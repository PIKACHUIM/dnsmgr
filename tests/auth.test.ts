import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { hash } from 'bcryptjs';
import { Hono } from 'hono';
import { md5 } from 'js-md5';
import { createApp } from '../src/app';
import { AppError } from '../src/core/errors';
import type { AppEnv, Bindings } from '../src/core/types';
import { environment } from '../src/platform/runtime';
import { encrypt, decrypt, sha256 } from '../src/security/crypto';
import { requireLegacyApi, requireDomain } from '../src/security/auth';
import { totpCode, verifyTotp } from '../src/security/totp';
import { createTestDatabase } from './helpers/sqlite';

const credentials = { username: 'admin', password: 'test-password-2026!' };
const bindings: Bindings = {
  DB_DRIVER: 'turso', DB_FORMAT: 'sql', TURSO_DATABASE_URL: 'https://test.invalid', TURSO_AUTH_TOKEN: 'test-token',
  APP_KEY: btoa('12345678901234567890123456789012'), SETUP_TOKEN: 'test-install-token-32-characters!!',
};

async function solveCaptcha(token: string, answerHash: string): Promise<string> {
  for (let value = 0; value < 10_000; value += 1) {
    const candidate = String(value).padStart(4, '0');
    if (await sha256(`${token}:${candidate}`) === answerHash) return candidate;
  }
  throw new Error('Unable to decode test CAPTCHA');
}

describe('authentication with a real transactional SQLite database', () => {
  let testDb: ReturnType<typeof createTestDatabase>;
  let app: ReturnType<typeof createApp>;
  beforeEach(() => { testDb = createTestDatabase(); app = createApp({ database: testDb.db }); });
  afterEach(() => { testDb.close(); });
  const request = (path: string, init: RequestInit = {}) => app.request(`https://panel.example${path}`, init, environment(bindings, 'local'));
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) => request(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const install = () => post('/install', credentials, { 'X-Setup-Token': bindings.SETUP_TOKEN! });
  async function login() {
    const response = await post('/login', credentials);
    expect(response.status).toBe(200);
    return { cookie: response.headers.get('set-cookie')!.split(';')[0]!, body: await response.json() as { csrfToken: string; totpEnabled: boolean; user: { id: number } } };
  }

  it('rejects missing install authorization and weak passwords without creating a user', async () => {
    expect((await post('/install', credentials)).status).toBe(403);
    expect((await post('/install', { ...credentials, password: 'weak' }, { 'X-Setup-Token': bindings.SETUP_TOKEN! })).status).toBe(400);
    expect(await testDb.db.query('SELECT id FROM users')).toEqual([]);
  });
  it('initializes exactly one administrator under concurrent install requests', async () => {
    const results = await Promise.all([install(), install()]);
    expect(results.map((response) => response.status).sort()).toEqual([200, 409]);
    const users = await testDb.db.query<{ password_hash: string; level: number }>('SELECT password_hash, level FROM users');
    expect(users).toHaveLength(1);
    expect(users[0]!.level).toBe(2);
    expect(users[0]!.password_hash).toMatch(/^\$2[aby]\$12\$/);
    expect(users[0]!.password_hash).not.toBe(credentials.password);
  });
  it('defaults login CAPTCHA to enabled without changing initialization state', async () => {
    const fresh = createTestDatabase({ captchaEnabled: true });
    try {
      expect(await fresh.db.query('SELECT value FROM app_settings WHERE key=?', ['vcode'])).toEqual([{ value: '1' }]);
      expect(await fresh.db.query('SELECT initialized FROM system_state WHERE id=1')).toEqual([{ initialized: 0 }]);
    } finally {
      fresh.close();
    }
  });
  it('uses trusted IP metadata from Cloudflare, EdgeOne and ESA without trusting X-Forwarded-For', async () => {
    await install();
    await testDb.db.execute("UPDATE app_settings SET value='1' WHERE key='vcode'");
    const cloudflareIp = '203.0.113.10';
    const cloudflareResponse = await app.request('https://panel.example/verifycode', {
      headers: { 'CF-Connecting-IP': cloudflareIp, 'X-Forwarded-For': '198.51.100.99' },
    }, environment(bindings, 'cloudflare'));
    expect(cloudflareResponse.status).toBe(200);
    for (let index = 1; index < 10; index += 1) {
      expect((await app.request('https://panel.example/verifycode', {
        headers: { 'CF-Connecting-IP': cloudflareIp, 'X-Forwarded-For': `198.51.100.${index}` },
      }, environment(bindings, 'cloudflare'))).status).toBe(200);
    }
    const ipLimited = await app.request('https://panel.example/verifycode', {
      headers: { 'CF-Connecting-IP': cloudflareIp, 'X-Forwarded-For': '203.0.113.200' },
    }, environment(bindings, 'cloudflare'));
    expect(ipLimited.status).toBe(429);

    const missingTrustedIp = await app.request('https://panel.example/verifycode', {
      headers: { 'X-Forwarded-For': '198.51.100.99' },
    }, environment(bindings, 'cloudflare'));
    expect(missingTrustedIp.status).toBe(503);
    expect(await missingTrustedIp.json()).toMatchObject({ reason: 'CLIENT_IP_UNAVAILABLE' });

    const edgeRequest = await app.request('https://panel.example/verifycode', {
      headers: { 'X-Forwarded-For': '198.51.100.99' },
    }, environment({ ...bindings, CLIENT_IP: '198.51.100.10' }, 'edgeone'));
    expect(edgeRequest.status).toBe(200);
    expect((await app.request('https://panel.example/verifycode', {}, environment({ ...bindings, CLIENT_IP: '192.0.2.10' }, 'esa'))).status).toBe(200);

    const keys = await testDb.db.query<{ key: string }>("SELECT key FROM rate_limits WHERE key LIKE 'captcha:issue-ip:%' ORDER BY key");
    expect(keys.map((row) => row.key)).toEqual([
      `captcha:issue-ip:${await sha256('192.0.2.10')}`,
      `captcha:issue-ip:${await sha256('198.51.100.10')}`,
      `captcha:issue-ip:${await sha256(cloudflareIp)}`,
    ].sort());
  });
  it('serves a no-store SVG login CAPTCHA with an HttpOnly one-use challenge cookie', async () => {
    await install();
    await testDb.db.execute("UPDATE app_settings SET value='1' WHERE key='vcode'");
    const response = await request('/verifycode');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('image/svg+xml');
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(response.headers.get('x-captcha-enabled')).toBe('1');
    expect(response.headers.get('set-cookie')).toMatch(/login_captcha=/);
    expect(response.headers.get('set-cookie')).toMatch(/HttpOnly/);
    expect(response.headers.get('set-cookie')).toMatch(/SameSite=Strict/);
    const svg = await response.text();
    expect(svg).toContain('<svg');
    expect(svg).not.toContain('<text');
    expect(await testDb.db.query('SELECT token_hash FROM login_captcha_challenges')).toHaveLength(1);
  });
  it('requires a valid CAPTCHA before counting or checking login credentials', async () => {
    await install();
    await testDb.db.execute("UPDATE app_settings SET value='1' WHERE key='vcode'");
    const response = await post('/login', credentials);
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ reason: 'INVALID_CAPTCHA' });
    expect(await testDb.db.query('SELECT * FROM users WHERE id=1 AND permission_version=1')).toHaveLength(1);
    expect(await testDb.db.query("SELECT key FROM rate_limits WHERE key LIKE 'login:%'")).toEqual([]);
    expect(await testDb.db.query('SELECT * FROM sessions')).toEqual([]);
  });
  it('limits unauthenticated CAPTCHA issuance and login requests globally', async () => {
    await install();
    await testDb.db.execute("UPDATE app_settings SET value='1' WHERE key='vcode'");
    const now = Math.floor(Date.now() / 1000);
    await testDb.db.execute('INSERT INTO rate_limits(key,window_start,count) VALUES(?,?,?)', ['login-captcha:issue', now, 120]);
    const issuance = await request('/verifycode');
    expect(issuance.status).toBe(429);
    expect(await issuance.json()).toMatchObject({ reason: 'RATE_LIMITED' });

    await testDb.db.execute('INSERT INTO rate_limits(key,window_start,count) VALUES(?,?,?)', ['captcha:login-requests', now, 300]);
    const loginAttempt = await post('/login', credentials);
    expect(loginAttempt.status).toBe(429);
    expect(await loginAttempt.json()).toMatchObject({ reason: 'RATE_LIMITED' });
    expect(await testDb.db.query("SELECT key FROM rate_limits WHERE key LIKE 'login:%'")).toEqual([]);
  });
  it('accepts one correct CAPTCHA after a rejected answer without charging the username login limit', async () => {
    await install();
    await testDb.db.execute("UPDATE app_settings SET value='1' WHERE key='vcode'");
    const captcha = await request('/verifycode');
    const cookie = captcha.headers.get('set-cookie')!.split(';')[0]!;
    const token = cookie.slice('login_captcha='.length);
    const row = await testDb.db.query<{ answer_hash: string }>(
      'SELECT answer_hash FROM login_captcha_challenges WHERE token_hash=?', [await sha256(token)],
    );
    const answer = await solveCaptcha(token, row[0]!.answer_hash);
    const wrong = String((Number(answer) + 1) % 10_000).padStart(4, '0');

    const rejected = await post('/login', { ...credentials, code: wrong }, { cookie });
    expect(rejected.status).toBe(401);
    expect(await rejected.json()).toMatchObject({ reason: 'INVALID_CAPTCHA' });
    expect(await testDb.db.query("SELECT key FROM rate_limits WHERE key LIKE 'login:%'")).toEqual([]);

    const accepted = await post('/login', { ...credentials, code: answer }, { cookie });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({ code: 0, user: { username: 'admin' } });

    const replay = await post('/login', { ...credentials, code: answer }, { cookie });
    expect(replay.status).toBe(401);
    expect(await replay.json()).toMatchObject({ reason: 'INVALID_CAPTCHA' });
    expect(await testDb.db.query("SELECT key FROM rate_limits WHERE key LIKE 'login:%'")).toEqual([]);
  });
  it('allows only one concurrent login for a single CAPTCHA challenge', async () => {
    await install();
    await testDb.db.execute("UPDATE app_settings SET value='1' WHERE key='vcode'");
    const captcha = await request('/verifycode');
    const cookie = captcha.headers.get('set-cookie')!.split(';')[0]!;
    const token = cookie.slice('login_captcha='.length);
    const row = await testDb.db.query<{ answer_hash: string }>(
      'SELECT answer_hash FROM login_captcha_challenges WHERE token_hash=?', [await sha256(token)],
    );
    const answer = await solveCaptcha(token, row[0]!.answer_hash);
    const attempts = await Promise.all([
      post('/login', { ...credentials, code: answer }, { cookie }),
      post('/login', { ...credentials, code: answer }, { cookie }),
    ]);
    expect(attempts.map((response) => response.status).sort()).toEqual([200, 401]);
    expect(await testDb.db.query('SELECT token_hash FROM sessions')).toHaveLength(1);
  });
  it('expires CAPTCHA tickets and discards them after four wrong answers', async () => {
    await install();
    await testDb.db.execute("UPDATE app_settings SET value='1' WHERE key='vcode'");
    const expired = await request('/verifycode');
    const firstCookie = expired.headers.get('set-cookie')!.split(';')[0]!;
    const firstToken = firstCookie.slice('login_captcha='.length);
    await testDb.db.execute('UPDATE login_captcha_challenges SET expires_at=? WHERE token_hash=?', [Math.floor(Date.now() / 1000) - 1, await sha256(firstToken)]);
    const expiredLogin = await post('/login', { ...credentials, code: '0000' }, { cookie: firstCookie });
    expect(expiredLogin.status).toBe(401);
    expect(await expiredLogin.json()).toMatchObject({ reason: 'INVALID_CAPTCHA' });

    const refreshed = await request('/verifycode', { headers: { cookie: firstCookie } });
    const cookie = refreshed.headers.get('set-cookie')!.split(';')[0]!;
    const token = cookie.slice('login_captcha='.length);
    const row = await testDb.db.query<{ answer_hash: string }>(
      'SELECT answer_hash FROM login_captcha_challenges WHERE token_hash=?', [await sha256(token)],
    );
    const answer = await solveCaptcha(token, row[0]!.answer_hash);
    const wrong = String((Number(answer) + 1) % 10_000).padStart(4, '0');
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const response = await post('/login', { ...credentials, code: wrong }, { cookie });
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ reason: 'INVALID_CAPTCHA' });
    }
    expect(await testDb.db.query('SELECT token_hash FROM login_captcha_challenges')).toEqual([]);
    expect(await testDb.db.query("SELECT key FROM rate_limits WHERE key LIKE 'login:%'")).toEqual([]);
  });
  it('protects login CAPTCHA settings with admin and CSRF checks and invalidates pending challenges on disable', async () => {
    await install();
    const { cookie, body } = await login();
    expect((await request('/api/v1/system/login-captcha')).status).toBe(401);
    const current = await request('/api/v1/system/login-captcha', { headers: { cookie } });
    expect(await current.json()).toMatchObject({ code: 0, vcode: '2', enabled: false });

    const missingCsrf = await request('/api/v1/system/login-captcha', {
      method: 'PUT', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ vcode: '1' }),
    });
    expect(missingCsrf.status).toBe(403);
    const invalid = await request('/api/v1/system/login-captcha', {
      method: 'PUT', headers: { 'content-type': 'application/json', cookie, 'X-CSRF-Token': body.csrfToken },
      body: JSON.stringify({ vcode: '0' }),
    });
    expect(invalid.status).toBe(400);

    const enabled = await request('/api/v1/system/login-captcha', {
      method: 'PUT', headers: { 'content-type': 'application/json', cookie, 'X-CSRF-Token': body.csrfToken },
      body: JSON.stringify({ vcode: '1' }),
    });
    expect(await enabled.json()).toMatchObject({ code: 0, vcode: '1', enabled: true });
    expect((await request('/verifycode')).status).toBe(200);
    expect(await testDb.db.query('SELECT token_hash FROM login_captcha_challenges')).toHaveLength(1);

    const disabled = await request('/api/v1/system/login-captcha', {
      method: 'PUT', headers: { 'content-type': 'application/json', cookie, 'X-CSRF-Token': body.csrfToken },
      body: JSON.stringify({ vcode: '2' }),
    });
    expect(await disabled.json()).toMatchObject({ code: 0, vcode: '2', enabled: false });
    expect(await testDb.db.query('SELECT token_hash FROM login_captcha_challenges')).toEqual([]);
    const noCaptcha = await request('/verifycode');
    expect(noCaptcha.status).toBe(204);
    expect(noCaptcha.headers.get('x-captcha-enabled')).toBe('0');
    expect((await post('/login', credentials)).status).toBe(200);

    await testDb.db.execute('UPDATE users SET level=1 WHERE id=1');
    expect((await request('/api/v1/system/login-captcha', { headers: { cookie } })).status).toBe(403);
  });
  it('creates an HttpOnly Secure Strict cookie, stores only a hash and restores the same csrf', async () => {
    await install();
    const response = await post('/login', credentials);
    expect(response.headers.get('set-cookie')).toMatch(/HttpOnly/);
    expect(response.headers.get('set-cookie')).toMatch(/Secure/);
    expect(response.headers.get('set-cookie')).toMatch(/SameSite=Strict/);
    const data = await response.json() as { csrfToken: string; totpEnabled: boolean; user: { id: number } };
    expect(data.totpEnabled).toBe(false);
    const cookie = response.headers.get('set-cookie')!.split(';')[0]!;
    const session = await request('/api/v1/session', { headers: { cookie } });
    expect(await session.json()).toMatchObject(data);
    const rows = await testDb.db.query<{ token_hash: string }>('SELECT token_hash FROM sessions');
    expect(rows[0]!.token_hash).toBe(await sha256(cookie.split('=')[1]!));
    expect(JSON.stringify(data)).not.toMatch(/password_hash|apikey_cipher|totp_cipher/);
  });
  async function seedQuickLoginDomain(): Promise<number> {
    const now = Math.floor(Date.now() / 1000);
    await testDb.db.execute(
      "INSERT INTO dns_accounts(type,name,config_cipher,created_at,updated_at) VALUES('cloudflare','quick-acc','{}',?,?)",
      [now, now],
    );
    await testDb.db.execute(
      "INSERT INTO dns_domains(account_id,name,record_count,created_at,updated_at) VALUES(1,'example.com',0,?,?)",
      [now, now],
    );
    const rows = await testDb.db.query<{ id: number }>("SELECT id FROM dns_domains WHERE name='example.com'");
    return rows[0]!.id;
  }
  function quickLoginUrl(
    token: string, options: { domain?: string; timestamp?: number; sign?: string } = {},
  ): string {
    const domain = options.domain ?? 'example.com';
    const timestamp = String(options.timestamp ?? Math.floor(Date.now() / 1000));
    const sign = options.sign ?? md5(`${bindings.APP_KEY}${domain}${timestamp}${token}${bindings.APP_KEY}`);
    return `/quicklogin?${new URLSearchParams({ domain, timestamp, token, sign })}`;
  }
  async function grantQuickToken(token: string, domainId: number, expiresIn = 300): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    await testDb.db.execute(
      'INSERT INTO quick_tokens(token_hash,user_id,domain_id,expires_at) VALUES(?,?,?,?)',
      [await sha256(token), 1, String(domainId), now + expiresIn],
    );
  }
  it('resets a lost authenticator with the setup token and revokes old sessions', async () => {
    await install();
    const { cookie } = await login();
    await testDb.db.execute('UPDATE users SET totp_cipher=? WHERE id=1', [
      await encrypt('JBSWY3DPEHPK3PXP', bindings.APP_KEY!, 'totp'),
    ]);
    expect((await post('/auth/totp/reset', { username: 'admin' })).status).toBe(403);
    expect((await post('/auth/totp/reset', { username: 'admin' }, { 'X-Setup-Token': 'x'.repeat(32) })).status).toBe(403);

    const reset = await post('/auth/totp/reset', { username: 'admin' }, { 'X-Setup-Token': bindings.SETUP_TOKEN! });
    expect(reset.status).toBe(200);
    expect(await reset.json()).toMatchObject({ code: 0 });
    expect(await testDb.db.query<{ totp_cipher: string | null; permission_version: number }>(
      'SELECT totp_cipher,permission_version FROM users WHERE id=1',
    )).toEqual([{ totp_cipher: null, permission_version: 2 }]);
    expect(await testDb.db.query('SELECT token_hash FROM sessions')).toEqual([]);
    expect(await testDb.db.query<{ user_id: number; action: string; detail: string }>(
      "SELECT user_id,action,detail FROM audit_logs WHERE action='auth.totp.reset'",
    )).toEqual([{ user_id: 1, action: 'auth.totp.reset', detail: 'operator=setup-token' }]);
    expect((await request('/api/v1/session', { headers: { cookie } })).status).toBe(401);

    const again = await post('/auth/totp/reset', { username: 'admin' }, { 'X-Setup-Token': bindings.SETUP_TOKEN! });
    expect(again.status).toBe(404);
    const relogin = await post('/login', credentials);
    expect(relogin.status).toBe(200);
    expect(await relogin.json()).toMatchObject({ totpEnabled: false });
  });
  it('rejects malformed, tampered and expired quick-login links without consuming the token', async () => {
    await install();
    const domainId = await seedQuickLoginDomain();
    const token = 'a'.repeat(43);
    await grantQuickToken(token, domainId);

    const malformed = await request('/quicklogin?domain=example.com');
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ reason: 'INVALID_QUICKLOGIN' });

    const expired = await request(quickLoginUrl(token, { timestamp: Math.floor(Date.now() / 1000) - 301 }));
    expect(expired.status).toBe(400);
    expect(await expired.json()).toMatchObject({ reason: 'QUICKLOGIN_EXPIRED' });

    const tampered = await request(quickLoginUrl(token, { sign: md5('tampered') }));
    expect(tampered.status).toBe(403);
    expect(await tampered.json()).toMatchObject({ reason: 'INVALID_QUICKLOGIN_SIGNATURE' });

    const wrongDomain = await request(quickLoginUrl(token, { domain: 'other.example.com' }));
    expect(wrongDomain.status).toBe(404);
    expect(await wrongDomain.json()).toMatchObject({ reason: 'DOMAIN_NOT_FOUND' });

    expect(await testDb.db.query('SELECT token_hash FROM quick_tokens')).toHaveLength(1);
  });
  it('consumes a signed one-time quick-login token and opens a session for the bound domain', async () => {
    await install();
    const domainId = await seedQuickLoginDomain();
    const token = 'b'.repeat(43);
    await grantQuickToken(token, domainId);
    const url = quickLoginUrl(token);

    const response = await request(url);
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(`/record/${domainId}`);
    expect(response.headers.get('set-cookie')).toMatch(/HttpOnly/);
    expect(await testDb.db.query('SELECT token_hash FROM quick_tokens')).toEqual([]);
    const sessionCookie = response.headers.get('set-cookie')!.split(';')[0]!;
    const session = await request('/api/v1/session', { headers: { cookie: sessionCookie } });
    expect(session.status).toBe(200);
    expect(await session.json()).toMatchObject({ user: { id: 1, username: 'admin' } });

    const replay = await request(url);
    expect(replay.status).toBe(401);
    expect(await replay.json()).toMatchObject({ reason: 'INVALID_QUICKLOGIN_TOKEN' });
  });
  it('requires the bound domain permission for a non-admin quick-login token', async () => {
    await install();
    const domainId = await seedQuickLoginDomain();
    const token = 'c'.repeat(43);
    await grantQuickToken(token, domainId);
    await testDb.db.execute('UPDATE users SET level=1 WHERE id=1');
    const url = quickLoginUrl(token);

    const denied = await request(url);
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ reason: 'PERMISSION_DENIED' });
    expect(await testDb.db.query('SELECT token_hash FROM quick_tokens')).toHaveLength(1);

    await testDb.db.execute('INSERT INTO permissions(user_id,domain_id) VALUES(1,?)', [String(domainId)]);
    const allowed = await request(url);
    expect(allowed.status).toBe(302);
    expect(allowed.headers.get('location')).toBe(`/record/${domainId}`);
    expect(await testDb.db.query('SELECT token_hash FROM quick_tokens')).toEqual([]);
  });
  it('rejects a cross-origin login and csrf-less logout, then revokes the authenticated session', async () => {
    await install();
    expect((await post('/login', credentials, { Origin: 'https://evil.example' })).status).toBe(403);
    const { cookie, body } = await login();
    expect((await post('/logout', {}, { cookie })).status).toBe(403);
    expect((await post('/logout', {}, { cookie, 'X-CSRF-Token': body.csrfToken })).status).toBe(200);
    expect((await request('/api/v1/session', { headers: { cookie } })).status).toBe(401);
  });
  it.each(['status', 'permission_version', 'expires_at'] as const)('immediately rejects an old session after %s changes', async (field) => {
    await install();
    const { cookie } = await login();
    await testDb.db.execute(`UPDATE users SET ${field} = ?`, [field === 'status' ? 0 : field === 'permission_version' ? 2 : 1]);
    expect([401, 403]).toContain((await request('/api/v1/session', { headers: { cookie } })).status);
  });
  it('changes a password and revokes all old sessions', async () => {
    await install();
    const { cookie, body } = await login();
    const response = await post('/setpwd', { currentPassword: credentials.password, password: 'new-password-2026!' }, { cookie, 'X-CSRF-Token': body.csrfToken });
    expect(response.status).toBe(200);
    expect(await testDb.db.query('SELECT * FROM sessions')).toEqual([]);
    expect((await post('/login', credentials)).status).toBe(401);
    expect((await post('/login', { ...credentials, password: 'new-password-2026!' })).status).toBe(200);
  });
  it('keeps the current session and password when password change is rejected', async () => {
    await install();
    const { cookie, body } = await login();
    const csrfMissing = await post('/setpwd', { currentPassword: credentials.password, password: 'new-password-2026!' }, { cookie });
    expect(csrfMissing.status).toBe(403);
    const wrongCurrentPassword = await post('/setpwd', { currentPassword: 'wrong-password-2026!', password: 'new-password-2026!' }, { cookie, 'X-CSRF-Token': body.csrfToken });
    expect(wrongCurrentPassword.status).toBe(401);
    expect(await wrongCurrentPassword.json()).toMatchObject({ reason: 'INVALID_CREDENTIALS' });
    expect((await request('/api/v1/session', { headers: { cookie } })).status).toBe(200);
    expect(await testDb.db.query('SELECT token_hash FROM sessions')).toEqual([{ token_hash: await sha256(cookie.split('=')[1]!) }]);
    expect((await post('/login', credentials)).status).toBe(200);
  });
  it('keeps newer sessions when an older password change loses its SQL CAS', async () => {
    await install();
    const { cookie, body } = await login();
    const batch = testDb.db.batch.bind(testDb.db);
    testDb.db.batch = async (statements) => {
      if (statements[0]?.sql.includes('SET password_hash')) {
        await testDb.db.execute('UPDATE users SET permission_version = 2 WHERE id = 1');
        await testDb.db.execute('INSERT INTO sessions(token_hash,user_id,permission_version,csrf_hash,expires_at,created_at) VALUES(?,1,2,?,9999999999,0)', ['newer-session-hash', 'newer-csrf-hash']);
      }
      return batch(statements);
    };
    const result = await post('/setpwd', { currentPassword: credentials.password, password: 'competing-password-2026' }, { cookie, 'X-CSRF-Token': body.csrfToken });
    expect(result.status).toBe(409);
    expect(await testDb.db.query('SELECT token_hash FROM sessions WHERE permission_version=2')).toEqual([{ token_hash: 'newer-session-hash' }]);
  });
  it('keeps each authentication step within four SQL network operations', async () => {
    await install();
    const original = testDb.db;
    let operations = 0;
    const check = () => { operations++; if (operations > 4) throw new Error('Four-operation budget exceeded'); };
    app = createApp({ database: {
      async query(sql, args) { check(); return original.query(sql, args); },
      async execute(sql, args) { check(); return original.execute(sql, args); },
      async batch(statements) { check(); return original.batch(statements); },
    } });
    operations = 0;
    const { cookie, body } = await login();
    expect(operations).toBe(4);
    operations = 0;
    const generated = await post('/totp/generate', { password: credentials.password }, { cookie, 'X-CSRF-Token': body.csrfToken });
    expect(generated.status).toBe(200);
    const binding = await generated.json() as { secret: string; challenge: string };
    const counter = Math.floor(Date.now() / 30_000);
    operations = 0;
    const bound = await post('/totp/bind', { challenge: binding.challenge, code: await totpCode(binding.secret, counter) }, { cookie, 'X-CSRF-Token': body.csrfToken });
    expect(bound.status).toBe(200);
    expect(operations).toBe(4);
    operations = 0;
    expect((await request('/api/v1/session', { headers: { cookie } })).status).toBe(401);
    await original.execute("UPDATE app_settings SET value='1' WHERE key='vcode'");
    operations = 0;
    const captcha = await request('/verifycode');
    expect(operations).toBe(4);
    const captchaCookie = captcha.headers.get('set-cookie')!.split(';')[0]!;
    const captchaToken = captchaCookie.slice('login_captcha='.length);
    const captchaRows = await original.query<{ answer_hash: string }>(
      'SELECT answer_hash FROM login_captcha_challenges WHERE token_hash=?', [await sha256(captchaToken)],
    );
    const captchaCode = await solveCaptcha(captchaToken, captchaRows[0]!.answer_hash);
    operations = 0;
    const prelogin = await post('/login', { ...credentials, code: captchaCode }, { cookie: captchaCookie });
    expect(prelogin.status).toBe(200);
    expect(operations).toBe(4);
    const challenge = (await prelogin.json() as { challenge: string }).challenge;
    operations = 0;
    const verified = await post('/auth/totp', { challenge, code: await totpCode(binding.secret, counter + 1) });
    expect(verified.status).toBe(200);
    expect(operations).toBe(4);
  });
  it('prunes expired one-use TOTP challenges when creating a new challenge', async () => {
    await install();
    const { cookie, body } = await login();
    const now = Math.floor(Date.now() / 1000);
    await testDb.db.execute(
      'INSERT INTO security_challenges(token_hash,purpose,user_id,secret_cipher,permission_version,expires_at,created_at) VALUES(?,?,?,?,?,?,?)',
      ['expired-enrollment', 'totp-bind', 1, 'expired-ciphertext', 1, now - 1, now - 181],
    );
    await testDb.db.execute(
      'INSERT INTO security_challenges(token_hash,purpose,user_id,secret_cipher,permission_version,expires_at,created_at) VALUES(?,?,?,?,?,?,?)',
      ['active-login', 'totp-login', 1, null, 1, now + 180, now],
    );
    const generated = await post('/totp/generate', { password: credentials.password }, { cookie, 'X-CSRF-Token': body.csrfToken });
    expect(generated.status).toBe(200);
    const challenge = (await generated.json() as { challenge: string }).challenge;
    const rows = await testDb.db.query<{ token_hash: string }>('SELECT token_hash FROM security_challenges ORDER BY token_hash');
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.token_hash)).toContain('active-login');
    expect(rows.map((row) => row.token_hash)).toContain(await sha256(challenge));
    expect(rows.map((row) => row.token_hash)).not.toContain('expired-enrollment');
  });
  it('counts failed passwords only and clears the per-user lock after successful authentication', async () => {
    await install();
    expect((await post('/login', { ...credentials, password: 'wrong-password!' })).status).toBe(401);
    expect(await testDb.db.query<{ count: number }>("SELECT count FROM rate_limits WHERE key LIKE 'login:%'")).toEqual([{ count: 1 }]);
    expect((await post('/login', credentials)).status).toBe(200);
    expect(await testDb.db.query("SELECT key FROM rate_limits WHERE key LIKE 'login:%'")).toEqual([]);
  });
  it('prunes expired rate-limit keys in bounded batches', async () => {
    await install();
    const now = Math.floor(Date.now() / 1000);
    await testDb.db.batch(Array.from({ length: 205 }, (_, index) => ({
      sql: 'INSERT INTO rate_limits(key,window_start,count) VALUES(?,?,1)',
      args: [`stale:${index}`, now - 121],
    })));
    expect((await post('/login', { ...credentials, password: 'wrong-password!' })).status).toBe(401);
    expect((await post('/login', { ...credentials, password: 'wrong-password!' })).status).toBe(401);
    const remaining = await testDb.db.query<{ count: number }>("SELECT COUNT(*) AS count FROM rate_limits WHERE key LIKE 'stale:%'");
    expect(remaining[0]!.count).toBe(5);
  });
  it('does not let case-variant usernames lock a distinct case-sensitive account', async () => {
    await install();
    await testDb.db.execute('UPDATE users SET username=? WHERE id=1', ['Alice']);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await post('/login', { username: 'alice', password: 'wrong-password!' })).status).toBe(401);
    }
    expect(await testDb.db.query("SELECT key FROM rate_limits WHERE key LIKE 'login:%'")).toEqual([]);
    const correct = await post('/login', { username: 'Alice', password: credentials.password });
    expect(correct.status).toBe(200);
    expect(await testDb.db.query<{ count: number }>('SELECT count FROM rate_limits WHERE key=?', [`login:${await sha256('Alice')}`])).toEqual([]);
  });
  it('atomically reserves password attempt slots under concurrent logins', async () => {
    await install();
    const attempts = await Promise.all(Array.from({ length: 10 }, () =>
      post('/login', { ...credentials, password: 'wrong-password!' }),
    ));
    expect(attempts.filter((response) => response.status === 401)).toHaveLength(5);
    expect(attempts.filter((response) => response.status === 429)).toHaveLength(5);
    expect(await testDb.db.query<{ count: number }>('SELECT count FROM rate_limits WHERE key=?', [`login:${await sha256(credentials.username)}`])).toEqual([{ count: 5 }]);
  });
  it('enforces a persistent login rate limit', async () => {
    await install();
    for (let attempt = 0; attempt < 5; attempt++) expect((await post('/login', { ...credentials, password: 'wrong-password!' })).status).toBe(401);
    expect((await post('/login', credentials)).status).toBe(429);
  });
  it('rejects a changed storage format rather than silently reusing a different backend', async () => {
    await install();
    const response = await app.request('https://panel.example/api/v1/install/status', {}, environment({ ...bindings, DB_FORMAT: 'map' }, 'local'));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ reason: 'STORAGE_IDENTITY_MISMATCH' });
  });
  it('limits repeated invalid TOTP challenges by client IP before unbounded challenge lookups', async () => {
    await install();
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const response = await post('/auth/totp', { challenge: 'not-a-real-challenge', code: '000000' });
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ reason: 'CHALLENGE_EXPIRED' });
    }
    const limited = await post('/auth/totp', { challenge: 'not-a-real-challenge', code: '000000' });
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ reason: 'RATE_LIMITED' });
    expect(await testDb.db.query<{ count: number }>('SELECT count FROM rate_limits WHERE key=?', [`totp:ip:${await sha256('127.0.0.1')}`])).toEqual([{ count: 31 }]);
  });
  it('enforces the global TOTP request limit before consuming a challenge', async () => {
    await install();
    const now = Math.floor(Date.now() / 1000);
    await testDb.db.execute('INSERT INTO rate_limits(key,window_start,count) VALUES(?,?,?)', ['totp:requests', now, 300]);
    const limited = await post('/auth/totp', { challenge: 'not-a-real-challenge', code: '000000' });
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ reason: 'RATE_LIMITED' });
    expect(await testDb.db.query<{ count: number }>('SELECT count FROM rate_limits WHERE key=?', ['totp:requests'])).toEqual([{ count: 301 }]);
  });
  it('atomically reserves TOTP failure attempts under parallel verification', async () => {
    await install();
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    await testDb.db.execute('UPDATE users SET totp_cipher=?', [await encrypt(secret, bindings.APP_KEY, 'totp')]);
    const currentCounter = Math.floor(Date.now() / 30_000);
    const validCodes = new Set(await Promise.all([-1, 0, 1].map((offset) => totpCode(secret, currentCounter + offset))));
    let wrongCode = '000000';
    while (validCodes.has(wrongCode)) wrongCode = String((Number(wrongCode) + 1) % 1_000_000).padStart(6, '0');
    const challenges: string[] = [];
    for (let index = 0; index < 10; index += 1) {
      const response = await post('/login', credentials);
      expect(response.status).toBe(200);
      challenges.push((await response.json() as { challenge: string }).challenge);
    }
    const attempts = await Promise.all(challenges.map((challenge) => post('/auth/totp', { challenge, code: wrongCode })));
    expect(attempts.filter((response) => response.status === 401)).toHaveLength(5);
    expect(attempts.filter((response) => response.status === 429)).toHaveLength(5);
    expect(await testDb.db.query<{ count: number }>('SELECT count FROM rate_limits WHERE key=?', ['totp:1'])).toEqual([{ count: 5 }]);
  });
  it('limits failed TOTP guesses and clears the account lock after a successful code', async () => {
    await install();
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    await testDb.db.execute('UPDATE users SET totp_cipher=?', [await encrypt(secret, bindings.APP_KEY, 'totp')]);
    const currentCounter = Math.floor(Date.now() / 30_000);
    const validCodes = new Set(await Promise.all([-1, 0, 1].map((offset) => totpCode(secret, currentCounter + offset))));
    let wrongCode = '000000';
    while (validCodes.has(wrongCode)) wrongCode = String((Number(wrongCode) + 1) % 1_000_000).padStart(6, '0');

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const loginResponse = await post('/login', credentials);
      const challenge = (await loginResponse.json() as { challenge: string }).challenge;
      const rejected = await post('/auth/totp', { challenge, code: wrongCode });
      expect(rejected.status).toBe(401);
      expect(await rejected.json()).toMatchObject({ reason: 'INVALID_TOTP' });
    }
    expect(await testDb.db.query<{ count: number }>('SELECT count FROM rate_limits WHERE key=?', ['totp:1'])).toEqual([{ count: 5 }]);

    const blockedLogin = await post('/login', credentials);
    const blockedChallenge = (await blockedLogin.json() as { challenge: string }).challenge;
    const blocked = await post('/auth/totp', { challenge: blockedChallenge, code: await totpCode(secret, currentCounter) });
    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toMatchObject({ reason: 'RATE_LIMITED' });

    await testDb.db.execute('UPDATE rate_limits SET window_start=? WHERE key=?', [Math.floor(Date.now() / 1000) - 121, 'totp:1']);
    const retryLogin = await post('/login', credentials);
    const retryChallenge = (await retryLogin.json() as { challenge: string }).challenge;
    const retry = await post('/auth/totp', { challenge: retryChallenge, code: await totpCode(secret, Math.floor(Date.now() / 30_000)) });
    expect(retry.status).toBe(200);
    expect(await testDb.db.query('SELECT key FROM rate_limits WHERE key=?', ['totp:1'])).toEqual([]);
  });
  it('requires both password and a one-use TOTP challenge, exposes only the enabled flag, and closes with a fresh code', async () => {
    await install();
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    await testDb.db.execute('UPDATE users SET totp_cipher = ?', [await encrypt(secret, bindings.APP_KEY, 'totp')]);
    const response = await post('/login', credentials);
    const challenge = (await response.json() as { challenge: string; vcode: number }).challenge;
    expect(response.headers.get('set-cookie')).toBeNull();
    const loginCounter = Math.floor(Date.now() / 30_000);
    const code = await totpCode(secret, loginCounter);
    const session = await post('/auth/totp', { challenge, code });
    expect(session.status).toBe(200);
    const sessionCookie = session.headers.get('set-cookie')!.split(';')[0]!;
    const sessionData = await session.json() as { csrfToken: string; totpEnabled: boolean };
    expect(sessionData.totpEnabled).toBe(true);
    expect(JSON.stringify(sessionData)).not.toContain(secret);
    const replay = await post('/totp/close', { password: credentials.password, code }, { cookie: sessionCookie, 'X-CSRF-Token': sessionData.csrfToken });
    expect(replay.status).toBe(401);
    const activeSession = await request('/api/v1/session', { headers: { cookie: sessionCookie } });
    expect(activeSession.status).toBe(200);
    expect(await activeSession.json()).toMatchObject({ totpEnabled: true });
    expect((await post('/auth/totp', { challenge, code })).status).toBe(401);
    const second = await post('/login', credentials);
    const next = await second.json() as { challenge: string };
    expect((await post('/auth/totp', { challenge: next.challenge, code })).status).toBe(401);
    const closeCounter = Math.max(Math.floor(Date.now() / 30_000), loginCounter + 1);
    const closed = await post('/totp/close', { password: credentials.password, code: await totpCode(secret, closeCounter) }, { cookie: sessionCookie, 'X-CSRF-Token': sessionData.csrfToken });
    expect(closed.status).toBe(200);
    expect(await closed.json()).toMatchObject({ code: 0, msg: '动态口令已关闭，请重新登录' });
    expect((await request('/api/v1/session', { headers: { cookie: sessionCookie } })).status).toBe(401);
    const loggedIn = await post('/login', credentials);
    expect(loggedIn.status).toBe(200);
    expect(await loggedIn.json()).toMatchObject({ totpEnabled: false });
  });
  it('preserves password whitespace instead of trimming it', async () => {
    const password = '  space-password-2026  ';
    expect((await post('/install', { ...credentials, password }, { 'X-Setup-Token': bindings.SETUP_TOKEN! })).status).toBe(200);
    expect((await post('/login', { ...credentials, password })).status).toBe(200);
    expect((await post('/login', { ...credentials, password: password.trim() })).status).toBe(401);
  });
});

describe('legacy API signatures and domain permissions', () => {
  it('accepts POST form MD5 uid+timestamp+apikey, permits id 0 record values, and checks live domain permissions', async () => {
    const testDb = createTestDatabase();
    try {
      const apiKey = 'test-api-key';
      await testDb.db.execute('INSERT INTO users(id,username,password_hash,level,status,is_api,apikey_cipher,permission_version,created_at) VALUES(1,?,?,1,1,1,?,1,0)', ['api-user', await hash('unused-test-password', 4), await encrypt(apiKey, bindings.APP_KEY, 'api-key')]);
      await testDb.db.execute('INSERT INTO permissions(user_id,domain_id) VALUES(1,?)', ['10']);
      const app = new Hono<AppEnv>();
      app.onError((error, c) => c.json({ code: -1, reason: error instanceof AppError ? error.reason : 'INTERNAL_ERROR' }, error instanceof AppError ? error.status : 500));
      app.use('*', async (c, next) => { c.set('db', testDb.db); await next(); });
      app.post('/api/record/data/:id', requireLegacyApi, async (c) => { await requireDomain(c, Number(c.req.param('id'))); return c.json({ total: 1, rows: [{ id: 0 }] }); });
      const timestamp = String(Math.floor(Date.now() / 1000));
      const form = new URLSearchParams({ uid: '1', timestamp, sign: md5('1' + timestamp + apiKey) });
      const response = await app.request('https://panel.example/api/record/data/10', { method: 'POST', body: form }, environment(bindings, 'local'));
      expect(await response.json()).toEqual({ total: 1, rows: [{ id: 0 }] });
      await testDb.db.execute('DELETE FROM permissions WHERE user_id=1');
      const denied = await app.request('https://panel.example/api/record/data/10', { method: 'POST', body: form }, environment(bindings, 'local'));
      expect(denied.status).toBe(403);
    } finally { testDb.close(); }
  });
});

describe('cryptographic primitives', () => {
  it('validates RFC 6238 SHA1 vectors and checks the bounded time window', async () => {
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    expect(await totpCode(secret, 1)).toBe('287082');
    expect(await verifyTotp(secret, '287082', 59)).toBe(1);
    expect(await verifyTotp(secret, '287082', 180)).toBeNull();
  });
  it('uses authenticated purpose-separated encryption and rejects tampering', async () => {
    const value = await encrypt('not-a-real-secret', bindings.APP_KEY, 'api-key');
    expect(await decrypt(value, bindings.APP_KEY, 'api-key')).toBe('not-a-real-secret');
    await expect(decrypt(value, bindings.APP_KEY, 'totp')).rejects.toThrow();
    const tail = value.slice(-3) === 'AAA' ? 'BBB' : 'AAA';
    await expect(decrypt(value.slice(0, -3) + tail, bindings.APP_KEY, 'api-key')).rejects.toThrow();
  });
});
