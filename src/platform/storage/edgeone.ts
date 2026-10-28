import type { BlobAdapter } from '../../storage/objects.js';

export interface EdgeOneBlobStore {
  get(key: string, options: { type: 'text'; consistency: 'strong' }): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

export function createEdgeOneBlobAdapter(store: EdgeOneBlobStore): BlobAdapter {
  return {
    getText: (key) => store.get(key, { type: 'text', consistency: 'strong' }),
    async putIfAbsent(key, payload) {
      // SDK 0.0.18 marks onlyIfNew unsupported; snapshot keys include random UUIDs and content hashes, while SQL CAS selects the active version.
      const current = await store.get(key, { type: 'text', consistency: 'strong' });
      if (current !== null) return current === payload;
      await store.set(key, payload);
      const written = await store.get(key, { type: 'text', consistency: 'strong' });
      if (written === null) throw new Error('Blob write was not visible to a strong read');
      return written === payload;
    },
  };
}
