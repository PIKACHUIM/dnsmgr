export type CustomWebhookContentFormat = 'html' | 'markdown' | 'text';

export interface CustomWebhookConfig {
  url: string;
  method: 'GET' | 'POST' | 'PUT';
  headers: Record<string, string>;
  body: string;
  contentType: string;
  contentFormat: CustomWebhookContentFormat;
}

export const DEFAULT_BODY = '{"title":"{title}","content":"{content}"}';

export function renderTemplate(template: string, title: string, content: string): string {
  return template.replaceAll('{title}', title).replaceAll('{content}', content);
}

/** 旧版 custom_webhook_content_format 只有 html/markdown/text，缺省按纯文本发送。 */
export function normalizeContentFormat(value: string | undefined): CustomWebhookContentFormat {
  const format = (value ?? '').trim().toLowerCase();
  return format === 'html' || format === 'markdown' ? format : 'text';
}

function stripTags(value: string): string {
  return value.replace(/<[^>]*>/g, '');
}

/** 复刻旧版 MsgNotice::send_custom_webhook 的内容格式处理。 */
export function formatNotificationContent(content: string, format: CustomWebhookContentFormat): string {
  if (format === 'html') return content;
  const withBreaks = content.replace(/<br\s*\/?>/gi, '\n');
  if (format === 'markdown') {
    return stripTags(withBreaks.replace(/<b>/gi, '**').replace(/<\/b>/gi, '**'));
  }
  return stripTags(withBreaks);
}

function parseHeaders(raw: string): Record<string, string> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return Object.fromEntries(Object.entries(parsed as Record<string, unknown>)
        .filter(([, value]) => typeof value === 'string')
        .map(([key, value]) => [key.slice(0, 64), String(value).slice(0, 1024)]));
    }
  } catch { /* 旧版按每行 Key: Value 保存，继续按行解析 */ }
  const headers: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const index = trimmed.indexOf(':');
    if (index <= 0) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim();
    if (key) headers[key.slice(0, 64)] = value.slice(0, 1024);
  }
  if (Object.keys(headers).length === 0) throw new Error('Webhook 请求头必须是 JSON 对象或每行 Key: Value');
  return headers;
}

export function parseConfig(values: Record<string, string | undefined>): CustomWebhookConfig | null {
  const url = (values.custom_webhook_url ?? '').trim();
  if (!url) return null;
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error('Webhook URL 格式无效'); }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('Webhook 仅支持 http/https');
  const method = (values.custom_webhook_method ?? 'POST').toUpperCase();
  if (!['GET', 'POST', 'PUT'].includes(method)) throw new Error('Webhook 方法只能是 GET/POST/PUT');
  let headers: Record<string, string> = {};
  const rawHeaders = (values.custom_webhook_headers ?? '').trim();
  if (rawHeaders) headers = parseHeaders(rawHeaders);
  const contentType = (values.custom_webhook_content_type ?? 'application/json').trim() || 'application/json';
  const body = (values.custom_webhook_body ?? '').trim() || DEFAULT_BODY;
  return {
    url, method: method as CustomWebhookConfig['method'], headers, body, contentType,
    contentFormat: normalizeContentFormat(values.custom_webhook_content_format),
  };
}

export async function sendCustomWebhook(
  config: CustomWebhookConfig, title: string, content: string, fetchImpl: typeof fetch = fetch,
): Promise<{ status: number; response: string }> {
  const rendered = renderTemplate(config.body, title, formatNotificationContent(content, config.contentFormat));
  const headers: Record<string, string> = { ...config.headers };
  if (config.method !== 'GET') headers['Content-Type'] = config.contentType;
  const init: RequestInit = { method: config.method, headers: { ...headers }, signal: AbortSignal.timeout(15_000), redirect: 'error' };
  if (config.method === 'GET') {
    const url = new URL(config.url);
    const params: [string, string][] = [];
    if (config.contentType === 'application/json') {
      let decoded: unknown;
      try { decoded = JSON.parse(rendered); } catch { decoded = null; }
      if (decoded && typeof decoded === 'object' && !Array.isArray(decoded)) {
        for (const [key, value] of Object.entries(decoded as Record<string, unknown>)) {
          if (value !== null && value !== undefined) {
            const encoded = typeof value === 'object' ? JSON.stringify(value) : typeof value === 'boolean' ? (value ? '1' : '0') : String(value);
            params.push([key, encoded]);
          }
        }
      } else {
        // 旧版在模板 JSON 无效时不发参数；这里回退到 title/content，避免 GET 通知静默丢失正文。
        params.push(['title', title], ['content', formatNotificationContent(content, config.contentFormat)]);
      }
    } else {
      for (const [key, value] of new URLSearchParams(rendered)) params.push([key, value]);
    }
    for (const [key, value] of params) url.searchParams.append(key, value);
    init.headers = headers;
    const response = await fetchImpl(url.toString(), init);
    return { status: response.status, response: (await response.text()).slice(0, 500) };
  }
  let body = rendered;
  if (config.contentType === 'application/json') {
    try { JSON.parse(body); } catch { body = JSON.stringify({ title, content: formatNotificationContent(content, config.contentFormat) }); }
  }
  init.body = body;
  const response = await fetchImpl(config.url, init);
  return { status: response.status, response: (await response.text()).slice(0, 500) };
}
