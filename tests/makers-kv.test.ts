import { describe, expect, it, vi } from 'vitest';
import { createMakersKvBridge } from '../src/platform/storage/makers-kv';

const token = 't'.repeat(32);

describe('Makers KV bridge client', () => {
  it('reads and writes through an authenticated HTTPS bridge', async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      if (String(input).includes('/get?')) {
        return new Response(JSON.stringify({ value: 'payload' }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 201 });
    }) as unknown as typeof fetch;
    const kv = createMakersKvBridge({ url: 'https://bridge.example/kv/', token, fetchImpl });

    await expect(kv.get('snapshots/a b')).resolves.toBe('payload');
    expect(calls[0]!.url).toBe('https://bridge.example/kv/get?key=snapshots%2Fa%20b');
    expect(calls[0]!.init?.method).toBe('GET');
    expect(calls[0]!.init?.headers).toMatchObject({ authorization: `Bearer ${token}` });

    await kv.put('key', 'value');
    expect(calls[1]!.url).toBe('https://bridge.example/kv/put');
    expect(calls[1]!.init?.method).toBe('PUT');
    expect(JSON.parse(String(calls[1]!.init?.body))).toEqual({ key: 'key', value: 'value' });
  });

  it('maps missing values to null and rejects unavailable or invalid responses', async () => {
    const missing = createMakersKvBridge({
      url: 'https://bridge.example', token,
      fetchImpl: async () => new Response(JSON.stringify({ value: null }), { status: 200 }),
    });
    await expect(missing.get('key')).resolves.toBeNull();

    const failed = createMakersKvBridge({
      url: 'https://bridge.example', token,
      fetchImpl: async () => new Response('', { status: 503 }),
    });
    await expect(failed.get('key')).rejects.toThrow('503');

    const invalid = createMakersKvBridge({
      url: 'https://bridge.example', token,
      fetchImpl: async () => new Response(JSON.stringify({ value: 42 }), { status: 200 }),
    });
    await expect(invalid.get('key')).rejects.toThrow('invalid value');

    const unreachable = createMakersKvBridge({
      url: 'https://bridge.example', token,
      fetchImpl: async () => { throw new Error('connection lost'); },
    });
    await expect(unreachable.put('key', 'value')).rejects.toThrow('unavailable');
  });

  it('requires HTTPS and a token of at least 32 characters', () => {
    expect(() => createMakersKvBridge({ url: 'http://bridge.example', token })).toThrow('HTTPS');
    expect(() => createMakersKvBridge({ url: 'https://bridge.example', token: 'short' })).toThrow('at least 32');
    expect(() => createMakersKvBridge({ url: 'https://bridge.example/path?x=1', token })).toThrow('Invalid');
    expect(() => createMakersKvBridge({ url: 'https://user:pass@bridge.example', token })).toThrow('Invalid');
  });
});
