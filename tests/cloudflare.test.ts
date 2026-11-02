import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import type { Bindings, RequestBudget } from '../src/core/types';
import { environment } from '../src/platform/runtime';
import { createTestDatabase } from './helpers/sqlite';

const credentials = { username: 'admin', password: 'test-password-2026!' };
const appKey = btoa('12345678901234567890123456789012');

describe('Cloudflare SaaS and Tunnel API', () => {
  let testDb: ReturnType<typeof createTestDatabase>;
  let app: ReturnType<typeof createApp>;
  let bindings: Bindings;
  let tunnelConfig: Record<string, unknown>;

  function transport() {
    return (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = new URL(String(input));
      const method = (init.method ?? 'GET').toUpperCase();
      const path = url.pathname.replace('/client/v4', '');
      const json = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), {
        status, headers: { 'Content-Type': 'application/json' },
      });
      const ok = (result: unknown) => json({ success: true, result, errors: [] });
      const notFound = () => json({ success: false, result: null, errors: [{ message: 'not found' }] }, 404);
      const body = init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};

      if (path === '/zones' && method === 'GET') return ok([{ id: 'zone-1', name: 'example.com', account: { id: 'acct-1' } }]);
      if (path === '/accounts' && method === 'GET') return ok([{ id: 'acct-1' }]);
      if (path === '/zones/zone-1/custom_hostnames' && method === 'GET') {
        return ok([{
          id: 'ch-1', hostname: 'app.example.com', custom_origin_server: 'origin.example.com',
          status: 'active', ssl: {
            method: 'txt', type: 'dv', status: 'active', settings: { min_tls_version: '1.2' },
            validation_records: [{ status: 'active', txt_name: '_acme-challenge.app.example.com', txt_value: 'value' }],
          },
          ownership_verification: { type: 'txt', name: '_cf-custom-hostname.app.example.com', value: 'owner', status: 'active' },
        }]);
      }
      if (path === '/zones/zone-1/custom_hostnames' && method === 'POST') {
        return ok({ id: 'ch-2', hostname: body.hostname, ssl: body.ssl });
      }
      if (path === '/zones/zone-1/custom_hostnames/ch-1' && method === 'GET') {
        return ok({ id: 'ch-1', hostname: 'app.example.com', ssl: { method: 'txt', type: 'dv', settings: { min_tls_version: '1.2' } } });
      }
      if (path.startsWith('/zones/zone-1/custom_hostnames/ch-') && (method === 'PATCH' || method === 'DELETE')) {
        return ok({ id: path.split('/').pop() });
      }
      if (path === '/zones/zone-1/custom_hostnames/fallback_origin') {
        if (method === 'GET') return ok({ origin: 'fallback.example.com' });
        if (method === 'PUT') return ok({ origin: body.origin });
        return ok({});
      }
      if (path === '/zones/zone-1/dcv_delegation/uuid') return ok({ uuid: 'dcv-uuid' });
      if (path === '/accounts/acct-1/cfd_tunnel' && method === 'GET') {
        return ok([{ id: 'tunnel-12345678', name: 'edge', status: 'healthy', connections: [{ id: 'c1' }] }]);
      }
      if (path === '/accounts/acct-1/cfd_tunnel' && method === 'POST') {
        return ok({ id: 'tunnel-12345678', name: body.name });
      }
      if (path === '/accounts/acct-1/cfd_tunnel/tunnel-12345678/token') return ok('tunnel-token');
      if (path === '/accounts/acct-1/cfd_tunnel/tunnel-12345678/configurations') {
        if (method === 'PUT') {
          tunnelConfig = (body.config ?? {}) as Record<string, unknown>;
          return ok(tunnelConfig);
        }
        return ok({ config: tunnelConfig });
      }
      if (path === '/zones/zone-1/dns_records' && method === 'GET') return ok([]);
      if (path === '/zones/zone-1/dns_records' && method === 'POST') return ok({ id: 'record-1' });
      if (path.startsWith('/zones/zone-1/dns_records/') && method === 'DELETE') return ok({ id: 'record-1' });
      if (path === '/accounts/acct-1/teamnet/routes' && method === 'GET') return ok([]);
      if (path === '/accounts/acct-1/teamnet/routes' && method === 'POST') return ok({ id: 'cidr-1' });
      if (path === '/accounts/acct-1/zerotrust/routes/hostname' && method === 'GET') return ok([]);
      if (path === '/accounts/acct-1/zerotrust/routes/hostname' && method === 'POST') return ok({ id: 'route-1' });
      return notFound();
    }) as typeof fetch;
  }

  beforeEach(() => {
    testDb = createTestDatabase();
    app = createApp({ database: testDb.db });
    tunnelConfig = { ingress: [{ service: 'http_status:404' }] };
    const budget: RequestBudget = { consume: () => {}, remainingMs: () => 30_000, fetch: transport() };
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

  async function seed() {
    await post('/install', credentials, { 'X-Setup-Token': bindings.SETUP_TOKEN! });
    const login = await post('/login', credentials);
    const { csrfToken } = await login.json() as { csrfToken: string };
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    const headers = { cookie, 'X-CSRF-Token': csrfToken };
    const account = await (await post('/api/v1/dns/accounts', {
      type: 'cloudflare', name: 'cf', config: { apikey: 'token' },
    }, headers)).json() as { id: number };
    await post(`/api/v1/dns/accounts/${account.id}/sync`, {
      domains: [{ id: 'zone-1', name: 'example.com' }],
    }, headers);
    const domains = await (await request('/api/v1/dns/domains', { headers: { cookie } })).json() as { items: { id: number }[] };
    return { cookie, csrf: csrfToken, headers, accountId: account.id, domainId: domains.items[0]!.id };
  }

  it('manages custom hostnames, fallback origin and DCV delegation', async () => {
    const { cookie, headers, domainId } = await seed();
    const list = await (await request(`/api/v1/cloudflare/domains/${domainId}/hostnames`, { headers: { cookie } })).json() as { total: number; items: Record<string, unknown>[] };
    expect(list.total).toBe(1);
    expect(list.items[0]).toMatchObject({
      id: 'ch-1', hostname: 'app.example.com', sslMethod: 'txt', sslStatus: 'active',
      ownership: { name: '_cf-custom-hostname.app.example.com', value: 'owner' },
    });

    const created = await post(`/api/v1/cloudflare/domains/${domainId}/hostnames`, {
      hostname: 'new.example.com', sslMethod: 'http', minTlsVersion: '1.3', customOriginServer: 'origin.example.com',
    }, headers);
    expect(await created.json()).toMatchObject({ code: 0, hostname: { id: 'ch-2', hostname: 'new.example.com' } });

    expect((await request(`/api/v1/cloudflare/domains/${domainId}/hostnames/ch-1`, {
      method: 'PATCH', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ minTlsVersion: '1.3' }),
    })).status).toBe(200);
    expect((await post(`/api/v1/cloudflare/domains/${domainId}/hostnames/ch-1/refresh`, {}, headers)).status).toBe(200);

    const batch = await post(`/api/v1/cloudflare/domains/${domainId}/hostnames/batch-add`, {
      hostnames: 'a.example.com\nb.example.com', sslMethod: 'txt',
    }, headers);
    expect(await batch.json()).toMatchObject({ added: 2, failed: 0 });
    expect((await post(`/api/v1/cloudflare/domains/${domainId}/hostnames/batch-delete`, { ids: ['ch-1'] }, headers)).status).toBe(200);

    expect(await (await request(`/api/v1/cloudflare/domains/${domainId}/fallback-origin`, { headers: { cookie } })).json())
      .toMatchObject({ origin: 'fallback.example.com' });
    expect((await request(`/api/v1/cloudflare/domains/${domainId}/fallback-origin`, {
      method: 'PUT', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ origin: 'http://bad' }),
    })).status).toBe(400);
    expect(await (await request(`/api/v1/cloudflare/domains/${domainId}/dcv-uuid`, { headers: { cookie } })).json())
      .toMatchObject({ uuid: 'dcv-uuid' });
  });

  it('manages tunnels, public hostnames and routes', async () => {
    const { cookie, headers, accountId } = await seed();
    const tunnels = await (await request(`/api/v1/cloudflare/accounts/${accountId}/tunnels`, { headers: { cookie } })).json() as { accountId: string; items: Record<string, unknown>[] };
    expect(tunnels).toMatchObject({ accountId: 'acct-1', items: [{ id: 'tunnel-12345678', connections: 1 }] });

    expect((await post(`/api/v1/cloudflare/accounts/${accountId}/tunnels`, { name: 'edge' }, headers)).status).toBe(200);
    expect(await (await request(`/api/v1/cloudflare/accounts/${accountId}/tunnels/tunnel-12345678/token`, { headers: { cookie } })).json())
      .toMatchObject({ token: 'tunnel-token' });

    const saved = await request(`/api/v1/cloudflare/accounts/${accountId}/tunnels/tunnel-12345678/public-hostnames`, {
      method: 'PUT', headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ hostname: 'app.example.com', service: 'http://localhost:8080' }),
    });
    expect(await saved.json()).toMatchObject({ code: 0, dns: 'created' });
    const ingress = tunnelConfig.ingress as Record<string, unknown>[];
    expect(ingress).toEqual([
      { hostname: 'app.example.com', service: 'http://localhost:8080' },
      { service: 'http_status:404' },
    ]);

    const listed = await (await request(`/api/v1/cloudflare/accounts/${accountId}/tunnels/tunnel-12345678/public-hostnames`, { headers: { cookie } })).json();
    expect(listed).toMatchObject({ items: [{ hostname: 'app.example.com', zoneName: 'example.com' }] });

    expect((await post(`/api/v1/cloudflare/accounts/${accountId}/tunnels/tunnel-12345678/cidr-routes`, { network: '10.0.0.0/33' }, headers)).status).toBe(400);
    expect((await post(`/api/v1/cloudflare/accounts/${accountId}/tunnels/tunnel-12345678/cidr-routes`, { network: '10.0.0.0/24' }, headers)).status).toBe(200);
    expect((await post(`/api/v1/cloudflare/accounts/${accountId}/tunnels/tunnel-12345678/hostname-routes`, { hostname: 'app.example.com' }, headers)).status).toBe(200);
  });
});
