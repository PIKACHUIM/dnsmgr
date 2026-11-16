import { deployRaw } from '../http';

/** Kangle / Easypanel 系列面板大量使用 HTML + alert() 反馈，这里统一判定。 */
export function ensureHtmlSuccess(body: string, status: number): void {
  if (body.includes('成功')) return;
  const alert = /alert\('([\s\S]*?)'\)/i.exec(body);
  if (alert && alert[1]) throw new Error(alert[1]);
  const trimmed = body.trim();
  if (trimmed.length > 3 && trimmed.length < 50) throw new Error(trimmed);
  throw new Error(`原因未知(httpCode=${status})`);
}

export async function postHtmlForm(
  runtime: Parameters<typeof deployRaw>[0], url: string, params: Record<string, string>, cookie: string, label: string,
): Promise<void> {
  const response = await deployRaw(runtime, url, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  }, label);
  ensureHtmlSuccess(await response.text(), response.status);
}
