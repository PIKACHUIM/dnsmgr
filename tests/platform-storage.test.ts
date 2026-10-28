import { describe, expect, it, vi } from 'vitest';
import { createCloudflareKvStore, createCloudflareR2Adapter } from '../src/platform/storage/cloudflare.js';
import { createEdgeOneBlobAdapter } from '../src/platform/storage/edgeone.js';
import { createEsaEdgeKvBinding } from '../src/platform/storage/esa.js';
import { sha256 } from '../src/storage/format.js';
import { createKvObjectStore, StorageUnavailableError } from '../src/storage/objects.js';

async function objectKey(payload: string): Promise<string> {
  return `snapshots/main/00000000-0000-4000-8000-000000000000/${await sha256(payload)}.json`;
}

describe('Cloudflare platform storage adapters', () => {
  it('uses KV text reads and string puts through the immutable KV store', async () => {
    const values = new Map<string, string>();
    const get = vi.fn(async (key: string, type: 'text') => {
      expect(type).toBe('text');
      return values.get(key) ?? null;
    });
    const put = vi.fn(async (key: string, value: string) => { values.set(key, value); });
    const store = createCloudflareKvStore({ get, put });
    const payload = '{"data":1}';
    const key = await objectKey(payload);

    expect(await store.read(key)).toBeNull();
    await store.writeNew(key, payload);
    expect(await store.read(key)).toBe(payload);
    await expect(store.writeNew(key, payload)).rejects.toThrow('Immutable object already exists');
    expect(get).toHaveBeenCalledWith(key, 'text');
    expect(put).toHaveBeenCalledTimes(1);
    expect(put).toHaveBeenCalledWith(key, payload);
  });

  it('uses RFC If-None-Match wildcard for atomic create-only R2 writes', async () => {
    const values = new Map<string, string>();
    const get = vi.fn(async (key: string) => {
      const value = values.get(key);
      return value === undefined ? null : { text: async () => value };
    });
    const put = vi.fn(async (key: string, value: string, options: { onlyIf: Headers }) => {
      expect(options.onlyIf.get('If-None-Match')).toBe('*');
      if (values.has(key)) return null;
      values.set(key, value);
      return { key };
    });
    const adapter = createCloudflareR2Adapter({ get, put });

    expect(await adapter.getText('absent')).toBeNull();
    expect(await adapter.putIfAbsent('new', 'first')).toBe(true);
    expect(await adapter.putIfAbsent('new', 'second')).toBe(false);
    expect(await adapter.getText('new')).toBe('first');
    expect(put).toHaveBeenCalledTimes(2);
    expect(put.mock.calls[0]?.[2].onlyIf.get('If-None-Match')).toBe('*');
    expect(put.mock.calls[1]?.[2].onlyIf.get('If-None-Match')).toBe('*');
  });

  it('propagates R2 operation errors', async () => {
    const failure = new Error('R2 unavailable');
    const adapter = createCloudflareR2Adapter({
      async get() { throw failure; },
      async put() { throw failure; },
    });
    await expect(adapter.getText('key')).rejects.toBe(failure);
    await expect(adapter.putIfAbsent('key', 'value')).rejects.toBe(failure);
  });
});

describe('EdgeOne Makers Blob adapter', () => {
  it('uses strong reads to verify content-addressed writes without relying on the deprecated onlyIfNew option', async () => {
    const values = new Map<string, string>();
    const get = vi.fn(async (key: string, options: { type: 'text'; consistency: 'strong' }) => {
      expect(options).toEqual({ type: 'text', consistency: 'strong' });
      return values.get(key) ?? null;
    });
    const set = vi.fn(async (key: string, value: string) => { values.set(key, value); });
    const adapter = createEdgeOneBlobAdapter({ get, set });

    expect(await adapter.getText('absent')).toBeNull();
    expect(await adapter.putIfAbsent('new', 'first')).toBe(true);
    expect(await adapter.getText('new')).toBe('first');
    expect(await adapter.putIfAbsent('new', 'first')).toBe(true);
    expect(await adapter.putIfAbsent('new', 'second')).toBe(false);
    expect(values.get('new')).toBe('first');
    expect(get).toHaveBeenCalledWith('new', { type: 'text', consistency: 'strong' });
    expect(set).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledWith('new', 'first');
  });

  it('fails closed when a strong read cannot observe the payload after write', async () => {
    const adapter = createEdgeOneBlobAdapter({
      async get() { return null; },
      async set() {},
    });
    await expect(adapter.putIfAbsent('new', 'first')).rejects.toThrow('strong read');
  });
});

describe('ESA EdgeKV adapter', () => {
  it('maps missing values to null, requests text, and passes put failures through', async () => {
    const values = new Map<string, string>();
    const get = vi.fn(async (key: string, options: { type: 'text' }) => {
      expect(options).toEqual({ type: 'text' });
      return values.get(key);
    });
    const put = vi.fn(async (key: string, value: string) => { values.set(key, value); });
    const binding = createEsaEdgeKvBinding({ get, put });

    expect(await binding.get('missing')).toBeNull();
    expect(get).toHaveBeenCalledWith('missing', { type: 'text' });
    await binding.put('present', 'value');
    expect(await binding.get('present')).toBe('value');
    expect('list' in binding).toBe(false);

    const failure = new Error('EdgeKV put failed');
    const failedBinding = createEsaEdgeKvBinding({
      async get() { return undefined; },
      async put() { throw failure; },
    });
    const store = createKvObjectStore(failedBinding);
    await expect(store.writeNew(await objectKey('{"data":2}'), '{"data":2}')).rejects.toBeInstanceOf(StorageUnavailableError);
  });

  it('rejects values above the documented 1.8 MB limit before EdgeKV I/O', async () => {
    const put = vi.fn(async () => undefined);
    const binding = createEsaEdgeKvBinding({ async get() { return undefined; }, put });
    await expect(binding.put('large', 'x'.repeat(1_800_001))).rejects.toThrow('1.8 MB');
    expect(put).not.toHaveBeenCalled();
  });
});
