import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { md5 } from 'js-md5';
import { createApp } from '../src/app';
import type { Bindings, RequestBudget } from '../src/core/types';
import { environment } from '../src/platform/runtime';
import { encrypt } from '../src/security/crypto';
import { MIGRATIONS } from '../src/version';
import { createTestDatabase } from './helpers/sqlite';

const credentials = { username: 'admin', password: 'test-password-2026!' };
const appKey = btoa('12345678901234567890123456789012');

describe('users, proxy, update and legacy record APIs', () => {
  let testDb: ReturnType<typeof createTestDatabase>;
  let app: ReturnType<typeof createApp>;
  let bindings: Bindings;
  let fetchMock: ReturnType<typeof vi.fn>;
  let cookie = '';
  let csrf = '';

  beforeEach(async () => {
    testDb = createTestDatabase();
    app = createApp({ database: testDb.db });
    fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      const json = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
      if (url.pathname === '/client/v4/zones' && url.searchParams.get('name')) {
        return json({ success: true, result: [{ id: 'zone-1', name: 'example.com' }], result_info: { total_count: 1 } });
      }
      if (url.pathname.endsWith('/dns_records')) {
        return json({ success: true, result: { id: 'remote-1' } });
      }
      return json({ success: true, result: { id: 'remote-1' } });
    });
    const budget: RequestBudget = { consume: () => {}, remainingMs: () => 30_000, fetch: fetchMock as unknown as typeof fetch };
    bindings = {
      DB_DRIVER: 'turso', DB_FORMAT: 'sql', TURSO_DATABASE_URL: 'https://test.invalid', TURSO_AUTH_TOKEN: 'test-token',
      APP_KEY: appKey, SETUP_TOKEN: 'test-install-token-32-characters!!', BUDGET: budget,
    };
    await post('/install', credentials, { 'X-Setup-Token': bindings.SETUP_TOKEN! });
    const login = await post('/login', credentials);
    const body = await login.json() as { csrfToken: string };
    csrf = body.csrfToken;
    cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  });
  afterEach(() => { testDb.close(); });

  function request(path: string, init: RequestInit = {}) {
    return app.request(`https://panel.example${path}`, init, environment(bindings, 'local'));
  }
  function post(path: string, body: unknown, headers: Record<string, string> = {}) {
    return request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, 'X-CSRF-Token': csrf, ...headers },
      body: JSON.stringify(body),
    });
  }
  function send(path: string, method: string, body: unknown) {
    return request(path, {
      method,
      headers: { 'content-type': 'application/json', cookie, 'X-CSRF-Token': csrf },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  it('creates, lists, edits and deletes users while protecting the last admin', async () => {
    const created = await post('/api/v1/users', {
      username: 'editor', password: 'another-password-2026', level: 1, isApi: true, expiresAt: 1_900_000_000,
    });
    expect(created.status).toBe(200);
    const createdBody = await created.json() as { code: 0; user: { id: number }; apikey: string };
    expect(createdBody.apikey).toMatch(/^dnsmgr_/);

    const listed = await request('/api/v1/users', { headers: { cookie } });
    const list = await listed.json() as { items: { username: string; isApi: boolean; hasApiKey: boolean; expiresAt: number }[] };
    expect(list.items).toHaveLength(2);
    expect(list.items.find((item) => item.username === 'editor')).toMatchObject({
      isApi: true, hasApiKey: true, expiresAt: 1_900_000_000,
    });

    const patched = await send(`/api/v1/users/${createdBody.user.id}`, 'PATCH', {
      level: 2, status: 0, expiresAt: null, rotateApiKey: true,
    });
    expect(await patched.json()).toMatchObject({ code: 0 });

    const selfDemote = await send('/api/v1/users/1', 'PATCH', { level: 1 });
    expect(selfDemote.status).toBe(409);
    const selfDelete = await send('/api/v1/users/1', 'DELETE', undefined);
    expect(selfDelete.status).toBe(409);

    const removed = await send(`/api/v1/users/${createdBody.user.id}`, 'DELETE', undefined);
    expect(await removed.json()).toMatchObject({ code: 0 });
    const remaining = await request('/api/v1/users', { headers: { cookie } });
    expect((await remaining.json() as { items: unknown[] }).items).toHaveLength(1);
  });

  it('assigns domain permissions and revokes sessions', async () => {
    const account = await testDb.db.execute(
      'INSERT INTO dns_accounts (type,name,config_cipher,created_at,updated_at) VALUES (?,?,?,?,?)',
      ['cloudflare', 'main', await encrypt('{}', appKey, 'dns-account/1'), 1, 1],
    );
    expect(account.changes).toBe(1);
    const now = Math.floor(Date.now() / 1000);
    await testDb.db.execute(
      'INSERT INTO dns_domains (account_id,name,third_id,created_at,updated_at) VALUES (?,?,?,?,?)',
      [1, 'example.com', 'zone-1', now, now],
    );
    const created = await (await post('/api/v1/users', {
      username: 'scoped', password: 'another-password-2026', level: 1,
    })).json() as { user: { id: number } };

    const saved = await send(`/api/v1/users/${created.user.id}/permissions`, 'PUT', { domainIds: [1] });
    expect(await saved.json()).toMatchObject({ code: 0, domainIds: ['1'] });
    const permission = await testDb.db.query<{ domain_id: string }>('SELECT domain_id FROM permissions WHERE user_id=?', [created.user.id]);
    expect(permission[0]?.domain_id).toBe('1');
    const loaded = await request(`/api/v1/users/${created.user.id}/permissions`, { headers: { cookie } });
    expect(await loaded.json()).toMatchObject({ domainIds: ['1'] });

    const invalid = await send(`/api/v1/users/${created.user.id}/permissions`, 'PUT', { domainIds: [999] });
    expect(invalid.status).toBe(400);
  });

  it('stores proxy credentials encrypted and never echoes the password', async () => {
    const incomplete = await send('/api/v1/system/proxy', 'PUT', { enabled: true, url: '' });
    expect(incomplete.status).toBe(400);

    const saved = await send('/api/v1/system/proxy', 'PUT', {
      enabled: true, url: 'https://proxy.example:8443', username: 'proxy-user', password: 'proxy-secret-2026',
      noProxy: 'localhost, 127.0.0.1 localhost',
    });
    expect(await saved.json()).toMatchObject({
      code: 0, enabled: true, url: 'https://proxy.example:8443', username: 'proxy-user', hasPassword: true, noProxy: 'localhost,127.0.0.1',
    });
    const stored = await testDb.db.query<{ value: string }>('SELECT value FROM app_settings WHERE key=?', ['proxy_config_cipher']);
    expect(stored[0]?.value).not.toContain('proxy-secret-2026');

    const loaded = await request('/api/v1/system/proxy', { headers: { cookie } });
    const body = await loaded.json() as Record<string, unknown>;
    expect(body).toMatchObject({ enabled: true, hasPassword: true });
    expect(body.password).toBeUndefined();

    const mismatch = await send('/api/v1/system/proxy', 'PUT', { username: 'only-user', clearPassword: true });
    expect(mismatch.status).toBe(400);
    const cleared = await send('/api/v1/system/proxy', 'PUT', { enabled: false, clearPassword: true });
    expect(await cleared.json()).toMatchObject({ code: 0, enabled: false, hasPassword: false });
  });

  it('reports schema version and pending migrations without applying them', async () => {
    await testDb.db.execute(
      'CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, applied_at TIMESTAMP)',
    );
    for (const migration of MIGRATIONS) {
      await testDb.db.execute('INSERT INTO d1_migrations (name) VALUES (?)', [migration]);
    }
    const current = await request('/api/v1/system/update', { headers: { cookie } });
    expect(await current.json()).toMatchObject({
      code: 0, version: expect.any(String), schemaVersion: MIGRATIONS.length,
      latestSchemaVersion: MIGRATIONS.length, pendingCount: 0, upToDate: true, compatible: true, readOnly: true,
    });

    await testDb.db.execute('DELETE FROM d1_migrations WHERE name=?', [MIGRATIONS[MIGRATIONS.length - 1]!]);
    const pending = await post('/api/v1/system/update/check', {});
    expect(await pending.json()).toMatchObject({
      pendingCount: 1, upToDate: false, pendingMigrations: [MIGRATIONS[MIGRATIONS.length - 1]],
    });
    const logs = await testDb.db.query<{ action: string }>('SELECT action FROM audit_logs WHERE action=?', ['system.update.check']);
    expect(logs).toHaveLength(1);
  });

  it('supports legacy signed record creation and batch actions', async () => {
    const account = await (await post('/api/v1/dns/accounts', {
      type: 'cloudflare', name: 'legacy', config: { apikey: 'token' },
    })).json() as { id: number };
    expect((await post(`/api/v1/dns/accounts/${account.id}/sync`, {
      domains: [{ id: 'zone-1', name: 'example.com', recordCount: 0 }],
    })).status).toBe(200);
    const domain = await testDb.db.query<{ id: number }>('SELECT id FROM dns_domains WHERE name=?', ['example.com']);
    await testDb.db.execute('UPDATE users SET is_api=1, apikey_cipher=? WHERE id=1', [await encrypt('legacy-api-key', appKey, 'api-key')]);

    async function signed(path: string, fields: Record<string, string>) {
      const timestamp = String(Math.floor(Date.now() / 1000));
      const form = new URLSearchParams({
        uid: '1', timestamp, sign: md5(`1${timestamp}legacy-api-key`), ...fields,
      });
      return request(path, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form.toString(),
      });
    }

    const added = await signed(`/api/record/add/${domain[0]!.id}`, {
      name: 'www', type: 'A', value: '1.1.1.1', line: 'default', ttl: '600',
    });
    expect(await added.json()).toMatchObject({ code: 0, msg: '添加解析记录成功！', id: 'remote-1' });
    expect(fetchMock.mock.calls.some(([url, init]) => String(url).endsWith('/dns_records') && (init as RequestInit | undefined)?.method === 'POST')).toBe(true);

    const batch = await signed(`/api/record/batch/${domain[0]!.id}`, {
      action: 'pause', recordinfo: JSON.stringify([{ RecordId: 'r1' }, { RecordId: 'r2' }]),
    });
    expect(await batch.json()).toMatchObject({ code: 0, success: 2, failed: 0, msg: '成功暂停2条解析记录' });

    const grouped = await signed(`/api/record/batch/${domain[0]!.id}`, {
      action: 'group', recordinfo: JSON.stringify([{ RecordId: 'r1' }]),
    });
    expect(grouped.status).toBe(501);
  });
});
