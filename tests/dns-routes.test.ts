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
    if (/\/dns_records\/r\d+$/.test(url.pathname)) {
      return json({ success: true, result: { id: 'r1', name: 'www.example.com', type: 'A', content: '1.1.1.1', ttl: 600 } });
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

  async function seedDomain(cookie: string, csrf: string, names: string[] = ['example.com']) {
    const created = await (await post('/api/v1/dns/accounts', {
      type: 'cloudflare', name: `acc-${names[0]}`, config: { apikey: 'token' },
    }, { cookie, 'X-CSRF-Token': csrf })).json() as { id: number };
    await post(`/api/v1/dns/accounts/${created.id}/sync`, {
      domains: names.map((name, index) => ({ id: `zone-${index + 1}`, name, recordCount: 0 })),
    }, { cookie, 'X-CSRF-Token': csrf });
    const list = await (await request(`/api/v1/dns/domains?accountId=${created.id}&page=1&pageSize=20`, { headers: { cookie } })).json() as { items: { id: number; name: string }[] };
    return list.items;
  }

  it('manages domain categories and filters domains by them', async () => {
    const { cookie, csrf } = await session();
    const [domain] = await seedDomain(cookie, csrf);
    const headers = { cookie, 'X-CSRF-Token': csrf };

    const created = await post('/api/v1/dns/categories', { name: '生产', sort: 2 }, headers);
    expect(created.status).toBe(200);
    const category = await created.json() as { id: number };
    expect((await post('/api/v1/dns/categories', { name: '生产' }, headers)).status).toBe(409);

    expect((await request(`/api/v1/dns/domains/${domain!.id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ categoryId: category.id }),
    })).status).toBe(200);

    const filtered = await (await request(`/api/v1/dns/domains?categoryId=${category.id}`, { headers: { cookie } })).json() as { total: number; items: { categoryName: string }[] };
    expect(filtered.total).toBe(1);
    expect(filtered.items[0]!.categoryName).toBe('生产');

    expect((await request(`/api/v1/dns/categories/${category.id}`, {
      method: 'DELETE', headers,
    })).status).toBe(409);

    await request(`/api/v1/dns/domains/${domain!.id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ categoryId: 0 }),
    });
    expect((await request(`/api/v1/dns/categories/${category.id}`, { method: 'DELETE', headers })).status).toBe(200);
  });

  it('applies domain batch actions and deletes local rows only', async () => {
    const { cookie, csrf } = await session();
    const domains = await seedDomain(cookie, csrf, ['a.example.com', 'b.example.com']);
    const ids = domains.map((domain) => domain.id);
    const headers = { cookie, 'X-CSRF-Token': csrf };

    const remarked = await post('/api/v1/dns/domains/batch', { ids, action: 'remark', remark: '批量' }, headers);
    expect(await remarked.json()).toMatchObject({ code: 0, affected: 2, requested: 2 });
    const hidden = await post('/api/v1/dns/domains/batch', { ids, action: 'hidden', value: true }, headers);
    expect(await hidden.json()).toMatchObject({ affected: 2 });

    const visible = await (await request('/api/v1/dns/domains?hidden=0', { headers: { cookie } })).json() as { total: number };
    expect(visible.total).toBe(0);
    const hiddenList = await (await request('/api/v1/dns/domains?hidden=1', { headers: { cookie } })).json() as { total: number };
    expect(hiddenList.total).toBe(2);

    expect((await post('/api/v1/dns/domains/batch', { ids: [999], action: 'delete' }, headers)).status).toBe(200);
    const removed = await post('/api/v1/dns/domains/batch', { ids, action: 'delete' }, headers);
    expect(await removed.json()).toMatchObject({ affected: 2 });
    expect(await (await request('/api/v1/dns/domains', { headers: { cookie } })).json()).toMatchObject({ total: 0 });
  });

  it('batch edits, adds and logs records through the provider', async () => {
    const { cookie, csrf } = await session();
    const [domain] = await seedDomain(cookie, csrf);
    const headers = { cookie, 'X-CSRF-Token': csrf };

    const status = await post(`/api/v1/dns/domains/${domain!.id}/records/batch`, {
      action: 'enable', recordIds: ['r1', 'r2'],
    }, headers);
    expect(await status.json()).toMatchObject({ code: 0, success: 2, failed: 0 });

    const added = await post(`/api/v1/dns/domains/${domain!.id}/records/batch-add`, {
      records: ['www 1.1.1.1', '@ 2001:db8::1', 'bad-line'],
    }, headers);
    expect(await added.json()).toMatchObject({ code: 0, added: 2, failed: 1 });

    const remoteLog = await (await request(`/api/v1/dns/domains/${domain!.id}/record-logs`, { headers: { cookie } })).json();
    expect(remoteLog).toMatchObject({ code: 0, supported: false, total: 0 });

    const logs = await (await request(`/api/v1/dns/logs?domain=${domain!.name}`, { headers: { cookie } })).json() as { total: number; items: { action: string }[] };
    expect(logs.total).toBeGreaterThanOrEqual(2);
    expect(logs.items.map((item) => item.action)).toContain('record.batch.add');
  });
});
