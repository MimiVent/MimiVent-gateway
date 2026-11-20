import https from 'node:https';
import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import mqtt from 'mqtt';
import { certificateFingerprint, createSetupArtifacts, renderSetupPage } from './app_setup.mjs';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { AuthorizationStore } from './auth_store.mjs';

const config = readConfig();
const setupArtifacts = await createSetupArtifacts({
  host: config.nasIp,
  gatewayPort: config.port,
  certificatePin: certificateFingerprint(config.tlsCertFile),
  mqttPort: config.mqttExternalPort,
  mqttUsername: config.mqttUsername,
  mqttPassword: config.mqttPassword,
});
const setupPage = renderSetupPage(setupArtifacts);
function writeSetupPage(response, method = 'GET') {
  response.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    Pragma: 'no-cache',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': `default-src 'none'; img-src data:; style-src 'nonce-${setupPage.nonce}'; script-src 'nonce-${setupPage.nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
  });
  return response.end(method === 'HEAD' ? undefined : setupPage.html);
}
fs.mkdirSync(config.dataDir, { recursive: true });
const database = new DatabaseSync(path.join(config.dataDir, 'gateway.sqlite'));
database.exec('PRAGMA journal_mode = WAL;');
const databaseSchemaVersion = database.prepare('PRAGMA user_version').get().user_version;
if (databaseSchemaVersion > 1) {
  throw new Error(`Unsupported Gateway database schema: ${databaseSchemaVersion}`);
}
if (databaseSchemaVersion < 1) {
  database.exec('BEGIN IMMEDIATE;');
  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS read_grants (
        device_id TEXT NOT NULL,
        token_id TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        issued_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        PRIMARY KEY (device_id, token_id)
      );
      CREATE TABLE IF NOT EXISTS state_snapshots (
        device_id TEXT PRIMARY KEY,
        payload TEXT NOT NULL,
        received_at INTEGER NOT NULL
      );
      PRAGMA user_version = 1;
    `);
    database.exec('COMMIT;');
  } catch (error) {
    database.exec('ROLLBACK;');
    throw error;
  }
}
const readGrantGet = database.prepare(
  'SELECT token_hash, expires_at FROM read_grants WHERE device_id = ? AND token_id = ?');
const readGrantPut = database.prepare(`
  INSERT INTO read_grants (device_id, token_id, token_hash, issued_at, expires_at)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(device_id, token_id) DO UPDATE SET
    token_hash = excluded.token_hash,
    issued_at = excluded.issued_at,
    expires_at = excluded.expires_at
`);
const readGrantDelete = database.prepare(
  'DELETE FROM read_grants WHERE device_id = ? AND token_id = ?');
const stateSnapshotList = database.prepare(
  'SELECT device_id, payload, received_at FROM state_snapshots ORDER BY received_at DESC LIMIT 32');
const stateSnapshotPut = database.prepare(`
  INSERT INTO state_snapshots (device_id, payload, received_at)
  VALUES (?, ?, ?)
  ON CONFLICT(device_id) DO UPDATE SET
    payload = excluded.payload,
    received_at = excluded.received_at
`);
const stateSnapshotPrune = database.prepare(`
  DELETE FROM state_snapshots WHERE device_id NOT IN (
    SELECT device_id FROM state_snapshots ORDER BY received_at DESC LIMIT 32
  )
`);
// P2 单服务授权与手机凭据：存储层由 AuthorizationStore 统一负责（凭据文件 0600）。
const authorization = new AuthorizationStore(database, config.dataDir);
let mqttClient;
let mqttReady = false;
let mqttTimeReady = false;
let stopping = false;
let reconnectTimer;
function createMqttClient() {
return mqtt.connect(config.mqttUrl, {
  username: config.mqttUsername,
  password: config.mqttPassword,
  clientId: `mimivent-gateway-${crypto.randomBytes(6).toString('hex')}`,
  clean: true,
  connectTimeout: 5000,
  reconnectPeriod: 0,
  keepalive: 30,
  protocolVersion: 4,
});
}

const pending = new Map();
const pendingQueries = new Map();
// 固件端 query-reply 使用单个待发送槽。不同手机可以并发请求 HTTP，
// 但同一设备的 MQTT 查询必须在 Gateway 排队，不能同时发布到设备。
const queryQueues = new Map();
let queuedQueryCount = 0;
let observedTimeHealthSequence = null;
let observedTimeHealthMonotonicAt = 0;
let observedTimeHealthAgeAtReadMs = 0;
let observedTimeHealth = null;
const completed = new Map();
const state = new Map();
const availability = new Map();
const maxPending = 64;
const maxPendingQueries = 2;
const maxCompleted = 512;
const completedTtlMs = 10 * 60 * 1000;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const deviceIdPattern = /^[0-9a-f]{32}$/;
const tokenIdPattern = /^[0-9a-f]{32}$/;
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const allowedPaths = new Set([
  '/api/auto',
  '/api/timed',
  '/api/test-fan',
  '/api/lockoff',
  '/api/settings',
  '/api/lease',
]);

function readConfig() {
  const required = (name) => {
    const value = process.env[name]?.trim();
    if (!value) throw new Error(`Missing required environment variable: ${name}`);
    return value;
  };
  const port = Number(process.env.PORT ?? '8444');
  const httpSetupPort = Number(process.env.HTTP_SETUP_PORT ?? '18080');
  // 设备回 ACK 的等待上限。两阶段控制（prepare/execute）各要一次 MQTT 往返，
  // 设备在跑统计查询或处理上一条命令时会变慢；2.5 秒的旧默认值会导致
  // DEVICE_ACK_TIMEOUT，App 侧表现为控制失败并回滚，观感是 UI 闪烁。
  const ackTimeoutMs = Number(process.env.ACK_TIMEOUT_MS ?? '6000');
  const mqttExternalPort = Number(process.env.MQTT_EXTERNAL_PORT ?? '1883');
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }
  if (!Number.isInteger(httpSetupPort) || httpSetupPort < 1 || httpSetupPort > 65535 || httpSetupPort === port) {
    throw new Error('HTTP_SETUP_PORT must be a different port between 1 and 65535');
  }
  if (!Number.isInteger(ackTimeoutMs) || ackTimeoutMs < 2500 || ackTimeoutMs > 10000) {
    throw new Error('ACK_TIMEOUT_MS must be between 2500 and 10000');
  }
  if (!Number.isInteger(mqttExternalPort) || mqttExternalPort < 1 || mqttExternalPort > 65535) {
    throw new Error('MQTT_EXTERNAL_PORT must be an integer between 1 and 65535');
  }
  const mqttUrl = required('MQTT_URL');
  if (!/^mqtt:\/\//.test(mqttUrl)) throw new Error('MQTT_URL must use mqtt:// on the LAN');
  return {
    port,
    httpSetupPort,
    nasIp: required('NAS_IP'),
    mqttExternalPort,
    ackTimeoutMs,
    mqttUrl,
    mqttUsername: required('MQTT_USERNAME'),
    mqttPassword: required('MQTT_PASSWORD'),
    tlsCertFile: required('TLS_CERT_FILE'),
    tlsKeyFile: required('TLS_KEY_FILE'),
    dataDir: process.env.GATEWAY_DATA_DIR?.trim() || '/app/data',
    timeHealthFile: process.env.TIME_SYNC_HEALTH_FILE?.trim() || '/run/mimivent/time-health.json',
  };
}

function topic(deviceId, suffix) {
  return `mimivent/v1/${deviceId}/${suffix}`;
}

function requestKey(deviceId, tokenId, requestId) {
  return `${deviceId}:${requestId}`;
}

function fingerprint(command) {
  return crypto.createHash('sha256').update(JSON.stringify([
    command.tokenId,
    command.path,
    command.body,
    command.token,
  ])).digest('hex');
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function equalHex(left, right) {
  return typeof left === 'string' && typeof right === 'string' &&
    /^[0-9a-f]{64}$/.test(left) && /^[0-9a-f]{64}$/.test(right) &&
    crypto.timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

const readGrantTtlMs = 7 * 24 * 60 * 60 * 1000;
const stateFreshnessMs = 30 * 1000;

function decodeStateSnapshot(value, deviceId) {
  let parsed;
  try { parsed = JSON.parse(value); }
  catch { return {error: 'STATE_UNREADABLE'}; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {error: 'STATE_UNREADABLE'};
  }
  if (!Object.hasOwn(parsed, 'schemaVersion')) {
    return {parsed, state: parsed, envelope: null};
  }
  if (parsed.schemaVersion !== 1 || !parsed.state || typeof parsed.state !== 'object' ||
      Array.isArray(parsed.state) || parsed.deviceId !== deviceId ||
      !/^[0-9a-f]{16}$/.test(parsed.bootId ?? '') ||
      !Number.isInteger(parsed.seq) || parsed.seq < 0 || parsed.seq > 0xffffffff ||
      !Number.isSafeInteger(parsed.sampledUptimeMs) || parsed.sampledUptimeMs < 0) {
    return {error: 'STATE_ENVELOPE_INVALID'};
  }
  return {parsed, state: parsed.state, envelope: parsed};
}

function shouldAcceptStateSnapshot(incoming, previous, retained, deviceId) {
  if (!previous) return true;
  const current = decodeStateSnapshot(previous.value, deviceId);
  if (current.error) return true;
  if (!incoming.envelope) return !current.envelope;
  if (!current.envelope) return true;
  if (incoming.envelope.bootId !== current.envelope.bootId) {
    // SQLite 恢复快照可能来自更早的设备启动周期；拒绝 retained Broker
    // 快照，但必须允许当前实时消息用新 bootId 恢复新鲜状态。
    return !retained;
  }
  if (incoming.envelope.sampledUptimeMs < current.envelope.sampledUptimeMs) return false;
  const distance = (incoming.envelope.seq - current.envelope.seq) >>> 0;
  if (distance === 0) {
    return incoming.envelope.sampledUptimeMs > current.envelope.sampledUptimeMs;
  }
  return distance < 0x80000000;
}

function persistStateSnapshot(deviceId, payload, receivedAt) {
  try {
    const parsed = JSON.parse(payload);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
    // 授权摘要只在实时内存中用于绑定验证，不写入持久状态缓存。
    const statePayload = parsed.state && typeof parsed.state === 'object' && !Array.isArray(parsed.state)
      ? parsed.state
      : parsed;
    delete statePayload.authTokens;
    const safePayload = JSON.stringify(parsed);
    if (Buffer.byteLength(safePayload, 'utf8') > 4096) return;
    stateSnapshotPut.run(deviceId, safePayload, receivedAt);
    stateSnapshotPrune.run();
  } catch (error) {
    // 数据库故障不能中断 MQTT 接收或当前进程的实时状态读取。
    console.error(`State snapshot persistence failed: ${error.code ?? 'database_error'}`);
  }
}

function restoreStateSnapshots() {
  const nowWall = Date.now();
  const nowMonotonic = performance.now();
  for (const row of stateSnapshotList.all()) {
    if (!deviceIdPattern.test(row.device_id) ||
        typeof row.payload !== 'string' || Buffer.byteLength(row.payload, 'utf8') > 4096) continue;
    try {
      const parsed = JSON.parse(row.payload);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      const wallAge = nowWall - row.received_at;
      const ageKnown = Number.isSafeInteger(row.received_at) && wallAge >= 0;
      const initialAge = ageKnown ? wallAge : stateFreshnessMs + 1;
      state.set(row.device_id, {
        value: row.payload,
        receivedAt: row.received_at,
        receivedMonotonicAt: nowMonotonic - initialAge,
        retained: true,
        restored: true,
        ageKnown,
      });
    } catch {
      // 一条损坏记录不能阻止 Gateway 启动，也不能覆盖其它设备的缓存。
    }
  }
}
restoreStateSnapshots();

function appAccess(request, deviceId) {
  const result = authorization.authenticateApp(request, deviceId);
  return result.error ? null : result.entry;
}

function readCachedState(request, deviceId) {
  const app = appAccess(request, deviceId);
  if (!app) return {code: 401, body: {error: 'AUTH_REQUIRED'}};
  const entry = state.get(deviceId);
  if (!entry) return {code: 503, body: {error: 'STATE_UNAVAILABLE'}};
  const decodedState = decodeStateSnapshot(entry.value, deviceId);
  if (decodedState.error) return {code: 502, body: {error: decodedState.error}};
  const {state: statePayload, envelope} = decodedState;
  const ageMs = Math.max(0, performance.now() - entry.receivedMonotonicAt);
  const fresh = !entry.retained && ageMs <= stateFreshnessMs;
  const {authTokens: _authTokens, ...visibleState} = statePayload;
  return {code: 200, body: {
    ...visibleState,
    deviceId,
    appInstanceId: app.app_instance_id,
    role: app.role,
    bindingState: 'active',
    protocolVersion: 1,
    ...(envelope ? {
      stateSchemaVersion: envelope.schemaVersion,
      bootId: envelope.bootId,
      seq: envelope.seq,
      sampledUptimeMs: envelope.sampledUptimeMs,
    } : {}),
    stateReceivedAt: entry.receivedAt,
    stateAgeMs: ageMs,
    stateAgeKnown: entry.ageKnown !== false,
    stateFreshness: fresh ? 'fresh' : (entry.retained ? 'cached_unconfirmed' : 'stale'),
    stale: !fresh,
  }};
}
function queryResult(request, deviceId, requestId) {
  if (!appAccess(request, deviceId)) return {code: 401, body: {error: 'AUTH_REQUIRED'}};
  cleanCompleted();
  const key = requestKey(deviceId, '', requestId);
  const cached = completed.get(key);
  const entry = cached ?? pending.get(key);
  if (!entry) return {code: 404, body: {error: 'UNKNOWN'}};
  return {code: 200, body: {
    requestId,
    status: cached ? (cached.response.httpStatus < 400 ? 'applied' : 'rejected') : 'pending',
    httpStatus: cached ? cached.response.httpStatus : 0,
  }};
}
function queryPath(value) {
  if (typeof value !== 'string' || value.length > 180 || !value.startsWith('/api/')) {
    return null;
  }
  let parsed;
  try { parsed = new URL(value, 'http://gateway.invalid'); }
  catch { return null; }
  if (parsed.origin !== 'http://gateway.invalid' || parsed.hash || parsed.username || parsed.password) {
    return null;
  }
  const allowed = new Map([
    ['/api/status', new Set()],
    ['/api/settings', new Set(['profile'])],
    ['/api/stats', new Set(['mode', 'offset', 'limit'])],
    ['/api/stats/range', new Set(['from', 'to', 'tzOffsetSeconds'])],
    ['/api/events', new Set(['start', 'end', 'kind', 'offset', 'limit', 'beforeId', 'dataEpoch'])],
  ]);
  const parameters = allowed.get(parsed.pathname);
  if (!parameters) return null;
  for (const name of parsed.searchParams.keys()) {
    if (!parameters.has(name)) return null;
  }
  if ([...parsed.searchParams.values()].some((item) => item.length > 64 || /[\u0000-\u001f]/.test(item))) {
    return null;
  }
  return parsed.pathname + parsed.search;
}

function validateQueryAccess(request, deviceId) {
  if (!appAccess(request, deviceId)) return {code: 401, error: 'AUTH_REQUIRED'};
  const service = authorization.readServiceCredential(deviceId);
  if (!service) return {code: 404, error: 'DEVICE_NOT_PROVISIONED'};
  const entry = state.get(deviceId);
  if (!entry || entry.retained ||
      performance.now() - entry.receivedMonotonicAt > stateFreshnessMs) {
    return {code: 503, error: 'DEVICE_STATE_NOT_FRESH'};
  }
  const snapshot = decodeStateSnapshot(entry.value, deviceId);
  const deviceCredentialId = snapshot.state?.service?.credentialId;
  if (typeof deviceCredentialId !== 'string') {
    return {code: 409, error: 'DEVICE_SERVICE_IDENTITY_UNAVAILABLE'};
  }
  if (deviceCredentialId !== service.tokenId) {
    console.warn(`[gw] service credential mismatch device=${deviceId} gatewayCredentialId=${service.tokenId} deviceCredentialId=${deviceCredentialId}`);
    return {code: 409, error: 'SERVICE_CREDENTIAL_MISMATCH'};
  }
  return {code: 200, token: service.token, tokenId: service.tokenId};
}
function queryDevice(deviceId, tokenId, token, path) {
  if (!mqttReady || !mqttClient?.connected) {
    return Promise.reject(Object.assign(new Error('MQTT_UNAVAILABLE'), {status: 503}));
  }
  if (pendingQueries.size + queuedQueryCount >= maxPendingQueries) {
    return Promise.reject(Object.assign(new Error('GATEWAY_BUSY'), {status: 503}));
  }

  let queue = queryQueues.get(deviceId);
  if (!queue) {
    queue = {tail: Promise.resolve(), waiting: 0, active: 0};
    queryQueues.set(deviceId, queue);
  }
  queue.waiting++;
  queuedQueryCount++;
  const queuedAt = performance.now();
  if (queue.active > 0 || queue.waiting > 1) {
    console.info(`[gw] query queued device=${deviceId} waiting=${queue.waiting}`);
  }

  const operation = queue.tail.then(() => {
    queue.waiting--;
    queuedQueryCount--;
    queue.active++;
    const queueWaitMs = Math.round(performance.now() - queuedAt);
    if (queueWaitMs > 0) {
      console.info(`[gw] query start device=${deviceId} queueWaitMs=${queueWaitMs}`);
    }
    return publishQueryNow(deviceId, tokenId, token, path);
  });
  queue.tail = operation.catch(() => {}).finally(() => {
    queue.active--;
    if (queue.active === 0 && queue.waiting === 0 && queryQueues.get(deviceId) === queue) {
      queryQueues.delete(deviceId);
    }
  });
  return operation;
}

function publishQueryNow(deviceId, tokenId, token, path) {
  if (!mqttReady || !mqttClient?.connected) {
    return Promise.reject(Object.assign(new Error('MQTT_UNAVAILABLE'), {status: 503}));
  }
  // 全局上限包含排队请求；此检查作为其它设备并发时的最后一道保护。
  if (pendingQueries.size >= maxPendingQueries) {
    return Promise.reject(Object.assign(new Error('GATEWAY_BUSY'), {status: 503}));
  }
  const queryId = crypto.randomUUID();
  const key = `${deviceId}:${queryId}`;
  let settle;
  const promise = new Promise((resolve, reject) => { settle = {resolve, reject}; });
  const timer = setTimeout(() => {
    const query = pendingQueries.get(key);
    if (!query) return;
    pendingQueries.delete(key);
    query.reject(Object.assign(new Error('DEVICE_QUERY_TIMEOUT'), {status: 504}));
  }, 30000);
  pendingQueries.set(key, {
    deviceId,
    queryId,
    chunkCount: null,
    statusCode: null,
    nextChunkIndex: 0,
    parts: [],
    resolve: (result) => { clearTimeout(timer); pendingQueries.delete(key); settle.resolve(result); },
    reject: (error) => { clearTimeout(timer); pendingQueries.delete(key); settle.reject(error); },
  });
  const message = JSON.stringify({schemaVersion: 1, queryId, tokenId, token, path});
  mqttClient.publish(topic(deviceId, 'query'), message, {qos: 1, retain: false}, (error) => {
    if (error) {
      const query = pendingQueries.get(key);
      if (query) query.reject(Object.assign(new Error('MQTT_QUERY_PUBLISH_FAILED'), {status: 503}));
    }
  });
  return promise;
}

function writeJson(response, statusCode, body) {
  const bytes = Buffer.from(JSON.stringify(body));
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': bytes.length,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'connection': 'close',
  });
  response.end(bytes);
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0;
    let tooLarge = false;
    request.on('data', (chunk) => {
      if (tooLarge) return;
      length += chunk.length;
      if (length > 4096) {
        tooLarge = true;
        chunks.length = 0;
        reject(Object.assign(new Error('Request body too large'), { status: 413 }));
        request.resume();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (tooLarge) return;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('Invalid JSON body'), { status: 400 }));
      }
    });
    request.on('error', reject);
  });
}

function validateControl(request, deviceId, body) {
  if (!appAccess(request, deviceId)) throw Object.assign(new Error('AUTH_REQUIRED'), { status: 401 });
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
      body.version !== 1 ||
      typeof body.requestId !== 'string' ||
      !uuidPattern.test(body.requestId ?? '') ||
      !allowedPaths.has(body.path) || typeof body.body !== 'string' ||
      body.body.includes('\0') ||
      Buffer.byteLength(body.body, 'utf8') > 256) {
    throw Object.assign(new Error('INVALID_CONTROL_REQUEST'), { status: 400 });
  }
  const service = authorization.readServiceCredential(deviceId);
  if (!service) throw Object.assign(new Error('DEVICE_NOT_PROVISIONED'), { status: 404 });
  return {
    deviceId,
    tokenId: service.tokenId,
    token: service.token,
    requestId: body.requestId,
    path: body.path,
    body: body.body,
  };
}
function cleanCompleted(now = Date.now()) {
  for (const [key, value] of completed) {
    if (now - value.completedAt > completedTtlMs) completed.delete(key);
  }
  while (completed.size > maxCompleted) {
    completed.delete(completed.keys().next().value);
  }
}

function publishAndWait(command) {
  const key = requestKey(command.deviceId, command.tokenId, command.requestId);
  const digest = fingerprint(command);
  cleanCompleted();
  const old = completed.get(key);
  if (old) {
    if (old.digest !== digest) {
      console.warn(`[gw] control conflict device=${command.deviceId} requestId=${command.requestId} phase=completed`);
      return Promise.reject(Object.assign(new Error('REQUEST_ID_CONFLICT'), { status: 409 }));
    }
    console.info(`[gw] control replay device=${command.deviceId} requestId=${command.requestId} status=${old.response.httpStatus}`);
    return Promise.resolve(old.response);
  }
  const inFlight = pending.get(key);
  if (inFlight) {
    if (inFlight.digest !== digest) {
      console.warn(`[gw] control conflict device=${command.deviceId} requestId=${command.requestId} phase=inflight`);
      return Promise.reject(Object.assign(new Error('REQUEST_ID_CONFLICT'), { status: 409 }));
    }
    console.info(`[gw] control join device=${command.deviceId} requestId=${command.requestId}`);
    return inFlight.promise;
  }
  if ([...pending.values()].some((entry) => entry.deviceId === command.deviceId)) {
    return Promise.reject(Object.assign(new Error('DEVICE_CONTROL_BUSY'), {
      status: 409,
      commandPublished: false,
    }));
  }
  if (!mqttReady || !mqttClient?.connected) {
    return Promise.reject(Object.assign(new Error('MQTT_UNAVAILABLE'), {
      status: 503,
      commandPublished: false,
    }));
  }
  if (pending.size >= maxPending) {
    return Promise.reject(Object.assign(new Error('GATEWAY_BUSY'), {
      status: 503,
      commandPublished: false,
    }));
  }

  let settle;
  const promise = new Promise((resolve, reject) => {
    settle = { resolve, reject };
  });
  const timer = setTimeout(() => {
    const entry = pending.get(key);
    if (entry) {
      pending.delete(key);
      entry.reject(Object.assign(new Error('DEVICE_ACK_TIMEOUT'), {
        status: entry.executing ? 504 : 503,
        commandPublished: entry.executing,
      }));
    }
  }, config.ackTimeoutMs);
  pending.set(key, {
    tokenId: command.tokenId,
    tokenHash: tokenHash(command.token),
    createdAt: performance.now(),
    command,
    executing: false,
    deviceId: command.deviceId,
    requestId: command.requestId,
    digest,
    promise,
    timer,
    resolve: (response) => {
      clearTimeout(timer);
      pending.delete(key);
      completed.set(key, { digest, response, completedAt: Date.now(),
        tokenId: command.tokenId, tokenHash: tokenHash(command.token) });
      cleanCompleted();
      settle.resolve(response);
    },
    reject: (error) => {
      clearTimeout(timer);
      const phase = pending.get(key)?.executing ? 'execute' : 'prepare';
      pending.delete(key);
      console.warn(`[gw] control result device=${command.deviceId} requestId=${command.requestId} phase=${phase} error=${error.message ?? 'unknown'} httpStatus=${error.status ?? 0} commandPublished=${error.commandPublished ?? 'unknown'}`);
      settle.reject(error);
    },
  });

  const message = JSON.stringify({
    version: 2,
    phase: 'prepare',
    requestId: command.requestId,
    tokenId: command.tokenId,
    token: command.token,
    path: command.path,
    body: command.body,
  });
  const originalEntry = pending.get(key);
  console.info(`[gw] control publish device=${command.deviceId} requestId=${command.requestId} phase=prepare path=${command.path}`);
  mqttClient.publish(topic(command.deviceId, 'command'), message, {
    qos: 1,
    retain: false,
  }, (error) => {
    if (!error) return;
    const entry = pending.get(key);
    if (entry === originalEntry) {
      entry.reject(Object.assign(new Error('MQTT_PUBLISH_UNCONFIRMED'), {
        status: entry.executing ? 504 : 503,
        commandPublished: entry.executing,
      }));
    }
  });
  return promise;
}

function onMqttMessage(messageTopic, payload, packet) {
  const parts = messageTopic.split('/');
  if (parts.length !== 4 || parts[0] !== 'mimivent' || parts[1] !== 'v1' ||
      !deviceIdPattern.test(parts[2])) return;
  const [, , deviceId, kind] = parts;
  if (kind === 'state' || kind === 'availability') {
    if (Buffer.byteLength(payload) <= 4096) {
      const target = kind === 'state' ? state : availability;
      const value = payload.toString('utf8');
      const receivedAt = Date.now();
      if (kind === 'state') {
        const decodedState = decodeStateSnapshot(value, deviceId);
        if (decodedState.error) {
          console.error(`Rejected invalid state snapshot: ${decodedState.error}`);
          return;
        }
        if (!shouldAcceptStateSnapshot(decodedState, target.get(deviceId),
          packet.retain === true, deviceId)) return;
      }
      target.set(deviceId, {
        value,
        receivedAt,
        receivedMonotonicAt: performance.now(),
        retained: packet.retain === true,
      });
      if (kind === 'state') persistStateSnapshot(deviceId, value, receivedAt);
      while (target.size > 32) target.delete(target.keys().next().value);
    }
    return;
  }
  if (kind === 'time-request') {
    if (packet.retain || payload.length > 1024) return;
    let request;
    try { request = JSON.parse(payload.toString('utf8')); }
    catch { return; }
    if (!request || request.schemaVersion !== 1 ||
        !/^[0-9a-f]{32}$/.test(request.nonce ?? '') ||
        !Number.isInteger(request.sentUptimeMs) || request.sentUptimeMs < 0 ||
        request.sentUptimeMs > 0xffffffff) return;
    const sample = timeHealthSample();
    const reply = {
      schemaVersion: 1,
      nonce: request.nonce,
      status: sample.status,
      ...(sample.status === 'available' ? {
        utcMs: sample.utcMs,
        accuracyMs: sample.accuracyMs,
      } : {reason: sample.reason}),
    };
    mqttClient.publish(topic(deviceId, 'time-reply'), JSON.stringify(reply),
      {qos: 1, retain: false});
    return;
  }
  if (kind === 'query-reply') {
    // 这里与设备端 WifiMqttTransport.cpp 的 kQueryChunkBytes 隐式耦合：
    // 整包 = data(分片大小) + 约 127 B 封装。设备 1024 B 时约 1278 B。
    // 取 4096 留出约 3 倍余量，避免以后调整分片大小又在这里被静默丢弃
    // （丢弃会导致设备收不到 ack 而无限重发，表现为统计查询永久转圈）。
    if (packet.retain || payload.length > 4096) return;
    let reply;
    try { reply = JSON.parse(payload.toString('utf8')); }
    catch { return; }
    if (!reply || typeof reply !== 'object' || reply.schemaVersion !== 1 ||
        !uuidPattern.test(reply.queryId ?? '') || !Number.isInteger(reply.statusCode) ||
        reply.statusCode < 100 || reply.statusCode > 599 ||
        !Number.isInteger(reply.chunkIndex) || reply.chunkIndex < 0 ||
        !Number.isInteger(reply.chunkCount) || reply.chunkCount < 1 ||
        reply.chunkCount > 72 || reply.chunkIndex >= reply.chunkCount ||
        // 见上方说明：data 上限需 >= 设备 kQueryChunkBytes。
        typeof reply.data !== 'string' || Buffer.byteLength(reply.data, 'utf8') > 2048) return;
    const query = pendingQueries.get(`${deviceId}:${reply.queryId}`);
    if (!query || query.deviceId !== deviceId) return;
    if ((query.chunkCount !== null && query.chunkCount !== reply.chunkCount) ||
        (query.statusCode !== null && query.statusCode !== reply.statusCode)) {
      query.reject(Object.assign(new Error('QUERY_CHUNK_METADATA_MISMATCH'), {status: 502}));
      return;
    }
    query.chunkCount = reply.chunkCount;
    query.statusCode = reply.statusCode;
    if (reply.chunkIndex > query.nextChunkIndex) return;
    if (reply.chunkIndex === query.nextChunkIndex) {
      query.parts.push(reply.data);
      query.nextChunkIndex++;
    }
    const ack = JSON.stringify({
      schemaVersion: 1,
      queryId: reply.queryId,
      chunkIndex: reply.chunkIndex,
    });
    mqttClient.publish(topic(deviceId, 'query-ack'), ack,
      {qos: 1, retain: false}, (error) => {
        if (error || pendingQueries.get(`${deviceId}:${reply.queryId}`) !== query) return;
        if (query.nextChunkIndex !== query.chunkCount) return;
        let body;
        try {
          const encoded = query.parts.join('');
          if (Buffer.byteLength(encoded, 'utf8') > 8192) throw new Error('QUERY_BODY_TOO_LARGE');
          body = JSON.parse(encoded);
        } catch {
          query.reject(Object.assign(new Error('INVALID_QUERY_RESPONSE'), {status: 502}));
          return;
        }
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          query.reject(Object.assign(new Error('INVALID_QUERY_RESPONSE'), {status: 502}));
          return;
        }
        query.resolve({statusCode: query.statusCode, body});
      });
    return;
  }
  if (kind !== 'ack' || packet.retain || payload.length > 2048) return;
  let ack;
  try {
    ack = JSON.parse(payload.toString('utf8'));
  } catch {
    return;
  }
  if (!ack || typeof ack !== 'object' || ack.version !== 2 ||
      !['ready', 'applied', 'rejected'].includes(ack.status) ||
      !uuidPattern.test(ack.requestId ?? '') ||
      !Number.isInteger(ack.httpStatus) || ack.httpStatus < 100 || ack.httpStatus > 599) return;
  const matching = [...pending.entries()].find(([, entry]) =>
    entry.deviceId === deviceId && entry.requestId === ack.requestId);
  if (!matching) {
    console.warn(`[gw] ack unmatched device=${deviceId} requestId=${ack.requestId} phase=${ack.status}`);
    return;
  }
  const [, entry] = matching;
  if (!entry.executing && ack.status === 'applied') return;
  if (!ack.body || typeof ack.body !== 'object' || Array.isArray(ack.body)) {
    entry.reject(Object.assign(new Error('INVALID_DEVICE_RESPONSE'), { status: 502 }));
    return;
  }
  const ackElapsedMs = Math.round(performance.now() - entry.createdAt);
  console.info(`[gw] ack device=${deviceId} requestId=${ack.requestId} phase=${ack.status} httpStatus=${ack.httpStatus} elapsedMs=${ackElapsedMs} error=${ack.body.error ?? 'none'}`);
  if (ack.status === 'ready') {
    // 新鲜度以设备收到 prepare 时的 millis() 为准。Gateway 的本地计时
    // 与设备时钟起点不同，不能按 elapsedMs 丢弃 ready；即使往返较慢，
    // 也交给固件的 3 秒 freshness 校验，过期时设备会明确回 COMMAND_EXPIRED。
    if (entry.executing) return;
    if (ack.httpStatus !== 200 ||
        !Number.isInteger(ack.body.issuedAtMs) || ack.body.issuedAtMs < 0 ||
        ack.body.issuedAtMs > 0xffffffff ||
        !/^[0-9a-f]{64}$/.test(ack.body.challenge ?? '')) {
      entry.reject(Object.assign(new Error('INVALID_READY_ACK'), {
        status: 502,
        commandPublished: false,
      }));
      return;
    }
    entry.executing = true;
    const {deviceId: ignoredDevice, ...command} = entry.command;
    mqttClient.publish(topic(deviceId, 'command'), JSON.stringify({
      ...command, version: 2, phase: 'execute',
      issuedAtMs: ack.body.issuedAtMs, challenge: ack.body.challenge,
    }), {qos: 1, retain: false}, (error) => {
      if (error && pending.get(requestKey(deviceId, '', ack.requestId)) === entry) {
        entry.reject(Object.assign(new Error('MQTT_PUBLISH_UNCONFIRMED'), {
          status: 504, commandPublished: true,
        }));
      }
    });
    return;
  }
  if (ack.body.error === 'REQUEST_BODY_UNKNOWN') {
    // 旧固件去重记录没有正文摘要，不能将“不知道请求内容”缓存为拒绝执行。
    entry.reject(Object.assign(new Error('REQUEST_BODY_UNKNOWN'), {
      status: 504, commandPublished: true,
    }));
    return;
  }
  const result = {
    requestId: ack.requestId,
    httpStatus: ack.httpStatus,
    body: ack.body && typeof ack.body === 'object' && !Array.isArray(ack.body)
      ? ack.body
      : { error: 'INVALID_DEVICE_RESPONSE' },
  };
  entry.resolve(result);
}

function timeHealthSample() {
  let health;
  try { health = JSON.parse(fs.readFileSync(config.timeHealthFile, 'utf8')); }
  catch { return {status: 'unavailable', reason: 'health_source_missing'}; }
  const nowWall = Date.now();
  const nowMonotonic = performance.now();
  if (!health || health.schemaVersion !== 1 ||
      !Number.isSafeInteger(health.sequence) || health.sequence < 0 ||
      !Number.isSafeInteger(health.updatedAtUnixMs) ||
      !Number.isSafeInteger(health.utcMs) ||
      !Number.isFinite(health.accuracyMs) || health.accuracyMs < 0 ||
      !Number.isFinite(health.syncAgeMs) || health.syncAgeMs < 0) {
    observedTimeHealthSequence = null;
    observedTimeHealth = null;
    observedTimeHealthAgeAtReadMs = 0;
    return {status: 'unavailable', reason: 'health_schema_invalid'};
  }
  const writeAgeMs = nowWall - health.updatedAtUnixMs;
  if (writeAgeMs < -1000 || writeAgeMs > 30000) {
    observedTimeHealthSequence = null;
    observedTimeHealth = null;
    observedTimeHealthAgeAtReadMs = 0;
    return {status: 'unavailable', reason: 'health_provider_stale'};
  }
  if (health.sequence !== observedTimeHealthSequence) {
    observedTimeHealthSequence = health.sequence;
    observedTimeHealthMonotonicAt = nowMonotonic;
    // Anchor the provider timestamp to monotonic time once. Adding writeAgeMs
    // on every read as well as observedAgeMs would count the same age twice.
    observedTimeHealthAgeAtReadMs = Math.max(0, writeAgeMs);
    observedTimeHealth = health;
  }
  const observedAgeMs = nowMonotonic - observedTimeHealthMonotonicAt;
  if (observedAgeMs > 30000) return {status: 'unavailable', reason: 'health_sequence_stale'};
  if (health.synchronized !== true) return {status: 'unavailable', reason: 'host_clock_unsynchronized'};
  const syncAgeMs = health.syncAgeMs + writeAgeMs;
  if (syncAgeMs > 6 * 60 * 60 * 1000) return {status: 'unavailable', reason: 'last_sync_too_old'};
  if (health.accuracyMs > 1000) return {status: 'unavailable', reason: 'accuracy_unavailable'};
  return {
    status: 'available',
    utcMs: health.utcMs + observedTimeHealthAgeAtReadMs + observedAgeMs,
    accuracyMs: health.accuracyMs,
  };
}

function startMqtt() {
  if (stopping) return;
  const client = createMqttClient();
  mqttClient = client;
  client.on('connect', () => {
    client.subscribe(['mimivent/v1/+/ack', 'mimivent/v1/+/state',
      'mimivent/v1/+/query-reply', 'mimivent/v1/+/time-request'], { qos: 1 }, (error, grants) => {
      if (client !== mqttClient || stopping) return;
      mqttReady = !error && grants?.length === 4 &&
        grants.slice(0, 3).every((grant) => grant.qos === 1);
      mqttTimeReady = !error && grants?.length === 4 && grants[3].qos === 1;
      if (!mqttReady) client.end(true);
    });
  });
  client.on('close', () => {
    if (client !== mqttClient) return;
    mqttReady = false;
    mqttTimeReady = false;
    // 销毁旧发件箱，防止重连后补发已经超时的控制。
    client.end(true);
    for (const entry of [...pending.values()]) {
      entry.reject(Object.assign(new Error('MQTT_CONNECTION_LOST'), {
        status: entry.executing ? 504 : 503, commandPublished: entry.executing,
      }));
    }
    for (const query of [...pendingQueries.values()]) {
      query.reject(Object.assign(new Error('MQTT_CONNECTION_LOST'), {status: 503}));
    }
    if (!stopping) reconnectTimer = setTimeout(startMqtt, 3000);
  });
  client.on('error', (error) => console.error(`MQTT error: ${error.code ?? 'unknown'}`));
  client.on('message', (topic, payload, packet) => {
    if (client === mqttClient) onMqttMessage(topic, payload, packet);
  });
}
startMqtt();

const server = https.createServer({
  cert: fs.readFileSync(config.tlsCertFile),
  key: fs.readFileSync(config.tlsKeyFile),
  minVersion: 'TLSv1.2',
}, async (request, response) => {
  let url;
  try { url = new URL(request.url ?? '/', 'https://nas-gateway.local'); }
  catch { return writeJson(response, 400, { error: 'INVALID_URL' }); }
  if (request.method === 'GET' && (url.pathname === '/setup' || url.pathname === '/') && !url.search) {
    return writeSetupPage(response, request.method);
  }
  if (request.method === 'GET' && url.pathname === '/healthz') {
    return writeJson(response, 200, {
      ok: true,
      mqttConnected: mqttReady,
      timeSyncReady: mqttTimeReady,
    });
  }
  const queryRoute = /^\/api\/v1\/devices\/([0-9a-f]{32})\/requests\/([0-9a-f-]{36})$/.exec(url.pathname);
  if (request.method === 'GET' && queryRoute && !url.search && uuidPattern.test(queryRoute[2])) {
    const result = queryResult(request, queryRoute[1], queryRoute[2]);
    return writeJson(response, result.code, result.body);
  }
  const stateRoute = /^\/api\/v1\/devices\/([0-9a-f]{32})\/state$/.exec(url.pathname);
  if (request.method === 'GET' && stateRoute && !url.search) {
    const result = readCachedState(request, stateRoute[1]);
    return writeJson(response, result.code, result.body);
  }
  const readRoute = /^\/api\/v1\/devices\/([0-9a-f]{32})\/query$/.exec(url.pathname);
  if (request.method === 'POST' && readRoute && !url.search) {
    if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) {
      return writeJson(response, 415, {error: 'JSON_REQUIRED'});
    }
    try {
      const access = validateQueryAccess(request, readRoute[1]);
      if (access.code !== 200) return writeJson(response, access.code, {error: access.error});
      const raw = await readJson(request);
      const path = queryPath(raw?.path);
      if (!path) return writeJson(response, 400, {error: 'QUERY_PATH_NOT_ALLOWED'});
      const result = await queryDevice(readRoute[1], access.tokenId, access.token, path);
      if (result.statusCode === 401 && result.body?.error === 'BINDING_INVALID') {
        console.error(`[gw] service credential rejected by device device=${readRoute[1]} credentialId=${access.tokenId}`);
        return writeJson(response, 409, {error: 'SERVICE_CREDENTIAL_MISMATCH'});
      }
      return writeJson(response, 200, {
        schemaVersion: 1,
        deviceId: readRoute[1],
        statusCode: result.statusCode,
        body: result.body,
      });
    } catch (error) {
      const status = Number.isInteger(error.status) ? error.status : 400;
      return writeJson(response, status, {error: error.message ?? 'QUERY_FAILED'});
    }
  }
  // ---- P2 单服务授权：首配会话、手机凭据、邀请 ----
  if (request.method === 'POST' && url.pathname === '/api/v1/setup/windows' && !url.search) {
    const window = authorization.openSetupWindow();
    return writeJson(response, 200, window);
  }
  if (request.method === 'POST' && url.pathname === '/api/v1/setup/sessions' && !url.search) {
    if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) {
      return writeJson(response, 415, {error: 'JSON_REQUIRED'});
    }
    try {
      const raw = await readJson(request);
      const appInstanceId = request.headers['x-app-instance-id'] ?? raw?.appInstanceId;
      const session = authorization.createSetupSession({
        setupId: raw?.setupId, setupSecret: raw?.setupSecret, appInstanceId,
      });
      if (!session) return writeJson(response, 403, {error: 'SETUP_WINDOW_INVALID_OR_EXPIRED'});
      return writeJson(response, 200, session);
    } catch (error) {
      const status = Number.isInteger(error.status) ? error.status : 400;
      return writeJson(response, status, {error: error.message ?? 'SETUP_SESSION_FAILED'});
    }
  }
  const setupRoute = /^\/api\/v1\/setup\/sessions\/([0-9a-f-]{36})\/(resume|service|verify|complete|cancel)$/.exec(url.pathname);
  if (setupRoute && !url.search) {
    const setupId = setupRoute[1];
    const action = setupRoute[2];
    if (!uuidPattern.test(setupId)) return writeJson(response, 400, {error: 'INVALID_SETUP_ID'});
    if (request.method !== 'POST' || !request.headers['content-type']?.toLowerCase().startsWith('application/json')) {
      return writeJson(response, 405, {error: 'METHOD_NOT_ALLOWED'});
    }
    try {
      const raw = await readJson(request);
      const sessionToken = raw?.sessionToken;
      if (action === 'resume') {
        const session = authorization.resumeSetupSession({setupId, sessionToken});
        if (!session) return writeJson(response, 403, {error: 'SETUP_SESSION_INVALID'});
        return writeJson(response, 200, {
          stage: session.stage,
          deviceId: session.device_id,
          expiresAt: session.expires_at,
        });
      }
      if (action === 'service') {
        const saved = authorization.saveServiceCredential({
          setupId, sessionToken, deviceId: raw?.deviceId,
          tokenId: raw?.credentialId, token: raw?.token,
        });
        if (!saved) return writeJson(response, 403, {error: 'SERVICE_CREDENTIAL_REJECTED'});
        return writeJson(response, 200, {stage: 'pending_device'});
      }
      if (action === 'verify') {
        // 设备在最终确认前保留旧有效凭据；核验新凭据时检查激活候选字段。
        const session = authorization.getSetupSession(setupId, sessionToken);
        if (!session || !session.device_id) return writeJson(response, 403, {error: 'SETUP_SESSION_INVALID'});
        const staged = authorization.readStagedServiceCredential(setupId, session.device_id);
        if (!staged) return writeJson(response, 409, {error: 'SERVICE_NOT_STAGED'});
        const snapshot = state.get(session.device_id);
        if (!snapshot) return writeJson(response, 503, {error: 'DEVICE_NOT_CONNECTED'});
        const decoded = decodeStateSnapshot(snapshot.value, session.device_id);
        if (decoded.error) return writeJson(response, 502, {error: decoded.error});
        const service = decoded.state?.service;
        const candidateMatches = service?.candidateCredentialId === staged.tokenId &&
          service?.candidateTransactionId === setupId && service?.candidateState === 'activated';
        const alreadyCommitted = service?.credentialId === staged.tokenId;
        if (!candidateMatches && !alreadyCommitted) {
          return writeJson(response, 409, {error: 'SERVICE_NOT_ACTIVE_ON_DEVICE'});
        }
        // 设备激活候选或已完成最终提交并上报 state 后，Gateway 才推进事务阶段。
        if (session.stage === 'pending_device') {
          authorization.updateSetupStage({setupId, sessionToken, stage: 'device_committed'});
        }
        const updated = authorization.updateSetupStage({setupId, sessionToken, stage: 'verified'});
        if (!updated) return writeJson(response, 409, {error: 'SETUP_STAGE_CONFLICT'});
        return writeJson(response, 200, {verified: true, stage: updated.stage, service});
      }
      if (action === 'complete') {
        const credential = authorization.completeSetup({setupId, sessionToken});
        if (!credential) return writeJson(response, 409, {error: 'SETUP_NOT_VERIFIED'});
        console.info(`[gw] setup complete setup=${setupId}`);
        return writeJson(response, 200, {stage: 'completed', ...credential});
      }
      const cancelled = authorization.cancelSetup({
        setupId, sessionToken, devicePendingCancelled: raw?.devicePendingCancelled === true,
      });
      if (!cancelled) return writeJson(response, 409, {error: 'SETUP_CANCEL_REJECTED'});
      return writeJson(response, 200, {stage: cancelled.stage});
    } catch (error) {
      const status = Number.isInteger(error.status) ? error.status : 400;
      return writeJson(response, status, {error: error.message ?? 'SETUP_ACTION_FAILED'});
    }
  }
  const resetRoute = /^\/api\/v1\/devices\/([0-9a-f]{32})\/reset$/.exec(url.pathname);
  if (resetRoute && request.method === 'POST' && !url.search) {
    const deviceId = resetRoute[1];
    const actor = appAccess(request, deviceId);
    if (!actor) return writeJson(response, 401, {error: 'AUTH_REQUIRED'});
    const done = authorization.resetDevice(deviceId);
    if (!done) return writeJson(response, 400, {error: 'RESET_FAILED'});
    console.info(`[gw] device auth reset device=${deviceId} app=${actor.app_instance_id}`);
    return writeJson(response, 200, {deviceId, reset: true});
  }
  const appsRoute = /^\/api\/v1\/devices\/([0-9a-f]{32})\/apps(?:\/([0-9a-f]{32}))?$/.exec(url.pathname);
  if (appsRoute && !url.search) {
    const deviceId = appsRoute[1];
    const targetApp = appsRoute[2] ?? '';
    // 管理手机不设唯一管理员角色；所有已加入手机对当前设备拥有相同管理权限。
    const viewer = appAccess(request, deviceId);
    if (!viewer) return writeJson(response, 401, {error: 'AUTH_REQUIRED'});
    if (request.method === 'GET' && !targetApp) {
      const rows = authorization.listApps(deviceId).map((row) => ({
        appInstanceId: row.app_instance_id, role: 'control', name: row.name,
        createdAt: row.created_at, revoked: row.revoked_at != null,
      }));
      return writeJson(response, 200, {
        deviceId,
        currentAppInstanceId: viewer.app_instance_id,
        currentRole: 'control',
        apps: rows,
      });
    }
    if (request.method === 'DELETE' && targetApp) {
      if (targetApp === viewer.app_instance_id) {
        return writeJson(response, 409, {error: 'CANNOT_REVOKE_SELF'});
      }
      const revoked = authorization.revokeApp({deviceId, appInstanceId: targetApp});
      if (!revoked) return writeJson(response, 404, {error: 'APP_NOT_FOUND'});
      return writeJson(response, 200, {deviceId, appInstanceId: targetApp, revoked: true});
    }
    if (request.method === 'POST' && !targetApp) {
      const invite = authorization.createInvite({
        deviceId, createdByAppInstanceId: viewer.app_instance_id,
        expiresAt: Date.now() + 24 * 60 * 60 * 1000,
      });
      if (!invite) return writeJson(response, 409, {error: 'INVITE_FAILED'});
      return writeJson(response, 200, {deviceId, ...invite});
    }
    return writeJson(response, 405, {error: 'METHOD_NOT_ALLOWED'});
  }
  if (request.method === 'POST' && url.pathname === '/api/v1/invites/redeem' && !url.search) {
    if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) {
      return writeJson(response, 415, {error: 'JSON_REQUIRED'});
    }
    try {
      const raw = await readJson(request);
      const issued = authorization.redeemInvite({
        inviteCode: raw?.inviteCode,
        appInstanceId: request.headers['x-app-instance-id'] ?? raw?.appInstanceId,
        name: raw?.name,
      });
      if (!issued) return writeJson(response, 403, {error: 'INVITE_INVALID_OR_EXPIRED'});
      return writeJson(response, 200, issued);
    } catch (error) {
      const status = Number.isInteger(error.status) ? error.status : 400;
      return writeJson(response, status, {error: error.message ?? 'INVITE_REDEEM_FAILED'});
    }
  }
  const route = /^\/api\/v1\/devices\/([0-9a-f]{32})\/control$/.exec(url.pathname);
  if (request.method !== 'POST' || !route || url.search) {
    return writeJson(response, 404, { error: 'NOT_FOUND' });
  }
  const deviceId = route[1];
  if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) {
    return writeJson(response, 415, { error: 'JSON_REQUIRED' });
  }
  let requestId = 'unvalidated';
  try {
    const raw = await readJson(request);
    const command = validateControl(request, deviceId, raw);
    requestId = command.requestId;
    const snapshot = state.get(deviceId);
    const stateAgeMs = snapshot ? Date.now() - snapshot.receivedAt : null;
    console.info(`[gw] control request device=${deviceId} requestId=${requestId} path=${command.path} stateAgeMs=${stateAgeMs ?? 'missing'} mqttReady=${mqttReady}`);
    const result = await publishAndWait(command);
    console.info(`[gw] control http success device=${deviceId} requestId=${requestId} httpStatus=200 deviceStatus=${result.httpStatus}`);
    return writeJson(response, 200, result);
  } catch (error) {
    const status = Number.isInteger(error.status) ? error.status : 400;
    console.warn(`[gw] control http failure device=${deviceId} requestId=${requestId} httpStatus=${status} error=${error.message ?? 'REQUEST_FAILED'} commandPublished=${error.commandPublished ?? 'unknown'}`);
    const body = { error: error.message ?? 'REQUEST_FAILED' };
    if (error.commandPublished === false) body.commandPublished = false;
    if (status === 504) body.commandPublished = true;
    return writeJson(response, status, body);
  }
});

// HTTP 快捷入口直接提供首配页面，避免 FN Connect 改写跨端口 HTTPS 重定向。
const setupRedirectServer = http.createServer((request, response) => {
  let url;
  try { url = new URL(request.url ?? '/', 'http://nas-gateway.local'); }
  catch { return writeJson(response, 400, { error: 'INVALID_URL' }); }
  if ((request.method === 'GET' || request.method === 'HEAD') &&
      (url.pathname === '/' || url.pathname === '/setup') && !url.search) {
    return writeSetupPage(response, request.method);
  }
  response.writeHead(request.method === 'GET' || request.method === 'HEAD' ? 404 : 405, {
    Allow: 'GET, HEAD',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  return response.end();
});

server.requestTimeout = 5000;
server.headersTimeout = 6000;
server.maxHeadersCount = 32;
server.listen(config.port, '0.0.0.0', () => {
  console.info(`MimiVent NAS gateway listening on ${config.port}`);
  console.info(`首次配置页面：https://${config.nasIp}:${config.port}/`);
  console.info('请在家庭局域网打开此页面查看、复制或扫码导入配置。');
});
setupRedirectServer.listen(config.httpSetupPort, '0.0.0.0', () => {
  console.info(`Docker HTTP 配置页：http://${config.nasIp}:${config.httpSetupPort}/`);
});

function shutdown() {
  stopping = true;
  mqttReady = false;
  clearTimeout(reconnectTimer);
  server.close();
  setupRedirectServer.close();
  mqttClient.end(false, {}, () => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
