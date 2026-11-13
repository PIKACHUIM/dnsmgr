import { Hono, type Context } from 'hono';
import type { AppEnv } from '../core/types';
import { AppError } from '../core/errors';
import { input } from '../core/request';
import { nowSeconds, requireAdmin, requireCsrf, requireSession } from '../security/auth';
import { decrypt } from '../security/crypto';
import { createProvider } from '../dns/registry';
import type { DnsDomain } from '../dns/types';
import {
  OPTIMIZE_API, OPTIMIZE_KEY, OPTIMIZE_MIN, executeOptimizeDue, fetchOptimizeCredit, loadOptimizeTask, readOptimizeSettings,
  runOptimizeTask, type IpGroup, type OptimizeTaskRow,
} from '../optimize';

function requireSql(c: Context<AppEnv>): void {
  if (c.get('storage').config.format !== 'sql') {
    throw new AppError(501, 'IP 优选目前仅支持 DB_FORMAT=sql', 'STORAGE_FORMAT_UNSUPPORTED');
  }
}

function numericId(value: unknown, label: string): number {
  const raw = typeof value === 'number' ? String(value) : typeof value === 'string' ? value : '';
  if (!/^[1-9]\d{0,15}$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
    throw new AppError(400, `${label}编号无效`, 'INVALID_OPTIMIZE_ID');
  }
  return Number(raw);
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number, reason: string): number {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new AppError(400, `参数范围应为 ${min}–${max}`, reason);
  }
  return parsed;
}

function recordName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!/^[A-Za-z0-9_@-]{1,63}$/.test(name)) throw new AppError(400, '主机记录格式无效', 'INVALID_OPTIMIZE_RR');
  return name;
}

function ipGroup(value: unknown): IpGroup {
  if (value === 'DEF' || value === 'CT' || value === 'CU' || value === 'CM') return value;
  throw new AppError(400, '线路分组无效', 'INVALID_OPTIMIZE_GROUP');
}

function lineValue(value: unknown): string {
  const line = typeof value === 'string' ? value.trim() : '0';
  if (!line || line.length > 20) throw new AppError(400, '线路标识无效', 'INVALID_OPTIMIZE_LINE');
  return line;
}

interface TaskViewRow extends OptimizeTaskRow {
  domain_name: string;
}

const TASK_LIST = `SELECT t.*,d.name AS domain_name,d.third_id AS zone_third_id,d.account_id,a.type AS account_type,a.config_cipher
  FROM optimize_ip_tasks t JOIN dns_domains d ON d.id=t.domain_id JOIN dns_accounts a ON a.id=d.account_id`;

function view(row: TaskViewRow) {
  return {
    id: row.id, domainId: row.domain_id, domainName: row.domain_name, rr: row.rr,
    recordType: row.record_type, ipGroup: row.ip_group, cdnType: row.cdn_type, recordCount: row.record_count,
    ttl: row.ttl, line: row.line, enabled: row.enabled === 1, remark: row.remark,
    lastRunAt: row.last_run_at, lastStatus: row.last_status, lastError: row.last_error,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function putSetting(c: Context<AppEnv>, key: string, value: string) {
  return c.get('db').execute(
    'INSERT INTO app_settings (key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at',
    [key, value, nowSeconds()],
  );
}

export function optimizeRoutes() {
  const routes = new Hono<AppEnv>();

  routes.use('/api/v1/optimize/*', async (c, next) => {
    requireSql(c);
    await next();
  });

  routes.get('/api/v1/optimize/settings', requireSession, async (c) => {
    requireAdmin(c);
    const settings = await readOptimizeSettings(c.get('db'));
    return c.json({ code: 0, api: settings.api, minMinutes: settings.minMinutes, keyConfigured: Boolean(settings.key) });
  });

  routes.put('/api/v1/optimize/settings', requireSession, requireCsrf, async (c) => {
    requireAdmin(c);
    const body = await input(c);
    const api = body.api === undefined ? null : body.api === '0' || body.api === '1' || body.api === '2' ? body.api : undefined;
    if (api === undefined) throw new AppError(400, '不支持的 IP 优选接口', 'INVALID_OPTIMIZE_API');
    if (api === '0') {
      const current = await readOptimizeSettings(c.get('db'));
      const key = typeof body.key === 'string' ? body.key.trim() : '';
      if (!key && !current.key) throw new AppError(400, 'wetest.vip 接口需要填写密钥', 'OPTIMIZE_KEY_REQUIRED');
    }
    const minMinutes = body.minMinutes === undefined ? null : boundedInteger(body.minMinutes, 60, 10, 1440, 'INVALID_OPTIMIZE_INTERVAL');
    if (api) await putSetting(c, OPTIMIZE_API, api);
    if (typeof body.key === 'string' && body.key.trim()) await putSetting(c, OPTIMIZE_KEY, body.key.trim().slice(0, 200));
    if (minMinutes !== null) await putSetting(c, OPTIMIZE_MIN, String(minMinutes));
    const settings = await readOptimizeSettings(c.get('db'));
    await c.get('db').execute(
      'INSERT INTO audit_logs (user_id,action,target,detail,created_at) VALUES (?,?,?,?,?)',
      [c.get('principal').user.id, 'optimize.settings', 'system', `api=${settings.api} min=${settings.minMinutes}`, nowSeconds()],
    );
    return c.json({ code: 0, api: settings.api, minMinutes: settings.minMinutes, keyConfigured: Boolean(settings.key) });
  });

  routes.post('/api/v1/optimize/credit', requireSession, requireCsrf, async (c) => {
    requireAdmin(c);
    const body = await input(c);
    const current = await readOptimizeSettings(c.get('db'));
    const api = body.api === '0' || body.api === '1' || body.api === '2' ? body.api : current.api;
    const submitted = typeof body.key === 'string' ? body.key.trim() : '';
    const key = (submitted || current.key).slice(0, 200);
    const count = await fetchOptimizeCredit(c.env.BUDGET.fetch, api, key);
    await c.get('db').execute(
      'INSERT INTO audit_logs (user_id,action,target,detail,created_at) VALUES (?,?,?,?,?)',
      [c.get('principal').user.id, 'optimize.credit', 'system', `api=${api},count=${count}`, nowSeconds()],
    );
    return c.json({ code: 0, count, msg: `当前积分余额：${count}` });
  });

  routes.get('/api/v1/optimize/tasks', requireSession, async (c) => {
    requireAdmin(c);
    const rows = await c.get('db').query<TaskViewRow>(`${TASK_LIST} ORDER BY t.id DESC`);
    return c.json({ code: 0, items: rows.map(view) });
  });

  routes.get('/api/v1/optimize/lines', requireSession, async (c) => {
    requireAdmin(c);
    const domainId = numericId(c.req.query('domainId'), '域名');
    const rows = await c.get('db').query<{
      id: number; name: string; third_id: string | null; account_id: number; type: string; config_cipher: string;
    }>(
      `SELECT d.id,d.name,d.third_id,d.account_id,a.type,a.config_cipher
       FROM dns_domains d JOIN dns_accounts a ON a.id=d.account_id WHERE d.id=?`, [domainId],
    );
    const row = rows[0];
    if (!row || !row.third_id) throw new AppError(404, 'DNS 域名不存在或尚未同步', 'OPTIMIZE_ZONE_NOT_FOUND');
    let config: Record<string, string>;
    try { config = JSON.parse(await decrypt(row.config_cipher, c.env.APP_KEY, `dns-account/${row.account_id}`)) as Record<string, string>; }
    catch { throw new AppError(503, 'DNS 账户凭据不可用', 'DNS_ACCOUNT_CONFIG_UNAVAILABLE'); }
    const provider = createProvider(row.type, config, c.env.BUDGET.fetch);
    const zone: DnsDomain = { id: row.third_id, name: row.name, recordCount: 0 };
    const lines = await provider.recordLines(zone);
    return c.json({ code: 0, lines: lines ?? [] });
  });

  routes.post('/api/v1/optimize/tasks', requireSession, requireCsrf, async (c) => {
    requireAdmin(c);
    const body = await input(c);
    const domainId = numericId(body.domainId, '域名');
    const domains = await c.get('db').query<{ id: number }>('SELECT id FROM dns_domains WHERE id=?', [domainId]);
    if (!domains[0]) throw new AppError(404, '域名不存在', 'DOMAIN_NOT_FOUND');
    const rr = recordName(body.rr);
    if (body.recordType !== 'A' && body.recordType !== 'AAAA') {
      throw new AppError(400, '记录类型只能是 A 或 AAAA', 'INVALID_OPTIMIZE_RECORD_TYPE');
    }
    const group = ipGroup(body.ipGroup);
    const cdnType = boundedInteger(body.cdnType ?? 1, 1, 1, 4, 'INVALID_OPTIMIZE_CDN');
    const recordCount = boundedInteger(body.recordCount ?? 2, 2, 1, 50, 'INVALID_OPTIMIZE_COUNT');
    const ttl = boundedInteger(body.ttl ?? 600, 600, 1, 86400, 'INVALID_OPTIMIZE_TTL');
    const line = lineValue(body.line);
    const now = nowSeconds();
    const duplicate = await c.get('db').query<{ id: number }>(
      'SELECT id FROM optimize_ip_tasks WHERE domain_id=? AND rr=? AND record_type=? AND ip_group=? AND line=?',
      [domainId, rr, body.recordType, group, line],
    );
    if (duplicate[0]) throw new AppError(409, '相同域名、记录与线路的优选任务已存在', 'OPTIMIZE_TASK_EXISTS');
    const created = await c.get('db').execute(
      `INSERT INTO optimize_ip_tasks
        (domain_id,rr,record_type,ip_group,cdn_type,record_count,ttl,line,enabled,remark,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,1,?,?,?) RETURNING id`,
      [domainId, rr, body.recordType, group, cdnType, recordCount, ttl, line,
        typeof body.remark === 'string' ? body.remark.trim().slice(0, 200) || null : null, now, now],
    );
    const taskId = Number(created.rows[0]?.id ?? 0);
    await c.get('db').execute(
      'INSERT INTO audit_logs (user_id,action,target,detail,created_at) VALUES (?,?,?,?,?)',
      [c.get('principal').user.id, 'optimize.task.create', String(domainId), `${rr} ${body.recordType} ${group}`, now],
    );
    return c.json({ code: 0, id: taskId });
  });

  routes.patch('/api/v1/optimize/tasks/:id', requireSession, requireCsrf, async (c) => {
    requireAdmin(c);
    const taskId = numericId(c.req.param('id'), '优选任务');
    const body = await input(c);
    const rows = await c.get('db').query<OptimizeTaskRow>('SELECT * FROM optimize_ip_tasks WHERE id=?', [taskId]);
    const task = rows[0];
    if (!task) throw new AppError(404, '优选任务不存在', 'OPTIMIZE_TASK_NOT_FOUND');
    if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
      throw new AppError(400, '启用状态无效', 'INVALID_OPTIMIZE_STATUS');
    }
    const recordCount = body.recordCount === undefined ? task.record_count : boundedInteger(body.recordCount, 2, 1, 50, 'INVALID_OPTIMIZE_COUNT');
    const ttl = body.ttl === undefined ? task.ttl : boundedInteger(body.ttl, 600, 1, 86400, 'INVALID_OPTIMIZE_TTL');
    const enabled = body.enabled === undefined ? task.enabled : body.enabled ? 1 : 0;
    const remark = body.remark === undefined ? task.remark : typeof body.remark === 'string' ? body.remark.trim().slice(0, 200) || null : null;
    await c.get('db').execute(
      'UPDATE optimize_ip_tasks SET enabled=?,record_count=?,ttl=?,remark=?,updated_at=? WHERE id=?',
      [enabled, recordCount, ttl, remark, nowSeconds(), taskId],
    );
    await c.get('db').execute(
      'INSERT INTO audit_logs (user_id,action,target,detail,created_at) VALUES (?,?,?,?,?)',
      [c.get('principal').user.id, 'optimize.task.update', String(taskId), `enabled=${enabled} count=${recordCount} ttl=${ttl}`, nowSeconds()],
    );
    return c.json({ code: 0, id: taskId, enabled: enabled === 1, recordCount, ttl });
  });

  routes.delete('/api/v1/optimize/tasks/:id', requireSession, requireCsrf, async (c) => {
    requireAdmin(c);
    const taskId = numericId(c.req.param('id'), '优选任务');
    const rows = await c.get('db').query<{ id: number }>('SELECT id FROM optimize_ip_tasks WHERE id=?', [taskId]);
    if (!rows[0]) throw new AppError(404, '优选任务不存在', 'OPTIMIZE_TASK_NOT_FOUND');
    await c.get('db').execute('DELETE FROM optimize_ip_tasks WHERE id=?', [taskId]);
    await c.get('db').execute(
      'INSERT INTO audit_logs (user_id,action,target,detail,created_at) VALUES (?,?,?,?,?)',
      [c.get('principal').user.id, 'optimize.task.delete', String(taskId), 'deleted', nowSeconds()],
    );
    return c.json({ code: 0 });
  });

  routes.post('/api/v1/optimize/tasks/:id/run', requireSession, requireCsrf, async (c) => {
    requireAdmin(c);
    const taskId = numericId(c.req.param('id'), '优选任务');
    const task = await loadOptimizeTask(c, taskId);
    const result = await runOptimizeTask(c, task);
    await c.get('db').execute(
      'INSERT INTO audit_logs (user_id,action,target,detail,created_at) VALUES (?,?,?,?,?)',
      [c.get('principal').user.id, 'optimize.task.run', String(taskId), result.detail.slice(0, 200), nowSeconds()],
    );
    return c.json({ code: 0, ...result });
  });

  routes.post('/api/v1/optimize/run', requireSession, requireCsrf, async (c) => {
    requireAdmin(c);
    const result = await executeOptimizeDue(c);
    await c.get('db').execute(
      'INSERT INTO audit_logs (user_id,action,target,detail,created_at) VALUES (?,?,?,?,?)',
      [c.get('principal').user.id, 'optimize.run', 'system', result.detail.slice(0, 200), nowSeconds()],
    );
    return c.json({ code: 0, ...result });
  });

  routes.get('/optimizeip/status', async (c) => {
    requireSql(c);
    const rows = await c.get('db').query<{ last_run_at: number | null }>(
      'SELECT MAX(last_run_at) AS last_run_at FROM optimize_ip_tasks WHERE enabled = 1',
    );
    const last = Number(rows[0]?.last_run_at ?? 0);
    return c.text(last > 0 && nowSeconds() - last <= 3600 ? 'ok' : 'error');
  });

  return routes;
}
