import { AppError } from '../core/errors';

const encoder = new TextEncoder();

export function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

export function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  try {
    return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
  } catch {
    throw new AppError(503, '加密密钥或数据格式无效', 'INVALID_ENCRYPTION');
  }
}

export function randomToken(): string {
  return toBase64(crypto.getRandomValues(new Uint8Array(32)))
    .replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

export async function sha256(value: string): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
  return Array.from(hash, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  let mismatch = leftBytes.length ^ rightBytes.length;
  const length = Math.max(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index++) {
    mismatch |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return mismatch === 0;
}

export async function encryptionKey(secret: string | undefined, purpose: string): Promise<CryptoKey> {
  if (!secret || fromBase64(secret).length !== 32) {
    throw new AppError(503, '需要配置 32 字节 Base64 APP_KEY', 'ENCRYPTION_NOT_CONFIGURED');
  }
  const master = await crypto.subtle.importKey('raw', fromBase64(secret), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: encoder.encode('dnsmgr-serverless-v1'), info: encoder.encode(purpose) },
    master,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function encrypt(value: string, secret: string | undefined, purpose: string): Promise<string> {
  const key = await encryptionKey(secret, purpose);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: encoder.encode(purpose) }, key, encoder.encode(value),
  );
  return `v1.${toBase64(iv)}.${toBase64(new Uint8Array(ciphertext))}`;
}

export async function decrypt(value: string, secret: string | undefined, purpose: string): Promise<string> {
  const [version, iv, data, extra] = value.split('.');
  if (version !== 'v1' || !iv || !data || extra !== undefined || fromBase64(iv).length !== 12) {
    throw new AppError(503, '加密数据损坏', 'CORRUPT_ENCRYPTION');
  }
  const key = await encryptionKey(secret, purpose);
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64(iv), additionalData: encoder.encode(purpose) }, key, fromBase64(data),
    );
    return new TextDecoder('utf-8', { fatal: true }).decode(plaintext);
  } catch {
    throw new AppError(503, '无法解密数据，请检查 APP_KEY', 'DECRYPTION_FAILED');
  }
}
