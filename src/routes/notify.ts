import { Hono, type Context } from 'hono';
import type { AppEnv } from '../core/types';
import { AppError } from '../core/errors';
import { input } from '../core/request';
import { requireAdmin, requireCsrf, requireSession, nowSeconds } from '../security/auth';
import { parseConfig } from '../notify/custom';
import {
  loadNotificationSettings, normalizeDingTalkAtMobiles, normalizeDingTalkWebhookUrl, normalizeFeishuUserIds,
  normalizeFeishuWebhookUrl, normalizeMailFrom, normalizeMailRecipients, normalizeQqBotAppId, normalizeQqBotAppSecret,
  normalizeQqBotOpenId, normalizeWecomWebhookUrl, normalizeWxPusherUids, notificationSettingsView,
  NOTIFICATION_CHANNELS, saveNotificationSettings, sendConfiguredNotifications, type NotificationChannel,
} from '../notify/settings';
import { qqBotValidationSignature, sendQqBotMessage, verifyQqBotSignature } from '../notify/qqbot';
import { deliverQueuedNotifications } from '../notify/certificate';

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
    return c.json({ code: 0, ...notificationSettingsView(await loadNotificationSettings(c), { mailAvailable: Boolean(c.env.EMAIL) }) });
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
      dingtalkWebhookUrl: secretValue('dingtalkWebhookUrl', 'clearDingtalk', 1024, current.secrets.dingtalkWebhookUrl),
      dingtalkSecret: secretValue('dingtalkSecret', 'clearDingtalk', 256, current.secrets.dingtalkSecret),
      dingtalkAtMobiles: secretValue('dingtalkAtMobiles', 'clearDingtalk', 512, current.secrets.dingtalkAtMobiles),
      feishuWebhookUrl: secretValue('feishuWebhookUrl', 'clearFeishu', 1024, current.secrets.feishuWebhookUrl),
      feishuUserIds: secretValue('feishuUserIds', 'clearFeishu', 2048, current.secrets.feishuUserIds),
      mailTo: secretValue('mailTo', 'clearMail', 1024, current.secrets.mailTo),
      mailFrom: secretValue('mailFrom', 'clearMail', 254, current.secrets.mailFrom),
      qqbotAppId: secretValue('qqbotAppId', 'clearQqbot', 32, current.secrets.qqbotAppId),
      qqbotAppSecret: secretValue('qqbotAppSecret', 'clearQqbot', 128, current.secrets.qqbotAppSecret),
      qqbotOpenId: secretValue('qqbotOpenId', 'clearQqbot', 128, current.secrets.qqbotOpenId),
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
    if (secrets.dingtalkWebhookUrl) secrets.dingtalkWebhookUrl = normalizeDingTalkWebhookUrl(secrets.dingtalkWebhookUrl);
    if (secrets.dingtalkAtMobiles) secrets.dingtalkAtMobiles = normalizeDingTalkAtMobiles(secrets.dingtalkAtMobiles);
    if (secrets.dingtalkSecret && (secrets.dingtalkSecret.length < 8 || secrets.dingtalkSecret.length > 256)) {
      throw new AppError(400, '钉钉签名密钥长度必须为 8 至 256 个字符', 'INVALID_DINGTALK_SECRET');
    }
    if (!secrets.dingtalkWebhookUrl && (secrets.dingtalkSecret || secrets.dingtalkAtMobiles)) {
      throw new AppError(400, '钉钉 Webhook URL 与签名或 @配置必须一起设置或清除', 'INCOMPLETE_DINGTALK_CONFIG');
    }
    if (secrets.feishuWebhookUrl) secrets.feishuWebhookUrl = normalizeFeishuWebhookUrl(secrets.feishuWebhookUrl);
    if (secrets.feishuUserIds) secrets.feishuUserIds = normalizeFeishuUserIds(secrets.feishuUserIds);
    if (!secrets.feishuWebhookUrl && secrets.feishuUserIds) {
      throw new AppError(400, '飞书 Webhook URL 与 @用户配置必须一起设置或清除', 'INCOMPLETE_FEISHU_CONFIG');
    }
    if (secrets.mailTo) secrets.mailTo = normalizeMailRecipients(secrets.mailTo);
    if (secrets.mailFrom) secrets.mailFrom = normalizeMailFrom(secrets.mailFrom);
    if (Boolean(secrets.mailTo) !== Boolean(secrets.mailFrom)) {
      throw new AppError(400, '收件邮箱与发件邮箱必须同时配置或清除', 'INCOMPLETE_MAIL_CONFIG');
    }
    if (secrets.mailTo && !c.env.EMAIL) {
      throw new AppError(400, '当前运行环境未绑定邮件发送服务（send_email），无法启用邮件通知', 'MAIL_BINDING_REQUIRED');
    }
    if (secrets.qqbotAppId) secrets.qqbotAppId = normalizeQqBotAppId(secrets.qqbotAppId);
    if (secrets.qqbotAppSecret) secrets.qqbotAppSecret = normalizeQqBotAppSecret(secrets.qqbotAppSecret);
    if (secrets.qqbotOpenId) secrets.qqbotOpenId = normalizeQqBotOpenId(secrets.qqbotOpenId);
    if (Boolean(secrets.qqbotAppId) !== Boolean(secrets.qqbotAppSecret)) {
      throw new AppError(400, 'QQ 机器人 AppID 与 AppSecret 必须同时配置或清除', 'INCOMPLETE_QQBOT_CONFIG');
    }
    if (secrets.qqbotOpenId && !secrets.qqbotAppId) {
      throw new AppError(400, '绑定 QQ 机器人 OpenID 前须先配置 AppID 与 AppSecret', 'INCOMPLETE_QQBOT_CONFIG');
    }
    if ((current.secrets.qqbotAppId || current.secrets.qqbotAppSecret)
      && (secrets.qqbotAppId !== current.secrets.qqbotAppId || secrets.qqbotAppSecret !== current.secrets.qqbotAppSecret)) {
      secrets.qqbotOpenId = '';
    }
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
      [c.get('principal').user.id, 'notify.settings', 'system', `webhook=${Boolean(secrets.webhookUrl)},wxpusher=${Boolean(secrets.wxpusherAppToken)},telegram=${Boolean(secrets.telegramBotToken)},wecom=${Boolean(secrets.wecomWebhookUrl)},dingtalk=${Boolean(secrets.dingtalkWebhookUrl)},feishu=${Boolean(secrets.feishuWebhookUrl)},mail=${Boolean(secrets.mailTo)},qqbot=${Boolean(secrets.qqbotOpenId)}`, nowSeconds()],
    );
    return c.json({ code: 0, ...notificationSettingsView({ secrets, method, contentType }, { mailAvailable: Boolean(c.env.EMAIL) }) });
  });

  routes.post('/api/v1/system/notify/test', requireSession, requireCsrf, async (c) => {
    requireSql(c);
    requireAdmin(c);
    const body = await input(c);
    const requested = typeof body.channel === 'string' ? body.channel.trim().toLowerCase() : '';
    if (requested && !NOTIFICATION_CHANNELS.includes(requested as NotificationChannel)) {
      throw new AppError(400, '不支持的通知渠道', 'INVALID_NOTIFICATION_CHANNEL');
    }
    const settings = await loadNotificationSettings(c);
    if (!settings.secrets.webhookUrl && !settings.secrets.wxpusherAppToken && !settings.secrets.telegramBotToken && !settings.secrets.wecomWebhookUrl && !settings.secrets.dingtalkWebhookUrl && !settings.secrets.feishuWebhookUrl && !settings.secrets.mailTo && !settings.secrets.qqbotOpenId) {
      throw new AppError(400, '请先配置至少一个通知渠道', 'NOTIFICATION_NOT_CONFIGURED');
    }
    const rawTitle = typeof body.title === 'string' ? body.title.trim().slice(0, 100) : '';
    const title = rawTitle || 'DNSMGR 测试通知';
    const content = typeof body.content === 'string' ? body.content.slice(0, 2000) : '这是一条来自 DNSMGR 的测试通知。';
    const allowed = requested ? new Set<NotificationChannel>([requested as NotificationChannel]) : undefined;
    const deliveries = await sendConfiguredNotifications(c, title, content, allowed);
    if (deliveries.length === 0) {
      throw new AppError(400, requested ? '该通知渠道尚未配置' : '请先配置至少一个通知渠道', 'NOTIFICATION_NOT_CONFIGURED');
    }
    const failed = deliveries.filter((delivery) => !delivery.ok);
    if (failed.length > 0) {
      throw new AppError(503, `测试发送失败：${failed.map((delivery) => delivery.channel).join(', ')}`, 'NOTIFICATION_FAILED');
    }
    return c.json({
      code: 0, msg: '测试通知已发送', status: deliveries[0]?.status ?? 200,
      channel: requested || 'all',
      channels: deliveries.map(({ channel, status }) => ({ channel, status })),
    });
  });

  routes.post('/api/v1/system/notify/flush', requireSession, requireCsrf, async (c) => {
    requireSql(c);
    requireAdmin(c);
    const result = await deliverQueuedNotifications(c.env, c.get('db'), 5);
    await c.get('db').execute(
      'INSERT INTO audit_logs (user_id, action, target, detail, created_at) VALUES (?,?,?,?,?)',
      [c.get('principal').user.id, 'notify.flush', 'system', `delivered=${result.delivered} failed=${result.failed} pending=${result.pending}`, nowSeconds()],
    );
    return c.json({ code: 0, ...result });
  });

  routes.post('/qqbot/webhook', async (c) => {
    requireSql(c);
    const raw = await c.req.text();
    let payload: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return c.text('bad request', 400);
      payload = parsed as Record<string, unknown>;
    } catch {
      return c.text('bad request', 400);
    }
    const settings = await loadNotificationSettings(c);
    const { qqbotAppId, qqbotAppSecret } = settings.secrets;
    if (!qqbotAppId || !qqbotAppSecret) return c.text('not configured', 400);
    const headerAppId = c.req.header('x-bot-appid') ?? '';
    if (headerAppId && headerAppId !== qqbotAppId) return c.text('appid mismatch', 403);
    if (Number(payload.op ?? 0) === 13) {
      const data = payload.d && typeof payload.d === 'object' ? payload.d as Record<string, unknown> : {};
      const eventTs = typeof data.event_ts === 'string' ? data.event_ts : '';
      const plainToken = typeof data.plain_token === 'string' ? data.plain_token : '';
      if (!eventTs || !plainToken) return c.text('bad request', 400);
      return c.json({ plain_token: plainToken, signature: await qqBotValidationSignature(eventTs, plainToken, qqbotAppSecret) });
    }
    const timestamp = c.req.header('x-signature-timestamp') ?? '';
    const signature = c.req.header('x-signature-ed25519') ?? '';
    if (!await verifyQqBotSignature(timestamp, signature, raw, qqbotAppSecret)) return c.text('invalid signature', 401);
    if (String(payload.t ?? '').toUpperCase() !== 'C2C_MESSAGE_CREATE') return c.text('', 200);
    const event = payload.d && typeof payload.d === 'object' ? payload.d as Record<string, unknown> : {};
    const author = event.author && typeof event.author === 'object' ? event.author as Record<string, unknown> : {};
    const openid = typeof author.user_openid === 'string' ? author.user_openid : '';
    if (!openid) return c.text('', 200);
    if (openid !== settings.secrets.qqbotOpenId) {
      await saveNotificationSettings(c, { ...settings, secrets: { ...settings.secrets, qqbotOpenId: openid } });
      await c.get('db').execute(
        'INSERT INTO audit_logs (user_id,action,target,detail,created_at) VALUES (?,?,?,?,?)',
        [0, 'qqbot.bind', 'system', openid, nowSeconds()],
      );
      try {
        await sendQqBotMessage(c, qqbotAppId, qqbotAppSecret, openid, '绑定成功', '您已绑定 QQ 机器人通知，聚合 DNS 管理系统的通知将通过本机器人发送。');
      } catch { /* 绑定回执失败不影响绑定结果 */ }
    }
    return c.text('', 200);
  });

  return routes;
}
