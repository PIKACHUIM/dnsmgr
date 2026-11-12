import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { md5 } from 'js-md5';
import { createApp } from '../src/app';
import type { Bindings, RequestBudget } from '../src/core/types';
import { environment } from '../src/platform/runtime';
import { encrypt } from '../src/security/crypto';
import { createTestDatabase } from './helpers/sqlite';

const credentials = { username: 'admin', password: 'test-password-2026!' };
const appKey = btoa('12345678901234567890123456789012');
const apiKey = 'group-api-key';

function aliyunFetch() {
  const calls: URL[] = [];
  const implementation = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    calls.push(url);
    const action = url.searchParams.get('Action');
    const json = (payload: unknown) => new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (action === 'DescribeDomains') return json({ TotalCount: 0, Domains: { Domain: [] } });
    if (action === 'DescribeRecordGroups') {
      return json({ TotalCount: 1, RecordGroups: { RecordGroup: [{ GroupId: 100, GroupName: '生产', RecordCount: 2 }] } });
    }
    if (action === 'DescribeDNSSLBSubDomains') {
      return json({ TotalCount: 1, SlbSubDomains: { SlbSubDomain: [
        { SubDomain: 'www.example.com', RecordCount: 2, Line: 'default', Type: 'A', Open: true },
      ] } });
    }
    return json({ RequestId: 'req' });
  }) as unknown as typeof fetch;
  return { calls, implementation };
}

describe('DNS record groups and weights', () => {
  let testDb: ReturnType<typeof createTestDatabase>;
  let app: ReturnType<typeof createApp>;
  let bindings: Bindings;
  let calls: URL[];

  beforeEach(() => {
    testDb = createTestDatabase();
    app = createApp({ database: testDb.db });
    const transport = aliyunFetch();
    calls = transport.calls;
    const budget: RequestBudget = { consume: () => {}, remainingMs: () => 30_000, fetch: transport.implementation };
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

  async function setupAliyun() {
    await post('/install', credentials, { 'X-Setup-Token': bindings.SETUP_TOKEN! });
    const login = await post('/login', credentials);
    const body = await login.json() as { csrfToken: string };
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    const created = await (await post('/api/v1/dns/accounts', {
      type: 'aliyun', name: '阿里云主账号', config: { AccessKeyId: 'ak', AccessKeySecret: 'sk' },
    }, { cookie, 'X-CSRF-Token': body.csrfToken })).json() as { id: number };
    await post(`/api/v1/dns/accounts/${created.id}/sync`, {
      domains: [{ id: 'd1', name: 'example.com', recordCount: 2 }],
    }, { cookie, 'X-CSRF-Token': body.csrfToken });
    return { cookie, csrf: body.csrfToken, accountId: created.id };
  }

  it('lists groups, moves records and updates SLB weights through the signed provider calls', async () => {
    const { cookie, csrf } = await setupAliyun();

    const groups = await request('/api/v1/dns/domains/1/record-groups', { headers: { cookie } });
    expect(await groups.json()).toEqual({
      code: 0, items: [{ id: '100', name: '生产', count: 2 }],
    });

    const move = await post('/api/v1/dns/domains/1/records/group', {
      recordIds: ['11', '12'], groupId: '100',
    }, { cookie, 'X-CSRF-Token': csrf });
    expect(await move.json()).toEqual({ code: 0, moved: 2 });
    const change = calls.filter((url) => url.searchParams.get('Action') === 'ChangeRecordGroup').at(-1)!;
    expect(change.searchParams.get('RecordIdList')).toBe('["11","12"]');
    expect(change.searchParams.get('GroupId')).toBe('100');

    const weights = await request('/api/v1/dns/domains/1/weight-subdomains?page=1&pageSize=20&keyword=www', { headers: { cookie } });
    expect(await weights.json()).toMatchObject({
      code: 0, total: 1,
      items: [{ subdomain: 'www.example.com', rr: 'www', type: 'A', line: 'default', count: 2, enabled: true }],
    });

    const update = await post('/api/v1/dns/domains/1/weights', {
      action: 'update', subdomain: 'www.example.com', type: 'A', line: 'default', enabled: true,
      weights: { 11: 30, 12: 70 },
    }, { cookie, 'X-CSRF-Token': csrf });
    expect(await update.json()).toEqual({ code: 0, updated: 2 });
    const status = calls.filter((url) => url.searchParams.get('Action') === 'SetDNSSLBStatus').at(-1)!;
    expect(status.searchParams.get('Open')).toBe('true');
    const sent = calls.filter((url) => url.searchParams.get('Action') === 'UpdateDNSSLBWeight')
      .map((url) => [url.searchParams.get('RecordId'), url.searchParams.get('Weight')]);
    expect(sent).toEqual([['11', '30'], ['12', '70']]);

    const disable = await post('/api/v1/dns/domains/1/weights', {
      action: 'status', subdomain: 'www.example.com', type: 'A', line: 'default', enabled: false,
    }, { cookie, 'X-CSRF-Token': csrf });
    expect(await disable.json()).toEqual({ code: 0, updated: 0 });
    expect(calls.filter((url) => url.searchParams.get('Action') === 'SetDNSSLBStatus').at(-1)!.searchParams.get('Open')).toBe('false');
  });

  it('batch edits values and lines through the signed provider calls', async () => {
    const { cookie, csrf } = await setupAliyun();
    const recordinfo = [{ RecordId: '11', Name: 'www', Type: 'A', Value: '1.1.1.1', Line: 'default', TTL: 600, MX: null, Weight: null, Remark: null }];

    const valueEdit = await post('/api/v1/dns/domains/1/records/batch-edit', {
      action: 'value', type: 'AAAA', value: '::1', recordinfo,
    }, { cookie, 'X-CSRF-Token': csrf });
    expect(await valueEdit.json()).toEqual({ code: 0, success: 1, failed: 0, errors: [] });
    const updated = calls.filter((url) => url.searchParams.get('Action') === 'UpdateDomainRecord').at(-1)!;
    expect(updated.searchParams.get('Type')).toBe('AAAA');
    expect(updated.searchParams.get('Value')).toBe('::1');

    const lineEdit = await post('/api/v1/dns/domains/1/records/batch-edit', {
      action: 'line', line: 'telecom', recordinfo,
    }, { cookie, 'X-CSRF-Token': csrf });
    expect(await lineEdit.json()).toMatchObject({ code: 0, success: 1, failed: 0 });
    expect(calls.filter((url) => url.searchParams.get('Action') === 'UpdateDomainRecord').at(-1)!.searchParams.get('Line')).toBe('telecom');
  });

  it('rejects group and weight endpoints for providers without the capability', async () => {
    const { cookie, csrf } = await setupAliyun();
    await testDb.db.execute('UPDATE dns_accounts SET type = ? WHERE id = 1', ['cloudflare']);

    const groups = await request('/api/v1/dns/domains/1/record-groups', { headers: { cookie } });
    expect(groups.status).toBe(501);
    expect(await groups.json()).toMatchObject({ code: -1, reason: 'DNS_GROUP_UNSUPPORTED' });

    const weights = await request('/api/v1/dns/domains/1/weight-subdomains', { headers: { cookie } });
    expect(weights.status).toBe(501);
    expect(await weights.json()).toMatchObject({ reason: 'DNS_WEIGHT_UNSUPPORTED' });

    const move = await post('/api/v1/dns/domains/1/records/group', { recordIds: ['1'], groupId: '100' }, { cookie, 'X-CSRF-Token': csrf });
    expect(move.status).toBe(501);
  });

  it('moves records through the legacy signed batch group action', async () => {
    await setupAliyun();
    await testDb.db.execute(
      'INSERT INTO users(id,username,password_hash,level,status,is_api,apikey_cipher,permission_version,created_at) VALUES(2,?,?,2,1,1,?,1,0)',
      ['api-user', 'x', await encrypt(apiKey, appKey, 'api-key')],
    );

    const timestamp = String(Math.floor(Date.now() / 1000));
    const form = new URLSearchParams({
      uid: '2', timestamp, sign: md5('2' + timestamp + apiKey),
      action: 'group', groupid: '100',
      recordinfo: JSON.stringify([{ RecordId: '11' }, { RecordId: '12' }]),
    });
    const response = await request('/api/record/batch/1', { method: 'POST', body: form });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ code: 0, success: 2, failed: 0, msg: '成功修改2条记录的分组' });
    const change = calls.filter((url) => url.searchParams.get('Action') === 'ChangeRecordGroup').at(-1)!;
    expect(change.searchParams.get('RecordIdList')).toBe('["11","12"]');
    expect(change.searchParams.get('GroupId')).toBe('100');
  });
});
