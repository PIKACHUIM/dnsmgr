import { Hono } from 'hono';
import { compare, hash } from 'bcryptjs';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { Context } from 'hono';
import type { AppEnv, UserRow } from '../core/types';
import type { SqlStatement } from '../storage/sql';
import { AppError } from '../core/errors';
import { selectStorage } from '../core/database';
import { assertSameOrigin, input, publicUser, text } from '../core/request';
import { assertActive, consumeRateLimit, csrfToken, nowSeconds, requireCsrf, requireSession } from '../security/auth';
import { constantTimeEqual, decrypt, encrypt, encryptionKey, randomToken, sha256 } from '../security/crypto';
import { newTotpSecret, verifyTotp } from '../security/totp';

interface ChallengeRow extends Record<string, unknown> {
  user_id: number;
  permission_version: number;
  secret_cipher: string | null;
}

const sessionSeconds = 12 * 60 * 60;

function password(body: Record<string, unknown>, key = 'password'): string {
  const value = text(body, key, 72);
  const length = new TextEncoder().encode(value).length;
  if (length < 12 || length > 72) throw new AppError(400, '密码需要 12–72 字节', 'INVALID_PASSWORD');
  return value;
}

function setSessionCookie(c: Context<AppEnv>, token: string): void {
  const url = new URL(c.req.url);
  const secure = (c.env.PUBLIC_ORIGIN ? new URL(c.env.PUBLIC_ORIGIN) : url).protocol === 'https:';
  if (!secure && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new AppError(503, '登录必须使用 HTTPS', 'HTTPS_REQUIRED');
  }
  setCookie(c, 'user_token', token, { httpOnly: true, secure, sameSite: 'Strict', path: '/', maxAge: sessionSeconds });
}

async function createSession(c: Context<AppEnv>, user: UserRow, counter?: SqlStatement): Promise<Response> {
  const token = randomToken();
  const csrf = await csrfToken(token);
  const now = nowSeconds();
  const statement: SqlStatement = {
    sql: `INSERT INTO sessions (token_hash, user_id, permission_version, csrf_hash, expires_at, created_at)
     SELECT ?, id, permission_version, ?, ?, ? FROM users
     WHERE id = ? AND status = 1 AND permission_version = ? AND (expires_at IS NULL OR expires_at > ?)${counter ? ' AND changes() = 1' : ''}`,
    args: [await sha256(token), await sha256(csrf), now + sessionSeconds, now, user.id, user.permission_version, now],
  };
  const results = await c.get('db').batch(counter ? [counter, statement] : [statement]);
  if (counter && results[0]?.changes !== 1) throw new AppError(401, '动态口令已使用，请等待下一个口令', 'TOTP_REPLAY');
  if (results.at(-1)?.changes !== 1) throw new AppError(401, '账户状态已变更，请重新登录', 'SESSION_REVOKED');
  setSessionCookie(c, token);
  return c.json({ code: 0, csrfToken: csrf, user: publicUser(user) });
}

async function createChallenge(c: Context<AppEnv>, user: UserRow, purpose: string, secretCipher: string | null = null): Promise<string> {
  const token = randomToken();
  const now = nowSeconds();
  const result = await c.get('db').execute(
    `INSERT INTO security_challenges (token_hash, purpose, user_id, secret_cipher, permission_version, expires_at, created_at)
     SELECT ?, ?, id, ?, permission_version, ?, ? FROM users
     WHERE id = ? AND status = 1 AND permission_version = ? AND (expires_at IS NULL OR expires_at > ?)`,
    [await sha256(token), purpose, secretCipher, now + 180, now, user.id, user.permission_version, now],
  );
  if (result.changes !== 1) throw new AppError(401, '账户状态已变更，请重新登录', 'SESSION_REVOKED');
  return token;
}

async function consumeChallenge(c: Context<AppEnv>, token: string, purpose: string): Promise<ChallengeRow> {
  const rows = await c.get('db').query<ChallengeRow>(
    `DELETE FROM security_challenges WHERE token_hash = ? AND purpose = ? AND expires_at > ?
     RETURNING user_id, secret_cipher, permission_version`, [await sha256(token), purpose, nowSeconds()],
  );
  if (!rows[0]) throw new AppError(401, '验证请求已过期或已使用，请重新验证', 'CHALLENGE_EXPIRED');
  return rows[0];
}

async function verifiedTotp(userId: number, secret: string, code: string): Promise<SqlStatement> {
  const counter = await verifyTotp(secret, code, nowSeconds());
  if (counter === null) throw new AppError(401, '动态口令错误', 'INVALID_TOTP');
  return {
    sql: `INSERT INTO totp_counters (user_id, counter) VALUES (?, ?)
     ON CONFLICT(user_id) DO UPDATE SET counter = excluded.counter WHERE counter < excluded.counter`,
    args: [userId, counter],
  };
}

export function authRoutes() {
  const routes = new Hono<AppEnv>();

  routes.get('/api/v1/install/status', async (c) => {
    const rows = await c.get('db').query<{ initialized: number }>('SELECT initialized FROM system_state WHERE id = 1');
    if (!rows[0]) throw new AppError(503, '数据库尚未执行迁移', 'SCHEMA_NOT_INITIALIZED');
    return c.json({ code: 0, initialized: rows[0].initialized === 1 });
  });

  routes.post('/install', async (c) => {
    assertSameOrigin(c);
    if (!c.env.SETUP_TOKEN || c.env.SETUP_TOKEN.length < 32) throw new AppError(503, '需要配置不少于 32 字符的 SETUP_TOKEN', 'SETUP_NOT_CONFIGURED');
    if (!constantTimeEqual(c.req.header('X-Setup-Token') ?? '', c.env.SETUP_TOKEN)) throw new AppError(403, '安装授权无效', 'INVALID_SETUP_TOKEN');
    await encryptionKey(c.env.APP_KEY, 'installation');
    const body = await input(c);
    const username = text(body, 'username', 64).trim();
    if (!/^[\p{L}\p{N}_.@-]{3,64}$/u.test(username)) throw new AppError(400, '用户名需为 3–64 位字母、数字或 _.@-', 'INVALID_USERNAME');
    const passwordHash = await hash(password(body), 12);
    const state = await c.get('db').batch([
      {
        sql: `INSERT INTO users (username, password_hash, level, status, is_api, permission_version, created_at)
              SELECT ?, ?, 2, 1, 0, 1, ? FROM system_state WHERE id = 1 AND initialized = 0`,
        args: [username, passwordHash, nowSeconds()],
      },
      { sql: 'UPDATE system_state SET initialized = 1, storage_identity = ? WHERE id = 1 AND initialized = 0', args: [selectStorage(c.env).identity] },
    ]);
    if (state[0]?.changes !== 1 || state[1]?.changes !== 1) throw new AppError(409, '系统已经初始化，禁止重复安装', 'ALREADY_INITIALIZED');
    return c.json({ code: 0, msg: '初始化完成，请登录' });
  });

  routes.post('/login', async (c) => {
    assertSameOrigin(c);
    await encryptionKey(c.env.APP_KEY, 'session');
    const body = await input(c);
    const username = text(body, 'username', 64).trim();
    const supplied = text(body, 'password', 72);
    if (new TextEncoder().encode(supplied).length > 72) throw new AppError(400, '密码格式无效', 'INVALID_PASSWORD');
    await consumeRateLimit(c, `login:${await sha256(username.toLowerCase())}`, 5, 120);
    const users = await c.get('db').query<UserRow>('SELECT * FROM users WHERE username = ?', [username]);
    const user = users[0];
    const valid = user ? await compare(supplied, user.password_hash) : (await hash(supplied, 12), false);
    if (!user || !valid) throw new AppError(401, '用户名或密码错误', 'INVALID_CREDENTIALS');
    assertActive(user);
    if (user.totp_cipher) {
      const challenge = await createChallenge(c, user, 'totp-login');
      return c.json({ code: -1, msg: '需要验证动态口令', vcode: 2, challenge });
    }
    return createSession(c, user);
  });

  routes.post('/auth/totp', async (c) => {
    assertSameOrigin(c);
    const body = await input(c);
    const challenge = await consumeChallenge(c, text(body, 'challenge', 128), 'totp-login');
    const users = await c.get('db').query<UserRow>('SELECT * FROM users WHERE id = ?', [challenge.user_id]);
    const user = users[0];
    if (!user || user.permission_version !== challenge.permission_version || !user.totp_cipher) throw new AppError(401, '账户状态已变更，请重新登录', 'CHALLENGE_EXPIRED');
    assertActive(user);
    const counter = await verifiedTotp(user.id, await decrypt(user.totp_cipher, c.env.APP_KEY, 'totp'), text(body, 'code', 6));
    return createSession(c, user, counter);
  });

  routes.get('/api/v1/session', requireSession, async (c) => c.json({
    code: 0,
    user: publicUser(c.get('principal').user),
    csrfToken: await csrfToken(getCookie(c, 'user_token')!),
  }));

  routes.post('/logout', requireSession, requireCsrf, async (c) => {
    await c.get('db').execute('DELETE FROM sessions WHERE token_hash = ?', [c.get('principal').sessionHash!]);
    deleteCookie(c, 'user_token', { path: '/', secure: new URL(c.env.PUBLIC_ORIGIN ?? c.req.url).protocol === 'https:', sameSite: 'Strict' });
    return c.json({ code: 0 });
  });

  routes.post('/setpwd', requireSession, requireCsrf, async (c) => {
    const user = c.get('principal').user;
    const body = await input(c);
    if (!await compare(text(body, 'currentPassword', 72), user.password_hash)) throw new AppError(401, '当前密码错误', 'INVALID_CREDENTIALS');
    const passwordHash = await hash(password(body), 12);
    const result = await c.get('db').batch([
      { sql: 'UPDATE users SET password_hash = ?, permission_version = permission_version + 1 WHERE id = ? AND permission_version = ?', args: [passwordHash, user.id, user.permission_version] },
      { sql: 'DELETE FROM sessions WHERE user_id = ? AND permission_version <= ? AND changes() = 1', args: [user.id, user.permission_version] },
    ]);
    if (result[0]?.changes !== 1) throw new AppError(409, '账户已变更，请重新登录', 'CONCURRENT_CHANGE');
    deleteCookie(c, 'user_token', { path: '/' });
    return c.json({ code: 0, msg: '密码已更新，请重新登录' });
  });

  routes.post('/totp/generate', requireSession, requireCsrf, async (c) => {
    const user = c.get('principal').user;
    const body = await input(c);
    if (!await compare(text(body, 'password', 72), user.password_hash)) throw new AppError(401, '密码错误', 'INVALID_CREDENTIALS');
    if (user.totp_cipher) throw new AppError(409, '动态口令已启用', 'TOTP_ALREADY_ENABLED');
    const secret = newTotpSecret();
    const challenge = await createChallenge(c, user, 'totp-bind', await encrypt(secret, c.env.APP_KEY, 'totp'));
    const uri = `otpauth://totp/${encodeURIComponent(`DnsMgr:${user.username}`)}?secret=${secret}&issuer=DnsMgr&algorithm=SHA1&digits=6&period=30`;
    return c.json({ code: 0, secret, challenge, uri });
  });

  routes.post('/totp/bind', requireSession, requireCsrf, async (c) => {
    const user = c.get('principal').user;
    const body = await input(c);
    const challenge = await consumeChallenge(c, text(body, 'challenge', 128), 'totp-bind');
    if (challenge.user_id !== user.id || challenge.permission_version !== user.permission_version || !challenge.secret_cipher) throw new AppError(403, '验证请求不属于当前会话', 'INVALID_CHALLENGE');
    const counter = await verifiedTotp(user.id, await decrypt(challenge.secret_cipher, c.env.APP_KEY, 'totp'), text(body, 'code', 6));
    const result = await c.get('db').batch([
      counter,
      { sql: 'UPDATE users SET totp_cipher = ?, permission_version = permission_version + 1 WHERE id = ? AND permission_version = ? AND totp_cipher IS NULL AND changes() = 1', args: [challenge.secret_cipher, user.id, user.permission_version] },
      { sql: 'DELETE FROM sessions WHERE user_id = ? AND permission_version <= ? AND changes() = 1', args: [user.id, user.permission_version] },
    ]);
    if (result[0]?.changes !== 1) throw new AppError(401, '动态口令已使用，请等待下一个口令', 'TOTP_REPLAY');
    if (result[1]?.changes !== 1) throw new AppError(409, '账户已变更，请重新登录', 'CONCURRENT_CHANGE');
    return c.json({ code: 0, msg: '动态口令已启用，请重新登录' });
  });

  routes.post('/totp/close', requireSession, requireCsrf, async (c) => {
    const user = c.get('principal').user;
    if (!user.totp_cipher) throw new AppError(409, '尚未启用动态口令', 'TOTP_NOT_ENABLED');
    const body = await input(c);
    if (!await compare(text(body, 'password', 72), user.password_hash)) throw new AppError(401, '密码错误', 'INVALID_CREDENTIALS');
    const counter = await verifiedTotp(user.id, await decrypt(user.totp_cipher, c.env.APP_KEY, 'totp'), text(body, 'code', 6));
    const result = await c.get('db').batch([
      counter,
      { sql: 'UPDATE users SET totp_cipher = NULL, permission_version = permission_version + 1 WHERE id = ? AND permission_version = ? AND changes() = 1', args: [user.id, user.permission_version] },
      { sql: 'DELETE FROM sessions WHERE user_id = ? AND permission_version <= ? AND changes() = 1', args: [user.id, user.permission_version] },
    ]);
    if (result[0]?.changes !== 1) throw new AppError(401, '动态口令已使用，请等待下一个口令', 'TOTP_REPLAY');
    if (result[1]?.changes !== 1) throw new AppError(409, '账户已变更，请重新登录', 'CONCURRENT_CHANGE');
    return c.json({ code: 0, msg: '动态口令已关闭，请重新登录' });
  });

  return routes;
}
