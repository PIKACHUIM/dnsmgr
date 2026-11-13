import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app';
import type { Bindings, RequestBudget } from '../src/core/types';
import { AppError } from '../src/core/errors';
import { environment } from '../src/platform/runtime';
import { normalizeProbeTarget, normalizeProbeUrl, probeHttp, probeTcp, validateFailoverValue } from '../src/schedule/failover';
import { setTcpConnect } from '../src/net/tcp';
import { createTestDatabase } from './helpers/sqlite';

const credentials = { username: 'admin', password: 'test-password-2026!' };
const appKey = btoa('12345678901234567890123456789012');

describe('failover input validation and HTTP probe', () => {
  it('accepts public endpoints and rejects local or credential-bearing URLs', () => {
    expect(normalizeProbeUrl('https://health.example.com/status#fragment')).toBe('https://health.example.com/status');
    for (const value of [
      'http://127.0.0.1/health', 'http://10.1.2.3/', 'http://169.254.169.254/latest',
      'http://localhost/', 'http://service.internal/', 'ftp://health.example.com/',
      'https://user:pass@health.example.com/',
    ]) expect(() => normalizeProbeUrl(value)).toThrow();
  });

  it('validates public DNS targets and treats redirects as reachable without following them', async () => {
    expect(validateFailoverValue('A', '1.1.1.1')).toBe(true);
    expect(validateFailoverValue('A', '192.168.1.1')).toBe(false);
    expect(validateFailoverValue('AAAA', '2606:4700:4700::1111')).toBe(true);
    expect(validateFailoverValue('AAAA', 'fe80::1')).toBe(false);
    expect(validateFailoverValue('CNAME', 'backup.example.net')).toBe(true);
    const transport = vi.fn(async () => new Response(null, { status: 302, headers: { Location: 'http://127.0.0.1/' } })) as unknown as typeof fetch;
    const result = await probeHttp('https://health.example.com/', 2, transport);
    expect(result).toMatchObject({ ok: true, httpStatus: 302 });
    expect(transport).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ redirect: 'manual' }));
  });

  it('normalizes TCP targets and probes them through the platform adapter', async () => {
    expect(normalizeProbeTarget('tcp://health.example.com:443')).toBe('tcp://health.example.com:443');
    expect(normalizeProbeTarget('tcp://[2606:4700:4700::1111]:53')).toBe('tcp://[2606:4700:4700::1111]:53');
    for (const value of [
      'tcp://127.0.0.1:80', 'tcp://health.example.com', 'tcp://health.example.com:0',
      'tcp://health.example.com:70000', 'tcp://health.example.com:443/path',
      'tcp://user:pass@health.example.com:443',
    ]) expect(() => normalizeProbeTarget(value)).toThrow();

    const seen: [string, number][] = [];
    setTcpConnect(async (host, port) => { seen.push([host, port]); });
    expect(await probeTcp('tcp://health.example.com:443', 2)).toMatchObject({ ok: true, httpStatus: null });
    expect(seen).toEqual([['health.example.com', 443]]);

    setTcpConnect(async () => { throw new Error('connection refused'); });
    expect(await probeTcp('tcp://health.example.com:443', 2)).toMatchObject({ ok: false, error: '探测连接失败' });

    setTcpConnect(null);
    expect(await probeTcp('tcp://health.example.com:443', 2)).toMatchObject({ ok: false, error: '当前运行时不支持 TCP 探测' });
  });
});

describe('failover API', () => {
  let testDb: ReturnType<typeof createTestDatabase>;
  let app: ReturnType<typeof createApp>;
  let bindings: Bindings;
  let cookie = '';
  let csrf = '';
  let healthStatus = 503;
  let recordValue = '1.1.1.1';
  let calls: { url: string; method: string; body: string }[];
  let domainId = 0;

  beforeEach(async () => {
    testDb = createTestDatabase();
    app = createApp({ database: testDb.db });
    healthStatus = 503;
    recordValue = '1.1.1.1';
    calls = [];
    const transport: typeof fetch = async (input, init = {}) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const method = init.method ?? (input instanceof Request ? input.method : 'GET');
      const body = typeof init.body === 'string' ? init.body : '';
      calls.push({ url: url.href, method, body });
      if (url.hostname === 'health.example.com') return new Response('health', { status: healthStatus });
      const json = (payload: unknown) => new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (url.pathname === '/client/v4/zones' && method === 'GET') {
        return json({ success: true, result: [{ id: 'zone-1', name: 'example.com' }] });
      }
      if (url.pathname.endsWith('/dns_records') && method === 'GET') {
        return json({ success: true, result: [{
          id: 'r1', name: 'www.example.com', type: 'A', content: recordValue, ttl: 600, proxied: false, comment: 'production',
        }], result_info: { total_count: 1 } });
      }
      if (/\/dns_records\/r1$/.test(url.pathname) && method === 'PATCH') {
        const requestBody = JSON.parse(body) as { content?: string };
        if (requestBody.content) recordValue = requestBody.content;
        return json({ success: true, result: { id: 'r1' } });
      }
      return json({ success: true, result: { id: 'r1' } });
    };
    const budget: RequestBudget = { consume: () => {}, remainingMs: () => 30_000, fetch: transport };
    bindings = {
      DB_DRIVER: 'turso', DB_FORMAT: 'sql', TURSO_DATABASE_URL: 'https://test.invalid', TURSO_AUTH_TOKEN: 'test-token',
      APP_KEY: appKey, SETUP_TOKEN: 'test-install-token-32-characters!!', BUDGET: budget,
    };
    await post('/install', credentials, { 'X-Setup-Token': bindings.SETUP_TOKEN! });
    const login = await post('/login', credentials);
    const session = await login.json() as { csrfToken: string };
    csrf = session.csrfToken;
    cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    const accountResponse = await post('/api/v1/dns/accounts', {
      type: 'cloudflare', name: 'cf', config: { apikey: 'token' },
    }, { 'X-CSRF-Token': csrf });
    expect(accountResponse.status, await accountResponse.clone().text()).toBe(200);
    const account = await accountResponse.json() as { id: number };
    const sync = await post(`/api/v1/dns/accounts/${account.id}/sync`, { domains: [{ id: 'zone-1', name: 'example.com' }] }, { 'X-CSRF-Token': csrf });
    expect(sync.status, await sync.clone().text()).toBe(200);
    const domainsResponse = await request('/api/v1/dns/domains?page=1&pageSize=10', { headers: { cookie } });
    expect(domainsResponse.status, await domainsResponse.clone().text()).toBe(200);
    const domains = await domainsResponse.json() as { items: { id: number }[] };
    domainId = domains.items[0]!.id;
  });

  afterEach(() => { testDb.close(); setTcpConnect(null); });

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
  function newTask(overrides: Record<string, unknown> = {}) {
    return {
      domainId, recordId: 'r1', recordName: 'www', recordType: 'A',
      mainValue: '1.1.1.1', backupValue: '8.8.8.8', checkUrl: 'https://health.example.com/health',
      intervalSeconds: 30, timeoutSeconds: 5, failureThreshold: 2, ...overrides,
    };
  }

  it('encrypts the endpoint and switches/recoveries only after consecutive threshold results', async () => {
    const invalid = await post('/api/v1/failover/tasks', newTask({ checkUrl: 'http://127.0.0.1/' }));
    expect(invalid.status).toBe(400);
    expect((await invalid.json()).reason).toBe('INVALID_PROBE_URL');

    const created = await post('/api/v1/failover/tasks', newTask());
    expect(created.status).toBe(200);
    const task = await created.json() as { id: number };
    const stored = await testDb.db.query<{ check_url_cipher: string; current_backup: number }>(
      'SELECT check_url_cipher, current_backup FROM dns_failover_tasks WHERE id = ?', [task.id],
    );
    expect(stored[0]!.check_url_cipher).not.toContain('health.example.com');
    expect(stored[0]!.current_backup).toBe(0);

    const runPath = `/api/v1/failover/tasks/${task.id}/run`;
    expect(await (await post(runPath, {})).json()).toMatchObject({ checked: 1, switched: 0, failed: 1 });
    let state = await testDb.db.query<{ current_backup: number; consecutive_count: number }>(
      'SELECT current_backup, consecutive_count FROM dns_failover_tasks WHERE id = ?', [task.id],
    );
    expect(state[0]).toMatchObject({ current_backup: 0, consecutive_count: 1 });

    expect(await (await post(runPath, {})).json()).toMatchObject({ checked: 1, switched: 1, failed: 1 });
    expect(recordValue).toBe('8.8.8.8');
    state = await testDb.db.query('SELECT current_backup, consecutive_count FROM dns_failover_tasks WHERE id = ?', [task.id]);
    expect(state[0]).toMatchObject({ current_backup: 1, consecutive_count: 0 });

    healthStatus = 200;
    expect(await (await post(runPath, {})).json()).toMatchObject({ checked: 1, switched: 0, failed: 0 });
    expect(await (await post(runPath, {})).json()).toMatchObject({ checked: 1, switched: 1, failed: 0 });
    expect(recordValue).toBe('1.1.1.1');

    const logs = await (await request(`/api/v1/failover/tasks/${task.id}/logs?page=1&pageSize=10`, { headers: { cookie } })).json() as { total: number; items: { event: string }[] };
    expect(logs.total).toBe(4);
    expect(logs.items.map((item) => item.event)).toEqual(['recover_main', 'healthy', 'switch_backup', 'unhealthy']);
    expect(calls.filter((call) => call.method === 'PATCH').map((call) => JSON.parse(call.body).content)).toEqual(['8.8.8.8', '1.1.1.1']);
  });

  it('creates TCP policies only with socket support and records probe results without HTTP status', async () => {
    const unsupported = await post('/api/v1/failover/tasks', newTask({ checkUrl: 'tcp://health.example.com:443' }));
    expect(unsupported.status).toBe(400);
    expect((await unsupported.json()).reason).toBe('TCP_PROBE_UNSUPPORTED');

    const connected: [string, number][] = [];
    setTcpConnect(async (host, port) => { connected.push([host, port]); });
    const created = await post('/api/v1/failover/tasks', newTask({
      checkUrl: 'tcp://health.example.com:443', failureThreshold: 1,
    }));
    expect(created.status, await created.clone().text()).toBe(200);
    const task = await created.json() as { id: number };
    const run = await post(`/api/v1/failover/tasks/${task.id}/run`, {});
    expect(await run.json()).toMatchObject({ checked: 1, switched: 0, failed: 0 });
    expect(connected).toEqual([['health.example.com', 443]]);
    const logs = await (await request(
      `/api/v1/failover/tasks/${task.id}/logs?page=1&pageSize=10`, { headers: { cookie } },
    )).json() as { items: { event: string; http_status: number | null }[] };
    expect(logs.items[0]).toMatchObject({ event: 'healthy', http_status: null });
  });

  it('prevents duplicate policies for a DNS record and rejects invalid backup values', async () => {
    const invalid = await post('/api/v1/failover/tasks', newTask({ backupValue: '192.168.1.4' }));
    expect(invalid.status).toBe(400);
    const created = await post('/api/v1/failover/tasks', newTask());
    expect(created.status).toBe(200);
    const duplicate = await post('/api/v1/failover/tasks', newTask());
    expect(duplicate.status).toBe(409);
    expect((await duplicate.json()).reason).toBe('FAILOVER_TASK_EXISTS');
  });

  it('executes due health checks from the existing /cron endpoint', async () => {
    healthStatus = 200;
    await post('/api/v1/failover/tasks', newTask());
    const settings = await (await request('/api/v1/system/cron', { headers: { cookie } })).json() as { key: string };
    const enabled = await request('/api/v1/system/cron', {
      method: 'PUT', headers: { 'Content-Type': 'application/json', cookie, 'X-CSRF-Token': csrf },
      body: JSON.stringify({ enabled: true }),
    });
    expect(enabled.status).toBe(200);
    const cron = await request(`/cron?key=${settings.key}`);
    expect(await cron.text()).toBe('success!');
    expect(calls.some((call) => new URL(call.url).hostname === 'health.example.com')).toBe(true);
  });

  it('does not count request-budget exhaustion as a health failure and serializes manual runs', async () => {
    const created = await post('/api/v1/failover/tasks', newTask({ failureThreshold: 1 }));
    const task = await created.json() as { id: number };
    const runPath = `/api/v1/failover/tasks/${task.id}/run`;
    const originalFetch = bindings.BUDGET!.fetch;
    bindings.BUDGET!.fetch = async () => { throw new AppError(503, 'budget exhausted', 'REQUEST_BUDGET_EXCEEDED'); };
    const deferred = await (await post(runPath, {})).json() as { switched: number; failed: number };
    expect(deferred).toMatchObject({ switched: 0, failed: 1 });
    let state = await testDb.db.query<{ current_backup: number; consecutive_count: number; lease_until: number }>(
      'SELECT current_backup, consecutive_count, lease_until FROM dns_failover_tasks WHERE id = ?', [task.id],
    );
    expect(state[0]).toMatchObject({ current_backup: 0, consecutive_count: 0, lease_until: 0 });

    let releaseProbe!: (response: Response) => void;
    let signalProbeStarted!: () => void;
    const probeStarted = new Promise<void>((resolve) => { signalProbeStarted = resolve; });
    const probeResponse = new Promise<Response>((resolve) => { releaseProbe = resolve; });
    bindings.BUDGET!.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.hostname === 'health.example.com') {
        signalProbeStarted();
        return probeResponse;
      }
      return originalFetch(input, init);
    };
    const firstRun = post(runPath, {});
    await probeStarted;
    const secondRun = await post(runPath, {});
    expect(secondRun.status).toBe(409);
    expect((await secondRun.json()).reason).toBe('TASK_RUNNING');
    releaseProbe(new Response(null, { status: 503 }));
    expect(await (await firstRun).json()).toMatchObject({ checked: 1, switched: 1, failed: 1 });
    state = await testDb.db.query('SELECT current_backup, consecutive_count, lease_until FROM dns_failover_tasks WHERE id = ?', [task.id]);
    expect(state[0]).toMatchObject({ current_backup: 1, consecutive_count: 0, lease_until: 0 });
  });
});
