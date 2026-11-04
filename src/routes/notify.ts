import { Hono, type Context } from 'hono';
import type { AppEnv } from '../core/types';
import { AppError } from '../core/errors';
import { input, text } from '../core/request';
import { requireAdmin, requireCsrf, requireSession, nowSeconds } from '../security/auth';
import { parseConfig } from '../notify/custom';
import {
  loadNotificationSettings, normalizeWecomWebhookUrl, normalizeWxPusherUids, notificationSettingsView,
  saveNotificationSettings, sendConfiguredNotifications,
} from '../notify/settings';

function normalizeTelegramBotToken(value: string): string {
  if (!/^\d{5,15}:[A-Za-z0-9_-]{20,128}$/.test(value)) {
    throw new AppError(400, 'Telegram Bot Token 格式无效', 'INVALID_TELEGRAM_TOKEN');
  }
  return value;
}

function normalizeTelegramChatId(value: string): string {
  if (!/^-?\d{1,20}$/.test(value) && !/^@[A-Za-z][A-Za-z0-9_]{4,31}$/.test(value)) {
    throw new AppError(400, 'Telegram Chat ID 格式无效', 'INVALID_TELEGRAM_CHAT_ID');
  }
  return value;
}

function normalizeTelegramTopicId(value: string): string {
  if (value && (!/^\d{1,12}$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1)) {
    throw new AppError(400, 'Telegram Topic ID 必须是正整数', 'INVALID_TELEGRAM_TOPIC_ID');
  }
  return value;
}

function requireSql(c: Context<AppEnv>): void {
  if (c.get('storage').config.format !== 'sql') {
    throw new AppError(501, '当前存储格式尚未支持通知设置，请使用 DB_FORMAT=sql', 'STORAGE_FORMAT_UNSUPPORTED');
  }
}

export function notifyRoutes() {
  const routes = new Hono<AppEnv>();

  routes.get('/api/v1/system/notify', requireSession, async (c) => {
    requireSql(c);
    requireAdmin(c);
    return c.json({ code: 0, ...notificationSettingsView(await loadNotificationSettings(c)) });
  });

  routes.put('/api/v1/system/notify', requireSession, requireCsrf, async (c) => {
    requireSql(c);
    requireAdmin(c);
    const body = await input(c);
    const current = await loadNotificationSettings(c);
    const secretValue = (field: string, clearField: string, max: number, existing: string): string => {
      if (body[clearField] === true) return '';
      const value = typeof body[field] === 'string' ? body[field].trim().slice(0, max) : '';
      return value || existing;
    };
    const secrets = {
      webhookUrl: secretValue('url', 'clearUrl', 1024, current.secrets.webhookUrl),
      webhookHeaders: secretValue('headers', 'clearHeaders', 4096, current.secrets.webhookHeaders),
      webhookBody: secretValue('body', 'clearBody', 8192, current.secrets.webhookBody),
      wxpusherAppToken: secretValue('wxpusherAppToken', 'clearWxpusherAppToken', 256, current.secrets.wxpusherAppToken),
      wxpusherUids: secretValue('wxpusherUids', 'clearWxpusherUids', 2048, current.secrets.wxpusherUids),
      telegramBotToken: secretValue('telegramBotToken', 'clearTelegram', 256, current.secrets.telegramBotToken),
      telegramChatId: secretValue('telegramChatId', 'clearTelegram', 128, current.secrets.telegramChatId),
      telegramTopicId: secretValue('telegramTopicId', 'clearTelegram', 12, current.secrets.telegramTopicId),
      wecomWebhookUrl: secretValue('wecomWebhookUrl', 'clearWecom', 1024, current.secrets.wecomWebhookUrl),
    };
    if (typeof body.wxpusherUids === 'string' && body.wxpusherUids.trim() && body.clearWxpusherUids !== true) {
      secrets.wxpusherUids = normalizeWxPusherUids(body.wxpusherUids.trim());
    }
    if (Boolean(secrets.wxpusherAppToken) !== Boolean(secrets.wxpusherUids)) {
      throw new AppError(400, 'WxPusher AppToken 与用户 UID 必须同时配置或清除', 'INCOMPLETE_WXPUSHER_CONFIG');
    }
    if (typeof body.telegramTopicId === 'string' && body.telegramTopicId.trim().length > 12 && body.clearTelegram !== true) {
      throw new AppError(400, 'Telegram Topic ID 必须是正整数', 'INVALID_TELEGRAM_TOPIC_ID');
    }
    if (secrets.telegramBotToken) secrets.telegramBotToken = normalizeTelegramBotToken(secrets.telegramBotToken);
    if (secrets.telegramChatId) secrets.telegramChatId = normalizeTelegramChatId(secrets.telegramChatId);
    secrets.telegramTopicId = normalizeTelegramTopicId(secrets.telegramTopicId);
    if (Boolean(secrets.telegramBotToken) !== Boolean(secrets.telegramChatId)) {
      throw new AppError(400, 'Telegram Bot Token 与 Chat ID 必须同时配置或清除', 'INCOMPLETE_TELEGRAM_CONFIG');
    }
    if (secrets.wecomWebhookUrl) secrets.wecomWebhookUrl = normalizeWecomWebhookUrl(secrets.wecomWebhookUrl);
    const method = typeof body.method === 'string' ? body.method.trim().toUpperCase() : current.method;
    const contentType = typeof body.contentType === 'string'
      ? body.contentType.trim().slice(0, 128) || 'application/json'
      : current.contentType;
    if (!['GET', 'POST', 'PUT'].includes(method)) throw new AppError(400, 'Webhook 方法只能是 GET/POST/PUT', 'INVALID_WEBHOOK');
    try {
      parseConfig({
        custom_webhook_url: secrets.webhookUrl, custom_webhook_method: method,
        custom_webhook_headers: secrets.webhookHeaders, custom_webhook_content_type: contentType,
        custom_webhook_body: secrets.webhookBody,
      });
    } catch (error) {
      throw new AppError(400, error instanceof Error ? error.message : 'Webhook 配置无效', 'INVALID_WEBHOOK');
    }
    await saveNotificationSettings(c, { secrets, method, contentType });
    await c.get('db').execute(
      'INSERT INTO audit_logs (user_id, action, target, detail, created_at) VALUES (?,?,?,?,?)',
      [c.get('principal').user.id, 'notify.settings', 'system', `webhook=${Boolean(secrets.webhookUrl)},wxpusher=${Boolean(secrets.wxpusherAppToken)},telegram=${Boolean(secrets.telegramBotToken)},wecom=${Boolean(secrets.wecomWebhookUrl)}`, nowSeconds()],
    );
    return c.json({ code: 0, ...notificationSettingsView({ secrets, method, contentType }) });
  });

  routes.post('/api/v1/system/notify/test', requireSession, requireCsrf, async (c) => {
    requireSql(c);
    requireAdmin(c);
    const body = await input(c);
    const settings = await loadNotificationSettings(c);
    if (!settings.secrets.webhookUrl && !settings.secrets.wxpusherAppToken && !settings.secrets.telegramBotToken && !settings.secrets.wecomWebhookUrl) {
      throw new AppError(400, '请先配置至少一个通知渠道', 'NOTIFICATION_NOT_CONFIGURED');
    }
    const title = text(body, 'title', 100).trim() || 'DNSMGR 测试通知';
    const content = typeof body.content === 'string' ? body.content.slice(0, 2000) : '这是一条来自 DNSMGR 的测试通知。';
    const deliveries = await sendConfiguredNotifications(c, title, content);
    const failed = deliveries.filter((delivery) => !delivery.ok);
    if (failed.length > 0) {
      throw new AppError(503, `测试发送失败：${failed.map((delivery) => delivery.channel).join(', ')}`, 'NOTIFICATION_FAILED');
    }
    return c.json({
      code: 0, msg: '测试通知已发送', status: deliveries[0]?.status ?? 200,
      channels: deliveries.map(({ channel, status }) => ({ channel, status })),
    });
  });

  return routes;
}
