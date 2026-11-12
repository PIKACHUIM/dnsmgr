import { Hono } from 'hono';
import { compare, hash } from 'bcryptjs';
import { md5 } from 'js-md5';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { Context } from 'hono';
import type { AppEnv, UserRow } from '../core/types';
import type { SqlStatement } from '../storage/sql';
import { AppError } from '../core/errors';
import { selectStorage } from '../core/database';
import { assertSameOrigin, input, publicUser, text } from '../core/request';
import { assertActive, consumeRateLimit, csrfToken, nowSeconds, requireAdmin, requireCsrf, requireSession, trustedClientIp } from '../security/auth';
import { constantTimeEqual, decrypt, encrypt, encryptionKey, randomToken, sha256 } from '../security/crypto';
import { createCaptchaCode, renderCaptchaSvg } from '../security/captcha';
import { newTotpSecret, verifyTotp } from '../security/totp';

interface ChallengeRow extends Record<string, unknown> {
  user_id: number;
  permission_version: number;
  secret_cipher: string | null;
}

const sessionSeconds = 12 * 60 * 60;
const quickLoginSeconds = 300;
const quickLoginDomain = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const expiredChallengePruneLimit = 100;
const loginCaptchaCookie = 'login_captcha';
const loginCaptchaSeconds = 1800;
const loginCaptchaPruneLimit = 100;
const loginCaptchaCapacity = 10000;
const loginRequestsPerMinute = 300;

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

function setLoginCaptchaCookie(c: Context<AppEnv>, token: string): void {
  const url = new URL(c.req.url);
  const secure = (c.env.PUBLIC_ORIGIN ? new URL(c.env.PUBLIC_ORIGIN) : url).protocol === 'https:';
  if (!secure && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new AppError(503, '登录验证码必须使用 HTTPS', 'HTTPS_REQUIRED');
  }
  setCookie(c, loginCaptchaCookie, token, { httpOnly: true, secure, sameSite: 'Strict', path: '/', maxAge: loginCaptchaSeconds });
}

async function consumeCaptchaIssueLimits(c: Context<AppEnv>, clientKey: string): Promise<void> {
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
              count=CASE WHEN window_start<=? THEN 1 ELSE count+1 END,
              window_start=CASE WHEN window_start<=? THEN excluded.window_start ELSE window_start END
            RETURNING count`,
      args: [clientKey, now, now - 60, now - 60],
    },
    {
      sql: `INSERT INTO rate_limits (key, window_start, count) VALUES ('login-captcha:issue', ?, 1)
            ON CONFLICT(key) DO UPDATE SET
              count=CASE WHEN window_start<=? THEN 1 ELSE count+1 END,
              window_start=CASE WHEN window_start<=? THEN excluded.window_start ELSE window_start END
            RETURNING count`,
      args: [now, now - 60, now - 60],
    },
  ]);
  const clientCount = results[1]?.rows[0]?.count;
  const globalCount = results[2]?.rows[0]?.count;
  if (typeof clientCount !== 'number' || typeof globalCount !== 'number') throw new AppError(503, '验证码限流状态不可用', 'RATE_LIMIT_UNAVAILABLE');
  if (clientCount > 10 || globalCount > 120) throw new AppError(429, '验证码请求过于频繁，请稍后重试', 'RATE_LIMITED');
}

async function issueLoginCaptcha(c: Context<AppEnv>): Promise<Response> {
  const settings = await c.get('db').query<{ value: string }>('SELECT value FROM app_settings WHERE key=?', ['vcode']);
  if (settings[0]?.value === '2') return c.body(null, 204, { 'X-Captcha-Enabled': '0' });
  const clientIp = trustedClientIp(c);
  if (!clientIp) throw new AppError(503, '无法获取可信客户端 IP，验证码服务已停止', 'CLIENT_IP_UNAVAILABLE');
  await consumeCaptchaIssueLimits(c, `captcha:issue-ip:${await sha256(clientIp)}`);

  const token = randomToken();
  const code = createCaptchaCode();
  const tokenHash = await sha256(token);
  const answerHash = await sha256(`${token}:${code}`);
  const now = nowSeconds();
  const oldTokenHash = await sha256(getCookie(c, loginCaptchaCookie) ?? '');
  const results = await c.get('db').batch([
    {
      sql: `DELETE FROM login_captcha_challenges WHERE token_hash IN (
        SELECT token_hash FROM login_captcha_challenges WHERE expires_at <= ? ORDER BY expires_at LIMIT ?
      )`,
      args: [now, loginCaptchaPruneLimit],
    },
    { sql: 'DELETE FROM login_captcha_challenges WHERE token_hash=?', args: [oldTokenHash] },
    {
      sql: `INSERT INTO login_captcha_challenges (token_hash, answer_hash, attempts, expires_at, created_at)
            SELECT ?, ?, 0, ?, ? WHERE (SELECT COUNT(*) FROM login_captcha_challenges WHERE expires_at > ?) < ?`,
      args: [tokenHash, answerHash, now + loginCaptchaSeconds, now, now, loginCaptchaCapacity],
    },
  ]);
  if (results[2]?.changes !== 1) throw new AppError(503, '验证码服务繁忙，请稍后重试', 'CAPTCHA_CAPACITY');
  setLoginCaptchaCookie(c, token);
  return c.body(renderCaptchaSvg(code), 200, {
    'Content-Type': 'image/svg+xml; charset=utf-8', 'X-Captcha-Enabled': '1', 'X-Content-Type-Options': 'nosniff',
  });
}

async function verifyCaptchaAndRequestLimit(c: Context<AppEnv>, code: string): Promise<void> {
  const now = nowSeconds();
  const token = getCookie(c, loginCaptchaCookie) ?? '';
  const tokenHash = await sha256(token);
  const answerHash = await sha256(`${token}:${code}`);
  const clientIp = trustedClientIp(c);
  const ipRateKey = clientIp ? `captcha:login-ip:${await sha256(clientIp)}` : null;
  const results = await c.get('db').batch([
    {
      sql: `DELETE FROM rate_limits WHERE key IN (
        SELECT key FROM rate_limits WHERE window_start <= ? ORDER BY window_start LIMIT 100
      )`,
      args: [now - 120],
    },
    { sql: 'SELECT value FROM app_settings WHERE key=?', args: ['vcode'] },
    {
      sql: `INSERT INTO rate_limits (key, window_start, count) VALUES ('captcha:login-requests', ?, 1)
            ON CONFLICT(key) DO UPDATE SET
              count=CASE WHEN window_start<=? THEN 1 ELSE count+1 END,
              window_start=CASE WHEN window_start<=? THEN excluded.window_start ELSE window_start END
            RETURNING count`,
      args: [now, now - 60, now - 60],
    },
    {
      sql: `INSERT INTO rate_limits (key, window_start, count)
            SELECT ?, ?, 1 WHERE ? IS NOT NULL
            ON CONFLICT(key) DO UPDATE SET
              count=CASE WHEN window_start<=? THEN 1 ELSE count+1 END,
              window_start=CASE WHEN window_start<=? THEN excluded.window_start ELSE window_start END
            RETURNING count`,
      args: [ipRateKey, now, ipRateKey, now - 60, now - 60],
    },
    {
      sql: `DELETE FROM login_captcha_challenges WHERE token_hash=? AND answer_hash=? AND expires_at>?
            AND ? IS NOT NULL AND COALESCE((SELECT value FROM app_settings WHERE key='vcode'),'1')<>'2'
            RETURNING token_hash`,
      args: [tokenHash, answerHash, now, ipRateKey],
    },
    {
      sql: `UPDATE login_captcha_challenges SET attempts=attempts+1
            WHERE token_hash=? AND answer_hash<>? AND expires_at>? AND attempts<4 AND ? IS NOT NULL
              AND COALESCE((SELECT value FROM app_settings WHERE key='vcode'),'1')<>'2'`,
      args: [tokenHash, answerHash, now, ipRateKey],
    },
    {
      sql: `DELETE FROM login_captcha_challenges WHERE token_hash=? AND expires_at>? AND attempts>=4 AND ? IS NOT NULL
            AND COALESCE((SELECT value FROM app_settings WHERE key='vcode'),'1')<>'2'`,
      args: [tokenHash, now, ipRateKey],
    },
  ]);
  const requestCount = results[2]?.rows[0]?.count;
  if (typeof requestCount !== 'number') throw new AppError(503, '登录限流状态不可用', 'RATE_LIMIT_UNAVAILABLE');
  if (requestCount > loginRequestsPerMinute) throw new AppError(429, '登录请求过于频繁，请稍后重试', 'RATE_LIMITED');
  const clientCount = results[3]?.rows[0]?.count;
  if (ipRateKey && typeof clientCount !== 'number') throw new AppError(503, '客户端限流状态不可用', 'RATE_LIMIT_UNAVAILABLE');
  if (typeof clientCount === 'number' && clientCount > 30) throw new AppError(429, '客户端登录请求过于频繁，请稍后重试', 'RATE_LIMITED');
  const captchaEnabled = results[1]?.rows[0]?.value !== '2';
  if (captchaEnabled && !ipRateKey) throw new AppError(503, '无法获取可信客户端 IP，验证码服务已停止', 'CLIENT_IP_UNAVAILABLE');
  if (captchaEnabled && results[4]?.changes !== 1) {
    throw new AppError(401, '验证码错误或已过期，请刷新后重试', 'INVALID_CAPTCHA');
  }
}

async function createSession(c: Context<AppEnv>, user: UserRow, counter?: SqlStatement, clearLoginKey?: string): Promise<Response> {
  const token = randomToken();
  const csrf = await csrfToken(token);
  const now = nowSeconds();
  const statement: SqlStatement = {
    sql: `INSERT INTO sessions (token_hash, user_id, permission_version, csrf_hash, expires_at, created_at)
     SELECT ?, id, permission_version, ?, ?, ? FROM users
     WHERE id = ? AND status = 1 AND permission_version = ? AND (expires_at IS NULL OR expires_at > ?)${counter ? ' AND changes() = 1' : ''}`,
    args: [await sha256(token), await sha256(csrf), now + sessionSeconds, now, user.id, user.permission_version, now],
  };
  const statements: SqlStatement[] = [];
  if (counter) statements.push(counter);
  const sessionIndex = statements.length;
  statements.push(statement);
  if (clearLoginKey) statements.push({
    sql: 'DELETE FROM rate_limits WHERE key=? AND changes()=1', args: [clearLoginKey],
  });
  const results = await c.get('db').batch(statements);
  if (counter && results[0]?.changes !== 1) throw new AppError(401, '动态口令已使用，请等待下一个口令', 'TOTP_REPLAY');
  if (results[sessionIndex]?.changes !== 1) throw new AppError(401, '账户状态已变更，请重新登录', 'SESSION_REVOKED');
  setSessionCookie(c, token);
  return c.json({ code: 0, csrfToken: csrf, user: publicUser(user), totpEnabled: Boolean(user.totp_cipher) });
}

async function createChallenge(
  c: Context<AppEnv>, user: UserRow, purpose: string, secretCipher: string | null = null, clearLoginKey?: string,
): Promise<string> {
  const token = randomToken();
  const now = nowSeconds();
  const statements: SqlStatement[] = [{
    sql: `DELETE FROM security_challenges WHERE token_hash IN (
      SELECT token_hash FROM security_challenges WHERE expires_at <= ? ORDER BY expires_at LIMIT ?
    )`,
    args: [now, expiredChallengePruneLimit],
  }];
  const challengeIndex = statements.length;
  statements.push({
    sql: `INSERT INTO security_challenges (token_hash, purpose, user_id, secret_cipher, permission_version, expires_at, created_at)
     SELECT ?, ?, id, ?, permission_version, ?, ? FROM users
     WHERE id = ? AND status = 1 AND permission_version = ? AND (expires_at IS NULL OR expires_at > ?)`,
    args: [await sha256(token), purpose, secretCipher, now + 180, now, user.id, user.permission_version, now],
  });
  if (clearLoginKey) statements.push({
    sql: 'DELETE FROM rate_limits WHERE key=? AND changes()=1', args: [clearLoginKey],
  });
  const results = await c.get('db').batch(statements);
  if (results[challengeIndex]?.changes !== 1) throw new AppError(401, '账户状态已变更，请重新登录', 'SESSION_REVOKED');
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

async function consumeLoginTotpChallenge(c: Context<AppEnv>, token: string): Promise<ChallengeRow> {
  const clientIp = trustedClientIp(c);
  if (!clientIp) throw new AppError(503, '无法获取可信客户端 IP，动态口令验证已停止', 'CLIENT_IP_UNAVAILABLE');
  const now = nowSeconds();
  const ipKey = `totp:ip:${await sha256(clientIp)}`;
  const tokenHash = await sha256(token);
  const results = await c.get('db').batch([
    {
      sql: `DELETE FROM rate_limits WHERE key IN (
        SELECT key FROM rate_limits WHERE window_start <= ? ORDER BY window_start LIMIT 100
      )`,
      args: [now - 120],
    },
    {
      sql: `INSERT INTO rate_limits (key, window_start, count) VALUES ('totp:requests', ?, 1)
            ON CONFLICT(key) DO UPDATE SET
              count=CASE WHEN window_start<=? THEN 1 ELSE count+1 END,
              window_start=CASE WHEN window_start<=? THEN excluded.window_start ELSE window_start END
            RETURNING count`,
      args: [now, now - 60, now - 60],
    },
    {
      sql: `INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)
            ON CONFLICT(key) DO UPDATE SET
              count=CASE WHEN window_start<=? THEN 1 ELSE count+1 END,
              window_start=CASE WHEN window_start<=? THEN excluded.window_start ELSE window_start END
            RETURNING count`,
      args: [ipKey, now, now - 60, now - 60],
    },
    {
      sql: `DELETE FROM security_challenges WHERE token_hash=? AND purpose='totp-login' AND expires_at>?
            AND (SELECT count FROM rate_limits WHERE key='totp:requests')<=300
            AND (SELECT count FROM rate_limits WHERE key=?)<=30
            RETURNING user_id, secret_cipher, permission_version`,
      args: [tokenHash, now, ipKey],
    },
  ]);
  const globalCount = results[1]?.rows[0]?.count;
  const clientCount = results[2]?.rows[0]?.count;
  if (typeof globalCount !== 'number' || typeof clientCount !== 'number') throw new AppError(503, '动态口令限流状态不可用', 'RATE_LIMIT_UNAVAILABLE');
  if (globalCount > 300 || clientCount > 30) throw new AppError(429, '动态口令请求过于频繁，请稍后重试', 'RATE_LIMITED');
  const challenge = results[3]?.rows[0] as ChallengeRow | undefined;
  if (!challenge) throw new AppError(401, '验证请求已过期或已使用，请重新验证', 'CHALLENGE_EXPIRED');
  return challenge;
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

  routes.get('/verifycode', (c) => issueLoginCaptcha(c));

  routes.get('/api/v1/system/login-captcha', requireSession, async (c) => {
    requireAdmin(c);
    const rows = await c.get('db').query<{ value: string }>('SELECT value FROM app_settings WHERE key=?', ['vcode']);
    const vcode = rows[0]?.value === '2' ? '2' : '1';
    return c.json({ code: 0, vcode, enabled: vcode === '1' });
  });

  routes.put('/api/v1/system/login-captcha', requireSession, requireCsrf, async (c) => {
    requireAdmin(c);
    const body = await input(c);
    if (body.vcode !== '1' && body.vcode !== '2') throw new AppError(400, '验证码开关值无效', 'INVALID_CAPTCHA_SETTING');
    const now = nowSeconds();
    const statements: SqlStatement[] = [{
      sql: 'INSERT INTO app_settings (key, value, updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at',
      args: ['vcode', body.vcode, now],
    }];
    if (body.vcode === '2') statements.push({ sql: 'DELETE FROM login_captcha_challenges' });
    await c.get('db').batch(statements);
    await c.get('db').execute(
      'INSERT INTO audit_logs (user_id, action, target, detail, created_at) VALUES (?,?,?,?,?)',
      [c.get('principal').user.id, 'login.captcha.settings', 'system', `vcode=${body.vcode}`, now],
    );
    return c.json({ code: 0, vcode: body.vcode, enabled: body.vcode === '1' });
  });

  routes.post('/login', async (c) => {
    assertSameOrigin(c);
    await encryptionKey(c.env.APP_KEY, 'session');
    const body = await input(c);
    const username = text(body, 'username', 64).trim();
    const supplied = text(body, 'password', 72);
    if (!username || !supplied) throw new AppError(400, '用户名和密码不能为空', 'INVALID_CREDENTIALS');
    if (new TextEncoder().encode(supplied).length > 72) throw new AppError(400, '密码格式无效', 'INVALID_PASSWORD');
    await verifyCaptchaAndRequestLimit(c, typeof body.code === 'string' ? body.code : '');
    const loginKey = `login:${await sha256(username)}`;
    const now = nowSeconds();
    const auth = await c.get('db').batch([
      {
        sql: `INSERT INTO rate_limits (key, window_start, count)
              SELECT ?, ?, 1 WHERE EXISTS(
                SELECT 1 FROM users WHERE username=? AND status=1 AND (expires_at IS NULL OR expires_at>?)
              )
              ON CONFLICT(key) DO UPDATE SET
                count=CASE WHEN rate_limits.window_start<=? THEN 1 ELSE rate_limits.count+1 END,
                window_start=CASE WHEN rate_limits.window_start<=? THEN excluded.window_start ELSE rate_limits.window_start END
              WHERE rate_limits.count<5 OR rate_limits.window_start<=?
              RETURNING count`,
        args: [loginKey, now, username, now, now - 120, now - 120, now - 120],
      },
      { sql: 'SELECT * FROM users WHERE username=?', args: [username] },
    ]);
    const user = auth[1]?.rows[0] as UserRow | undefined;
    const attemptCount = auth[0]?.rows[0]?.count;
    if (user && user.status === 1 && (user.expires_at === null || user.expires_at > now) && typeof attemptCount !== 'number') {
      throw new AppError(429, '登录失败次数过多，请稍后重试', 'RATE_LIMITED');
    }
    const valid = user ? await compare(supplied, user.password_hash) : (await hash(supplied, 12), false);
    if (!user || !valid) throw new AppError(401, '用户名或密码错误', 'INVALID_CREDENTIALS');
    assertActive(user);
    if (user.totp_cipher) {
      const challenge = await createChallenge(c, user, 'totp-login', null, loginKey);
      return c.json({ code: -1, msg: '需要验证动态口令', vcode: 2, challenge });
    }
    return createSession(c, user, undefined, loginKey);
  });

  routes.post('/auth/totp', async (c) => {
    assertSameOrigin(c);
    const body = await input(c);
    const challenge = await consumeLoginTotpChallenge(c, text(body, 'challenge', 128));
    const totpKey = `totp:${challenge.user_id}`;
    const now = nowSeconds();
    const auth = await c.get('db').batch([
      {
        sql: `INSERT INTO rate_limits (key, window_start, count)
              SELECT ?, ?, 1 WHERE EXISTS(
                SELECT 1 FROM users WHERE id=? AND status=1 AND (expires_at IS NULL OR expires_at>?)
              )
              ON CONFLICT(key) DO UPDATE SET
                count=CASE WHEN rate_limits.window_start<=? THEN 1 ELSE rate_limits.count+1 END,
                window_start=CASE WHEN rate_limits.window_start<=? THEN excluded.window_start ELSE rate_limits.window_start END
              WHERE rate_limits.count<5 OR rate_limits.window_start<=?
              RETURNING count`,
        args: [totpKey, now, challenge.user_id, now, now - 120, now - 120, now - 120],
      },
      { sql: 'SELECT * FROM users WHERE id=?', args: [challenge.user_id] },
    ]);
    const user = auth[1]?.rows[0] as UserRow | undefined;
    if (!user || user.permission_version !== challenge.permission_version || !user.totp_cipher) throw new AppError(401, '账户状态已变更，请重新登录', 'CHALLENGE_EXPIRED');
    const active = user.status === 1 && (user.expires_at === null || user.expires_at > now);
    if (active && typeof auth[0]?.rows[0]?.count !== 'number') throw new AppError(429, '动态口令尝试过多，请稍后重新登录', 'RATE_LIMITED');
    assertActive(user);
    const counter = await verifiedTotp(user.id, await decrypt(user.totp_cipher, c.env.APP_KEY, 'totp'), text(body, 'code', 6));
    return createSession(c, user, counter, totpKey);
  });

  routes.get('/api/v1/session', requireSession, async (c) => {
    const user = c.get('principal').user;
    return c.json({
      code: 0,
      user: publicUser(user),
      totpEnabled: Boolean(user.totp_cipher),
      csrfToken: await csrfToken(getCookie(c, 'user_token')!),
    });
  });

  routes.get('/quicklogin', async (c) => {
    if (c.get('storage').config.format !== 'sql') {
      throw new AppError(501, '当前存储格式尚未支持快捷登录', 'STORAGE_FORMAT_UNSUPPORTED');
    }
    const domain = (c.req.query('domain') ?? '').trim();
    const timestamp = c.req.query('timestamp') ?? '';
    const token = c.req.query('token') ?? '';
    const sign = (c.req.query('sign') ?? '').toLowerCase();
    if (!quickLoginDomain.test(domain) || !/^\d{10}$/.test(timestamp)
      || !/^[A-Za-z0-9_-]{43}$/.test(token) || !/^[a-f0-9]{32}$/.test(sign)) {
      throw new AppError(400, '快捷登录参数无效', 'INVALID_QUICKLOGIN');
    }
    const now = nowSeconds();
    const stamp = Number(timestamp);
    if (!Number.isSafeInteger(stamp) || Math.abs(now - stamp) > quickLoginSeconds) {
      throw new AppError(400, '快捷登录链接已过期', 'QUICKLOGIN_EXPIRED');
    }
    const expected = md5(`${c.env.APP_KEY}${domain}${timestamp}${token}${c.env.APP_KEY}`);
    if (!constantTimeEqual(expected, sign)) throw new AppError(403, '快捷登录签名无效', 'INVALID_QUICKLOGIN_SIGNATURE');
    const ip = trustedClientIp(c);
    if (ip) await consumeRateLimit(c, `quicklogin:${ip}`, 60, 60);

    const tokenHash = await sha256(token);
    const rows = await c.get('db').query<UserRow & { quick_domain_id: string }>(
      `SELECT u.*, qt.domain_id AS quick_domain_id FROM quick_tokens qt JOIN users u ON u.id=qt.user_id
       WHERE qt.token_hash=? AND qt.expires_at>?`, [tokenHash, now],
    );
    const user = rows[0];
    if (!user) throw new AppError(401, '快捷登录令牌无效或已使用', 'INVALID_QUICKLOGIN_TOKEN');
    const targetId = /^\d{1,10}$/.test(user.quick_domain_id) ? Number(user.quick_domain_id) : 0;
    const domains = targetId > 0
      ? await c.get('db').query<{ id: number; name: string }>('SELECT id,name FROM dns_domains WHERE id=?', [targetId])
      : [];
    const target = domains[0];
    if (!target || target.name !== domain) throw new AppError(404, '域名不存在', 'DOMAIN_NOT_FOUND');
    if (user.level !== 2) {
      const permission = await c.get('db').query(
        'SELECT 1 FROM permissions WHERE user_id=? AND domain_id=?', [user.id, user.quick_domain_id],
      );
      if (!permission[0]) throw new AppError(403, '没有该域名的访问权限', 'PERMISSION_DENIED');
    }
    assertActive(user);
    const consumed = await c.get('db').execute(
      'DELETE FROM quick_tokens WHERE token_hash=? AND expires_at>?', [tokenHash, now],
    );
    if (consumed.changes !== 1) throw new AppError(401, '快捷登录令牌无效或已使用', 'INVALID_QUICKLOGIN_TOKEN');

    const sessionToken = randomToken();
    const csrf = await csrfToken(sessionToken);
    const created = await c.get('db').execute(
      `INSERT INTO sessions (token_hash, user_id, permission_version, csrf_hash, expires_at, created_at)
       SELECT ?, id, permission_version, ?, ?, ? FROM users
       WHERE id=? AND status=1 AND permission_version=? AND (expires_at IS NULL OR expires_at>?)`,
      [await sha256(sessionToken), await sha256(csrf), now + sessionSeconds, now, user.id, user.permission_version, now],
    );
    if (created.changes !== 1) throw new AppError(401, '账户状态已变更，请重新登录', 'SESSION_REVOKED');
    setSessionCookie(c, sessionToken);
    return c.redirect(`/record/${target.id}`);
  });

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

  routes.post('/auth/totp/reset', async (c) => {
    assertSameOrigin(c);
    if (!c.env.SETUP_TOKEN || c.env.SETUP_TOKEN.length < 32) {
      throw new AppError(503, '需要配置不少于 32 字符的 SETUP_TOKEN', 'SETUP_NOT_CONFIGURED');
    }
    if (!constantTimeEqual(c.req.header('X-Setup-Token') ?? '', c.env.SETUP_TOKEN)) {
      throw new AppError(403, '重置授权无效', 'INVALID_SETUP_TOKEN');
    }
    const ip = trustedClientIp(c);
    if (ip) await consumeRateLimit(c, `totp-reset:${ip}`, 10, 60);
    const body = await input(c);
    const username = text(body, 'username', 64).trim();
    if (!/^[\p{L}\p{N}_.@-]{3,64}$/u.test(username)) {
      throw new AppError(400, '用户名需为 3–64 位字母、数字或 _.@-', 'INVALID_USERNAME');
    }
    const now = nowSeconds();
    const results = await c.get('db').batch([
      {
        sql: `UPDATE users SET totp_cipher=NULL, permission_version=permission_version+1
              WHERE username=? AND totp_cipher IS NOT NULL RETURNING id`,
        args: [username],
      },
      { sql: 'DELETE FROM sessions WHERE user_id=(SELECT id FROM users WHERE username=?)', args: [username] },
      { sql: 'DELETE FROM totp_counters WHERE user_id=(SELECT id FROM users WHERE username=?)', args: [username] },
    ]);
    const row = results[0]?.rows[0] as { id?: number } | undefined;
    if (results[0]?.changes !== 1 || !row?.id) {
      throw new AppError(404, '用户不存在或未启用动态口令', 'TOTP_NOT_ENABLED');
    }
    await c.get('db').execute(
      'INSERT INTO audit_logs (user_id, action, target, detail, created_at) VALUES (?,?,?,?,?)',
      [row.id, 'auth.totp.reset', username, 'operator=setup-token', now],
    );
    return c.json({ code: 0, msg: '动态口令已重置，请使用密码重新登录并重新绑定' });
  });

  return routes;
}
