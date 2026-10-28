import type { SqlDatabase } from './sql.js';
import { StorageConflictError, unixSeconds, validateStorageName } from './coordinator.js';
import { parseJsonMap, sha256, StorageCorruptionError } from './format.js';

export class StorageUnavailableError extends Error {
  constructor() {
    super('Object storage is unavailable');
    this.name = 'StorageUnavailableError';
  }
}

async function storageOperation<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) {
    if (error instanceof StorageConflictError || error instanceof StorageCorruptionError || error instanceof StorageUnavailableError) throw error;
    throw new StorageUnavailableError();
  }
}

export interface ImmutableObjectStore {
  read(key: string): Promise<string | null>;
  writeNew(key: string, payload: string): Promise<void>;
}
export function validateSnapshotKey(key: string): void {
  if (!/^snapshots\/[A-Za-z0-9_][A-Za-z0-9_.:-]{0,127}\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/[0-9a-f]{64}\.json$/.test(key)) {
    throw new StorageCorruptionError('Invalid snapshot object key');
  }
}
export function validateEntityObjectKey(objectKey: string, namespace: string, entityId: string): string {
  validateStorageName(namespace);
  validateStorageName(entityId);
  const prefix = `entities/${namespace}/${encodeURIComponent(entityId)}/`;
  if (!objectKey.startsWith(prefix)) throw new StorageCorruptionError('Invalid entity object key');
  const hash = objectKey.slice(prefix.length).match(/^([0-9a-f]{64})\.json$/)?.[1];
  if (!hash) throw new StorageCorruptionError('Invalid entity object key');
  return hash;
}
async function validateWrite(key: string, payload: string): Promise<void> {
  if (key.startsWith('snapshots/')) validateSnapshotKey(key);
  else if (key.startsWith('entities/')) {
    const match = /^entities\/([A-Za-z0-9_][A-Za-z0-9_.:-]{0,127})\/([^/]+)\//.exec(key);
    if (!match) throw new StorageCorruptionError('Invalid entity object key');
    let entityId: string;
    try { entityId = decodeURIComponent(match[2]!); } catch { throw new StorageCorruptionError('Invalid entity object key'); }
    validateEntityObjectKey(key, match[1]!, entityId);
  } else throw new StorageCorruptionError('Invalid object key');
  if (!key.endsWith(`/${await sha256(payload)}.json`)) throw new StorageCorruptionError();
}
export function createSqlObjectStore(db: SqlDatabase): ImmutableObjectStore {
  return {
    async read(key) {
      const rows = await db.query<{ payload: string }>('SELECT payload FROM storage_objects WHERE object_key=?', [key]);
      return rows[0]?.payload ?? null;
    },
    async writeNew(key, payload) {
      await validateWrite(key, payload);
      await db.execute('INSERT INTO storage_objects(object_key,payload,created_at) VALUES (?,?,?)', [key, payload, unixSeconds()]);
    },
  };
}

export interface KvBinding {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}
export function createKvObjectStore(binding: KvBinding): ImmutableObjectStore {
  return {
    read: (key) => storageOperation(() => binding.get(key)),
    async writeNew(key, payload) {
      await validateWrite(key, payload);
      const current = await storageOperation(() => binding.get(key));
      if (current !== null) throw new StorageConflictError('Immutable object already exists');
      // KV lacks conditional writes; UUID + content hash gives each immutable object a unique append-only key.
      await storageOperation(() => binding.put(key, payload));
    },
  };
}

export interface BlobAdapter {
  getText(key: string): Promise<string | null>;
  putIfAbsent(key: string, payload: string): Promise<boolean>;
}
export function createBlobObjectStore(adapter: BlobAdapter): ImmutableObjectStore {
  return {
    read: (key) => storageOperation(() => adapter.getText(key)),
    async writeNew(key, payload) {
      await validateWrite(key, payload);
      const created = await storageOperation(() => adapter.putIfAbsent(key, payload));
      if (!created) throw new StorageConflictError('Immutable object already exists');
    },
  };
}

export async function readLegacyJson(store: Pick<ImmutableObjectStore, 'read'>, key: string, expectedSha256?: string): Promise<Record<string, unknown>> {
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.:-]{0,127}$/.test(key)) throw new StorageCorruptionError('Invalid legacy storage key');
  const text = await store.read(key);
  if (text === null) throw new StorageCorruptionError();
  if (expectedSha256 !== undefined && (!/^[0-9a-f]{64}$/.test(expectedSha256) || await sha256(text) !== expectedSha256)) {
    throw new StorageCorruptionError();
  }
  return parseJsonMap(text);
}
