import { Hono, type Context } from 'hono';
import type { AppEnv } from '../core/types';
import { AppError } from '../core/errors';
import { input, text } from '../core/request';
import { requireAdmin, requireCsrf, requireSession, nowSeconds, consumeRateLimit } from '../security/auth';
import { decrypt, encrypt } from '../security/crypto';
import { createProvider } from '../dns/registry';
import { DnsError, type DnsDomain, type DnsRecord } from '../dns/types';
import type { SqlDatabase } from '../storage/sql';
import { executeFailoverDue, normalizeProbeUrl, validateFailoverValue } from '../schedule/failover';

interface DomainRow extends Record<string, unknown> {
  id: number;
  name: string;
  account_id: number;
  third_id: string | null;
  account_type: string;
  config_cipher: string;
}

function db(c: Context<AppEnv>): SqlDatabase {
  return c.get('db');
}

function requireSql(c: Context<AppEnv>): void {
  if (c.get('storage').config.format !== 'sql') {
    throw new AppError(501, '当前存储格式尚未支持容灾任务，请使用 DB_FORMAT=sql', 'STORAGE_FORMAT_UNSUPPORTED');
  }
}

function positiveId(value: string): number {
  if (!/^[1-9]\d{0,9}$/.test(value)) throw new AppError(400, '编号无效', 'INVALID_ID');
  return Number(value);
}

function providerFailure(error: unknown): never {
  if (error instanceof DnsError) {
    const status = [400, 401, 403, 404, 409, 429].includes(error.status)
      ? error.status as 400 | 401 | 403 | 404 | 409 | 429 : 503;
    throw new AppError(status, error.message, error.code);
  }
  throw error;
}

async function writeAudit(c: Context<AppEnv>, action: string, target: string, detail: string): Promise<void> {
  await db(c).execute(
    'INSERT INTO audit_logs (user_id, action, target, detail, created_at) VALUES (?,?,?,?,?)',
    [c.get('principal').user.id, action, target.slice(0, 255), detail.slice(0, 500), nowSeconds()],
  );
}

function recordValueEqual(type: string, left: string, right: string): boolean {
  const normalize = (value: string) => type === 'CNAME' ? value.replace(/\.$/, '').toLowerCase() : value;
  return normalize(left) === normalize(right);
}

function integer(body: Record<string, unknown>, key: string, min: number, max: number): number {
  const value = Number(body[key]);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new AppError(400, `${key} 必须在 ${min}–${max} 之间`, 'INVALID_FAILOVER_SETTING');
  }
  return value;
}

function pageParams(c: Context<AppEnv>): { page: number; pageSize: number } {
  const pageRaw = c.req.query('page') ?? '1';
  const sizeRaw = c.req.query('pageSize') ?? '50';
  if (!/^\d{1,7}$/.test(pageRaw) || !/^\d{1,3}$/.test(sizeRaw)) throw new AppError(400, '分页参数无效', 'INVALID_PAGINATION');
  const page = Math.max(1, Number(pageRaw));
  const pageSize = Math.min(100, Math.max(1, Number(sizeRaw)));
  return { page, pageSize };
}

export function failoverRoutes() {
  const routes = new Hono<AppEnv>();

  routes.get('/api/v1/failover/tasks', requireSession, async (c) => {
    requireSql(c);
    requireAdmin(c);
    const { page, pageSize } = pageParams(c);
    const rows = await db(c).query<Record<string, unknown>>(
      `SELECT t.*, d.name AS domain_name, a.type AS account_type
       FROM dns_failover_tasks t JOIN dns_domains d ON d.id = t.domain_id
       JOIN dns_accounts a ON a.id = d.account_id ORDER BY t.id DESC LIMIT ? OFFSET ?`,
      [pageSize, (page - 1) * pageSize],
    );
    const totals = await db(c).query<{ total: number }>('SELECT COUNT(*) AS total FROM dns_failover_tasks');
    return c.json({
      code: 0, page, pageSize, total: Number(totals[0]?.total ?? 0),
      items: rows.map((row) => ({
        id: row.id, domainId: row.domain_id, domainName: row.domain_name, accountType: row.account_type,
        recordId: row.record_id, recordName: row.record_name, recordType: row.record_type,
        mainValue: row.main_value, backupValue: row.backup_value,
        intervalSeconds: row.interval_seconds, timeoutSeconds: row.timeout_seconds,
        failureThreshold: row.failure_threshold, consecutiveCount: row.consecutive_count,
        currentBackup: row.current_backup === 1, active: row.active === 1,
        nextCheckAt: row.next_check_at, lastCheckAt: row.last_check_at,
        lastHttpStatus: row.last_http_status, lastLatencyMs: row.last_latency_ms, lastError: row.last_error,
      })),
    });
  });

  routes.post('/api/v1/failover/tasks', requireSession, requireCsrf, async (c) => {
    requireSql(c);
    requireAdmin(c);
    await consumeRateLimit(c, `failover:create:${c.get('principal').user.id}`, 20, 60);
    const body = await input(c);
    const domainId = Number(body.domainId);
    if (!Number.isSafeInteger(domainId) || domainId < 1) throw new AppError(400, '域名编号无效', 'INVALID_ID');
    const domains = await db(c).query<DomainRow>(
      `SELECT d.id, d.name, d.account_id, d.third_id, a.type AS account_type, a.config_cipher
       FROM dns_domains d JOIN dns_accounts a ON a.id = d.account_id WHERE d.id = ?`, [domainId],
    );
    const domainRow = domains[0];
    if (!domainRow) throw new AppError(404, '域名不存在', 'DOMAIN_NOT_FOUND');
    const recordId = text(body, 'recordId', 255).trim();
    if (!/^[A-Za-z0-9_.|@:*-]{1,255}$/.test(recordId)) throw new AppError(400, '记录编号无效', 'INVALID_RECORD_ID');
    const recordType = text(body, 'recordType', 8).trim().toUpperCase();
    const recordName = text(body, 'recordName', 253).trim();
    if (!['A', 'AAAA', 'CNAME'].includes(recordType)) throw new AppError(400, '仅支持 A、AAAA、CNAME 记录', 'INVALID_RECORD_TYPE');
    const mainValue = text(body, 'mainValue', 253).trim();
    const backupValue = text(body, 'backupValue', 253).trim();
    if (!validateFailoverValue(recordType, mainValue) || !validateFailoverValue(recordType, backupValue)) {
      throw new AppError(400, '主备地址必须是对应记录类型的公网地址', 'INVALID_RECORD_VALUE');
    }
    if (recordValueEqual(recordType, mainValue, backupValue)) throw new AppError(400, '主备地址不能相同', 'INVALID_RECORD_VALUE');
    const checkUrl = normalizeProbeUrl(text(body, 'checkUrl', 512).trim());
    const intervalSeconds = integer(body, 'intervalSeconds', 30, 86400);
    const timeoutSeconds = integer(body, 'timeoutSeconds', 1, 30);
    const failureThreshold = integer(body, 'failureThreshold', 1, 10);
    if (timeoutSeconds >= intervalSeconds) throw new AppError(400, '探测超时必须小于检测间隔', 'INVALID_FAILOVER_SETTING');
    const duplicate = await db(c).query<{ id: number }>(
      'SELECT id FROM dns_failover_tasks WHERE domain_id = ? AND record_id = ?', [domainId, recordId],
    );
    if (duplicate[0]) throw new AppError(409, '该解析记录已有容灾任务', 'FAILOVER_TASK_EXISTS');

    let config: Record<string, string>;
    try { config = JSON.parse(await decrypt(domainRow.config_cipher, c.env.APP_KEY, `dns-account/${domainRow.account_id}`)) as Record<string, string>; }
    catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(503, 'DNS 账户凭据损坏，无法解密', 'ACCOUNT_CORRUPTED');
    }
    const provider = createProvider(domainRow.account_type, config, c.env.BUDGET.fetch);
    const dnsDomain: DnsDomain = { id: domainRow.third_id ?? '', name: domainRow.name, recordCount: 0 };
    let record: DnsRecord | undefined;
    try {
      const page = await provider.listRecords(dnsDomain, { page: 1, pageSize: 100, name: recordName, type: recordType });
      record = page.items.find((item) => item.id === recordId && item.name === recordName && item.type === recordType);
    } catch (error) { providerFailure(error); }
    if (!record) throw new AppError(404, '解析记录不存在或不在当前域名中', 'DNS_RECORD_NOT_FOUND');
    if (record.status !== 1) throw new AppError(409, '请先启用该解析记录，再创建容灾任务', 'DNS_RECORD_DISABLED');
    const currentIsMain = recordValueEqual(recordType, record.value, mainValue);
    const currentIsBackup = recordValueEqual(recordType, record.value, backupValue);
    if (!currentIsMain && !currentIsBackup) {
      throw new AppError(409, '当前解析值必须与主地址或备用地址一致', 'DNS_RECORD_VALUE_MISMATCH');
    }
    const now = nowSeconds();
    const checkUrlCipher = await encrypt(checkUrl, c.env.APP_KEY, `dns-failover/${domainId}/${recordId}`);
    const result = await db(c).execute(
      `INSERT INTO dns_failover_tasks
       (domain_id, record_id, record_name, record_type, main_value, backup_value, check_url_cipher,
        interval_seconds, timeout_seconds, failure_threshold, current_backup, line, ttl, mx, weight, remark,
        active, next_check_at, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?) RETURNING id`,
      [domainId, recordId, record.name, recordType, mainValue, backupValue, checkUrlCipher,
        intervalSeconds, timeoutSeconds, failureThreshold, currentIsBackup ? 1 : 0,
        record.line || 'default', record.ttl, record.mx, record.weight, record.remark, now, now, now],
    );
    const taskId = Number(result.rows[0]?.id);
    await writeAudit(c, 'failover.create', domainRow.name, `${record.name} ${recordType}`);
    return c.json({ code: 0, id: taskId, nextCheckAt: now });
  });

  routes.get('/api/v1/failover/tasks/:id/logs', requireSession, async (c) => {
    requireSql(c);
    requireAdmin(c);
    const taskId = positiveId(c.req.param('id'));
    const { page, pageSize } = pageParams(c);
    const exists = await db(c).query<{ id: number }>('SELECT id FROM dns_failover_tasks WHERE id = ?', [taskId]);
    if (!exists[0]) throw new AppError(404, '容灾任务不存在', 'TASK_NOT_FOUND');
    const items = await db(c).query<Record<string, unknown>>(
      `SELECT id, event, probe_ok, http_status, latency_ms, message, created_at
       FROM dns_failover_logs WHERE task_id = ? ORDER BY id DESC LIMIT ? OFFSET ?`,
      [taskId, pageSize, (page - 1) * pageSize],
    );
    const totals = await db(c).query<{ total: number }>('SELECT COUNT(*) AS total FROM dns_failover_logs WHERE task_id = ?', [taskId]);
    return c.json({ code: 0, page, pageSize, total: Number(totals[0]?.total ?? 0), items });
  });

  routes.post('/api/v1/failover/tasks/:id/run', requireSession, requireCsrf, async (c) => {
    requireSql(c);
    requireAdmin(c);
    const taskId = positiveId(c.req.param('id'));
    const tasks = await db(c).query<{ domain_name: string; active: number }>(
      `SELECT d.name AS domain_name, t.active FROM dns_failover_tasks t
       JOIN dns_domains d ON d.id = t.domain_id WHERE t.id = ?`, [taskId],
    );
    const task = tasks[0];
    if (!task) throw new AppError(404, '容灾任务不存在', 'TASK_NOT_FOUND');
    if (task.active !== 1) throw new AppError(409, '请先启用容灾任务', 'TASK_DISABLED');
    const now = nowSeconds();
    const requested = await db(c).execute(
      'UPDATE dns_failover_tasks SET next_check_at = ?, updated_at = ? WHERE id = ? AND active = 1 AND lease_until <= ?',
      [now, now, taskId, now],
    );
    if (requested.changes !== 1) throw new AppError(409, '该容灾任务正在执行，请稍后再试', 'TASK_RUNNING');
    const result = await executeFailoverDue(c, 1, taskId);
    await writeAudit(c, 'failover.manual', task.domain_name, `checked=${result.checked}`);
    return c.json({ code: 0, ...result });
  });

  routes.patch('/api/v1/failover/tasks/:id', requireSession, requireCsrf, async (c) => {
    requireSql(c);
    requireAdmin(c);
    const taskId = positiveId(c.req.param('id'));
    const body = await input(c);
    if (typeof body.active !== 'boolean') throw new AppError(400, '状态参数无效', 'INVALID_STATUS');
    const now = nowSeconds();
    const next = await db(c).execute(
      'UPDATE dns_failover_tasks SET active = ?, next_check_at = ?, updated_at = ? WHERE id = ?',
      [body.active ? 1 : 0, body.active ? now : 0, now, taskId],
    );
    if (next.changes !== 1) throw new AppError(404, '容灾任务不存在', 'TASK_NOT_FOUND');
    await writeAudit(c, 'failover.toggle', String(taskId), body.active ? 'on' : 'off');
    return c.json({ code: 0 });
  });

  routes.delete('/api/v1/failover/tasks/:id', requireSession, requireCsrf, async (c) => {
    requireSql(c);
    requireAdmin(c);
    const taskId = positiveId(c.req.param('id'));
    const tasks = await db(c).query<{ domain_name: string }>(
      'SELECT d.name AS domain_name FROM dns_failover_tasks t JOIN dns_domains d ON d.id = t.domain_id WHERE t.id = ?', [taskId],
    );
    if (!tasks[0]) throw new AppError(404, '容灾任务不存在', 'TASK_NOT_FOUND');
    await db(c).execute('DELETE FROM dns_failover_logs WHERE task_id = ?', [taskId]);
    await db(c).execute('DELETE FROM dns_failover_tasks WHERE id = ?', [taskId]);
    await writeAudit(c, 'failover.delete', tasks[0].domain_name, String(taskId));
    return c.json({ code: 0 });
  });

  return routes;
}
