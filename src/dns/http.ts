import { DnsError } from './types';

export interface HttpResponse {
  ok: boolean;
  status: number;
  body: unknown;
}

/** 所有平台请求都走这里，统一超时与网络错误文案；业务错误由驱动解析响应体。 */
export async function sendJson(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit = {},
  timeoutMs = 15000,
): Promise<HttpResponse> {
  let response: Response;
  try {
    response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new DnsError('DNS 服务商接口响应超时', 504, 'DNS_TIMEOUT');
    }
    throw new DnsError('无法连接 DNS 服务商接口，请检查网络、代理或 API 地址', 502, 'DNS_UNREACHABLE');
  }
  let body: unknown = null;
  const text = await response.text();
  if (text) {
    try { body = JSON.parse(text); } catch {
      throw new DnsError(`DNS 服务商返回了非 JSON 响应（HTTP ${response.status}）`, 502, 'DNS_INVALID_RESPONSE');
    }
  }
  return { ok: response.ok, status: response.status, body };
}

export function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DnsError('DNS 服务商响应格式异常', 502, 'DNS_INVALID_RESPONSE');
  return value as Record<string, unknown>;
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function num(value: unknown, fallback = 0): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
