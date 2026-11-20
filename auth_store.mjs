import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const opaqueToken = () => crypto.randomBytes(32).toString('base64url');
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');

/** 持久化 Gateway 首配、设备服务凭据及手机授权。 */
export class AuthorizationStore {
  constructor(database, dataDir) {
    this.database = database;
    this.credentialDir = path.join(dataDir, 'credentials');
    fs.mkdirSync(this.credentialDir, {recursive: true, mode: 0o700});
    try { fs.chmodSync(this.credentialDir, 0o700); } catch { /* 由 NAS 文件系统权限兜底 */ }
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS setup_windows (
        setup_id TEXT PRIMARY KEY,
        secret_hash TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        consumed_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS setup_sessions (
        setup_id TEXT PRIMARY KEY,
        session_hash TEXT NOT NULL,
        app_instance_id TEXT NOT NULL,
        device_id TEXT,
        stage TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS service_credentials (
        device_id TEXT PRIMARY KEY,
        token_id TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        credential_ref TEXT NOT NULL,
        setup_id TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS staged_service_credentials (
        setup_id TEXT PRIMARY KEY,
        device_id TEXT NOT NULL,
        token_id TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        credential_ref TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS app_credentials (
        app_instance_id TEXT PRIMARY KEY,
        device_id TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('admin', 'control')),
        name TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        revoked_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS app_invites (
        invite_hash TEXT PRIMARY KEY,
        device_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role = 'control'),
        expires_at INTEGER NOT NULL,
        created_by TEXT NOT NULL,
        used_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS gateway_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    // 角色列仅用于兼容既有 SQLite 文件；升级后所有既有手机统一为普通授权手机。
    this.database.prepare(`
      UPDATE app_credentials
      SET role='control',
          name=CASE WHEN name='NAS 初始管理员' THEN 'NAS 初始手机' ELSE name END
      WHERE role='admin' OR name='NAS 初始管理员'
    `).run();
    const sessionColumns = new Set(this.database.prepare('PRAGMA table_info(setup_sessions)').all().map((row) => row.name));
    if (!sessionColumns.has('expires_at')) {
      this.database.exec('ALTER TABLE setup_sessions ADD COLUMN expires_at INTEGER NOT NULL DEFAULT 0');
      this.database.exec(`UPDATE setup_sessions SET expires_at=updated_at+86400000 WHERE expires_at=0`);
    }
    this.windowPut = this.database.prepare(`
      INSERT INTO setup_windows(setup_id, secret_hash, expires_at, consumed_at)
      VALUES(?, ?, ?, NULL)
      ON CONFLICT(setup_id) DO UPDATE SET secret_hash=excluded.secret_hash,
        expires_at=excluded.expires_at, consumed_at=NULL`);
    this.windowGet = this.database.prepare(
      'SELECT secret_hash, expires_at, consumed_at FROM setup_windows WHERE setup_id=?');
    this.windowConsume = this.database.prepare(
      'UPDATE setup_windows SET consumed_at=? WHERE setup_id=? AND consumed_at IS NULL');
    this.sessionPut = this.database.prepare(`
      INSERT INTO setup_sessions(setup_id, session_hash, app_instance_id, device_id, stage, created_at, updated_at, expires_at)
      VALUES(?, ?, ?, NULL, 'session_active', ?, ?, ?)
      ON CONFLICT(setup_id) DO NOTHING`);
    this.sessionGet = this.database.prepare(
      'SELECT * FROM setup_sessions WHERE setup_id=? AND session_hash=?');
    this.sessionUpdate = this.database.prepare(
      'UPDATE setup_sessions SET device_id=?, stage=?, updated_at=? WHERE setup_id=? AND session_hash=?');
    this.sessionRenew = this.database.prepare(
      'UPDATE setup_sessions SET updated_at=?, expires_at=? WHERE setup_id=? AND session_hash=?');
    this.servicePut = this.database.prepare(`
      INSERT INTO service_credentials(device_id, token_id, token_hash, credential_ref, setup_id, updated_at)
      VALUES(?, ?, ?, ?, ?, ?)
      ON CONFLICT(device_id) DO UPDATE SET token_id=excluded.token_id,
        token_hash=excluded.token_hash, credential_ref=excluded.credential_ref,
        setup_id=excluded.setup_id, updated_at=excluded.updated_at`);
    this.serviceGet = this.database.prepare(
      'SELECT * FROM service_credentials WHERE device_id=?');
    this.stagedServicePut = this.database.prepare(`
      INSERT INTO staged_service_credentials(setup_id, device_id, token_id, token_hash, credential_ref, updated_at)
      VALUES(?, ?, ?, ?, ?, ?)
      ON CONFLICT(setup_id) DO UPDATE SET device_id=excluded.device_id, token_id=excluded.token_id,
        token_hash=excluded.token_hash, credential_ref=excluded.credential_ref, updated_at=excluded.updated_at`);
    this.stagedServiceGet = this.database.prepare(
      'SELECT * FROM staged_service_credentials WHERE setup_id=? AND device_id=?');
    this.stagedServiceDelete = this.database.prepare(
      'DELETE FROM staged_service_credentials WHERE setup_id=?');
    this.appPut = this.database.prepare(`
      INSERT INTO app_credentials(app_instance_id, device_id, token_hash, role, name, created_at, revoked_at)
      VALUES(?, ?, ?, ?, ?, ?, NULL)
      ON CONFLICT(app_instance_id) DO UPDATE SET device_id=excluded.device_id,
        token_hash=excluded.token_hash, role=excluded.role, name=excluded.name,
        created_at=excluded.created_at, revoked_at=NULL`);
    this.appGet = this.database.prepare(
      'SELECT * FROM app_credentials WHERE app_instance_id=? AND device_id=?');
    this.appList = this.database.prepare(`
      SELECT app_instance_id, role, name, created_at, revoked_at
      FROM app_credentials WHERE device_id=? ORDER BY created_at`);
    this.appRevoke = this.database.prepare(
      'UPDATE app_credentials SET revoked_at=? WHERE app_instance_id=? AND device_id=? AND revoked_at IS NULL');
    this.invitePut = this.database.prepare(`
      INSERT INTO app_invites(invite_hash, device_id, role, expires_at, created_by, used_at)
      VALUES(?, ?, 'control', ?, ?, NULL)`);
    this.inviteGet = this.database.prepare(
      'SELECT * FROM app_invites WHERE invite_hash=?');
    this.inviteConsume = this.database.prepare(
      'UPDATE app_invites SET used_at=? WHERE invite_hash=? AND used_at IS NULL');
    this.metaGet = this.database.prepare('SELECT value FROM gateway_meta WHERE key=?');
    this.metaPut = this.database.prepare('INSERT OR IGNORE INTO gateway_meta(key, value) VALUES(?, ?)');
    this.metaPut.run('client_id', crypto.randomUUID());
    this.pruneExpiredSetupData();
    this.pruneCredentialFiles();
  }

  pruneExpiredSetupData(now = Date.now()) {
    this.database.prepare('DELETE FROM setup_windows WHERE expires_at<=?').run(now);
    this.database.prepare(`DELETE FROM staged_service_credentials WHERE setup_id IN (
      SELECT setup_id FROM setup_sessions WHERE expires_at<=? AND stage IN ('cancelled', 'failed')
    )`).run(now);
  }

  gatewayClientId() { return this.metaGet.get('client_id').value; }

  openSetupWindow(now = Date.now(), ttlMs = 5 * 60_000) {
    this.database.prepare('DELETE FROM setup_windows WHERE consumed_at IS NOT NULL OR expires_at<=?').run(now);
    this.database.prepare('UPDATE setup_windows SET consumed_at=? WHERE consumed_at IS NULL').run(now);
    const setupId = crypto.randomUUID();
    const secret = opaqueToken();
    this.windowPut.run(setupId, hash(secret), now + ttlMs);
    return {setupId, setupSecret: secret, expiresAt: now + ttlMs};
  }

  createSetupSession({setupId, setupSecret, appInstanceId, now = Date.now(), ttlMs = 24 * 60 * 60_000}) {
    if (!/^[0-9a-f-]{36}$/i.test(setupId ?? '') ||
        !/^[0-9a-f]{32}$/i.test(appInstanceId ?? '') ||
        !/^[A-Za-z0-9_-]{43}$/.test(setupSecret ?? '')) return null;
    const window = this.windowGet.get(setupId);
    if (!window || window.consumed_at !== null || window.expires_at <= now ||
        !crypto.timingSafeEqual(Buffer.from(window.secret_hash, 'hex'), Buffer.from(hash(setupSecret), 'hex'))) return null;
    const sessionToken = opaqueToken();
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const consumed = this.windowConsume.run(now, setupId);
      if (Number(consumed.changes) !== 1) { this.database.exec('ROLLBACK'); return null; }
      this.sessionPut.run(setupId, hash(sessionToken), appInstanceId, now, now, now + ttlMs);
      const session = this.database.prepare('SELECT setup_id FROM setup_sessions WHERE setup_id=?').get(setupId);
      if (!session) throw new Error('SETUP_SESSION_CREATE_FAILED');
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
    return {setupId, sessionToken};
  }

  getSetupSession(setupId, sessionToken, now = Date.now()) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(sessionToken ?? '')) return null;
    const session = this.sessionGet.get(setupId, hash(sessionToken)) ?? null;
    return session && session.expires_at > now ? session : null;
  }

  /** 用本机加密存储的会话令牌恢复中断事务；候选授权在设备上已激活时不能因 TTL 到期丢失恢复通道。 */
  resumeSetupSession({setupId, sessionToken, now = Date.now(), ttlMs = 24 * 60 * 60_000}) {
    if (!/^[0-9a-f-]{36}$/i.test(setupId ?? '') ||
        !/^[A-Za-z0-9_-]{43}$/.test(sessionToken ?? '')) return null;
    const session = this.sessionGet.get(setupId, hash(sessionToken)) ?? null;
    if (!session || ['cancelled', 'failed'].includes(session.stage)) return null;
    this.sessionRenew.run(now, now + ttlMs, setupId, hash(sessionToken));
    return {...session, updated_at: now, expires_at: now + ttlMs};
  }

  saveServiceCredential({setupId, sessionToken, deviceId, tokenId, token, now = Date.now()}) {
    const session = this.getSetupSession(setupId, sessionToken, now);
    if (!session || !['session_active', 'pending_device', 'device_committed', 'verified'].includes(session.stage) ||
        (session.device_id && session.device_id !== deviceId) ||
        !/^[0-9a-f]{32}$/.test(deviceId ?? '') ||
        !/^[0-9a-f]{32}$/.test(tokenId ?? '') || !/^[A-Za-z0-9_-]{43}$/.test(token ?? '')) return false;
    // 允许 BLE 端重新建立服务授权时覆盖 Gateway 残留的旧授权。
    // 这一步只暂存候选；只有设备上报新 credentialId 并通过 verify 后才会替换现有数据。
    const reference = `service-${deviceId}-${setupId}.json`;
    const target = path.join(this.credentialDir, reference);
    const temp = `${target}.${crypto.randomBytes(8).toString('hex')}.tmp`;
    const content = JSON.stringify({schemaVersion: 1, deviceId, tokenId, token});
    const fd = fs.openSync(temp, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, content, 'utf8');
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    try {
      fs.renameSync(temp, target);
      const dirFd = fs.openSync(this.credentialDir, 'r');
      try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
      this.database.exec('BEGIN IMMEDIATE');
      try {
        this.stagedServicePut.run(setupId, deviceId, tokenId, hash(token), reference, now);
        const stage = session.stage === 'session_active' ? 'pending_device' : session.stage;
        this.sessionUpdate.run(deviceId, stage, now, setupId, hash(sessionToken));
        this.database.exec('COMMIT');
      } catch (error) { this.database.exec('ROLLBACK'); throw error; }
    } catch (error) {
      try { fs.unlinkSync(temp); } catch { /* 已 rename 或已清理 */ }
      throw error;
    }
    return true;
  }

  updateSetupStage({setupId, sessionToken, stage, now = Date.now()}) {
    const session = this.getSetupSession(setupId, sessionToken, now);
    if (!session) return null;
    if (!['device_committed', 'verified', 'completed', 'failed'].includes(stage)) return null;
    const allowed = {
      device_committed: ['pending_device', 'device_committed'],
      verified: ['device_committed', 'verified'],
      completed: [],
      failed: ['session_active', 'pending_device', 'device_committed', 'failed'],
    };
    if (!allowed[stage].includes(session.stage)) return null;
    this.sessionUpdate.run(session.device_id, stage, now, setupId, hash(sessionToken));
    return this.getSetupSession(setupId, sessionToken, now);
  }

  /** 只取消尚未提交到设备的配置；提交后只能恢复验证或经 BLE 撤销。 */
  cancelSetup({setupId, sessionToken, devicePendingCancelled = false, now = Date.now()}) {
    const session = this.getSetupSession(setupId, sessionToken, now);
    if (!session || !['session_active', 'pending_device'].includes(session.stage)) return null;
    if (session.stage === 'pending_device' && devicePendingCancelled !== true) return null;

    const staged = session.device_id
      ? this.stagedServiceGet.get(setupId, session.device_id)
      : null;
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.stagedServiceDelete.run(setupId);
      this.sessionUpdate.run(session.device_id, 'cancelled', now, setupId, hash(sessionToken));
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
    if (staged?.credential_ref) {
      try { fs.unlinkSync(path.join(this.credentialDir, staged.credential_ref)); } catch { /* DB 已取消，启动时清理孤儿 */ }
    }
    return this.getSetupSession(setupId, sessionToken, now);
  }

  completeSetup({setupId, sessionToken, now = Date.now()}) {
    const session = this.getSetupSession(setupId, sessionToken, now);
    if (!session || !session.device_id) return null;
    if (session.stage === 'completed') {
      if (!this.readServiceCredential(session.device_id)) return null;
      const existing = this.appGet.get(session.app_instance_id, session.device_id);
      if (!existing || existing.revoked_at !== null) return null;
      return this.issueAppCredential({
        appInstanceId: session.app_instance_id,
        deviceId: session.device_id,
        role: 'control',
        name: existing.name,
        now,
      });
    }
    if (session.stage !== 'verified') return null;
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const staged = this.stagedServiceGet.get(setupId, session.device_id);
      if (!staged) { this.database.exec('ROLLBACK'); return null; }
      const previous = this.serviceGet.get(session.device_id);
      this.servicePut.run(staged.device_id, staged.token_id, staged.token_hash,
        staged.credential_ref, setupId, now);
      this.stagedServiceDelete.run(setupId);
      // 新服务已通过设备侧核验，视为一次明确的重新配置：旧手机权限与未用邀请失效，
      // 当前通过 BLE 完成配置的手机成为首个普通授权手机。整个切换与签发在同一事务内提交。
      this.database.prepare('DELETE FROM app_credentials WHERE device_id=?').run(session.device_id);
      this.database.prepare('DELETE FROM app_invites WHERE device_id=?').run(session.device_id);
      const credential = this.issueAppCredential({
        appInstanceId: session.app_instance_id,
        deviceId: session.device_id,
        role: 'control',
        name: 'NAS 初始手机',
        now,
      });
      if (!credential) throw new Error('APP_CREDENTIAL_ISSUE_FAILED');
      this.sessionUpdate.run(session.device_id, 'completed', now, setupId, hash(sessionToken));
      this.database.exec('COMMIT');
      if (previous?.credential_ref && previous.credential_ref !== staged.credential_ref) {
        try { fs.unlinkSync(path.join(this.credentialDir, previous.credential_ref)); } catch { /* 启动时清理孤儿 */ }
      }
      return credential;
    } catch (error) { this.database.exec('ROLLBACK'); throw error; }
  }

  listApps(deviceId) { return this.appList.all(deviceId); }

  revokeApp({deviceId, appInstanceId, now = Date.now()}) {
    const entry = this.appGet.get(appInstanceId, deviceId);
    if (!entry || entry.revoked_at !== null) return false;
    return Number(this.appRevoke.run(now, appInstanceId, deviceId).changes) === 1;
  }

  /**
   * 清除一台设备的全部授权（服务凭据 + 所有手机凭据 + 候选）。
   * 用于设备侧已清除服务授权后的同步复位，清除所有手机凭据与候选授权。
   */
  resetDevice(deviceId) {
    if (!/^[0-9a-f]{32}$/.test(deviceId ?? '')) return false;
    const rows = this.database.prepare(
      'SELECT credential_ref FROM service_credentials WHERE device_id=?').all(deviceId);
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.prepare('DELETE FROM app_credentials WHERE device_id=?').run(deviceId);
      this.database.prepare('DELETE FROM service_credentials WHERE device_id=?').run(deviceId);
      this.database.prepare('DELETE FROM staged_service_credentials WHERE device_id=?').run(deviceId);
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
    for (const row of rows) {
      if (!/^[a-zA-Z0-9._-]+\.json$/.test(row.credential_ref)) continue;
      try { fs.unlinkSync(path.join(this.credentialDir, row.credential_ref)); } catch { /* 启动时清理孤儿 */ }
    }
    return true;
  }

  readServiceCredential(deviceId) {
    const row = this.serviceGet.get(deviceId);
    if (!row || !/^[a-zA-Z0-9._-]+\.json$/.test(row.credential_ref)) return null;
    try {
      const value = JSON.parse(fs.readFileSync(path.join(this.credentialDir, row.credential_ref), 'utf8'));
      if (value.deviceId !== deviceId || value.tokenId !== row.token_id ||
          hash(value.token) !== row.token_hash) return null;
      return {tokenId: row.token_id, token: value.token};
    } catch { return null; }
  }

  readStagedServiceCredential(setupId, deviceId) {
    const row = this.stagedServiceGet.get(setupId, deviceId);
    if (!row || !/^[a-zA-Z0-9._-]+\.json$/.test(row.credential_ref)) return null;
    try {
      const value = JSON.parse(fs.readFileSync(path.join(this.credentialDir, row.credential_ref), 'utf8'));
      if (value.deviceId !== deviceId || value.tokenId !== row.token_id || hash(value.token) !== row.token_hash) return null;
      return {tokenId: row.token_id, token: value.token};
    } catch { return null; }
  }

  pruneCredentialFiles() {
    const retained = new Set([
      ...this.database.prepare('SELECT credential_ref FROM service_credentials').all(),
      ...this.database.prepare('SELECT credential_ref FROM staged_service_credentials').all(),
    ].map((row) => row.credential_ref));
    for (const name of fs.readdirSync(this.credentialDir)) {
      if (!/^[a-zA-Z0-9._-]+(?:\.json|\.tmp)$/.test(name)) continue;
      if (name.endsWith('.tmp') || (name.endsWith('.json') && !retained.has(name))) {
        try { fs.unlinkSync(path.join(this.credentialDir, name)); } catch { /* 逐项清理 */ }
      }
    }
  }

  issueAppCredential({appInstanceId, deviceId, name = 'MimiVent App', now = Date.now()}) {
    if (!/^[0-9a-f]{32}$/i.test(appInstanceId ?? '') ||
        !/^[0-9a-f]{32}$/.test(deviceId ?? '')) return null;
    const existing = this.database.prepare(
      'SELECT COUNT(*) AS count FROM app_credentials WHERE device_id=? AND revoked_at IS NULL')
      .get(deviceId).count;
    const sameInstance = this.appGet.get(appInstanceId, deviceId);
    if (existing >= 32 && (!sameInstance || sameInstance.revoked_at !== null)) {
      throw Object.assign(new Error('APP_LIMIT_REACHED'), {status: 409});
    }
    const token = opaqueToken();
    // 角色字段保留在 SQLite 中兼容已有数据库，但不再区分管理员和普通手机。
    const role = 'control';
    this.appPut.run(appInstanceId, deviceId, hash(token), role, String(name).slice(0, 80), now);
    return {appInstanceId, appToken: token, role};
  }

  authenticateApp(request, deviceId) {
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.authorization ?? '');
    const appInstanceId = request.headers['x-app-instance-id'];
    if (!match || !/^[0-9a-f]{32}$/i.test(appInstanceId ?? '')) return {error: 'AUTH_REQUIRED', status: 401};
    const entry = this.appGet.get(appInstanceId, deviceId);
    if (!entry || entry.revoked_at !== null ||
        !crypto.timingSafeEqual(Buffer.from(entry.token_hash, 'hex'), Buffer.from(hash(match[1]), 'hex'))) {
      return {error: 'INVALID_BEARER', status: 403};
    }
    return {entry};
  }

  createInvite({deviceId, createdByAppInstanceId, expiresAt, now = Date.now()}) {
    const inviteCode = opaqueToken();
    this.invitePut.run(hash(inviteCode), deviceId, expiresAt, createdByAppInstanceId);
    return {inviteCode, expiresAt};
  }

  redeemInvite({inviteCode, appInstanceId, name = 'MimiVent App', now = Date.now()}) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(inviteCode ?? '') || !/^[0-9a-f]{32}$/i.test(appInstanceId ?? '')) return null;
    const inviteHash = hash(inviteCode);
    const invite = this.inviteGet.get(inviteHash);
    if (!invite || invite.used_at !== null || invite.expires_at <= now) return null;
    const activeApps = this.database.prepare(
      'SELECT COUNT(*) AS count FROM app_credentials WHERE device_id=? AND revoked_at IS NULL')
      .get(invite.device_id).count;
    if (activeApps >= 32) {
      throw Object.assign(new Error('APP_LIMIT_REACHED'), {status: 409});
    }
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const consumed = this.inviteConsume.run(now, inviteHash);
      if (Number(consumed.changes) !== 1) { this.database.exec('ROLLBACK'); return null; }
      const issued = this.issueAppCredential({appInstanceId, deviceId: invite.device_id,
        role: 'control', name, now});
      if (!issued) throw new Error('APP_CREDENTIAL_ISSUE_FAILED');
      this.database.exec('COMMIT');
      return {deviceId: invite.device_id, ...issued};
    } catch (error) { this.database.exec('ROLLBACK'); throw error; }
  }
}
