import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import forge from 'node-forge';
import { md5 } from 'js-md5';
import { createApp } from '../src/app';
import type { Bindings, RequestBudget } from '../src/core/types';
import type { SqlDatabase, SqlStatement, SqlValue } from '../src/storage/sql';
import { environment } from '../src/platform/runtime';
import { decrypt, encrypt } from '../src/security/crypto';
import { createTestDatabase } from './helpers/sqlite';

const apiKey = 'certificate-test-api-key';
const appKey = btoa('12345678901234567890123456789012');
let fixture: { fullchain: string; privateKey: string; issuedAt: number; expiresAt: number; domains: string[] };

beforeAll(() => {
  const pair = forge.pki.rsa.generateKeyPair({ bits: 2048, workers: 0 });
  const certificate = forge.pki.createCertificate();
  certificate.publicKey = pair.publicKey;
  certificate.serialNumber = '01';
  certificate.validity.notBefore = new Date('2026-01-01T00:00:00Z');
  certificate.validity.notAfter = new Date('2035-01-01T00:00:00Z');
  certificate.setSubject([{ name: 'commonName', value: 'example.test' }]);
  certificate.setIssuer([{ name: 'commonName', value: 'Example Test Issuer' }]);
  certificate.setExtensions([{ name: 'subjectAltName', altNames: [
    { type: 2, value: 'example.test' }, { type: 2, value: 'www.example.test' },
  ] }]);
  certificate.sign(pair.privateKey, forge.md.sha256.create());
  fixture = {
    fullchain: forge.pki.certificateToPem(certificate),
    privateKey: forge.pki.privateKeyToPem(pair.privateKey),
    issuedAt: Math.floor(certificate.validity.notBefore.getTime() / 1000),
    expiresAt: Math.floor(certificate.validity.notAfter.getTime() / 1000),
    domains: ['example.test', 'www.example.test'],
  };
});

describe('certificate order API', () => {
  let testDb: ReturnType<typeof createTestDatabase>;
  let app: ReturnType<typeof createApp>;
  let bindings: Bindings;

  beforeEach(() => {
    testDb = createTestDatabase();
    app = createApp({ database: testDb.db });
    const budget: RequestBudget = { consume: () => {}, remainingMs: () => 30_000, fetch: fetch };
    bindings = {
      DB_DRIVER: 'turso', DB_FORMAT: 'sql', TURSO_DATABASE_URL: 'https://test.invalid', TURSO_AUTH_TOKEN: 'test-token',
      APP_KEY: appKey, SETUP_TOKEN: 'test-install-token-32-characters!!', BUDGET: budget,
    };
  });
  afterEach(() => testDb.close());

  const request = (path: string, init: RequestInit = {}, targetApp = app, targetBindings = bindings) =>
    targetApp.request(`https://panel.example${path}`, init, environment(targetBindings, 'local'));
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) => request(path, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
  });

  async function adminSession() {
    await post('/install', { username: 'admin', password: 'test-certificate-password!' }, { 'X-Setup-Token': bindings.SETUP_TOKEN! });
    const login = await post('/login', { username: 'admin', password: 'test-certificate-password!' });
    const body = await login.json() as { csrfToken: string };
    return { cookie: login.headers.get('set-cookie')!.split(';')[0]!, csrf: body.csrfToken };
  }

  async function importFixture(cookie: string, csrf: string) {
    return post('/api/v1/cert/orders/import', fixture, { cookie, 'X-CSRF-Token': csrf });
  }

  async function enableLegacyApi(level = 2) {
    await testDb.db.execute('UPDATE users SET level=?,is_api=1,apikey_cipher=? WHERE id=1', [level, await encrypt(apiKey, appKey, 'api-key')]);
  }

  async function legacyRead(orderId: number, sign = md5(`1${timestamp}${apiKey}`), targetApp = app, targetBindings = bindings) {
    const form = new URLSearchParams({ uid: '1', timestamp, sign, id: String(orderId) });
    return request('/api/cert/order', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form.toString(),
    }, targetApp, targetBindings);
  }

  let timestamp: string;
  beforeEach(() => { timestamp = String(Math.floor(Date.now() / 1000)); });

  it('stores an imported RSA certificate and private key encrypted and lists metadata only', async () => {
    const { cookie, csrf } = await adminSession();
    const imported = await importFixture(cookie, csrf);
    expect(imported.status).toBe(200);
    const created = await imported.json() as { code: 0; id: number };
    expect(created.id).toBeGreaterThan(0);

    const stored = await testDb.db.query<{ fullchain_cipher: string; private_key_cipher: string }>(
      'SELECT fullchain_cipher,private_key_cipher FROM cert_orders WHERE id=?', [created.id],
    );
    expect(stored[0]!.fullchain_cipher).not.toContain('BEGIN CERTIFICATE');
    expect(stored[0]!.private_key_cipher).not.toContain('BEGIN PRIVATE KEY');
    expect(await decrypt(stored[0]!.fullchain_cipher, appKey, `cert-order/${created.id}/fullchain`)).toBe(fixture.fullchain);
    expect(await decrypt(stored[0]!.private_key_cipher, appKey, `cert-order/${created.id}/private-key`)).toBe(fixture.privateKey);

    const listing = await request('/api/v1/cert/orders', { headers: { cookie } });
    const payload = await listing.json() as { items: Record<string, unknown>[] };
    expect(payload.items).toEqual([expect.objectContaining({
      id: created.id, status: 'issued', issuer: 'Example Test Issuer', keyType: 'RSA', keySize: 2048,
      issuedAt: fixture.issuedAt, expiresAt: fixture.expiresAt, domains: fixture.domains,
    })]);
    expect(JSON.stringify(payload)).not.toContain('PRIVATE KEY');
    expect(JSON.stringify(payload)).not.toContain('BEGIN CERTIFICATE');

    const downloaded = await request(`/api/v1/cert/orders/${created.id}/export`, {
      method: 'POST', headers: { cookie, 'X-CSRF-Token': csrf },
    });
    expect(downloaded.status).toBe(200);
    expect(downloaded.headers.get('content-type')).toContain('application/x-pkcs12');
    expect(downloaded.headers.get('content-disposition')).toContain(`certificate-${created.id}.p12`);
    expect(downloaded.headers.get('cache-control')).toContain('no-store');
    const binary = Array.from(new Uint8Array(await downloaded.arrayBuffer()), (byte) => String.fromCharCode(byte)).join('');
    const downloadedPfx = forge.asn1.fromDer(binary);
    expect(forge.pkcs12.pkcs12FromAsn1(downloadedPfx, false, '123456').version).toBe(3);
    const audit = await testDb.db.query<{ action: string; target: string; detail: string }>(
      "SELECT action,target,detail FROM audit_logs WHERE action='cert.order.export'",
    );
    expect(audit).toEqual([{ action: 'cert.order.export', target: String(created.id), detail: 'admin PFX download' }]);
    expect(JSON.stringify(audit)).not.toContain(fixture.privateKey);
  });

  it('returns the legacy certificate, key and password-compatible PFX only to signed administrators', async () => {
    const { cookie, csrf } = await adminSession();
    const imported = await importFixture(cookie, csrf);
    const { id } = await imported.json() as { id: number };
    await enableLegacyApi();

    const invalidSignature = await legacyRead(id, '0'.repeat(32));
    expect(invalidSignature.status).toBe(403);
    const response = await legacyRead(id);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');
    const payload = await response.json() as { code: 0; data: Record<string, unknown> };
    expect(payload.code).toBe(0);
    expect(payload.data).toMatchObject({
      id, crt: fixture.fullchain, key: fixture.privateKey, issuetime: fixture.issuedAt,
      expiretime: fixture.expiresAt, domains: fixture.domains,
    });
    const pfxBase64 = String(payload.data.pfx);
    const parsed = forge.asn1.fromDer(forge.util.decode64(pfxBase64));
    expect(forge.pkcs12.pkcs12FromAsn1(parsed, false, '123456').version).toBe(3);

    const audits = await testDb.db.query<{ action: string; target: string; detail: string }>(
      "SELECT action,target,detail FROM audit_logs WHERE action='cert.order.export'",
    );
    expect(audits).toEqual([{ action: 'cert.order.export', target: String(id), detail: 'legacy signed API export' }]);
    expect(JSON.stringify(audits)).not.toContain(fixture.privateKey);
    expect(JSON.stringify(audits)).not.toContain(pfxBase64);

    await testDb.db.execute('UPDATE users SET level=1 WHERE id=1');
    const denied = await legacyRead(id);
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ reason: 'PERMISSION_DENIED' });
  });

  it('serves legacy certificate material within the ESA fetch budget', async () => {
    const { cookie, csrf } = await adminSession();
    const imported = await importFixture(cookie, csrf);
    const { id } = await imported.json() as { id: number };
    await enableLegacyApi();
    let spent = 0;
    const budget: RequestBudget = {
      consume() { spent += 1; if (spent > 4) throw new Error('ESA fetch budget exceeded'); },
      remainingMs: () => 8_000,
      fetch: async () => { throw new Error('unexpected external request'); },
    };
    const database: SqlDatabase = {
      async query<T extends Record<string, unknown>>(sql: string, args: SqlValue[] = []) {
        budget.consume(); return testDb.db.query<T>(sql, args);
      },
      async execute(sql: string, args: SqlValue[] = []) {
        budget.consume(); return testDb.db.execute(sql, args);
      },
      async batch(statements: SqlStatement[]) {
        budget.consume(); return testDb.db.batch(statements);
      },
    };
    const esaApp = createApp({ database });
    const form = new URLSearchParams({ uid: '1', timestamp, sign: md5(`1${timestamp}${apiKey}`), id: String(id) });
    const response = await esaApp.request('https://panel.example/api/cert/order', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form.toString(),
    }, environment({ ...bindings, BUDGET: budget }, 'esa'));
    expect(response.status).toBe(200);
    expect((await response.json()).code).toBe(0);
    expect(spent).toBe(3);
    expect(spent).toBeLessThanOrEqual(4);
  });

  it('rejects a mismatched certificate key without persisting material', async () => {
    const { cookie, csrf } = await adminSession();
    const otherPair = forge.pki.rsa.generateKeyPair({ bits: 2048, workers: 0 });
    const response = await post('/api/v1/cert/orders/import', {
      ...fixture, privateKey: forge.pki.privateKeyToPem(otherPair.privateKey),
    }, { cookie, 'X-CSRF-Token': csrf });
    expect(response.status).toBe(400);
    expect(await testDb.db.query('SELECT id FROM cert_orders')).toEqual([]);
  });

  it('does not release certificate material when access auditing fails', async () => {
    const { cookie, csrf } = await adminSession();
    const imported = await importFixture(cookie, csrf);
    const { id } = await imported.json() as { id: number };
    await enableLegacyApi();
    const database: SqlDatabase = {
      async query<T extends Record<string, unknown>>(sql: string, args: SqlValue[] = []) { return testDb.db.query<T>(sql, args); },
      async execute(sql: string, args: SqlValue[] = []) {
        if (sql.startsWith('INSERT INTO audit_logs')) throw new Error('audit unavailable');
        return testDb.db.execute(sql, args);
      },
      async batch(statements: SqlStatement[]) { return testDb.db.batch(statements); },
    };
    const auditFailApp = createApp({ database });
    const response = await legacyRead(id, md5(`1${timestamp}${apiKey}`), auditFailApp);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ reason: 'CERT_EXPORT_AUDIT_FAILED' });
    expect(await testDb.db.query("SELECT id FROM audit_logs WHERE action='cert.order.export'")).toEqual([]);
  });
});
