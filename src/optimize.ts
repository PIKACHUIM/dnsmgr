import type { Context } from 'hono';
import type { AppEnv } from './core/types';
import type { SqlDatabase, SqlValue } from './storage/sql';
import { AppError } from './core/errors';
import { decrypt } from './security/crypto';
import { nowSeconds } from './security/auth';
import { createProvider } from './dns/registry';
import type { DnsDomain } from './dns/types';

export const OPTIMIZE_API = 'optimize_ip_api';
export const OPTIMIZE_KEY = 'optimize_ip_key';
export const OPTIMIZE_MIN = 'optimize_ip_min';
export const OPTIMIZE_LAST = 'optimize_ip_time';

export type IpGroup = 'DEF' | 'CT' | 'CU' | 'CM';
export type IpVersion = 'v4' | 'v6';

export interface OptimizeSettings {
  api: '0' | '1' | '2';
  key: string;
  minMinutes: number;
}

export interface OptimizeTaskRow extends Record<string, unknown> {
  id: number;
  domain_id: number;
  rr: string;
  record_type: 'A' | 'AAAA';
  ip_group: IpGroup;
  cdn_type: number;
  record_count: number;
  ttl: number;
  line: string;
  enabled: number;
  remark: string | null;
  last_run_at: number | null;
  last_status: string | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
  zone_name: string;
  zone_third_id: string;
  account_id: number;
  account_type: string;
  config_cipher: string;
}

const IPV4 = /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const IPV6 = /^[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,7}$/i;

export function isIpAddress(value: string, version: IpVersion): boolean {
  return version === 'v4' ? IPV4.test(value) : IPV6.test(value) && value.includes(':');
}

export function normalizeOptimizeSettings(values: Map<string, string>): OptimizeSettings {
  const api = values.get(OPTIMIZE_API);
  const rawMin = Number(values.get(OPTIMIZE_MIN) ?? 60);
  return {
    api: api === '0' || api === '1' ? api : '2',
    key: values.get(OPTIMIZE_KEY) ?? '',
    minMinutes: Number.isInteger(rawMin) && rawMin >= 10 && rawMin <= 1440 ? rawMin : 60,
  };
}

export async function readOptimizeSettings(db: SqlDatabase): Promise<OptimizeSettings> {
  const rows = await db.query<{ key: string; value: string }>(
    'SELECT key,value FROM app_settings WHERE key IN (?,?,?)', [OPTIMIZE_API, OPTIMIZE_KEY, OPTIMIZE_MIN],
  );
  return normalizeOptimizeSettings(new Map(rows.map((row) => [row.key, row.value])));
}

function collectIps(info: unknown, version: IpVersion, label: string): string[] {
  if (!info || typeof info !== 'object' || Array.isArray(info)) return [];
  const entry = (info as Record<string, unknown>)[label];
  if (!Array.isArray(entry)) return [];
  const ips: string[] = [];
  for (const item of entry) {
    const value = typeof item === 'string' ? item : item && typeof item === 'object' && !Array.isArray(item)
      ? (item as Record<string, unknown>).ip : undefined;
    if (typeof value === 'string' && isIpAddress(value, version) && !ips.includes(value)) ips.push(value);
    if (ips.length >= 50) break;
  }
  return ips;
}

async function readJson(response: Response): Promise<unknown> {
  const body = await response.text();
  if (body.length > 256 * 1024) throw new AppError(502, 'IP 优选接口响应过大', 'OPTIMIZE_SOURCE_INVALID');
  try { return JSON.parse(body); } catch { throw new AppError(502, 'IP 优选接口响应格式无效', 'OPTIMIZE_SOURCE_INVALID'); }
}

const CDN_SLUG: Record<number, string> = {
  1: 'get_cloudflare_ip', 2: 'get_cloudfront_ip', 3: 'get_gcore_ip', 4: 'get_edgeone_ip',
};

/** 从公开优选接口读取各线路 IP，返回值已去重并限制数量。 */
export async function fetchOptimizedIps(
  fetcher: typeof fetch, settings: OptimizeSettings, cdnType: number, version: IpVersion,
): Promise<Record<IpGroup, string[]>> {
  const empty: Record<IpGroup, string[]> = { DEF: [], CT: [], CU: [], CM: [] };
  if (settings.api === '2') {
    if (version === 'v6') throw new AppError(400, '当前 IP 源不支持 IPv6', 'OPTIMIZE_SOURCE_UNSUPPORTED');
    const response = await fetcher('https://raw.githubusercontent.com/xingpingcn/enhanced-FaaS-in-China/refs/heads/main/Cf.json', {
      signal: AbortSignal.timeout(20_000), redirect: 'error',
    });
    if (!response.ok) throw new AppError(502, `IP 优选接口返回 HTTP ${response.status}`, 'OPTIMIZE_SOURCE_FAILED');
    const payload = await readJson(response);
    const result = (payload as { Cf?: { result?: Record<string, unknown> } })?.Cf?.result;
    return {
      ...empty,
      CT: collectIps(result, version, 'dianxin'),
      CU: collectIps(result, version, 'liantong'),
      CM: collectIps(result, version, 'yidong'),
    };
  }
  const url = settings.api === '1'
    ? 'https://api.hostmonit.com/get_optimization_ip'
    : `https://www.wetest.vip/api/cf2dns/${CDN_SLUG[cdnType] ?? CDN_SLUG[1]}`;
  if (settings.api === '0' && !settings.key) {
    throw new AppError(400, '请先在优选设置中填写接口密钥', 'OPTIMIZE_KEY_REQUIRED');
  }
  const response = await fetcher(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=UTF-8' },
    body: JSON.stringify({ key: settings.key, type: version }),
    signal: AbortSignal.timeout(20_000),
    redirect: 'error',
  });
  if (!response.ok) throw new AppError(502, `IP 优选接口返回 HTTP ${response.status}`, 'OPTIMIZE_SOURCE_FAILED');
  const payload = await readJson(response);
  const record = payload as { code?: unknown; info?: unknown; msg?: unknown };
  if (record.code !== 200) {
    const message = typeof record.info === 'string' ? record.info : typeof record.msg === 'string' ? record.msg : '未知错误';
    throw new AppError(502, `获取优选 IP 失败：${message}`, 'OPTIMIZE_SOURCE_FAILED');
  }
  const info = record.info;
  return {
    ...empty,
    DEF: collectIps(info, version, 'DEF'),
    CT: collectIps(info, version, 'CT'),
    CU: collectIps(info, version, 'CU'),
    CM: collectIps(info, version, 'CM'),
  };
}

/** 读取数据源剩余积分。xingpingcn 为免费源，没有积分概念。 */
export async function fetchOptimizeCredit(
  fetcher: typeof fetch, api: OptimizeSettings['api'], key: string,
): Promise<number> {
  if (api === '2') {
    throw new AppError(400, 'xingpingcn.top 接口免费使用，无需密钥，也没有积分限制', 'OPTIMIZE_CREDIT_NOT_APPLICABLE');
  }
  if (!key) throw new AppError(400, '请先填写接口密钥', 'OPTIMIZE_KEY_REQUIRED');
  const url = api === '1'
    ? `https://api.hostmonit.com/get_license?license=${encodeURIComponent(key)}`
    : `https://www.wetest.vip/api/cf2dns/get_license?license=${encodeURIComponent(key)}`;
  const response = await fetcher(url, { method: 'GET', signal: AbortSignal.timeout(15_000), redirect: 'error' });
  if (!response.ok) throw new AppError(502, `积分查询接口返回 HTTP ${response.status}`, 'OPTIMIZE_CREDIT_FAILED');
  const payload = await readJson(response) as { code?: unknown; count?: unknown; info?: unknown };
  if (Number(payload.code) === 200 && payload.count !== undefined && Number.isFinite(Number(payload.count))) {
    return Number(payload.count);
  }
  const info = typeof payload.info === 'string' ? payload.info : '';
  throw new AppError(502, info ? `获取剩余请求次数失败：${info}` : '获取剩余请求次数失败', 'OPTIMIZE_CREDIT_FAILED');
}

const TASK_SELECT = `SELECT t.*,d.name AS zone_name,d.third_id AS zone_third_id,d.account_id,a.type AS account_type,a.config_cipher
  FROM optimize_ip_tasks t
  JOIN dns_domains d ON d.id=t.domain_id
  JOIN dns_accounts a ON a.id=d.account_id`;
export async function loadOptimizeTask(c: Context<AppEnv>, taskId: number): Promise<OptimizeTaskRow> {
  const rows = await c.get('db').query<OptimizeTaskRow>(`${TASK_SELECT} WHERE t.id=?`, [taskId]);
  if (!rows[0]) throw new AppError(404, '优选任务不存在', 'OPTIMIZE_TASK_NOT_FOUND');
  return rows[0];
}

export interface OptimizeRunResult {
  added: number;
  updated: number;
  removed: number;
  unchanged: number;
  partial: boolean;
  desired: number;
}

export async function executeOptimizeTask(c: Context<AppEnv>, task: OptimizeTaskRow): Promise<OptimizeRunResult> {
  if (!task.zone_third_id) throw new AppError(400, '优选任务所在域名尚未同步到本系统', 'OPTIMIZE_ZONE_UNSYNCED');
  let config: Record<string, string>;
  try {
    config = JSON.parse(await decrypt(task.config_cipher, c.env.APP_KEY, `dns-account/${task.account_id}`)) as Record<string, string>;
  } catch {
    throw new AppError(503, 'DNS 账户凭据不可用', 'DNS_ACCOUNT_CONFIG_UNAVAILABLE');
  }
  const provider = createProvider(task.account_type, config, c.env.BUDGET.fetch);
  const zone: DnsDomain = { id: task.zone_third_id, name: task.zone_name, recordCount: 0 };
  const settings = await readOptimizeSettings(c.get('db'));
  const version: IpVersion = task.record_type === 'AAAA' ? 'v6' : 'v4';
  const groups = await fetchOptimizedIps(c.env.BUDGET.fetch, settings, task.cdn_type, version);
  const source = groups[task.ip_group].length > 0 ? groups[task.ip_group] : groups.CT;
  const desired = source.slice(0, task.record_count);
  if (desired.length === 0) throw new AppError(502, 'IP 优选接口未返回可用地址', 'OPTIMIZE_SOURCE_EMPTY');

  const existing = (await provider.listRecords(zone, { page: 1, pageSize: 100, name: task.rr, type: task.record_type }))
    .items.filter((record) => record.line === task.line && record.type === task.record_type)
    .slice(0, 100);
  const result: OptimizeRunResult = { added: 0, updated: 0, removed: 0, unchanged: 0, partial: false, desired: desired.length };
  const writes: (() => Promise<void>)[] = [];
  for (let index = 0; index < desired.length; index += 1) {
    const ip = desired[index]!;
    const record = existing[index];
    if (!record) {
      writes.push(async () => {
        await provider.addRecord(zone, {
          name: task.rr, type: task.record_type, value: ip, line: task.line, ttl: task.ttl,
          mx: null, weight: null, remark: null,
        });
        result.added += 1;
      });
      continue;
    }
    if (record.value === ip) {
      result.unchanged += 1;
      continue;
    }
    writes.push(async () => {
      await provider.updateRecord(zone, record.id, {
        name: task.rr, type: task.record_type, value: ip, line: task.line, ttl: task.ttl,
        mx: record.mx, weight: record.weight, remark: record.remark,
      });
      result.updated += 1;
    });
  }
  for (const record of existing.slice(desired.length)) {
    writes.push(async () => {
      await provider.deleteRecord(zone, record.id);
      result.removed += 1;
    });
  }
  const budget = 5;
  for (const write of writes.slice(0, budget)) await write();
  result.partial = writes.length > budget;
  return result;
}

function taskClaimStatement(task: OptimizeTaskRow) {
  return {
    sql: 'UPDATE optimize_ip_tasks SET last_run_at=?,last_status=?,last_error=NULL,updated_at=? WHERE id=?',
    args: [nowSeconds(), 'running', nowSeconds(), task.id] as SqlValue[],
  };
}

export async function runOptimizeTask(
  c: Context<AppEnv>, task: OptimizeTaskRow,
): Promise<{ ok: boolean; detail: string; result?: OptimizeRunResult }> {
  const claim = taskClaimStatement(task);
  const claimed = await c.get('db').execute(claim.sql, claim.args);
  if (claimed.changes !== 1) throw new AppError(409, '优选任务正在运行', 'OPTIMIZE_TASK_IN_FLIGHT');
  try {
    const result = await executeOptimizeTask(c, task);
    const detail = `新增 ${result.added}、更新 ${result.updated}、删除 ${result.removed}、保持 ${result.unchanged}`
      + (result.partial ? '（写入次数达到单次上限，下一次继续）' : '');
    await c.get('db').execute(
      'UPDATE optimize_ip_tasks SET last_status=?,last_error=?,updated_at=? WHERE id=?',
      [result.partial ? 'partial' : 'succeeded', null, nowSeconds(), task.id],
    );
    return { ok: true, detail, result };
  } catch (error) {
    const detail = error instanceof AppError ? error.message : '优选任务执行失败';
    await c.get('db').execute(
      'UPDATE optimize_ip_tasks SET last_status=?,last_error=?,updated_at=? WHERE id=?',
      ['failed', detail.slice(0, 200), nowSeconds(), task.id],
    );
    return { ok: false, detail };
  }
}

export async function executeOptimizeDue(c: Context<AppEnv>): Promise<{ ran: number; detail: string }> {
  const settings = await readOptimizeSettings(c.get('db'));
  const rows = await c.get('db').query<{ value: string }>('SELECT value FROM app_settings WHERE key=?', [OPTIMIZE_LAST]);
  const last = Number(rows[0]?.value ?? 0);
  if (Number.isFinite(last) && last > nowSeconds() - settings.minMinutes * 60) {
    return { ran: 0, detail: '优选任务尚未到下次执行时间' };
  }
  const due = await c.get('db').query<OptimizeTaskRow>(
    `${TASK_SELECT} WHERE t.enabled=1 AND (t.last_run_at IS NULL OR t.last_run_at<=?) ORDER BY t.last_run_at IS NULL DESC, t.last_run_at ASC, t.id ASC LIMIT 1`,
    [nowSeconds() - settings.minMinutes * 60],
  );
  if (!due[0]) return { ran: 0, detail: '没有到期的优选任务' };
  await c.get('db').execute(
    'INSERT INTO app_settings (key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at',
    [OPTIMIZE_LAST, String(nowSeconds()), nowSeconds()],
  );
  const result = await runOptimizeTask(c, due[0]);
  return { ran: 1, detail: result.detail };
}
