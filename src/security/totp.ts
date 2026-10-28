import { constantTimeEqual } from './crypto';
import { AppError } from '../core/errors';

const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function newTotpSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  let bits = '';
  for (const byte of bytes) bits += byte.toString(2).padStart(8, '0');
  let value = '';
  for (let index = 0; index < bits.length; index += 5) value += alphabet[parseInt(bits.slice(index, index + 5), 2)];
  return value;
}

function decodeSecret(secret: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Z2-7]{16,128}$/.test(secret)) throw new AppError(503, '动态口令密钥损坏', 'INVALID_TOTP');
  const bits = Array.from(secret, (character) => alphabet.indexOf(character).toString(2).padStart(5, '0')).join('');
  return Uint8Array.from(bits.match(/[01]{8}/g) ?? [], (byte) => parseInt(byte, 2));
}

export async function totpCode(secret: string, counter: number): Promise<string> {
  const key = await crypto.subtle.importKey('raw', decodeSecret(secret), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const message = new ArrayBuffer(8);
  new DataView(message).setBigUint64(0, BigInt(counter));
  const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, message));
  const offset = digest[digest.length - 1]! & 15;
  const value = ((digest[offset]! & 127) << 24) | (digest[offset + 1]! << 16) | (digest[offset + 2]! << 8) | digest[offset + 3]!;
  return (value % 1_000_000).toString().padStart(6, '0');
}

export async function verifyTotp(secret: string, code: string, now: number): Promise<number | null> {
  if (!/^\d{6}$/.test(code)) return null;
  const counter = Math.floor(now / 30);
  for (const candidate of [counter, counter - 1, counter + 1]) {
    if (constantTimeEqual(await totpCode(secret, candidate), code)) return candidate;
  }
  return null;
}
