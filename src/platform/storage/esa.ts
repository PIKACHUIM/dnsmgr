import type { KvBinding } from '../../storage/objects.js';

export interface EsaEdgeKvClient {
  get(key: string, options: { type: 'text' }): Promise<string | undefined>;
  put(key: string, value: string): Promise<void>;
}

export function createEsaEdgeKvBinding(client: EsaEdgeKvClient): KvBinding {
  return {
    async get(key) {
      return (await client.get(key, { type: 'text' })) ?? null;
    },
    async put(key, value) {
      if (new TextEncoder().encode(value).byteLength > 1_800_000) throw new Error('ESA EdgeKV object exceeds the documented 1.8 MB limit');
      await client.put(key, value);
    },
  };
}
