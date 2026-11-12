import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import forge from 'node-forge';
import { md5 } from 'js-md5';
import { createApp } from '../src/app';
import type { Bindings, RequestBudget } from '../src/core/types';
import type { SqlDatabase, SqlStatement, SqlValue } from '../src/storage/sql';
import { environment } from '../src/platform/runtime';
import { encrypt } from '../src/security/crypto';
import { createTestDatabase } from './helpers/sqlite';

const appKey = btoa('12345678901234567890123456789012');
const apiKey = 'acme-legacy-export-api-key';
const credentials = { username: 'admin', password: 'test-acme-password-2026!' };
const stagingOrigin = 'https://acme-staging-v02.api.letsencrypt.org';

describe('ACME schema migration', () => {
  it('preserves manually imported orders while widening source constraints with foreign keys enabled', () => {
    const sqlite = new DatabaseSync(':memory:');
    try {
      sqlite.exec('PRAGMA foreign_keys=ON');
      const beforeAcme = [
        '0001_core.sql', '0002_dns.sql', '0003_dns_aliases.sql', '0004_schedule.sql', '0005_failover.sql',
        '0006_domain_expiration_queue.sql', '0007_domain_periodic_expiration_queue.sql',
        '0008_domain_expiration_notices.sql', '0009_login_captcha.sql', '0010_certificates.sql',
      ];
      for (const migration of beforeAcme) sqlite.exec(readFileSync(new URL(`../migrations/${migration}`, import.meta.url), 'utf8'));
      sqlite.prepare('INSERT INTO users (id,username,password_hash,level,created_at) VALUES (1,?,?,2,1)').run('admin', 'test-hash');
      sqlite.prepare(`INSERT INTO cert_orders
        (id,source,status,issuer,key_type,key_size,issued_at,expires_at,fullchain_cipher,private_key_cipher,created_by,created_at,updated_at)
        VALUES (42,'manual','issued','Fixture CA','RSA',2048,1,2,'enc-chain','enc-key',1,3,4)`).run();
      sqlite.prepare('INSERT INTO cert_order_domains (order_id,domain,sort) VALUES (42,\'example.test\',0)').run();
      sqlite.exec('BEGIN IMMEDIATE');
      try {
        sqlite.exec(readFileSync(new URL('../migrations/0011_certificate_acme.sql', import.meta.url), 'utf8'));
        sqlite.exec('COMMIT');
      } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
      expect(sqlite.prepare('SELECT source,fullchain_cipher,private_key_cipher FROM cert_orders WHERE id=42').get())
        .toEqual({ source: 'manual', fullchain_cipher: 'enc-chain', private_key_cipher: 'enc-key' });
      expect(sqlite.prepare('SELECT domain FROM cert_order_domains WHERE order_id=42').get()).toEqual({ domain: 'example.test' });
      sqlite.prepare(`INSERT INTO cert_orders
        (id,source,status,issuer,key_type,key_size,issued_at,expires_at,fullchain_cipher,private_key_cipher,created_by,created_at,updated_at)
        VALUES (43,'acme','issued','Staging CA','RSA',2048,1,2,'enc-acme-chain','enc-acme-key',1,3,4)`).run();
      expect(sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally { sqlite.close(); }
  });
});
let issuedCertificate = '';
let issuerPair: forge.pki.rsa.KeyPair;
let requestedDomains: string[] = [];
let challengeTriggered = false;
let dnsRecordPresent = false;
let dnsTxtContent = '';
let failNextDnsDelete = false;
let failNextNewOrder = false;
let replayNonce = 0;
let transport: typeof fetch;
let transportCalls: string[][] = [];
let simulatedCaError = '';

function fromBase64Url(value: string): string {
  const base64 = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4);
  return forge.util.decode64(base64);
}

function acmeJson(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Replay-Nonce': `nonce-${++replayNonce}`, ...headers },
  });
}

function certificateForCsr(csrDerBase64Url: string, domains: string[]): string {
  const der = fromBase64Url(csrDerBase64Url);
  const csr = forge.pki.certificationRequestFromAsn1(forge.asn1.fromDer(der));
  const certificate = forge.pki.createCertificate();
  certificate.publicKey = csr.publicKey!;
  certificate.serialNumber = '01';
  certificate.validity.notBefore = new Date('2026-01-01T00:00:00Z');
  certificate.validity.notAfter = new Date('2027-01-01T00:00:00Z');
  certificate.setSubject([{ name: 'commonName', value: domains[0]!.replace(/^\*\./, '') }]);
  certificate.setIssuer([{ name: 'commonName', value: 'Fake ACME Test CA' }]);
  certificate.setExtensions([{ name: 'subjectAltName', altNames: domains.map((value) => ({ type: 2, value })) }]);
  certificate.sign(issuerPair.privateKey, forge.md.sha256.create());
  return forge.pki.certificateToPem(certificate);
}

function fakeFetch(): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    transportCalls.push([`${url.origin}${url.pathname}`, init?.method ?? 'GET']);
    if (url.hostname === new URL(stagingOrigin).hostname) {
      if (url.pathname === '/directory' && init?.method === 'GET') return acmeJson({
        newNonce: `${stagingOrigin}/acme/new-nonce`,
        newAccount: `${stagingOrigin}/acme/new-account`,
        newOrder: `${stagingOrigin}/acme/new-order`,
        meta: { termsOfService: 'https://letsencrypt.org/repository/' },
      });
      if (url.pathname === '/acme/new-nonce' && init?.method === 'HEAD') {
        return new Response(null, { status: 200, headers: { 'Replay-Nonce': `nonce-${++replayNonce}` } });
      }
      if (url.pathname === '/acme/new-account' && init?.method === 'POST') {
        return acmeJson({ status: 'valid' }, 201, { Location: `${stagingOrigin}/acme/acct/1` });
      }
      if (url.pathname === '/acme/new-order' && init?.method === 'POST') {
        const jws = JSON.parse(String(init.body)) as { payload: string };
        const payload = JSON.parse(fromBase64Url(jws.payload)) as { identifiers: { type: string; value: string }[] };
        requestedDomains = payload.identifiers.map((item) => item.value);
        challengeTriggered = false;
        if (failNextNewOrder) { failNextNewOrder = false; throw new Error('lost response after ACME newOrder dispatch'); }
        return acmeJson({
          status: 'pending', authorizations: [`${stagingOrigin}/acme/authz/1`], finalize: `${stagingOrigin}/acme/finalize/1`,
        }, 201, { Location: `${stagingOrigin}/acme/order/1` });
      }
      if (url.pathname === '/acme/authz/1' && init?.method === 'POST') {
        return acmeJson({
          status: challengeTriggered ? 'valid' : 'pending',
          identifier: { type: 'dns', value: requestedDomains[0]!.replace(/^\*\./, '') },
          wildcard: requestedDomains[0]!.startsWith('*.'),
          challenges: [{ type: 'dns-01', url: `${stagingOrigin}/acme/challenge/1`, token: 'dns01-test-token' }],
        });
      }
      if (url.pathname === '/acme/challenge/1' && init?.method === 'POST') {
        challengeTriggered = true;
        return acmeJson({ status: 'processing' });
      }
      if (url.pathname === '/acme/finalize/1' && init?.method === 'POST') {
        const jws = JSON.parse(String(init.body)) as { payload: string };
        const payload = JSON.parse(fromBase64Url(jws.payload)) as { csr: string };
        try { issuedCertificate = certificateForCsr(payload.csr, requestedDomains); }
        catch (error) { simulatedCaError = error instanceof Error ? error.message : String(error); throw error; }
        return acmeJson({ status: 'valid', certificate: `${stagingOrigin}/acme/cert/1` });
      }
      if (url.pathname === '/acme/cert/1' && init?.method === 'POST') {
        return new Response(issuedCertificate, { status: 200, headers: {
          'Content-Type': 'application/pem-certificate-chain', 'Replay-Nonce': `nonce-${++replayNonce}`,
        } });
      }
      return acmeJson({ type: 'urn:ietf:params:acme:error:malformed' }, 400);
    }

    if (url.hostname === 'api.cloudflare.com') {
      if (url.pathname === '/client/v4/zones/zone-acme/dns_records' && init?.method === 'POST') {
        dnsRecordPresent = true;
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        dnsTxtContent = String(body.content ?? '');
        expect(body).toMatchObject({ type: 'TXT', name: '_acme-challenge.example.test', ttl: 120, proxied: false });
        return acmeJson({ success: true, result: { id: 'record-challenge-1' } });
      }
      if (url.pathname === '/client/v4/zones/zone-acme/dns_records/record-challenge-1' && init?.method === 'DELETE') {
        if (failNextDnsDelete) { failNextDnsDelete = false; dnsRecordPresent = false; throw new Error('lost Cloudflare delete response after dispatch'); }
        dnsRecordPresent = false;
        return acmeJson({ success: true, result: { id: 'record-challenge-1' } });
      }
      if (url.pathname === '/client/v4/zones/zone-acme/dns_records' && init?.method === 'GET') {
        return acmeJson({ success: true, result: dnsRecordPresent ? [{
          id: 'record-challenge-1', name: '_acme-challenge.example.test', type: 'TXT', content: `"${dnsTxtContent}"`, ttl: 120,
        }] : [], result_info: { total_count: dnsRecordPresent ? 1 : 0 } });
      }
    }
    throw new Error(`Unexpected test fetch: ${init?.method ?? 'GET'} ${url.origin}${url.pathname}`);
  }) as unknown as typeof fetch;
}

describe('ACME staging DNS-01 issuance workflow', () => {
  let testDb: ReturnType<typeof createTestDatabase>;
  let app: ReturnType<typeof createApp>;
  let bindings: Bindings;
  let cookie: string;
  let csrf: string;
  let platform: 'local' | 'esa' = 'local';

  beforeAll(() => { issuerPair = forge.pki.rsa.generateKeyPair({ bits: 2048, workers: 0 }); });
  beforeEach(async () => {
    platform = 'local';
    testDb = createTestDatabase();
    app = createApp({ database: testDb.db });
    replayNonce = 0;
    transportCalls = [];
    simulatedCaError = '';
    requestedDomains = [];
    challengeTriggered = false;
    dnsRecordPresent = false;
    dnsTxtContent = '';
    failNextDnsDelete = false;
    failNextNewOrder = false;
    issuedCertificate = '';
    transport = fakeFetch();
    const budget: RequestBudget = { consume: () => {}, remainingMs: () => 30_000, fetch: transport };
    bindings = {
      DB_DRIVER: 'turso', DB_FORMAT: 'sql', TURSO_DATABASE_URL: 'https://test.invalid', TURSO_AUTH_TOKEN: 'test-token',
      APP_KEY: appKey, SETUP_TOKEN: 'test-install-token-32-characters!!', BUDGET: budget,
    };
    const post = (path: string, value: unknown, headers: Record<string, string> = {}) => app.request(`https://panel.example${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(value),
    }, environment(bindings, 'local'));
    await post('/install', credentials, { 'X-Setup-Token': bindings.SETUP_TOKEN! });
    const login = await post('/login', credentials);
    const session = await login.json() as { csrfToken: string };
    cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    csrf = session.csrfToken;
    const dnsCipher = await encrypt(JSON.stringify({ apikey: 'fake-cloudflare-token' }), appKey, 'dns-account/1');
    await testDb.db.execute(
      `INSERT INTO dns_accounts (id,type,name,config_cipher,created_at,updated_at) VALUES (1,'cloudflare','acme-test',?,?,?)`,
      [dnsCipher, Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000)],
    );
    await testDb.db.execute(
      `INSERT INTO dns_domains (id,account_id,name,third_id,record_count,created_at,updated_at) VALUES (1,1,'example.test','zone-acme',0,?,?)`,
      [Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000)],
    );
  });
  afterEach(() => testDb.close());

  const post = (path: string, body: unknown) => app.request(`https://panel.example${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie, 'X-CSRF-Token': csrf }, body: JSON.stringify(body),
  }, environment(bindings, platform));

  async function createReadyStagingAccount(): Promise<number> {
    const created = await post('/api/v1/cert/acme/accounts', { email: 'admin@example.test', environment: 'staging' });
    const account = await created.json() as { id: number };
    await post(`/api/v1/cert/acme/accounts/${account.id}/directory`, {});
    await post(`/api/v1/cert/acme/accounts/${account.id}/prepare-nonce`, {});
    const registered = await post(`/api/v1/cert/acme/accounts/${account.id}/register`, { agreeToTerms: true });
    expect(registered.status).toBe(200);
    return account.id;
  }

  async function createDraftOrder(accountId: number): Promise<number> {
    const created = await post('/api/v1/cert/acme/orders', {
      accountId, dnsDomainId: 1, domains: ['example.test'],
    });
    expect(created.status).toBe(200);
    return (await created.json() as { id: number }).id;
  }

  it('keeps every staging ACME issuance request within ESA four-fetch budget', async () => {
    let spent = 0;
    let budget: RequestBudget;
    budget = {
      consume() { spent += 1; if (spent > 4) throw new Error('ESA request budget exceeded'); },
      remainingMs: () => 8_000,
      fetch: async (input, init) => { budget.consume(); return transport(input, init); },
    };
    const database: SqlDatabase = {
      async query<T extends Record<string, unknown>>(sql: string, args: SqlValue[] = []) { budget.consume(); return testDb.db.query<T>(sql, args); },
      async execute(sql: string, args: SqlValue[] = []) { budget.consume(); return testDb.db.execute(sql, args); },
      async batch(statements: SqlStatement[]) { budget.consume(); return testDb.db.batch(statements); },
    };
    bindings.BUDGET = budget;
    app = createApp({ database });
    platform = 'esa';
    async function bounded(path: string, body: unknown) {
      spent = 0;
      const response = await post(path, body);
      const responseBody = await response.clone().json();
      expect(spent, `${path}: ${JSON.stringify(responseBody)}`).toBeLessThanOrEqual(4);
      return response;
    }

    const created = await bounded('/api/v1/cert/acme/accounts', { email: 'admin@example.test', environment: 'staging' });
    const account = await created.json() as { id: number };
    expect((await bounded(`/api/v1/cert/acme/accounts/${account.id}/directory`, {})).status).toBe(200);
    expect((await bounded(`/api/v1/cert/acme/accounts/${account.id}/prepare-nonce`, {})).status).toBe(200);
    expect((await bounded(`/api/v1/cert/acme/accounts/${account.id}/register`, { agreeToTerms: true })).status).toBe(200);
    const createdOrder = await bounded('/api/v1/cert/acme/orders', {
      accountId: account.id, dnsDomainId: 1, domains: ['example.test'],
    });
    const order = await createdOrder.json() as { id: number };
    const accountClaim = await testDb.db.query<{ replay_nonce: string | null; claimed_nonce: string | null }>(
      'SELECT replay_nonce,claimed_nonce FROM cert_acme_accounts WHERE id=?', [account.id],
    );
    expect(accountClaim).toEqual([{ replay_nonce: null, claimed_nonce: null }]);
    expect(await testDb.db.query<{ replay_nonce: string | null; claimed_nonce: string | null }>(
      'SELECT replay_nonce,claimed_nonce FROM cert_acme_orders WHERE id=?', [order.id],
    )).toEqual([{ replay_nonce: expect.stringMatching(/^nonce-/), claimed_nonce: null }]);
    const steps = [
      ['place', {}], ['authorize', {}], ['add-dns', {}], ['trigger', {}],
      ['poll-authorization', {}], ['cleanup-dns', {}], ['finalize', {}], ['fetch-certificate', {}],
    ] as const;
    for (const [step, body] of steps) {
      const result = await bounded(`/api/v1/cert/acme/orders/${order.id}/${step}`, body);
      expect(result.status, `${step}: ${JSON.stringify(await result.clone().json())}`).toBe(200);
    }
  });

  it('marks a lost newOrder response unknown and never retries the non-idempotent submission', async () => {
    const accountId = await createReadyStagingAccount();
    const orderId = await createDraftOrder(accountId);
    failNextNewOrder = true;
    const first = await post(`/api/v1/cert/acme/orders/${orderId}/place`, {});
    expect(first.status).toBe(503);
    expect(await first.json()).toMatchObject({ reason: 'ACME_OUTCOME_UNKNOWN' });
    expect(await testDb.db.query<{ status: string }>('SELECT status FROM cert_acme_orders WHERE id=?', [orderId]))
      .toEqual([{ status: 'outcome_unknown' }]);
    expect(transportCalls.filter((call) => call[0]?.endsWith('/acme/new-order'))).toHaveLength(1);
    await post(`/api/v1/cert/acme/orders/${orderId}/prepare-nonce`, {});
    const retry = await post(`/api/v1/cert/acme/orders/${orderId}/place`, {});
    expect(retry.status).toBe(409);
    expect(transportCalls.filter((call) => call[0]?.endsWith('/acme/new-order'))).toHaveLength(1);
  });

  it('reconciles a challenge whose delete committed before the Cloudflare response was lost', async () => {
    const accountId = await createReadyStagingAccount();
    const orderId = await createDraftOrder(accountId);
    for (const step of ['place','authorize','add-dns','trigger','poll-authorization']) {
      const response = await post(`/api/v1/cert/acme/orders/${orderId}/${step}`, {});
      expect(response.status, step).toBe(200);
    }
    expect(dnsRecordPresent).toBe(true);
    failNextDnsDelete = true;
    const cleanup = await post(`/api/v1/cert/acme/orders/${orderId}/cleanup-dns`, {});
    expect(cleanup.status).toBe(503);
    expect(await cleanup.json()).toMatchObject({ reason: 'ACME_DNS_OUTCOME_UNKNOWN' });
    expect(dnsRecordPresent).toBe(false);
    const reconciled = await post(`/api/v1/cert/acme/orders/${orderId}/reconcile-dns`, {});
    expect(reconciled.status).toBe(200);
    expect(await reconciled.json()).toMatchObject({ status: 'ready_to_finalize', found: false, cleanupComplete: true });
  });

  it('persists each ACME phase, cleans its exact TXT record, and stores an issued encrypted order', async () => {
    const createdAccount = await post('/api/v1/cert/acme/accounts', { email: 'admin@example.test', environment: 'staging' });
    expect(createdAccount.status).toBe(200);
    const account = await createdAccount.json() as { id: number; status: string };
    expect(account.status).toBe('pending_directory');

    const directory = await post(`/api/v1/cert/acme/accounts/${account.id}/directory`, {});
    expect(directory.status).toBe(200);
    expect(await directory.json()).toMatchObject({ status: 'pending_registration', termsOfService: 'https://letsencrypt.org/repository/' });
    expect((await post(`/api/v1/cert/acme/accounts/${account.id}/prepare-nonce`, {})).status).toBe(200);
    const registered = await post(`/api/v1/cert/acme/accounts/${account.id}/register`, { agreeToTerms: true });
    expect(registered.status).toBe(200);
    expect(await registered.json()).toMatchObject({ status: 'ready' });

    const orderCreated = await post('/api/v1/cert/acme/orders', {
      accountId: account.id, dnsDomainId: 1, domains: ['example.test'],
    });
    expect(orderCreated.status).toBe(200);
    const order = await orderCreated.json() as { id: number; status: string };
    expect(order.status).toBe('draft');
    const placed = await post(`/api/v1/cert/acme/orders/${order.id}/place`, {});
    expect(placed.status, JSON.stringify({ response: await placed.clone().json(), state: await testDb.db.query('SELECT status,last_error FROM cert_acme_orders'), calls: transportCalls, simulatedCaError })).toBe(200);
    expect((await post(`/api/v1/cert/acme/orders/${order.id}/authorize`, {})).status).toBe(200);
    expect((await post(`/api/v1/cert/acme/orders/${order.id}/add-dns`, {})).status).toBe(200);
    expect(dnsRecordPresent).toBe(true);
    expect((await post(`/api/v1/cert/acme/orders/${order.id}/trigger`, {})).status).toBe(200);
    expect((await post(`/api/v1/cert/acme/orders/${order.id}/poll-authorization`, {})).status).toBe(200);
    const cleanup = await post(`/api/v1/cert/acme/orders/${order.id}/cleanup-dns`, {});
    expect(cleanup.status).toBe(200);
    expect(dnsRecordPresent).toBe(false);
    expect(await cleanup.json()).toMatchObject({ status: 'ready_to_finalize' });
    const finalized = await post(`/api/v1/cert/acme/orders/${order.id}/finalize`, {});
    expect(finalized.status, JSON.stringify({ response: await finalized.clone().json(), state: await testDb.db.query('SELECT status,last_error FROM cert_acme_orders'), calls: transportCalls, simulatedCaError })).toBe(200);
    const issued = await post(`/api/v1/cert/acme/orders/${order.id}/fetch-certificate`, {});
    expect(issued.status).toBe(200);
    const result = await issued.json() as { certificateOrderId: number; status: string };
    expect(result.status).toBe('issued');

    const orders = await app.request('https://panel.example/api/v1/cert/orders', { headers: { cookie } }, environment(bindings, 'local'));
    const listing = await orders.json() as { items: { id: number; source: string; domains: string[] }[] };
    expect(listing.items).toEqual([expect.objectContaining({ id: result.certificateOrderId, source: 'acme', domains: ['example.test'] })]);
    const audit = await testDb.db.query<{ action: string; detail: string }>(
      "SELECT action,detail FROM audit_logs WHERE action LIKE 'cert.acme.%' ORDER BY id",
    );
    expect(audit.map((row) => row.action)).toEqual([
      'cert.acme.account.create', 'cert.acme.account.register', 'cert.acme.order.create',
      'cert.acme.order.placed', 'cert.acme.dns.create', 'cert.acme.dns.cleanup', 'cert.acme.order.issued',
    ]);
    expect(JSON.stringify(audit)).not.toContain('dns01-test-token');
    const stored = await testDb.db.query<{ private_key_cipher: string; fullchain_cipher: string }>(
      'SELECT private_key_cipher,fullchain_cipher FROM cert_orders WHERE id=?', [result.certificateOrderId],
    );
    expect(stored[0]!.private_key_cipher).not.toContain('BEGIN RSA PRIVATE KEY');
    expect(stored[0]!.fullchain_cipher).not.toContain('BEGIN CERTIFICATE');
  });

  it('does not overwrite a fresh in-flight replay nonce and recovers only stale claims', async () => {
    const created = await post('/api/v1/cert/acme/accounts', { email: 'admin@example.test', environment: 'staging' });
    const account = await created.json() as { id: number };
    await post(`/api/v1/cert/acme/accounts/${account.id}/directory`, {});
    await post(`/api/v1/cert/acme/accounts/${account.id}/prepare-nonce`, {});
    await testDb.db.execute(
      'UPDATE cert_acme_accounts SET replay_nonce=NULL,claimed_nonce=?,claimed_at=?,updated_at=? WHERE id=?',
      ['in-flight-test-nonce', Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000), account.id],
    );
    const beforeFresh = transportCalls.length;
    const freshClaim = await post(`/api/v1/cert/acme/accounts/${account.id}/prepare-nonce`, {});
    expect(freshClaim.status).toBe(409);
    expect(transportCalls.length).toBe(beforeFresh);
    expect(await testDb.db.query<{ claimed_nonce: string }>('SELECT claimed_nonce FROM cert_acme_accounts WHERE id=?', [account.id]))
      .toEqual([{ claimed_nonce: 'in-flight-test-nonce' }]);

    await testDb.db.execute(
      'UPDATE cert_acme_accounts SET claimed_at=?,updated_at=? WHERE id=?',
      [Math.floor(Date.now() / 1000) - 61, Math.floor(Date.now() / 1000) - 61, account.id],
    );
    const staleClaim = await post(`/api/v1/cert/acme/accounts/${account.id}/prepare-nonce`, {});
    expect(staleClaim.status).toBe(200);
    expect(await testDb.db.query<{ claimed_nonce: string | null; replay_nonce: string | null }>(
      'SELECT claimed_nonce,replay_nonce FROM cert_acme_accounts WHERE id=?', [account.id],
    )).toEqual([{ claimed_nonce: null, replay_nonce: expect.stringMatching(/^nonce-/) }]);
  });

  it('requires explicit live-CA confirmation and admin session access', async () => {
    const live = await post('/api/v1/cert/acme/accounts', {
      email: 'admin@example.test', environment: 'production', confirmProduction: false,
    });
    expect(live.status).toBe(400);
    expect(await live.json()).toMatchObject({ reason: 'ACME_PRODUCTION_CONFIRMATION_REQUIRED' });
    const badTerms = await post('/api/v1/cert/acme/accounts', { email: 'admin@example.test', environment: 'staging' });
    const account = await badTerms.json() as { id: number };
    await post(`/api/v1/cert/acme/accounts/${account.id}/directory`, {});
    const missingNonce = await post(`/api/v1/cert/acme/accounts/${account.id}/register`, { agreeToTerms: true });
    expect(missingNonce.status).toBe(409);
    expect(await missingNonce.json()).toMatchObject({ reason: 'ACME_NONCE_REQUIRED' });
    await testDb.db.execute('UPDATE users SET level=1 WHERE id=1');
    const denied = await post('/api/v1/cert/acme/accounts', { email: 'user@example.test', environment: 'staging' });
    expect(denied.status).toBe(403);
  });
});
