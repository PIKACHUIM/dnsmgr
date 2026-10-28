import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { secureHeaders } from 'hono/secure-headers';
import type { AppEnv } from './core/types';
import type { SqlDatabase } from './storage/sql';
import { SqlStorageError } from './storage/sql';
import { StorageCorruptionError } from './storage/format';
import { StorageConflictError } from './storage/coordinator';
import { StorageUnavailableError } from './storage/objects';
import { AppError } from './core/errors';
import { assertStorageIdentity, selectStorage, storage as createStorage } from './core/database';
import { publicUser } from './core/request';
import { requireSession } from './security/auth';
import { authRoutes } from './routes/auth';

declare const __APP_SHELL__: string;
const defaultShell = typeof __APP_SHELL__ === 'string' ? __APP_SHELL__ : '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>DnsMgr</title><p>请先运行前端构建。</p></html>';

const pagePatterns = [
  /^\/$/, /^\/(install|login|setpwd)$/, /^\/user$/, /^\/log$/,
  /^\/account(?:\/(add|edit))?$/, /^\/domain(?:\/(add|category|expirenotice))?$/,
  /^\/record\/(\d+|batchadd|batchedit|search|smartparse)$/,
  /^\/record\/(batchadd|log|weight|alias|import)\/\d+$/,
  /^\/cloudflare\/(hostnames|tunnels)\/\d+$/,
  /^\/dmonitor\/(overview|task)(?:\/(add|edit))?$/, /^\/dmonitor\/task\/info\/\d+$/,
  /^\/optimizeip\/(opipset|opiplist)$/, /^\/optimizeip\/opipform\/(add|edit)$/,
  /^\/cert\/(certaccount|deployaccount|certorder|deploytask|cname|certset)$/,
  /^\/cert\/(account|order|deploy)\/(add|edit|import|show|download)$/,
  /^\/schedule\/stask(?:\/(add|edit))?$/, /^\/system\/(loginset|noticeset|proxyset|cronset|update)$/,
];
const databasePaths = /^(\/api\/v1\/|\/(install|login|auth\/totp|logout|setpwd|totp\/))/;

export function createApp(options: { database?: SqlDatabase; shell?: string } = {}) {
  const app = new Hono<AppEnv>();
  app.use('*', secureHeaders({
    xFrameOptions: 'DENY',
    referrerPolicy: 'no-referrer',
    contentSecurityPolicy: {
      defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'], imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"], objectSrc: ["'none'"], baseUri: ["'none'"], frameAncestors: ["'none'"],
    },
  }));
  app.use('*', bodyLimit({ maxSize: 64 * 1024, onError: (c) => c.json({ code: -1, msg: '请求体超过 64KB', reason: 'BODY_TOO_LARGE' }, 413) }));
  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    const path = c.req.path;
    if (/(^|\/)\.|\.(php|sql|env|map)$|^\/(app|config|route|vendor|runtime)(\/|$)/i.test(path)) return c.json({ code: -1, msg: '未找到', reason: 'NOT_FOUND' }, 404);
    if (databasePaths.test(path) && !(c.req.method === 'GET' && ['/', '/install', '/login', '/setpwd'].includes(path))) {
      const selected = selectStorage(c.env);
      const configured = options.database ? null : createStorage(c.env);
      const db = options.database ?? configured!.db;
      c.set('db', db);
      c.set('storage', configured
        ? { config: configured.config, db: configured.db, snapshots: configured.snapshots }
        : { config: selected, db, snapshots: null });
      await assertStorageIdentity(db, selected);
    }
    await next();
  });

  app.get('/health', (c) => c.json({ code: 0, service: 'dnsmgr-serverless', stage: 'foundation' }));
  app.route('/', authRoutes());
  app.get('/api/v1/bootstrap', requireSession, (c) => {
    const storage = c.get('storage').config;
    return c.json({
      code: 0, user: publicUser(c.get('principal').user),
      runtime: { platform: c.env.RUNTIME.platform, storage: { driver: storage.driver, format: storage.format } },
      capabilities: { dns: false, cert: false, tasks: false, executor: false },
      migration: { stage: 'foundation' },
    });
  });

  app.get('/assets/*', async (c) => {
    if (!c.env.ASSETS) return c.notFound();
    const response = await c.env.ASSETS.fetch(c.req.raw);
    if (response.status === 200) {
      const headers = new Headers(response.headers);
      headers.set('Cache-Control', 'public, max-age=31536000, immutable');
      return new Response(response.body, { status: response.status, headers });
    }
    return c.notFound();
  });

  app.get('*', (c) => {
    if (pagePatterns.some((pattern) => pattern.test(c.req.path))) return c.html(options.shell ?? defaultShell);
    return c.json({ code: -1, msg: '该路径尚未实现或不存在', reason: 'NOT_FOUND' }, 404);
  });
  app.notFound((c) => c.json({ code: -1, msg: '该接口尚未移植或不存在', reason: 'NOT_FOUND' }, 404));
  app.onError((error, c) => {
    if (error instanceof AppError) return c.json({ code: -1, msg: error.message, reason: error.reason }, error.status);
    if (error instanceof StorageConflictError) return c.json({ code: -1, msg: '存储版本已被其他请求更新，请重新读取后重试', reason: 'STORAGE_CONFLICT' }, 409);
    if (error instanceof SqlStorageError || error instanceof StorageCorruptionError || error instanceof StorageUnavailableError) return c.json({ code: -1, msg: '持久化存储不可用或数据损坏，已停止操作', reason: 'STORAGE_UNAVAILABLE' }, 503);
    console.error(JSON.stringify({ event: 'request_failed', method: c.req.method, kind: error.name }));
    return c.json({ code: -1, msg: '服务发生错误', reason: 'INTERNAL_ERROR' }, 500);
  });
  return app;
}
