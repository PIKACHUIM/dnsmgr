import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app';
import type { Bindings, RequestBudget } from '../src/core/types';
import { environment } from '../src/platform/runtime';
import { createTestDatabase } from './helpers/sqlite';

const credentials = { username: 'admin', password: 'test-password-2026!' };
const appKey = btoa('12345678901234567890123456789012');

function cloudflareFetch() {
  let nextRecord = 1;
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    const json = (payload: unknown) => new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (url.pathname === '/client/v4/zones' && url.searchParams.get('name')) {
      return json({ success: true, result: [{ id: 'zone-1', name: 'example.com' }], result_info: { total_count: 1 } });
    }
    if (url.pathname === '/client/v4/zones/zone-1/dns_records' && url.search.endsWith('') === false) {
      return json({ success: true, result: [], result_info: { total_count: 0 } });
    }
    if (url.pathname.endsWith('/dns_records') && url.search === '') {
      return json({ success: true, result: { id: `remote-${nextRecord++}` } });
    }
    return json({ success: true, result: [] });
  }) as unknown as typeof fetch;
}

describe('DNS account, domain and record API', () => {
  let testDb: ReturnType<typeof createTestDatabase>;
  let app: ReturnType<typeof createApp>;
  let budget: RequestBudget;
  let bindings: Bindings;

  beforeEach(() => {
    testDb = createTestDatabase();
    app = createApp({ database: testDb.db });
    const transport = cloudflareFetch();
    budget = { consume: () => {}, remainingMs: () => 30_000, fetch: transport };
    bindings = {
      DB_DRIVER: 'turso', DB_FORMAT: 'sql', TURSO_DATABASE_URL: 'https://test.invalid', TURSO_AUTH_TOKEN: 'test-token',
      APP_KEY: appKey, SETUP_TOKEN: 'test-install-token-32-characters!!', BUDGET: budget,
    };
  });
  afterEach(() => { testDb.close(); });

  const request = (path: string, init: RequestInit = {}) =>
    app.request(`https://panel.example${path}`, init, environment(bindings, 'local'));
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    request(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

  async function session() {
    await post('/install', credentials, { 'X-Setup-Token': bindings.SETUP_TOKEN! });
    const response = await post('/login', credentials);
    const body = await response.json() as { csrfToken: string };
    return { cookie: response.headers.get('set-cookie')!.split(';')[0]!, csrf: body.csrfToken };
  }

  it('creates an account only after the provider accepts the credentials', async () => {
    const { cookie, csrf } = await session();
    const response = await post('/api/v1/dns/accounts', {
      type: 'cloudflare', name: '主账号', config: { apikey: 'token' }, remark: 'primary',
    }, { cookie, 'X-CSRF-Token': csrf });
    expect(response.status).toBe(200);
    const created = await response.json() as { id: number };
    expect(created.id).toBeGreaterThan(0);

    const rows = await testDb.db.query<{ config_cipher: string }>('SELECT config_cipher FROM dns_accounts');
    expect(rows[0]!.config_cipher).not.toContain('token');
    expect(rows[0]!.config_cipher.startsWith('v1.')).toBe(true);

    const list = await request('/api/v1/dns/accounts', { headers: { cookie } });
    const payload = await list.json() as { items: { name: string; domainCount: number }[] };
    expect(payload.items).toEqual([{ id: created.id, type: 'cloudflare', name: '主账号', remark: 'primary', domainCount: 0, createdAt: expect.any(Number), updatedAt: expect.any(Number) }]);
  });

  it('requires admin rights and CSRF for account mutations', async () => {
    const { cookie } = await session();
    expect((await post('/api/v1/dns/accounts', { type: 'cloudflare', name: 'x', config: { apikey: 't' } }, { cookie })).status).toBe(403);
    await testDb.db.execute('INSERT INTO users (username, password_hash, level, status, is_api, permission_version, created_at) VALUES (?,?,1,1,0,1,?)', ['user1', 'x', 1]);
    await testDb.db.execute('UPDATE users SET level = 1');
    expect((await request('/api/v1/dns/accounts', { headers: { cookie } })).status).not.toBe(200);
  });

  it('syncs remote domains, then lists them for the owner', async () => {
    const { cookie, csrf } = await session();
    const created = await (await post('/api/v1/dns/accounts', {
      type: 'cloudflare', name: '主账号', config: { apikey: 'token' },
    }, { cookie, 'X-CSRF-Token': csrf })).json() as { id: number };

    const remote = await request(`/api/v1/dns/accounts/${created.id}/remote-domains?page=1&pageSize=20&keyword=example.com`, { headers: { cookie } });
    expect(await remote.json()).toMatchObject({ code: 0, total: 1, items: [{ id: 'zone-1', name: 'example.com' }] });

    const synced = await post(`/api/v1/dns/accounts/${created.id}/sync`, {
      domains: [{ id: 'zone-1', name: 'example.com', recordCount: 3 }],
    }, { cookie, 'X-CSRF-Token': csrf });
    expect(await synced.json()).toMatchObject({ code: 0, imported: 1, skipped: 0 });

    const duplicates = await post(`/api/v1/dns/accounts/${created.id}/sync`, {
      domains: [{ id: 'zone-1', name: 'example.com' }],
    }, { cookie, 'X-CSRF-Token': csrf });
    expect(await duplicates.json()).toMatchObject({ imported: 0, skipped: 1 });

    const domains = await request('/api/v1/dns/domains?page=1&pageSize=20', { headers: { cookie } });
    const payload = await domains.json() as { total: number; items: { id: number; name: string; thirdId: string }[] };
    expect(payload.total).toBe(1);
    expect(payload.items[0]).toMatchObject({ name: 'example.com', thirdId: 'zone-1' });
  });

  it('rejects unknown providers before touching storage', async () => {
    const { cookie, csrf } = await session();
    expect((await post('/api/v1/dns/accounts', {
      type: 'nope', name: 'nope', config: { AccessKeyId: 'a', AccessKeySecret: 'b' },
    }, { cookie, 'X-CSRF-Token': csrf })).status).toBe(400);

    const audit = await testDb.db.query('SELECT * FROM audit_logs');
    expect(audit).toHaveLength(0);
  });
});
