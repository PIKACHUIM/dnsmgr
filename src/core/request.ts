import type { Context } from 'hono';
import type { AppEnv } from './types';
import { AppError } from './errors';

export async function input(c: Context<AppEnv>): Promise<Record<string, unknown>> {
  const type = c.req.header('Content-Type')?.split(';')[0]?.trim();
  if (type === 'application/json') {
    let body: unknown;
    try { body = await c.req.json(); } catch { throw new AppError(400, 'JSON 格式无效', 'INVALID_BODY'); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AppError(400, '请求数据必须为对象', 'INVALID_BODY');
    return body as Record<string, unknown>;
  }
  if (type === 'application/x-www-form-urlencoded' || type === 'multipart/form-data') {
    const body = await c.req.parseBody();
    for (const value of Object.values(body)) {
      if (typeof value !== 'string') throw new AppError(400, '不支持该字段类型', 'INVALID_BODY');
    }
    return body;
  }
  throw new AppError(400, '需要 JSON 或表单请求', 'INVALID_CONTENT_TYPE');
}

export function text(body: Record<string, unknown>, key: string, maxLength = 256): string {
  const value = body[key];
  if (typeof value !== 'string' || !value || value.length > maxLength) throw new AppError(400, `${key} 格式无效`, 'INVALID_INPUT');
  return value;
}

export function assertSameOrigin(c: Context<AppEnv>): void {
  const origin = c.req.header('Origin');
  const expected = c.env.PUBLIC_ORIGIN ?? new URL(c.req.url).origin;
  if ((origin && origin !== expected) || c.req.header('Sec-Fetch-Site') === 'cross-site') {
    throw new AppError(403, '不允许跨站请求', 'CROSS_SITE_REQUEST');
  }
}

export function publicUser(user: AppEnv['Variables']['principal']['user']) {
  return { id: user.id, username: user.username, level: user.level };
}
