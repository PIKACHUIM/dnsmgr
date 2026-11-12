import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import type { Bindings, RequestBudget } from '../src/core/types';
import { environment } from '../src/platform/runtime';
import { createTestDatabase } from './helpers/sqlite';

const appKey = btoa('12345678901234567890123456789012');

describe('CNAME proxy API', () => {
  let testDb: ReturnType<typeof createTestDatabase>;
  let app: ReturnType<typeof createApp>;
  let bindings: Bindings;
  let cookie = '';
  let csrf = '';
  let zoneId = 0;
  let proxyZoneId = 0;

  beforeEach(async () => {
    testDb = createTestDatabase();
    app = createApp({ database: testDb.db });
    const budget: RequestBudget = { consume: () => {}, remainingMs: () => 30_000, fetch };
    bindings = {
      DB_DRIVER: 'turso', DB_FORMAT: 'sql', TURSO_DATABASE_URL: 'https://test.invalid', TURSO_AUTH_TOKEN: 'test-token',
      APP_KEY: appKey, SETUP_TOKEN: 'test-install-token-32-characters!!', BUDGET: budget,
    };
    await request('/install', {
      method: 'POST', headers: { 'content-type': 'application/json', 'X-Setup-Token': bindings.SETUP_TOKEN! },
      body: JSON.stringify({ username: 'admin', password: 'test-cname-password!' }),
    });
    const login = await request('/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'test-cname-password!' }),
    });
    cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    csrf = ((await login.json()) as { csrfToken: string }).csrfToken;
    await testDb.db.execute(
      "INSERT INTO dns_accounts (id,type,name,config_cipher,created_at,updated_at) VALUES (1,'cloudflare','main','cipher',1,1)",
    );
    const main = await testDb.db.execute(
      "INSERT INTO dns_domains (account_id,name,third_id,created_at,updated_at) VALUES (1,'example.test','main-zone',1,1) RETURNING id",
    );
    zoneId = Number(main.rows[0]!.id);
    const proxy = await testDb.db.execute(
      "INSERT INTO dns_domains (account_id,name,third_id,created_at,updated_at) VALUES (1,'proxy.test','proxy-zone',1,1) RETURNING id",
    );
    proxyZoneId = Number(proxy.rows[0]!.id);
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

  it('creates, lists, updates and deletes CNAME proxies inside synced zones', async () => {
    const created = await send('/api/v1/cert/cname', 'POST', {
      domain: 'customer.test', target: '_acme-challenge.customer.test.proxy.test', remark: '外包域名',
    });
    expect(created.status).toBe(200);
    const body = await created.json() as { id: number; dnsDomainId: number; zoneName: string };
    expect(body).toMatchObject({ dnsDomainId: proxyZoneId, zoneName: 'proxy.test' });

    const invalidTarget = await send('/api/v1/cert/cname', 'POST', {
      domain: 'other.test', target: '_acme-challenge.other.test.unknown.test',
    });
    expect(invalidTarget.status).toBe(400);
    expect((await invalidTarget.json()).reason).toBe('CNAME_TARGET_ZONE_NOT_FOUND');

    const invalidDomain = await send('/api/v1/cert/cname', 'POST', {
      domain: '*.bad.test', target: '_acme-challenge.bad.proxy.test',
    });
    expect(invalidDomain.status).toBe(400);
    expect((await invalidDomain.json()).reason).toBe('INVALID_CNAME_DOMAIN');

    const duplicate = await send('/api/v1/cert/cname', 'POST', {
      domain: 'customer.test', target: '_acme-challenge.customer.proxy.test',
    });
    expect(duplicate.status).toBe(409);
    expect((await duplicate.json()).reason).toBe('CNAME_DOMAIN_EXISTS');

    const listed = await request('/api/v1/cert/cname', { headers: { cookie } });
    expect(await listed.json()).toMatchObject({
      code: 0,
      items: [{ domain: 'customer.test', target: '_acme-challenge.customer.test.proxy.test', zoneName: 'proxy.test', enabled: true }],
    });

    const updated = await send(`/api/v1/cert/cname/${body.id}`, 'PATCH', { enabled: false, remark: '暂停' });
    expect(updated.status).toBe(200);

    const removed = await send(`/api/v1/cert/cname/${body.id}`, 'DELETE', {});
    expect(removed.status).toBe(200);
    expect(await testDb.db.query('SELECT id FROM cert_cname_proxies')).toEqual([]);
  });

  it('routes ACME challenge TXT records through a proxy zone and rejects dispersed zones', async () => {
    await send('/api/v1/cert/cname', 'POST', { domain: 'customer.test', target: '_acme-challenge.customer.test.proxy.test' });
    await send('/api/v1/cert/cname', 'POST', { domain: 'other.test', target: '_acme-challenge.other.test.example.test' });
    await testDb.db.execute(
      `INSERT INTO cert_acme_accounts
        (id,directory,directory_url,email,account_key_cipher,status,created_by,created_at,updated_at,ca,kid,replay_nonce,directory_json)
       VALUES (1,'staging','https://acme-staging-v02.api.letsencrypt.org/directory','admin@example.test','cipher','ready',1,1,1,
        'letsencrypt','kid-value','nonce-value','{"newNonce":"https://acme-staging-v02.api.letsencrypt.org/acme/new-nonce"}')`,
    );

    const proxied = await send('/api/v1/cert/acme/orders', 'POST', {
      accountId: 1, dnsDomainId: zoneId, domains: ['customer.test'],
    });
    expect(proxied.status, JSON.stringify(await proxied.clone().json())).toBe(200);
    const order = await proxied.json() as { id: number };
    const stored = await testDb.db.query<{
      dns_domain_id: number; dns_zone_name: string; challenge_map_json: string;
    }>('SELECT dns_domain_id,dns_zone_name,challenge_map_json FROM cert_acme_orders WHERE id=?', [order.id]);
    expect(stored[0]).toMatchObject({ dns_domain_id: proxyZoneId, dns_zone_name: 'proxy.test' });
    expect(JSON.parse(stored[0]!.challenge_map_json)).toEqual({
      'customer.test': '_acme-challenge.customer.test.proxy.test',
    });

    await testDb.db.execute(
      `UPDATE cert_acme_accounts SET replay_nonce='nonce-value',claimed_nonce=NULL,claimed_at=NULL WHERE id=1`,
    );
    const dispersed = await send('/api/v1/cert/acme/orders', 'POST', {
      accountId: 1, dnsDomainId: zoneId, domains: ['customer.test', 'other.test'],
    });
    expect(dispersed.status).toBe(400);
    expect((await dispersed.json()).reason).toBe('ACME_MULTI_ZONE_UNSUPPORTED');

    await testDb.db.execute('UPDATE cert_cname_proxies SET enabled=0');
    await testDb.db.execute(
      `UPDATE cert_acme_accounts SET replay_nonce='nonce-value',claimed_nonce=NULL,claimed_at=NULL WHERE id=1`,
    );
    const disabled = await send('/api/v1/cert/acme/orders', 'POST', {
      accountId: 1, dnsDomainId: zoneId, domains: ['customer.test'],
    });
    expect(disabled.status).toBe(400);
    expect((await disabled.json()).reason).toBe('ACME_DNS_ZONE_MISMATCH');
  });
});
