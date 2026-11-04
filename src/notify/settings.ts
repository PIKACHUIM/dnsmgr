import type { Context } from 'hono';
import type { AppEnv } from '../core/types';
import { AppError } from '../core/errors';
import { encrypt, decrypt } from '../security/crypto';
import type { SqlDatabase } from '../storage/sql';
import { parseConfig, sendCustomWebhook } from './custom';

const SECRET_KEY = 'notification_secrets_cipher';
const SECRET_PURPOSE = 'notification-secrets/v1';
const LEGACY_SECRET_KEYS = ['custom_webhook_url', 'custom_webhook_headers', 'custom_webhook_body'] as const;
const SETTING_KEYS = [SECRET_KEY, ...LEGACY_SECRET_KEYS, 'custom_webhook_method', 'custom_webhook_content_type'] as const;

export interface NotificationSettings {
  secrets: {
    webhookUrl: string;
    webhookHeaders: string;
    webhookBody: string;
    wxpusherAppToken: string;
    wxpusherUids: string;
    telegramBotToken: string;
    telegramChatId: string;
    telegramTopicId: string;
    wecomWebhookUrl: string;
  };
  method: string;
  contentType: string;
}

export interface NotificationDelivery {
  channel: 'webhook' | 'wxpusher' | 'telegram' | 'wecom';
  ok: boolean;
  status: number | null;
}

function emptySecrets(): NotificationSettings['secrets'] {
  return {
    webhookUrl: '', webhookHeaders: '', webhookBody: '', wxpusherAppToken: '', wxpusherUids: '',
    telegramBotToken: '', telegramChatId: '', telegramTopicId: '', wecomWebhookUrl: '',
  };
}

function parseSecrets(value: string): NotificationSettings['secrets'] {
  let decoded: unknown;
  try { decoded = JSON.parse(value); } catch { throw new AppError(503, '通知配置损坏，请重新保存通知设置', 'NOTIFICATION_CONFIG_CORRUPTED'); }
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
    throw new AppError(503, '通知配置损坏，请重新保存通知设置', 'NOTIFICATION_CONFIG_CORRUPTED');
  }
  const source = decoded as Record<string, unknown>;
  const keys = [
    'webhookUrl', 'webhookHeaders', 'webhookBody', 'wxpusherAppToken', 'wxpusherUids',
    'telegramBotToken', 'telegramChatId', 'telegramTopicId', 'wecomWebhookUrl',
  ] as const;
  if (keys.some((key) => source[key] !== undefined && typeof source[key] !== 'string')) {
    throw new AppError(503, '通知配置损坏，请重新保存通知设置', 'NOTIFICATION_CONFIG_CORRUPTED');
  }
  return Object.fromEntries(keys.map((key) => [key, source[key] ?? ''])) as NotificationSettings['secrets'];
}

async function storeSecrets(db: SqlDatabase, appKey: string | undefined, secrets: NotificationSettings['secrets']): Promise<void> {
  const encrypted = await encrypt(JSON.stringify(secrets), appKey, SECRET_PURPOSE);
  const now = Math.floor(Date.now() / 1000);
  await db.batch([
    { sql: 'INSERT INTO app_settings (key, value, updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at', args: [SECRET_KEY, encrypted, now] },
    { sql: `DELETE FROM app_settings WHERE key IN (${LEGACY_SECRET_KEYS.map(() => '?').join(',')})`, args: [...LEGACY_SECRET_KEYS] },
  ]);
}

export async function loadNotificationSettings(c: Context<AppEnv>): Promise<NotificationSettings> {
  const db = c.get('db');
  const rows = await db.query<{ key: string; value: string }>(
    `SELECT key, value FROM app_settings WHERE key IN (${SETTING_KEYS.map(() => '?').join(',')})`, [...SETTING_KEYS],
  );
  const values = Object.fromEntries(rows.map((row) => [row.key, row.value]));
  let secrets: NotificationSettings['secrets'];
  if (values[SECRET_KEY]) {
    secrets = parseSecrets(await decrypt(values[SECRET_KEY]!, c.env.APP_KEY, SECRET_PURPOSE));
    if (LEGACY_SECRET_KEYS.some((key) => values[key] !== undefined)) {
      await db.execute(`DELETE FROM app_settings WHERE key IN (${LEGACY_SECRET_KEYS.map(() => '?').join(',')})`, [...LEGACY_SECRET_KEYS]);
    }
  } else {
    secrets = {
      ...emptySecrets(),
      webhookUrl: values.custom_webhook_url ?? '',
      webhookHeaders: values.custom_webhook_headers ?? '',
      webhookBody: values.custom_webhook_body ?? '',
    };
    if (LEGACY_SECRET_KEYS.some((key) => values[key] !== undefined)) await storeSecrets(db, c.env.APP_KEY, secrets);
  }
  return {
    secrets,
    method: values.custom_webhook_method ?? 'POST',
    contentType: values.custom_webhook_content_type ?? 'application/json',
  };
}

export async function saveNotificationSettings(c: Context<AppEnv>, settings: NotificationSettings): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const encrypted = await encrypt(JSON.stringify(settings.secrets), c.env.APP_KEY, SECRET_PURPOSE);
  const db = c.get('db');
  await db.batch([
    { sql: 'INSERT INTO app_settings (key, value, updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at', args: [SECRET_KEY, encrypted, now] },
    { sql: 'INSERT INTO app_settings (key, value, updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at', args: ['custom_webhook_method', settings.method, now] },
    { sql: 'INSERT INTO app_settings (key, value, updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at', args: ['custom_webhook_content_type', settings.contentType, now] },
    { sql: `DELETE FROM app_settings WHERE key IN (${LEGACY_SECRET_KEYS.map(() => '?').join(',')})`, args: [...LEGACY_SECRET_KEYS] },
  ]);
}

export function notificationSettingsView(settings: NotificationSettings) {
  const { secrets } = settings;
  const webhookConfigured = Boolean(secrets.webhookUrl);
  const wxpusherConfigured = Boolean(secrets.wxpusherAppToken && secrets.wxpusherUids);
  const telegramConfigured = Boolean(secrets.telegramBotToken && secrets.telegramChatId);
  const wecomConfigured = Boolean(secrets.wecomWebhookUrl);
  return {
    url: '', headers: '', body: '', wxpusherAppToken: '', wxpusherUids: '', wecomWebhookUrl: '',
    telegramBotToken: '', telegramChatId: '', telegramTopicId: '',
    method: settings.method, contentType: settings.contentType,
    configured: webhookConfigured, webhookConfigured,
    urlConfigured: webhookConfigured, headersConfigured: Boolean(secrets.webhookHeaders),
    bodyConfigured: Boolean(secrets.webhookBody),
    wxpusherConfigured, wxpusherTokenConfigured: Boolean(secrets.wxpusherAppToken),
    wxpusherUidsConfigured: Boolean(secrets.wxpusherUids),
    telegramConfigured, telegramTokenConfigured: Boolean(secrets.telegramBotToken),
    telegramChatIdConfigured: Boolean(secrets.telegramChatId),
    telegramTopicIdConfigured: Boolean(secrets.telegramTopicId),
    wecomConfigured, wecomUrlConfigured: wecomConfigured,
  };
}

export function normalizeWxPusherUids(value: string): string {
  const uids = [...new Set(value.split(/[\s,]+/).map((uid) => uid.trim()).filter(Boolean))];
  if (uids.length > 20 || uids.some((uid) => !/^UID_[A-Za-z0-9_-]{3,124}$/.test(uid))) {
    throw new AppError(400, 'WxPusher 用户 UID 格式无效（最多 20 个）', 'INVALID_WXPUSHER_UID');
  }
  return uids.join(',');
}

export function normalizeWecomWebhookUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new AppError(400, '企业微信 Webhook URL 无效', 'INVALID_WECOM_WEBHOOK_URL'); }
  const entries = [...url.searchParams.entries()];
  if (
    url.protocol !== 'https:' || url.hostname !== 'qyapi.weixin.qq.com' || url.port ||
    url.username || url.password || url.pathname !== '/cgi-bin/webhook/send' || url.hash ||
    entries.length !== 1 || entries[0]![0] !== 'key' || !/^[A-Za-z0-9_-]{16,128}$/.test(entries[0]![1])
  ) {
    throw new AppError(400, '企业微信 Webhook URL 必须使用官方 HTTPS 机器人地址', 'INVALID_WECOM_WEBHOOK_URL');
  }
  return url.toString();
}

async function sendWxPusher(
  appToken: string, uids: string, title: string, content: string, fetchImpl: typeof fetch,
): Promise<{ status: number; ok: boolean }> {
  const response = await fetchImpl('https://wxpusher.zjiecode.com/api/send/message', {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=UTF-8' },
    body: JSON.stringify({ appToken, content, summary: title, contentType: 3, uids: uids.split(',') }),
    signal: AbortSignal.timeout(15_000),
    redirect: 'error',
  });
  if (!response.ok) return { status: response.status, ok: false };
  const body = await response.text();
  if (body.length > 4096) return { status: response.status, ok: false };
  try {
    const payload = JSON.parse(body) as { success?: unknown };
    return { status: response.status, ok: payload.success === true };
  } catch {
    return { status: response.status, ok: false };
  }
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

async function sendTelegram(
  token: string, chatId: string, topicId: string, title: string, content: string, fetchImpl: typeof fetch,
): Promise<{ status: number; ok: boolean }> {
  const payload: Record<string, string | number> = {
    chat_id: chatId, text: `<b>${escapeHtml(title)}</b>\n${escapeHtml(content)}`, parse_mode: 'HTML',
  };
  if (topicId) payload.message_thread_id = Number(topicId);
  const response = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15_000),
    redirect: 'error',
  });
  if (!response.ok) return { status: response.status, ok: false };
  const body = await response.text();
  if (body.length > 4096) return { status: response.status, ok: false };
  try {
    const result = JSON.parse(body) as { ok?: unknown };
    return { status: response.status, ok: result.ok === true };
  } catch {
    return { status: response.status, ok: false };
  }
}

async function sendWecom(
  webhookUrl: string, title: string, content: string, fetchImpl: typeof fetch,
): Promise<{ status: number; ok: boolean }> {
  const message = `### ${title}\n${content}`.replace(/@all\b/gi, (mention) => `@${String.fromCharCode(0x200b)}${mention.slice(1)}`);
  if (new TextEncoder().encode(message).byteLength > 4096) return { status: 413, ok: false };
  const response = await fetchImpl(normalizeWecomWebhookUrl(webhookUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=UTF-8' },
    body: JSON.stringify({ msgtype: 'markdown', markdown: { content: message } }),
    signal: AbortSignal.timeout(15_000),
    redirect: 'error',
  });
  if (!response.ok) return { status: response.status, ok: false };
  const body = await response.text();
  if (body.length > 4096) return { status: response.status, ok: false };
  try {
    const result = JSON.parse(body) as { errcode?: unknown };
    return { status: response.status, ok: result.errcode === 0 };
  } catch {
    return { status: response.status, ok: false };
  }
}

export async function sendConfiguredNotifications(
  c: Context<AppEnv>, title: string, content: string,
): Promise<NotificationDelivery[]> {
  const config = await loadNotificationSettings(c);
  const deliveries: NotificationDelivery[] = [];
  const fetchImpl = c.env.BUDGET.fetch;
  if (config.secrets.webhookUrl) {
    try {
      const webhook = parseConfig({
        custom_webhook_url: config.secrets.webhookUrl,
        custom_webhook_method: config.method,
        custom_webhook_headers: config.secrets.webhookHeaders,
        custom_webhook_content_type: config.contentType,
        custom_webhook_body: config.secrets.webhookBody,
      });
      if (webhook) {
        const result = await sendCustomWebhook(webhook, title, content, fetchImpl);
        deliveries.push({ channel: 'webhook', ok: result.status >= 200 && result.status < 300, status: result.status });
      }
    } catch {
      deliveries.push({ channel: 'webhook', ok: false, status: null });
    }
  }
  if (config.secrets.wxpusherAppToken && config.secrets.wxpusherUids) {
    try {
      const result = await sendWxPusher(config.secrets.wxpusherAppToken, config.secrets.wxpusherUids, title, content, fetchImpl);
      deliveries.push({ channel: 'wxpusher', ...result });
    } catch {
      deliveries.push({ channel: 'wxpusher', ok: false, status: null });
    }
  }
  if (config.secrets.telegramBotToken && config.secrets.telegramChatId) {
    try {
      const result = await sendTelegram(
        config.secrets.telegramBotToken, config.secrets.telegramChatId, config.secrets.telegramTopicId, title, content, fetchImpl,
      );
      deliveries.push({ channel: 'telegram', ...result });
    } catch {
      deliveries.push({ channel: 'telegram', ok: false, status: null });
    }
  }
  if (config.secrets.wecomWebhookUrl) {
    try {
      const result = await sendWecom(config.secrets.wecomWebhookUrl, title, content, fetchImpl);
      deliveries.push({ channel: 'wecom', ...result });
    } catch {
      deliveries.push({ channel: 'wecom', ok: false, status: null });
    }
  }
  return deliveries;
}
