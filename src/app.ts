import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { secureHeaders } from 'hono/secure-headers';
import type { AppEnv } from './core/types';
import type { SqlDatabase } from './storage/sql';
import { SqlStorageError } from './storage/sql';
import { StorageCorruptionError } from './storage/format';
import { SqlCoordinator, StorageConflictError } from './storage/coordinator';
import type { StorageRuntime } from './storage/config';
import { StorageUnavailableError } from './storage/objects';
import { AppError } from './core/errors';
import { assertStorageIdentity, selectStorage, storage as createStorage } from './core/database';
import { publicUser } from './core/request';
import { requireSession } from './security/auth';
import { authRoutes } from './routes/auth';
import { dnsRoutes } from './routes/dns';
import { cloudflareRoutes } from './routes/cloudflare';
import { scheduleRoutes } from './routes/schedule';
import { notifyRoutes } from './routes/notify';
import { failoverRoutes } from './routes/failover';
import { certificateRoutes } from './routes/certificates';
import { certificateAcmeRoutes } from './routes/certificate-acme';
import { certificateCnameRoutes } from './routes/cname';
import { certificateDeployRoutes } from './routes/deploy';
import { optimizeRoutes } from './routes/optimize';
import { userRoutes } from './routes/users';
import { proxyRoutes } from './routes/proxy';
import { updateRoutes } from './routes/update';
import { storageRoutes } from './routes/storage';

declare const __APP_SHELL__: string;
const defaultShell = typeof __APP_SHELL__ === 'string' ? __APP_SHELL__ : '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>DnsMgr</title><p>请先运行前端构建。</p></html>';

const pagePatterns = [
  /^\/$/, /^\/(install|login|setpwd)$/, /^\/user$/, /^\/log$/,
  /^\/account(?:\/(add|edit))?$/, /^\/domain(?:\/(add|category|expirenotice))?$/,
  /^\/record\/(\d+|batchadd|batchedit|search|smartparse)$/,
  /^\/record\/(batchadd|batchedit|log|weight|groups|alias|import)\/\d+$/,
  /^\/record\/\d+\/(alias|import)$/,
  /^\/cloudflare\/(hostnames|tunnels)\/\d+$/,
  /^\/dmonitor\/(overview|task)(?:\/(add|edit))?$/, /^\/dmonitor\/task\/info\/\d+$/,
  /^\/optimizeip\/(opipset|opiplist)$/, /^\/optimizeip\/opipform\/(add|edit)$/,
  /^\/cert\/(certaccount|deployaccount|certorder|deploytask|cname|certset)$/,
  /^\/cert\/(account|order|deploy)\/(add|edit|import|show|download)$/,
  /^\/schedule\/stask(?:\/(add|edit))?$/, /^\/system\/(loginset|noticeset|proxyset|cronset|update)$/,
];
const databasePaths = /^(\/api\/v1\/|\/api\/(?:domain|cert\/order|record\/(?:add|batch|data|remark|delete|update|status))(?:\/|$)|\/cron(?:\?|$)|\/qqbot\/webhook(?:\?|$)|\/(verifycode|install|login|quicklogin|auth\/totp|logout|setpwd|totp\/))/;
const legacySignedApiPaths = /^\/api\/(?:domain|cert\/order|record\/(?:add|batch|data|remark|delete|update|status))(?:\/|$)/;
const certificateSessionPaths = /^\/api\/v1\/cert(?:\/|$)/;

function injectedStorage(db: SqlDatabase, config: StorageRuntime['config']): StorageRuntime {
  return {
    config,
    db,
    coordinator: new SqlCoordinator(db),
    entities: () => {
      throw new Error('Entity repository is not available for injected storage');
    },
    snapshots: null,
  };
}

export function createApp(options: { database?: SqlDatabase; shell?: string; storage?: StorageRuntime } = {}) {
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
  const jsonBodyLimit = bodyLimit({ maxSize: 64 * 1024, onError: (c) => c.json({ code: -1, msg: '请求体超过 64KB', reason: 'BODY_TOO_LARGE' }, 413) });
  app.use('*', (c, next) => c.req.path === '/api/v1/system/storage/import' ? next() : jsonBodyLimit(c, next));
  app.use('/api/v1/system/storage/import', bodyLimit({
    maxSize: 4 * 1024 * 1024,
    onError: (c) => c.json({ code: -1, msg: '存储导入包超过 4MB', reason: 'BODY_TOO_LARGE' }, 413),
  }));
  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    const path = c.req.path;
    if (/(^|\/)\.|\.(php|sql|env|map)$|^\/(app|config|route|vendor|runtime)(\/|$)/i.test(path)) return c.json({ code: -1, msg: '未找到', reason: 'NOT_FOUND' }, 404);
    if (databasePaths.test(path) && !(c.req.method === 'GET' && ['/', '/install', '/login', '/setpwd'].includes(path))) {
      const selected = selectStorage(c.env);
      const runtimeStorage = options.storage
        ?? (options.database ? injectedStorage(options.database, selected) : createStorage(c.env));
      const db = runtimeStorage.db;
      c.set('db', db);
      c.set('storage', runtimeStorage);
      if (!legacySignedApiPaths.test(path) && !certificateSessionPaths.test(path)) await assertStorageIdentity(db, selected);
    }
    await next();
  });

  app.get('/health', (c) => c.json({ code: 0, service: 'dnsmgr-serverless', stage: 'foundation' }));
  app.route('/', authRoutes());
  app.route('/', dnsRoutes());
  app.route('/', cloudflareRoutes());
  app.route('/', scheduleRoutes());
  app.route('/', notifyRoutes());
  app.route('/', failoverRoutes());
  app.route('/', certificateRoutes());
  app.route('/', certificateAcmeRoutes());
  app.route('/', certificateCnameRoutes());
  app.route('/', certificateDeployRoutes());
  app.route('/', optimizeRoutes());
  app.route('/', userRoutes());
  app.route('/', proxyRoutes());
  app.route('/', updateRoutes());
  app.route('/', storageRoutes());
  app.get('/api/v1/bootstrap', requireSession, (c) => {
    const storage = c.get('storage').config;
    return c.json({
      code: 0, user: publicUser(c.get('principal').user),
      runtime: { platform: c.env.RUNTIME.platform, storage: { driver: storage.driver, format: storage.format } },
      capabilities: { dns: true, cert: true, tasks: true, executor: true },
      migration: { stage: 'wave7-system-management' },
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
