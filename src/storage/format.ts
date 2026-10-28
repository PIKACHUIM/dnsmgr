import { validateStorageName } from './coordinator.js';

export class StorageCorruptionError extends Error {
  constructor(message = 'Storage data is missing or corrupt') {
    super(message);
    this.name = 'StorageCorruptionError';
  }
}
export function canonicalJson(value: unknown): string {
  const ancestors = new Set<object>();
  function encode(item: unknown): string {
    if (item === null) return 'null';
    if (typeof item === 'string' || typeof item === 'boolean') return JSON.stringify(item);
    if (typeof item === 'number' && Number.isFinite(item)) return JSON.stringify(item);
    if (typeof item !== 'object' || item === null || ancestors.has(item)) throw new StorageCorruptionError('Invalid JSON data');
    ancestors.add(item);
    let encoded: string;
    if (Array.isArray(item)) {
      if (Object.keys(item).length !== item.length || Array.from({ length: item.length }, (_, index) => index).some((index) => !Object.hasOwn(item, index))) {
        throw new StorageCorruptionError('Invalid JSON array');
      }
      encoded = `[${item.map(encode).join(',')}]`;
    } else {
      if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) {
        throw new StorageCorruptionError('Invalid JSON object');
      }
      const values = item as Record<string, unknown>;
      encoded = `{${Object.keys(values).sort().map((key) => `${JSON.stringify(key)}:${encode(values[key])}`).join(',')}}`;
    }
    ancestors.delete(item);
    return encoded;
  }
  return encode(value);
}
export async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('');
}
export function jsonMap(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new StorageCorruptionError();
  const map = value as Record<string, unknown>;
  for (const key of Object.keys(map)) validateStorageName(key);
  canonicalJson(map);
  return map;
}
export function parseJsonMap(text: string): Record<string, unknown> {
  try { return jsonMap(JSON.parse(text)); } catch { throw new StorageCorruptionError(); }
}
export async function keyHashes(data: Record<string, unknown>): Promise<Record<string, string>> {
  const entries = await Promise.all(Object.keys(data).sort().map(async (key) => [key, await sha256(canonicalJson(data[key]))] as const));
  return Object.fromEntries(entries);
}
