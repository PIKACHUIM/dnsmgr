import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app';
import type { Bindings, RequestBudget } from '../src/core/types';
import { environment } from '../src/platform/runtime';
import { parseConfig, renderTemplate } from '../src/notify/custom';
import { signQqBotPayload, verifyQqBotSignature } from '../src/notify/qqbot';
import { createTestDatabase } from './helpers/sqlite';

const credentials = { username: 'admin', password: 'test-password-2026!' };
const appKey = btoa('12345678901234567890123456789012');

describe('custom webhook rendering', () => {
  it('validates and renders templates', () => {
    const config = parseConfig({
      custom_webhook_url: 'https://example.com/hook', custom_webhook_method: 'POST',
      custom_webhook_headers: '{"Authorization":"Bearer x","N":1}', custom_webhook_body: '{"t":"{title}","c":"{content}"}',
    });
    expect(config).toMatchObject({ url: 'https://example.com/hook', method: 'POST', headers: { Authorization: 'Bearer x' } });
    expect(renderTemplate('{title}: {content}', 'T', 'C')).toBe('T: C');
    expect(() => parseConfig({ custom_webhook_url: 'ftp://x' })).toThrow(/http/);
    expect(() => parseConfig({ custom_webhook_url: 'https://x', custom_webhook_headers: '[]' })).toThrow(/JSON/);
  });
});

describe('notification settings API', () => {
  let testDb: ReturnType<typeof createTestDatabase>;
  let app: ReturnType<typeof createApp>;
  let bindings: Bindings;
  let cookie = '';
  let csrf = '';
  let sent: string[] = [];
  let wxpusherSuccess = true;
  let telegramOk = true;
  let wecomErrcode = 0;
  let dingtalkErrcode = 0;
  let feishuCode = 0;
  let qqbotSendOk = true;
  let mailMessages: Record<string, unknown>[] = [];

  beforeEach(async () => {
    testDb = createTestDatabase();
    app = createApp({ database: testDb.db });
    sent = [];
    wxpusherSuccess = true;
    telegramOk = true;
    wecomErrcode = 0;
    dingtalkErrcode = 0;
    feishuCode = 0;
    qqbotSendOk = true;
    mailMessages = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      sent.push(`${init.method ?? 'GET'} ${String(input)} ${String(init.body ?? '')}`);
      const url = new URL(String(input));
      if (url.hostname === 'bots.qq.com') {
        return new Response(JSON.stringify({ access_token: 'qqbot-access-token', expires_in: 7200 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.hostname === 'api.sgroup.qq.com') {
        return new Response(JSON.stringify(qqbotSendOk ? { id: 'msg-1' } : { code: 40054, message: 'active message rejected' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.hostname === 'wxpusher.zjiecode.com') {
        return new Response(JSON.stringify({ success: wxpusherSuccess }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.hostname === 'api.telegram.org') {
        return new Response(JSON.stringify({ ok: telegramOk }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.hostname === 'qyapi.weixin.qq.com') {
        return new Response(JSON.stringify({ errcode: wecomErrcode, errmsg: wecomErrcode === 0 ? 'ok' : 'rejected' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.hostname === 'oapi.dingtalk.com') {
        return new Response(JSON.stringify({ errcode: dingtalkErrcode, errmsg: dingtalkErrcode === 0 ? 'ok' : 'rejected' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.hostname === 'open.feishu.cn' || url.hostname === 'open.larksuite.com') {
        return new Response(JSON.stringify({ code: feishuCode, msg: feishuCode === 0 ? 'success' : 'rejected' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response('ok', { status: 200 });
    }) as unknown as typeof fetch;
    const budget: RequestBudget = { consume: () => {}, remainingMs: () => 30_000, fetch: fetchMock };
    bindings = {
      DB_DRIVER: 'turso', DB_FORMAT: 'sql', TURSO_DATABASE_URL: 'https://test.invalid', TURSO_AUTH_TOKEN: 'test-token',
      APP_KEY: appKey, SETUP_TOKEN: 'test-install-token-32-characters!!', BUDGET: budget,
    };
    await post('/install', credentials, { 'X-Setup-Token': bindings.SETUP_TOKEN! });
    const login = await post('/login', credentials);
    const body = await login.json() as { csrfToken: string };
    csrf = body.csrfToken;
    cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  });
  afterEach(() => { testDb.close(); });

  function request(path: string, init: RequestInit = {}) {
    return app.request(`https://panel.example${path}`, init, environment(bindings, 'local'));
  }
  function post(path: string, body: unknown, headers: Record<string, string> = {}) {
    return request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie, 'X-CSRF-Token': csrf, ...headers },
      body: JSON.stringify(body),
    });
  }

  it('encrypts channel credentials, redacts reads and sends both configured channels', async () => {
    const saved = await request('/api/v1/system/notify', {
      method: 'PUT', headers: { 'content-type': 'application/json', cookie, 'X-CSRF-Token': csrf },
      body: JSON.stringify({
        url: 'https://example.com/hook?token=webhook-secret', method: 'POST',
        headers: '{"Authorization":"Bearer header-secret"}', contentType: 'application/json',
        body: '{"t":"{title}","c":"{content}","credential":"body-secret"}',
        wxpusherAppToken: 'AT_wxpusher-secret', wxpusherUids: 'UID_test-user',
      }),
    });
    expect(await saved.json()).toMatchObject({ code: 0, configured: true, webhookConfigured: true, wxpusherConfigured: true });

    const stored = await testDb.db.query<{ key: string; value: string }>(
      "SELECT key, value FROM app_settings WHERE key IN ('notification_secrets_cipher','custom_webhook_url','custom_webhook_headers','custom_webhook_body')",
    );
    const cipher = stored.find((row) => row.key === 'notification_secrets_cipher')!.value;
    expect(cipher).not.toContain('webhook-secret');
    expect(cipher).not.toContain('header-secret');
    expect(cipher).not.toContain('body-secret');
    expect(cipher).not.toContain('AT_wxpusher-secret');
    expect(cipher).not.toContain('UID_test-user');
    expect(stored.filter((row) => row.key !== 'notification_secrets_cipher')).toHaveLength(0);

    const viewResponse = await request('/api/v1/system/notify', { headers: { cookie } });
    const view = await viewResponse.json() as Record<string, unknown>;
    expect(view).toMatchObject({ url: '', headers: '', body: '', urlConfigured: true, headersConfigured: true, bodyConfigured: true, wxpusherTokenConfigured: true, wxpusherUidsConfigured: true });
    expect(JSON.stringify(view)).not.toContain('webhook-secret');
    expect(JSON.stringify(view)).not.toContain('header-secret');
    expect(JSON.stringify(view)).not.toContain('body-secret');
    expect(JSON.stringify(view)).not.toContain('AT_wxpusher-secret');
    expect(JSON.stringify(view)).not.toContain('UID_test-user');

    const updated = await request('/api/v1/system/notify', {
      method: 'PUT', headers: { 'content-type': 'application/json', cookie, 'X-CSRF-Token': csrf },
      body: JSON.stringify({ method: 'PUT' }),
    });
    expect(await updated.json()).toMatchObject({ webhookConfigured: true, wxpusherConfigured: true });

    const sentResponse = await post('/api/v1/system/notify/test', { title: '标题', content: '正文' });
    expect(await sentResponse.json()).toMatchObject({ code: 0, status: 200, channels: [{ channel: 'webhook', status: 200 }, { channel: 'wxpusher', status: 200 }] });
    expect(sent[0]).toContain('PUT https://example.com/hook?token=webhook-secret');
    expect(sent[0]).toContain('"t":"标题"');
    expect(sent[0]).toContain('"c":"正文"');
    expect(sent[1]).toContain('https://wxpusher.zjiecode.com/api/send/message');
    expect(sent[1]).toContain('"appToken":"AT_wxpusher-secret"');
    expect(sent[1]).toContain('"uids":["UID_test-user"]');

    const cleared = await request('/api/v1/system/notify', {
      method: 'PUT', headers: { 'content-type': 'application/json', cookie, 'X-CSRF-Token': csrf },
      body: JSON.stringify({ clearWxpusherAppToken: true, clearWxpusherUids: true }),
    });
    expect(await cleared.json()).toMatchObject({ webhookConfigured: true, wxpusherConfigured: false });
  });

  it('reports WxPusher rejection without returning response details or credentials', async () => {
    await request('/api/v1/system/notify', {
      method: 'PUT', headers: { 'content-type': 'application/json', cookie, 'X-CSRF-Token': csrf },
      body: JSON.stringify({ wxpusherAppToken: 'AT_rejected-secret', wxpusherUids: 'UID_rejected-test' }),
    });
    wxpusherSuccess = false;
    const response = await post('/api/v1/system/notify/test', { title: 'test', content: 'test' });
    const result = await response.json() as Record<string, unknown>;
    expect(response.status).toBe(503);
    expect(result.reason).toBe('NOTIFICATION_FAILED');
    expect(JSON.stringify(result)).not.toContain('AT_rejected-secret');
  });

  it('encrypts legacy plaintext settings on first read and rejects invalid WxPusher recipients', async () => {
    await testDb.db.batch([
      { sql: 'INSERT INTO app_settings (key, value, updated_at) VALUES (?,?,?)', args: ['custom_webhook_url', 'https://legacy.example/hook?secret=legacy-secret', 1] },
      { sql: 'INSERT INTO app_settings (key, value, updated_at) VALUES (?,?,?)', args: ['custom_webhook_headers', '{"Authorization":"legacy-header"}', 1] },
      { sql: 'INSERT INTO app_settings (key, value, updated_at) VALUES (?,?,?)', args: ['custom_webhook_body', '{"token":"legacy-body"}', 1] },
    ]);
    const response = await request('/api/v1/system/notify', { headers: { cookie } });
    const view = await response.json() as Record<string, unknown>;
    expect(view).toMatchObject({ webhookConfigured: true, url: '', headers: '', body: '' });
    expect(JSON.stringify(view)).not.toContain('legacy-secret');
    const keys = await testDb.db.query<{ key: string; value: string }>(
      "SELECT key, value FROM app_settings WHERE key IN ('notification_secrets_cipher','custom_webhook_url','custom_webhook_headers','custom_webhook_body')",
    );
    expect(keys).toHaveLength(1);
    expect(keys[0]!.value).not.toContain('legacy-secret');

    const invalid = await request('/api/v1/system/notify', {
      method: 'PUT', headers: { 'content-type': 'application/json', cookie, 'X-CSRF-Token': csrf },
      body: JSON.stringify({ wxpusherAppToken: 'AT_test', wxpusherUids: 'not-a-uid' }),
    });
    expect(invalid.status).toBe(400);
    expect((await invalid.json()).reason).toBe('INVALID_WXPUSHER_UID');
  });

  it('encrypts and redacts Telegram credentials, escapes HTML and sends to the configured topic', async () => {
    const token = '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi';
    const chatId = '-1001234567890';
    const saved = await request('/api/v1/system/notify', {
      method: 'PUT', headers: { 'content-type': 'application/json', cookie, 'X-CSRF-Token': csrf },
      body: JSON.stringify({ telegramBotToken: token, telegramChatId: chatId, telegramTopicId: '42' }),
    });
    expect(await saved.json()).toMatchObject({ telegramConfigured: true, telegramTokenConfigured: true, telegramChatIdConfigured: true, telegramTopicIdConfigured: true });

    const stored = await testDb.db.query<{ value: string }>("SELECT value FROM app_settings WHERE key = 'notification_secrets_cipher'");
    expect(stored[0]!.value).not.toContain(token);
    expect(stored[0]!.value).not.toContain(chatId);
    expect(stored[0]!.value).not.toContain('"telegramTopicId":"42"');
    const viewResponse = await request('/api/v1/system/notify', { headers: { cookie } });
    const view = await viewResponse.json() as Record<string, unknown>;
    expect(view).toMatchObject({ telegramBotToken: '', telegramChatId: '', telegramTopicId: '', telegramConfigured: true });
    expect(JSON.stringify(view)).not.toContain(token);
    expect(JSON.stringify(view)).not.toContain(chatId);

    const sentResponse = await post('/api/v1/system/notify/test', { title: '<unsafe>', content: '&payload' });
    expect(await sentResponse.json()).toMatchObject({ code: 0, channels: [{ channel: 'telegram', status: 200 }] });
    const telegramCall = sent.find((entry) => entry.includes('api.telegram.org'))!;
    expect(telegramCall).toContain(`/bot${token}/sendMessage`);
    const payload = JSON.parse(telegramCall.slice(telegramCall.indexOf('{'))) as Record<string, unknown>;
    expect(payload).toMatchObject({ chat_id: chatId, parse_mode: 'HTML', message_thread_id: 42 });
    expect(payload.text).toBe('<b>&lt;unsafe&gt;</b>\n&amp;payload');

    const cleared = await request('/api/v1/system/notify', {
      method: 'PUT', headers: { 'content-type': 'application/json', cookie, 'X-CSRF-Token': csrf },
      body: JSON.stringify({ clearTelegram: true }),
    });
    expect(await cleared.json()).toMatchObject({ telegramConfigured: false, telegramTokenConfigured: false, telegramChatIdConfigured: false, telegramTopicIdConfigured: false });
  });

  it('sends Telegram messages without a topic and reports Bot API rejection without leaking the token', async () => {
    const token = '987654321:abcdefghijklmnopqrstuvwxyzABCDEFGH';
    const saved = await request('/api/v1/system/notify', {
      method: 'PUT', headers: { 'content-type': 'application/json', cookie, 'X-CSRF-Token': csrf },
      body: JSON.stringify({ telegramBotToken: token, telegramChatId: '@alerts_channel' }),
    });
    expect(saved.status).toBe(200);
    const sentResponse = await post('/api/v1/system/notify/test', { title: 'ok', content: 'message' });
    expect(sentResponse.status).toBe(200);
    const telegramCall = sent.find((entry) => entry.includes('api.telegram.org'))!;
    const payload = JSON.parse(telegramCall.slice(telegramCall.indexOf('{'))) as Record<string, unknown>;
    expect(payload).not.toHaveProperty('message_thread_id');

    telegramOk = false;
    const rejected = await post('/api/v1/system/notify/test', { title: 'ok', content: 'message' });
    const result = await rejected.json() as Record<string, unknown>;
    expect(rejected.status).toBe(503);
    expect(result.reason).toBe('NOTIFICATION_FAILED');
    expect(JSON.stringify(result)).not.toContain(token);
  });

  it('rejects incomplete Telegram credentials and malformed topic IDs', async () => {
    const token = '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi';
    const incomplete = await request('/api/v1/system/notify', {
      method: 'PUT', headers: { 'content-type': 'application/json', cookie, 'X-CSRF-Token': csrf },
      body: JSON.stringify({ telegramBotToken: token }),
    });
    expect(incomplete.status).toBe(400);
    expect((await incomplete.json()).reason).toBe('INCOMPLETE_TELEGRAM_CONFIG');

    const invalidTopic = await request('/api/v1/system/notify', {
      method: 'PUT', headers: { 'content-type': 'application/json', cookie, 'X-CSRF-Token': csrf },
      body: JSON.stringify({ telegramBotToken: token, telegramChatId: '12345', telegramTopicId: '12x' }),
    });
    expect(invalidTopic.status).toBe(400);
    expect((await invalidTopic.json()).reason).toBe('INVALID_TELEGRAM_TOPIC_ID');
  });

  it('encrypts and redacts the enterprise WeChat webhook and sends Markdown notifications', async () => {
    const key = '0123456789abcdef0123456789abcdef';
    const webhookUrl = `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${key}`;
    const saved = await request('/api/v1/system/notify', {
      method: 'PUT', headers: { 'content-type': 'application/json', cookie, 'X-CSRF-Token': csrf },
      body: JSON.stringify({ wecomWebhookUrl: webhookUrl }),
    });
    expect(await saved.json()).toMatchObject({ wecomConfigured: true, wecomUrlConfigured: true, wecomWebhookUrl: '' });

    const stored = await testDb.db.query<{ value: string }>("SELECT value FROM app_settings WHERE key = 'notification_secrets_cipher'");
    expect(stored[0]!.value).not.toContain(key);
    expect(stored[0]!.value).not.toContain(webhookUrl);
    const viewResponse = await request('/api/v1/system/notify', { headers: { cookie } });
    const view = await viewResponse.json() as Record<string, unknown>;
    expect(view).toMatchObject({ wecomConfigured: true, wecomWebhookUrl: '' });
    expect(JSON.stringify(view)).not.toContain(key);

    const sentResponse = await post('/api/v1/system/notify/test', { title: '告警', content: '域名解析已更新 @all' });
    expect(await sentResponse.json()).toMatchObject({ code: 0, channels: [{ channel: 'wecom', status: 200 }] });
    const wecomCall = sent.find((entry) => entry.includes('qyapi.weixin.qq.com'))!;
    expect(wecomCall).toContain(webhookUrl);
    const payload = JSON.parse(wecomCall.slice(wecomCall.indexOf('{'))) as Record<string, unknown>;
    expect(payload).toEqual({ msgtype: 'markdown', markdown: { content: `### 告警\n域名解析已更新 @${String.fromCharCode(0x200b)}all` } });

    wecomErrcode = 93000;
    const rejected = await post('/api/v1/system/notify/test', { title: '告警', content: '失败' });
    expect(rejected.status).toBe(503);
    expect(JSON.stringify(await rejected.json())).not.toContain(key);

    const cleared = await request('/api/v1/system/notify', {
      method: 'PUT', headers: { 'content-type': 'application/json', cookie, 'X-CSRF-Token': csrf },
      body: JSON.stringify({ clearWecom: true }),
    });
    expect(await cleared.json()).toMatchObject({ wecomConfigured: false, wecomUrlConfigured: false });
  });

  it('rejects non-official enterprise WeChat webhook URLs', async () => {
    const invalid = await request('/api/v1/system/notify', {
      method: 'PUT', headers: { 'content-type': 'application/json', cookie, 'X-CSRF-Token': csrf },
      body: JSON.stringify({ wecomWebhookUrl: 'https://qyapi.weixin.qq.com.evil.test/cgi-bin/webhook/send?key=0123456789abcdef' }),
    });
    expect(invalid.status).toBe(400);
    expect((await invalid.json()).reason).toBe('INVALID_WECOM_WEBHOOK_URL');
  });

  it('encrypts DingTalk robot credentials, signs requests, and sends escaped Markdown with mentions', async () => {
    const accessToken = '0123456789abcdef0123456789abcdef0123456789abcdef';
    const secret = 'SEC_dingtalk_signing_secret_0123456789';
    const webhookUrl = `https://oapi.dingtalk.com/robot/send?access_token=${accessToken}`;
    const saved = await request('/api/v1/system/notify', {
      method: 'PUT', headers: { 'content-type': 'application/json', cookie, 'X-CSRF-Token': csrf },
      body: JSON.stringify({ dingtalkWebhookUrl: webhookUrl, dingtalkSecret: secret, dingtalkAtMobiles: '+8613800138000,13800138001' }),
    });
    expect(await saved.json()).toMatchObject({ dingtalkConfigured: true, dingtalkUrlConfigured: true, dingtalkSecretConfigured: true, dingtalkAtMobilesConfigured: true });

    const stored = await testDb.db.query<{ value: string }>("SELECT value FROM app_settings WHERE key = 'notification_secrets_cipher'");
    expect(stored[0]!.value).not.toContain(accessToken);
    expect(stored[0]!.value).not.toContain(secret);
    expect(stored[0]!.value).not.toContain('13800138001');
    const view = await (await request('/api/v1/system/notify', { headers: { cookie } })).json() as Record<string, unknown>;
    expect(view).toMatchObject({ dingtalkWebhookUrl: '', dingtalkSecret: '', dingtalkAtMobiles: '', dingtalkConfigured: true });
    expect(JSON.stringify(view)).not.toContain(accessToken);
    expect(JSON.stringify(view)).not.toContain(secret);

    const sentResponse = await post('/api/v1/system/notify/test', { title: 'DNS *告警*', content: '解析[已切换]' });
    expect(await sentResponse.json()).toMatchObject({ code: 0, channels: [{ channel: 'dingtalk', status: 200 }] });
    const call = sent.find((entry) => entry.includes('oapi.dingtalk.com'))!;
    const [method, requestUrl] = call.split(' ');
    expect(method).toBe('POST');
    const signedUrl = new URL(requestUrl!);
    expect(signedUrl.searchParams.get('access_token')).toBe(accessToken);
    const timestamp = signedUrl.searchParams.get('timestamp')!;
    expect(Number(timestamp)).toBeGreaterThan(Date.now() - 30_000);
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}\n${secret}`)));
    expect(signedUrl.searchParams.get('sign')).toBe(btoa(String.fromCharCode(...signature)));
    const payload = JSON.parse(call.slice(call.indexOf('{'))) as { at: Record<string, unknown>; markdown: { text: string } };
    expect(payload.at).toEqual({ atMobiles: ['+8613800138000', '13800138001'], isAtAll: false });
    expect(payload.markdown.text).toContain(`${String.fromCharCode(92)}*告警${String.fromCharCode(92)}*`);
    expect(payload.markdown.text).toContain(`${String.fromCharCode(92)}[已切换${String.fromCharCode(92)}]`);

    dingtalkErrcode = 310000;
    const rejected = await post('/api/v1/system/notify/test', { title: 'test', content: 'failed' });
    expect(rejected.status).toBe(503);
    const rejection = JSON.stringify(await rejected.json());
    expect(rejection).not.toContain(accessToken);
    expect(rejection).not.toContain(secret);

    const cleared = await request('/api/v1/system/notify', {
      method: 'PUT', headers: { 'content-type': 'application/json', cookie, 'X-CSRF-Token': csrf },
      body: JSON.stringify({ clearDingtalk: true }),
    });
    expect(await cleared.json()).toMatchObject({ dingtalkConfigured: false, dingtalkSecretConfigured: false, dingtalkAtMobilesConfigured: false });
  });

  it('validates the official DingTalk URL, signing secret and @mention configuration', async () => {
    const invalid = await request('/api/v1/system/notify', {
      method: 'PUT', headers: { 'content-type': 'application/json', cookie, 'X-CSRF-Token': csrf },
      body: JSON.stringify({ dingtalkWebhookUrl: 'https://oapi.dingtalk.com.evil.test/robot/send?access_token=0123456789abcdef' }),
    });
    expect(invalid.status).toBe(400);
    expect((await invalid.json()).reason).toBe('INVALID_DINGTALK_WEBHOOK_URL');

    const invalidAt = await request('/api/v1/system/notify', {
      method: 'PUT', headers: { 'content-type': 'application/json', cookie, 'X-CSRF-Token': csrf },
      body: JSON.stringify({ dingtalkWebhookUrl: 'https://oapi.dingtalk.com/robot/send?access_token=0123456789abcdef', dingtalkAtMobiles: 'all,13800138000' }),
    });
    expect(invalidAt.status).toBe(400);
    expect((await invalidAt.json()).reason).toBe('INVALID_DINGTALK_AT_MOBILES');
  });

  it('encrypts Feishu bot settings and sends interactive cards with escaped content and mentions', async () => {
    const token = 'feishu-hook-token-0123456789';
    const webhookUrl = `https://open.feishu.cn/open-apis/bot/v2/hook/${token}`;
    const userId = 'ou_test-user_123';
    const saved = await request('/api/v1/system/notify', {
      method: 'PUT', headers: { 'content-type': 'application/json', cookie, 'X-CSRF-Token': csrf },
      body: JSON.stringify({ feishuWebhookUrl: webhookUrl, feishuUserIds: userId }),
    });
    expect(await saved.json()).toMatchObject({ feishuConfigured: true, feishuUrlConfigured: true, feishuUserIdsConfigured: true, feishuWebhookUrl: '', feishuUserIds: '' });

    const stored = await testDb.db.query<{ value: string }>("SELECT value FROM app_settings WHERE key = 'notification_secrets_cipher'");
    expect(stored[0]!.value).not.toContain(token);
    expect(stored[0]!.value).not.toContain(userId);
    const view = await (await request('/api/v1/system/notify', { headers: { cookie } })).json() as Record<string, unknown>;
    expect(view).toMatchObject({ feishuWebhookUrl: '', feishuUserIds: '', feishuConfigured: true });
    expect(JSON.stringify(view)).not.toContain(token);
    expect(JSON.stringify(view)).not.toContain(userId);

    const sentResponse = await post('/api/v1/system/notify/test', { title: 'DNS 发生告警', content: '域名 *切换* <edge>' });
    expect(await sentResponse.json()).toMatchObject({ code: 0, channels: [{ channel: 'feishu', status: 200 }] });
    const call = sent.find((entry) => entry.includes('open.feishu.cn'))!;
    expect(call).toContain(webhookUrl);
    const payload = JSON.parse(call.slice(call.indexOf('{'))) as {
      msg_type: string;
      card: { schema: string; header: { template: string; title: { content: string } }; body: { elements: Array<{ tag: string; content: string }> } };
    };
    expect(payload.msg_type).toBe('interactive');
    expect(payload.card.schema).toBe('2.0');
    expect(payload.card.header.template).toBe('red');
    expect(payload.card.header.title.content).toBe('DNS 发生告警');
    expect(payload.card.body.elements[0]!.tag).toBe('markdown');
    expect(payload.card.body.elements[0]!.content).toContain(`域名 ${String.fromCharCode(92)}*切换${String.fromCharCode(92)}* ${String.fromCharCode(92)}<edge${String.fromCharCode(92)}>`);
    expect(payload.card.body.elements[0]!.content).toContain(`<at user_id="${userId}"></at>`);

    const allSaved = await request('/api/v1/system/notify', {
      method: 'PUT', headers: { 'content-type': 'application/json', cookie, 'X-CSRF-Token': csrf },
      body: JSON.stringify({ feishuUserIds: 'all' }),
    });
    expect(allSaved.status).toBe(200);
    await post('/api/v1/system/notify/test', { title: 'DNS 恢复正常', content: '已恢复' });
    const allCall = sent.filter((entry) => entry.includes('open.feishu.cn')).at(-1)!;
    const allPayload = JSON.parse(allCall.slice(allCall.indexOf('{'))) as { card: { header: { template: string }; body: { elements: Array<{ content: string }> } } };
    expect(allPayload.card.header.template).toBe('green');
    expect(allPayload.card.body.elements[0]!.content).toContain('<at id=all></at>');

    await post('/api/v1/system/notify/test', { title: 'DNS 到期提醒', content: '请在到期前续期' });
    const expiryCall = sent.filter((entry) => entry.includes('open.feishu.cn')).at(-1)!;
    const expiryPayload = JSON.parse(expiryCall.slice(expiryCall.indexOf('{'))) as { card: { header: { template: string } } };
    expect(expiryPayload.card.header.template).toBe('yellow');
    await post('/api/v1/system/notify/test', { title: 'DNS 通知', content: '状态更新' });
    const defaultCall = sent.filter((entry) => entry.includes('open.feishu.cn')).at(-1)!;
    const defaultPayload = JSON.parse(defaultCall.slice(defaultCall.indexOf('{'))) as { card: { header: { template: string } } };
    expect(defaultPayload.card.header.template).toBe('blue');

    feishuCode = 999;
    const rejected = await post('/api/v1/system/notify/test', { title: 'DNS 发生告警失败', content: '失败' });
    expect(rejected.status).toBe(503);
    const rejection = JSON.stringify(await rejected.json());
    expect(rejection).not.toContain(token);
    expect(rejection).not.toContain(userId);

    const cleared = await request('/api/v1/system/notify', {
      method: 'PUT', headers: { 'content-type': 'application/json', cookie, 'X-CSRF-Token': csrf },
      body: JSON.stringify({ clearFeishu: true }),
    });
    expect(await cleared.json()).toMatchObject({ feishuConfigured: false, feishuUrlConfigured: false, feishuUserIdsConfigured: false });
  });

  it('validates official Feishu webhooks and recipient IDs', async () => {
    const invalidUrl = await request('/api/v1/system/notify', {
      method: 'PUT', headers: { 'content-type': 'application/json', cookie, 'X-CSRF-Token': csrf },
      body: JSON.stringify({ feishuWebhookUrl: 'https://open.feishu.cn.evil.test/open-apis/bot/v2/hook/0123456789abcdef' }),
    });
    expect(invalidUrl.status).toBe(400);
    expect((await invalidUrl.json()).reason).toBe('INVALID_FEISHU_WEBHOOK_URL');

    const webhookUrl = 'https://open.larksuite.com/open-apis/bot/v2/hook/0123456789abcdef';
    const invalidUserId = await request('/api/v1/system/notify', {
      method: 'PUT', headers: { 'content-type': 'application/json', cookie, 'X-CSRF-Token': csrf },
      body: JSON.stringify({ feishuWebhookUrl: webhookUrl, feishuUserIds: 'id with spaces' }),
    });
    expect(invalidUserId.status).toBe(400);
    expect((await invalidUserId.json()).reason).toBe('INVALID_FEISHU_USER_ID');

    const mixedAll = await request('/api/v1/system/notify', {
      method: 'PUT', headers: { 'content-type': 'application/json', cookie, 'X-CSRF-Token': csrf },
      body: JSON.stringify({ feishuWebhookUrl: webhookUrl, feishuUserIds: 'all,ou_user_123' }),
    });
    expect(mixedAll.status).toBe(400);
    expect((await mixedAll.json()).reason).toBe('INVALID_FEISHU_USER_ID');

    const incomplete = await request('/api/v1/system/notify', {
      method: 'PUT', headers: { 'content-type': 'application/json', cookie, 'X-CSRF-Token': csrf },
      body: JSON.stringify({ feishuUserIds: 'ou_user_123' }),
    });
    expect(incomplete.status).toBe(400);
    expect((await incomplete.json()).reason).toBe('INCOMPLETE_FEISHU_CONFIG');
  });

  it('requires the email binding and sends mail notifications with the configured sender', async () => {
    const missing = await request('/api/v1/system/notify', {
      method: 'PUT', headers: { 'content-type': 'application/json', cookie, 'X-CSRF-Token': csrf },
      body: JSON.stringify({ mailTo: 'ops@example.test', mailFrom: 'dns@example.test' }),
    });
    expect(missing.status).toBe(400);
    expect((await missing.json()).reason).toBe('MAIL_BINDING_REQUIRED');

    bindings.EMAIL = {
      send: async (message) => { mailMessages.push(message as unknown as Record<string, unknown>); return { messageId: 'mail-1' }; },
    };
    const invalid = await request('/api/v1/system/notify', {
      method: 'PUT', headers: { 'content-type': 'application/json', cookie, 'X-CSRF-Token': csrf },
      body: JSON.stringify({ mailTo: 'not-an-email', mailFrom: 'dns@example.test' }),
    });
    expect(invalid.status).toBe(400);
    expect((await invalid.json()).reason).toBe('INVALID_MAIL_RECIPIENTS');

    const saved = await request('/api/v1/system/notify', {
      method: 'PUT', headers: { 'content-type': 'application/json', cookie, 'X-CSRF-Token': csrf },
      body: JSON.stringify({ mailTo: 'ops@example.test', mailFrom: 'dns@example.test' }),
    });
    expect(await saved.json()).toMatchObject({ mailConfigured: true, mailToConfigured: true, mailFromConfigured: true, mailBindingAvailable: true });

    const read = await request('/api/v1/system/notify', { headers: { cookie } });
    const view = JSON.stringify(await read.json());
    expect(view).not.toContain('ops@example.test');
    expect(view).toContain('"mailConfigured":true');

    const delivered = await post('/api/v1/system/notify/test', { title: '证书到期', content: 'example.test 即将到期' });
    expect(await delivered.json()).toMatchObject({ code: 0, channels: [{ channel: 'mail', status: 202 }] });
    expect(mailMessages).toHaveLength(1);
    expect(mailMessages[0]).toMatchObject({
      to: ['ops@example.test'], from: 'dns@example.test', subject: '证书到期', text: 'example.test 即将到期',
    });
    expect(String(mailMessages[0]!.html)).toContain('example.test 即将到期');
  });

  it('validates QQ bot credentials, caches the access token and delivers markdown messages', async () => {
    const missingSecret = await request('/api/v1/system/notify', {
      method: 'PUT', headers: { 'content-type': 'application/json', cookie, 'X-CSRF-Token': csrf },
      body: JSON.stringify({ qqbotAppId: '1020304050' }),
    });
    expect(missingSecret.status).toBe(400);
    expect((await missingSecret.json()).reason).toBe('INCOMPLETE_QQBOT_CONFIG');

    const saved = await request('/api/v1/system/notify', {
      method: 'PUT', headers: { 'content-type': 'application/json', cookie, 'X-CSRF-Token': csrf },
      body: JSON.stringify({ qqbotAppId: '1020304050', qqbotAppSecret: 'secret-value-0123456789', qqbotOpenId: 'OPENID_0123456789' }),
    });
    expect(await saved.json()).toMatchObject({ qqbotConfigured: true, qqbotAppIdConfigured: true, qqbotAppSecretConfigured: true, qqbotOpenIdConfigured: true });

    const first = await post('/api/v1/system/notify/test', { title: '证书已签发', content: 'example.test' });
    expect(await first.json()).toMatchObject({ code: 0, channels: [{ channel: 'qqbot', status: 200 }] });
    expect(sent.filter((call) => call.includes('bots.qq.com'))).toHaveLength(1);
    expect(sent.find((call) => call.includes('bots.qq.com'))).toContain('"clientSecret":"secret-value-0123456789"');
    const message = sent.find((call) => call.includes('api.sgroup.qq.com'))!;
    expect(message).toContain('/v2/users/OPENID_0123456789/messages');
    expect(message).toContain('"msg_type":2');
    expect(message).toContain('# 证书已签发');

    const second = await post('/api/v1/system/notify/test', { title: '续签成功', content: 'example.test' });
    expect((await second.json()).channels).toEqual([{ channel: 'qqbot', status: 200 }]);
    expect(sent.filter((call) => call.includes('bots.qq.com'))).toHaveLength(1);
  });

  it('answers QQ bot callback validation, rejects unsigned events and binds the sender openid', async () => {
    const secret = 'secret-value-0123456789';
    const saved = await request('/api/v1/system/notify', {
      method: 'PUT', headers: { 'content-type': 'application/json', cookie, 'X-CSRF-Token': csrf },
      body: JSON.stringify({ qqbotAppId: '1020304050', qqbotAppSecret: secret }),
    });
    expect(saved.status).toBe(200);

    const validation = await request('/qqbot/webhook', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op: 13, d: { event_ts: '1700000000', plain_token: 'plain-token-value' } }),
    });
    expect(validation.status).toBe(200);
    const validationBody = await validation.json() as { plain_token: string; signature: string };
    expect(validationBody.plain_token).toBe('plain-token-value');
    expect(await verifyQqBotSignature('1700000000', validationBody.signature, 'plain-token-value', secret)).toBe(true);

    const timestamp = '1700000001';
    const eventBody = JSON.stringify({ op: 0, t: 'C2C_MESSAGE_CREATE', d: { id: 'msg-1', author: { user_openid: 'OPENID_0123456789' } } });
    const rejected = await request('/qqbot/webhook', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-signature-timestamp': timestamp, 'x-signature-ed25519': 'f'.repeat(128) },
      body: eventBody,
    });
    expect(rejected.status).toBe(401);

    const accepted = await request('/qqbot/webhook', {
      method: 'POST',
      headers: {
        'content-type': 'application/json', 'x-bot-appid': '1020304050',
        'x-signature-timestamp': timestamp, 'x-signature-ed25519': await signQqBotPayload(`${timestamp}${eventBody}`, secret),
      },
      body: eventBody,
    });
    expect(accepted.status).toBe(200);
    const read = await request('/api/v1/system/notify', { headers: { cookie } });
    expect(await read.json()).toMatchObject({ qqbotOpenIdConfigured: true });
    expect(sent.some((call) => call.includes('/v2/users/OPENID_0123456789/messages'))).toBe(true);
  });

  it('delivers queued certificate notifications only while certificate notices are enabled', async () => {
    const saved = await request('/api/v1/system/notify', {
      method: 'PUT', headers: { 'content-type': 'application/json', cookie, 'X-CSRF-Token': csrf },
      body: JSON.stringify({ url: 'https://example.com/hook', method: 'POST' }),
    });
    expect(saved.status).toBe(200);

    await testDb.db.execute(
      `INSERT INTO notification_outbox (topic,title,content,created_at) VALUES ('certificate','SSL 证书已签发','example.test',1)`,
    );
    const flushed = await post('/api/v1/system/notify/flush', {});
    expect(await flushed.json()).toMatchObject({ code: 0, delivered: 1, failed: 0 });
    expect(sent.some((call) => call.includes('https://example.com/hook'))).toBe(true);
    const delivered = await testDb.db.query<{ sent_at: number | null; attempts: number }>(
      'SELECT sent_at,attempts FROM notification_outbox ORDER BY id DESC LIMIT 1',
    );
    expect(delivered[0]!.sent_at).toBeTypeOf('number');
    expect(delivered[0]!.attempts).toBe(1);

    await testDb.db.execute(
      `INSERT INTO app_settings (key,value,updated_at) VALUES ('cert_notify_enabled','0',1)
       ON CONFLICT(key) DO UPDATE SET value='0'`,
    );
    await testDb.db.execute(
      `INSERT INTO notification_outbox (topic,title,content,created_at) VALUES ('certificate','SSL 证书续签成功','example.test',2)`,
    );
    const skipped = await post('/api/v1/system/notify/flush', {});
    expect(await skipped.json()).toMatchObject({ code: 0, delivered: 0 });
    const latest = await testDb.db.query<{ last_error: string | null; sent_at: number | null }>(
      'SELECT last_error,sent_at FROM notification_outbox ORDER BY id DESC LIMIT 1',
    );
    expect(latest[0]).toMatchObject({ last_error: 'DISABLED' });
    expect(latest[0]!.sent_at).toBeTypeOf('number');
  });
});
