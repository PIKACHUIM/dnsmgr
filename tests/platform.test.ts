import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app';
import { sha256 } from '../src/security/crypto';
import cf from '../src/platform/cloudflare';
import esa from '../src/platform/esa';
import { clientIpFromMakersContext, onRequest } from '../src/platform/edgeone';
import { budgetedFetch, environment, runtime } from '../src/platform/runtime';
import type { Bindings } from '../src/core/types';
import type { D1Binding, D1Result, D1Statement, SqlDatabase, SqlValue } from '../src/storage/sql';
import { createTestDatabase } from './helpers/sqlite';

const shell = '<!doctype html><html lang="zh-CN"><title>DnsMgr test shell</title></html>';

function d1Binding(db: SqlDatabase): D1Binding {
  const prepared = (sql: string): D1Statement & { sql: string; args: SqlValue[] } => {
    const statement: D1Statement & { sql: string; args: SqlValue[] } = {
      sql,
      args: [],
      bind(...args) { statement.args = args; return statement; },
      async all(): Promise<D1Result> {
        const result = await db.execute(sql, statement.args);
        return { success: true, results: result.rows, meta: { changes: result.changes } };
      },
      async run(): Promise<D1Result> {
        const result = await db.execute(sql, statement.args);
        return { success: true, results: result.rows, meta: { changes: result.changes } };
      },
    };
    return statement;
  };
  return {
    prepare: prepared,
    async batch(statements) {
      const results = await db.batch(statements.map((statement) => {
        const prepared = statement as D1Statement & { sql: string; args: SqlValue[] };
        return { sql: prepared.sql, args: prepared.args };
      }));
      return results.map((result) => ({ success: true, results: result.rows, meta: { changes: result.changes } }));
    },
  };
}

describe('platform routing and isolation', () => {
  it.each(['cloudflare', 'edgeone', 'esa'] as const)('serves health through the real %s entry without a database', async (platform) => {
    const request = new Request('https://panel.example/health');
    const response = platform === 'cloudflare' ? await cf.fetch(request, {}) : platform === 'esa' ? await esa.fetch(request, {}, {}) : await onRequest({ request, env: {} });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ service: 'dnsmgr-serverless', stage: 'foundation' });
  });
  it('uses the trusted EdgeOne Node Function context IP, not request forwarding headers', () => {
    const request = new Request('https://panel.example/verifycode', { headers: { 'X-Forwarded-For': '198.51.100.99' } });
    expect(clientIpFromMakersContext({ request, clientIp: '203.0.113.20' })).toBe('203.0.113.20');
    expect(clientIpFromMakersContext({ request })).toBeUndefined();
    expect(clientIpFromMakersContext({ request, clientIp: '203.0.113.20, 198.51.100.99' })).toBeUndefined();
  });
  it('forwards trusted client IP through the Cloudflare, EdgeOne and ESA entrypoints', async () => {
    const testDb = createTestDatabase({ captchaEnabled: true });
    try {
      const bindings: Bindings = {
        DB_DRIVER: 'd1', DB_FORMAT: 'sql', COORDINATOR_ID: 'trusted-ip-test', DB: d1Binding(testDb.db),
      };
      const cloudflareIp = '203.0.113.10';
      const cloudflare = await cf.fetch(new Request('https://panel.example/verifycode', {
        headers: { 'CF-Connecting-IP': cloudflareIp, 'X-Forwarded-For': '198.51.100.99' },
      }), bindings);
      expect(cloudflare.status).toBe(200);

      const edgeone = await onRequest({
        request: new Request('https://panel.example/verifycode', { headers: { 'X-Forwarded-For': '198.51.100.99' } }),
        clientIp: '198.51.100.10', env: bindings,
      });
      expect(edgeone.status).toBe(200);

      const esaResponse = await esa.fetch(
        new Request('https://panel.example/verifycode', { headers: { 'X-Forwarded-For': '198.51.100.99' } }),
        { info: { remote_addr: '192.0.2.10' } }, bindings,
      );
      expect(esaResponse.status).toBe(200);
      const keys = await testDb.db.query<{ key: string }>("SELECT key FROM rate_limits WHERE key LIKE 'captcha:issue-ip:%' ORDER BY key");
      expect(keys.map((row) => row.key)).toEqual([
        `captcha:issue-ip:${await sha256(cloudflareIp)}`,
        `captcha:issue-ip:${await sha256('198.51.100.10')}`,
        `captcha:issue-ip:${await sha256('192.0.2.10')}`,
      ].sort());
    } finally {
      testDb.close();
    }
  });
  it('connects CF KV and ESA EdgeKV to their SQL coordinator without implicit fallbacks', async () => {
    const kvDatabase = createTestDatabase();
    const cfValues = new Map<string, string>();
    try {
      const cloudflare = await cf.fetch(new Request('https://panel.example/api/v1/install/status'), {
        DB_DRIVER: 'kv', DB_FORMAT: 'map', COORDINATOR_DRIVER: 'd1', COORDINATOR_ID: 'd1-test',
        PAYLOAD_STORE_ID: 'cf-kv-test', DB: d1Binding(kvDatabase.db),
        KV: { async get(key) { return cfValues.get(key) ?? null; }, async put(key, value) { cfValues.set(key, value); } },
      });
      expect(cloudflare.status).toBe(200);
      expect(await cloudflare.json()).toMatchObject({ initialized: false });

      const r2Values = new Map<string, string>();
      const r2 = await cf.fetch(new Request('https://panel.example/api/v1/install/status'), {
        DB_DRIVER: 'blob', DB_FORMAT: 'map', COORDINATOR_DRIVER: 'd1', COORDINATOR_ID: 'd1-test',
        PAYLOAD_STORE_ID: 'r2-test', DB: d1Binding(kvDatabase.db),
        BUCKET: {
          async get(key) { const value = r2Values.get(key); return value === undefined ? null : { text: async () => value }; },
          async put(key, value, options) {
            if (options.onlyIf.get('If-None-Match') !== '*' || r2Values.has(key)) return null;
            r2Values.set(key, value);
            return { key };
          },
        },
      });
      expect(r2.status).toBe(200);
      expect(await r2.json()).toMatchObject({ initialized: false });
      const unpinnedD1 = await cf.fetch(new Request('https://panel.example/api/v1/install/status'), {
        DB_DRIVER: 'd1', DB: d1Binding(kvDatabase.db),
      });
      expect(unpinnedD1.status).toBe(503);
      expect(await unpinnedD1.json()).toMatchObject({ reason: 'STORAGE_NOT_CONFIGURED' });

      const globalWithEdgeKv = globalThis as typeof globalThis & { EdgeKV?: new (options: { namespace: string }) => { get(key: string, options: { type: 'text' }): Promise<string | undefined>; put(key: string, value: string): Promise<void> } };
      const priorConstructor = globalWithEdgeKv.EdgeKV;
      const esaValues = new Map<string, string>();
      globalWithEdgeKv.EdgeKV = class {
        constructor(readonly options: { namespace: string }) {}
        async get(key: string) { return esaValues.get(key); }
        async put(key: string, value: string) { esaValues.set(key, value); }
      };
      try {
        const edgeKv = await esa.fetch(new Request('https://panel.example/api/v1/install/status'), {}, {
          DB_DRIVER: 'kv', DB_FORMAT: 'key', COORDINATOR_DRIVER: 'd1', COORDINATOR_ID: 'd1-test',
          ESA_KV_NAMESPACE: 'esa-test', DB: d1Binding(kvDatabase.db),
        });
        expect(edgeKv.status).toBe(200);
        expect(await edgeKv.json()).toMatchObject({ initialized: false });
      } finally {
        if (priorConstructor) globalWithEdgeKv.EdgeKV = priorConstructor;
        else delete globalWithEdgeKv.EdgeKV;
      }
    } finally { kvDatabase.close(); }
  });
  it.each(['/login', '/install', '/record/1000', '/cloudflare/tunnels/12', '/cert/certorder'])('serves controlled HTML at %s', async (path) => {
    const app = createApp({ shell });
    const response = await app.request(`https://panel.example${path}`, {}, environment({}, 'local'));
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(await response.text()).toBe(shell);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });
  it.each(['/api/unknown', '/quicklogin', '/unknown', '/app/sql/install.sql', '/.env', '/config/database.php', '/assets/unknown.js'])('never swallows %s with a SPA fallback', async (path) => {
    const app = createApp({ shell });
    const response = await app.request(`https://panel.example${path}`, {}, environment({}, 'local'));
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(await response.text()).not.toBe(shell);
  });
  it('fails closed for /qqbot/webhook without storage instead of serving the SPA shell', async () => {
    const app = createApp({ shell });
    const response = await app.request('https://panel.example/qqbot/webhook', {}, environment({}, 'local'));
    expect(response.status).toBe(503);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(await response.json()).toMatchObject({ code: -1, reason: 'STORAGE_NOT_CONFIGURED' });
  });
  it('never serves the SPA shell for /cron', async () => {
    const app = createApp({ shell });
    const response = await app.request('https://panel.example/cron?key=x', {}, environment({}, 'local'));
    expect(response.headers.get('content-type')).not.toContain('text/html');
    expect(await response.text()).not.toBe(shell);
  });
  it('fails closed for missing persistence and never leaks a secret', async () => {
    const app = createApp();
    const response = await app.request('https://panel.example/api/v1/install/status', {}, environment({ APP_KEY: 'should-not-leak' }, 'local'));
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('should-not-leak');
  });
  it('reads the ESA third argument rather than the context and does not enumerate a lazy env', async () => {
    const lazy = { get APP_KEY() { return 'value'; } };
    const result = environment(lazy, 'esa');
    expect(result.APP_KEY).toBe('value');
    const response = await esa.fetch(new Request('https://panel.example/api/v1/install/status'), { DB_DRIVER: 'invalid-context' }, {});
    expect(await response.json()).toMatchObject({ reason: 'STORAGE_NOT_CONFIGURED' });
  });
  it('keeps request environments separate instead of mutating shared state', () => {
    const first = environment({ APP_KEY: 'first' }, 'edgeone');
    const second = environment({ APP_KEY: 'second' }, 'esa');
    expect(first.APP_KEY).toBe('first');
    expect(second.APP_KEY).toBe('second');
    expect(first.RUNTIME.platform).toBe('edgeone');
  });
  it('limits ESA external requests and resets the budget for a new request', async () => {
    const transport = vi.fn(async () => new Response('{}'));
    const limited = budgetedFetch(runtime('esa'), transport);
    for (let request = 0; request < 4; request++) await limited('https://service.example');
    await expect(limited('https://service.example')).rejects.toThrow('子请求上限');
    expect(transport).toHaveBeenCalledTimes(4);
    await budgetedFetch(runtime('esa'), transport)('https://service.example');
    expect(transport).toHaveBeenCalledTimes(5);
  });
  it('shares the ESA four-operation budget with EdgeKV reads and writes', async () => {
    const put = vi.fn(async () => undefined);
    const bindings = environment({ KV: { async get() { return null; }, put }, ESA_KV_NAMESPACE: 'budget-test' }, 'esa');
    for (let request = 0; request < 4; request++) await bindings.KV!.get(`key-${request}`);
    await expect(bindings.KV!.put('blocked', 'value')).rejects.toThrow('子请求上限');
    expect(put).not.toHaveBeenCalled();
  });
  it('rejects oversized JSON before database work', async () => {
    const response = await createApp().request('https://panel.example/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'x'.repeat(70_000) }) }, environment({}, 'local'));
    expect(response.status).toBe(413);
  });
});
