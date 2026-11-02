import { Hono, type Context } from 'hono';
import type { AppEnv } from '../core/types';
import { AppError } from '../core/errors';
import { input, text } from '../core/request';
import { requireAdmin, requireCsrf, requireSession, nowSeconds } from '../security/auth';
import { parseConfig, sendCustomWebhook } from '../notify/custom';

const KEYS = ['custom_webhook_url', 'custom_webhook_method', 'custom_webhook_headers', 'custom_webhook_content_type', 'custom_webhook_body'] as const;

async function values(c: Context<AppEnv>): Promise<Record<string, string>> {
  const rows = await c.get('db').query<{ key: string; value: string }>(
    `SELECT key, value FROM app_settings WHERE key IN (${KEYS.map(() => '?').join(',')})`, [...KEYS],
  );
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}

function requireSql(c: Context<AppEnv>): void {
  if (c.get('storage').config.format !== 'sql') {
    throw new AppError(501, '当前存储格式尚未支持通知设置，请使用 DB_FORMAT=sql', 'STORAGE_FORMAT_UNSUPPORTED');
  }
}

async function put(c: Context<AppEnv>, key: string, value: string): Promise<void> {
  await c.get('db').execute(
    'INSERT INTO app_settings (key, value, updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at',
    [key, value, nowSeconds()],
  );
}

export function notifyRoutes() {
  const routes = new Hono<AppEnv>();

  routes.get('/api/v1/system/notify', requireSession, async (c) => {
    requireSql(c);
    requireAdmin(c);
    const config = await values(c);
    return c.json({
      code: 0,
      url: config.custom_webhook_url ?? '',
      method: config.custom_webhook_method ?? 'POST',
      headers: config.custom_webhook_headers ?? '',
      contentType: config.custom_webhook_content_type ?? 'application/json',
      body: config.custom_webhook_body ?? '',
      configured: Boolean(config.custom_webhook_url),
    });
  });

  routes.put('/api/v1/system/notify', requireSession, requireCsrf, async (c) => {
    requireSql(c);
    requireAdmin(c);
    const body = await input(c);
    const url = typeof body.url === 'string' ? body.url.trim().slice(0, 1024) : '';
    const method = text(body, 'method', 8).toUpperCase() || 'POST';
    const headers = typeof body.headers === 'string' ? body.headers.trim().slice(0, 4096) : '';
    const contentType = typeof body.contentType === 'string' ? body.contentType.trim().slice(0, 128) : 'application/json';
    const template = typeof body.body === 'string' ? body.body.slice(0, 8192) : '';
    try {
      parseConfig({ custom_webhook_url: url, custom_webhook_method: method, custom_webhook_headers: headers, custom_webhook_content_type: contentType, custom_webhook_body: template });
    } catch (error) {
      throw new AppError(400, error instanceof Error ? error.message : 'Webhook 配置无效', 'INVALID_WEBHOOK');
    }
    await put(c, 'custom_webhook_url', url);
    await put(c, 'custom_webhook_method', method);
    await put(c, 'custom_webhook_headers', headers);
    await put(c, 'custom_webhook_content_type', contentType);
    await put(c, 'custom_webhook_body', template);
    await c.get('db').execute(
      'INSERT INTO audit_logs (user_id, action, target, detail, created_at) VALUES (?,?,?,?,?)',
      [c.get('principal').user.id, 'notify.settings', 'system', url ? url.slice(0, 200) : 'cleared', nowSeconds()],
    );
    return c.json({ code: 0, configured: Boolean(url) });
  });

  routes.post('/api/v1/system/notify/test', requireSession, requireCsrf, async (c) => {
    requireSql(c);
    requireAdmin(c);
    const body = await input(c);
    const config = await values(c);
    let webhook;
    try { webhook = parseConfig(config); } catch (error) {
      throw new AppError(400, error instanceof Error ? error.message : 'Webhook 配置无效', 'INVALID_WEBHOOK');
    }
    if (!webhook) throw new AppError(400, '请先保存自定义 Webhook 地址', 'WEBHOOK_NOT_CONFIGURED');
    const title = text(body, 'title', 100).trim() || 'DNSMGR 测试通知';
    const content = typeof body.content === 'string' ? body.content.slice(0, 2000) : '这是一条来自 DNSMGR 的测试通知。';
    try {
      const result = await sendCustomWebhook(webhook, title, content, c.env.BUDGET?.fetch ?? fetch);
      if (result.status < 200 || result.status >= 300) {
        throw new AppError(503, `Webhook 返回 HTTP ${result.status}：${result.response}`, 'WEBHOOK_FAILED');
      }
      return c.json({ code: 0, msg: '测试通知已发送', status: result.status });
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(503, `Webhook 发送失败：${error instanceof Error ? error.message : '未知错误'}`, 'WEBHOOK_FAILED');
    }
  });

  return routes;
}
