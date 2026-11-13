import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import type { Bindings, RequestBudget } from '../src/core/types';
import { environment } from '../src/platform/runtime';
import { deployWindowAllows } from '../src/deploy';
import { encrypt } from '../src/security/crypto';
import { createTestDatabase } from './helpers/sqlite';

const appKey = btoa('12345678901234567890123456789012');
const fullchain = '-----BEGIN CERTIFICATE-----\nQUJD\n-----END CERTIFICATE-----\n';
const privateKey = '-----BEGIN PRIVATE KEY-----\nQUJD\n-----END PRIVATE KEY-----\n';

describe('certificate deployment and executor', () => {
  let testDb: ReturnType<typeof createTestDatabase>;
  let app: ReturnType<typeof createApp>;
  let bindings: Bindings;
  let cookie = '';
  let csrf = '';
  let webhookCalls: { url: string; init: RequestInit }[] = [];
  let webhookStatus = 200;
  let certId = 0;

  beforeEach(async () => {
    testDb = createTestDatabase();
    app = createApp({ database: testDb.db });
    webhookCalls = [];
    webhookStatus = 200;
    const fetchMock = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      webhookCalls.push({ url: String(input), init });
      return new Response('ok', { status: webhookStatus });
    }) as unknown as typeof fetch;
    const budget: RequestBudget = { consume: () => {}, remainingMs: () => 30_000, fetch: fetchMock };
    bindings = {
      DB_DRIVER: 'turso', DB_FORMAT: 'sql', TURSO_DATABASE_URL: 'https://test.invalid', TURSO_AUTH_TOKEN: 'test-token',
      APP_KEY: appKey, SETUP_TOKEN: 'test-install-token-32-characters!!', BUDGET: budget,
    };
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
    certId = 4242;
    await testDb.db.batch([
      {
        sql: `INSERT INTO cert_orders
          (id,source,status,issuer,key_type,key_size,issued_at,expires_at,fullchain_cipher,private_key_cipher,created_by,created_at,updated_at,is_auto)
          VALUES (?,'manual','issued','Test Issuer','RSA',2048,1000,2000,?,?,1,1000,1000,0)`,
        args: [certId, await encrypt(fullchain, appKey, `cert-order/${certId}/fullchain`),
          await encrypt(privateKey, appKey, `cert-order/${certId}/private-key`)],
      },
      { sql: 'INSERT INTO cert_order_domains (order_id,domain,sort) VALUES (?,?,0)', args: [certId, 'deploy.example.test'] },
    ]);
  });
  afterEach(() => testDb.close());

  function request(path: string, init: RequestInit = {}) {
    return app.request(`https://panel.example${path}`, init, environment(bindings, 'local'));
  }
  function send(path: string, method: string, body: unknown, headers: Record<string, string> = {}) {
    return request(path, {
      method, headers: { 'content-type': 'application/json', cookie, 'X-CSRF-Token': csrf, ...headers }, body: JSON.stringify(body),
    });
  }

  async function createAccount(body: Record<string, unknown>) {
    const response = await send('/api/v1/cert/deploy/accounts', 'POST', body);
    expect(response.status, JSON.stringify(await response.clone().json())).toBe(200);
    return (await response.json() as { id: number }).id;
  }

  it('validates deploy accounts and pushes certificates through HTTPS webhooks', async () => {
    const insecure = await send('/api/v1/cert/deploy/accounts', 'POST', {
      name: 'insecure', type: 'webhook', url: 'http://panel.example/hook',
    });
    expect(insecure.status).toBe(400);
    expect((await insecure.json()).reason).toBe('INVALID_DEPLOY_WEBHOOK_URL');

    const accountId = await createAccount({
      name: 'webhook-target', type: 'webhook', url: 'https://deploy.example/hook', token: 'deploy-token', headers: '{"X-Source":"dnsmgr"}',
    });
    const stored = await testDb.db.query<{ config_cipher: string }>('SELECT config_cipher FROM cert_deploy_accounts WHERE id=?', [accountId]);
    expect(stored[0]!.config_cipher).not.toContain('deploy-token');

    const listed = await request('/api/v1/cert/deploy/accounts', { headers: { cookie } });
    const view = JSON.stringify(await listed.json());
    expect(view).toContain('https://deploy.example/hook');
    expect(view).not.toContain('deploy-token');

    const taskResponse = await send('/api/v1/cert/deploy/tasks', 'POST', {
      name: 'deploy example', accountId, certificateOrderId: certId,
    });
    expect(taskResponse.status).toBe(200);
    const taskId = (await taskResponse.json() as { id: number }).id;

    const run = await send(`/api/v1/cert/deploy/tasks/${taskId}/run`, 'POST', {});
    const result = await run.json() as { ok: boolean; runId: number; detail: string };
    expect(result.ok).toBe(true);
    expect(webhookCalls).toHaveLength(1);
    expect(webhookCalls[0]!.url).toBe('https://deploy.example/hook');
    const headers = webhookCalls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer deploy-token');
    expect(headers['X-Source']).toBe('dnsmgr');
    const payload = JSON.parse(String(webhookCalls[0]!.init.body)) as {
      certificate: { domains: string[]; fullchain: string; privateKey: string };
    };
    expect(payload.certificate.domains).toEqual(['deploy.example.test']);
    expect(payload.certificate.fullchain).toBe(fullchain);
    expect(payload.certificate.privateKey).toBe(privateKey);

    const runs = await request(`/api/v1/cert/deploy/runs?taskId=${taskId}`, { headers: { cookie } });
    expect(await runs.json()).toMatchObject({ code: 0, items: [{ status: 'succeeded', taskId }] });

    webhookStatus = 500;
    const failed = await send(`/api/v1/cert/deploy/tasks/${taskId}/run`, 'POST', {});
    expect(await failed.json()).toMatchObject({ ok: false });
    const outbox = await testDb.db.query<{ topic: string; title: string }>('SELECT topic,title FROM notification_outbox');
    expect(outbox).toEqual([{ topic: 'deploy', title: '证书自动部署失败' }]);

    const accountInUse = await send(`/api/v1/cert/deploy/accounts/${accountId}`, 'DELETE', {});
    expect(accountInUse.status).toBe(409);
    expect((await accountInUse.json()).reason).toBe('DEPLOY_ACCOUNT_IN_USE');
  });

  it('queues executor jobs behind a bearer token and records the reported result', async () => {
    const accountId = await createAccount({ name: 'executor-target', type: 'executor', label: 'node-1', path: '/etc/ssl' });
    const taskResponse = await send('/api/v1/cert/deploy/tasks', 'POST', {
      name: 'executor deploy', accountId, certificateOrderId: certId, target: 'web-1',
    });
    const taskId = (await taskResponse.json() as { id: number }).id;

    const settings = await request('/api/v1/system/executor', { headers: { cookie } });
    const { token } = await settings.json() as { token: string };
    expect(token).toMatch(/^[0-9a-f]{32}$/);

    const unauthorized = await request('/api/v1/executor/claim', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    expect(unauthorized.status).toBe(401);

    const queued = await send(`/api/v1/cert/deploy/tasks/${taskId}/run`, 'POST', {});
    expect(await queued.json()).toMatchObject({ ok: true, detail: '部署任务已加入执行器队列' });

    const claim = await request('/api/v1/executor/claim', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ executorId: 'node-1' }),
    });
    expect(claim.status).toBe(200);
    const job = (await claim.json() as { job: Record<string, unknown> }).job;
    expect(job).toMatchObject({
      task: { id: taskId, target: 'web-1' },
      account: { name: 'executor-target', type: 'executor', config: { label: 'node-1', path: '/etc/ssl' } },
      certificate: { id: certId, domains: ['deploy.example.test'], fullchain, privateKey },
    });

    const empty = await request('/api/v1/executor/claim', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: '{}',
    });
    expect(await empty.json()).toMatchObject({ code: 0, job: null });

    const report = await request('/api/v1/executor/report', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ runId: (job as { runId: number }).runId, ok: false, detail: 'nginx reload failed' }),
    });
    expect(report.status).toBe(200);
    const runs = await testDb.db.query<{ status: string; detail: string }>('SELECT status,detail FROM cert_deploy_runs');
    expect(runs).toEqual([{ status: 'failed', detail: 'nginx reload failed' }]);
    expect(await testDb.db.query<{ last_status: string }>('SELECT last_status FROM cert_deploy_tasks'))
      .toEqual([{ last_status: 'failed' }]);
    expect(await testDb.db.query<{ topic: string }>('SELECT topic FROM notification_outbox'))
      .toEqual([{ topic: 'deploy' }]);

    const rotated = await send('/api/v1/system/executor', 'PUT', { rotate: true });
    const rotatedToken = (await rotated.json() as { token: string }).token;
    expect(rotatedToken).not.toBe(token);
    const stale = await request('/api/v1/executor/claim', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: '{}',
    });
    expect(stale.status).toBe(401);
  });

  it('wraps deployment windows across midnight', () => {
    expect(deployWindowAllows(12, 0, 23)).toBe(true);
    expect(deployWindowAllows(0, 0, 23)).toBe(true);
    expect(deployWindowAllows(23, 22, 6)).toBe(true);
    expect(deployWindowAllows(3, 22, 6)).toBe(true);
    expect(deployWindowAllows(12, 22, 6)).toBe(false);
    expect(deployWindowAllows(5, 5, 5)).toBe(true);
    expect(deployWindowAllows(6, 5, 5)).toBe(false);
  });

  it('limits cron deployments to the configured hour window but keeps manual runs available', async () => {
    const accountId = await createAccount({ name: 'window-target', type: 'webhook', url: 'https://deploy.example/window' });
    const taskResponse = await send('/api/v1/cert/deploy/tasks', 'POST', {
      name: 'window deploy', accountId, certificateOrderId: certId,
    });
    expect(taskResponse.status).toBe(200);

    const settings = await request('/api/v1/system/certificate-renew', { headers: { cookie } });
    expect(await settings.json()).toMatchObject({ code: 0, deployStart: 0, deployEnd: 23 });

    const invalid = await send('/api/v1/system/certificate-renew', 'PUT', { deployStart: 24, deployEnd: 23 });
    expect(invalid.status).toBe(400);
    expect((await invalid.json()).reason).toBe('INVALID_CERT_RENEW_SETTINGS');

    const offsetRows = await testDb.db.query<{ value: string }>(
      "SELECT value FROM app_settings WHERE key='schedule_tz_offset'",
    );
    const offset = Number(offsetRows[0]?.value ?? 480);
    const seconds = Math.floor(Date.now() / 1000) + offset * 60;
    const localHour = Math.floor((((seconds % 86_400) + 86_400) % 86_400) / 3600);
    const blocked = (localHour + 1) % 24;
    const saved = await send('/api/v1/system/certificate-renew', 'PUT', { deployStart: blocked, deployEnd: blocked });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ code: 0, deployStart: blocked, deployEnd: blocked });

    await testDb.db.execute("INSERT INTO app_settings (key,value,updated_at) VALUES ('cron_enabled','1',0)");
    await testDb.db.execute("INSERT INTO app_settings (key,value,updated_at) VALUES ('cron_key','window-cron-key',0)");

    const cron = await request('/cron?key=window-cron-key');
    expect(await cron.text()).toBe('success!');
    expect(webhookCalls).toHaveLength(0);
    expect(await testDb.db.query('SELECT id FROM cert_deploy_runs')).toEqual([]);

    const manual = await send('/api/v1/cert/deploy/run', 'POST', {});
    expect(await manual.json()).toMatchObject({ code: 0, ran: 1 });
    expect(webhookCalls).toHaveLength(1);
    expect(webhookCalls[0]!.url).toBe('https://deploy.example/window');
  });
});
