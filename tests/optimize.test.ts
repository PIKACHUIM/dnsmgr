import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import type { Bindings, RequestBudget } from '../src/core/types';
import { environment } from '../src/platform/runtime';
import { encrypt } from '../src/security/crypto';
import { AUTO_LINE, taskTargets } from '../src/optimize';
import { createTestDatabase } from './helpers/sqlite';

const appKey = btoa('12345678901234567890123456789012');

interface Rrset {
  name: string;
  type: string;
  ttl: number;
  records: { content: string; disabled: boolean }[];
  comments?: { content: string }[];
}

describe('Cloudflare IP optimization', () => {
  let testDb: ReturnType<typeof createTestDatabase>;
  let app: ReturnType<typeof createApp>;
  let bindings: Bindings;
  let cookie = '';
  let csrf = '';
  let rrsets: Rrset[] = [];
  let ips: string[] = [];
  let writes: string[] = [];
  let requests: string[] = [];
  let domainId = 0;

  beforeEach(async () => {
    testDb = createTestDatabase();
    app = createApp({ database: testDb.db });
    rrsets = [];
    writes = [];
    requests = [];
    ips = ['104.16.0.1', '104.16.0.2', '104.16.0.3'];
    const fetchMock = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = new URL(String(input));
      requests.push(url.href);
      const method = (init.method ?? 'GET').toUpperCase();
      const ok = (result: unknown) => new Response(JSON.stringify(result), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
      if (url.pathname.endsWith('/Cf.json')) {
        return ok({ Cf: { result: { dianxin: ips, liantong: [], yidong: [] } } });
      }
      if (url.pathname.startsWith('/api/v1/servers/localhost/zones/example.test')) {
        if (method === 'GET') return ok({ rrsets });
        if (method === 'PATCH') {
          const body = JSON.parse(String(init.body)) as { rrsets: (Rrset & { changetype: string })[] };
          for (const set of body.rrsets) {
            const index = rrsets.findIndex((entry) => entry.name === set.name && entry.type === set.type);
            if (set.changetype === 'DELETE') {
              if (index >= 0) rrsets.splice(index, 1);
              writes.push(`DELETE ${set.name} ${set.type}`);
              continue;
            }
            const next: Rrset = {
              name: set.name, type: set.type, ttl: set.ttl,
              records: set.records.map((record) => ({ content: record.content, disabled: Boolean(record.disabled) })),
              ...(set.comments ? { comments: set.comments } : {}),
            };
            if (index >= 0) rrsets[index] = next;
            else rrsets.push(next);
            writes.push(`REPLACE ${set.name} ${set.type} ${next.records.map((record) => record.content).join(',')}`);
          }
          return ok({});
        }
      }
      return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
    }) as unknown as typeof fetch;
    const budget: RequestBudget = { consume: () => {}, remainingMs: () => 30_000, fetch: fetchMock };
    bindings = {
      DB_DRIVER: 'turso', DB_FORMAT: 'sql', TURSO_DATABASE_URL: 'https://test.invalid', TURSO_AUTH_TOKEN: 'test-token',
      APP_KEY: appKey, SETUP_TOKEN: 'test-install-token-32-characters!!', BUDGET: budget,
    };
    await request('/install', {
      method: 'POST', headers: { 'content-type': 'application/json', 'X-Setup-Token': bindings.SETUP_TOKEN! },
      body: JSON.stringify({ username: 'admin', password: 'test-optimize-password!' }),
    });
    const login = await request('/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'test-optimize-password!' }),
    });
    cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    csrf = ((await login.json()) as { csrfToken: string }).csrfToken;
    await testDb.db.execute(
      "INSERT INTO dns_accounts (id,type,name,config_cipher,created_at,updated_at) VALUES (1,'powerdns','pdns','cipher',1,1)",
    );
    await testDb.db.execute(
      'UPDATE dns_accounts SET config_cipher=? WHERE id=1',
      [await encrypt(JSON.stringify({ ip: '10.0.0.1', port: '8081', apikey: 'pdns-key' }), appKey, 'dns-account/1')],
    );
    const inserted = await testDb.db.execute(
      "INSERT INTO dns_domains (account_id,name,third_id,created_at,updated_at) VALUES (1,'example.test','example.test.',1,1) RETURNING id",
    );
    domainId = Number(inserted.rows[0]!.id);
  });
  afterEach(() => testDb.close());

  function request(path: string, init: RequestInit = {}) {
    return app.request(`https://panel.example${path}`, init, environment(bindings, 'local'));
  }
  function send(path: string, method: string, body: unknown) {
    return request(path, {
      method, headers: { 'content-type': 'application/json', cookie, 'X-CSRF-Token': csrf }, body: JSON.stringify(body),
    });
  }
  function aRecords() {
    return rrsets.find((entry) => entry.type === 'A' && entry.name === 'cf.example.test')?.records.map((record) => record.content) ?? [];
  }

  it('validates optimization settings and keeps provider lines discoverable', async () => {
    const badInterval = await send('/api/v1/optimize/settings', 'PUT', { api: '2', minMinutes: 5 });
    expect(badInterval.status).toBe(400);
    expect((await badInterval.json()).reason).toBe('INVALID_OPTIMIZE_INTERVAL');

    const saved = await send('/api/v1/optimize/settings', 'PUT', { api: '2', minMinutes: 10 });
    expect(await saved.json()).toMatchObject({ code: 0, api: '2', minMinutes: 10, keyConfigured: false });

    const lines = await request(`/api/v1/optimize/lines?domainId=${domainId}`, { headers: { cookie } });
    expect(await lines.json()).toMatchObject({
      code: 0, lines: [{ id: 'default', name: '默认' }], autoLine: false,
    });
  });

  it('creates optimization tasks and reconciles A records against the preferred IP source', async () => {
    await send('/api/v1/optimize/settings', 'PUT', { api: '2', minMinutes: 10 });
    const invalid = await send('/api/v1/optimize/tasks', 'POST', {
      domainId, rr: 'bad name', recordType: 'A', ipGroup: 'CT', recordCount: 2,
    });
    expect(invalid.status).toBe(400);
    expect((await invalid.json()).reason).toBe('INVALID_OPTIMIZE_RR');

    const task = await send('/api/v1/optimize/tasks', 'POST', {
      domainId, rr: 'cf', recordType: 'A', ipGroup: 'CT', recordCount: 2, ttl: 120, line: 'default',
    });
    expect(task.status).toBe(200);
    const taskId = (await task.json() as { id: number }).id;

    const duplicate = await send('/api/v1/optimize/tasks', 'POST', {
      domainId, rr: 'cf', recordType: 'A', ipGroup: 'CT', recordCount: 2, line: 'default',
    });
    expect(duplicate.status).toBe(409);
    expect((await duplicate.json()).reason).toBe('OPTIMIZE_TASK_EXISTS');

    const first = await send(`/api/v1/optimize/tasks/${taskId}/run`, 'POST', {});
    expect(await first.json()).toMatchObject({ code: 0, ok: true });
    expect(aRecords()).toEqual(['104.16.0.1', '104.16.0.2']);

    writes = [];
    const second = await send(`/api/v1/optimize/tasks/${taskId}/run`, 'POST', {});
    expect((await second.json() as { detail: string }).detail).toContain('保持 2');
    expect(writes).toEqual([]);

    ips = ['104.16.0.9', '104.16.0.2'];
    writes = [];
    const updated = await send(`/api/v1/optimize/tasks/${taskId}/run`, 'POST', {});
    expect((await updated.json() as { detail: string }).detail).toContain('更新 1');
    expect(aRecords()).toEqual(['104.16.0.9', '104.16.0.2']);

    const patched = await send(`/api/v1/optimize/tasks/${taskId}`, 'PATCH', { recordCount: 1 });
    expect(patched.status).toBe(200);
    writes = [];
    const pruned = await send(`/api/v1/optimize/tasks/${taskId}/run`, 'POST', {});
    expect((await pruned.json() as { detail: string }).detail).toContain('删除 1');
    expect(aRecords()).toHaveLength(1);

    const listed = await request('/api/v1/optimize/tasks', { headers: { cookie } });
    expect(await listed.json()).toMatchObject({
      code: 0,
      items: [{ id: taskId, domainName: 'example.test', rr: 'cf', recordCount: 1, enabled: true, lastStatus: 'succeeded' }],
    });

    const removed = await send(`/api/v1/optimize/tasks/${taskId}`, 'DELETE', {});
    expect(removed.status).toBe(200);
  });

  it('runs at most one due task per schedule window', async () => {
    await send('/api/v1/optimize/settings', 'PUT', { api: '2', minMinutes: 10 });
    const task = await send('/api/v1/optimize/tasks', 'POST', {
      domainId, rr: 'cf', recordType: 'A', ipGroup: 'CT', recordCount: 2, line: 'default',
    });
    expect(task.status).toBe(200);

    const first = await send('/api/v1/optimize/run', 'POST', {});
    expect(await first.json()).toMatchObject({ code: 0, ran: 1 });
    const second = await send('/api/v1/optimize/run', 'POST', {});
    expect(await second.json()).toMatchObject({ code: 0, ran: 0 });
    expect(aRecords()).toHaveLength(2);
  });

  it('fetches the free source through a validated proxy', async () => {
    const invalid = await send('/api/v1/optimize/settings', 'PUT', { api: '2', proxy: 'ftp://mirror.example' });
    expect(invalid.status).toBe(400);
    expect((await invalid.json()).reason).toBe('INVALID_OPTIMIZE_PROXY');

    const saved = await send('/api/v1/optimize/settings', 'PUT', {
      api: '2', minMinutes: 10, proxy: 'https://ghfast.top/https://raw.githubusercontent.com/',
    });
    expect(await saved.json()).toMatchObject({
      code: 0, api: '2', minMinutes: 10, proxy: 'https://ghfast.top/https://raw.githubusercontent.com/',
    });

    await send('/api/v1/optimize/tasks', 'POST', {
      domainId, rr: 'cf', recordType: 'A', ipGroup: 'CT', recordCount: 1, line: 'default',
    });
    const run = await send('/api/v1/optimize/run', 'POST', {});
    expect(await run.json()).toMatchObject({ code: 0, ran: 1 });
    expect(requests.some((url) => url === 'https://ghfast.top/https://raw.githubusercontent.com/xingpingcn/enhanced-FaaS-in-China/refs/heads/main/Cf.json')).toBe(true);

    const cleared = await send('/api/v1/optimize/settings', 'PUT', { proxy: '' });
    expect(await cleared.json()).toMatchObject({ code: 0, proxy: '' });
  });

  it('removes CNAME records on the task line before writing A records', async () => {
    await send('/api/v1/optimize/settings', 'PUT', { api: '2', minMinutes: 10 });
    rrsets.push({
      name: 'cf.example.test', type: 'CNAME', ttl: 600,
      records: [{ content: 'target.example.', disabled: false }],
    });
    const task = await send('/api/v1/optimize/tasks', 'POST', {
      domainId, rr: 'cf', recordType: 'A', ipGroup: 'CT', recordCount: 2, line: 'default',
    });
    const taskId = (await task.json() as { id: number }).id;
    const run = await send(`/api/v1/optimize/tasks/${taskId}/run`, 'POST', {});
    expect(await run.json()).toMatchObject({ code: 0, ok: true });
    expect(writes).toContain('DELETE cf.example.test CNAME');
    expect(rrsets.filter((entry) => entry.type === 'CNAME')).toHaveLength(0);
    expect(aRecords().sort()).toEqual(['104.16.0.1', '104.16.0.2']);
  });

  it('rejects Cloudflare-hosted domains like the legacy panel', async () => {
    await testDb.db.execute(
      "INSERT INTO dns_accounts (id,type,name,config_cipher,created_at,updated_at) VALUES (2,'cloudflare','cf','cipher',1,1)",
    );
    const inserted = await testDb.db.execute(
      "INSERT INTO dns_domains (account_id,name,third_id,created_at,updated_at) VALUES (2,'cf-hosted.test','zone-9',1,1) RETURNING id",
    );
    const rejected = await send('/api/v1/optimize/tasks', 'POST', {
      domainId: Number(inserted.rows[0]!.id), rr: 'cf', recordType: 'A', ipGroup: 'CT', recordCount: 2, line: '0',
    });
    expect(rejected.status).toBe(400);
    expect((await rejected.json()).reason).toBe('OPTIMIZE_CLOUDFLARE_UNSUPPORTED');
  });
});

describe('optimization line targets', () => {
  const base = {
    id: 1, domain_id: 1, rr: 'cf', record_type: 'A', ip_group: 'CT', cdn_type: 1, record_count: 2,
    ttl: 600, enabled: 1, remark: null, last_run_at: null, last_status: null, last_error: null,
    created_at: 0, updated_at: 0, zone_name: 'example.test', zone_third_id: 'zone-1',
    account_id: 1, config_cipher: 'cipher',
  } as const;

  it('expands auto lines through the legacy group mapping', () => {
    expect(taskTargets({ ...base, account_type: 'aliyun', line: AUTO_LINE })).toEqual([
      { group: 'DEF', line: 'default' },
      { group: 'CT', line: 'telecom' },
      { group: 'CU', line: 'unicom' },
      { group: 'CM', line: 'mobile' },
    ]);
    expect(taskTargets({ ...base, account_type: 'huawei', line: AUTO_LINE }).map((target) => target.line))
      .toEqual(['default_view', 'Dianxin', 'Liantong', 'Yidong']);
    expect(taskTargets({ ...base, account_type: 'powerdns', line: 'default' }))
      .toEqual([{ group: 'CT', line: 'default' }]);
    expect(() => taskTargets({ ...base, account_type: 'powerdns', line: AUTO_LINE }))
      .toThrowError(/不支持自动线路/);
  });
});
