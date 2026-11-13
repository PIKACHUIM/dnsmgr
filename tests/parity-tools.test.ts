import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import type { Bindings } from '../src/core/types';
import { environment } from '../src/platform/runtime';
import { createTestDatabase } from './helpers/sqlite';

const credentials = { username: 'admin', password: 'test-password-2026!' };
const appKey = btoa('12345678901234567890123456789012');

describe('legacy tool parity endpoints', () => {
  let testDb: ReturnType<typeof createTestDatabase>;
  let app: ReturnType<typeof createApp>;
  let bindings: Bindings;
  let cookie = '';
  let csrf = '';
  let calls: string[];
  let optimizeReply: { status: number; body: string };

  beforeEach(async () => {
    testDb = createTestDatabase();
    app = createApp({ database: testDb.db });
    calls = [];
    optimizeReply = { status: 200, body: JSON.stringify({ code: 200, count: 42 }) };
    const transport: typeof fetch = async (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      calls.push(url.href);
      if (url.hostname === 'api.hostmonit.com' || url.hostname === 'www.wetest.vip') {
        return new Response(optimizeReply.body, { status: optimizeReply.status, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.hostname === 'api.telegram.org') return new Response(JSON.stringify({ ok: true }), { status: 200 });
      if (url.hostname === 'feishu.example') return new Response(JSON.stringify({ code: 0 }), { status: 200 });
      if (url.hostname === 'proxy.example') return new Response('proxy auth required', { status: 407 });
      if (url.hostname === 'down.example') throw new Error('connect failed');
      return new Response('unexpected', { status: 500 });
    };
    bindings = {
      DB_DRIVER: 'turso', DB_FORMAT: 'sql', TURSO_DATABASE_URL: 'https://test.invalid', TURSO_AUTH_TOKEN: 'test-token',
      APP_KEY: appKey, SETUP_TOKEN: 'test-install-token-32-characters!!', BUDGET: { consume: () => {}, remainingMs: () => 30_000, fetch: transport },
    };
    await post('/install', credentials, { 'X-Setup-Token': bindings.SETUP_TOKEN! });
    const login = await post('/login', credentials);
    const session = await login.json() as { csrfToken: string };
    csrf = session.csrfToken;
    cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  });

  afterEach(() => { testDb.close(); });

  function request(path: string, init: RequestInit = {}) {
    return app.request(`https://panel.example${path}`, init, environment(bindings, 'local'));
  }
  function post(path: string, body: unknown, extraHeaders: Record<string, string> = {}) {
    return request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie, 'X-CSRF-Token': csrf, ...extraHeaders },
      body: JSON.stringify(body),
    });
  }
  function put(path: string, body: unknown) {
    return request(path, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', cookie, 'X-CSRF-Token': csrf },
      body: JSON.stringify(body),
    });
  }
  async function seedDomain(): Promise<void> {
    await testDb.db.execute(
      'INSERT INTO dns_accounts (type,name,config_cipher,created_at,updated_at) VALUES (?,?,?,?,?)',
      ['cloudflare', 'primary', 'cipher', 1, 1],
    );
    await testDb.db.execute(
      'INSERT INTO dns_domains (account_id,name,created_at,updated_at) VALUES (?,?,?,?)', [1, 'example.com', 1, 1],
    );
  }

  it('tests one notification channel at a time and rejects unknown or unconfigured channels', async () => {
    const saved = await put('/api/v1/system/notify', {
      telegramBotToken: `123456:${'a'.repeat(30)}`, telegramChatId: '12345',
    });
    expect(saved.status, await saved.clone().text()).toBe(200);

    const unknown = await post('/api/v1/system/notify/test', { channel: 'pager' });
    expect(unknown.status).toBe(400);
    expect((await unknown.json()).reason).toBe('INVALID_NOTIFICATION_CHANNEL');

    const unconfigured = await post('/api/v1/system/notify/test', { channel: 'feishu' });
    expect(unconfigured.status).toBe(400);
    expect((await unconfigured.json()).reason).toBe('NOTIFICATION_NOT_CONFIGURED');

    const telegram = await post('/api/v1/system/notify/test', { channel: 'telegram' });
    expect(telegram.status, await telegram.clone().text()).toBe(200);
    const result = await telegram.json() as { channel: string; channels: { channel: string }[] };
    expect(result.channel).toBe('telegram');
    expect(result.channels.map((item) => item.channel)).toEqual(['telegram']);
    expect(calls.some((href) => href.includes('api.telegram.org'))).toBe(true);
  });

  it('reports the remaining credit of the configured IP source and rejects the free source', async () => {
    const credit = await post('/api/v1/optimize/credit', { api: '1', key: 'secret-key' });
    expect(credit.status, await credit.clone().text()).toBe(200);
    expect(await credit.json()).toMatchObject({ code: 0, count: 42 });
    expect(calls.some((href) => href.startsWith('https://api.hostmonit.com/get_license?license=secret-key'))).toBe(true);

    const free = await post('/api/v1/optimize/credit', { api: '2' });
    expect(free.status).toBe(400);
    expect((await free.json()).reason).toBe('OPTIMIZE_CREDIT_NOT_APPLICABLE');

    optimizeReply = { status: 200, body: JSON.stringify({ code: 400, info: '密钥无效' }) };
    const failed = await post('/api/v1/optimize/credit', { api: '0', key: 'bad' });
    expect(failed.status).toBe(502);
    expect((await failed.json()).msg).toContain('密钥无效');
  });

  it('cleans failover logs by retention days and validates the parameter', async () => {
    await seedDomain();
    await testDb.db.execute(
      `INSERT INTO dns_failover_tasks
        (domain_id,record_id,record_name,record_type,main_value,backup_value,check_url_cipher,interval_seconds,timeout_seconds,failure_threshold,line,ttl,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [1, 'r1', 'www', 'A', '1.1.1.1', '8.8.8.8', 'cipher', 30, 5, 2, '0', 600, 1, 1],
    );
    const now = Math.floor(Date.now() / 1000);
    await testDb.db.execute('INSERT INTO dns_failover_logs (task_id,event,created_at) VALUES (?,?,?)', [1, 'healthy', now - 40 * 86400]);
    await testDb.db.execute('INSERT INTO dns_failover_logs (task_id,event,created_at) VALUES (?,?,?)', [1, 'healthy', now - 3600]);

    const invalid = await post('/api/v1/failover/logs/clean', { days: -1 });
    expect(invalid.status).toBe(400);

    const cleaned = await post('/api/v1/failover/logs/clean', { days: 30 });
    expect(cleaned.status, await cleaned.clone().text()).toBe(200);
    expect(await cleaned.json()).toMatchObject({ code: 0, deleted: 1 });
    const remaining = await testDb.db.query<{ total: number }>('SELECT COUNT(*) AS total FROM dns_failover_logs');
    expect(remaining[0]!.total).toBe(1);
  });

  it('exposes cron heartbeats for failover and IP optimization', async () => {
    await seedDomain();
    const emptyFailover = await request('/dmtask/status');
    expect(emptyFailover.status).toBe(200);
    expect(await emptyFailover.text()).toBe('error');
    expect(await (await request('/optimizeip/status')).text()).toBe('error');

    const now = Math.floor(Date.now() / 1000);
    await testDb.db.execute(
      `INSERT INTO dns_failover_tasks
        (domain_id,record_id,record_name,record_type,main_value,backup_value,check_url_cipher,interval_seconds,timeout_seconds,failure_threshold,line,ttl,last_check_at,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [1, 'r1', 'www', 'A', '1.1.1.1', '8.8.8.8', 'cipher', 60, 5, 2, '0', 600, now, 1, 1],
    );
    await testDb.db.execute(
      `INSERT INTO optimize_ip_tasks (domain_id,rr,record_type,ip_group,cdn_type,record_count,ttl,line,enabled,last_run_at,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [1, 'www', 'A', 'CT', 1, 2, 600, '0', 1, now, 1, 1],
    );
    expect(await (await request('/dmtask/status')).text()).toBe('ok');
    expect(await (await request('/optimizeip/status')).text()).toBe('ok');

    await testDb.db.execute('UPDATE optimize_ip_tasks SET last_run_at=?', [now - 7200]);
    await testDb.db.execute('UPDATE dns_failover_tasks SET last_check_at=?', [now - 3600]);
    expect(await (await request('/dmtask/status')).text()).toBe('error');
    expect(await (await request('/optimizeip/status')).text()).toBe('error');
  });

  it('checks proxy reachability without claiming egress validation', async () => {
    const http = await post('/api/v1/system/proxy/test', { url: 'http://proxy.example:8080' });
    expect(http.status, await http.clone().text()).toBe(200);
    expect(await http.json()).toMatchObject({ code: 0, reachable: true, status: 407 });

    const socks = await post('/api/v1/system/proxy/test', { url: 'socks5://proxy.example:1080' });
    expect(socks.status).toBe(200);
    expect(await socks.json()).toMatchObject({ code: 0, reachable: null });

    const down = await post('/api/v1/system/proxy/test', { url: 'http://down.example:8080' });
    expect(down.status).toBe(502);
    expect((await down.json()).reason).toBe('PROXY_UNREACHABLE');

    const missing = await post('/api/v1/system/proxy/test', { url: '' });
    expect(missing.status).toBe(400);
  });

  it('stores per-purpose notification channel settings and drops disabled certificate notices', async () => {
    const defaults = await request('/api/v1/system/cert-notice', { headers: { cookie } });
    expect(defaults.status).toBe(200);
    expect((await defaults.json()).channels).toEqual({
      webhook: '1', wxpusher: '1', telegram: '1', wecom: '1', dingtalk: '1', feishu: '1', mail: '1', qqbot: '1',
    });

    const updated = await put('/api/v1/system/cert-notice', { channels: { telegram: '2', mail: '0' } });
    expect(updated.status, await updated.clone().text()).toBe(200);
    const channels = (await updated.json()).channels as Record<string, string>;
    expect(channels.telegram).toBe('2');
    expect(channels.mail).toBe('0');
    expect(channels.webhook).toBe('1');

    const failoverDefaults = await request('/api/v1/system/failover-notice', { headers: { cookie } });
    expect((await failoverDefaults.json()).channels).toMatchObject({ webhook: true, telegram: true });
    const failover = await put('/api/v1/system/failover-notice', { channels: { telegram: false, mail: '0' } });
    expect((await failover.json()).channels).toMatchObject({ telegram: false, mail: false, webhook: true });

    await put('/api/v1/system/cert-notice', {
      channels: { webhook: '0', wxpusher: '0', telegram: '0', wecom: '0', dingtalk: '0', feishu: '0', mail: '0', qqbot: '0' },
    });
    await testDb.db.execute("INSERT INTO notification_outbox (topic,title,content,created_at) VALUES ('certificate','x','y',1)");
    const flush = await post('/api/v1/system/notify/flush', {});
    expect(flush.status, await flush.clone().text()).toBe(200);
    const row = await testDb.db.query<{ sent_at: number | null; last_error: string | null }>(
      'SELECT sent_at,last_error FROM notification_outbox WHERE id=1',
    );
    expect(row[0]!.last_error).toBe('DISABLED');
    expect(row[0]!.sent_at).not.toBeNull();
  });

  it('stores the instance default skin for browsers without a local choice', async () => {
    const initial = await request('/api/v1/preferences/skin');
    expect(initial.status).toBe(200);
    expect(await initial.json()).toEqual({ code: 0, skin: 'classic' });

    const updated = await put('/api/v1/system/skin', { skin: 'tech' });
    expect(updated.status, await updated.clone().text()).toBe(200);
    expect(await (await request('/api/v1/preferences/skin')).json()).toEqual({ code: 0, skin: 'tech' });

    const invalid = await put('/api/v1/system/skin', { skin: 'neon' });
    expect(invalid.status).toBe(400);
    expect((await invalid.json()).reason).toBe('INVALID_SKIN');

    const anonymous = await request('/api/v1/preferences/skin', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ skin: 'aurora' }) });
    expect(anonymous.status).toBe(404);
  });
});
