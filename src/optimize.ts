import type { Context } from 'hono';
import type { AppEnv } from './core/types';
import type { SqlDatabase, SqlValue } from './storage/sql';
import { AppError } from './core/errors';
import { decrypt } from './security/crypto';
import { nowSeconds } from './security/auth';
import { createProvider } from './dns/registry';
import { lineCodeFor, supportsAutoLines, type LineGroup } from './dns/lines';
import type { DnsDomain, DnsProvider } from './dns/types';

export const OPTIMIZE_API = 'optimize_ip_api';
export const OPTIMIZE_KEY = 'optimize_ip_key';
export const OPTIMIZE_MIN = 'optimize_ip_min';
export const OPTIMIZE_PROXY = 'optimize_ip_proxy';
export const OPTIMIZE_LAST = 'optimize_ip_time';

/** 旧版 wetest.vip 的公开免费密钥，未填写密钥时沿用。 */
export const DEFAULT_OPTIMIZE_KEY = 'o1zrmHAF';
/** 线路填 `auto` 表示按数据源分组写入服务商的全部线路。 */
export const AUTO_LINE = 'auto';

export type IpGroup = LineGroup;
export type IpVersion = 'v4' | 'v6';

export interface OptimizeSettings {
  api: '0' | '1' | '2';
  key: string;
  minMinutes: number;
  /** xingpingcn 数据源可选的 http(s) 代理前缀，用于访问 raw.githubusercontent.com。 */
  proxy: string;
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
  const rawMin = Number(values.get(OPTIMIZE_MIN) ?? 30);
  return {
    api: api === '1' || api === '2' ? api : '0',
    key: values.get(OPTIMIZE_KEY) ?? '',
    minMinutes: Number.isInteger(rawMin) && rawMin >= 10 && rawMin <= 1440 ? rawMin : 30,
    proxy: values.get(OPTIMIZE_PROXY) ?? '',
  };
}

export async function readOptimizeSettings(db: SqlDatabase): Promise<OptimizeSettings> {
  const rows = await db.query<{ key: string; value: string }>(
    'SELECT key,value FROM app_settings WHERE key IN (?,?,?,?)', [OPTIMIZE_API, OPTIMIZE_KEY, OPTIMIZE_MIN, OPTIMIZE_PROXY],
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

/** 校验并归一化代理前缀：只接受 http/https，且只能作为路径前缀使用。 */
export function optimizeProxyPrefix(proxy: string): string {
  const value = proxy.trim();
  if (!value) return '';
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new AppError(400, '代理地址格式无效', 'INVALID_OPTIMIZE_PROXY'); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new AppError(400, '代理地址只支持 http/https', 'INVALID_OPTIMIZE_PROXY');
  }
  return value.replace(/\/+$/, '');
}

/** 从公开优选接口读取各线路 IP，返回值已去重并限制数量。 */
export async function fetchOptimizedIps(
  fetcher: typeof fetch, settings: OptimizeSettings, cdnType: number, version: IpVersion,
): Promise<Record<IpGroup, string[]>> {
  const empty: Record<IpGroup, string[]> = { DEF: [], CT: [], CU: [], CM: [] };
  if (settings.api === '2') {
    if (version === 'v6') throw new AppError(400, '当前 IP 源不支持 IPv6', 'OPTIMIZE_SOURCE_UNSUPPORTED');
    const prefix = optimizeProxyPrefix(settings.proxy);
    const target = prefix
      ? `${prefix}/xingpingcn/enhanced-FaaS-in-China/refs/heads/main/Cf.json`
      : 'https://raw.githubusercontent.com/xingpingcn/enhanced-FaaS-in-China/refs/heads/main/Cf.json';
    const response = await fetcher(target, {
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
  const key = settings.key || DEFAULT_OPTIMIZE_KEY;
  const response = await fetcher(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=UTF-8' },
    body: JSON.stringify({ key, type: version }),
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
  const license = key || DEFAULT_OPTIMIZE_KEY;
  const url = api === '1'
    ? `https://api.hostmonit.com/get_license?license=${encodeURIComponent(license)}`
    : `https://www.wetest.vip/api/cf2dns/get_license?license=${encodeURIComponent(license)}`;
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
  // 华为云一条记录可承载多个 IP，旧版把本线路的 IP 合并成单条记录。
  const merged = task.account_type === 'huawei';
  const result: OptimizeRunResult = { added: 0, updated: 0, removed: 0, unchanged: 0, partial: false, desired: 0 };
  const writes: (() => Promise<void>)[] = [];

  const desiredFor = (group: IpGroup): string[] => {
    const source = groups[group].length > 0 ? groups[group] : group === 'DEF' ? groups.CT : [];
    if (merged) {
      const mergedValue = [...source.slice(0, task.record_count)].sort().join(',');
      return mergedValue ? [mergedValue] : [];
    }
    return source.slice(0, task.record_count);
  };

  const targets = taskTargets(task);
  let matched = false;
  for (const target of targets) {
    const desired = desiredFor(target.group);
    if (desired.length === 0) continue;
    matched = true;
    result.desired += desired.length;
    await planLine(provider, zone, task, target.line, desired, merged, result, writes);
  }
  if (!matched) throw new AppError(502, 'IP 优选接口未返回可用地址', 'OPTIMIZE_SOURCE_EMPTY');

  const reserved = 2 + targets.length;
  const budget = Math.max(1, (c.env.RUNTIME?.maxFetches ?? 50) - reserved);
  for (const write of writes.slice(0, budget)) await write();
  result.partial = writes.length > budget;
  return result;
}

interface LineTarget { group: IpGroup; line: string }

/** 单个任务写入的线路：显式线路只写一条，`auto` 按分组写入服务商的全部线路。 */
export function taskTargets(task: OptimizeTaskRow): LineTarget[] {
  if (task.line !== AUTO_LINE) return [{ group: task.ip_group, line: task.line }];
  if (!supportsAutoLines(task.account_type)) {
    throw new AppError(400, '当前服务商不支持自动线路，请为任务指定 DNS 线路', 'OPTIMIZE_AUTO_LINE_UNSUPPORTED');
  }
  const targets: LineTarget[] = [];
  for (const group of ['DEF', 'CT', 'CU', 'CM'] as IpGroup[]) {
    const line = lineCodeFor(task.account_type, group);
    if (line !== null) targets.push({ group, line });
  }
  return targets;
}

async function planLine(
  provider: DnsProvider, zone: DnsDomain, task: OptimizeTaskRow, line: string, desired: string[],
  merged: boolean, result: OptimizeRunResult, writes: (() => Promise<void>)[],
): Promise<void> {
  const listed = await provider.listRecords(zone, { page: 1, pageSize: 100, name: task.rr });
  const sameLine = (value: string) => (value === '' ? 'default' : value) === line;
  const onLine = listed.items.filter((record) => sameLine(record.line));
  const cnames = onLine.filter((record) => record.type === 'CNAME');
  const existing = onLine.filter((record) => record.type === task.record_type).slice(0, 100);
  // 同一线路存在 CNAME 时无法再写入 A/AAAA，旧版会先删除这些 CNAME 记录。
  for (const record of cnames) {
    writes.push(async () => { await provider.deleteRecord(zone, record.id); });
  }
  const sameValue = (value: string) => merged
    ? value.split(',').map((item) => item.trim()).filter(Boolean).sort().join(',')
    : value;
  for (let index = 0; index < desired.length; index += 1) {
    const ip = desired[index]!;
    const record = existing[index];
    if (!record) {
      writes.push(async () => {
        await provider.addRecord(zone, {
          name: task.rr, type: task.record_type, value: ip, line, ttl: task.ttl,
          mx: null, weight: null, remark: null,
        });
        result.added += 1;
      });
      continue;
    }
    if (sameValue(record.value) === ip) {
      result.unchanged += 1;
      continue;
    }
    writes.push(async () => {
      await provider.updateRecord(zone, record.id, {
        name: task.rr, type: task.record_type, value: ip, line, ttl: task.ttl,
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
