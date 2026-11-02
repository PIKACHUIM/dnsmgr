const encoder = new TextEncoder();

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function base64(buffer: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)));
}

export async function sha256Hex(value: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
}

async function hmac(hash: 'SHA-1' | 'SHA-256', key: ArrayBuffer | Uint8Array<ArrayBuffer>, data: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey('raw', key as BufferSource, { name: 'HMAC', hash }, false, ['sign']);
  return crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(data));
}

/** 阿里云 RPC 签名使用的 RFC3986 编码。 */
export function percentEncode(value: string): string {
  return encodeURIComponent(value)
    .replaceAll('!', '%21')
    .replaceAll("'", '%27')
    .replaceAll('(', '%28')
    .replaceAll(')', '%29')
    .replaceAll('*', '%2A');
}

/** 阿里云 RPC（HMAC-SHA1，签名在 query string）。 */
export async function aliyunSignature(secret: string, params: Record<string, string>): Promise<string> {
  const canonical = Object.keys(params).sort()
    .map((key) => `${percentEncode(key)}=${percentEncode(params[key] ?? '')}`)
    .join('&');
  const stringToSign = `GET&%2F&${percentEncode(canonical)}`;
  return base64(await hmac('SHA-1', encoder.encode(`${secret}&`), stringToSign));
}

/** 腾讯云 TC3-HMAC-SHA256。 */
export async function tencentAuthorization(input: {
  secretId: string;
  secretKey: string;
  service: string;
  host: string;
  action: string;
  version: string;
  payload: string;
  timestamp: number;
}): Promise<string> {
  const date = new Date(input.timestamp * 1000).toISOString().slice(0, 10);
  const contentType = 'application/json; charset=utf-8';
  const canonicalRequest = [
    'POST', '/', '',
    `content-type:${contentType}`, `host:${input.host}`, '',
    'content-type;host',
    await sha256Hex(input.payload),
  ].join('\n');
  const scope = `${date}/${input.service}/tc3_request`;
  const stringToSign = ['TC3-HMAC-SHA256', String(input.timestamp), scope, await sha256Hex(canonicalRequest)].join('\n');
  const secretDate = await hmac('SHA-256', encoder.encode(`TC3${input.secretKey}`), date);
  const secretService = await hmac('SHA-256', secretDate, input.service);
  const secretSigning = await hmac('SHA-256', secretService, 'tc3_request');
  const signature = hex(await hmac('SHA-256', secretSigning, stringToSign));
  return `TC3-HMAC-SHA256 Credential=${input.secretId}/${scope}, SignedHeaders=content-type;host, Signature=${signature}`;
}
