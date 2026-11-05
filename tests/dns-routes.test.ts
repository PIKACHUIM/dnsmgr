import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app';
import { md5 } from 'js-md5';
import { AppError } from '../src/core/errors';
import type { Bindings, RequestBudget } from '../src/core/types';
import { environment } from '../src/platform/runtime';
import { encrypt } from '../src/security/crypto';
import { createTestDatabase } from './helpers/sqlite';

const credentials = { username: 'admin', password: 'test-password-2026!' };
const appKey = btoa('12345678901234567890123456789012');
let rdapLookupStatus = 200;
let dohPayload: unknown = { Status: 0, Answer: [{ type: 1, data: '1.1.1.1' }] };
let dohQueries: URL[] = [];

function cloudflareFetch() {
  let nextRecord = 1;
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    const json = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
    if (url.hostname === 'dns.alidns.com') {
      dohQueries.push(url);
      return json(dohPayload);
    }
    if (url.hostname === 'data.iana.org') {
      return json({ services: [[['com'], ['https://rdap.verisign.com/com/v1/']]] });
    }
    if (url.hostname === 'rdap.verisign.com') {
      return json({ events: [{ eventAction: 'expiration', eventDate: '2030-01-01T00:00:00Z' }] }, rdapLookupStatus);
    }
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
    rdapLookupStatus = 200;
    dohPayload = { Status: 0, Answer: [{ type: 1, data: '1.1.1.1' }] };
    dohQueries = [];
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

  it('serves the read-only legacy signed domain list with old row names and current permissions', async () => {
    const { cookie, csrf } = await session();
    const account = await (await post('/api/v1/dns/accounts', {
      type: 'cloudflare', name: 'legacy-api', config: { apikey: 'token' }, remark: 'account remark',
    }, { cookie, 'X-CSRF-Token': csrf })).json() as { id: number };
    const synced = await post(`/api/v1/dns/accounts/${account.id}/sync`, {
      domains: [
        { id: 'zone-shop', name: 'shop.example.com', recordCount: 8 },
        { id: 'zone-hidden', name: 'hidden.example.com', recordCount: 2 },
        { id: 'zone-expired', name: 'expired.example.net', recordCount: 1 },
      ],
    }, { cookie, 'X-CSRF-Token': csrf });
    expect(synced.status).toBe(200);

    const now = Math.floor(Date.now() / 1000);
    await testDb.db.execute('INSERT INTO dns_domain_categories(name,sort,created_at) VALUES(?,?,?)', ['Favorites', 1, now]);
    const category = await testDb.db.query<{ id: number }>('SELECT id FROM dns_domain_categories WHERE name=?', ['Favorites']);
    await testDb.db.execute(
      'UPDATE dns_domains SET remark=?,notice=1,category_id=?,expires_at=?,checked_at=?,check_status=1 WHERE name=?',
      ['shop memo', category[0]!.id, now + 7 * 86_400, now - 60, 'shop.example.com'],
    );
    await testDb.db.execute('UPDATE dns_domains SET hidden=1 WHERE name=?', ['hidden.example.com']);
    await testDb.db.execute('UPDATE dns_domains SET expires_at=?,check_status=1 WHERE name=?', [now - 60, 'expired.example.net']);
    await testDb.db.execute('UPDATE users SET is_api=1,apikey_cipher=? WHERE id=1', [await encrypt('legacy-api-key', bindings.APP_KEY, 'api-key')]);

    async function signedList(params: Record<string, string> = {}) {
      const timestamp = String(Math.floor(Date.now() / 1000));
      const form = new URLSearchParams({
        uid: '1', timestamp, sign: md5(`1${timestamp}legacy-api-key`), ...params,
      });
      return request('/api/domain', {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form.toString(),
      });
    }

    const before = await testDb.db.query<{ id: number; record_count: number; updated_at: number }>(
      'SELECT id,record_count,updated_at FROM dns_domains ORDER BY id',
    );
    const fetchCount = (budget.fetch as ReturnType<typeof vi.fn>).mock.calls.length;
    const listed = await signedList({ limit: '20', sortName: 'name', sortOrder: 'asc' });
    expect(listed.status).toBe(200);
    const result = await listed.json() as { total: number; rows: Record<string, unknown>[] };
    expect(result.total).toBe(3);
    expect(result.rows.map((row) => row.name)).toEqual(['expired.example.net', 'hidden.example.com', 'shop.example.com']);
    expect(result.rows.find((row) => row.name === 'shop.example.com')).toMatchObject({
      aid: account.id, cid: category[0]!.id, thirdid: 'zone-shop', is_hide: 0, is_sso: 0,
      recordcount: 8, remark: 'shop memo', is_notice: 1, regtime: null,
      checkstatus: 1, type: 'cloudflare', aremark: 'account remark', typename: 'Cloudflare',
      icon: 'cloudflare.ico', category_name: 'Favorites',
    });
    expect(result.rows.find((row) => row.name === 'shop.example.com')!.expiretime).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    await expect((await signedList({ kw: 'shop memo' })).json()).resolves.toMatchObject({ total: 1 });
    await expect((await signedList({ status: '1' })).json()).resolves.toMatchObject({ total: 1 });
    await expect((await signedList({ status: '2' })).json()).resolves.toMatchObject({ total: 1 });
    await expect((await signedList({ status: '10' })).json()).resolves.toMatchObject({ total: 3 });
    await expect((await signedList({ aid: String(account.id) })).json()).resolves.toMatchObject({ total: 3 });
    await expect((await signedList({ type: 'cloud' })).json()).resolves.toMatchObject({ total: 3 });
    await expect((await signedList({ cid: String(category[0]!.id) })).json()).resolves.toMatchObject({ total: 1 });
    await expect((await signedList({ id: String(result.rows.find((row) => row.name === 'shop.example.com')!.id), kw: 'expired' })).json()).resolves.toMatchObject({ total: 1, rows: [{ name: 'shop.example.com' }] });
    await expect((await signedList({ offset: '1', limit: '1', sortName: 'name', sortOrder: 'asc' })).json()).resolves.toMatchObject({ total: 3, rows: [{ name: 'hidden.example.com' }] });
    expect(await (await signedList({ sortName: 'constructor' })).json()).toMatchObject({ total: 3 });

    await testDb.db.execute('UPDATE users SET level=1 WHERE id=1');
    await testDb.db.execute('INSERT INTO permissions(user_id,domain_id) VALUES(1,?)', [String(result.rows.find((row) => row.name === 'shop.example.com')!.id)]);
    const scoped = await signedList();
    expect(await scoped.json()).toMatchObject({ total: 1, rows: [{ name: 'shop.example.com' }] });
    await testDb.db.execute('UPDATE users SET level=3 WHERE id=1');
    expect(await (await signedList()).json()).toEqual({ total: 0, rows: [] });
    expect(await testDb.db.query('SELECT id,record_count,updated_at FROM dns_domains ORDER BY id')).toEqual(before);
    expect((budget.fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(fetchCount);
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

  it('refreshes one domain expiration through RDAP with CSRF protection', async () => {
    const { cookie, csrf } = await session();
    const [domain] = await seedDomain(cookie, csrf);
    const path = `/api/v1/dns/domains/${domain!.id}/expiration/refresh`;
    expect((await post(path, {}, { cookie })).status).toBe(403);

    const response = await post(path, {}, { cookie, 'X-CSRF-Token': csrf });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ code: 0, expiresAt: 1893456000, checkStatus: 1 });
    const stored = await testDb.db.query<{ expires_at: number; checked_at: number; check_status: number }>(
      'SELECT expires_at, checked_at, check_status FROM dns_domains WHERE id=?', [domain!.id],
    );
    expect(stored[0]).toMatchObject({ expires_at: 1893456000, check_status: 1, checked_at: expect.any(Number) });
  });

  it('marks failed expiration lookups without replacing the previous date', async () => {
    const { cookie, csrf } = await session();
    const [domain] = await seedDomain(cookie, csrf);
    await testDb.db.execute('UPDATE dns_domains SET expires_at=?, check_status=1 WHERE id=?', [1_900_000_000, domain!.id]);
    rdapLookupStatus = 503;

    const response = await post(`/api/v1/dns/domains/${domain!.id}/expiration/refresh`, {}, { cookie, 'X-CSRF-Token': csrf });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ reason: 'EXPIRATION_LOOKUP_FAILED' });
    const stored = await testDb.db.query<{ expires_at: number; checked_at: number; check_status: number }>(
      'SELECT expires_at, checked_at, check_status FROM dns_domains WHERE id=?', [domain!.id],
    );
    expect(stored[0]).toMatchObject({ expires_at: 1_900_000_000, check_status: 2, checked_at: expect.any(Number) });
  });

  it('does not record a failed lookup when the platform request budget is exhausted', async () => {
    const { cookie, csrf } = await session();
    const [domain] = await seedDomain(cookie, csrf);
    budget.fetch = async () => { throw new AppError(503, 'budget exhausted', 'REQUEST_BUDGET_EXCEEDED'); };

    const response = await post(`/api/v1/dns/domains/${domain!.id}/expiration/refresh`, {}, { cookie, 'X-CSRF-Token': csrf });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ reason: 'REQUEST_BUDGET_EXCEEDED' });
    const stored = await testDb.db.query<{ expires_at: number | null; checked_at: number | null; check_status: number }>(
      'SELECT expires_at, checked_at, check_status FROM dns_domains WHERE id=?', [domain!.id],
    );
    expect(stored[0]).toEqual({ expires_at: null, checked_at: null, check_status: 0 });
  });

  it('checks public DNS records without changing DNS state', async () => {
    const { cookie, csrf } = await session();
    const [domain] = await seedDomain(cookie, csrf);
    const path = `/api/v1/dns/domains/${domain!.id}/records/check`;
    const body = { name: 'www', type: 'A', value: '1.1.1.1' };
    const headers = { cookie, 'X-CSRF-Token': csrf };
    const stateBefore = await testDb.db.query('SELECT expires_at, checked_at, check_status, updated_at FROM dns_domains WHERE id=?', [domain!.id]);
    const auditBefore = await testDb.db.query<{ n: number }>('SELECT COUNT(*) AS n FROM audit_logs');

    expect((await post(path, body, { cookie })).status).toBe(403);
    const active = await post(path, body, headers);
    expect(active.status).toBe(200);
    expect(await active.json()).toEqual({ code: 0, data: { status: 'active', actual: ['1.1.1.1'] } });
    expect(dohQueries[0]!.searchParams.get('name')).toBe('www.example.com');

    dohPayload = { Status: 0, Answer: [{ type: 1, data: '2.2.2.2' }] };
    const mismatch = await post(path, body, headers);
    expect(await mismatch.json()).toEqual({ code: 0, data: { status: 'mismatch', actual: ['2.2.2.2'], expected: '1.1.1.1' } });

    dohPayload = { Status: 3 };
    const missing = await post(path, body, headers);
    expect(await missing.json()).toEqual({ code: 0, data: { status: 'not_found', actual: [] } });

    const unsupported = await post(path, { ...body, type: 'URL' }, headers);
    expect(unsupported.status).toBe(400);
    expect(await unsupported.json()).toMatchObject({ reason: 'UNSUPPORTED_DNS_CHECK_TYPE' });
    const invalidName = await post(path, { ...body, name: 'www..net' }, headers);
    expect(invalidName.status).toBe(400);
    const emptyValue = await post(path, { ...body, value: '   ' }, headers);
    expect(emptyValue.status).toBe(400);
    expect(await emptyValue.json()).toMatchObject({ reason: 'INVALID_RECORD_VALUE' });

    expect(await testDb.db.query('SELECT expires_at, checked_at, check_status, updated_at FROM dns_domains WHERE id=?', [domain!.id])).toEqual(stateBefore);
    expect((await testDb.db.query<{ n: number }>('SELECT COUNT(*) AS n FROM audit_logs'))[0]!.n).toBe(auditBefore[0]!.n);
  });

  it('requires domain read permission and rate-limits public DNS lookups', async () => {
    const { cookie, csrf } = await session();
    const [domain] = await seedDomain(cookie, csrf);
    const path = `/api/v1/dns/domains/${domain!.id}/records/check`;
    const body = { name: 'www', type: 'A', value: '1.1.1.1' };
    await testDb.db.execute('UPDATE users SET level=0 WHERE id=1');
    expect((await post(path, body, { cookie, 'X-CSRF-Token': csrf })).status).toBe(403);
    expect(dohQueries).toHaveLength(0);

    await testDb.db.execute('UPDATE users SET level=2 WHERE id=1');
    const responses: Response[] = [];
    for (let attempt = 0; attempt < 21; attempt++) responses.push(await post(path, body, { cookie, 'X-CSRF-Token': csrf }));
    expect(responses.slice(0, 20).every((response) => response.status === 200)).toBe(true);
    expect(responses[20]!.status).toBe(429);
    expect(dohQueries).toHaveLength(20);
  });

  it('preserves request-budget errors instead of reporting DNS not_found', async () => {
    const { cookie, csrf } = await session();
    const [domain] = await seedDomain(cookie, csrf);
    budget.fetch = async () => { throw new AppError(503, 'budget exhausted', 'REQUEST_BUDGET_EXCEEDED'); };

    const response = await post(`/api/v1/dns/domains/${domain!.id}/records/check`,
      { name: '@', type: 'A', value: '1.1.1.1' }, { cookie, 'X-CSRF-Token': csrf });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ reason: 'REQUEST_BUDGET_EXCEEDED' });
  });

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

  it('queues batch expiration refreshes without resetting active claims or replacing dates', async () => {
    const { cookie, csrf } = await session();
    const domains = await seedDomain(cookie, csrf, ['a.example.com', 'b.example.com']);
    const headers = { cookie, 'X-CSRF-Token': csrf };
    await testDb.db.execute('UPDATE dns_domains SET expires_at=?, checked_at=123, check_status=1, updated_at=100 WHERE id=?', [1_900_000_000, domains[0]!.id]);
    await testDb.db.execute('UPDATE dns_domains SET expires_at=?, checked_at=456, check_status=3, updated_at=100 WHERE id=?', [1_910_000_000, domains[1]!.id]);

    expect((await post('/api/v1/dns/domains/batch', { ids: domains.map((domain) => domain.id), action: 'expiration-refresh' }, { cookie })).status).toBe(403);
    const response = await post('/api/v1/dns/domains/batch', { ids: domains.map((domain) => domain.id), action: 'expiration-refresh' }, headers);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ code: 0, affected: 1, requested: 2 });

    const rows = await testDb.db.query<{ id: number; expires_at: number; checked_at: number | null; check_status: number; updated_at: number }>(
      'SELECT id, expires_at, checked_at, check_status, updated_at FROM dns_domains ORDER BY id',
    );
    const queued = rows.find((row) => row.id === domains[0]!.id);
    const activeClaim = rows.find((row) => row.id === domains[1]!.id);
    expect(queued).toMatchObject({ expires_at: 1_900_000_000, checked_at: null, check_status: 0 });
    expect(queued!.updated_at).toBeGreaterThan(100);
    expect(activeClaim).toEqual({ id: domains[1]!.id, expires_at: 1_910_000_000, checked_at: 456, check_status: 3, updated_at: 100 });
    expect((await testDb.db.query<{ action: string; detail: string }>(
      "SELECT action, detail FROM audit_logs WHERE action='domain.batch.expiration-refresh'",
    ))[0]).toEqual({ action: 'domain.batch.expiration-refresh', detail: 'affected=1' });
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

    const batchPath = `/api/v1/dns/domains/${domain!.id}/records/batch-add`;
    const records = [
      'www 1.1.1.1',
      '@ 2001:db8::1',
      { name: 'mail', type: 'UNKNOWN', value: 'mail.example.com' },
      'bad-line',
    ];
    expect((await post(batchPath, { records }, { cookie })).status).toBe(403);
    const added = await post(batchPath, { records }, headers);
    expect(await added.json()).toMatchObject({
      code: 0, added: 2, failed: 2,
      results: [
        { index: 0, ok: true },
        { index: 1, ok: true },
        { index: 2, ok: false, error: '不支持的记录类型' },
        { index: 3, ok: false, error: '无法解析：bad-line' },
      ],
    });

    budget.fetch = async () => { throw new AppError(503, '上游请求超时', 'REQUEST_TIMEOUT'); };
    const uncertain = await post(batchPath, { records: [{ name: 'delayed', type: 'A', value: '1.1.1.2' }] }, headers);
    const uncertainPayload = await uncertain.json() as {
      code: number; added: number; failed: number;
      results: { index: number; ok: boolean; uncertain?: boolean; error?: string }[];
    };
    expect(uncertainPayload).toMatchObject({
      code: 0, added: 0, failed: 1,
      results: [{ index: 0, ok: false, uncertain: true }],
    });
    expect(uncertainPayload.results[0]!.error).toBeTruthy();

    const remoteLog = await (await request(`/api/v1/dns/domains/${domain!.id}/record-logs`, { headers: { cookie } })).json();
    expect(remoteLog).toMatchObject({ code: 0, supported: false, total: 0 });

    const logs = await (await request(`/api/v1/dns/logs?domain=${domain!.name}`, { headers: { cookie } })).json() as { total: number; items: { action: string }[] };
    expect(logs.total).toBeGreaterThanOrEqual(2);
    expect(logs.items.map((item) => item.action)).toContain('record.batch.add');
  });
});
