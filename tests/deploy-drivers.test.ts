import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import type { Bindings, RequestBudget } from '../src/core/types';
import { environment } from '../src/platform/runtime';
import { encrypt } from '../src/security/crypto';
import { DEPLOY_META } from '../src/deploy/metadata';
import { deployCatalog, deployProvider } from '../src/deploy/registry';
import { k8s, parseKubeconfigYaml } from '../src/deploy/providers/k8s';
import { createTestDatabase } from './helpers/sqlite';

const appKey = btoa('12345678901234567890123456789012');
const fullchain = '-----BEGIN CERTIFICATE-----\nQUJD\n-----END CERTIFICATE-----\n';
const privateKey = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg3xTrCXj0RazQSz9r
Xd5v16gulGW6uJLOBIZvPc7vgcShRANCAAQ6cNxYpuZr4zH467KiDthkSJ8aw4bG
mDd38fd4NJUN982YgECCuQNvRDL5VxR6IDs4Ii4LayVpndTmZJcQR4K/
-----END PRIVATE KEY-----`;

interface RecordedCall { url: string; init: RequestInit }

describe('native deploy drivers', () => {
  let testDb: ReturnType<typeof createTestDatabase>;
  let app: ReturnType<typeof createApp>;
  let bindings: Bindings;
  let cookie = '';
  let csrf = '';
  let calls: RecordedCall[] = [];
  let panelStatus = 1;
  let tencentError = '';
  let tencentDeployFailure = false;
  const certId = 777;
  const tencentAction = (call: RecordedCall) =>
    String((call.init.headers as Record<string, string> | undefined)?.['X-TC-Action'] ?? '');

  beforeEach(async () => {
    testDb = createTestDatabase();
    calls = [];
    panelStatus = 1;
    tencentError = '';
    tencentDeployFailure = false;
    const fetchMock = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.startsWith('https://panel.example')) {
        if (url.includes('action=get_config')) {
          return new Response(JSON.stringify(panelStatus === 1 ? { status: 1, sites_path: '/www' } : { status: 0, msg: '密钥错误' }));
        }
        return new Response(JSON.stringify({ status: true }));
      }
      if (url.startsWith('https://da.example:2222')) {
        return new Response('error=0&text=ok&details=', { headers: { 'content-type': 'text/plain' } });
      }
      if (url.startsWith('https://ssl.tencentcloudapi.com')) {
        const action = (init.headers as Record<string, string>)['X-TC-Action'];
        if (tencentError && action === 'UploadCertificate') {
          return new Response(JSON.stringify({ Response: { Error: { Code: 'AuthFailure', Message: tencentError } } }));
        }
        if (action === 'UploadCertificate') {
          return new Response(JSON.stringify({ Response: { CertificateId: 'tencent-cert-1' } }));
        }
        if (action === 'DeployCertificateInstance') {
          if (tencentDeployFailure) {
            return new Response(JSON.stringify({ Response: { Error: { Code: 'FailedOperation', Message: '部署失败' } } }));
          }
          return new Response(JSON.stringify({ Response: { DeployRecordId: 1234 } }));
        }
        if (action === 'DescribeHostDeployRecordDetail') {
          return new Response(JSON.stringify({ Response: { SuccessTotalCount: 1 } }));
        }
        if (action === 'CreateCertificateBindResourceSyncTask') {
          return new Response(JSON.stringify({ Response: { CertTaskIds: [{ TaskId: 'sync-task-1' }] } }));
        }
        if (action === 'DescribeCertificateBindResourceTaskResult') {
          return new Response(JSON.stringify({ Response: { SyncTaskBindResourceResult: [{
            Status: 1,
            BindResourceResult: [{ ResourceType: 'clb', BindResourceRegionResult: [
              { Region: 'ap-guangzhou', TotalCount: 2 },
              { Region: 'ap-shanghai', TotalCount: 0 },
            ] }],
          }] } }));
        }
        if (action === 'UploadUpdateCertificateInstance') {
          return new Response(JSON.stringify({ Response: { DeployStatus: 1 } }));
        }
        if (action === 'UpdateCertificateInstance') {
          return new Response(JSON.stringify({ Response: { DeployRecordId: 7788 } }));
        }
        if (action === 'DescribeCertificates') {
          return new Response(JSON.stringify({ Response: { Certificates: [{
            CertificateId: 'tencent-cert-new', Domain: 'web.example.test', Status: 1, CertEndTime: '2030-01-01T00:00:00Z',
          }] } }));
        }
        return new Response(JSON.stringify({ Response: {} }));
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;
    const budget: RequestBudget = { consume: () => {}, remainingMs: () => 30_000, fetch: fetchMock };
    bindings = {
      DB_DRIVER: 'turso', DB_FORMAT: 'sql', TURSO_DATABASE_URL: 'https://test.invalid', TURSO_AUTH_TOKEN: 'test-token',
      APP_KEY: appKey, SETUP_TOKEN: 'test-install-token-32-characters!!', BUDGET: budget,
    };
    app = createApp({ database: testDb.db });
    await request('/install', {
      method: 'POST', headers: { 'content-type': 'application/json', 'X-Setup-Token': bindings.SETUP_TOKEN! },
      body: JSON.stringify({ username: 'admin', password: 'test-deploy-password!' }),
    });
    const login = await request('/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'test-deploy-password!' }),
    });
    cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    csrf = ((await login.json()) as { csrfToken: string }).csrfToken;
    await testDb.db.batch([
      {
        sql: `INSERT INTO cert_orders
          (id,source,status,issuer,key_type,key_size,issued_at,expires_at,fullchain_cipher,private_key_cipher,created_by,created_at,updated_at,is_auto)
          VALUES (?,'manual','issued','Test Issuer','RSA',2048,1000,2000,?,?,1,1000,1000,0)`,
        args: [certId, await encrypt(fullchain, appKey, `cert-order/${certId}/fullchain`),
          await encrypt(privateKey, appKey, `cert-order/${certId}/private-key`)],
      },
      { sql: 'INSERT INTO cert_order_domains (order_id,domain,sort) VALUES (?,?,0)', args: [certId, 'web.example.test'] },
    ]);
  });
  afterEach(() => testDb.close());

  function request(path: string, init: RequestInit = {}) {
    return app.request(`https://panel.app${path}`, init, environment(bindings, 'local'));
  }
  function send(path: string, method: string, body: unknown) {
    return request(path, {
      method, headers: { 'content-type': 'application/json', cookie, 'X-CSRF-Token': csrf }, body: JSON.stringify(body),
    });
  }
  async function createAccount(body: Record<string, unknown>): Promise<number> {
    const response = await send('/api/v1/cert/deploy/accounts', 'POST', body);
    expect(response.status, JSON.stringify(await response.clone().json())).toBe(200);
    return (await response.json() as { id: number }).id;
  }
  async function createTask(body: Record<string, unknown>): Promise<number> {
    const response = await send('/api/v1/cert/deploy/tasks', 'POST', body);
    expect(response.status, JSON.stringify(await response.clone().json())).toBe(200);
    return (await response.json() as { id: number }).id;
  }

  it('exposes the driver catalog with account and task fields', async () => {
    const response = await request('/api/v1/cert/deploy/providers', { headers: { cookie } });
    expect(response.status).toBe(200);
    const { providers } = await response.json() as { providers: { type: string; fields: { key: string }[]; taskFields: { key: string; options?: { value: string; label: string }[] }[] }[] };
    const types = providers.map((provider) => provider.type);
    expect(types.slice(0, 2)).toEqual(['webhook', 'executor']);
    expect(types).toContain('btpanel');
    expect(types).toContain('tencent');
    const btpanel = providers.find((provider) => provider.type === 'btpanel')!;
    expect(btpanel.fields.map((field) => field.key)).toEqual(['url', 'key']);
    expect(btpanel.taskFields.map((field) => field.key)).toEqual(['type', 'sites']);
    const tencent = providers.find((provider) => provider.type === 'tencent')!;
    expect(tencent.taskFields.map((field) => field.key)).toContain('product');
    const products = tencent.taskFields.find((field) => field.key === 'product')!.options!;
    expect(products.map((option) => option.value)).toEqual([
      'cdn', 'teo', 'waf', 'cos', 'clb', 'tke', 'scf', 'ddos', 'live', 'vod',
      'tse', 'tcb', 'lighthouse', 'upload', 'update', 'update_new',
    ]);
    expect(products.every((option) => Boolean(option.label) && option.label !== '[object Object]')).toBe(true);
    expect(tencent.taskFields.find((field) => field.key === 'site_type')!.options)
      .toEqual([{ value: 'cn', label: '国内站' }, { value: 'intl', label: '国际站' }]);
    expect(tencent.taskFields.find((field) => field.key === 'region')!.options)
      .toEqual([{ value: 'ap-guangzhou', label: '中国大陆' }, { value: 'ap-seoul', label: '非中国大陆' }]);
  });

  it('validates panel credentials before saving and deploys to every listed site', async () => {
    const missing = await send('/api/v1/cert/deploy/accounts', 'POST', { name: 'panel', type: 'btpanel' });
    expect(missing.status).toBe(400);
    expect((await missing.json()).reason).toBe('INVALID_DEPLOY_CONFIG');

    panelStatus = 0;
    const rejected = await send('/api/v1/cert/deploy/accounts', 'POST', {
      name: 'panel', type: 'btpanel', url: 'https://panel.example', key: 'panel-key',
    });
    expect(rejected.status).toBe(400);
    expect((await rejected.json()).reason).toBe('DEPLOY_ACCOUNT_CHECK_FAILED');

    panelStatus = 1;
    const accountId = await createAccount({ name: 'panel', type: 'btpanel', url: 'https://panel.example', key: 'panel-key' });
    const accountRow = await testDb.db.query<{ config_cipher: string }>('SELECT config_cipher FROM cert_deploy_accounts WHERE id=?', [accountId]);
    expect(accountRow[0]!.config_cipher).not.toContain('panel-key');
    const checkCall = calls.find((call) => call.url.includes('action=get_config'))!;
    const checkBody = new URLSearchParams(String(checkCall.init.body));
    expect(checkBody.get('request_time')).toMatch(/^\d+$/);
    expect(checkBody.get('request_token')).toMatch(/^[0-9a-f]{32}$/);

    const invalidTask = await send('/api/v1/cert/deploy/tasks', 'POST', {
      name: 'site', accountId, certificateOrderId: certId, config: { type: '0' },
    });
    expect(invalidTask.status).toBe(400);
    expect((await invalidTask.json()).reason).toBe('INVALID_DEPLOY_CONFIG');

    const taskId = await createTask({
      name: 'site', accountId, certificateOrderId: certId, config: { type: '0', sites: 'a.example.test\nb.example.test' },
    });
    const taskRow = await testDb.db.query<{ config_json: string }>('SELECT config_json FROM cert_deploy_tasks WHERE id=?', [taskId]);
    expect(JSON.parse(taskRow[0]!.config_json)).toEqual({ type: '0', sites: 'a.example.test\nb.example.test' });

    calls = [];
    const run = await send(`/api/v1/cert/deploy/tasks/${taskId}/run`, 'POST', {});
    const result = await run.json() as { ok: boolean; detail: string };
    expect(result.ok).toBe(true);
    expect(result.detail).toContain('a.example.test');
    const siteCalls = calls.filter((call) => call.url.includes('/site?action=SetSSL'));
    expect(siteCalls).toHaveLength(2);
    expect(String(siteCalls[0]!.init.body)).toContain('siteName=a.example.test');
    expect(String(siteCalls[1]!.init.body)).toContain('siteName=b.example.test');
  });

  it('uploads to Tencent Cloud and deploys to the selected product instance', async () => {
    const accountId = await createAccount({
      name: 'tencent', type: 'tencent', SecretId: 'AKIDtest', SecretKey: 'secret-value',
    });
    const taskId = await createTask({
      name: 'cdn', accountId, certificateOrderId: certId, config: { product: 'cdn', domain: 'web.example.test,api.example.test' },
    });

    calls = [];
    const run = await send(`/api/v1/cert/deploy/tasks/${taskId}/run`, 'POST', {});
    const result = await run.json() as { ok: boolean; detail: string };
    expect(result.ok, result.detail).toBe(true);

    const upload = calls.find((call) => (call.init.headers as Record<string, string>)['X-TC-Action'] === 'UploadCertificate')!;
    const authorization = (upload.init.headers as Record<string, string>).authorization;
    expect(authorization).toMatch(/^TC3-HMAC-SHA256 Credential=AKIDtest\/\d{4}-\d{2}-\d{2}\/ssl\/tc3_request, SignedHeaders=content-type;host, Signature=[0-9a-f]{64}$/);
    const deploy = calls.find((call) => (call.init.headers as Record<string, string>)['X-TC-Action'] === 'DeployCertificateInstance')!;
    const payload = JSON.parse(String(deploy.init.body)) as Record<string, unknown>;
    expect(payload).toMatchObject({
      CertificateId: 'tencent-cert-1', ResourceType: 'cdn',
      InstanceIdList: ['web.example.test|on', 'api.example.test|on'],
    });
    const state = await testDb.db.query<{ info_json: string }>('SELECT info_json FROM cert_deploy_tasks WHERE id=?', [taskId]);
    expect(JSON.parse(state[0]!.info_json)).toEqual({ cert_id: 'tencent-cert-1', record_id: '1234' });

    tencentError = '鉴权失败';
    calls = [];
    const failed = await send(`/api/v1/cert/deploy/tasks/${taskId}/run`, 'POST', {});
    expect((await failed.json()).ok).toBe(false);
    const runs = await testDb.db.query<{ status: string; detail: string }>('SELECT status,detail FROM cert_deploy_runs ORDER BY id DESC LIMIT 1');
    expect(runs[0]).toMatchObject({ status: 'failed', detail: '鉴权失败' });
  });

  it('updates a Tencent certificate in place for product=update', async () => {
    const accountId = await createAccount({
      name: 'tencent-update', type: 'tencent', SecretId: 'AKIDtest', SecretKey: 'secret-value',
    });
    const taskId = await createTask({
      name: 'update', accountId, certificateOrderId: certId,
      config: { product: 'update', cert_id: 'tencent-cert-old' },
    });

    calls = [];
    const result = await (await send(`/api/v1/cert/deploy/tasks/${taskId}/run`, 'POST', {})).json() as { ok: boolean; detail: string };
    expect(result.ok, result.detail).toBe(true);
    const actions = calls.map(tencentAction);
    expect(actions).not.toContain('UploadCertificate');
    expect(actions).toContain('CreateCertificateBindResourceSyncTask');
    expect(actions).toContain('DescribeCertificateBindResourceTaskResult');

    const update = calls.find((call) => tencentAction(call) === 'UploadUpdateCertificateInstance')!;
    const payload = JSON.parse(String(update.init.body)) as Record<string, unknown>;
    expect(payload).toMatchObject({
      OldCertificateId: 'tencent-cert-old',
      ResourceTypes: ['clb'],
      ResourceTypesRegions: [{ ResourceType: 'clb', Regions: ['ap-guangzhou'] }],
    });
    expect(String(payload.CertificatePublicKey)).toBe(fullchain);
    expect(String(payload.CertificatePrivateKey)).toContain('BEGIN PRIVATE KEY');
    const state = await testDb.db.query<{ info_json: string }>('SELECT info_json FROM cert_deploy_tasks WHERE id=?', [taskId]);
    expect(JSON.parse(state[0]!.info_json)).toEqual({});
  });

  it('rotates the Tencent certificate id for product=update_new and honours delete_old_cert', async () => {
    const accountId = await createAccount({
      name: 'tencent-rotate', type: 'tencent', SecretId: 'AKIDtest', SecretKey: 'secret-value',
    });
    const taskId = await createTask({
      name: 'rotate', accountId, certificateOrderId: certId,
      config: { product: 'update_new', cert_id: 'tencent-cert-old', delete_old_cert: true },
    });

    calls = [];
    const result = await (await send(`/api/v1/cert/deploy/tasks/${taskId}/run`, 'POST', {})).json() as { ok: boolean; detail: string };
    expect(result.ok, result.detail).toBe(true);
    const update = calls.find((call) => tencentAction(call) === 'UpdateCertificateInstance')!;
    expect(JSON.parse(String(update.init.body))).toMatchObject({
      OldCertificateId: 'tencent-cert-old',
      ResourceTypes: ['clb'],
      ResourceTypesRegions: [{ ResourceType: 'clb', Regions: ['ap-guangzhou'] }],
    });
    const deletion = calls.find((call) => tencentAction(call) === 'DeleteCertificate')!;
    expect(JSON.parse(String(deletion.init.body))).toEqual({ CertificateId: 'tencent-cert-old' });

    const rows = await testDb.db.query<{ config_json: string }>('SELECT config_json FROM cert_deploy_tasks WHERE id=?', [taskId]);
    expect(JSON.parse(rows[0]!.config_json)).toEqual({
      product: 'update_new', cert_id: 'tencent-cert-new', delete_old_cert: '1',
    });
  });

  it('treats a repeated Tencent deployment as done when the previous record succeeded', async () => {
    const accountId = await createAccount({
      name: 'tencent-retry', type: 'tencent', SecretId: 'AKIDtest', SecretKey: 'secret-value',
    });
    const taskId = await createTask({
      name: 'cdn-retry', accountId, certificateOrderId: certId, config: { product: 'cdn', domain: 'web.example.test' },
    });
    await testDb.db.execute('UPDATE cert_deploy_tasks SET info_json=? WHERE id=?', [JSON.stringify({ record_id: '1234' }), taskId]);

    tencentDeployFailure = true;
    calls = [];
    const result = await (await send(`/api/v1/cert/deploy/tasks/${taskId}/run`, 'POST', {})).json() as { ok: boolean; detail: string };
    expect(result.ok, result.detail).toBe(true);
    expect(result.detail).toContain('无需重复部署');
    expect(calls.some((call) => tencentAction(call) === 'DescribeHostDeployRecordDetail')).toBe(true);
    const state = await testDb.db.query<{ info_json: string }>('SELECT info_json FROM cert_deploy_tasks WHERE id=?', [taskId]);
    expect(JSON.parse(state[0]!.info_json)).toEqual({ cert_id: 'tencent-cert-1', record_id: '1234' });
  });

  it('provides a native driver for every catalog entry', () => {
    const types = deployCatalog().map((meta) => meta.type);
    const builtins = new Set(['webhook', 'executor']);
    for (const type of Object.keys(DEPLOY_META)) {
      expect(deployProvider(type), `缺少驱动实现：${type}`).toBeDefined();
      expect(types).toContain(type);
    }
    for (const provider of deployCatalog()) {
      if (builtins.has(provider.type)) continue;
      expect(DEPLOY_META[provider.type], `未登记字段定义：${provider.type}`).toBeDefined();
    }
  });

  it('deploys to DirectAdmin through the official CMD_API_SSL endpoint', async () => {
    const accountId = await createAccount({
      name: 'da', type: 'directadmin', url: 'https://da.example:2222', username: 'admin', password: 'da-password',
    });
    const taskId = await createTask({
      name: 'da-site', accountId, certificateOrderId: certId, config: { domain: 'a.example.test' },
    });
    calls = [];
    const run = await send(`/api/v1/cert/deploy/tasks/${taskId}/run`, 'POST', {});
    const result = await run.json() as { ok: boolean; detail: string };
    expect(result.ok, result.detail).toBe(true);
    const deployCall = calls.find((call) => call.url.endsWith('/CMD_API_SSL'))!;
    const body = new URLSearchParams(String(deployCall.init.body));
    expect(body.get('domain')).toBe('a.example.test');
    expect(body.get('action')).toBe('save');
    expect(body.get('type')).toBe('paste');
    expect(body.get('certificate')).toContain('BEGIN CERTIFICATE');
    expect(body.get('certificate')).toContain('BEGIN EC PRIVATE KEY');
    expect((deployCall.init.headers as Record<string, string>).authorization).toMatch(/^Basic /);
  });

  it('reads kubeconfig credentials and explains the client-certificate limitation', async () => {
    const document = parseKubeconfigYaml([
      'apiVersion: v1',
      'current-context: dev',
      'clusters:',
      '- cluster:',
      '    server: https://k8s.example:6443',
      '  name: dev-cluster',
      'contexts:',
      '- context:',
      '    cluster: dev-cluster',
      '    user: dev-user',
      '  name: dev',
      'users:',
      '- name: dev-user',
      '  user:',
      '    token: "abc:def"',
    ].join('\n'));
    expect(document['current-context']).toBe('dev');
    expect(document.clusters).toEqual([{ cluster: { server: 'https://k8s.example:6443' }, name: 'dev-cluster' }]);

    const runtime = {
      fetch: (() => { throw new Error('不应发起请求'); }) as unknown as typeof fetch,
      log: () => {},
      state: {},
      saveConfig: () => {},
    };
    await expect(k8s.check({ kubeconfig: 'apiVersion: v1\ncurrent-context: dev\n' }, runtime))
      .rejects.toThrow('Kubeconfig中找不到current-context: dev');
    await expect(k8s.check({
      kubeconfig: [
        'current-context: dev',
        'clusters:',
        '- cluster:',
        '    server: https://k8s.example:6443',
        '  name: c1',
        'contexts:',
        '- context:',
        '    cluster: c1',
        '    user: u1',
        '  name: dev',
        'users:',
        '- name: u1',
        '  user:',
        '    client-certificate-data: QUJD',
        '    client-key-data: QUJD',
      ].join('\n'),
    }, runtime)).rejects.toThrow('客户端证书');
  });

  it('keeps existing webhook accounts working through the generic catalog', async () => {
    const accountId = await createAccount({
      name: 'hook', type: 'webhook', url: 'https://deploy.example/hook', token: 'token-1', headers: '{"X-Source":"dnsmgr"}',
    });
    const listed = await request('/api/v1/cert/deploy/accounts', { headers: { cookie } });
    const view = JSON.stringify(await listed.json());
    expect(view).toContain('https://deploy.example/hook');
    expect(view).not.toContain('token-1');
    expect(await testDb.db.query<{ type: string }>('SELECT type FROM cert_deploy_accounts WHERE id=?', [accountId]))
      .toEqual([{ type: 'webhook' }]);
  });
});
