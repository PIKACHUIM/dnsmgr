import { AppError } from '../core/errors';

const DOH_URL = 'https://dns.alidns.com/resolve';
const RESPONSE_LIMIT = 262_144;
const FETCH_TIMEOUT_MS = 5_000;
const MAX_ANSWERS = 100;
const DNS_TYPES = {
  A: 1,
  NS: 2,
  CNAME: 5,
  SOA: 6,
  PTR: 12,
  MX: 15,
  TXT: 16,
  AAAA: 28,
  SRV: 33,
  CAA: 257,
} as const;

export type DnsCheckType = keyof typeof DNS_TYPES;
export type DnsCheckStatus = 'active' | 'mismatch' | 'not_found';

export interface DnsCheckResult {
  status: DnsCheckStatus;
  actual: string[];
  expected?: string;
}

interface DohResponse {
  Status?: unknown;
  Answer?: unknown;
}

export function isDnsCheckType(value: string): value is DnsCheckType {
  return Object.hasOwn(DNS_TYPES, value);
}

function normalizeIp(value: string, type: DnsCheckType): string | null {
  if (type === 'A') {
    const parts = value.trim().split('.');
    if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return null;
    return parts.map(Number).join('.');
  }
  if (type !== 'AAAA' || !value.includes(':')) return null;
  try {
    return new URL(`http://[${value.trim().replace(/^\[|\]$/g, '')}]/`).hostname.replace(/^\[|\]$/g, '').toLowerCase();
  } catch {
    return null;
  }
}

function normalizeValue(value: string, type: DnsCheckType): string {
  let normalized = value.trim();
  if (type === 'TXT' && normalized.startsWith('"') && normalized.endsWith('"')) {
    try {
      const decoded: unknown = JSON.parse(normalized);
      if (typeof decoded === 'string') normalized = decoded;
    } catch {
      normalized = normalized.slice(1, -1);
    }
  }
  if (type === 'MX') normalized = normalized.replace(/^\d+\s+/, '');
  if (type === 'SRV') normalized = normalized.replace(/\s+/g, ' ');
  const ip = normalizeIp(normalized, type);
  return (ip ?? normalized).toLowerCase().replace(/\.+$/, '');
}

async function readJson(response: Response): Promise<DohResponse> {
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > RESPONSE_LIMIT) throw new AppError(503, '公共 DNS 响应过大', 'DNS_RESPONSE_TOO_LARGE');
  if (!response.body) throw new AppError(503, '公共 DNS 响应为空', 'DNS_LOOKUP_FAILED');

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > RESPONSE_LIMIT) {
        await reader.cancel();
        throw new AppError(503, '公共 DNS 响应过大', 'DNS_RESPONSE_TOO_LARGE');
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(503, '公共 DNS 响应读取失败', 'DNS_LOOKUP_FAILED');
  } finally {
    reader.releaseLock();
  }

  try {
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid DNS response');
    return value as DohResponse;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(503, '公共 DNS 响应格式无效', 'DNS_LOOKUP_FAILED');
  }
}

function answerValues(payload: DohResponse): string[] {
  if (payload.Status !== 0 && payload.Status !== 3) throw new AppError(503, '公共 DNS 查询失败', 'DNS_LOOKUP_FAILED');
  if (payload.Status === 3) return [];
  if (payload.Answer === undefined) return [];
  if (!Array.isArray(payload.Answer) || payload.Answer.length > MAX_ANSWERS) {
    throw new AppError(503, '公共 DNS 响应格式无效', 'DNS_LOOKUP_FAILED');
  }
  const values: string[] = [];
  for (const answer of payload.Answer) {
    if (!answer || typeof answer !== 'object' || typeof (answer as { data?: unknown }).data !== 'string') {
      throw new AppError(503, '公共 DNS 响应格式无效', 'DNS_LOOKUP_FAILED');
    }
    const data = (answer as { data: string }).data;
    if (data.length > 2048) throw new AppError(503, '公共 DNS 响应格式无效', 'DNS_LOOKUP_FAILED');
    values.push(data);
  }
  return values;
}

export async function lookupPublicDnsRecords(name: string, type: DnsCheckType, fetchImpl: typeof fetch): Promise<string[]> {
  const queryName = name.trim().toLowerCase().replace(/\.$/, '');
  if (queryName.length > 253 || !/^(?=.{1,253}$)(?:[a-z0-9_*](?:[a-z0-9_-]{0,61}[a-z0-9_*])?\.)+[a-z]{2,63}$/.test(queryName)) {
    throw new AppError(400, '查询域名格式无效', 'INVALID_DNS_QUERY_NAME');
  }

  const url = new URL(DOH_URL);
  url.searchParams.set('name', queryName);
  url.searchParams.set('type', String(DNS_TYPES[type]));
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: { Accept: 'application/dns-json, application/json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: 'error',
    });
  } catch (error) {
    if (error instanceof AppError && (error.reason === 'REQUEST_BUDGET_EXCEEDED' || error.reason === 'REQUEST_TIMEOUT')) throw error;
    throw new AppError(503, '公共 DNS 服务连接失败', 'DNS_LOOKUP_FAILED');
  }
  if (!response.ok) throw new AppError(503, '公共 DNS 服务返回错误', 'DNS_LOOKUP_FAILED');
  return answerValues(await readJson(response));
}

export function checkDnsRecordValue(expectedValue: string, answers: string[], type: DnsCheckType): DnsCheckResult {
  const expected = normalizeValue(expectedValue, type);
  const actual = answers.map((answer) => normalizeValue(answer, type));
  if (actual.length === 0) return { status: 'not_found', actual: [] };
  if (actual.includes(expected)) return { status: 'active', actual };
  return { status: 'mismatch', actual, expected };
}
