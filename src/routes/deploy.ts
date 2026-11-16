import { Hono, type Context } from 'hono';
import type { AppEnv } from '../core/types';
import { AppError } from '../core/errors';
import { input } from '../core/request';
import { nowSeconds, requireAdmin, requireCertificateSession, requireCsrf } from '../security/auth';
import {
  claimExecutorJob, decryptDeployConfig, encryptDeployConfig, executeDeployDue, loadDeployTask,
  parseTaskConfig, readExecutorToken, reportExecutorJob, requireExecutor, rotateExecutorToken, runDeployTask,
  type DeployAccountConfig, type DeployAccountRow, type DeployAccountType, type DeployRunRow, type DeployTaskRow,
} from '../deploy';
import { deployCatalog, deployProvider, deployProviderMeta, WEBHOOK_DEPLOY_TYPE } from '../deploy/registry';
import type { DeployField, DeployProviderMeta, DeployTaskConfig } from '../deploy/types';
import { deployShowVisible } from '../deploy/types';
import { executorProxy, loadProxySettings } from '../proxy';

function requireSql(c: Context<AppEnv>): void {
  if (c.get('storage').config.format !== 'sql') {
    throw new AppError(501, '自动部署目前仅支持 DB_FORMAT=sql', 'CERT_STORAGE_UNSUPPORTED');
  }
}

function recordId(value: unknown, label: string): number {
  const raw = typeof value === 'number' ? String(value) : typeof value === 'string' ? value : '';
  if (!/^[1-9]\d{0,15}$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
    throw new AppError(400, `${label}编号无效`, 'INVALID_DEPLOY_ID');
  }
  return Number(raw);
}

function accountName(value: unknown): string {
  if (typeof value !== 'string') throw new AppError(400, '部署名称无效', 'INVALID_DEPLOY_NAME');
  const name = value.trim();
  if (!name || name.length > 64) throw new AppError(400, '部署名称不能为空且不超过 64 个字符', 'INVALID_DEPLOY_NAME');
  return name;
}

function deployAccountType(value: unknown): DeployAccountType {
  const type = typeof value === 'string' ? value.trim() : '';
  if (!type || !deployProviderMeta(type)) throw new AppError(400, '不支持的部署账户类型', 'INVALID_DEPLOY_TYPE');
  return type;
}

function webhookUrl(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw || raw.length > 2000) throw new AppError(400, 'Webhook 地址无效', 'INVALID_DEPLOY_WEBHOOK_URL');
  let url: URL;
  try { url = new URL(raw); } catch { throw new AppError(400, 'Webhook 地址无效', 'INVALID_DEPLOY_WEBHOOK_URL'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new AppError(400, 'Webhook 地址必须是 HTTPS 且不能包含凭据或片段', 'INVALID_DEPLOY_WEBHOOK_URL');
  }
  return url.toString();
}

function webhookHeaders(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return '';
  if (raw.length > 2000) throw new AppError(400, '请求头过长', 'INVALID_DEPLOY_HEADERS');
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new AppError(400, '请求头必须是 JSON 对象', 'INVALID_DEPLOY_HEADERS'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AppError(400, '请求头必须是 JSON 对象', 'INVALID_DEPLOY_HEADERS');
  }
  for (const [key, headerValue] of Object.entries(parsed as Record<string, unknown>)) {
    if (!/^[A-Za-z0-9-]{1,64}$/.test(key) || typeof headerValue !== 'string' || headerValue.length > 500
      || ['host', 'content-length', 'connection'].includes(key.toLowerCase())) {
      throw new AppError(400, '请求头格式无效', 'INVALID_DEPLOY_HEADERS');
    }
  }
  return raw;
}

function optionalText(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function readFieldValue(field: DeployField, body: Record<string, unknown>, current?: DeployAccountConfig): string | undefined {
  const provided = body[field.key];
  if (field.type === 'checkbox') {
    const value = provided === undefined ? current?.[field.key] : provided;
    if (value === undefined) return field.defaultValue ?? '0';
    return value === true || value === '1' || value === 'true' || value === 'on' ? '1' : '0';
  }
  const value = provided === undefined || (field.secret && provided === '') ? current?.[field.key] : provided;
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new AppError(400, `${field.label}格式无效`, 'INVALID_DEPLOY_CONFIG');
  const trimmed = value.trim();
  if (field.maxLength && trimmed.length > field.maxLength) throw new AppError(400, `${field.label}过长`, 'INVALID_DEPLOY_CONFIG');
  return trimmed;
}

function fieldVisible(field: DeployField, values: Record<string, string | undefined>): boolean {
  return deployShowVisible(values, field.showWhen);
}

function buildConfig(type: DeployAccountType, body: Record<string, unknown>, current?: DeployAccountConfig): DeployAccountConfig {
  const meta = deployProviderMeta(type);
  if (!meta) throw new AppError(400, '不支持的部署账户类型', 'INVALID_DEPLOY_TYPE');
  const config: DeployAccountConfig = {};
  for (const field of meta.fields) {
    const value = readFieldValue(field, body, current);
    if (value !== undefined && value !== '') config[field.key] = value;
  }
  for (const field of meta.fields) {
    if (!fieldVisible(field, config)) continue;
    if (field.required && !config[field.key]) throw new AppError(400, `请填写${field.label}`, 'INVALID_DEPLOY_CONFIG');
  }
  if (type === WEBHOOK_DEPLOY_TYPE) {
    config.url = webhookUrl(config.url);
    if (config.headers) config.headers = webhookHeaders(config.headers);
  }
  return config;
}

function buildTaskConfig(meta: DeployProviderMeta, body: Record<string, unknown>, current?: DeployTaskConfig): DeployTaskConfig {
  const config: DeployTaskConfig = {};
  for (const field of meta.taskFields) {
    const value = readFieldValue(field, body, current);
    if (value !== undefined) config[field.key] = value;
  }
  for (const field of meta.taskFields) {
    if (!fieldVisible(field, config)) continue;
    if (field.required && !config[field.key]) throw new AppError(400, `请填写${field.label}`, 'INVALID_DEPLOY_CONFIG');
  }
  return config;
}

const ACCOUNT_SELECT = 'SELECT id,name,type,config_cipher,remark,created_at,updated_at FROM cert_deploy_accounts';

async function loadAccount(c: Context<AppEnv>, accountId: number): Promise<DeployAccountRow> {
  const rows = await c.get('db').query<DeployAccountRow>(`${ACCOUNT_SELECT} WHERE id=?`, [accountId]);
  if (!rows[0]) throw new AppError(404, '部署账户不存在', 'DEPLOY_ACCOUNT_NOT_FOUND');
  return rows[0];
}

/** 与 PHP 面板一致：保存前调用驱动 check() 验证凭据；内置的 webhook/执行器没有远端校验。 */
async function checkAccount(c: Context<AppEnv>, type: DeployAccountType, config: DeployAccountConfig): Promise<void> {
  const provider = deployProvider(type);
  if (!provider) return;
  try {
    await provider.check(config, { fetch: c.env.BUDGET.fetch, log: () => undefined, state: {}, saveConfig: () => undefined });
  } catch (error) {
    const detail = error instanceof Error ? error.message : '部署账户验证失败';
    throw new AppError(400, `验证部署账户失败：${detail}`, 'DEPLOY_ACCOUNT_CHECK_FAILED');
  }
}

function accountView(row: DeployAccountRow, config: DeployAccountConfig) {
  const meta = deployProviderMeta(row.type);
  const fields: Record<string, string> = {};
  const secrets: string[] = [];
  for (const field of meta?.fields ?? []) {
    const value = config[field.key] ?? '';
    if (field.secret) {
      if (value) secrets.push(field.key);
      continue;
    }
    if (value) fields[field.key] = value;
  }
  return {
    id: row.id, name: row.name, type: row.type, remark: row.remark, fields, secrets,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

interface TaskListRow extends DeployTaskRow {
  account_name: string;
  account_type: DeployAccountType;
  domains: string;
}

function taskView(row: DeployTaskRow & { domains?: string | null }) {
  let config: DeployTaskConfig = {};
  try { config = parseTaskConfig(row.config_json); } catch { config = {}; }
  return {
    id: row.id, name: row.name, accountId: row.account_id, accountName: row.account_name,
    accountType: row.account_type, certificateOrderId: row.certificate_order_id,
    domains: row.domains ? row.domains.split(',') : [],
    enabled: row.enabled === 1, autoDeploy: row.auto_deploy === 1, target: row.target, config,
    lastRunAt: row.last_run_at, lastStatus: row.last_status, lastError: row.last_error,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function objectInput(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppError(400, '部署配置格式无效', 'INVALID_DEPLOY_CONFIG');
  }
  return value as Record<string, unknown>;
}

function runView(row: DeployRunRow) {
  return {
    id: row.id, taskId: row.task_id, status: row.status, detail: row.detail,
    claimedBy: row.claimed_by, startedAt: row.started_at, finishedAt: row.finished_at,
  };
}

const TASK_SELECT = `SELECT t.*,a.name AS account_name,a.type AS account_type,
  (SELECT group_concat(domain, ',') FROM cert_order_domains d WHERE d.order_id=t.certificate_order_id) AS domains
  FROM cert_deploy_tasks t JOIN cert_deploy_accounts a ON a.id=t.account_id`;

async function loadTask(c: Context<AppEnv>, taskId: number) {
  const rows = await c.get('db').query<TaskListRow>(`${TASK_SELECT} WHERE t.id=?`, [taskId]);
  if (!rows[0]) throw new AppError(404, '部署任务不存在', 'DEPLOY_TASK_NOT_FOUND');
  return rows[0];
}

export function certificateDeployRoutes() {
  const routes = new Hono<AppEnv>();

  routes.use('/api/v1/cert/deploy*', async (c, next) => {
    requireSql(c);
    await next();
  });
  routes.use('/api/v1/executor/*', async (c, next) => {
    requireSql(c);
    await next();
  });

  routes.get('/api/v1/cert/deploy/providers', requireCertificateSession, async (c) => {
    requireAdmin(c);
    return c.json({ code: 0, providers: deployCatalog() });
  });

  routes.get('/api/v1/cert/deploy/accounts', requireCertificateSession, async (c) => {
    requireAdmin(c);
    const rows = await c.get('db').query<DeployAccountRow>(`${ACCOUNT_SELECT} ORDER BY id DESC`);
    const items = [];
    for (const row of rows) {
      let config: DeployAccountConfig = {};
      try { config = await decryptDeployConfig(c, row); } catch { config = {}; }
      items.push(accountView(row, config));
    }
    return c.json({ code: 0, items });
  });

  routes.post('/api/v1/cert/deploy/accounts', requireCertificateSession, requireCsrf, async (c) => {
    requireAdmin(c);
    const body = await input(c);
    const type = deployAccountType(body.type);
    const name = accountName(body.name);
    const config = buildConfig(type, body);
    await checkAccount(c, type, config);
    const existing = await c.get('db').query<{ id: number }>('SELECT id FROM cert_deploy_accounts WHERE name=?', [name]);
    if (existing[0]) throw new AppError(409, '部署账户名称已存在', 'DEPLOY_ACCOUNT_EXISTS');
    const now = nowSeconds();
    const created = await c.get('db').execute(
      `INSERT INTO cert_deploy_accounts (name,type,config_cipher,remark,created_at,updated_at)
       VALUES (?,?,?,?,?,?) RETURNING id`,
      [name, type, 'pending', optionalText(body.remark, 200) || null, now, now],
    );
    const accountId = Number(created.rows[0]?.id ?? 0);
    if (!Number.isSafeInteger(accountId) || accountId < 1) throw new AppError(503, '部署账户创建失败', 'DEPLOY_ACCOUNT_CREATE_FAILED');
    await c.get('db').execute('UPDATE cert_deploy_accounts SET config_cipher=? WHERE id=?', [await encryptDeployConfig(c, accountId, config), accountId]);
    await c.get('db').execute(
      'INSERT INTO audit_logs (user_id,action,target,detail,created_at) VALUES (?,?,?,?,?)',
      [c.get('principal').user.id, 'cert.deploy.account.create', String(accountId), `${type} ${name}`, now],
    );
    return c.json({ code: 0, id: accountId });
  });

  routes.patch('/api/v1/cert/deploy/accounts/:id', requireCertificateSession, requireCsrf, async (c) => {
    requireAdmin(c);
    const accountId = recordId(c.req.param('id'), '部署账户');
    const body = await input(c);
    const account = await loadAccount(c, accountId);
    const type = body.type === undefined ? account.type : deployAccountType(body.type);
    const name = body.name === undefined ? account.name : accountName(body.name);
    const duplicate = await c.get('db').query<{ id: number }>('SELECT id FROM cert_deploy_accounts WHERE name=? AND id<>?', [name, accountId]);
    if (duplicate[0]) throw new AppError(409, '部署账户名称已存在', 'DEPLOY_ACCOUNT_EXISTS');
    let current: DeployAccountConfig | undefined;
    try { current = await decryptDeployConfig(c, account); } catch { current = undefined; }
    const config = buildConfig(type, body, current);
    await checkAccount(c, type, config);
    await c.get('db').execute(
      'UPDATE cert_deploy_accounts SET name=?,type=?,config_cipher=?,remark=?,updated_at=? WHERE id=?',
      [name, type, await encryptDeployConfig(c, accountId, config),
        body.remark === undefined ? account.remark : optionalText(body.remark, 200) || null, nowSeconds(), accountId],
    );
    await c.get('db').execute(
      'INSERT INTO audit_logs (user_id,action,target,detail,created_at) VALUES (?,?,?,?,?)',
      [c.get('principal').user.id, 'cert.deploy.account.update', String(accountId), `${type} ${name}`, nowSeconds()],
    );
    return c.json({ code: 0, id: accountId });
  });

  routes.delete('/api/v1/cert/deploy/accounts/:id', requireCertificateSession, requireCsrf, async (c) => {
    requireAdmin(c);
    const accountId = recordId(c.req.param('id'), '部署账户');
    const account = await loadAccount(c, accountId);
    const used = await c.get('db').query<{ id: number }>('SELECT id FROM cert_deploy_tasks WHERE account_id=? LIMIT 1', [accountId]);
    if (used[0]) throw new AppError(409, '该账户下仍有部署任务，无法删除', 'DEPLOY_ACCOUNT_IN_USE');
    await c.get('db').execute('DELETE FROM cert_deploy_accounts WHERE id=?', [accountId]);
    await c.get('db').execute(
      'INSERT INTO audit_logs (user_id,action,target,detail,created_at) VALUES (?,?,?,?,?)',
      [c.get('principal').user.id, 'cert.deploy.account.delete', String(accountId), account.name, nowSeconds()],
    );
    return c.json({ code: 0 });
  });

  routes.get('/api/v1/cert/deploy/tasks', requireCertificateSession, async (c) => {
    requireAdmin(c);
    const rows = await c.get('db').query<TaskListRow>(`${TASK_SELECT} ORDER BY t.id DESC`);
    return c.json({ code: 0, items: rows.map(taskView) });
  });

  routes.post('/api/v1/cert/deploy/tasks', requireCertificateSession, requireCsrf, async (c) => {
    requireAdmin(c);
    const body = await input(c);
    const name = accountName(body.name);
    const accountId = recordId(body.accountId, '部署账户');
    const certificateOrderId = recordId(body.certificateOrderId, '证书订单');
    const account = await loadAccount(c, accountId);
    const meta = deployProviderMeta(account.type);
    if (!meta) throw new AppError(400, '部署账户类型无效', 'INVALID_DEPLOY_TYPE');
    const config = buildTaskConfig(meta, objectInput(body.config));
    const orders = await c.get('db').query<{ id: number; revoked_at: number | null }>(
      'SELECT id,revoked_at FROM cert_orders WHERE id=?', [certificateOrderId],
    );
    if (!orders[0]) throw new AppError(404, '证书订单不存在', 'CERT_ORDER_NOT_FOUND');
    if (orders[0].revoked_at !== null) throw new AppError(409, '已吊销的证书不能部署', 'CERT_ORDER_REVOKED');
    if (body.enabled !== undefined && typeof body.enabled !== 'boolean') throw new AppError(400, '启用状态无效', 'INVALID_DEPLOY_STATUS');
    if (body.autoDeploy !== undefined && typeof body.autoDeploy !== 'boolean') throw new AppError(400, '自动部署开关无效', 'INVALID_DEPLOY_STATUS');
    const now = nowSeconds();
    const created = await c.get('db').execute(
      `INSERT INTO cert_deploy_tasks
        (name,account_id,certificate_order_id,enabled,auto_deploy,target,config_json,created_by,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?) RETURNING id`,
      [name, accountId, certificateOrderId, body.enabled === false ? 0 : 1, body.autoDeploy === false ? 0 : 1,
        optionalText(body.target, 500) || null, JSON.stringify(config), c.get('principal').user.id, now, now],
    );
    const taskId = Number(created.rows[0]?.id ?? 0);
    await c.get('db').execute(
      'INSERT INTO audit_logs (user_id,action,target,detail,created_at) VALUES (?,?,?,?,?)',
      [c.get('principal').user.id, 'cert.deploy.task.create', String(taskId), `${name} -> account ${accountId}`, now],
    );
    return c.json({ code: 0, id: taskId });
  });

  routes.patch('/api/v1/cert/deploy/tasks/:id', requireCertificateSession, requireCsrf, async (c) => {
    requireAdmin(c);
    const taskId = recordId(c.req.param('id'), '部署任务');
    const body = await input(c);
    const task = await loadTask(c, taskId);
    if (body.enabled !== undefined && typeof body.enabled !== 'boolean') throw new AppError(400, '启用状态无效', 'INVALID_DEPLOY_STATUS');
    if (body.autoDeploy !== undefined && typeof body.autoDeploy !== 'boolean') throw new AppError(400, '自动部署开关无效', 'INVALID_DEPLOY_STATUS');
    const name = body.name === undefined ? task.name : accountName(body.name);
    const enabled = body.enabled === undefined ? task.enabled : body.enabled ? 1 : 0;
    const autoDeploy = body.autoDeploy === undefined ? task.auto_deploy : body.autoDeploy ? 1 : 0;
    const target = body.target === undefined ? task.target : optionalText(body.target, 500) || null;
    let configJson = task.config_json;
    if (body.config !== undefined) {
      const meta = deployProviderMeta(task.account_type);
      if (!meta) throw new AppError(400, '部署账户类型无效', 'INVALID_DEPLOY_TYPE');
      let current: DeployTaskConfig = {};
      try { current = parseTaskConfig(task.config_json); } catch { current = {}; }
      configJson = JSON.stringify(buildTaskConfig(meta, objectInput(body.config), current));
    }
    await c.get('db').execute(
      'UPDATE cert_deploy_tasks SET name=?,enabled=?,auto_deploy=?,target=?,config_json=?,updated_at=? WHERE id=?',
      [name, enabled, autoDeploy, target, configJson, nowSeconds(), taskId],
    );
    await c.get('db').execute(
      'INSERT INTO audit_logs (user_id,action,target,detail,created_at) VALUES (?,?,?,?,?)',
      [c.get('principal').user.id, 'cert.deploy.task.update', String(taskId), `enabled=${enabled} auto=${autoDeploy}`, nowSeconds()],
    );
    return c.json({ code: 0, id: taskId, enabled: enabled === 1, autoDeploy: autoDeploy === 1 });
  });

  routes.delete('/api/v1/cert/deploy/tasks/:id', requireCertificateSession, requireCsrf, async (c) => {
    requireAdmin(c);
    const taskId = recordId(c.req.param('id'), '部署任务');
    const task = await loadTask(c, taskId);
    await c.get('db').execute('DELETE FROM cert_deploy_tasks WHERE id=?', [taskId]);
    await c.get('db').execute(
      'INSERT INTO audit_logs (user_id,action,target,detail,created_at) VALUES (?,?,?,?,?)',
      [c.get('principal').user.id, 'cert.deploy.task.delete', String(taskId), task.name, nowSeconds()],
    );
    return c.json({ code: 0 });
  });

  routes.post('/api/v1/cert/deploy/tasks/:id/run', requireCertificateSession, requireCsrf, async (c) => {
    requireAdmin(c);
    const taskId = recordId(c.req.param('id'), '部署任务');
    const task = await loadDeployTask(c, taskId);
    if (task.enabled !== 1) throw new AppError(409, '部署任务已停用', 'DEPLOY_TASK_DISABLED');
    const result = await runDeployTask(c, task, { force: true });
    await c.get('db').execute(
      'INSERT INTO audit_logs (user_id,action,target,detail,created_at) VALUES (?,?,?,?,?)',
      [c.get('principal').user.id, 'cert.deploy.task.run', String(taskId), result.detail.slice(0, 200), nowSeconds()],
    );
    return c.json({ code: 0, ...result });
  });

  routes.get('/api/v1/cert/deploy/runs', requireCertificateSession, async (c) => {
    requireAdmin(c);
    const taskFilter = c.req.query('taskId');
    const taskId = taskFilter ? recordId(taskFilter, '部署任务') : 0;
    const rows = await c.get('db').query<DeployRunRow>(
      taskId
        ? 'SELECT * FROM cert_deploy_runs WHERE task_id=? ORDER BY id DESC LIMIT 50'
        : 'SELECT * FROM cert_deploy_runs ORDER BY id DESC LIMIT 50',
      taskId ? [taskId] : [],
    );
    return c.json({ code: 0, items: rows.map(runView) });
  });

  routes.post('/api/v1/cert/deploy/run', requireCertificateSession, requireCsrf, async (c) => {
    requireAdmin(c);
    const result = await executeDeployDue(c, 5, { ignoreWindow: true });
    await c.get('db').execute(
      'INSERT INTO audit_logs (user_id,action,target,detail,created_at) VALUES (?,?,?,?,?)',
      [c.get('principal').user.id, 'cert.deploy.run', 'system', `ran=${result.ran}`, nowSeconds()],
    );
    return c.json({ code: 0, ...result });
  });

  routes.get('/api/v1/system/executor', requireCertificateSession, async (c) => {
    requireAdmin(c);
    const token = await readExecutorToken(c);
    return c.json({
      code: 0, token, claimUrl: '/api/v1/executor/claim', reportUrl: '/api/v1/executor/report',
      header: 'Authorization: Bearer <token>',
    });
  });

  routes.put('/api/v1/system/executor', requireCertificateSession, requireCsrf, async (c) => {
    requireAdmin(c);
    const body = await input(c);
    if (body.rotate !== true) throw new AppError(400, '仅支持轮换执行器令牌', 'INVALID_EXECUTOR_SETTINGS');
    const token = await rotateExecutorToken(c);
    await c.get('db').execute(
      'INSERT INTO audit_logs (user_id,action,target,detail,created_at) VALUES (?,?,?,?,?)',
      [c.get('principal').user.id, 'executor.token.rotate', 'system', 'rotated', nowSeconds()],
    );
    return c.json({ code: 0, token, claimUrl: '/api/v1/executor/claim', reportUrl: '/api/v1/executor/report' });
  });

  routes.post('/api/v1/executor/claim', async (c) => {
    await requireExecutor(c);
    const body = await input(c);
    const executorId = optionalText(body.executorId, 100) || 'executor';
    const job = await claimExecutorJob(c, executorId);
    const proxy = executorProxy(await loadProxySettings(c));
    return c.json({ code: 0, job, proxy });
  });

  routes.post('/api/v1/executor/report', async (c) => {
    await requireExecutor(c);
    const body = await input(c);
    const runId = recordId(body.runId, '部署运行');
    if (typeof body.ok !== 'boolean') throw new AppError(400, 'ok 必须是布尔值', 'INVALID_EXECUTOR_REPORT');
    const detail = optionalText(body.detail, 500) || (body.ok ? '执行器已完成部署' : '执行器报告部署失败');
    await reportExecutorJob(c, runId, body.ok, detail);
    return c.json({ code: 0 });
  });

  return routes;
}
