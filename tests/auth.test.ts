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
    return { cookie: response.headers.get('set-cookie')!.split(';')[0]!, body: await response.json() as { csrfToken: string; user: { id: number } } };
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
  it('creates an HttpOnly Secure Strict cookie, stores only a hash and restores the same csrf', async () => {
    await install();
    const response = await post('/login', credentials);
    expect(response.headers.get('set-cookie')).toMatch(/HttpOnly/);
    expect(response.headers.get('set-cookie')).toMatch(/Secure/);
    expect(response.headers.get('set-cookie')).toMatch(/SameSite=Strict/);
    const data = await response.json() as { csrfToken: string; user: { id: number } };
    const cookie = response.headers.get('set-cookie')!.split(';')[0]!;
    const session = await request('/api/v1/session', { headers: { cookie } });
    expect(await session.json()).toMatchObject(data);
    const rows = await testDb.db.query<{ token_hash: string }>('SELECT token_hash FROM sessions');
    expect(rows[0]!.token_hash).toBe(await sha256(cookie.split('=')[1]!));
    expect(JSON.stringify(data)).not.toMatch(/password_hash|apikey_cipher|totp_cipher/);
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
    const prelogin = await post('/login', credentials);
    expect(operations).toBe(4);
    const challenge = (await prelogin.json() as { challenge: string }).challenge;
    operations = 0;
    const verified = await post('/auth/totp', { challenge, code: await totpCode(binding.secret, counter + 1) });
    expect(verified.status).toBe(200);
    expect(operations).toBe(4);
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
  it('requires both password and a one-use TOTP challenge and rejects replay', async () => {
    await install();
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    await testDb.db.execute('UPDATE users SET totp_cipher = ?', [await encrypt(secret, bindings.APP_KEY, 'totp')]);
    const response = await post('/login', credentials);
    const challenge = (await response.json() as { challenge: string; vcode: number }).challenge;
    expect(response.headers.get('set-cookie')).toBeNull();
    const code = await totpCode(secret, Math.floor(Date.now() / 30_000));
    const session = await post('/auth/totp', { challenge, code });
    expect(session.status).toBe(200);
    const sessionCookie = session.headers.get('set-cookie')!.split(';')[0]!;
    const sessionData = await session.json() as { csrfToken: string };
    const replay = await post('/totp/close', { password: credentials.password, code }, { cookie: sessionCookie, 'X-CSRF-Token': sessionData.csrfToken });
    expect(replay.status).toBe(401);
    expect((await request('/api/v1/session', { headers: { cookie: sessionCookie } })).status).toBe(200);
    expect((await post('/auth/totp', { challenge, code })).status).toBe(401);
    const second = await post('/login', credentials);
    const next = await second.json() as { challenge: string };
    expect((await post('/auth/totp', { challenge: next.challenge, code })).status).toBe(401);
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
