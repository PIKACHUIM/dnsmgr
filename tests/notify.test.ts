import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app';
import type { Bindings, RequestBudget } from '../src/core/types';
import { environment } from '../src/platform/runtime';
import { parseConfig, renderTemplate } from '../src/notify/custom';
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

  beforeEach(async () => {
    testDb = createTestDatabase();
    app = createApp({ database: testDb.db });
    sent = [];
    wxpusherSuccess = true;
    telegramOk = true;
    wecomErrcode = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      sent.push(`${init.method ?? 'GET'} ${String(input)} ${String(init.body ?? '')}`);
      const url = new URL(String(input));
      if (url.hostname === 'wxpusher.zjiecode.com') {
        return new Response(JSON.stringify({ success: wxpusherSuccess }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.hostname === 'api.telegram.org') {
        return new Response(JSON.stringify({ ok: telegramOk }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (url.hostname === 'qyapi.weixin.qq.com') {
        return new Response(JSON.stringify({ errcode: wecomErrcode, errmsg: wecomErrcode === 0 ? 'ok' : 'rejected' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
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
});
