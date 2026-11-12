import { Hono, type Context } from 'hono';
import { hash } from 'bcryptjs';
import type { AppEnv, UserRow } from '../core/types';
import { AppError } from '../core/errors';
import { input, text } from '../core/request';
import { requireAdmin, requireCsrf, requireSession, nowSeconds } from '../security/auth';
import { encrypt, randomToken } from '../security/crypto';
import type { SqlStatement } from '../storage/sql';

interface UserListRow extends UserRow {
  created_at: number;
  permission_count: number;
  session_count: number;
}

interface SessionVersionRow extends Record<string, unknown> {
  id: number;
  level: number;
  status: number;
  permission_version: number;
  is_api: number;
  apikey_cipher: string | null;
  expires_at: number | null;
}

const MAX_USERS = 200;

function requireSql(c: Context<AppEnv>): void {
  if (c.get('storage').config.format !== 'sql') {
    throw new AppError(501, '当前存储格式尚未支持用户管理，请使用 DB_FORMAT=sql', 'STORAGE_FORMAT_UNSUPPORTED');
  }
}

function userPassword(value: unknown): string {
  if (typeof value !== 'string') throw new AppError(400, '密码需要 12–72 字节', 'INVALID_PASSWORD');
  const bytes = new TextEncoder().encode(value).length;
  if (bytes < 12 || bytes > 72) throw new AppError(400, '密码需要 12–72 字节', 'INVALID_PASSWORD');
  return value;
}

function username(value: unknown): string {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!/^[\p{L}\p{N}_.@-]{3,64}$/u.test(name)) {
    throw new AppError(400, '用户名需为 3–64 位字母、数字或 _.@-', 'INVALID_USERNAME');
  }
  return name;
}

function levelValue(value: unknown): number {
  const level = Number(value);
  if (!Number.isSafeInteger(level) || level < 0 || level > 2) {
    throw new AppError(400, '用户等级只能是 0、1 或 2', 'INVALID_USER_LEVEL');
  }
  return level;
}

function statusValue(value: unknown): number {
  if (value === true || value === 1 || value === '1') return 1;
  if (value === false || value === 0 || value === '0') return 0;
  throw new AppError(400, '账户状态无效', 'INVALID_USER_STATUS');
}

function expiresValue(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const seconds = Number(value);
  if (!Number.isSafeInteger(seconds) || seconds < 0 || seconds > 4_102_444_800) {
    throw new AppError(400, '到期时间无效', 'INVALID_USER_EXPIRY');
  }
  return seconds === 0 ? null : seconds;
}

function userId(value: string): number {
  if (!/^[1-9]\d{0,9}$/.test(value)) throw new AppError(400, '用户编号无效', 'INVALID_USER_ID');
  return Number(value);
}

function userView(row: UserListRow) {
  return {
    id: row.id,
    username: row.username,
    level: row.level,
    status: row.status,
    isApi: row.is_api === 1,
    hasApiKey: Boolean(row.apikey_cipher),
    hasTotp: Boolean(row.totp_cipher),
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    permissionCount: Number(row.permission_count ?? 0),
    sessionCount: Number(row.session_count ?? 0),
  };
}

async function audit(c: Context<AppEnv>, action: string, target: string, detail: string): Promise<void> {
  await c.get('db').execute(
    'INSERT INTO audit_logs (user_id, action, target, detail, created_at) VALUES (?,?,?,?,?)',
    [c.get('principal').user.id, action, target.slice(0, 255), detail.slice(0, 500), nowSeconds()],
  );
}

async function loadUser(c: Context<AppEnv>, id: number): Promise<SessionVersionRow> {
  const rows = await c.get('db').query<SessionVersionRow>(
    'SELECT id, level, status, permission_version, is_api, apikey_cipher, expires_at FROM users WHERE id=?', [id],
  );
  if (!rows[0]) throw new AppError(404, '用户不存在', 'USER_NOT_FOUND');
  return rows[0];
}

async function ensureNotLastAdmin(c: Context<AppEnv>, id: number): Promise<void> {
  const rows = await c.get('db').query<{ count: number }>(
    'SELECT COUNT(*) AS count FROM users WHERE level=2 AND status=1 AND id<>?', [id],
  );
  if (Number(rows[0]?.count ?? 0) === 0) {
    throw new AppError(409, '至少需要保留一个启用中的管理员', 'LAST_ADMIN_PROTECTED');
  }
}

function collectDomainIds(value: unknown): string[] {
  if (!Array.isArray(value)) throw new AppError(400, '域名权限必须是编号数组', 'INVALID_PERMISSIONS');
  if (value.length > 200) throw new AppError(400, '一次最多设置 200 个域名权限', 'INVALID_PERMISSIONS');
  const ids = new Set<string>();
  for (const entry of value) {
    const raw = typeof entry === 'number' ? String(entry) : typeof entry === 'string' ? entry.trim() : '';
    if (!/^[1-9]\d{0,9}$/.test(raw)) throw new AppError(400, '域名编号无效', 'INVALID_PERMISSIONS');
    ids.add(raw);
  }
  return [...ids];
}

export function userRoutes() {
  const routes = new Hono<AppEnv>();

  routes.use('/api/v1/users*', async (c, next) => {
    requireSql(c);
    await next();
  });

  routes.get('/api/v1/users', requireSession, async (c) => {
    requireAdmin(c);
    const rows = await c.get('db').query<UserListRow>(
      `SELECT u.*,
        (SELECT COUNT(*) FROM permissions p WHERE p.user_id=u.id) AS permission_count,
        (SELECT COUNT(*) FROM sessions s WHERE s.user_id=u.id AND s.expires_at>?) AS session_count
       FROM users u ORDER BY u.id ASC`,
      [nowSeconds()],
    );
    return c.json({ code: 0, items: rows.map(userView) });
  });

  routes.post('/api/v1/users', requireSession, requireCsrf, async (c) => {
    requireAdmin(c);
    const body = await input(c);
    const name = username(body.username);
    const passwordHash = await hash(userPassword(body.password), 12);
    const level = levelValue(body.level ?? 1);
    const status = body.status === undefined ? 1 : statusValue(body.status);
    const isApi = body.isApi === true || body.isApi === 1;
    const expiresAt = expiresValue(body.expiresAt);
    const apikey = isApi ? `dnsmgr_${randomToken()}` : null;
    const apikeyCipher = apikey ? await encrypt(apikey, c.env.APP_KEY, 'api-key') : null;
    const now = nowSeconds();
    const existing = await c.get('db').query<{ id: number }>('SELECT id FROM users WHERE username=?', [name]);
    if (existing[0]) throw new AppError(409, '用户名已存在', 'USERNAME_EXISTS');
    const total = await c.get('db').query<{ count: number }>('SELECT COUNT(*) AS count FROM users');
    if (Number(total[0]?.count ?? 0) >= MAX_USERS) {
      throw new AppError(409, `用户数量不能超过 ${MAX_USERS} 个`, 'USER_LIMIT_REACHED');
    }
    const result = await c.get('db').execute(
      `INSERT INTO users (username, password_hash, level, status, is_api, apikey_cipher, permission_version, expires_at, created_at)
       VALUES (?,?,?,?,?,?,1,?,?) RETURNING id`,
      [name, passwordHash, level, status, isApi ? 1 : 0, apikeyCipher, expiresAt, now],
    );
    await audit(c, 'user.create', name, `level=${level} status=${status} api=${isApi}`);
    return c.json({
      code: 0,
      user: { id: Number(result.rows[0]?.id ?? 0), username: name, level, status, isApi, expiresAt, createdAt: now },
      ...(apikey ? { apikey } : {}),
    });
  });

  routes.patch('/api/v1/users/:id', requireSession, requireCsrf, async (c) => {
    requireAdmin(c);
    const targetId = userId(c.req.param('id'));
    const current = await loadUser(c, targetId);
    const body = await input(c);
    const self = c.get('principal').user.id === targetId;
    const updates: string[] = [];
    const args: (string | number | null)[] = [];
    let revokeSessions = false;
    let apikey: string | null = null;

    if (body.level !== undefined) {
      const level = levelValue(body.level);
      if (self && level !== 2) throw new AppError(409, '不能降低当前登录管理员自身的等级', 'SELF_DEMOTION_FORBIDDEN');
      if (current.level === 2 && level !== 2) await ensureNotLastAdmin(c, targetId);
      updates.push('level=?'); args.push(level);
      if (level !== current.level) revokeSessions = true;
    }
    if (body.status !== undefined) {
      const status = statusValue(body.status);
      if (self && status !== 1) throw new AppError(409, '不能禁用当前登录的账户', 'SELF_DISABLE_FORBIDDEN');
      if (current.level === 2 && status !== 1) await ensureNotLastAdmin(c, targetId);
      updates.push('status=?'); args.push(status);
      if (status !== current.status) revokeSessions = true;
    }
    if (body.expiresAt !== undefined) {
      updates.push('expires_at=?'); args.push(expiresValue(body.expiresAt));
    }
    if (body.password !== undefined && body.password !== '') {
      updates.push('password_hash=?'); args.push(await hash(userPassword(body.password), 12));
      revokeSessions = true;
    }
    if (body.isApi !== undefined) {
      const isApi = body.isApi === true || body.isApi === 1;
      updates.push('is_api=?'); args.push(isApi ? 1 : 0);
      if (!isApi) {
        updates.push('apikey_cipher=?'); args.push(null);
      } else if (!current.apikey_cipher || body.rotateApiKey === true) {
        apikey = `dnsmgr_${randomToken()}`;
        updates.push('apikey_cipher=?'); args.push(await encrypt(apikey, c.env.APP_KEY, 'api-key'));
      }
      if ((isApi ? 1 : 0) !== current.is_api) revokeSessions = true;
    } else if (body.rotateApiKey === true) {
      if (current.is_api !== 1) throw new AppError(409, '请先启用 API 访问后再轮换密钥', 'API_ACCESS_DISABLED');
      apikey = `dnsmgr_${randomToken()}`;
      updates.push('apikey_cipher=?'); args.push(await encrypt(apikey, c.env.APP_KEY, 'api-key'));
    }
    if (body.resetTotp === true) {
      updates.push('totp_cipher=?'); args.push(null);
      revokeSessions = true;
    }
    if (updates.length === 0) throw new AppError(400, '没有需要更新的字段', 'NO_USER_CHANGES');
    if (revokeSessions) updates.push('permission_version=permission_version+1');
    const statements: SqlStatement[] = [{
      sql: `UPDATE users SET ${updates.join(', ')} WHERE id=? RETURNING id, username, level, status, is_api, apikey_cipher, totp_cipher, expires_at, created_at`,
      args: [...args, targetId],
    }];
    if (revokeSessions) statements.push({ sql: 'DELETE FROM sessions WHERE user_id=?', args: [targetId] });
    if (body.resetTotp === true) statements.push({ sql: 'DELETE FROM totp_counters WHERE user_id=?', args: [targetId] });
    const results = await c.get('db').batch(statements);
    const row = results[0]?.rows[0];
    await audit(c, 'user.update', String(targetId), `${updates.join(',')}${revokeSessions ? ',sessions-revoked' : ''}`);
    return c.json({
      code: 0,
      user: row ? userView({
        ...(row as unknown as UserListRow),
        permission_count: 0,
        session_count: 0,
      }) : undefined,
      ...(apikey ? { apikey } : {}),
    });
  });

  routes.delete('/api/v1/users/:id', requireSession, requireCsrf, async (c) => {
    requireAdmin(c);
    const targetId = userId(c.req.param('id'));
    if (c.get('principal').user.id === targetId) {
      throw new AppError(409, '不能删除当前登录的账户', 'SELF_DELETE_FORBIDDEN');
    }
    const current = await loadUser(c, targetId);
    if (current.level === 2 && current.status === 1) await ensureNotLastAdmin(c, targetId);
    await c.get('db').execute('DELETE FROM users WHERE id=?', [targetId]);
    await audit(c, 'user.delete', String(targetId), `username-level=${current.level}`);
    return c.json({ code: 0 });
  });

  routes.get('/api/v1/users/:id/permissions', requireSession, async (c) => {
    requireAdmin(c);
    const targetId = userId(c.req.param('id'));
    await loadUser(c, targetId);
    const rows = await c.get('db').query<{ id: number; name: string; allowed: number }>(
      `SELECT d.id, d.name,
        CASE WHEN EXISTS (SELECT 1 FROM permissions p WHERE p.user_id=? AND p.domain_id=CAST(d.id AS TEXT)) THEN 1 ELSE 0 END AS allowed
       FROM dns_domains d ORDER BY d.id ASC`,
      [targetId],
    );
    return c.json({
      code: 0,
      domains: rows.map((row) => ({ id: row.id, name: row.name, allowed: row.allowed === 1 })),
      domainIds: rows.filter((row) => row.allowed === 1).map((row) => String(row.id)),
    });
  });

  routes.put('/api/v1/users/:id/permissions', requireSession, requireCsrf, async (c) => {
    requireAdmin(c);
    const targetId = userId(c.req.param('id'));
    await loadUser(c, targetId);
    const domainIds = collectDomainIds((await input(c)).domainIds);
    if (domainIds.length > 0) {
      const placeholders = domainIds.map(() => '?').join(',');
      const existing = await c.get('db').query<{ id: number }>(`SELECT id FROM dns_domains WHERE id IN (${placeholders})`, domainIds);
      if (existing.length !== domainIds.length) {
        throw new AppError(400, '包含不存在的域名编号', 'INVALID_PERMISSIONS');
      }
    }
    const statements: SqlStatement[] = [{ sql: 'DELETE FROM permissions WHERE user_id=?', args: [targetId] }];
    for (const domainId of domainIds) {
      statements.push({ sql: 'INSERT INTO permissions (user_id, domain_id) VALUES (?,?)', args: [targetId, domainId] });
    }
    statements.push({
      sql: 'UPDATE users SET permission_version=permission_version+1 WHERE id=?',
      args: [targetId],
    });
    statements.push({ sql: 'DELETE FROM sessions WHERE user_id=?', args: [targetId] });
    await c.get('db').batch(statements);
    await audit(c, 'user.permissions', String(targetId), domainIds.length > 0 ? domainIds.join(',') : 'none');
    return c.json({ code: 0, domainIds });
  });

  return routes;
}
