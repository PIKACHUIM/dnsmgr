import { AppError } from '../core/errors';

const RDAP_BOOTSTRAP_URL = 'https://data.iana.org/rdap/dns.json';
const RESPONSE_LIMIT = 2_000_000;
const FETCH_TIMEOUT_MS = 5_000;

interface RdapBootstrap {
  services?: unknown;
}

interface RdapEvent {
  eventAction?: unknown;
  eventDate?: unknown;
}

function parseDomain(value: string): string {
  const domain = value.trim().toLowerCase().replace(/\.$/, '');
  if (domain.length > 253 || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)) {
    throw new AppError(400, '域名格式无效', 'INVALID_DOMAIN_NAME');
  }
  return domain;
}

function publicHttpsUrl(value: string): URL | null {
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (
    url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash
    || !host.includes('.') || host.includes(':') || /^\d+(?:\.\d+){3}$/.test(host)
    || /\.(?:localhost|local|internal|test|invalid|example|home\.arpa)$/.test(host)
  ) return null;
  return url;
}

function rdapBaseUrl(bootstrap: RdapBootstrap, domain: string): URL {
  if (!Array.isArray(bootstrap.services)) throw new AppError(503, '域名注册信息服务暂不可用', 'INVALID_RDAP_BOOTSTRAP');
  let bestMatch = '';
  let bestEndpoints: unknown[] = [];
  for (const service of bootstrap.services) {
    if (!Array.isArray(service) || service.length !== 2 || !Array.isArray(service[0]) || !Array.isArray(service[1])) continue;
    for (const entry of service[0] as unknown[]) {
      if (typeof entry !== 'string') continue;
      const suffix = entry.toLowerCase();
      if ((domain === suffix || domain.endsWith(`.${suffix}`)) && suffix.length > bestMatch.length) {
        bestMatch = suffix;
        bestEndpoints = service[1] as unknown[];
      }
    }
  }
  for (const endpoint of bestEndpoints) {
    if (typeof endpoint !== 'string') continue;
    const url = publicHttpsUrl(endpoint);
    if (url) return url;
  }
  throw new AppError(503, '该域名后缀暂不支持到期时间查询', 'RDAP_UNSUPPORTED_TLD');
}

async function readJson(response: Response): Promise<unknown> {
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > RESPONSE_LIMIT) throw new AppError(503, '注册信息响应过大', 'RDAP_RESPONSE_TOO_LARGE');
  if (!response.body) throw new AppError(503, '注册信息响应为空', 'INVALID_RDAP_RESPONSE');

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
        throw new AppError(503, '注册信息响应过大', 'RDAP_RESPONSE_TOO_LARGE');
      }
      chunks.push(value);
    }
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
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new AppError(503, '注册信息响应格式无效', 'INVALID_RDAP_RESPONSE');
  }
}

function expirationTimestamp(value: unknown): number {
  if (!value || typeof value !== 'object' || !Array.isArray((value as { events?: unknown }).events)) {
    throw new AppError(503, '注册信息中没有到期时间', 'RDAP_EXPIRATION_MISSING');
  }
  const events = (value as { events: RdapEvent[] }).events;
  for (const event of events) {
    if (!event || typeof event !== 'object' || typeof event.eventAction !== 'string' || !/^(?:expiration|expires)$/i.test(event.eventAction)) continue;
    if (typeof event.eventDate !== 'string') continue;
    const timestamp = Date.parse(event.eventDate);
    if (Number.isFinite(timestamp)) return Math.floor(timestamp / 1000);
  }
  throw new AppError(503, '注册信息中没有有效的到期时间', 'RDAP_EXPIRATION_MISSING');
}

async function getJson(url: string, fetchImpl: typeof fetch): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: { Accept: 'application/rdap+json, application/json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: 'error',
    });
  } catch (error) {
    if (error instanceof AppError && (error.reason === 'REQUEST_BUDGET_EXCEEDED' || error.reason === 'REQUEST_TIMEOUT')) throw error;
    throw new AppError(503, '注册信息服务连接失败', 'RDAP_FETCH_FAILED');
  }
  if (!response.ok) throw new AppError(503, '注册信息服务返回错误', 'RDAP_FETCH_FAILED');
  return readJson(response);
}

export async function lookupDomainExpiration(value: string, fetchImpl: typeof fetch): Promise<number> {
  const domain = parseDomain(value);
  const bootstrap = await getJson(RDAP_BOOTSTRAP_URL, fetchImpl) as RdapBootstrap;
  const base = rdapBaseUrl(bootstrap, domain);
  const queryUrl = new URL(`domain/${encodeURIComponent(domain)}`, base.toString().endsWith('/') ? base : `${base}/`);
  const rdap = await getJson(queryUrl.toString(), fetchImpl);
  return expirationTimestamp(rdap);
}
