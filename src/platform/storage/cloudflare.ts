import type { BlobAdapter, ImmutableObjectStore, KvBinding } from '../../storage/objects.js';
import { createKvObjectStore } from '../../storage/objects.js';

export interface CloudflareKvNamespace {
  get(key: string, type: 'text'): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

export function createCloudflareKvStore(binding: CloudflareKvNamespace): ImmutableObjectStore {
  const kv: KvBinding = {
    get: (key) => binding.get(key, 'text'),
    put: (key, value) => binding.put(key, value),
  };
  return createKvObjectStore(kv);
}

export interface CloudflareR2Bucket {
  get(key: string): Promise<{ text(): Promise<string> } | null>;
  put(key: string, value: string, options: { onlyIf: Headers }): Promise<{ key: string } | null>;
}

export function createCloudflareR2Adapter(bucket: CloudflareR2Bucket): BlobAdapter {
  return {
    async getText(key) {
      const object = await bucket.get(key);
      return object === null ? null : object.text();
    },
    async putIfAbsent(key, payload) {
      const onlyIf = new Headers({ 'If-None-Match': '*' });
      const result = await bucket.put(key, payload, { onlyIf });
      return result !== null;
    },
  };
}
