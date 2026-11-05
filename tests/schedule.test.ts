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
let wxpusherSuccess = true;
let telegramRequests: string[] = [];

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
      return json({ success: wxpusherSuccess });
    }
    if (url.hostname === 'api.telegram.org') {
      telegramRequests.push(String(init.body ?? ''));
      return json({ ok: true, result: { message_id: 1 } });
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
    wxpusherSuccess = true;
    telegramRequests = [];
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

  async function addDomain(name: string, expiresAt: number, checkedAt: number, checkStatus: number) {
    const accounts = await testDb.db.query<{ id: number }>('SELECT id FROM dns_accounts LIMIT 1');
    const now = Math.floor(Date.now() / 1000);
    await testDb.db.execute(
      `INSERT INTO dns_domains
       (account_id, name, third_id, record_count, expires_at, checked_at, check_status, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [accounts[0]!.id, name, `zone-${name}`, 0, expiresAt, checkedAt, checkStatus, now, now],
    );
  }

  async function setExpirationNoticeConfig(days: string, localHour: number) {
    const now = Math.floor(Date.now() / 1000);
    const utc = new Date(now * 1000);
    const utcMinutes = utc.getUTCHours() * 60 + utc.getUTCMinutes();
    let offset = localHour * 60 - utcMinutes;
    if (offset > 720) offset -= 1440;
    if (offset < -720) offset += 1440;
    await testDb.db.execute(
      'INSERT INTO app_settings (key, value, updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at',
      ['expire_noticedays', days, now],
    );
    await testDb.db.execute(
      'INSERT INTO app_settings (key, value, updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at',
      ['schedule_tz_offset', String(offset), now],
    );
  }

  async function setExpirationNoticeChannels(channels: Record<string, boolean>) {
    const now = Math.floor(Date.now() / 1000);
    await testDb.db.execute(
      'INSERT INTO app_settings (key, value, updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at',
      ['expire_notice_channels', JSON.stringify(channels), now],
    );
  }

  async function enableTelegramNotices() {
    const saved = await request('/api/v1/system/notify', {
      method: 'PUT', headers: { 'content-type': 'application/json', cookie, 'X-CSRF-Token': csrf },
      body: JSON.stringify({ telegramBotToken: '123456:abcdefghijklmnopqrstuvwxyz', telegramChatId: '12345' }),
    });
    expect(saved.status).toBe(200);
  }

  async function enableWxPusherNotices() {
    const saved = await request('/api/v1/system/notify', {
      method: 'PUT', headers: { 'content-type': 'application/json', cookie, 'X-CSRF-Token': csrf },
      body: JSON.stringify({ wxpusherAppToken: 'AT_expiration-test', wxpusherUids: 'UID_expiration-test' }),
    });
    expect(saved.status).toBe(200);
  }

  it('stores expiration notice days with admin, CSRF and input validation', async () => {
    const unauthorized = await request('/api/v1/system/expiration-notice');
    expect(unauthorized.status).toBe(401);

    const current = await request('/api/v1/system/expiration-notice', { headers: { cookie } });
    expect(await current.json()).toMatchObject({ code: 0, days: '' });

    const missingCsrf = await request('/api/v1/system/expiration-notice', {
      method: 'PUT', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ days: '7' }),
    });
    expect(missingCsrf.status).toBe(403);

    const saved = await request('/api/v1/system/expiration-notice', {
      method: 'PUT', headers: { 'content-type': 'application/json', cookie, 'X-CSRF-Token': csrf },
      body: JSON.stringify({ days: '14, 7,14' }),
    });
    expect(await saved.json()).toMatchObject({ code: 0, days: '7,14' });
    const reloaded = await request('/api/v1/system/expiration-notice', { headers: { cookie } });
    expect(await reloaded.json()).toMatchObject({ code: 0, days: '7,14' });
    const stored = await testDb.db.query<{ value: string }>('SELECT value FROM app_settings WHERE key=?', ['expire_noticedays']);
    expect(stored[0]!.value).toBe('7,14');
    expect(await testDb.db.query('SELECT key FROM app_settings WHERE key=?', ['expire_notice_channels'])).toEqual([]);

    for (const days of ['7,,14', '3651', '1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33', 7]) {
      const invalid = await request('/api/v1/system/expiration-notice', {
        method: 'PUT', headers: { 'content-type': 'application/json', cookie, 'X-CSRF-Token': csrf },
        body: JSON.stringify({ days }),
      });
      expect(invalid.status).toBe(400);
    }

    const disabled = await request('/api/v1/system/expiration-notice', {
      method: 'PUT', headers: { 'content-type': 'application/json', cookie, 'X-CSRF-Token': csrf },
      body: JSON.stringify({ days: '' }),
    });
    expect(await disabled.json()).toMatchObject({ code: 0, days: '' });

    await testDb.db.execute('UPDATE users SET level=1 WHERE id=1');
    const nonAdmin = await request('/api/v1/system/expiration-notice', { headers: { cookie } });
    expect(nonAdmin.status).toBe(403);
  });

  it('stores per-channel expiration notice settings with defaults, CSRF and validation', async () => {
    const defaults = await request('/api/v1/system/expiration-notice', { headers: { cookie } });
    expect(await defaults.json()).toMatchObject({ channels: {
      webhook: true, wxpusher: true, telegram: true, wecom: true, dingtalk: true, feishu: true,
    } });

    const channels = { webhook: false, wxpusher: true, telegram: false, wecom: false, dingtalk: true, feishu: false };
    const saved = await request('/api/v1/system/expiration-notice', {
      method: 'PUT', headers: { 'content-type': 'application/json', cookie, 'X-CSRF-Token': csrf },
      body: JSON.stringify({ days: '7', channels }),
    });
    expect(await saved.json()).toMatchObject({ code: 0, days: '7', channels });

    const daysOnly = await request('/api/v1/system/expiration-notice', {
      method: 'PUT', headers: { 'content-type': 'application/json', cookie, 'X-CSRF-Token': csrf },
      body: JSON.stringify({ days: '14' }),
    });
    expect(await daysOnly.json()).toMatchObject({ days: '14', channels });

    const invalid = await request('/api/v1/system/expiration-notice', {
      method: 'PUT', headers: { 'content-type': 'application/json', cookie, 'X-CSRF-Token': csrf },
      body: JSON.stringify({ days: '14', channels: { ...channels, telegram: 'false' } }),
    });
    expect(invalid.status).toBe(400);

    const reloaded = await request('/api/v1/system/expiration-notice', { headers: { cookie } });
    expect(await reloaded.json()).toMatchObject({ days: '14', channels });

    await testDb.db.execute('UPDATE app_settings SET value=? WHERE key=?', ['not-json', 'expire_notice_channels']);
    const corrupted = await request('/api/v1/system/expiration-notice', { headers: { cookie } });
    expect(await corrupted.json()).toMatchObject({ channels: {
      webhook: false, wxpusher: false, telegram: false, wecom: false, dingtalk: false, feishu: false,
    } });
  });

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

  it('keeps scheduled failure notifications independent of expiration channel settings', async () => {
    const saved = await request('/api/v1/system/notify', {
      method: 'PUT', headers: { 'content-type': 'application/json', cookie, 'X-CSRF-Token': csrf },
      body: JSON.stringify({ wxpusherAppToken: 'AT_scheduled-test', wxpusherUids: 'UID_scheduled-test' }),
    });
    expect(saved.status).toBe(200);
    await setExpirationNoticeChannels({
      webhook: false, wxpusher: false, telegram: false, wecom: false, dingtalk: false, feishu: false,
    });
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

  it('refreshes a due known expiration after the initial queue and only once per cron', async () => {
    await enableCron();
    const now = Math.floor(Date.now() / 1000);
    const priorCheckedAt = now - 86_401;
    await addDomain('periodic.example.com', now + 10 * 86_400, priorCheckedAt, 1);

    await request('/cron?key=test-cron-key');
    expect(rdapRequests).toHaveLength(2);
    const initial = await testDb.db.query<{ check_status: number; expires_at: number | null }>(
      'SELECT check_status, expires_at FROM dns_domains WHERE name=?', ['example.com'],
    );
    const periodicBefore = await testDb.db.query<{ check_status: number; checked_at: number; expires_at: number }>(
      'SELECT check_status, checked_at, expires_at FROM dns_domains WHERE name=?', ['periodic.example.com'],
    );
    expect(initial[0]).toMatchObject({ check_status: 1, expires_at: 1_893_456_000 });
    expect(periodicBefore[0]).toEqual({ check_status: 1, checked_at: priorCheckedAt, expires_at: now + 10 * 86_400 });

    await request('/cron?key=test-cron-key');
    expect(rdapRequests).toHaveLength(4);
    const periodicAfter = await testDb.db.query<{ check_status: number; checked_at: number; expires_at: number }>(
      'SELECT check_status, checked_at, expires_at FROM dns_domains WHERE name=?', ['periodic.example.com'],
    );
    expect(periodicAfter[0]).toMatchObject({ check_status: 1, expires_at: 1_893_456_000 });
    expect(periodicAfter[0]!.checked_at).toBeGreaterThanOrEqual(now);

    await request('/cron?key=test-cron-key');
    expect(rdapRequests).toHaveLength(4);
  });

  it('skips periodic refreshes outside the expiry window or before the daily interval', async () => {
    await enableCron();
    const now = Math.floor(Date.now() / 1000);
    await testDb.db.execute(
      'UPDATE dns_domains SET expires_at=?, checked_at=?, check_status=1 WHERE name=?',
      [now + 31 * 86_400, now - 25 * 3_600, 'example.com'],
    );
    await addDomain('past.example.com', now - 6 * 86_400, now - 25 * 3_600, 2);
    await addDomain('recent.example.com', now + 10 * 86_400, now - 23 * 3_600, 1);

    await request('/cron?key=test-cron-key');

    expect(rdapRequests).toHaveLength(0);
    const statuses = await testDb.db.query<{ check_status: number; checked_at: number; expires_at: number }>(
      'SELECT check_status, checked_at, expires_at FROM dns_domains ORDER BY name',
    );
    expect(statuses.every((domain) => domain.check_status !== 3)).toBe(true);
  });

  it('does not duplicate concurrent periodic refreshes', async () => {
    await enableCron();
    const now = Math.floor(Date.now() / 1000);
    await testDb.db.execute(
      'UPDATE dns_domains SET expires_at=?, checked_at=?, check_status=1 WHERE name=?',
      [now + 10 * 86_400, now - 86_401, 'example.com'],
    );

    const results = await Promise.all([
      request('/cron?key=test-cron-key'),
      request('/cron?key=test-cron-key'),
    ]);

    expect(await Promise.all(results.map((response) => response.text()))).toEqual(['success!', 'success!']);
    expect(rdapRequests).toHaveLength(2);
  });

  it('preserves the previous expiry when a periodic lookup fails', async () => {
    await enableCron();
    const now = Math.floor(Date.now() / 1000);
    rdapLookupStatus = 503;
    await testDb.db.execute(
      'UPDATE dns_domains SET expires_at=?, checked_at=?, check_status=1 WHERE name=?',
      [now + 10 * 86_400, now - 86_401, 'example.com'],
    );

    await request('/cron?key=test-cron-key');

    const domains = await testDb.db.query<{ expires_at: number; check_status: number; checked_at: number }>(
      'SELECT expires_at, check_status, checked_at FROM dns_domains WHERE name=?', ['example.com'],
    );
    expect(domains[0]).toMatchObject({ expires_at: now + 10 * 86_400, check_status: 2 });
    expect(domains[0]!.checked_at).toBeGreaterThanOrEqual(now);
    const logs = await testDb.db.query<{ detail: string }>(
      "SELECT detail FROM audit_logs WHERE action='domain.expiration.auto.failed'",
    );
    expect(logs[0]!.detail).toBe('periodic lookup failed');
  });

  it('restores the prior periodic state when the fetch budget is exhausted', async () => {
    await enableCron();
    const now = Math.floor(Date.now() / 1000);
    const priorCheckedAt = now - 86_401;
    const priorExpiresAt = now + 10 * 86_400;
    await testDb.db.execute(
      'UPDATE dns_domains SET expires_at=?, checked_at=?, check_status=2, updated_at=100 WHERE name=?',
      [priorExpiresAt, priorCheckedAt, 'example.com'],
    );
    bindings.BUDGET!.fetch = async () => { throw new AppError(503, 'budget exhausted', 'REQUEST_BUDGET_EXCEEDED'); };

    await request('/cron?key=test-cron-key');

    const domains = await testDb.db.query<{ expires_at: number; check_status: number; checked_at: number; updated_at: number }>(
      'SELECT expires_at, check_status, checked_at, updated_at FROM dns_domains WHERE name=?', ['example.com'],
    );
    expect(domains[0]).toEqual({ expires_at: priorExpiresAt, check_status: 2, checked_at: priorCheckedAt, updated_at: 100 });
  });

  it('sends a same-day reminder group after local 09:00 with a 20-hour cooldown', async () => {
    await enableCron();
    await enableWxPusherNotices();
    const now = Math.floor(Date.now() / 1000);
    const day = 86_400;
    await setExpirationNoticeConfig('7,14', 9);
    await testDb.db.execute('UPDATE dns_domains SET check_status=1, checked_at=?, expires_at=NULL WHERE name=?', [now, 'example.com']);
    await addDomain('alpha.example.com', now + 7 * day + 10, now, 1);
    await addDomain('beta.example.com', now + 7 * day + 20, now, 1);
    await addDomain('later.example.com', now + 14 * day + 10, now, 1);
    await addDomain('disabled.example.com', now + 7 * day + 1, now, 1);
    await addDomain('cooldown.example.com', now + 7 * day + 2, now, 1);
    await testDb.db.execute('UPDATE dns_domains SET notice=0 WHERE name=?', ['disabled.example.com']);
    await testDb.db.execute('UPDATE dns_domains SET notice_attempted_at=? WHERE name=?', [now - 3_600, 'cooldown.example.com']);
    await testDb.db.execute(
      'UPDATE dns_domains SET notice=1 WHERE name IN (?,?,?)',
      ['alpha.example.com', 'beta.example.com', 'later.example.com'],
    );

    await request('/cron?key=test-cron-key');

    expect(wxpusherRequests).toHaveLength(1);
    const first = JSON.parse(wxpusherRequests[0]!) as { summary: string; content: string };
    expect(first.summary).toContain('7');
    expect(first.content).toContain('alpha.example.com');
    expect(first.content).toContain('beta.example.com');
    expect(first.content).not.toContain('disabled.example.com');
    expect(first.content).not.toContain('cooldown.example.com');
    const firstGroup = await testDb.db.query<{ name: string; notice_attempted_at: number | null }>(
      'SELECT name, notice_attempted_at FROM dns_domains WHERE name IN (?,?,?) ORDER BY name',
      ['alpha.example.com', 'beta.example.com', 'later.example.com'],
    );
    expect(firstGroup.find((domain) => domain.name === 'alpha.example.com')!.notice_attempted_at).toBeGreaterThanOrEqual(now);
    expect(firstGroup.find((domain) => domain.name === 'beta.example.com')!.notice_attempted_at).toBeGreaterThanOrEqual(now);
    expect(firstGroup.find((domain) => domain.name === 'later.example.com')!.notice_attempted_at).toBeNull();
    const firstAudit = await testDb.db.query<{ detail: string }>("SELECT detail FROM audit_logs WHERE action='domain.expiration.notice'");
    expect(firstAudit[0]!.detail).toContain('wxpusher:ok:200');

    await request('/cron?key=test-cron-key');
    expect(wxpusherRequests).toHaveLength(2);
    expect((JSON.parse(wxpusherRequests[1]!) as { summary: string }).summary).toContain('14');
    await request('/cron?key=test-cron-key');
    expect(wxpusherRequests).toHaveLength(2);
  });

  it('sends expiry reminders only to configured channels enabled by the per-channel policy', async () => {
    await enableCron();
    await enableWxPusherNotices();
    await enableTelegramNotices();
    await setExpirationNoticeChannels({
      webhook: false, wxpusher: false, telegram: true, wecom: false, dingtalk: false, feishu: false,
    });
    const now = Math.floor(Date.now() / 1000);
    await setExpirationNoticeConfig('7', 9);
    await testDb.db.execute('UPDATE dns_domains SET check_status=1, checked_at=?, expires_at=NULL WHERE name=?', [now, 'example.com']);
    await addDomain('notice.example.com', now + 7 * 86_400 + 60, now, 1);
    await testDb.db.execute('UPDATE dns_domains SET notice=1 WHERE name=?', ['notice.example.com']);

    await request('/cron?key=test-cron-key');

    expect(wxpusherRequests).toHaveLength(0);
    expect(telegramRequests).toHaveLength(1);
    expect(JSON.parse(telegramRequests[0]!)).toMatchObject({ chat_id: '12345' });
    const logs = await testDb.db.query<{ detail: string }>("SELECT detail FROM audit_logs WHERE action='domain.expiration.notice'");
    expect(logs[0]!.detail).toContain('telegram:ok:200');
    expect(logs[0]!.detail).not.toContain('wxpusher');
  });

  it('does not send expiry reminders with empty days or before local 09:00', async () => {
    await enableCron();
    await enableWxPusherNotices();
    const now = Math.floor(Date.now() / 1000);
    await testDb.db.execute('UPDATE dns_domains SET check_status=1, checked_at=?, expires_at=NULL WHERE name=?', [now, 'example.com']);
    await addDomain('notice.example.com', now + 7 * 86_400 + 60, now, 1);
    await testDb.db.execute('UPDATE dns_domains SET notice=1 WHERE name=?', ['notice.example.com']);
    await setExpirationNoticeConfig('', 9);
    await request('/cron?key=test-cron-key');
    await setExpirationNoticeConfig('7', 8);
    await request('/cron?key=test-cron-key');
    expect(wxpusherRequests).toHaveLength(0);

    await setExpirationNoticeConfig('7', 9);
    await request('/cron?key=test-cron-key');
    expect(wxpusherRequests).toHaveLength(1);
  });

  it('prioritizes pending RDAP refresh work over expiry reminders', async () => {
    await enableCron();
    await enableWxPusherNotices();
    const now = Math.floor(Date.now() / 1000);
    await setExpirationNoticeConfig('7', 9);
    await testDb.db.execute(
      'UPDATE dns_domains SET check_status=1, checked_at=?, expires_at=? WHERE name=?',
      [now - 86_401, now + 10 * 86_400, 'example.com'],
    );
    await addDomain('notice.example.com', now + 7 * 86_400 + 60, now, 1);
    await testDb.db.execute('UPDATE dns_domains SET notice=1 WHERE name=?', ['notice.example.com']);

    await request('/cron?key=test-cron-key');
    expect(rdapRequests).toHaveLength(2);
    expect(wxpusherRequests).toHaveLength(0);
    let domains = await testDb.db.query<{ notice_attempted_at: number | null }>(
      'SELECT notice_attempted_at FROM dns_domains WHERE name=?', ['notice.example.com'],
    );
    expect(domains[0]!.notice_attempted_at).toBeNull();

    await request('/cron?key=test-cron-key');
    expect(wxpusherRequests).toHaveLength(1);
  });

  it('releases reminder claims when no notification channel is configured', async () => {
    await enableCron();
    const now = Math.floor(Date.now() / 1000);
    await setExpirationNoticeConfig('7', 9);
    await testDb.db.execute('UPDATE dns_domains SET check_status=1, checked_at=?, expires_at=NULL WHERE name=?', [now, 'example.com']);
    await addDomain('notice.example.com', now + 7 * 86_400 + 60, now, 1);
    await testDb.db.execute('UPDATE dns_domains SET notice=1 WHERE name=?', ['notice.example.com']);

    await request('/cron?key=test-cron-key');
    let domains = await testDb.db.query<{ notice_attempted_at: number | null }>(
      'SELECT notice_attempted_at FROM dns_domains WHERE name=?', ['notice.example.com'],
    );
    expect(domains[0]!.notice_attempted_at).toBeNull();
    expect(wxpusherRequests).toHaveLength(0);

    await enableWxPusherNotices();
    const notificationSecret = await testDb.db.query<{ value: string }>(
      'SELECT value FROM app_settings WHERE key=?', ['notification_secrets_cipher'],
    );
    await testDb.db.execute('UPDATE app_settings SET value=? WHERE key=?', ['broken-ciphertext', 'notification_secrets_cipher']);
    await setExpirationNoticeChannels({
      webhook: false, wxpusher: false, telegram: false, wecom: false, dingtalk: false, feishu: false,
    });
    await request('/cron?key=test-cron-key');
    expect(wxpusherRequests).toHaveLength(0);
    domains = await testDb.db.query<{ notice_attempted_at: number | null }>(
      'SELECT notice_attempted_at FROM dns_domains WHERE name=?', ['notice.example.com'],
    );
    expect(domains[0]!.notice_attempted_at).toBeNull();

    await testDb.db.execute('UPDATE app_settings SET value=? WHERE key=?', [notificationSecret[0]!.value, 'notification_secrets_cipher']);
    await testDb.db.execute('UPDATE app_settings SET value=? WHERE key=?', ['not-json', 'expire_notice_channels']);
    await request('/cron?key=test-cron-key');
    expect(wxpusherRequests).toHaveLength(0);
    domains = await testDb.db.query<{ notice_attempted_at: number | null }>(
      'SELECT notice_attempted_at FROM dns_domains WHERE name=?', ['notice.example.com'],
    );
    expect(domains[0]!.notice_attempted_at).toBeNull();

    await setExpirationNoticeChannels({
      webhook: false, wxpusher: true, telegram: false, wecom: false, dingtalk: false, feishu: false,
    });
    await request('/cron?key=test-cron-key');
    expect(wxpusherRequests).toHaveLength(1);
    domains = await testDb.db.query<{ notice_attempted_at: number | null }>(
      'SELECT notice_attempted_at FROM dns_domains WHERE name=?', ['notice.example.com'],
    );
    expect(domains[0]!.notice_attempted_at).toBeGreaterThanOrEqual(now);
  });

  it('keeps the 20-hour cooldown and audits failed notification delivery', async () => {
    await enableCron();
    await enableWxPusherNotices();
    const now = Math.floor(Date.now() / 1000);
    await setExpirationNoticeConfig('3', 9);
    await testDb.db.execute('UPDATE dns_domains SET check_status=1, checked_at=?, expires_at=NULL WHERE name=?', [now, 'example.com']);
    await addDomain('failed.example.com', now + 3 * 86_400 + 60, now, 1);
    await testDb.db.execute('UPDATE dns_domains SET notice=1 WHERE name=?', ['failed.example.com']);
    wxpusherSuccess = false;

    await request('/cron?key=test-cron-key');
    expect(wxpusherRequests).toHaveLength(1);
    const domain = await testDb.db.query<{ notice_attempted_at: number | null }>(
      'SELECT notice_attempted_at FROM dns_domains WHERE name=?', ['failed.example.com'],
    );
    expect(domain[0]!.notice_attempted_at).toBeGreaterThanOrEqual(now);
    const logs = await testDb.db.query<{ detail: string }>("SELECT detail FROM audit_logs WHERE action='domain.expiration.notice'");
    expect(logs[0]!.detail).toContain('wxpusher:failed:200');

    wxpusherSuccess = true;
    await request('/cron?key=test-cron-key');
    expect(wxpusherRequests).toHaveLength(1);
  });

  it('limits expiry reminder claims to ten domains and prevents concurrent duplicate sends', async () => {
    await enableCron();
    await enableWxPusherNotices();
    const now = Math.floor(Date.now() / 1000);
    await setExpirationNoticeConfig('7', 9);
    await testDb.db.execute('UPDATE dns_domains SET check_status=1, checked_at=?, expires_at=NULL WHERE name=?', [now, 'example.com']);
    for (let index = 0; index < 12; index += 1) {
      const name = `batch${String(index).padStart(2, '0')}.example.com`;
      await addDomain(name, now + 7 * 86_400 + index * 60, now, 1);
      await testDb.db.execute('UPDATE dns_domains SET notice=1 WHERE name=?', [name]);
    }

    await request('/cron?key=test-cron-key');
    expect(wxpusherRequests).toHaveLength(1);
    const claimedAfterFirst = await testDb.db.query<{ count: number }>(
      'SELECT COUNT(*) AS count FROM dns_domains WHERE name LIKE ? AND notice_attempted_at IS NOT NULL', ['batch%.example.com'],
    );
    expect(claimedAfterFirst[0]!.count).toBe(10);

    await Promise.all([request('/cron?key=test-cron-key'), request('/cron?key=test-cron-key')]);
    expect(wxpusherRequests).toHaveLength(2);
    const claimedAfterConcurrentRun = await testDb.db.query<{ count: number }>(
      'SELECT COUNT(*) AS count FROM dns_domains WHERE name LIKE ? AND notice_attempted_at IS NOT NULL', ['batch%.example.com'],
    );
    expect(claimedAfterConcurrentRun[0]!.count).toBe(12);
  });
});
