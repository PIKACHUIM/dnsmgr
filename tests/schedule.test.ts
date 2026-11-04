import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app';
import { AppError } from '../src/core/errors';
import type { Bindings, RequestBudget } from '../src/core/types';
import { environment } from '../src/platform/runtime';
import { nextRunAt } from '../src/schedule/tasks';
import { createTestDatabase } from './helpers/sqlite';

const credentials = { username: 'admin', password: 'test-password-2026!' };
const appKey = btoa('12345678901234567890123456789012');
let failRecordUpdate = false;
let rdapLookupStatus = 200;
let rdapRequests: string[] = [];
let wxpusherRequests: string[] = [];

function transport() {
  return vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const json = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
    if (url.hostname === 'data.iana.org') {
      rdapRequests.push(url.toString());
      return json({ services: [[['com'], ['https://rdap.verisign.com/com/v1/']]] });
    }
    if (url.hostname === 'rdap.verisign.com') {
      rdapRequests.push(url.toString());
      return json({ events: [{ eventAction: 'expiration', eventDate: '2030-01-01T00:00:00Z' }] }, rdapLookupStatus);
    }
    if (url.hostname === 'wxpusher.zjiecode.com') {
      wxpusherRequests.push(String(init.body ?? ''));
      return json({ success: true });
    }
    if (url.pathname === '/client/v4/zones') return json({ success: true, result: [{ id: 'zone-1', name: 'example.com' }] });
    if (/\/dns_records\/r\d+$/.test(url.pathname)) {
      if (failRecordUpdate && init.method === 'PATCH') {
        return json({ success: false, errors: [{ code: 1000, message: 'write failed' }] });
      }
      return json({ success: true, result: { id: 'r1', name: 'www.example.com', type: 'A', content: '1.1.1.1', ttl: 600 } });
    }
    if (url.pathname.endsWith('/dns_records') && (init.method ?? 'GET') === 'GET') return json({ success: true, result: [], result_info: { total_count: 0 } });
    return json({ success: true, result: { id: 'r1' } });
  }) as unknown as typeof fetch;
}

describe('schedule next run calculation', () => {
  const at = (iso: string) => Math.floor(Date.parse(iso) / 1000);

  it('handles once, daily, weekly and monthly modes', () => {
    const now = at('2026-11-02T01:00:00Z'); // 本地 09:00 UTC+8
    expect(nextRunAt({ mode: 'daily', runTime: '10:30' }, now, 480)).toBe(at('2026-11-02T02:30:00Z'));
    expect(nextRunAt({ mode: 'daily', runTime: '08:00' }, now, 480)).toBe(at('2026-11-03T00:00:00Z'));
    expect(nextRunAt({ mode: 'weekly', runTime: '10:00', weekday: 3 }, now, 480)).toBe(at('2026-11-04T02:00:00Z'));
    expect(nextRunAt({ mode: 'monthly', runTime: '10:00', monthDay: 31 }, now, 480)).toBe(at('2026-12-31T02:00:00Z'));
    expect(nextRunAt({ mode: 'once', runTime: '10:00', runDate: '2026-11-02' }, now, 480)).toBe(at('2026-11-02T02:00:00Z'));
    expect(nextRunAt({ mode: 'once', runTime: '08:00', runDate: '2026-11-02' }, now, 480)).toBeNull();
  });
});

describe('schedule API', () => {
  let testDb: ReturnType<typeof createTestDatabase>;
  let app: ReturnType<typeof createApp>;
  let bindings: Bindings;
  let cookie = '';
  let csrf = '';

  beforeEach(async () => {
    failRecordUpdate = false;
    rdapLookupStatus = 200;
    rdapRequests = [];
    wxpusherRequests = [];
    testDb = createTestDatabase();
    app = createApp({ database: testDb.db });
    const budget: RequestBudget = { consume: () => {}, remainingMs: () => 30_000, fetch: transport() };
    bindings = {
      DB_DRIVER: 'turso', DB_FORMAT: 'sql', TURSO_DATABASE_URL: 'https://test.invalid', TURSO_AUTH_TOKEN: 'test-token',
      APP_KEY: appKey, SETUP_TOKEN: 'test-install-token-32-characters!!', BUDGET: budget,
    };
    await post('/install', credentials, { 'X-Setup-Token': bindings.SETUP_TOKEN! });
    const login = await post('/login', credentials);
    const body = await login.json() as { csrfToken: string };
    csrf = body.csrfToken;
    cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    const account = await (await post('/api/v1/dns/accounts', {
      type: 'cloudflare', name: 'cf', config: { apikey: 'token' },
    }, { 'X-CSRF-Token': csrf })).json() as { id: number };
    await post(`/api/v1/dns/accounts/${account.id}/sync`, { domains: [{ id: 'zone-1', name: 'example.com' }] }, { 'X-CSRF-Token': csrf });
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

  async function enableCron() {
    const now = Math.floor(Date.now() / 1000);
    await testDb.db.execute('INSERT INTO app_settings (key, value, updated_at) VALUES (?,?,?)', ['cron_enabled', '1', now]);
    await testDb.db.execute('INSERT INTO app_settings (key, value, updated_at) VALUES (?,?,?)', ['cron_key', 'test-cron-key', now]);
  }

  it('creates tasks, exposes cron settings and executes due work', async () => {
    const settings = await request('/api/v1/system/cron', { headers: { cookie } });
    const config = await settings.json() as { key: string; enabled: boolean };
    expect(config.enabled).toBe(false);
    expect(config.key).toMatch(/^[0-9a-f]{32}$/);

    expect((await request('/api/v1/system/cron', {
      method: 'PUT', headers: { 'content-type': 'application/json', cookie, 'X-CSRF-Token': csrf },
      body: JSON.stringify({ enabled: true }),
    })).status).toBe(200);

    const domains = await (await request('/api/v1/dns/domains', { headers: { cookie } })).json() as { items: { id: number }[] };
    const domainId = domains.items[0]!.id;
    expect((await post('/api/v1/schedule/tasks', {
      domainId, recordName: 'www', recordType: 'A', recordId: 'r1', switchType: 2,
      mode: 'once', runDate: '2099-01-01', runTime: '10:00',
    })).status).toBe(200);

    const list = await (await request('/api/v1/schedule/tasks', { headers: { cookie } })).json() as { items: { id: number; active: boolean; nextRunAt: number }[] };
    expect(list.items[0]).toMatchObject({ active: true, mode: 'once', switchType: 2 });

    expect((await request('/api/v1/schedule/tasks/' + list.items[0]!.id, {
      method: 'PATCH', headers: { 'content-type': 'application/json', cookie, 'X-CSRF-Token': csrf },
      body: JSON.stringify({ active: false }),
    })).status).toBe(200);

    const now = Math.floor(Date.now() / 1000);
    await testDb.db.execute(
      `INSERT INTO dns_schedule_tasks
       (domain_id, record_id, record_name, record_type, switch_type, mode, run_time, active, next_run_at, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [domainId, 'r1', 'www', 'A', 2, 'once', '10:00', 1, now - 1, now, now],
    );
    const run = await post('/api/v1/schedule/run', {});
    expect(await run.json()).toMatchObject({ code: 0, ran: 1, failed: 0 });
    const tasks = await testDb.db.query<{ active: number; next_run_at: number; last_run_at: number }>('SELECT active, next_run_at, last_run_at FROM dns_schedule_tasks WHERE next_run_at = 0');
    expect(tasks[0]).toMatchObject({ active: 0, next_run_at: 0 });
    expect(tasks[0]!.last_run_at).toBeGreaterThan(0);

    expect(await (await request(`/cron?key=${config.key}`)).text()).toBe('success!');
    expect(await (await request('/cron?key=wrong')).text()).toBe('访问密钥错误');
  });

  it('sends WxPusher notifications when a scheduled DNS update fails', async () => {
    const saved = await request('/api/v1/system/notify', {
      method: 'PUT', headers: { 'content-type': 'application/json', cookie, 'X-CSRF-Token': csrf },
      body: JSON.stringify({ wxpusherAppToken: 'AT_scheduled-test', wxpusherUids: 'UID_scheduled-test' }),
    });
    expect(saved.status).toBe(200);
    const domains = await (await request('/api/v1/dns/domains', { headers: { cookie } })).json() as { items: { id: number }[] };
    const now = Math.floor(Date.now() / 1000);
    await testDb.db.execute(
      `INSERT INTO dns_schedule_tasks
       (domain_id, record_id, record_name, record_type, switch_type, mode, run_time, value, active, next_run_at, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [domains.items[0]!.id, 'r1', 'www', 'A', 0, 'once', '10:00', '8.8.8.8', 1, now - 1, now, now],
    );
    failRecordUpdate = true;
    const run = await post('/api/v1/schedule/run', {});
    expect(await run.json()).toMatchObject({ code: 0, ran: 0, failed: 1 });
    expect(wxpusherRequests).toHaveLength(1);
    expect(JSON.parse(wxpusherRequests[0]!)).toMatchObject({ appToken: 'AT_scheduled-test', uids: ['UID_scheduled-test'] });
  });

  it('refreshes one pending domain from cron and avoids duplicate concurrent lookups', async () => {
    await enableCron();
    const path = '/cron?key=test-cron-key';
    const results = await Promise.all([request(path), request(path)]);
    expect(await Promise.all(results.map((response) => response.text()))).toEqual(['success!', 'success!']);
    expect(rdapRequests).toHaveLength(2);
    const domains = await testDb.db.query<{ expires_at: number; check_status: number; checked_at: number }>(
      'SELECT expires_at, check_status, checked_at FROM dns_domains WHERE name=?', ['example.com'],
    );
    expect(domains[0]).toMatchObject({ expires_at: 1_893_456_000, check_status: 1, checked_at: expect.any(Number) });

    await request(path);
    expect(rdapRequests).toHaveLength(2);
  });

  it('marks failed initial lookups without replacing an existing expiration date', async () => {
    await enableCron();
    rdapLookupStatus = 503;
    await testDb.db.execute('UPDATE dns_domains SET expires_at=? WHERE name=?', [1_900_000_000, 'example.com']);
    await request('/cron?key=test-cron-key');
    const domains = await testDb.db.query<{ expires_at: number; check_status: number; checked_at: number }>(
      'SELECT expires_at, check_status, checked_at FROM dns_domains WHERE name=?', ['example.com'],
    );
    expect(domains[0]).toMatchObject({ expires_at: 1_900_000_000, check_status: 2, checked_at: expect.any(Number) });
  });

  it('reclaims a stale pending expiration claim after a crashed cron request', async () => {
    await enableCron();
    const now = Math.floor(Date.now() / 1000);
    await testDb.db.execute('UPDATE dns_domains SET check_status=3, checked_at=? WHERE name=?', [now - 301, 'example.com']);
    await request('/cron?key=test-cron-key');
    const domains = await testDb.db.query<{ expires_at: number; check_status: number; checked_at: number }>(
      'SELECT expires_at, check_status, checked_at FROM dns_domains WHERE name=?', ['example.com'],
    );
    expect(domains[0]).toMatchObject({ expires_at: 1_893_456_000, check_status: 1, checked_at: expect.any(Number) });
  });

  it('releases the pending claim when the platform fetch budget is exhausted', async () => {
    await enableCron();
    bindings.BUDGET!.fetch = async () => { throw new AppError(503, 'budget exhausted', 'REQUEST_BUDGET_EXCEEDED'); };
    await request('/cron?key=test-cron-key');
    const domains = await testDb.db.query<{ expires_at: number | null; check_status: number; checked_at: number | null }>(
      'SELECT expires_at, check_status, checked_at FROM dns_domains WHERE name=?', ['example.com'],
    );
    expect(domains[0]).toEqual({ expires_at: null, check_status: 0, checked_at: null });
  });
});
