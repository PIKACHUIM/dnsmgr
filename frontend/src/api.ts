export interface User {
  id: number;
  username: string;
  level: number;
}

export interface Session {
  code: 0;
  csrfToken: string;
  user: User;
}

export interface Bootstrap {
  code: 0;
  user: User;
  runtime: { platform: string; storage: { driver: string; format: string } };
  capabilities: { dns: boolean; cert: boolean; tasks: boolean; executor: boolean };
  migration: { stage: string };
}

export class ApiError extends Error {
  constructor(message: string, public status: number, public body: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...options,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { Accept: 'application/json', ...options.headers },
    });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new ApiError('无法连接服务，请检查网络或后端服务后重试。', 0);
  }
  let body: Record<string, unknown>;
  try {
    body = await response.json() as Record<string, unknown>;
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new ApiError('服务未返回有效的 JSON 响应，请检查后端状态。', response.status);
  }
  if (!body || typeof body !== 'object' || !response.ok || body.code !== 0) {
    const message = body && typeof body.msg === 'string' ? body.msg : `请求未成功（HTTP ${response.status}），请重试。`;
    throw new ApiError(message, response.status, body ?? {});
  }
  return body as T;
}

export function post<T>(path: string, body: Record<string, string>, signal: AbortSignal, headers: Record<string, string> = {}) {
  return request<T>(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal,
  });
}

export function send<T>(path: string, method: string, body: unknown, signal: AbortSignal, headers: Record<string, string> = {}) {
  return request<T>(path, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal,
  });
}

export function readSession(value: Session): Session {
  if (!value.user || typeof value.user.username !== 'string' || typeof value.user.level !== 'number'
    || typeof value.user.id !== 'number' || typeof value.csrfToken !== 'string' || !value.csrfToken) {
    throw new ApiError('会话响应不完整，请重试或检查后端服务。', 502);
  }
  return value;
}

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : '请求未成功，请重试。';
}
