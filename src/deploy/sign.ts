import forge from 'node-forge';
import { hmacSha256Raw, hexOf, sha256Hex } from '../dns/sign';

const encoder = new TextEncoder();

/** SHA-1 十六进制摘要（UCloud 等仍使用 SHA-1 签名）。 */
export async function sha1Hex(value: string): Promise<string> {
  return hexOf(await crypto.subtle.digest('SHA-1', encoder.encode(value)));
}

/** HMAC-MD5：WebCrypto 不支持 MD5，改用 node-forge。 */
export function hmacMd5Hex(key: string, data: string): string {
  const hmac = forge.hmac.create();
  hmac.start('md5', key);
  hmac.update(data);
  return hmac.digest().toHex();
}

/** 十六进制 HMAC-SHA1（多吉云等以 hex 摘要作为签名）。 */
export async function hmacSha1Hex(key: string, data: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw', encoder.encode(key), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign'],
  );
  return hexOf(await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(data)));
}

/** URL 安全的 Base64 HMAC-SHA1（七牛管理接口的 QBox / Qiniu 签名）。 */
export async function hmacSha1Base64Url(key: string, data: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw', encoder.encode(key), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replaceAll('+', '-')
    .replaceAll('/', '_');
}

/** 标准 Base64 HMAC-SHA1（华为云 OBS 的 OBS 签名）。 */
export async function hmacSha1Base64(key: string, data: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw', encoder.encode(key), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(signature)));
}

/** Base64 编码的 MD5 摘要（OBS / OSS 的 Content-MD5 请求头）。 */
export function md5Base64(value: string): string {
  const digest = forge.md.md5.create().update(value, 'utf8');
  return forge.util.encode64(digest.digest().getBytes());
}

export interface Sigv4Input {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  service: string;
  method: string;
  host: string;
  path: string;
  query?: Record<string, string | undefined>;
  /** 参与签名的请求头；host 与 x-amz-date 会自动补齐。 */
  headers?: Record<string, string>;
  body?: string;
  now?: number;
}

export interface Sigv4Result {
  authorization: string;
  amzDate: string;
  headers: Record<string, string>;
}

function escape(value: string): string {
  return encodeURIComponent(value)
    .replaceAll('!', '%21')
    .replaceAll("'", '%27')
    .replaceAll('(', '%28')
    .replaceAll(')', '%29')
    .replaceAll('*', '%2A');
}

function canonicalUri(path: string): string {
  if (!path) return '/';
  return path.split('/').map((segment) => escape(segment)).join('/');
}

function canonicalQuery(query: Record<string, string | undefined>): string {
  return Object.entries(query)
    .filter(([, value]) => value !== undefined && value !== '')
    .map(([key, value]) => [escape(key), escape(value as string)] as const)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
}

async function hmac(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  return hmacSha256Raw(key as ArrayBuffer, data);
}

/**
 * AWS SigV4 签名，供金山云 / 火山引擎 / S3 兼容存储等复用。
 * 与 PHP 客户端一致的实现：canonical headers 只包含调用方提供的头。
 */
export async function sigv4Signature(input: Sigv4Input): Promise<Sigv4Result> {
  const now = input.now ?? Math.floor(Date.now() / 1000);
  const amzDate = new Date(now * 1000).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const shortDate = amzDate.slice(0, 8);
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(input.headers ?? {})) headers[key.toLowerCase()] = value.trim();
  headers.host = input.host;
  headers['x-amz-date'] = amzDate;
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((name) => `${name}:${headers[name]}\n`).join('');
  const signedHeaders = names.join(';');
  const canonicalRequest = [
    input.method.toUpperCase(),
    canonicalUri(input.path),
    canonicalQuery(input.query ?? {}),
    canonicalHeaders,
    signedHeaders,
    await sha256Hex(input.body ?? ''),
  ].join('\n');
  const scope = `${shortDate}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256', amzDate, scope, await sha256Hex(canonicalRequest),
  ].join('\n');
  const secretDate = await hmac(encoder.encode(`AWS4${input.secretAccessKey}`), shortDate);
  const secretRegion = await hmac(secretDate, input.region);
  const secretService = await hmac(secretRegion, input.service);
  const secretSigning = await hmac(secretService, 'aws4_request');
  const signature = hexOf(await hmac(secretSigning, stringToSign));
  return {
    amzDate,
    headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}
