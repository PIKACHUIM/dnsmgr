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

/** 部分服务商（西部数码等）仍使用 MD5；WebCrypto 不提供，这里按 RFC 1321 实现。 */
export function md5Hex(value: string): string {
  const bytes = encoder.encode(value);
  const bitLength = bytes.length * 8;
  const padded = new Uint8Array(Math.ceil((bytes.length + 9) / 64) * 64);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, bitLength >>> 0, true);
  view.setUint32(padded.length - 4, Math.floor(bitLength / 0x100000000) >>> 0, true);
  const shifts = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
  ];
  const table = new Uint32Array(64);
  for (let i = 0; i < 64; i++) table[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0;
  const words = new Uint32Array(16);
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) words[i] = view.getUint32(offset + i * 4, true);
    let a = a0, b = b0, c = c0, d = d0;
    for (let i = 0; i < 64; i++) {
      let f: number;
      let g: number;
      if (i < 16) { f = (b & c) | (~b & d); g = i; }
      else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) % 16; }
      else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) % 16; }
      else { f = c ^ (b | ~d); g = (7 * i) % 16; }
      const sum = (a + f + table[i]! + words[g]!) >>> 0;
      a = d;
      d = c;
      c = b;
      b = (b + ((sum << shifts[i]!) | (sum >>> (32 - shifts[i]!)))) >>> 0;
    }
    a0 = (a0 + a) >>> 0; b0 = (b0 + b) >>> 0; c0 = (c0 + c) >>> 0; d0 = (d0 + d) >>> 0;
  }
  return [a0, b0, c0, d0].map((word) =>
    [0, 8, 16, 24].map((shift) => ((word >>> shift) & 0xff).toString(16).padStart(2, '0')).join('')).join('');
}

export function base64Encode(value: string): string {
  return btoa(String.fromCharCode(...encoder.encode(value)));
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

/** 阿里云 RPC（HMAC-SHA1，签名在 query string 或表单体）。 */
export async function aliyunSignature(secret: string, params: Record<string, string>, method: 'GET' | 'POST' = 'GET'): Promise<string> {
  const canonical = Object.keys(params).sort()
    .map((key) => `${percentEncode(key)}=${percentEncode(params[key] ?? '')}`)
    .join('&');
  const stringToSign = `${method}&%2F&${percentEncode(canonical)}`;
  return base64(await hmac('SHA-1', encoder.encode(`${secret}&`), stringToSign));
}

/** 原始 HMAC-SHA256，供需要以二进制密钥链式派生的签名流程（京东云）使用。 */
export async function hmacSha256Raw(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  return hmac('SHA-256', key as unknown as ArrayBuffer, data);
}

export function hexOf(bytes: ArrayBuffer): string {
  return hex(bytes);
}

export function base64Of(bytes: ArrayBuffer): string {
  return base64(bytes);
}

/** 十六进制 HMAC-SHA256，供百度云 BCE 等以 hex 作为密钥的签名流程使用。 */
export async function hmacSha256Hex(key: string, data: string): Promise<string> {
  return hex(await hmac('SHA-256', encoder.encode(key), data));
}

/** 百度云 BCE 转义：urlencode 后把 + * %7E 还原为规范形式。 */
export function bceEscape(value: string): string {
  return encodeURIComponent(value)
    .replaceAll('+', '%20')
    .replaceAll('*', '%2A')
    .replaceAll('%7E', '~');
}

/** 腾讯云 TC3-HMAC-SHA256。 */export async function tencentAuthorization(input: {
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
