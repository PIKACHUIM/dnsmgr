export interface CustomWebhookConfig {
  url: string;
  method: 'GET' | 'POST' | 'PUT';
  headers: Record<string, string>;
  body: string;
  contentType: string;
}

export const DEFAULT_BODY = '{"title":"{title}","content":"{content}"}';

export function renderTemplate(template: string, title: string, content: string): string {
  return template.replaceAll('{title}', title).replaceAll('{content}', content);
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
  if (rawHeaders) {
    try {
      const parsedHeaders = JSON.parse(rawHeaders) as unknown;
      if (!parsedHeaders || typeof parsedHeaders !== 'object' || Array.isArray(parsedHeaders)) throw new Error('headers');
      headers = Object.fromEntries(Object.entries(parsedHeaders as Record<string, unknown>)
        .filter(([, value]) => typeof value === 'string')
        .map(([key, value]) => [key.slice(0, 64), String(value).slice(0, 1024)]));
    } catch {
      throw new Error('Webhook 请求头必须是 JSON 对象');
    }
  }
  const contentType = (values.custom_webhook_content_type ?? 'application/json').trim() || 'application/json';
  const body = (values.custom_webhook_body ?? '').trim() || DEFAULT_BODY;
  return { url, method, headers, body, contentType } as CustomWebhookConfig;
}

export async function sendCustomWebhook(
  config: CustomWebhookConfig, title: string, content: string, fetchImpl: typeof fetch = fetch,
): Promise<{ status: number; response: string }> {
  const rendered = renderTemplate(config.body, title, content);
  const headers: Record<string, string> = { ...config.headers };
  if (config.method !== 'GET') headers['Content-Type'] = config.contentType;
  const init: RequestInit = { method: config.method, headers: { ...headers }, signal: AbortSignal.timeout(15_000) };
  if (config.method === 'GET') {
    const url = new URL(config.url);
    url.searchParams.set('title', title);
    url.searchParams.set('content', content);
    init.headers = headers;
    const response = await fetchImpl(url.toString(), init);
    return { status: response.status, response: (await response.text()).slice(0, 500) };
  }
  init.body = rendered;
  const response = await fetchImpl(config.url, init);
  return { status: response.status, response: (await response.text()).slice(0, 500) };
}
