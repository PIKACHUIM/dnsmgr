import { asArray, asRecord, num, sendJson } from '../dns/http';
import { DnsError } from '../dns/types';

export interface CloudflareApiConfig {
  apikey: string;
  email?: string;
  account_id?: string;
}

interface Envelope {
  success: boolean;
  errors?: Array<{ message?: string; code?: number }>;
  result?: unknown;
  result_info?: { total_count?: number; page?: number; per_page?: number };
}

const BASE = 'https://api.cloudflare.com/client/v4';

export function cloudflareApi(config: CloudflareApiConfig, fetchImpl: typeof fetch = fetch) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.email) {
    headers['X-Auth-Email'] = config.email;
    headers['X-Auth-Key'] = config.apikey;
  } else {
    headers.Authorization = `Bearer ${config.apikey}`;
  }

  async function call(method: string, path: string, body?: unknown, allowNotFound = false): Promise<unknown> {
    const response = await sendJson(fetchImpl, `${BASE}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (allowNotFound && response.status === 404) return null;
    const payload = asRecord(response.body);
    if (payload.success !== true) {
      const first = asArray(payload.errors)[0];
      const detail = first ? asRecord(first) : {};
      const message = typeof detail.message === 'string' && detail.message
        ? detail.message
        : `Cloudflare 请求失败（HTTP ${response.status}）`;
      const status = response.status === 401 || response.status === 403 || response.status === 404
        || response.status === 409 || response.status === 429 ? response.status : 502;
      throw new DnsError(message, status, status === 403 ? 'CF_FORBIDDEN' : 'CF_API_ERROR');
    }
    return payload.result;
  }

  async function accountId(): Promise<string> {
    const configured = typeof config.account_id === 'string' ? config.account_id.trim() : '';
    if (configured) return configured;
    const accounts = asArray(await call('GET', '/accounts?page=1&per_page=1')).map(asRecord);
    const resolved = String(accounts[0]?.id ?? '');
    if (resolved) return resolved;
    const zones = asArray(await call('GET', '/zones?page=1&per_page=1')).map(asRecord);
    const fromZone = String(asRecord(zones[0]?.account ?? {}).id ?? '');
    if (fromZone) return fromZone;
    throw new DnsError('当前 Cloudflare 账户缺少 Account ID，且无法自动探测，请编辑账户补充', 400, 'CF_ACCOUNT_ID_MISSING');
  }

  return { call, accountId, tokenAuth: !config.email };
}

/** Cloudflare for SaaS 的自定义主机名行，仅保留界面需要的字段。 */
export function hostnameRow(raw: unknown): Record<string, unknown> {
  const row = asRecord(raw);
  const ssl = asRecord(row.ssl ?? {});
  const ownership = asRecord(row.ownership_verification ?? {});
  const ownershipHttp = asRecord(row.ownership_verification_http ?? {});
  const validationRecords = asArray(ssl.validation_records).map((record) => {
    const item = asRecord(record);
    return {
      status: String(item.status ?? ''),
      txtName: item.txt_name === undefined ? null : String(item.txt_name),
      txtValue: item.txt_value === undefined ? null : String(item.txt_value),
      cnameTarget: item.cname_target === undefined ? null : String(item.cname_target),
      httpUrl: item.http_url === undefined ? null : String(item.http_url),
      httpBody: item.http_body === undefined ? null : String(item.http_body),
      emails: asArray(item.emails).map(String),
    };
  });
  return {
    id: String(row.id ?? ''),
    hostname: String(row.hostname ?? ''),
    customOriginServer: typeof row.custom_origin_server === 'string' ? row.custom_origin_server : null,
    sslMethod: String(ssl.method ?? ''),
    sslType: String(ssl.type ?? ''),
    minTlsVersion: String(asRecord(ssl.settings ?? {}).min_tls_version ?? ''),
    sslStatus: String(ssl.status ?? ''),
    sslValidationStatus: validationRecords.map((record) => record.status).filter(Boolean).join(' / '),
    verificationStatus: String(row.status ?? ''),
    ownership: {
      type: String(ownership.type ?? ''),
      name: String(ownership.name ?? ''),
      value: String(ownership.value ?? ''),
      status: String(ownership.status ?? ''),
    },
    ownershipHttp: {
      url: String(ownershipHttp.http_url ?? ''),
      body: String(ownershipHttp.http_body ?? ''),
    },
    validationRecords,
    createdAt: typeof row.created_at === 'string' ? row.created_at : null,
    errors: asArray(row.verification_errors).map(String),
  };
}

export const HOSTNAME_PATTERN = /^(?:\*\.)?(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
export const DNS_NAME_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

export function normalizeHostname(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, '');
}

export function validateOrigin(value: string): string {
  const origin = value.trim();
  if (!origin) return '';
  if (/^https?:\/\//i.test(origin) || /[/\\*]/.test(origin) || origin.includes(':') || /^\d+\.\d+\.\d+\.\d+$/.test(origin)) {
    throw new DnsError('自定义源站必须是域名，不能包含协议、端口、路径、通配符或 IP', 400, 'CF_INVALID_ORIGIN');
  }
  if (!DNS_NAME_PATTERN.test(origin)) throw new DnsError('自定义源站域名格式无效', 400, 'CF_INVALID_ORIGIN');
  return origin.toLowerCase();
}

export function isValidCidr(value: string): boolean {
  const [network, prefixRaw, ...rest] = value.trim().split('/');
  if (!network || prefixRaw === undefined || rest.length > 0) return false;
  const prefix = Number(prefixRaw);
  if (!Number.isInteger(prefix) || prefix < 0) return false;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(network)) {
    return prefix <= 32 && network.split('.').every((part) => Number(part) <= 255);
  }
  if (network.includes(':') && /^[0-9a-f:]+$/i.test(network)) return prefix <= 128;
  return false;
}

/** 兼容旧版返回的 { total, rows } 形态。 */
export function rowsOf(result: unknown): { total: number; rows: unknown[] } {
  const data = asRecord(result);
  const rows = asArray(data.rows);
  return { total: num(data.total, rows.length), rows };
}
