import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import https from 'node:https';
import net from 'node:net';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import mqtt from 'mqtt';

const exec = promisify(execFile);
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const deviceId = 'a'.repeat(32);
const tokenId = 'b'.repeat(32);
const token = 'c'.repeat(43);
const container = `mimivent-query-test-${Date.now()}`;
const messages = new Map();
const readQueries = new Map();
const queryReplies = new Map();
const timeReplies = new Map();
let timeHealthSequence = 1;
let directory, gateway, device, port, containerStarted = false, gatewayEnv;
let mode = 'normal';
let logs = '';
const delay = (ms) => new Promise((done) => setTimeout(done, ms));

function request(method, path, body, headers = {}) {
  return new Promise((resolveResponse, reject) => {
    const req = https.request({
      host: '127.0.0.1', port, method, path,
      // 测试临时证书；生产 App 始终校验固定指纹。
      rejectUnauthorized: false,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        'x-device-token-id': tokenId,
        ...headers,
      },
    }, (res) => {
      let text = '';
      res.on('data', (data) => { text += data; });
      res.on('end', () => {
        try { resolveResponse({ code: res.statusCode, body: JSON.parse(text) }); }
        catch (error) { reject(error); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function startGateway() {
  const child = spawn(process.execPath, [join(root, 'server.mjs')], {
    cwd: root,
    env: gatewayEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (data) => { logs += data; });
  child.stderr.on('data', (data) => { logs += data; });
  return child;
}

async function waitForGateway() {
  for (let i = 0; i < 80; i++) {
    try {
      const health = await request('GET', '/healthz');
      if (health.body.mqttConnected) return;
    } catch { /* 等待启动 */ }
    await delay(100);
  }
  assert.fail(`Gateway 未就绪：${logs}`);
}

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'mimivent-query-'));
  await writeFile(join(directory, 'time-health.json'), JSON.stringify({
    schemaVersion: 1,
    sequence: timeHealthSequence,
    updatedAtUnixMs: Date.now(),
    utcMs: Date.now(),
    utcOffsetMinutes: 480,
    synchronized: true,
    syncAgeMs: 1000,
    accuracyMs: 10,
  }));
  await writeFile(join(directory, 'mosquitto.conf'), 'listener 1883\nallow_anonymous true\n');
  await exec('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-keyout', join(directory, 'key.pem'), '-out', join(directory, 'cert.pem'),
    '-subj', '/CN=localhost']);
  await exec('docker', ['run', '-d', '--name', container, '-p', '127.0.0.1::1883',
    '-v', `${directory}/mosquitto.conf:/mosquitto/config/mosquitto.conf:ro`,
    'eclipse-mosquitto:2.0.22']);
  containerStarted = true;
  const mapping = await exec('docker', ['port', container, '1883']);
  const brokerPort = Number(mapping.stdout.trim().split(':').pop());
  const listener = net.createServer();
  await new Promise((done) => listener.listen(0, '127.0.0.1', done));
  port = listener.address().port;
  await new Promise((done) => listener.close(done));
  gatewayEnv = { ...process.env, PORT: String(port), MQTT_URL: `mqtt://127.0.0.1:${brokerPort}`,
      MQTT_USERNAME: 'test', MQTT_PASSWORD: 'test-password',
      TLS_CERT_FILE: join(directory, 'cert.pem'), TLS_KEY_FILE: join(directory, 'key.pem'),
      GATEWAY_DATA_DIR: directory,
      TIME_SYNC_HEALTH_FILE: join(directory, 'time-health.json') };
  gateway = startGateway();
  await waitForGateway();
  device = mqtt.connect(`mqtt://127.0.0.1:${brokerPort}`, { reconnectPeriod: 0 });
  await new Promise((done, reject) => {
    device.on('error', reject);
    device.on('connect', () => device.subscribe([
      `mimivent/v1/${deviceId}/command`, `mimivent/v1/${deviceId}/query`,
      `mimivent/v1/${deviceId}/query-ack`,
      `mimivent/v1/${deviceId}/time-reply`,
    ],
      { qos: 1 }, (error) => error ? reject(error) : done()));
  });
  device.on('message', (messageTopic, bytes) => {
    if (messageTopic.endsWith('/time-reply')) {
      const reply = JSON.parse(bytes);
      timeReplies.set(reply.nonce, reply);
      return;
    }
    if (messageTopic.endsWith('/query-ack')) {
      const ack = JSON.parse(bytes);
      const response = queryReplies.get(ack.queryId);
      if (response && ack.chunkIndex === response.nextIndex) {
        response.nextIndex++;
        const chunkIndex = response.nextIndex;
        if (chunkIndex < response.chunks.length) {
          device.publish(`mimivent/v1/${deviceId}/query-reply`, JSON.stringify({
            schemaVersion: 1,
            queryId: ack.queryId,
            statusCode: 200,
            chunkIndex,
            chunkCount: response.chunks.length,
            data: response.chunks[chunkIndex],
          }), {qos: 1});
        }
      }
      return;
    }
    const command = JSON.parse(bytes);
    if (messageTopic.endsWith('/query')) {
      readQueries.set(command.queryId, (readQueries.get(command.queryId) ?? 0) + 1);
      const body = JSON.stringify({
        deviceId: '0123456789abcdef',
        path: command.path,
        result: 'ok',
        padding: '通风数据'.repeat(70),
      });
      const bytes = Buffer.from(body, 'utf8');
      const chunks = [];
      for (let start = 0; start < bytes.length;) {
        let end = Math.min(start + 128, bytes.length);
        while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
        chunks.push(bytes.subarray(start, end).toString('utf8'));
        start = end;
      }
      queryReplies.set(command.queryId, {chunks, nextIndex: 0});
      device.publish(`mimivent/v1/${deviceId}/query-reply`, JSON.stringify({
        schemaVersion: 1,
        queryId: command.queryId,
        statusCode: 200,
        chunkIndex: 0,
        chunkCount: chunks.length,
        data: chunks[0],
      }), {qos: 1});
      return;
    }
    const phases = messages.get(command.requestId) ?? [];
    phases.push(command.phase);
    messages.set(command.requestId, phases);
    const ack = (status, body, httpStatus = 200) => device.publish(`mimivent/v1/${deviceId}/ack`,
      JSON.stringify({ version: 2, requestId: command.requestId, status, httpStatus, body }),
      { qos: 1 });
    if (command.phase === 'prepare') {
      ack('ready', { issuedAtMs: 123, challenge: 'd'.repeat(64) });
    } else if (mode === 'normal') {
      ack('applied', { ok: true });
    } else if (mode === 'legacy') {
      ack('rejected', { error: 'REQUEST_BODY_UNKNOWN' }, 409);
    }
  });
}, { timeout: 30000 });

after(async () => {
  if (device) device.end(true);
  if (gateway) gateway.kill('SIGTERM');
  try { if (containerStarted) await exec('docker', ['rm', '-f', container]); }
  finally { if (directory) await rm(directory, { recursive: true, force: true }); }
});

const controlPath = `/api/v1/devices/${deviceId}/control`;
const deviceReadPath = `/api/v1/devices/${deviceId}/query`;
const statePath = `/api/v1/devices/${deviceId}/state`;
const queryPath = (id) => `/api/v1/devices/${deviceId}/requests/${id}`;
const controlBody = (id) => ({ version: 1, requestId: id, tokenId,
  path: '/api/timed', body: 'mode=on' });

let stateSampledUptimeMs = 1234;
function publishSnapshot({
  authTokens = [{ tokenId, tokenHash: createHash('sha256').update(token).digest('hex') }],
  retain = false,
  bootId = 'f'.repeat(16),
  seq = 42,
  sampledUptimeMs = ++stateSampledUptimeMs,
  mode = 'auto',
} = {}) {
  return new Promise((resolve, reject) => device.publish(`mimivent/v1/${deviceId}/state`,
    JSON.stringify({ schemaVersion: 1, deviceId, bootId, seq, sampledUptimeMs,
      state: { fan: false, mode, authTokens } }),
    { qos: 1, retain }, (error) => error ? reject(error) : resolve()));
}

function publishState(authTokens = [{ tokenId, tokenHash: createHash('sha256').update(token).digest('hex') }], retain = true) {
  return publishSnapshot({ authTokens, retain });
}

test('状态读取校验 token 哈希，返回不泄漏授权摘要，并持久化 7 天 read grant', async () => {
  await publishState();
  await delay(100);
  const wrongTokenId = 'e'.repeat(32);
  const denied = await request('GET', statePath, null,
    { 'x-device-token-id': wrongTokenId });
  assert.equal(denied.code, 403);
  assert.equal(denied.body.error, 'READ_GRANT_REVOKED');

  const response = await request('GET', statePath);
  assert.equal(response.code, 200);
  assert.equal(response.body.deviceId, deviceId);
  assert.equal(response.body.tokenId, tokenId);
  assert.equal(response.body.bindingState, 'active');
  assert.equal(response.body.authTokens, undefined);
  assert.equal(response.body.bootId, 'f'.repeat(16));
  assert.equal(response.body.seq, 42);
  assert.equal(response.body.fan, false);
  assert.equal(response.body.stateFreshness, 'fresh');

  const badBearer = await request('GET', statePath, null,
    { authorization: `Bearer ${'d'.repeat(43)}` });
  assert.equal(badBearer.code, 403);
  assert.equal(badBearer.body.error, 'INVALID_BEARER');
  const stillAuthorized = await request('GET', statePath);
  assert.equal(stillAuthorized.code, 200);

  const db = new DatabaseSync(join(directory, 'gateway.sqlite'));
  const grant = db.prepare('SELECT token_hash, expires_at FROM read_grants WHERE device_id = ? AND token_id = ?')
    .get(deviceId, tokenId);
  assert.equal(grant.token_hash, createHash('sha256').update(token).digest('hex'));
  assert.ok(grant.expires_at > Date.now() + 6 * 24 * 60 * 60 * 1000);
  db.close();
});

test('状态序号按模 2^32 拒绝旧包并接受回绕后的新包', async () => {
  const bootId = 'e'.repeat(16);
  await publishSnapshot({ bootId, seq: 0xffffffff, sampledUptimeMs: 9000, mode: 'auto' });
  await delay(80);
  let response = await request('GET', statePath);
  assert.equal(response.body.seq, 0xffffffff);

  await publishSnapshot({ bootId, seq: 0, sampledUptimeMs: 9001, mode: 'timed_off' });
  await delay(80);
  response = await request('GET', statePath);
  assert.equal(response.body.seq, 0);
  assert.equal(response.body.mode, 'timed_off');

  await publishSnapshot({ bootId, seq: 0xffffffff, sampledUptimeMs: 9002, mode: 'auto' });
  await publishSnapshot({ bootId, seq: 0x80000000, sampledUptimeMs: 9003, mode: 'auto' });
  await delay(80);
  response = await request('GET', statePath);
  assert.equal(response.body.seq, 0);
  assert.equal(response.body.mode, 'timed_off');
});

test('统计/事件只读请求经 MQTT query-reply 往返，不暴露 bearer 并限制路径', async () => {
  await publishState(undefined, false);
  await delay(100);
  const path = '/api/events?start=1793900000&end=1794000000&kind=all&limit=4';
  const response = await request('POST', deviceReadPath, {path});
  assert.equal(response.code, 200);
  assert.equal(response.body.schemaVersion, 1);
  assert.equal(response.body.deviceId, deviceId);
  assert.equal(response.body.statusCode, 200);
  assert.equal(response.body.body.deviceId, '0123456789abcdef');
  assert.equal(response.body.body.path, path);
  assert.equal(response.body.body.padding, '通风数据'.repeat(70));
  assert.equal(readQueries.size, 1);
  assert.equal((await request('POST', deviceReadPath,
    {path: '/api/settings/reset'})).code, 400);
  assert.equal(readQueries.size, 1);
});

test('NAS 只在时间健康文件新鲜且已同步时响应 MQTT 校时', async () => {
  const nonce = 'd'.repeat(32);
  const sentAt = Date.now();
  device.publish(`mimivent/v1/${deviceId}/time-request`, JSON.stringify({
    schemaVersion: 1,
    nonce,
    sentUptimeMs: 1234,
  }), {qos: 1, retain: false});
  for (let i = 0; i < 30 && !timeReplies.has(nonce); i++) await delay(50);
  const available = timeReplies.get(nonce);
  assert.equal(available?.status, 'available');
  assert.equal(available?.nonce, nonce);
  assert.equal(Object.hasOwn(available ?? {}, 'utcOffsetMinutes'), false);
  assert.ok(Math.abs(available.utcMs - sentAt) < 5000);

  timeHealthSequence++;
  await writeFile(join(directory, 'time-health.json'), JSON.stringify({
    schemaVersion: 1,
    sequence: timeHealthSequence,
    updatedAtUnixMs: Date.now(),
    utcMs: Date.now(),
    utcOffsetMinutes: 480,
    synchronized: false,
    syncAgeMs: 1000,
    accuracyMs: 10,
  }));
  const unavailableNonce = 'e'.repeat(32);
  device.publish(`mimivent/v1/${deviceId}/time-request`, JSON.stringify({
    schemaVersion: 1,
    nonce: unavailableNonce,
    sentUptimeMs: 2345,
  }), {qos: 1, retain: false});
  for (let i = 0; i < 30 && !timeReplies.has(unavailableNonce); i++) await delay(50);
  assert.equal(timeReplies.get(unavailableNonce)?.status, 'unavailable');
  assert.equal(timeReplies.get(unavailableNonce)?.reason, 'host_clock_unsynchronized');
});

test('设备在线确认绑定撤销后删除旧 read grant', async () => {
  await publishState([]);
  await delay(100);
  const response = await request('GET', statePath);
  assert.equal(response.code, 403);
  assert.equal(response.body.error, 'READ_GRANT_REVOKED');
});

test('并发去重后的成功结果可查询，查询不会重新发送控制', async () => {
  const id = randomUUID();
  const responses = await Promise.all([
    request('POST', controlPath, controlBody(id)), request('POST', controlPath, controlBody(id)),
  ]);
  assert.ok(responses.every((res) => res.code === 200 && res.body.httpStatus === 200));
  const result = await request('GET', queryPath(id));
  assert.equal(result.code, 200);
  assert.equal(result.body.status, 'applied');
  assert.deepEqual(messages.get(id), ['prepare', 'execute']);
});

test('设置更新仍经过 NAS MQTT 两阶段控制通道', async () => {
  const id = randomUUID();
  const result = await request('POST', controlPath, {
    ...controlBody(id),
    path: '/api/settings',
    body: 'profile=production&startupCooldownMs=1000&leaveConfirmMs=0&autoExhaustMs=300000&manualExhaustMs=180000&pauseMs=600000',
  });
  assert.equal(result.code, 200);
  assert.equal(result.body.httpStatus, 200);
  assert.deepEqual(messages.get(id), ['prepare', 'execute']);
});

test('查询拒绝其他 bearer、其他 tokenId 和未知请求', async () => {
  const id = randomUUID();
  await request('POST', controlPath, controlBody(id));
  assert.equal((await request('GET', queryPath(id), null,
    { authorization: `Bearer ${'x'.repeat(43)}` })).code, 404);
  assert.equal((await request('GET', queryPath(id), null,
    { 'x-device-token-id': 'e'.repeat(32) })).code, 404);
  assert.equal((await request('GET', queryPath(id), null, { authorization: '' })).code, 401);
  assert.equal((await request('GET', queryPath(randomUUID()))).code, 404);
  assert.deepEqual(messages.get(id), ['prepare', 'execute']);
});

test('等待执行结果可查 pending，超时后不伪造 applied', { timeout: 10000 }, async () => {
  mode = 'silent';
  const id = randomUUID();
  const response = request('POST', controlPath, controlBody(id));
  for (let i = 0; i < 100 && !messages.get(id)?.includes('execute'); i++) await delay(10);
  assert.ok(messages.get(id)?.includes('execute'));
  const pending = await request('GET', queryPath(id));
  assert.equal(pending.code, 200);
  assert.equal(pending.body.status, 'pending');
  const result = await response;
  assert.equal(result.code, 504);
  assert.equal(result.body.commandPublished, true);
  assert.equal((await request('GET', queryPath(id))).code, 404);
  assert.deepEqual(messages.get(id), ['prepare', 'execute']);
});

test('同一设备已有控制在途时拒绝不同 requestId 且不发布第二条命令', async () => {
  mode = 'silent';
  const firstId = randomUUID();
  const secondId = randomUUID();
  const firstResponse = request('POST', controlPath, controlBody(firstId));
  for (let i = 0; i < 100 && !messages.get(firstId)?.includes('execute'); i++) await delay(10);
  assert.ok(messages.get(firstId)?.includes('execute'));

  const second = await request('POST', controlPath, controlBody(secondId));
  const ack = JSON.stringify({ version: 2, requestId: firstId,
    status: 'applied', httpStatus: 200, body: { ok: true } });
  await new Promise((resolve, reject) => device.publish(
    `mimivent/v1/${deviceId}/ack`, ack, { qos: 1 },
    (error) => error ? reject(error) : resolve()));
  const first = await firstResponse;

  assert.equal(second.code, 409);
  assert.equal(second.body.error, 'DEVICE_CONTROL_BUSY');
  assert.equal(second.body.commandPublished, false);
  assert.equal(messages.has(secondId), false);
  assert.equal(first.code, 200);
  mode = 'normal';
});

test('旧记录缺少摘要时结果保持未知，不缓存成 rejected', async () => {
  mode = 'legacy';
  const id = randomUUID();
  const result = await request('POST', controlPath, controlBody(id));
  assert.equal(result.code, 504);
  assert.equal(result.body.commandPublished, true);
  assert.equal((await request('GET', queryPath(id))).code, 404);
  assert.deepEqual(messages.get(id), ['prepare', 'execute']);
});

test('网关运行期间同 ID 改正文必须冲突', async () => {
  mode = 'normal';
  const id = randomUUID();
  await request('POST', controlPath, controlBody(id));
  const result = await request('POST', controlPath, { ...controlBody(id), body: 'mode=off' });
  assert.equal(result.code, 409);
  assert.deepEqual(messages.get(id), ['prepare', 'execute']);
});

test('Gateway 重启后从 SQLite 恢复最后状态，并将其标记为过期快照', async () => {
  await publishState();
  await delay(100);
  const live = await request('GET', statePath);
  assert.equal(live.code, 200);
  assert.equal(live.body.stateFreshness, 'fresh');

  // 删除 Broker retained 副本，确保重启后的状态只能来自 Gateway 持久层。
  await new Promise((resolve, reject) => device.publish(
    `mimivent/v1/${deviceId}/state`, '', { qos: 1, retain: true },
    (error) => error ? reject(error) : resolve()));
  await publishState(undefined, false);
  await delay(100);

  const oldGateway = gateway;
  await new Promise((resolve) => {
    oldGateway.once('exit', resolve);
    oldGateway.kill('SIGTERM');
  });
  gateway = startGateway();
  await waitForGateway();

  const restored = await request('GET', statePath);
  assert.equal(restored.code, 200);
  assert.equal(restored.body.stale, true);
  assert.equal(restored.body.stateFreshness, 'cached_unconfirmed');
  assert.equal(restored.body.authTokens, undefined);

  // Gateway 重启后的 SQLite 快照只供标 stale 的缓存读取；设备新启动周期
  // 发来的实时包必须能替换它，否则状态会永久停留在旧 bootId。
  await publishSnapshot({
    bootId: '1'.repeat(16),
    seq: 0,
    sampledUptimeMs: 1,
    mode: 'armed',
  });
  await delay(100);
  const recovered = await request('GET', statePath);
  assert.equal(recovered.code, 200);
  assert.equal(recovered.body.stateFreshness, 'fresh');
  assert.equal(recovered.body.bootId, '1'.repeat(16));
  assert.equal(recovered.body.mode, 'armed');

  const db = new DatabaseSync(join(directory, 'gateway.sqlite'));
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1);
  const snapshot = db.prepare('SELECT payload FROM state_snapshots WHERE device_id = ?')
    .get(deviceId);
  assert.ok(snapshot);
  assert.equal(JSON.parse(snapshot.payload).state.authTokens, undefined);
  db.close();
});
