import type { Context } from 'hono';
import type { AppEnv } from '../core/types';
import { AppError } from '../core/errors';
import { DnsError, type DnsDomain, type DnsRecordInput } from '../dns/types';
import { createProvider } from '../dns/registry';
import { decrypt } from '../security/crypto';
import type { SqlDatabase } from '../storage/sql';
import { parseConfig, sendCustomWebhook } from '../notify/custom';

interface FailoverTask extends Record<string, unknown> {
  id: number;
  domain_id: number;
  domain_name: string;
  third_id: string | null;
  account_id: number;
  record_id: string;
  record_name: string;
  record_type: string;
  main_value: string;
  backup_value: string;
  check_url_cipher: string;
  interval_seconds: number;
  timeout_seconds: number;
  failure_threshold: number;
  consecutive_count: number;
  current_backup: number;
  line: string;
  ttl: number;
  mx: number | null;
  weight: number | null;
  remark: string | null;
  next_check_at: number;
  lease_until: number;
}

interface ProbeResult {
  ok: boolean;
  httpStatus: number | null;
  latencyMs: number;
  error: string | null;
}

function db(c: Context<AppEnv>): SqlDatabase {
  return c.get('db');
}

function ipv4Parts(host: string): number[] | null {
  const parts = host.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return null;
  const values = parts.map(Number);
  return values.every((part) => part >= 0 && part <= 255) ? values : null;
}

function publicIpv4(host: string): boolean {
  const parts = ipv4Parts(host);
  if (!parts) return false;
  const [a, b, c] = parts as [number, number, number, number];
  return !(
    a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b! >= 64 && b! <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b! >= 16 && b! <= 31)
    || (a === 192 && (b === 0 || b === 168))
    || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
    || (a === 203 && b === 0 && c === 113)
  );
}

function ipv6Words(host: string): number[] | null {
  if (!host.includes(':') || host.includes('%')) return null;
  const halves = host.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0]!.split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1]!.split(':') : [];
  if ([...left, ...right].some((word) => !/^[\da-f]{1,4}$/i.test(word))) return null;
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
  return [...left.map((word) => Number.parseInt(word, 16)), ...Array(missing).fill(0), ...right.map((word) => Number.parseInt(word, 16))];
}

function publicIpv6(host: string): boolean {
  const words = ipv6Words(host);
  if (!words) return false;
  const first = words[0]!;
  if (first < 0x2000 || first > 0x3fff) return false;
  if (first === 0x2001 && (words[1] === 0 || words[1] === 0x0db8)) return false;
  if (first === 0x2002) return false;
  return true;
}

export function normalizeProbeUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new AppError(400, '探测地址格式无效', 'INVALID_PROBE_URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hostname === '') {
    throw new AppError(400, '探测地址仅支持无凭据的 HTTP/HTTPS 公网地址', 'INVALID_PROBE_URL');
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  const ipv4 = ipv4Parts(host);
  if (ipv4) {
    if (!publicIpv4(host)) throw new AppError(400, '探测地址不能指向私有或保留 IP', 'INVALID_PROBE_URL');
  } else if (host.includes(':')) {
    if (!publicIpv6(host)) throw new AppError(400, '探测地址不能指向私有或保留 IP', 'INVALID_PROBE_URL');
  } else if (
    !host.includes('.') || host === 'localhost' || host === 'metadata'
    || /\.(?:localhost|local|internal|test|invalid|example|home\.arpa)$/.test(host)
  ) {
    throw new AppError(400, '探测地址必须使用公网主机名', 'INVALID_PROBE_URL');
  }
  url.hash = '';
  return url.toString();
}

export function validateFailoverValue(type: string, value: string): boolean {
  if (type === 'A') return publicIpv4(value);
  if (type === 'AAAA') return publicIpv6(value);
  if (type === 'CNAME') {
    const name = value.replace(/\.$/, '');
    return name.length <= 253 && name.includes('.')
      && name.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label));
  }
  return false;
}

export async function probeHttp(
  value: string,
  timeoutSeconds: number,
  fetchImpl: typeof fetch,
): Promise<ProbeResult> {
  const url = normalizeProbeUrl(value);
  const started = Date.now();
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      redirect: 'manual',
      headers: { accept: '*/*', 'user-agent': 'DnsMgr-HealthCheck/1.0' },
      signal: AbortSignal.timeout(timeoutSeconds * 1000),
    });
    const httpStatus = response.status;
    try { await response.body?.cancel(); } catch { /* response body is not used */ }
    return {
      ok: httpStatus < 400,
      httpStatus,
      latencyMs: Math.max(0, Date.now() - started),
      error: httpStatus < 400 ? null : `http_code=${httpStatus}`,
    };
  } catch (error) {
    if (error instanceof AppError && ['REQUEST_BUDGET_EXCEEDED', 'REQUEST_TIMEOUT'].includes(error.reason)) throw error;
    return {
      ok: false,
      httpStatus: null,
      latencyMs: Math.max(0, Date.now() - started),
      error: error instanceof Error && error.name === 'TimeoutError' ? '探测超时' : '探测连接失败',
    };
  }
}

function errorText(error: unknown): string {
  if (error instanceof AppError) return error.message;
  if (error instanceof DnsError) return `DNS 服务商更新失败（${error.code}）`;
  return 'DNS 服务商更新失败';
}

function batchLimit(c: Context<AppEnv>): number {
  if (c.env.RUNTIME.platform === 'esa') return 1;
  return c.env.RUNTIME.platform === 'cloudflare' ? 8 : 15;
}

async function updateRecord(c: Context<AppEnv>, task: FailoverTask, value: string): Promise<void> {
  const rows = await db(c).query<{ type: string; config_cipher: string }>(
    'SELECT type, config_cipher FROM dns_accounts WHERE id = ?', [task.account_id],
  );
  const account = rows[0];
  if (!account) throw new Error('DNS 账户不存在');
  let config: Record<string, string>;
  try { config = JSON.parse(await decrypt(account.config_cipher, c.env.APP_KEY, `dns-account/${task.account_id}`)) as Record<string, string>; }
  catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(503, 'DNS 账户凭据损坏，无法解密', 'ACCOUNT_CORRUPTED');
  }
  const provider = createProvider(account.type, config, c.env.BUDGET.fetch);
  const domain: DnsDomain = { id: task.third_id ?? '', name: task.domain_name, recordCount: 0 };
  const record: DnsRecordInput = {
    name: task.record_name, type: task.record_type, value,
    line: task.line || 'default', ttl: task.ttl, mx: task.mx,
    weight: task.weight, remark: task.remark,
  };
  await provider.updateRecord(domain, task.record_id, record);
}

async function sendTransitionNotice(c: Context<AppEnv>, task: FailoverTask, event: 'switch_backup' | 'recover_main', value: string): Promise<void> {
  try {
    const rows = await db(c).query<{ key: string; value: string }>("SELECT key, value FROM app_settings WHERE key LIKE 'custom_webhook_%'");
    const config = parseConfig(Object.fromEntries(rows.map((row) => [row.key, row.value])));
    if (!config) return;
    const title = event === 'switch_backup' ? 'DNSMGR 容灾切换至备用' : 'DNSMGR 容灾已恢复主线路';
    const content = `${task.domain_name} ${task.record_name} ${task.record_type} → ${value}`;
    await sendCustomWebhook(config, title, content, c.env.BUDGET.fetch);
  } catch { /* notification failure does not change DNS task state */ }
}

export async function executeFailoverDue(
  c: Context<AppEnv>,
  requestedLimit?: number,
  taskId?: number,
): Promise<{ checked: number; switched: number; failed: number }> {
  const limit = Math.max(1, Math.min(requestedLimit ?? batchLimit(c), batchLimit(c)));
  const now = Math.floor(Date.now() / 1000);
  const taskFilter = taskId === undefined ? '' : ' AND t.id = ?';
  const args = taskId === undefined ? [now, now, limit] : [now, now, taskId, limit];
  const tasks = await db(c).query<FailoverTask>(
    `SELECT t.*, d.name AS domain_name, d.third_id, d.account_id
     FROM dns_failover_tasks t JOIN dns_domains d ON d.id = t.domain_id
     WHERE t.active = 1 AND t.next_check_at <= ? AND t.lease_until <= ?${taskFilter}
     ORDER BY t.next_check_at ASC LIMIT ?`, args,
  );
  let checked = 0;
  let switched = 0;
  let failed = 0;
  for (const task of tasks) {
    const claimed = await db(c).execute(
      'UPDATE dns_failover_tasks SET next_check_at = ?, lease_until = ?, updated_at = ? WHERE id = ? AND active = 1 AND next_check_at = ? AND lease_until <= ?',
      [now + task.interval_seconds, now + task.timeout_seconds + 30, now, task.id, task.next_check_at, now],
    );
    if (claimed.changes !== 1) continue;
    checked += 1;
    let probe: ProbeResult | null = null;
    let nextState = task.current_backup;
    let nextCount = task.consecutive_count;
    let event = 'runtime_error';
    let message: string | null = null;
    let stateChanged = false;
    let taskFailed = false;
    try {
      const checkUrl = await decrypt(task.check_url_cipher, c.env.APP_KEY, `dns-failover/${task.domain_id}/${task.record_id}`);
      probe = await probeHttp(checkUrl, task.timeout_seconds, c.env.BUDGET.fetch);
      const shouldRecover = task.current_backup === 1 && probe.ok;
      const shouldFailover = task.current_backup === 0 && !probe.ok;
      nextCount = shouldRecover || shouldFailover ? task.consecutive_count + 1 : 0;
      const transition = nextCount >= task.failure_threshold;
      if (transition) {
        const stillActive = await db(c).query<{ active: number }>('SELECT active FROM dns_failover_tasks WHERE id = ?', [task.id]);
        if (stillActive[0]?.active === 1) {
          const targetState = task.current_backup === 0 ? 1 : 0;
          const targetValue = targetState === 1 ? task.backup_value : task.main_value;
          try {
            await updateRecord(c, task, targetValue);
            nextState = targetState;
            nextCount = 0;
            stateChanged = true;
            event = targetState === 1 ? 'switch_backup' : 'recover_main';
            message = probe.error;
          } catch (error) {
            nextCount = task.failure_threshold;
            event = 'dns_update_failed';
            message = `DNS 更新失败：${errorText(error)}`;
            taskFailed = true;
          }
        } else {
          event = probe.ok ? 'healthy' : 'unhealthy';
          message = probe.error;
        }
      } else {
        event = probe.ok ? 'healthy' : 'unhealthy';
        message = probe.error;
      }
    } catch (error) {
      message = errorText(error);
      nextCount = task.consecutive_count;
      taskFailed = true;
    }
    const completedAt = Math.floor(Date.now() / 1000);
    if (probe && !probe.ok) taskFailed = true;
    if (taskFailed) failed += 1;
    await db(c).execute(
      `UPDATE dns_failover_tasks
       SET current_backup = ?, consecutive_count = ?, lease_until = 0, next_check_at = ?, last_check_at = ?,
           last_http_status = ?, last_latency_ms = ?, last_error = ?, updated_at = ?
       WHERE id = ?`,
      [nextState, nextCount, completedAt + task.interval_seconds, completedAt,
        probe?.httpStatus ?? null, probe?.latencyMs ?? null, message, completedAt, task.id],
    );
    await db(c).execute(
      'INSERT INTO dns_failover_logs (task_id, event, probe_ok, http_status, latency_ms, message, created_at) VALUES (?,?,?,?,?,?,?)',
      [task.id, event, probe ? (probe.ok ? 1 : 0) : null, probe?.httpStatus ?? null, probe?.latencyMs ?? null, message, completedAt],
    );
    await db(c).execute(
      'DELETE FROM dns_failover_logs WHERE id IN (SELECT id FROM dns_failover_logs WHERE task_id = ? ORDER BY id DESC LIMIT -1 OFFSET 500)',
      [task.id],
    );
    if (stateChanged) {
      switched += 1;
      await db(c).execute(
        'INSERT INTO audit_logs (user_id, action, target, detail, created_at) VALUES (?,?,?,?,?)',
        [0, event, task.domain_name, `${task.record_name} ${task.record_type} → ${nextState === 1 ? task.backup_value : task.main_value}`.slice(0, 500), completedAt],
      );
      await sendTransitionNotice(c, task, event as 'switch_backup' | 'recover_main', nextState === 1 ? task.backup_value : task.main_value);
    }
  }
  return { checked, switched, failed };
}
