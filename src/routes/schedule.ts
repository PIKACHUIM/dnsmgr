import { Hono, type Context } from 'hono';
import type { AppEnv } from '../core/types';
import { AppError } from '../core/errors';
import { input, text } from '../core/request';
import { requireAdmin, requireCsrf, requireSession, nowSeconds } from '../security/auth';
import { decrypt } from '../security/crypto';
import { createProvider } from '../dns/registry';
import { DnsError, type DnsDomain, type DnsRecordInput } from '../dns/types';
import { type SqlDatabase } from '../storage/sql';
import { nextRunAt, parseRunTime, type ScheduleMode, type ScheduleTaskRow } from '../schedule/tasks';
import { sendConfiguredNotifications } from '../notify/settings';
import { executeFailoverDue } from '../schedule/failover';
import {
  executeExpirationNotice, executeInitialExpirationRefresh, executePeriodicExpirationRefresh,
  EXPIRATION_NOTICE_CHANNELS, EXPIRATION_NOTICE_CHANNELS_SETTING, parseExpirationNoticeChannels,
  type ExpirationNoticeChannels,
} from '../schedule/expiration';
import {
  CERT_RENEW_DAYS, CERT_RENEW_ENABLED, executeCertificateRenewal, readCertificateRenewSettings,
} from '../schedule/certificate';
import { CERT_NOTIFY_ENABLED, deliverQueuedNotifications } from '../notify/certificate';
import { executeDeployDue } from '../deploy';
import { executeOptimizeDue } from '../optimize';

interface AccountRow extends Record<string, unknown> {
  id: number;
  type: string;
  name: string;
  config_cipher: string;
}

interface TaskRow extends ScheduleTaskRow {
  [key: string]: unknown;
  domain_name: string;
  account_id: number;
  third_id: string | null;
  account_type: string;
}

function db(c: Context<AppEnv>): SqlDatabase {
  return c.get('db');
}

function requireSql(c: Context<AppEnv>): void {
  if (c.get('storage').config.format !== 'sql') {
    throw new AppError(501, '当前存储格式尚未支持任务业务表，请使用 DB_FORMAT=sql', 'STORAGE_FORMAT_UNSUPPORTED');
  }
}

function id(value: string): number {
  if (!/^[1-9]\d{0,9}$/.test(value)) throw new AppError(400, '编号无效', 'INVALID_ID');
  return Number(value);
}

async function getSetting(c: Context<AppEnv>, key: string): Promise<string | null> {
  const rows = await db(c).query<{ value: string }>('SELECT value FROM app_settings WHERE key = ?', [key]);
  return rows[0]?.value ?? null;
}

async function putSetting(c: Context<AppEnv>, key: string, value: string): Promise<void> {
  await db(c).execute(
    'INSERT INTO app_settings (key, value, updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at',
    [key, value, nowSeconds()],
  );
}

function newCronKey(): string {
  return crypto.randomUUID().replace(/-/g, '');
}

function safeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return diff === 0;
}

function normalizeExpirationNoticeDays(value: unknown): string {
  if (typeof value !== 'string' || value.length > 256) {
    throw new AppError(400, '到期提醒天数格式无效', 'INVALID_EXPIRATION_NOTICE_DAYS');
  }
  const rawDays = value.trim();
  if (!rawDays) return '';
  const entries = rawDays.split(',').map((entry) => entry.trim());
  if (entries.length > 32 || entries.some((entry) => !/^\d{1,4}$/.test(entry))) {
    throw new AppError(400, '请用英文逗号分隔 0–3650 之间的提醒天数（最多 32 项）', 'INVALID_EXPIRATION_NOTICE_DAYS');
  }
  const days = [...new Set(entries.map(Number))];
  if (days.some((day) => day > 3650)) {
    throw new AppError(400, '提醒天数必须在 0–3650 之间', 'INVALID_EXPIRATION_NOTICE_DAYS');
  }
  return days.sort((left, right) => left - right).join(',');
}

function normalizeExpirationNoticeChannels(value: unknown): ExpirationNoticeChannels {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppError(400, '到期提醒渠道配置格式无效', 'INVALID_EXPIRATION_NOTICE_CHANNELS');
  }
  const source = value as Record<string, unknown>;
  if (Object.keys(source).length !== EXPIRATION_NOTICE_CHANNELS.length || EXPIRATION_NOTICE_CHANNELS.some((channel) => typeof source[channel] !== 'boolean')) {
    throw new AppError(400, '到期提醒渠道配置必须包含全部渠道开关', 'INVALID_EXPIRATION_NOTICE_CHANNELS');
  }
  return Object.fromEntries(EXPIRATION_NOTICE_CHANNELS.map((channel) => [channel, source[channel]])) as ExpirationNoticeChannels;
}

async function audit(c: Context<AppEnv>, action: string, target: string, detail: string): Promise<void> {
  const principal = c.get('principal') as { user?: { id: number } } | undefined;
  await db(c).execute(
    'INSERT INTO audit_logs (user_id, action, target, detail, created_at) VALUES (?,?,?,?,?)',
    [principal?.user?.id ?? 0, action, target.slice(0, 255), detail.slice(0, 500), nowSeconds()],
  );
}

async function providerFor(c: Context<AppEnv>, account: AccountRow) {
  let config: unknown;
  try {
    config = JSON.parse(await decrypt(account.config_cipher, c.env.APP_KEY, `dns-account/${account.id}`));
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(503, 'DNS 账户凭据损坏，无法解密', 'ACCOUNT_CORRUPTED');
  }
  return createProvider(account.type, config as Record<string, string>, c.env.BUDGET?.fetch ?? fetch);
}

function taskParams(body: Record<string, unknown>): {
  recordName: string; recordType: string; recordId: string | null; switchType: number;
  mode: ScheduleMode; runTime: string; runDate: string | null; weekday: number | null;
  monthDay: number | null; value: string | null; line: string | null; ttl: number | null;
  mx: number | null; remark: string | null;
} {
  const recordName = text(body, 'recordName', 128).trim();
  if (!/^(?:@|\*|(?:\*\.)?[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?(?:\.[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?)*)$/i.test(recordName)) {
    throw new AppError(400, '主机记录格式无效', 'INVALID_RECORD_NAME');
  }
  const recordType = text(body, 'recordType', 16).trim().toUpperCase();
  if (!recordType) throw new AppError(400, '记录类型不能为空', 'INVALID_RECORD_TYPE');
  const recordIdRaw = typeof body.recordId === 'string' ? body.recordId.trim() : '';
  if (recordIdRaw && !/^[A-Za-z0-9_.|@:*\-]{1,255}$/.test(recordIdRaw)) throw new AppError(400, '记录编号无效', 'INVALID_RECORD_ID');
  const switchType = Number(body.switchType);
  if (![0, 1, 2, 3].includes(switchType)) throw new AppError(400, '切换类型无效', 'INVALID_SWITCH_TYPE');
  if (switchType !== 0 && !recordIdRaw) throw new AppError(400, '启用、暂停或删除解析时必须提供记录编号', 'INVALID_RECORD_ID');
  const mode = text(body, 'mode', 16) as ScheduleMode;
  if (!['once', 'daily', 'weekly', 'monthly'].includes(mode)) throw new AppError(400, '调度模式无效', 'INVALID_MODE');
  const runTime = text(body, 'runTime', 5).trim();
  if (!parseRunTime(runTime)) throw new AppError(400, '执行时间格式应为 HH:mm', 'INVALID_RUN_TIME');
  const runDate = mode === 'once' ? text(body, 'runDate', 10).trim() : null;
  if (mode === 'once' && !/^\d{4}-\d{2}-\d{2}$/.test(runDate ?? '')) throw new AppError(400, '一次性任务需要 YYYY-MM-DD 日期', 'INVALID_RUN_DATE');
  const weekday = mode === 'weekly' ? Number(body.weekday) : null;
  if (mode === 'weekly' && (!Number.isInteger(weekday) || weekday! < 0 || weekday! > 6)) throw new AppError(400, '星期值应为 0–6', 'INVALID_WEEKDAY');
  const monthDay = mode === 'monthly' ? Number(body.monthDay) : null;
  if (mode === 'monthly' && (!Number.isInteger(monthDay) || monthDay! < 1 || monthDay! > 31)) throw new AppError(400, '日期应为 1–31', 'INVALID_MONTH_DAY');
  const value = typeof body.value === 'string' ? body.value.trim().slice(0, 2048) : '';
  if (switchType === 0 && !value) throw new AppError(400, '修改记录值时必须填写新值', 'INVALID_RECORD_VALUE');
  const line = typeof body.line === 'string' && body.line.trim() ? body.line.trim().slice(0, 64) : null;
  const ttlRaw = body.ttl === undefined || body.ttl === null || body.ttl === '' ? null : Number(body.ttl);
  if (ttlRaw !== null && (!Number.isSafeInteger(ttlRaw) || ttlRaw < 1 || ttlRaw > 86400)) throw new AppError(400, 'TTL 必须在 1–86400 之间', 'INVALID_TTL');
  const mxRaw = body.mx === undefined || body.mx === null || body.mx === '' ? null : Number(body.mx);
  if (mxRaw !== null && (!Number.isSafeInteger(mxRaw) || mxRaw < 0 || mxRaw > 65535)) throw new AppError(400, 'MX 优先级无效', 'INVALID_MX');
  const remark = typeof body.remark === 'string' ? body.remark.trim().slice(0, 100) || null : null;
  return {
    recordName, recordType, recordId: recordIdRaw || null, switchType, mode, runTime,
    runDate, weekday, monthDay, value: value || null, line, ttl: ttlRaw, mx: mxRaw, remark,
  };
}

function specOf(task: { mode: ScheduleMode; run_time: string; run_date: string | null; weekday: number | null; month_day: number | null }) {
  return { mode: task.mode, runTime: task.run_time, runDate: task.run_date, weekday: task.weekday, monthDay: task.month_day };
}

async function offsetMinutes(c: Context<AppEnv>): Promise<number> {
  const raw = await getSetting(c, 'schedule_tz_offset');
  const parsed = Number(raw ?? 480);
  return Number.isFinite(parsed) && Math.abs(parsed) <= 840 ? parsed : 480;
}

/** 旧版证书部署时间窗：0–23 时，按 cron 时区偏移换算。 */
async function readDeployWindowSettings(db: SqlDatabase): Promise<{ deployStart: number; deployEnd: number }> {
  const rows = await db.query<{ key: string; value: string }>(
    "SELECT key,value FROM app_settings WHERE key IN ('deploy_hour_start','deploy_hour_end')",
  );
  const values = new Map(rows.map((row) => [row.key, row.value]));
  const bounded = (raw: string | undefined, fallback: number) => {
    const parsed = Number(raw);
    return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= 23 ? parsed : fallback;
  };
  return {
    deployStart: bounded(values.get('deploy_hour_start'), 0),
    deployEnd: bounded(values.get('deploy_hour_end'), 23),
  };
}

async function notifyFailure(c: Context<AppEnv>, domain: string, message: string): Promise<void> {
  try {
    await sendConfiguredNotifications(c, 'DNSMGR 定时任务失败', `域名 ${domain}：${message}`);
  } catch { /* 通知失败不影响任务结果 */ }
}

async function executeDue(c: Context<AppEnv>, limit = 20): Promise<{ ran: number; failed: number }> {
  const now = nowSeconds();
  const due = await db(c).query<TaskRow>(
    `SELECT t.*, d.name AS domain_name, d.account_id, d.third_id, a.type AS account_type
     FROM dns_schedule_tasks t
     JOIN dns_domains d ON d.id = t.domain_id
     JOIN dns_accounts a ON a.id = d.account_id
     WHERE t.active = 1 AND t.next_run_at > 0 AND t.next_run_at <= ?
     ORDER BY t.next_run_at ASC LIMIT ?`, [now, limit],
  );
  const offset = await offsetMinutes(c);
  let ran = 0;
  let failed = 0;
  for (const task of due) {
    const claimed = await db(c).execute(
      'UPDATE dns_schedule_tasks SET next_run_at = ?, updated_at = ? WHERE id = ? AND next_run_at = ?',
      [now + 300, now, task.id, task.next_run_at],
    );
    if (claimed.changes !== 1) continue;
    let errorMessage: string | null = null;
    try {
      const accountRows = await db(c).query<AccountRow>('SELECT * FROM dns_accounts WHERE id = ?', [task.account_id]);
      const account = accountRows[0];
      if (!account) throw new Error('DNS 账户不存在');
      const provider = await providerFor(c, account);
      const domain: DnsDomain = { id: task.third_id ?? '', name: task.domain_name, recordCount: 0 };
      if (task.switch_type === 0) {
        const recordId = task.record_id;
        if (!recordId) throw new Error('缺少记录编号');
        const record: DnsRecordInput = {
          name: task.record_name, type: task.record_type, value: task.value ?? '',
          line: task.line || 'default', ttl: task.ttl ?? 600, mx: task.mx,
          weight: null, remark: null,
        };
        await provider.updateRecord(domain, recordId, record);
      } else if (task.switch_type === 1 || task.switch_type === 2) {
        if (!task.record_id) throw new Error('缺少记录编号');
        await provider.setRecordStatus(domain, task.record_id, task.switch_type === 1);
      } else {
        if (!task.record_id) throw new Error('缺少记录编号');
        await provider.deleteRecord(domain, task.record_id);
      }
      ran++;
    } catch (error) {
      failed++;
      errorMessage = error instanceof DnsError || error instanceof Error ? error.message.slice(0, 500) : '未知错误';
    }
    const finalNow = nowSeconds();
    let next: number | null = null;
    if (!errorMessage) {
      try { next = nextRunAt(specOf(task), finalNow, offset); }
      catch { next = null; }
    }
    await db(c).execute(
      'UPDATE dns_schedule_tasks SET next_run_at = ?, active = ?, last_run_at = ?, last_error = ?, updated_at = ? WHERE id = ?',
      [errorMessage ? finalNow + 300 : next ?? 0, errorMessage ? 1 : next === null ? 0 : 1, finalNow, errorMessage, finalNow, task.id],
    );
    if (errorMessage) await notifyFailure(c, task.domain_name, errorMessage);
    await db(c).execute(
      'INSERT INTO audit_logs (user_id, action, target, detail, created_at) VALUES (?,?,?,?,?)',
      [0, errorMessage ? 'schedule.failed' : 'schedule.run', task.domain_name.slice(0, 255),
        `${task.record_name} ${task.record_type} type=${task.switch_type}${errorMessage ? ` ${errorMessage}` : ''}`.slice(0, 500), finalNow],
    );
  }
  return { ran, failed };
}

export function scheduleRoutes() {
  const routes = new Hono<AppEnv>();

  routes.get('/cron', async (c) => {
    requireSql(c);
    const key = c.req.query('key') ?? '';
    const enabled = await getSetting(c, 'cron_enabled');
    const expected = await getSetting(c, 'cron_key');
    if (enabled !== '1' || !expected) return c.text('未开启当前方式');
    if (!key || !safeEqual(key, expected)) return c.text('访问密钥错误');
    await executeFailoverDue(c);
    await executeDue(c);
    const initialRefreshRan = await executeInitialExpirationRefresh(c);
    const periodicRefreshRan = initialRefreshRan ? false : await executePeriodicExpirationRefresh(c);
    if (!initialRefreshRan && !periodicRefreshRan) await executeExpirationNotice(c, await offsetMinutes(c));
    try { await executeCertificateRenewal(c.env, db(c)); } catch { /* 预算不足时由下一次 cron 继续 */ }
    try { await executeDeployDue(c, 2); } catch { /* 部署失败由运行记录与通知反馈 */ }
    try { await executeOptimizeDue(c); } catch { /* IP 优选失败记录在任务状态中 */ }
    try { await deliverQueuedNotifications(c.env, db(c), 3); } catch { /* 通知发送失败不影响调度任务 */ }
    return c.text('success!');
  });

  routes.get('/api/v1/system/expiration-notice', requireSession, async (c) => {
    requireSql(c);
    requireAdmin(c);
    const stored = await getSetting(c, 'expire_noticedays');
    const channels = parseExpirationNoticeChannels(await getSetting(c, EXPIRATION_NOTICE_CHANNELS_SETTING));
    return c.json({ code: 0, days: normalizeExpirationNoticeDays(stored ?? ''), channels });
  });

  routes.put('/api/v1/system/expiration-notice', requireSession, requireCsrf, async (c) => {
    requireSql(c);
    requireAdmin(c);
    const body = await input(c);
    const days = normalizeExpirationNoticeDays(body.days);
    const channels = body.channels === undefined
      ? parseExpirationNoticeChannels(await getSetting(c, EXPIRATION_NOTICE_CHANNELS_SETTING))
      : normalizeExpirationNoticeChannels(body.channels);
    const updates = [{
      sql: 'INSERT INTO app_settings (key, value, updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at',
      args: ['expire_noticedays', days, nowSeconds()],
    }];
    if (body.channels !== undefined) updates.push({
      sql: 'INSERT INTO app_settings (key, value, updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at',
      args: [EXPIRATION_NOTICE_CHANNELS_SETTING, JSON.stringify(channels), nowSeconds()],
    });
    await db(c).batch(updates);
    await audit(c, 'expiration-notice.settings', 'system', `${days ? `days=${days}` : 'disabled'} channels=${EXPIRATION_NOTICE_CHANNELS.filter((channel) => channels[channel]).join(',') || 'none'}`);
    return c.json({ code: 0, days, channels });
  });

  routes.get('/api/v1/system/cron', requireSession, async (c) => {
    requireSql(c);
    requireAdmin(c);
    let key = await getSetting(c, 'cron_key');
    if (!key) {
      key = newCronKey();
      await putSetting(c, 'cron_key', key);
    }
    const enabled = (await getSetting(c, 'cron_enabled')) === '1';
    const offset = await offsetMinutes(c);
    return c.json({ code: 0, enabled, key, offset, url: `/cron?key=${key}` });
  });

  routes.put('/api/v1/system/cron', requireSession, requireCsrf, async (c) => {
    requireSql(c);
    requireAdmin(c);
    const body = await input(c);
    if (body.enabled !== undefined) await putSetting(c, 'cron_enabled', body.enabled === true ? '1' : '0');
    if (body.regenerate === true) await putSetting(c, 'cron_key', newCronKey());
    if (body.offset !== undefined) {
      const offset = Number(body.offset);
      if (!Number.isSafeInteger(offset) || Math.abs(offset) > 840) throw new AppError(400, '时区偏移应为 -840–840 分钟', 'INVALID_OFFSET');
      await putSetting(c, 'schedule_tz_offset', String(offset));
    }
    await audit(c, 'cron.settings', 'system', 'updated');
    const key = await getSetting(c, 'cron_key') ?? '';
    return c.json({
      code: 0, enabled: (await getSetting(c, 'cron_enabled')) === '1', key,
      offset: await offsetMinutes(c), url: `/cron?key=${key}`,
    });
  });

  routes.get('/api/v1/system/certificate-renew', requireSession, async (c) => {
    requireSql(c);
    requireAdmin(c);
    const window = await readDeployWindowSettings(db(c));
    return c.json({ code: 0, ...(await readCertificateRenewSettings(db(c))), ...window });
  });

  routes.put('/api/v1/system/certificate-renew', requireSession, requireCsrf, async (c) => {
    requireSql(c);
    requireAdmin(c);
    const body = await input(c);
    if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
      throw new AppError(400, '自动续签开关无效', 'INVALID_CERT_RENEW_SETTINGS');
    }
    if (body.notifyEnabled !== undefined && typeof body.notifyEnabled !== 'boolean') {
      throw new AppError(400, '证书通知开关无效', 'INVALID_CERT_RENEW_SETTINGS');
    }
    if (body.days !== undefined) {
      const days = Number(body.days);
      if (!Number.isSafeInteger(days) || days < 1 || days > 60) {
        throw new AppError(400, '到期前续签天数应为 1–60', 'INVALID_CERT_RENEW_SETTINGS');
      }
      await putSetting(c, CERT_RENEW_DAYS, String(days));
    }
    if (body.enabled !== undefined) await putSetting(c, CERT_RENEW_ENABLED, body.enabled ? '1' : '0');
    if (body.notifyEnabled !== undefined) await putSetting(c, CERT_NOTIFY_ENABLED, body.notifyEnabled ? '1' : '0');
    if (body.deployStart !== undefined || body.deployEnd !== undefined) {
      const current = await readDeployWindowSettings(db(c));
      const start = Number(body.deployStart ?? current.deployStart);
      const end = Number(body.deployEnd ?? current.deployEnd);
      if (!Number.isSafeInteger(start) || start < 0 || start > 23
        || !Number.isSafeInteger(end) || end < 0 || end > 23) {
        throw new AppError(400, '部署时间窗应为 0–23 时', 'INVALID_CERT_RENEW_SETTINGS');
      }
      await putSetting(c, 'deploy_hour_start', String(start));
      await putSetting(c, 'deploy_hour_end', String(end));
    }
    await audit(c, 'certificate-renew.settings', 'system', `enabled=${String(body.enabled ?? 'unchanged')} days=${String(body.days ?? 'unchanged')} notify=${String(body.notifyEnabled ?? 'unchanged')}`);
    return c.json({ code: 0, ...(await readCertificateRenewSettings(db(c))), ...(await readDeployWindowSettings(db(c))) });
  });

  routes.post('/api/v1/system/certificate-renew/run', requireSession, requireCsrf, async (c) => {
    requireSql(c);
    requireAdmin(c);
    const result = await executeCertificateRenewal(c.env, db(c));
    await audit(c, 'certificate-renew.manual', 'system', result.detail);
    return c.json({ code: 0, ...result });
  });

  routes.get('/api/v1/schedule/tasks', requireSession, async (c) => {
    requireSql(c);
    requireAdmin(c);
    const rows = await db(c).query<TaskRow>(
      `SELECT t.*, d.name AS domain_name, d.account_id, d.third_id, a.type AS account_type
       FROM dns_schedule_tasks t
       JOIN dns_domains d ON d.id = t.domain_id
       JOIN dns_accounts a ON a.id = d.account_id
       ORDER BY t.id DESC`,
    );
    return c.json({
      code: 0,
      items: rows.map((row) => ({
        id: row.id, domainId: row.domain_id, domainName: row.domain_name, accountType: row.account_type,
        recordId: row.record_id, recordName: row.record_name, recordType: row.record_type,
        switchType: row.switch_type, mode: row.mode, runDate: row.run_date, weekday: row.weekday,
        monthDay: row.month_day, runTime: row.run_time, value: row.value, line: row.line,
        ttl: row.ttl, mx: row.mx, remark: row.remark, active: row.active === 1,
        nextRunAt: row.next_run_at, lastRunAt: row.last_run_at, lastError: row.last_error,
      })),
    });
  });

  routes.post('/api/v1/schedule/tasks', requireSession, requireCsrf, async (c) => {
    requireSql(c);
    requireAdmin(c);
    const body = await input(c);
    const domainId = Number(body.domainId);
    if (!Number.isSafeInteger(domainId) || domainId < 1) throw new AppError(400, '域名编号无效', 'INVALID_ID');
    const domains = await db(c).query<{ id: number }>('SELECT id FROM dns_domains WHERE id = ?', [domainId]);
    if (!domains[0]) throw new AppError(404, '域名不存在', 'DOMAIN_NOT_FOUND');
    const params = taskParams(body);
    const now = nowSeconds();
    const offset = await offsetMinutes(c);
    const next = nextRunAt({
      mode: params.mode, runTime: params.runTime, runDate: params.runDate,
      weekday: params.weekday, monthDay: params.monthDay,
    }, now, offset);
    if (next === null) throw new AppError(400, '一次性任务的执行时间必须晚于当前时间', 'INVALID_RUN_DATE');
    const result = await db(c).execute(
      `INSERT INTO dns_schedule_tasks
       (domain_id, record_id, record_name, record_type, switch_type, mode, run_date, weekday, month_day, run_time,
        value, line, ttl, mx, remark, active, next_run_at, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
      [domainId, params.recordId, params.recordName, params.recordType, params.switchType, params.mode,
        params.runDate, params.weekday, params.monthDay, params.runTime, params.value, params.line,
        params.ttl, params.mx, params.remark, 1, next, now, now],
    );
    const created = Number(result.rows[0]?.id);
    await audit(c, 'schedule.create', String(domainId), `${params.recordName} ${params.mode} ${params.runTime}`);
    return c.json({ code: 0, id: created, nextRunAt: next });
  });

  routes.patch('/api/v1/schedule/tasks/:id', requireSession, requireCsrf, async (c) => {
    requireSql(c);
    requireAdmin(c);
    const taskId = id(c.req.param('id'));
    const body = await input(c);
    const rows = await db(c).query<TaskRow>('SELECT t.*, d.name AS domain_name, d.account_id, d.third_id, a.type AS account_type FROM dns_schedule_tasks t JOIN dns_domains d ON d.id=t.domain_id JOIN dns_accounts a ON a.id=d.account_id WHERE t.id = ?', [taskId]);
    const task = rows[0];
    if (!task) throw new AppError(404, '任务不存在', 'TASK_NOT_FOUND');
    if (typeof body.active !== 'boolean') throw new AppError(400, '状态参数无效', 'INVALID_STATUS');
    const now = nowSeconds();
    let next = task.next_run_at;
    if (body.active) {
      const computed = nextRunAt(specOf(task), now, await offsetMinutes(c));
      if (computed === null) throw new AppError(400, '一次性任务已过期，无法重新启用', 'TASK_EXPIRED');
      next = computed;
    }
    await db(c).execute('UPDATE dns_schedule_tasks SET active=?, next_run_at=?, updated_at=? WHERE id=?',
      [body.active ? 1 : 0, body.active ? next : task.next_run_at, now, taskId]);
    await audit(c, 'schedule.toggle', task.domain_name, `${taskId} ${body.active ? 'on' : 'off'}`);
    return c.json({ code: 0 });
  });

  routes.delete('/api/v1/schedule/tasks/:id', requireSession, requireCsrf, async (c) => {
    requireSql(c);
    requireAdmin(c);
    const taskId = id(c.req.param('id'));
    const rows = await db(c).query<{ domain_name: string }>('SELECT d.name AS domain_name FROM dns_schedule_tasks t JOIN dns_domains d ON d.id=t.domain_id WHERE t.id = ?', [taskId]);
    if (!rows[0]) throw new AppError(404, '任务不存在', 'TASK_NOT_FOUND');
    await db(c).execute('DELETE FROM dns_schedule_tasks WHERE id = ?', [taskId]);
    await audit(c, 'schedule.delete', rows[0].domain_name, String(taskId));
    return c.json({ code: 0 });
  });

  routes.post('/api/v1/schedule/run', requireSession, requireCsrf, async (c) => {
    requireSql(c);
    requireAdmin(c);
    const result = await executeDue(c, 50);
    await audit(c, 'schedule.manual', 'system', `${result.ran} ok, ${result.failed} failed`);
    return c.json({ code: 0, ...result });
  });

  return routes;
}
