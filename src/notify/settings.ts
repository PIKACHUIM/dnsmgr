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
    dingtalkWebhookUrl: string;
    dingtalkSecret: string;
    dingtalkAtMobiles: string;
    feishuWebhookUrl: string;
    feishuUserIds: string;
  };
  method: string;
  contentType: string;
}

export interface NotificationDelivery {
  channel: 'webhook' | 'wxpusher' | 'telegram' | 'wecom' | 'dingtalk' | 'feishu';
  ok: boolean;
  status: number | null;
}

function emptySecrets(): NotificationSettings['secrets'] {
  return {
    webhookUrl: '', webhookHeaders: '', webhookBody: '', wxpusherAppToken: '', wxpusherUids: '',
    telegramBotToken: '', telegramChatId: '', telegramTopicId: '', wecomWebhookUrl: '',
    dingtalkWebhookUrl: '', dingtalkSecret: '', dingtalkAtMobiles: '', feishuWebhookUrl: '', feishuUserIds: '',
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
    'telegramBotToken', 'telegramChatId', 'telegramTopicId', 'wecomWebhookUrl', 'dingtalkWebhookUrl', 'dingtalkSecret', 'dingtalkAtMobiles', 'feishuWebhookUrl', 'feishuUserIds',
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
  const dingtalkConfigured = Boolean(secrets.dingtalkWebhookUrl);
  const feishuConfigured = Boolean(secrets.feishuWebhookUrl);
  return {
    url: '', headers: '', body: '', wxpusherAppToken: '', wxpusherUids: '', wecomWebhookUrl: '',
    dingtalkWebhookUrl: '', dingtalkSecret: '', dingtalkAtMobiles: '', feishuWebhookUrl: '', feishuUserIds: '',
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
    dingtalkConfigured, dingtalkUrlConfigured: dingtalkConfigured,
    dingtalkSecretConfigured: Boolean(secrets.dingtalkSecret),
    dingtalkAtMobilesConfigured: Boolean(secrets.dingtalkAtMobiles),
    feishuConfigured, feishuUrlConfigured: feishuConfigured,
    feishuUserIdsConfigured: Boolean(secrets.feishuUserIds),
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

export function normalizeDingTalkWebhookUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new AppError(400, '钉钉 Webhook URL 无效', 'INVALID_DINGTALK_WEBHOOK_URL'); }
  const entries = [...url.searchParams.entries()];
  if (
    url.protocol !== 'https:' || url.hostname !== 'oapi.dingtalk.com' || url.port ||
    url.username || url.password || url.pathname !== '/robot/send' || url.hash ||
    entries.length !== 1 || entries[0]![0] !== 'access_token' || !/^[A-Za-z0-9_-]{16,256}$/.test(entries[0]![1])
  ) {
    throw new AppError(400, '钉钉 Webhook URL 必须使用官方 HTTPS 机器人地址', 'INVALID_DINGTALK_WEBHOOK_URL');
  }
  return url.toString();
}

export function normalizeDingTalkAtMobiles(value: string): string {
  const recipients = [...new Set(value.split(/[\s,，]+/).map((recipient) => recipient.trim()).filter(Boolean))];
  if (recipients.length === 1 && recipients[0]!.toLowerCase() === 'all') return 'all';
  if (recipients.length > 20 || recipients.some((recipient) => !/^\+?\d{5,20}$/.test(recipient))) {
    throw new AppError(400, '钉钉 @用户须为手机号（最多 20 个），或填写 all', 'INVALID_DINGTALK_AT_MOBILES');
  }
  return recipients.join(',');
}

export function normalizeFeishuWebhookUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new AppError(400, '飞书 Webhook URL 无效', 'INVALID_FEISHU_WEBHOOK_URL'); }
  const hostAllowed = url.hostname === 'open.feishu.cn' || url.hostname === 'open.larksuite.com';
  if (
    url.protocol !== 'https:' || !hostAllowed || url.port || url.username || url.password ||
    !/^\/open-apis\/bot\/v2\/hook\/[A-Za-z0-9_-]{16,128}$/.test(url.pathname) || url.search || url.hash
  ) {
    throw new AppError(400, '飞书 Webhook URL 必须使用官方 HTTPS 机器人地址', 'INVALID_FEISHU_WEBHOOK_URL');
  }
  return url.toString();
}

export function normalizeFeishuUserIds(value: string): string {
  const recipients = [...new Set(value.split(/[\s,，]+/).map((recipient) => recipient.trim()).filter(Boolean))];
  if (recipients.length === 1 && recipients[0]!.toLowerCase() === 'all') return 'all';
  if (recipients.length > 20 || recipients.some((recipient) => recipient.toLowerCase() === 'all' || !/^[A-Za-z0-9_-]{1,128}$/.test(recipient))) {
    throw new AppError(400, '飞书 @用户须为有效 user_id（最多 20 个），或填写 all', 'INVALID_FEISHU_USER_ID');
  }
  return recipients.join(',');
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

function escapeDingTalkMarkdown(value: string): string {
  const slash = String.fromCharCode(92);
  const special = new Set([slash, '`', '*', '_', '{', '}', '[', ']', '(', ')', '#', '+', '-', '.', '!', '|', '>', '~']);
  return [...value].map((character) => special.has(character) ? `${slash}${character}` : character).join('');
}

async function signDingTalkUrl(url: URL, secret: string): Promise<URL> {
  if (!secret) return url;
  const timestamp = Date.now();
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(`${timestamp}\n${secret}`)));
  const base64 = btoa(String.fromCharCode(...signature));
  url.searchParams.set('timestamp', String(timestamp));
  url.searchParams.set('sign', base64);
  return url;
}

async function sendDingTalk(
  webhookUrl: string, secret: string, atMobiles: string, title: string, content: string, fetchImpl: typeof fetch,
): Promise<{ status: number; ok: boolean }> {
  const url = await signDingTalkUrl(new URL(normalizeDingTalkWebhookUrl(webhookUrl)), secret);
  const markdown = `### ${escapeDingTalkMarkdown(title)}\n${escapeDingTalkMarkdown(content)}`;
  if (new TextEncoder().encode(markdown).byteLength > 20_000) return { status: 413, ok: false };
  const payload: Record<string, unknown> = {
    msgtype: 'markdown', markdown: { title, text: markdown },
  };
  if (atMobiles.toLowerCase() === 'all') payload.at = { isAtAll: true };
  else if (atMobiles) payload.at = { atMobiles: atMobiles.split(','), isAtAll: false };
  const response = await fetchImpl(url.toString(), {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=UTF-8' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15_000),
    redirect: 'error',
  });
  if (!response.ok) return { status: response.status, ok: false };
  const body = await response.text();
  if (body.length > 4096) return { status: response.status, ok: false };
  try {
    const result = JSON.parse(body) as { errcode?: unknown; code?: unknown };
    return { status: response.status, ok: result.errcode === 0 || result.code === 0 };
  } catch {
    return { status: response.status, ok: false };
  }
}

function escapeFeishuMarkdown(value: string): string {
  const slash = String.fromCharCode(92);
  const special = new Set([slash, '`', '*', '_', '{', '}', '[', ']', '(', ')', '#', '+', '-', '.', '!', '|', '>', '~', '<', '>']);
  return [...value].map((character) => special.has(character) ? `${slash}${character}` : character).join('');
}

function feishuCardTemplate(title: string): string {
  if (title.includes('发生告警') || title.includes('失败')) return 'red';
  if (title.includes('恢复正常')) return 'green';
  if (title.includes('到期提醒')) return 'yellow';
  return 'blue';
}

async function sendFeishu(
  webhookUrl: string, userIds: string, title: string, content: string, fetchImpl: typeof fetch,
): Promise<{ status: number; ok: boolean }> {
  const markdownContent = escapeFeishuMarkdown(content);
  const mentions = userIds.toLowerCase() === 'all'
    ? '<at id=all></at>'
    : userIds.split(',').filter(Boolean).map((id) => `<at user_id="${id}"></at>`).join('');
  const message = mentions ? `${markdownContent}\n${mentions}` : markdownContent;
  if (new TextEncoder().encode(message).byteLength > 20_000) return { status: 413, ok: false };
  const padding = '12px 12px 12px 12px';
  const payload = {
    msg_type: 'interactive',
    card: {
      schema: '2.0',
      config: {
        update_multi: true,
        style: { text_size: { normal_v2: { default: 'normal', pc: 'normal', mobile: 'heading' } } },
      },
      header: {
        title: { tag: 'plain_text', content: title }, subtitle: { tag: 'plain_text', content: '' },
        template: feishuCardTemplate(title), padding,
      },
      body: {
        direction: 'vertical', padding,
        elements: [{ tag: 'markdown', content: message, text_align: 'left', text_size: 'normal_v2', margin: '0px 0px 0px 0px' }],
      },
    },
  };
  const response = await fetchImpl(normalizeFeishuWebhookUrl(webhookUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=UTF-8' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15_000),
    redirect: 'error',
  });
  if (!response.ok) return { status: response.status, ok: false };
  const body = await response.text();
  if (body.length > 4096) return { status: response.status, ok: false };
  try {
    const result = JSON.parse(body) as { errcode?: unknown; code?: unknown };
    return { status: response.status, ok: result.errcode === 0 || result.code === 0 };
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
  if (config.secrets.dingtalkWebhookUrl) {
    try {
      const result = await sendDingTalk(
        config.secrets.dingtalkWebhookUrl, config.secrets.dingtalkSecret, config.secrets.dingtalkAtMobiles, title, content, fetchImpl,
      );
      deliveries.push({ channel: 'dingtalk', ...result });
    } catch {
      deliveries.push({ channel: 'dingtalk', ok: false, status: null });
    }
  }
  if (config.secrets.feishuWebhookUrl) {
    try {
      const result = await sendFeishu(config.secrets.feishuWebhookUrl, config.secrets.feishuUserIds, title, content, fetchImpl);
      deliveries.push({ channel: 'feishu', ...result });
    } catch {
      deliveries.push({ channel: 'feishu', ok: false, status: null });
    }
  }
  return deliveries;
}
