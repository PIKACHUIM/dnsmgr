import type { Context } from 'hono';
import type { AppEnv } from './core/types';
import { AppError } from './core/errors';
import { decrypt, encrypt } from './security/crypto';
import { nowSeconds } from './security/auth';
import { queueNotification } from './notify/certificate';

export const EXECUTOR_TOKEN_SETTING = 'executor_token_cipher';
const EXECUTOR_TOKEN_PURPOSE = 'executor-token/v1';
const STALE_PENDING_SECONDS = 3600;

export type DeployAccountType = 'webhook' | 'executor';

export interface DeployAccountConfig {
  url?: string;
  token?: string;
  headers?: string;
  label?: string;
  path?: string;
  command?: string;
}

export interface DeployAccountRow extends Record<string, unknown> {
  id: number;
  name: string;
  type: DeployAccountType;
  config_cipher: string;
  remark: string | null;
  created_at: number;
  updated_at: number;
}

export interface DeployTaskRow extends Record<string, unknown> {
  id: number;
  name: string;
  account_id: number;
  certificate_order_id: number;
  enabled: number;
  auto_deploy: number;
  target: string | null;
  created_by: number;
  created_at: number;
  updated_at: number;
  last_run_at: number | null;
  last_status: string | null;
  last_error: string | null;
  account_name: string;
  account_type: DeployAccountType;
  config_cipher: string;
  cert_updated_at: number;
  cert_expires_at: number;
  fullchain_cipher: string;
  private_key_cipher: string;
  issuer: string;
}

export interface DeployRunRow extends Record<string, unknown> {
  id: number;
  task_id: number;
  status: 'pending' | 'running' | 'succeeded' | 'failed';
  detail: string | null;
  claimed_by: string | null;
  started_at: number;
  finished_at: number | null;
}

function safeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return diff === 0;
}

export function parseDeployConfig(value: string): DeployAccountConfig {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new AppError(503, '部署账户配置损坏，请重新保存', 'DEPLOY_CONFIG_CORRUPTED'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AppError(503, '部署账户配置损坏，请重新保存', 'DEPLOY_CONFIG_CORRUPTED');
  }
  const source = parsed as Record<string, unknown>;
  const config: DeployAccountConfig = {};
  for (const key of ['url', 'token', 'headers', 'label', 'path', 'command'] as const) {
    if (source[key] !== undefined && typeof source[key] !== 'string') {
      throw new AppError(503, '部署账户配置损坏，请重新保存', 'DEPLOY_CONFIG_CORRUPTED');
    }
    if (typeof source[key] === 'string') config[key] = source[key] as string;
  }
  return config;
}

export async function decryptDeployConfig(c: Context<AppEnv>, row: { id: number; config_cipher: string }): Promise<DeployAccountConfig> {
  let plain: string;
  try { plain = await decrypt(row.config_cipher, c.env.APP_KEY, `cert-deploy-account/${row.id}`); }
  catch { throw new AppError(503, '部署账户凭据不可用', 'DEPLOY_CONFIG_UNAVAILABLE'); }
  return parseDeployConfig(plain);
}

export async function encryptDeployConfig(c: Context<AppEnv>, accountId: number, config: DeployAccountConfig): Promise<string> {
  return encrypt(JSON.stringify(config), c.env.APP_KEY, `cert-deploy-account/${accountId}`);
}

const DUE_TASKS_SQL = `SELECT t.*,a.name AS account_name,a.type AS account_type,a.config_cipher,
    o.updated_at AS cert_updated_at,o.expires_at AS cert_expires_at,o.fullchain_cipher,o.private_key_cipher,o.issuer
  FROM cert_deploy_tasks t
  JOIN cert_deploy_accounts a ON a.id=t.account_id
  JOIN cert_orders o ON o.id=t.certificate_order_id
  WHERE t.enabled=1 AND o.revoked_at IS NULL`;

export async function loadDeployTask(c: Context<AppEnv>, taskId: number): Promise<DeployTaskRow> {
  const rows = await c.get('db').query<DeployTaskRow>(`${DUE_TASKS_SQL} AND t.id=?`, [taskId]);
  if (!rows[0]) throw new AppError(404, '部署任务不存在', 'DEPLOY_TASK_NOT_FOUND');
  return rows[0];
}

async function loadCertificateMaterial(c: Context<AppEnv>, task: DeployTaskRow) {
  const domains = (await c.get('db').query<{ domain: string }>(
    'SELECT domain FROM cert_order_domains WHERE order_id=? ORDER BY sort', [task.certificate_order_id],
  )).map((row) => row.domain);
  let fullchain: string;
  let privateKey: string;
  try {
    fullchain = await decrypt(task.fullchain_cipher, c.env.APP_KEY, `cert-order/${task.certificate_order_id}/fullchain`);
    privateKey = await decrypt(task.private_key_cipher, c.env.APP_KEY, `cert-order/${task.certificate_order_id}/private-key`);
  } catch {
    throw new AppError(503, '证书材料不可用，无法部署', 'DEPLOY_CERTIFICATE_UNAVAILABLE');
  }
  return { domains, fullchain, privateKey, expiresAt: task.cert_expires_at, issuer: task.issuer };
}

function claimTaskStatement(task: DeployTaskRow, status: string, force = false) {
  return force
    ? {
      sql: 'UPDATE cert_deploy_tasks SET last_run_at=?,last_status=?,last_error=NULL,updated_at=? WHERE id=? AND enabled=1',
      args: [nowSeconds(), status, nowSeconds(), task.id] as (string | number)[],
    }
    : {
      sql: `UPDATE cert_deploy_tasks SET last_run_at=?,last_status=?,last_error=NULL,updated_at=?
        WHERE id=? AND enabled=1 AND (last_run_at IS NULL OR last_run_at<?)`,
      args: [nowSeconds(), status, nowSeconds(), task.id, task.cert_updated_at] as (string | number)[],
    };
}

async function postWebhook(c: Context<AppEnv>, config: DeployAccountConfig, payload: unknown): Promise<number> {
  if (!config.url) throw new AppError(503, '部署账户缺少 Webhook 地址', 'DEPLOY_WEBHOOK_NOT_CONFIGURED');
  let headers: Record<string, string> = { 'content-type': 'application/json' };
  if (config.headers) {
    let parsed: unknown;
    try { parsed = JSON.parse(config.headers); } catch { throw new AppError(503, '部署账户请求头不是有效 JSON', 'DEPLOY_WEBHOOK_HEADERS_INVALID'); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
      || Object.entries(parsed as Record<string, unknown>).some(([, value]) => typeof value !== 'string')) {
      throw new AppError(503, '部署账户请求头格式无效', 'DEPLOY_WEBHOOK_HEADERS_INVALID');
    }
    headers = { ...(parsed as Record<string, string>), 'content-type': 'application/json' };
  }
  if (config.token) headers.authorization = `Bearer ${config.token}`;
  const response = await c.env.BUDGET.fetch(config.url, {
    method: 'POST', headers, body: JSON.stringify(payload),
    signal: AbortSignal.timeout(20_000), redirect: 'error',
  });
  return response.status;
}

async function finishRun(
  c: Context<AppEnv>, runId: number, ok: boolean, detail: string, taskId: number,
): Promise<void> {
  const now = nowSeconds();
  await c.get('db').batch([
    {
      sql: 'UPDATE cert_deploy_runs SET status=?,detail=?,finished_at=? WHERE id=? AND status IN (\'pending\',\'running\')',
      args: [ok ? 'succeeded' : 'failed', detail.slice(0, 500), now, runId],
    },
    {
      sql: 'UPDATE cert_deploy_tasks SET last_status=?,last_error=?,updated_at=? WHERE id=?',
      args: [ok ? 'succeeded' : 'failed', ok ? null : detail.slice(0, 200), now, taskId],
    },
  ]);
}

export async function runDeployTask(
  c: Context<AppEnv>, task: DeployTaskRow, options: { force?: boolean } = {},
): Promise<{ ok: boolean; detail: string; runId: number }> {
  const claim = claimTaskStatement(task, 'running', options.force === true);
  const claimed = await c.get('db').execute(claim.sql, claim.args);
  if (claimed.changes !== 1) throw new AppError(409, '部署任务已在运行或证书未更新', 'DEPLOY_TASK_NOT_READY');
  const inserted = await c.get('db').execute(
    `INSERT INTO cert_deploy_runs (task_id,status,started_at) VALUES (?,'running',?) RETURNING id`, [task.id, nowSeconds()],
  );
  const runId = Number(inserted.rows[0]?.id ?? 0);
  if (!Number.isSafeInteger(runId) || runId < 1) throw new AppError(503, '部署运行记录创建失败', 'DEPLOY_RUN_CREATE_FAILED');

  try {
    if (task.account_type === 'executor') {
      await c.get('db').execute(
        `UPDATE cert_deploy_runs SET status='pending',detail=? WHERE id=?`, ['等待执行器领取', runId],
      );
      await c.get('db').execute(`UPDATE cert_deploy_tasks SET last_status='pending',updated_at=? WHERE id=?`, [nowSeconds(), task.id]);
      return { ok: true, detail: '部署任务已加入执行器队列', runId };
    }
    const config = await decryptDeployConfig(c, { id: task.account_id, config_cipher: task.config_cipher });
    const material = await loadCertificateMaterial(c, task);
    const status = await postWebhook(c, config, {
      task: { id: task.id, name: task.name, target: task.target },
      certificate: {
        id: task.certificate_order_id, issuer: material.issuer, domains: material.domains,
        expiresAt: material.expiresAt, fullchain: material.fullchain, privateKey: material.privateKey,
      },
    });
    if (status < 200 || status >= 300) {
      const detail = `Webhook 返回 HTTP ${status}`;
      await finishRun(c, runId, false, detail, task.id);
      await queueNotification(c.get('db'), 'deploy', '证书自动部署失败', `${task.name}：${detail}`);
      return { ok: false, detail, runId };
    }
    const detail = `Webhook 返回 HTTP ${status}`;
    await finishRun(c, runId, true, detail, task.id);
    return { ok: true, detail, runId };
  } catch (error) {
    const detail = error instanceof Error ? error.message : '部署失败';
    await finishRun(c, runId, false, detail, task.id);
    await queueNotification(c.get('db'), 'deploy', '证书自动部署失败', `${task.name}：${detail}`);
    return { ok: false, detail, runId };
  }
}

/** 旧版 deploy_hour_start/end 的窗口判定：起止相同表示只允许该小时，跨天时按环绕处理。 */
export function deployWindowAllows(hour: number, start: number, end: number): boolean {
  if (start <= end) return hour >= start && hour <= end;
  return hour >= start || hour <= end;
}

async function readDeployWindow(c: Context<AppEnv>): Promise<{ start: number; end: number; offset: number }> {
  const rows = await c.get('db').query<{ key: string; value: string }>(
    "SELECT key,value FROM app_settings WHERE key IN ('deploy_hour_start','deploy_hour_end','schedule_tz_offset')",
  );
  const values = new Map(rows.map((row) => [row.key, row.value]));
  const bounded = (raw: string | undefined, fallback: number) => {
    const parsed = Number(raw);
    return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= 23 ? parsed : fallback;
  };
  const rawOffset = Number(values.get('schedule_tz_offset') ?? 480);
  return {
    start: bounded(values.get('deploy_hour_start'), 0),
    end: bounded(values.get('deploy_hour_end'), 23),
    offset: Number.isFinite(rawOffset) && Math.abs(rawOffset) <= 840 ? rawOffset : 480,
  };
}

export async function executeDeployDue(
  c: Context<AppEnv>, limit = 2, options: { ignoreWindow?: boolean } = {},
): Promise<{ ran: number; skipped?: string }> {
  if (!options.ignoreWindow) {
    const window = await readDeployWindow(c);
    const local = (((nowSeconds() + window.offset * 60) % 86_400) + 86_400) % 86_400;
    if (!deployWindowAllows(Math.floor(local / 3600), window.start, window.end)) {
      return { ran: 0, skipped: 'OUTSIDE_DEPLOY_WINDOW' };
    }
  }
  const tasks = await c.get('db').query<DeployTaskRow>(
    `${DUE_TASKS_SQL} AND t.auto_deploy=1
      AND (t.last_run_at IS NULL OR t.last_run_at<o.updated_at)
      AND NOT EXISTS (SELECT 1 FROM cert_deploy_runs r WHERE r.task_id=t.id AND r.status IN ('pending','running'))
      ORDER BY t.id LIMIT ?`, [limit],
  );
  let ran = 0;
  for (const task of tasks) {
    if (task.account_type === 'executor') {
      const now = nowSeconds();
      const claimed = await c.get('db').execute(claimTaskStatement(task, 'pending').sql, claimTaskStatement(task, 'pending').args);
      if (claimed.changes !== 1) continue;
      const inserted = await c.get('db').execute(
        `INSERT INTO cert_deploy_runs (task_id,status,detail,started_at) VALUES (?,'pending',?,?) RETURNING id`,
        [task.id, '等待执行器领取', now],
      );
      if (Number(inserted.rows[0]?.id ?? 0) > 0) ran += 1;
      continue;
    }
    try {
      await runDeployTask(c, task);
      ran += 1;
    } catch {
      continue;
    }
  }
  await c.get('db').execute(
    `UPDATE cert_deploy_runs SET status='failed',detail='执行器领取超时',finished_at=? WHERE status='pending' AND started_at<?`,
    [nowSeconds(), nowSeconds() - STALE_PENDING_SECONDS],
  ).catch(() => undefined);
  return { ran };
}

export async function readExecutorToken(c: Context<AppEnv>, create = true): Promise<string | null> {
  const rows = await c.get('db').query<{ value: string }>('SELECT value FROM app_settings WHERE key=?', [EXECUTOR_TOKEN_SETTING]);
  if (rows[0]) {
    try { return await decrypt(rows[0].value, c.env.APP_KEY, EXECUTOR_TOKEN_PURPOSE); } catch { return null; }
  }
  if (!create) return null;
  const token = crypto.randomUUID().replace(/-/g, '');
  const cipher = await encrypt(token, c.env.APP_KEY, EXECUTOR_TOKEN_PURPOSE);
  await c.get('db').execute(
    'INSERT INTO app_settings (key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at',
    [EXECUTOR_TOKEN_SETTING, cipher, nowSeconds()],
  );
  return token;
}

export async function rotateExecutorToken(c: Context<AppEnv>): Promise<string> {
  await c.get('db').execute('DELETE FROM app_settings WHERE key=?', [EXECUTOR_TOKEN_SETTING]);
  return (await readExecutorToken(c))!;
}

export async function requireExecutor(c: Context<AppEnv>): Promise<void> {
  const header = c.req.header('authorization') ?? '';
  const token = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
  const expected = await readExecutorToken(c, false);
  if (!expected || !token || !safeEqual(token, expected)) {
    throw new AppError(401, '执行器令牌无效', 'EXECUTOR_UNAUTHORIZED');
  }
}

export interface ExecutorJob {
  runId: number;
  task: { id: number; name: string; target: string | null };
  account: { id: number; name: string; type: DeployAccountType; config: DeployAccountConfig };
  certificate: { id: number; issuer: string; domains: string[]; expiresAt: number; fullchain: string; privateKey: string };
}

export async function claimExecutorJob(c: Context<AppEnv>, executorId: string): Promise<ExecutorJob | null> {
  const runs = await c.get('db').query<DeployRunRow>(
    `SELECT id,task_id FROM cert_deploy_runs WHERE status='pending' ORDER BY id LIMIT 3`,
  );
  for (const run of runs) {
    const claimed = await c.get('db').execute(
      `UPDATE cert_deploy_runs SET status='running',claimed_by=?,started_at=? WHERE id=? AND status='pending'`,
      [executorId.slice(0, 100), nowSeconds(), run.id],
    );
    if (claimed.changes !== 1) continue;
    let task: DeployTaskRow;
    try {
      task = await loadDeployTask(c, run.task_id);
    } catch {
      await c.get('db').execute(
        `UPDATE cert_deploy_runs SET status='failed',detail='部署任务或证书已删除',finished_at=? WHERE id=?`,
        [nowSeconds(), run.id],
      );
      continue;
    }
    const config = await decryptDeployConfig(c, { id: task.account_id, config_cipher: task.config_cipher });
    const material = await loadCertificateMaterial(c, task);
    await c.get('db').execute(`UPDATE cert_deploy_tasks SET last_status='running',updated_at=? WHERE id=?`, [nowSeconds(), task.id]);
    return {
      runId: run.id,
      task: { id: task.id, name: task.name, target: task.target },
      account: { id: task.account_id, name: task.account_name, type: task.account_type, config },
      certificate: {
        id: task.certificate_order_id, issuer: material.issuer, domains: material.domains,
        expiresAt: material.expiresAt, fullchain: material.fullchain, privateKey: material.privateKey,
      },
    };
  }
  return null;
}

export async function reportExecutorJob(
  c: Context<AppEnv>, runId: number, ok: boolean, detail: string,
): Promise<void> {
  const rows = await c.get('db').query<DeployRunRow>('SELECT * FROM cert_deploy_runs WHERE id=?', [runId]);
  const run = rows[0];
  if (!run) throw new AppError(404, '部署运行记录不存在', 'DEPLOY_RUN_NOT_FOUND');
  if (run.status !== 'running' && run.status !== 'pending') {
    throw new AppError(409, '部署运行记录已结束', 'DEPLOY_RUN_FINISHED');
  }
  await finishRun(c, runId, ok, detail, run.task_id);
  if (!ok) {
    const tasks = await c.get('db').query<{ name: string }>('SELECT name FROM cert_deploy_tasks WHERE id=?', [run.task_id]);
    await queueNotification(c.get('db'), 'deploy', '证书自动部署失败', `${tasks[0]?.name ?? run.task_id}：${detail}`);
  }
}
