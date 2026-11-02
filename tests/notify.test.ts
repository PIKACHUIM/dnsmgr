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

  beforeEach(async () => {
    testDb = createTestDatabase();
    app = createApp({ database: testDb.db });
    sent = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      sent.push(`${init.method ?? 'GET'} ${String(input)} ${String(init.body ?? '')}`);
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

  it('saves settings and sends a templated test webhook', async () => {
    const saved = await request('/api/v1/system/notify', {
      method: 'PUT', headers: { 'content-type': 'application/json', cookie, 'X-CSRF-Token': csrf },
      body: JSON.stringify({ url: 'https://example.com/hook', method: 'POST', headers: '{"X-Test":"1"}', contentType: 'application/json', body: '{"t":"{title}","c":"{content}"}' }),
    });
    expect(await saved.json()).toMatchObject({ code: 0, configured: true });

    const sentResponse = await post('/api/v1/system/notify/test', { title: '标题', content: '正文' });
    expect(await sentResponse.json()).toMatchObject({ code: 0, status: 200 });
    expect(sent[0]).toContain('POST https://example.com/hook');
    expect(sent[0]).toContain('"t":"标题"');
    expect(sent[0]).toContain('"c":"正文"');
  });
});
