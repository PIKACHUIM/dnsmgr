import type { Context } from 'hono';
import type { AppEnv } from '../core/types';
import { AppError } from '../core/errors';
import { decrypt, encrypt } from '../security/crypto';
import { nowSeconds } from '../security/auth';

const PKCS8_ED25519_PREFIX = '302e020100300506032b657004220420';
const TOKEN_SETTING = 'qqbot_access_token_cipher';
const TOKEN_PURPOSE = 'qqbot-access-token/v1';
const TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken';
const API_BASE = 'https://api.sgroup.qq.com';

function hexToBytes(value: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[0-9a-f]+$/i.test(value) || value.length % 2 !== 0) return null;
  const bytes = new Uint8Array(new ArrayBuffer(value.length / 2));
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  return bytes;
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replaceAll('-', '+').replaceAll('_', '/');
  const raw = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='));
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
  return bytes;
}

/** QQ 开放平台要求把 Secret 重复补齐到 32 字节后作为 Ed25519 seed。 */
function secretSeed(secret: string): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder();
  let seed = secret;
  while (encoder.encode(seed).byteLength < 32) seed += seed;
  const encoded = encoder.encode(seed).slice(0, 32);
  const bytes = new Uint8Array(new ArrayBuffer(32));
  bytes.set(encoded);
  return bytes;
}

async function privateKey(secret: string): Promise<CryptoKey> {
  const prefix = hexToBytes(PKCS8_ED25519_PREFIX)!;
  const seed = secretSeed(secret);
  const der = new Uint8Array(new ArrayBuffer(prefix.length + seed.length));
  der.set(prefix);
  der.set(seed, prefix.length);
  return crypto.subtle.importKey('pkcs8', der, { name: 'Ed25519' }, true, ['sign']);
}

async function publicKey(secret: string): Promise<CryptoKey> {
  const key = await privateKey(secret);
  const jwk = await crypto.subtle.exportKey('jwk', key);
  if (typeof jwk.x !== 'string') throw new Error('invalid qqbot key');
  return crypto.subtle.importKey('raw', base64UrlToBytes(jwk.x), { name: 'Ed25519' }, false, ['verify']);
}

export async function signQqBotPayload(message: string, secret: string): Promise<string> {
  const signature = await crypto.subtle.sign({ name: 'Ed25519' }, await privateKey(secret), new TextEncoder().encode(message));
  return toHex(new Uint8Array(signature));
}

export async function qqBotValidationSignature(eventTs: string, plainToken: string, secret: string): Promise<string> {
  return signQqBotPayload(`${eventTs}${plainToken}`, secret);
}

export async function verifyQqBotSignature(timestamp: string, signatureHex: string, body: string, secret: string): Promise<boolean> {
  if (!timestamp || !/^[0-9a-f]{128}$/i.test(signatureHex.trim())) return false;
  const signature = hexToBytes(signatureHex.trim());
  if (!signature || signature.length !== 64 || (signature[63]! & 224) !== 0) return false;
  try {
    return await crypto.subtle.verify(
      { name: 'Ed25519' }, await publicKey(secret), signature, new TextEncoder().encode(`${timestamp}${body}`),
    );
  } catch {
    return false;
  }
}

interface CachedToken {
  appId: string;
  token: string;
  expiresAt: number;
}

async function readCachedToken(c: Context<AppEnv>, appId: string): Promise<string | null> {
  const rows = await c.get('db').query<{ value: string }>('SELECT value FROM app_settings WHERE key=?', [TOKEN_SETTING]);
  if (!rows[0]) return null;
  try {
    const decoded = JSON.parse(await decrypt(rows[0].value, c.env.APP_KEY, TOKEN_PURPOSE)) as CachedToken;
    if (decoded.appId === appId && typeof decoded.token === 'string' && decoded.expiresAt > nowSeconds() + 60) return decoded.token;
  } catch {
    return null;
  }
  return null;
}

async function fetchAccessToken(c: Context<AppEnv>, appId: string, secret: string): Promise<string> {
  const response = await c.env.BUDGET.fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ appId, clientSecret: secret }),
    signal: AbortSignal.timeout(15_000),
    redirect: 'error',
  });
  const body = await response.text();
  if (!response.ok || body.length > 4096) throw new AppError(502, 'QQ 机器人凭证获取失败', 'QQBOT_TOKEN_FAILED');
  let payload: { access_token?: unknown; expires_in?: unknown };
  try { payload = JSON.parse(body) as typeof payload; } catch { throw new AppError(502, 'QQ 机器人凭证响应无效', 'QQBOT_TOKEN_FAILED'); }
  if (typeof payload.access_token !== 'string' || !payload.access_token) {
    throw new AppError(502, 'QQ 机器人凭证获取失败', 'QQBOT_TOKEN_FAILED');
  }
  const ttl = Number(payload.expires_in ?? 7200);
  const expiresAt = nowSeconds() + (Number.isFinite(ttl) && ttl > 120 ? Math.floor(ttl) - 120 : 6900);
  const cipher = await encrypt(
    JSON.stringify({ appId, token: payload.access_token, expiresAt } satisfies CachedToken),
    c.env.APP_KEY, TOKEN_PURPOSE,
  );
  await c.get('db').execute(
    'INSERT INTO app_settings (key, value, updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at',
    [TOKEN_SETTING, cipher, nowSeconds()],
  );
  return payload.access_token;
}

export async function sendQqBotMessage(
  c: Context<AppEnv>, appId: string, secret: string, openid: string, title: string, content: string,
): Promise<{ status: number | null; ok: boolean }> {
  const token = await readCachedToken(c, appId) ?? await fetchAccessToken(c, appId, secret);
  const response = await c.env.BUDGET.fetch(`${API_BASE}/v2/users/${encodeURIComponent(openid)}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `QQBot ${token}` },
    body: JSON.stringify({ msg_type: 2, markdown: { content: `# ${title}\n\n${content}` } }),
    signal: AbortSignal.timeout(15_000),
    redirect: 'error',
  });
  const body = await response.text();
  if (!response.ok) return { status: response.status, ok: false };
  if (body.length > 4096) return { status: response.status, ok: false };
  try {
    const payload = JSON.parse(body) as { id?: unknown; code?: unknown };
    return { status: response.status, ok: payload.code === 0 || typeof payload.id === 'string' };
  } catch {
    return { status: response.status, ok: false };
  }
}
