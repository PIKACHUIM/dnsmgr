import type { DeployRuntime } from './types';

const DEFAULT_TIMEOUT_MS = 20_000;

export interface DeployRequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string | FormData;
  timeoutMs?: number;
  /** 面板登录需要读取 3xx，默认按 fetch 语义跟随重定向。 */
  redirect?: RequestRedirect;
}

function snippet(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  return trimmed ? `：${trimmed.slice(0, 200)}` : '';
}

/** 非 2xx 响应：保留状态码与原始正文，便于驱动按厂商格式提取错误信息。 */
export class DeployHttpError extends Error {
  constructor(readonly status: number, readonly body: string, label: string) {
    super(`${label}返回 HTTP ${status}${snippet(body)}`);
    this.name = 'DeployHttpError';
  }
}

/** 发送请求但不校验状态码，供需要自己判断 3xx / 非 2xx 的驱动使用。 */
export async function deployRaw(
  runtime: DeployRuntime, url: string, init: DeployRequestInit, label: string,
): Promise<Response> {
  try {
    return await runtime.fetch(url, {
      method: init.method ?? 'GET',
      headers: init.headers,
      body: init.body,
      redirect: init.redirect,
      signal: AbortSignal.timeout(init.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (error) {
    const timeout = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    throw new Error(`${label}${timeout ? '请求超时' : '无法连接'}`);
  }
}

/**
 * 统一的驱动 HTTP 请求：带超时、非 2xx 直接抛出可读错误。
 * 返回值是响应文本，调用方按各厂商格式自行解析。
 */
export async function deployRequest(
  runtime: DeployRuntime, url: string, init: DeployRequestInit, label: string,
): Promise<string> {
  const response = await deployRaw(runtime, url, init, label);
  const text = await response.text();
  if (!response.ok) throw new DeployHttpError(response.status, text, label);
  return text;
}

export function parseJsonObject(text: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new Error(`${label}返回数据解析失败`); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${label}返回数据解析失败`);
  return parsed as Record<string, unknown>;
}

export function parseJsonValue(text: string, label: string): unknown {
  try { return JSON.parse(text); } catch { throw new Error(`${label}返回数据解析失败`); }
}

/** 严格校验用户填写的面板 / 接口地址，避免把凭据发到非预期协议。 */
export function panelBaseUrl(config: Record<string, string>, key = 'url', label = '面板地址'): string {
  const raw = (config[key] ?? '').trim().replace(/\/+$/, '');
  if (!raw) throw new Error(`${label}不能为空`);
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error(`${label}无效`); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error(`${label}无效`);
  return url.toString().replace(/\/+$/, '');
}

export function joinUrl(base: string, path: string): string {
  if (!path) return base;
  return path.startsWith('/') ? `${base}${path}` : `${base}/${path}`;
}

export function withQuery(url: string, params: Record<string, string | undefined>): string {
  const query = Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== '')
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value as string)}`)
    .join('&');
  if (!query) return url;
  return `${url}${url.includes('?') ? '&' : '?'}${query}`;
}

export function formBody(params: Record<string, string | number | undefined | null>): string {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    body.append(key, String(value));
  }
  return body.toString();
}

export function postForm(
  runtime: DeployRuntime, url: string, params: Record<string, string | number | undefined | null>,
  headers: Record<string, string> = {}, label = '接口',
): Promise<string> {
  return deployRequest(runtime, url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: formBody(params),
  }, label);
}

export function postJson(
  runtime: DeployRuntime, url: string, payload: unknown, headers: Record<string, string> = {}, label = '接口',
): Promise<string> {
  return deployRequest(runtime, url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(payload),
  }, label);
}

export function basicAuth(username: string, password: string): string {
  return `Basic ${btoa(`${username}:${password}`)}`;
}

/** 读取 Set-Cookie，返回可直接放进 Cookie 请求头的 name=value 列表。 */
export function readSetCookies(response: Response): string[] {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const raw = typeof headers.getSetCookie === 'function'
    ? headers.getSetCookie()
    : [response.headers.get('set-cookie') ?? ''].filter(Boolean);
  const cookies: string[] = [];
  for (const entry of raw) {
    const pair = entry.split(';')[0]?.trim() ?? '';
    if (!pair.includes('=')) continue;
    const value = pair.slice(pair.indexOf('=') + 1);
    if (!value || value === 'deleted') continue;
    cookies.push(pair);
  }
  return cookies;
}

export function readString(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

export function readArray(source: Record<string, unknown>, key: string): Record<string, unknown>[] {
  const value = source[key];
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object') : [];
}
