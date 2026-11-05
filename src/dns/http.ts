import { AppError } from '../core/errors';
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
  decode: (bytes: ArrayBuffer) => string = (bytes) => new TextDecoder().decode(bytes),
): Promise<HttpResponse> {
  let response: Response;
  try {
    response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    if (error instanceof AppError && ['REQUEST_BUDGET_EXCEEDED', 'REQUEST_TIMEOUT'].includes(error.reason)) throw error;
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new DnsError('DNS 服务商接口响应超时', 504, 'DNS_TIMEOUT');
    }
    throw new DnsError('无法连接 DNS 服务商接口，请检查网络、代理或 API 地址', 502, 'DNS_UNREACHABLE');
  }
  let body: unknown = null;
  const text = decode(await response.arrayBuffer());
  if (text) {
    try { body = JSON.parse(text); } catch {
      throw new DnsError(`DNS 服务商返回了非 JSON 响应（HTTP ${response.status}）`, 502, 'DNS_INVALID_RESPONSE');
    }
  }
  return { ok: response.ok, status: response.status, body };
}

/** 部分服务商按 GBK 返回；编码支持缺失时退回 UTF-8，避免整个驱动不可用。 */
export function gbkDecode(bytes: ArrayBuffer): string {
  try {
    return new TextDecoder('gbk').decode(bytes);
  } catch {
    return new TextDecoder().decode(bytes);
  }
}

/** 纯文本/XML 接口（Route53、HE.net 等）使用，避免强制 JSON 解析。 */
export async function sendText(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit = {},
  timeoutMs = 15000,
): Promise<{ ok: boolean; status: number; text: string; headers: Headers }> {
  let response: Response;
  try {
    response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    if (error instanceof AppError && ['REQUEST_BUDGET_EXCEEDED', 'REQUEST_TIMEOUT'].includes(error.reason)) throw error;
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new DnsError('DNS 服务商接口响应超时', 504, 'DNS_TIMEOUT');
    }
    throw new DnsError('无法连接 DNS 服务商接口，请检查网络、代理或 API 地址', 502, 'DNS_UNREACHABLE');
  }
  return { ok: response.ok, status: response.status, text: await response.text(), headers: response.headers };
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
