import type { Context, MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import { md5 } from 'js-md5';
import type { AppEnv, Principal, UserRow } from '../core/types';
import { AppError } from '../core/errors';
import { selectStorage } from '../core/database';
import { assertSameOrigin, input } from '../core/request';
import { constantTimeEqual, decrypt, sha256 } from './crypto';

export function nowSeconds(): number { return Math.floor(Date.now() / 1000); }

function validClientIp(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const ip = value.trim();
  return ip && ip.length <= 128 && !/[\s,]/.test(ip) ? ip : null;
}

export function trustedClientIp(c: Context<AppEnv>): string | null {
  switch (c.env.RUNTIME.platform) {
    case 'local': return '127.0.0.1';
    case 'cloudflare': return validClientIp(c.req.header('CF-Connecting-IP'));
    case 'edgeone': return validClientIp(c.env.CLIENT_IP);
    case 'esa': return validClientIp(c.env.CLIENT_IP);
  }
}

export function assertActive(user: UserRow): void {
  if (user.status !== 1 || (user.expires_at !== null && user.expires_at <= nowSeconds())) {
    throw new AppError(403, '账户已禁用或过期', 'USER_INACTIVE');
  }
}

export async function csrfToken(token: string): Promise<string> { return sha256(`dnsmgr/csrf/${token}`); }

export async function authenticateSession(c: Context<AppEnv>): Promise<Principal> {
  const token = getCookie(c, 'user_token');
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new AppError(401, '请先登录', 'NOT_AUTHENTICATED');
  const tokenHash = await sha256(token);
  const rows = await c.get('db').query<UserRow & { csrf_hash: string; session_version: number; session_expires: number }>(
    `SELECT u.*, s.csrf_hash, s.permission_version AS session_version, s.expires_at AS session_expires
     FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`, [tokenHash],
  );
  const user = rows[0];
  if (!user || user.session_expires <= nowSeconds() || user.session_version !== user.permission_version) {
    throw new AppError(401, '会话已失效，请重新登录', 'SESSION_REVOKED');
  }
  assertActive(user);
  return { user, sessionHash: tokenHash, csrfHash: user.csrf_hash, mode: 'session' };
}

export const requireSession: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.set('principal', await authenticateSession(c));
  await next();
};

async function authenticateCertificateSession(c: Context<AppEnv>): Promise<Principal> {
  const token = getCookie(c, 'user_token');
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new AppError(401, '请先登录', 'NOT_AUTHENTICATED');
  const tokenHash = await sha256(token);
  const rows = await c.get('db').query<UserRow & {
    csrf_hash: string; session_version: number; session_expires: number;
    storage_initialized: number; storage_identity: string | null;
  }>(
    `SELECT u.*, s.csrf_hash, s.permission_version AS session_version, s.expires_at AS session_expires,
      st.initialized AS storage_initialized, st.storage_identity
     FROM sessions s JOIN users u ON u.id=s.user_id JOIN system_state st ON st.id=1
     WHERE s.token_hash=?`, [tokenHash],
  );
  const user = rows[0];
  if (!user || user.session_expires <= nowSeconds() || user.session_version !== user.permission_version) {
    throw new AppError(401, '会话已失效，请重新登录', 'SESSION_REVOKED');
  }
  if (user.storage_initialized === 1 && user.storage_identity !== selectStorage(c.env).identity) {
    throw new AppError(503, '存储配置与初始化身份不一致，需要显式导出/导入', 'STORAGE_IDENTITY_MISMATCH');
  }
  assertActive(user);
  return { user, sessionHash: tokenHash, csrfHash: user.csrf_hash, mode: 'session' };
}

export const requireCertificateSession: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.set('principal', await authenticateCertificateSession(c));
  await next();
};

export const requireCsrf: MiddlewareHandler<AppEnv> = async (c, next) => {
  assertSameOrigin(c);
  const supplied = c.req.header('X-CSRF-Token');
  const expected = c.get('principal').csrfHash;
  if (!supplied || !expected || !constantTimeEqual(await sha256(supplied), expected)) {
    throw new AppError(403, '安全校验失败，请刷新页面重试', 'INVALID_CSRF');
  }
  await next();
};

export function requireAdmin(c: Context<AppEnv>): void {
  if (c.get('principal').user.level !== 2) throw new AppError(403, '需要管理员权限', 'PERMISSION_DENIED');
}

export async function requireDomain(c: Context<AppEnv>, domainId: number, writable = false): Promise<void> {
  const principal = c.get('principal');
  if (!Number.isSafeInteger(domainId) || domainId < 1) throw new AppError(400, '域名编号无效', 'INVALID_DOMAIN');
  if (principal.domainId !== undefined && principal.domainId !== domainId) throw new AppError(403, '域名权限不足', 'PERMISSION_DENIED');
  if (principal.user.level === 2) return;
  if (writable && principal.user.level < 1) throw new AppError(403, '只读用户无法修改解析', 'PERMISSION_DENIED');
  const permission = await c.get('db').query('SELECT 1 AS allowed FROM permissions WHERE user_id = ? AND domain_id = ?', [principal.user.id, String(domainId)]);
  if (!permission[0]) throw new AppError(403, '域名权限不足', 'PERMISSION_DENIED');
}

interface LegacyApiCredentials {
  body: Record<string, unknown>;
  uid: string;
  timestamp: string;
  signature: string;
}

interface LegacyApiUserRow extends UserRow {
  system_initialized: number;
  storage_identity: string | null;
}

async function legacyApiCredentials(c: Context<AppEnv>): Promise<LegacyApiCredentials> {
  if (c.req.method !== 'POST') throw new AppError(403, 'API 仅接受 POST', 'INVALID_API_METHOD');
  const body = await input(c);
  const uid = String(body.uid ?? '');
  const timestamp = String(body.timestamp ?? '');
  const signature = String(body.sign ?? '');
  if (!/^\d{1,15}$/.test(uid) || !/^\d{10}$/.test(timestamp) || !/^[a-f0-9]{32}$/.test(signature) || Math.abs(Number(timestamp) - nowSeconds()) > 300) {
    throw new AppError(403, 'API 参数、签名或时间戳无效', 'INVALID_API_SIGNATURE');
  }
  return { body, uid, timestamp, signature };
}

async function legacyApiUser(c: Context<AppEnv>, row: LegacyApiUserRow, credentials: LegacyApiCredentials): Promise<UserRow> {
  const user: UserRow = {
    id: row.id, username: row.username, password_hash: row.password_hash, level: row.level, status: row.status,
    is_api: row.is_api, apikey_cipher: row.apikey_cipher, totp_cipher: row.totp_cipher,
    permission_version: row.permission_version, expires_at: row.expires_at,
  };
  if (row.system_initialized === 1 && row.storage_identity !== selectStorage(c.env).identity) {
    throw new AppError(503, '存储配置与初始化身份不一致，需要显式导出/导入', 'STORAGE_IDENTITY_MISMATCH');
  }
  if (user.is_api !== 1 || !user.apikey_cipher) throw new AppError(403, 'API 用户无效或未启用', 'INVALID_API_USER');
  assertActive(user);
  const apikey = await decrypt(user.apikey_cipher, c.env.APP_KEY, 'api-key');
  if (!constantTimeEqual(md5(credentials.uid + credentials.timestamp + apikey), credentials.signature)) {
    throw new AppError(403, 'API 签名错误', 'INVALID_API_SIGNATURE');
  }
  return user;
}

export const requireLegacyApi: MiddlewareHandler<AppEnv> = async (c, next) => {
  const credentials = await legacyApiCredentials(c);
  const users = await c.get('db').query<LegacyApiUserRow>(
    `SELECT u.*, s.initialized AS system_initialized, s.storage_identity
     FROM users u JOIN system_state s ON s.id=1 WHERE u.id=?`, [Number(credentials.uid)],
  );
  const row = users[0];
  if (!row) throw new AppError(403, 'API 用户无效或未启用', 'INVALID_API_USER');
  const user = await legacyApiUser(c, row, credentials);
  c.set('principal', { user, mode: 'api' });
  c.set('legacyApiBody', credentials.body);
  await next();
};

export const requireLegacyApiDomain: MiddlewareHandler<AppEnv> = async (c, next) => {
  const credentials = await legacyApiCredentials(c);
  if (c.get('storage').config.format !== 'sql') {
    throw new AppError(501, '当前存储格式尚未支持 DNS 业务表，请使用 DB_FORMAT=sql', 'STORAGE_FORMAT_UNSUPPORTED');
  }
  const domainId = c.req.param('id') ?? '';
  if (!/^[1-9]\d{0,9}$/.test(domainId)) throw new AppError(400, '域名编号无效', 'INVALID_DOMAIN');
  const rows = await c.get('db').query<LegacyApiUserRow & {
    record_domain_id: number | null;
    record_account_id: number | null;
    record_name: string | null;
    record_third_id: string | null;
    record_owner_id: number | null;
    record_owner_type: string | null;
    record_owner_name: string | null;
    record_owner_config_cipher: string | null;
    record_owner_remark: string | null;
    record_owner_created_at: number | null;
    record_owner_updated_at: number | null;
    record_domain_allowed: number;
  }>(
    `SELECT u.*, s.initialized AS system_initialized, s.storage_identity,
      d.id AS record_domain_id, d.account_id AS record_account_id, d.name AS record_name,
      d.third_id AS record_third_id, a.id AS record_owner_id, a.type AS record_owner_type,
      a.name AS record_owner_name, a.config_cipher AS record_owner_config_cipher,
      a.remark AS record_owner_remark, a.created_at AS record_owner_created_at,
      a.updated_at AS record_owner_updated_at,
      CASE WHEN u.level=2 THEN 1 ELSE EXISTS (
        SELECT 1 FROM permissions p WHERE p.user_id=u.id AND p.domain_id=CAST(d.id AS TEXT)
      ) END AS record_domain_allowed
     FROM users u JOIN system_state s ON s.id=1
     LEFT JOIN dns_domains d ON d.id=?
     LEFT JOIN dns_accounts a ON a.id=d.account_id
     WHERE u.id=?`, [Number(domainId), Number(credentials.uid)],
  );
  const row = rows[0];
  if (!row) throw new AppError(403, 'API 用户无效或未启用', 'INVALID_API_USER');
  const user = await legacyApiUser(c, row, credentials);
  if (user.level !== 2 && user.level < 1) throw new AppError(403, '只读 API 用户无法修改解析', 'PERMISSION_DENIED');
  if (row.record_domain_id === null || row.record_owner_id === null || row.record_domain_allowed !== 1) {
    throw new AppError(404, '域名不存在或无权访问', 'DOMAIN_NOT_FOUND');
  }
  c.set('principal', { user, mode: 'api' });
  c.set('legacyApiBody', credentials.body);
  c.set('legacyApiDomain', {
    id: row.record_domain_id, account_id: row.record_account_id, name: row.record_name,
    third_id: row.record_third_id, owner_id: row.record_owner_id, owner_type: row.record_owner_type,
    owner_name: row.record_owner_name, owner_config_cipher: row.record_owner_config_cipher,
    owner_remark: row.record_owner_remark, owner_created_at: row.record_owner_created_at,
    owner_updated_at: row.record_owner_updated_at,
  });
  await next();
};

export async function consumeRateLimit(c: Context<AppEnv>, key: string, limit: number, windowSeconds: number): Promise<void> {
  const now = nowSeconds();
  const results = await c.get('db').batch([
    {
      sql: `DELETE FROM rate_limits WHERE key IN (
        SELECT key FROM rate_limits WHERE window_start <= ? ORDER BY window_start LIMIT 100
      )`,
      args: [now - 120],
    },
    {
      sql: `INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)
            ON CONFLICT(key) DO UPDATE SET
              count = CASE WHEN window_start <= ? THEN 1 ELSE count + 1 END,
              window_start = CASE WHEN window_start <= ? THEN excluded.window_start ELSE window_start END
            RETURNING count`,
      args: [key, now, now - windowSeconds, now - windowSeconds],
    },
  ]);
  const count = results[1]?.rows[0]?.count;
  if (typeof count !== 'number' || count > limit) throw new AppError(429, '请求过于频繁，请稍后重试', 'RATE_LIMITED');
}
