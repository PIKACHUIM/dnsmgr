import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import type { Bindings, RequestBudget } from '../src/core/types';
import { environment } from '../src/platform/runtime';
import { encrypt } from '../src/security/crypto';
import { createTestDatabase } from './helpers/sqlite';

const appKey = btoa('12345678901234567890123456789012');

interface StoredRecord { id: string; type: string; name: string; content: string; proxied: boolean; ttl: number }

describe('Cloudflare IP optimization', () => {
  let testDb: ReturnType<typeof createTestDatabase>;
  let app: ReturnType<typeof createApp>;
  let bindings: Bindings;
  let cookie = '';
  let csrf = '';
  let records: StoredRecord[] = [];
  let ips: string[] = [];
  let writes: string[] = [];
  let domainId = 0;

  beforeEach(async () => {
    testDb = createTestDatabase();
    app = createApp({ database: testDb.db });
    records = [];
    writes = [];
    ips = ['104.16.0.1', '104.16.0.2', '104.16.0.3'];
    let sequence = 0;
    const fetchMock = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = new URL(String(input));
      const method = (init.method ?? 'GET').toUpperCase();
      if (url.hostname === 'raw.githubusercontent.com') {
        return new Response(JSON.stringify({ Cf: { result: { dianxin: ips, liantong: [], yidong: [] } } }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      const ok = (result: unknown) => new Response(JSON.stringify({ success: true, result, errors: [], result_info: { total_count: Array.isArray(result) ? result.length : 1 } }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
      const body = init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      const path = url.pathname.replace('/client/v4', '');
      if (path === '/zones/zone-1/dns_records' && method === 'GET') {
        const name = url.searchParams.get('name');
        const type = url.searchParams.get('type');
        return ok(records.filter((record) => (!name || record.name === name) && (!type || record.type === type)));
      }
      if (path === '/zones/zone-1/dns_records' && method === 'POST') {
        sequence += 1;
        const created: StoredRecord = {
          id: `rec-${sequence}`, type: String(body.type), name: String(body.name),
          content: String(body.content), proxied: body.proxied === true, ttl: Number(body.ttl),
        };
        records.push(created);
        writes.push(`POST ${created.name} ${created.content}`);
        return ok(created);
      }
      if (path.startsWith('/zones/zone-1/dns_records/')) {
        const id = path.split('/').pop()!;
        const record = records.find((entry) => entry.id === id);
        if (method === 'PATCH' && record) {
          if (body.content !== undefined) record.content = String(body.content);
          if (body.name !== undefined) record.name = String(body.name);
          if (body.ttl !== undefined) record.ttl = Number(body.ttl);
          writes.push(`PATCH ${record.name} ${record.content}`);
          return ok(record);
        }
        if (method === 'DELETE') {
          records = records.filter((entry) => entry.id !== id);
          writes.push(`DELETE ${id}`);
          return ok({ id });
        }
      }
      return new Response(JSON.stringify({ success: false, errors: [{ message: 'not found' }] }), { status: 404 });
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
      "INSERT INTO dns_accounts (id,type,name,config_cipher,created_at,updated_at) VALUES (1,'cloudflare','cf','cipher',1,1)",
    );
    await testDb.db.execute(
      'UPDATE dns_accounts SET config_cipher=? WHERE id=1',
      [await encrypt(JSON.stringify({ apikey: 'cf-token' }), appKey, 'dns-account/1')],
    );
    const inserted = await testDb.db.execute(
      "INSERT INTO dns_domains (account_id,name,third_id,created_at,updated_at) VALUES (1,'example.test','zone-1',1,1) RETURNING id",
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

  it('validates optimization settings and keeps provider lines discoverable', async () => {
    const missingKey = await send('/api/v1/optimize/settings', 'PUT', { api: '0' });
    expect(missingKey.status).toBe(400);
    expect((await missingKey.json()).reason).toBe('OPTIMIZE_KEY_REQUIRED');

    const badInterval = await send('/api/v1/optimize/settings', 'PUT', { api: '2', minMinutes: 5 });
    expect(badInterval.status).toBe(400);
    expect((await badInterval.json()).reason).toBe('INVALID_OPTIMIZE_INTERVAL');

    const saved = await send('/api/v1/optimize/settings', 'PUT', { api: '2', minMinutes: 10 });
    expect(await saved.json()).toMatchObject({ code: 0, api: '2', minMinutes: 10, keyConfigured: false });

    const lines = await request(`/api/v1/optimize/lines?domainId=${domainId}`, { headers: { cookie } });
    expect(await lines.json()).toMatchObject({
      code: 0, lines: [{ id: '0', name: '仅 DNS' }, { id: '1', name: '已代理' }],
    });
  });

  it('creates optimization tasks and reconciles A records against the preferred IP source', async () => {
    const invalid = await send('/api/v1/optimize/tasks', 'POST', {
      domainId, rr: 'bad name', recordType: 'A', ipGroup: 'CT', recordCount: 2,
    });
    expect(invalid.status).toBe(400);
    expect((await invalid.json()).reason).toBe('INVALID_OPTIMIZE_RR');

    const task = await send('/api/v1/optimize/tasks', 'POST', {
      domainId, rr: 'cf', recordType: 'A', ipGroup: 'CT', recordCount: 2, ttl: 120, line: '0',
    });
    expect(task.status).toBe(200);
    const taskId = (await task.json() as { id: number }).id;

    const duplicate = await send('/api/v1/optimize/tasks', 'POST', {
      domainId, rr: 'cf', recordType: 'A', ipGroup: 'CT', recordCount: 2, line: '0',
    });
    expect(duplicate.status).toBe(409);
    expect((await duplicate.json()).reason).toBe('OPTIMIZE_TASK_EXISTS');

    const first = await send(`/api/v1/optimize/tasks/${taskId}/run`, 'POST', {});
    expect(await first.json()).toMatchObject({ code: 0, ok: true });
    expect(records.map((record) => record.content)).toEqual(['104.16.0.1', '104.16.0.2']);
    expect(records.every((record) => record.name === 'cf.example.test' && record.type === 'A' && record.ttl === 120)).toBe(true);

    writes = [];
    const second = await send(`/api/v1/optimize/tasks/${taskId}/run`, 'POST', {});
    expect((await second.json() as { detail: string }).detail).toContain('保持 2');
    expect(writes).toEqual([]);

    ips = ['104.16.0.9', '104.16.0.2'];
    writes = [];
    const updated = await send(`/api/v1/optimize/tasks/${taskId}/run`, 'POST', {});
    expect((await updated.json() as { detail: string }).detail).toContain('更新 1');
    expect(writes).toEqual(['PATCH cf.example.test 104.16.0.9']);

    const patched = await send(`/api/v1/optimize/tasks/${taskId}`, 'PATCH', { recordCount: 1 });
    expect(patched.status).toBe(200);
    writes = [];
    const pruned = await send(`/api/v1/optimize/tasks/${taskId}/run`, 'POST', {});
    expect((await pruned.json() as { detail: string }).detail).toContain('删除 1');
    expect(records).toHaveLength(1);

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
      domainId, rr: 'cf', recordType: 'A', ipGroup: 'CT', recordCount: 2, line: '0',
    });
    expect(task.status).toBe(200);

    const first = await send('/api/v1/optimize/run', 'POST', {});
    expect(await first.json()).toMatchObject({ code: 0, ran: 1 });
    const second = await send('/api/v1/optimize/run', 'POST', {});
    expect(await second.json()).toMatchObject({ code: 0, ran: 0 });
    expect(records).toHaveLength(2);
  });
});
