import type { SqlDatabase, SqlValue } from './sql.js';
import { type Lease, StorageConflictError, unixSeconds, validateStorageName } from './coordinator.js';
import { canonicalJson, jsonMap, keyHashes, parseJsonMap, sha256, StorageCorruptionError } from './format.js';
import { type ImmutableObjectStore, validateEntityObjectKey, validateSnapshotKey } from './objects.js';

export type SnapshotFormat = 'map' | 'key';
type VersionRow = {
  namespace: string; version: string; format: string; object_key: string;
  sha256: string; manifest: string; created_at: number;
};
type LoadedSnapshot = {
  row: VersionRow;
  data: Record<string, unknown> | null;
  keyMap: Record<string, string>;
  keyObjects: Record<string, string> | null;
};
export type Snapshot = { namespace: string; version: string; data: Record<string, unknown>; createdAt: number };

function exactKeys(object: Record<string, unknown>, keys: string[]): void {
  if (canonicalJson(Object.keys(object).sort()) !== canonicalJson(keys.sort())) throw new StorageCorruptionError();
}
function hashMap(value: unknown): Record<string, string> {
  const map = jsonMap(value);
  for (const hash of Object.values(map)) {
    if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) throw new StorageCorruptionError();
  }
  return map as Record<string, string>;
}
function objectKey(namespace: string, version: string, hash: string): string {
  const key = `snapshots/${namespace}/${version}/${hash}.json`;
  validateSnapshotKey(key);
  return key;
}
function entityObjectKey(namespace: string, key: string, hash: string): string {
  return `entities/${namespace}/${encodeURIComponent(key)}/${hash}.json`;
}

async function publishSnapshot(
  db: SqlDatabase,
  objects: ImmutableObjectStore,
  namespace: string,
  format: SnapshotFormat,
  version: string,
  expectedVersion: string | null,
  lease: Lease,
  createdAt: number,
  startedAt: number,
  now: number | undefined,
  hashes: Record<string, string>,
  keyObjects: Record<string, string> | null,
  envelope: Record<string, unknown>,
): Promise<string> {
  const payload = canonicalJson(envelope);
  const hash = await sha256(payload);
  const rootObject = objectKey(namespace, version, hash);
  const manifest = canonicalJson({ namespace, version, format, objectKey: rootObject, sha256: hash, keyMap: hashes,
    ...(keyObjects === null ? {} : { keyObjects }) });
  await objects.writeNew(rootObject, payload);

  const clock = now === undefined ? 'unixepoch()' : '?';
  const guard = `EXISTS (SELECT 1 FROM coordinator_leases WHERE name=? AND owner=? AND fence=? AND lease_until>${clock})
    AND ((? IS NULL AND NOT EXISTS (SELECT 1 FROM storage_active WHERE namespace=?))
      OR EXISTS (SELECT 1 FROM storage_active a JOIN storage_versions v ON v.namespace=a.namespace AND v.version=a.version
                 WHERE a.namespace=? AND a.version=? AND v.format=? AND a.fence<=?))`;
  const clockArgs: SqlValue[] = now === undefined ? [] : [now + Math.max(0, unixSeconds() - startedAt)];
  const guardArgs: SqlValue[] = [lease.name, lease.owner, lease.fence, ...clockArgs, expectedVersion, namespace, namespace, expectedVersion, format, lease.fence];
  const results = await db.batch([
    {
      sql: `INSERT INTO storage_versions(namespace,version,format,object_key,sha256,manifest,created_at)
            SELECT ?,?,?,?,?,?,? WHERE ${guard}`,
      args: [namespace, version, format, rootObject, hash, manifest, createdAt, ...guardArgs],
    },
    {
      sql: `INSERT INTO storage_active(namespace,version,fence)
            SELECT ?,CASE WHEN ${guard} THEN ? ELSE NULL END,?
            WHERE EXISTS (SELECT 1 FROM storage_versions WHERE namespace=? AND version=?)
            ON CONFLICT(namespace) DO UPDATE SET version=excluded.version,fence=excluded.fence
            WHERE storage_active.version=? AND storage_active.fence<=excluded.fence RETURNING version`,
      args: [namespace, ...guardArgs, version, lease.fence, namespace, version, expectedVersion],
    },
  ]);
  if (results.length !== 2 || results.some((result) => result.changes !== 1)) throw new StorageConflictError();
  return version;
}

export class VersionedSnapshotRepository {
  constructor(private readonly db: SqlDatabase, private readonly objects: ImmutableObjectStore, readonly format: SnapshotFormat = 'map') {
    if (format !== 'map' && format !== 'key') throw new Error('Unsupported snapshot format');
  }

  async activeVersion(namespace: string): Promise<string | null> {
    validateStorageName(namespace);
    const rows = await this.db.query<{ version: string }>('SELECT version FROM storage_active WHERE namespace=?', [namespace]);
    return rows[0]?.version ?? null;
  }

  async write(namespace: string, data: Record<string, unknown>, expectedVersion: string | null, lease: Lease, now?: number): Promise<string> {
    validateStorageName(namespace);
    if (lease.name !== `snapshot:${namespace}` || (now !== undefined && (!Number.isSafeInteger(now) || now < 0))) throw new StorageConflictError();
    const startedAt = unixSeconds();
    const createdAt = now ?? startedAt;
    const version = crypto.randomUUID();
    // 在异步哈希和对象写入前捕获调用者数据，防止等待期间发生突变。
    const captured = parseJsonMap(canonicalJson(jsonMap(data)));
    const hashes = await keyHashes(captured);
    const previous = this.format === 'key' && expectedVersion !== null
      ? await this.loadSnapshot(namespace, expectedVersion)
      : null;
    let envelope: Record<string, unknown>;
    let keyObjects: Record<string, string> | null = null;
    if (this.format === 'map') {
      envelope = { schemaVersion: 1, namespace, version, format: 'map', data: captured, keyMap: hashes };
    } else {
      keyObjects = {};
      for (const key of Object.keys(captured).sort()) {
        if (previous && previous.keyMap[key] === hashes[key] && previous.keyObjects?.[key]) {
          keyObjects[key] = previous.keyObjects[key]!;
          continue;
        }
        const payload = canonicalJson({ schemaVersion: 1, namespace, key, sha256: hashes[key], data: captured[key] });
        const entityObject = entityObjectKey(namespace, key, await sha256(payload));
        await this.objects.writeNew(entityObject, payload);
        keyObjects[key] = entityObject;
      }
      // key 模式的活动版本对象只存索引；实体内容分别存于不可变对象，读取单 key 不拉全库。
      envelope = { schemaVersion: 1, namespace, version, format: 'key', keyMap: hashes, keyObjects };
    }
    return publishSnapshot(this.db, this.objects, namespace, this.format, version, expectedVersion, lease, createdAt,
      startedAt, now, hashes, keyObjects, envelope);
  }

  async putKey(namespace: string, key: string, value: unknown, expectedVersion: string | null, lease: Lease, now?: number): Promise<string> {
    if (this.format !== 'key') throw new StorageConflictError('Single-key writes require key format');
    validateStorageName(namespace);
    validateStorageName(key);
    if (lease.name !== `snapshot:${namespace}` || (now !== undefined && (!Number.isSafeInteger(now) || now < 0))) throw new StorageConflictError();
    const previous = expectedVersion === null ? null : await this.loadSnapshot(namespace, expectedVersion);
    const hashes = { ...(previous?.keyMap ?? {}) };
    const references = { ...(previous?.keyObjects ?? {}) };
    const valuePayload = canonicalJson(value);
    const valueHash = await sha256(valuePayload);
    if (hashes[key] !== valueHash) {
      const encodedValue = JSON.parse(valuePayload) as unknown;
      const entityPayload = canonicalJson({ schemaVersion: 1, namespace, key, sha256: valueHash, data: encodedValue });
      const entityHash = await sha256(entityPayload);
      const reference = entityObjectKey(namespace, key, entityHash);
      await this.objects.writeNew(reference, entityPayload);
      hashes[key] = valueHash;
      references[key] = reference;
    }
    return this.publishKeyIndex(namespace, hashes, references, expectedVersion, lease, now);
  }

  async deleteKey(namespace: string, key: string, expectedVersion: string | null, lease: Lease, now?: number): Promise<string> {
    if (this.format !== 'key') throw new StorageConflictError('Single-key deletes require key format');
    validateStorageName(namespace);
    validateStorageName(key);
    if (expectedVersion === null || lease.name !== `snapshot:${namespace}` || (now !== undefined && (!Number.isSafeInteger(now) || now < 0))) {
      throw new StorageConflictError();
    }
    const previous = await this.loadSnapshot(namespace, expectedVersion);
    if (!Object.hasOwn(previous.keyMap, key) || !previous.keyObjects) throw new StorageConflictError('Snapshot key does not exist');
    const hashes = { ...previous.keyMap };
    const references = { ...previous.keyObjects };
    delete hashes[key];
    delete references[key];
    return this.publishKeyIndex(namespace, hashes, references, expectedVersion, lease, now);
  }

  async listKeys(namespace: string, after = '', limit = 100, version?: string): Promise<{ keys: string[]; nextCursor: string | null; version: string | null }> {
    validateStorageName(namespace);
    if (after) validateStorageName(after);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error('Invalid key page size');
    const selectedVersion = version ?? await this.activeVersion(namespace);
    if (selectedVersion === null) return { keys: [], nextCursor: null, version: null };
    const loaded = await this.loadSnapshot(namespace, selectedVersion);
    const candidates = Object.keys(loaded.keyMap).filter((key) => key > after).sort();
    const page = candidates.slice(0, limit + 1);
    const hasMore = page.length > limit;
    const keys = hasMore ? page.slice(0, limit) : page;
    return { keys, nextCursor: hasMore ? keys.at(-1)! : null, version: selectedVersion };
  }

  private async publishKeyIndex(namespace: string, hashes: Record<string, string>, references: Record<string, string>, expectedVersion: string | null, lease: Lease, now?: number): Promise<string> {
    const startedAt = unixSeconds();
    const version = crypto.randomUUID();
    const envelope = { schemaVersion: 1, namespace, version, format: 'key', keyMap: hashes, keyObjects: references };
    return publishSnapshot(this.db, this.objects, namespace, 'key', version, expectedVersion, lease, now ?? startedAt,
      startedAt, now, hashes, references, envelope);
  }

  async readActive(namespace: string): Promise<Snapshot> {
    const version = await this.activeVersion(namespace);
    if (version === null) throw new StorageCorruptionError();
    return this.readVersion(namespace, version);
  }

  async readVersion(namespace: string, version: string): Promise<Snapshot> {
    const loaded = await this.loadSnapshot(namespace, version);
    const data = loaded.data ?? Object.fromEntries(await Promise.all(Object.keys(loaded.keyMap).map(async (key) =>
      [key, await this.readEntityObject(namespace, key, loaded)] as const)));
    return { namespace, version, data, createdAt: loaded.row.created_at };
  }

  async readKey(namespace: string, key: string, version?: string): Promise<unknown> {
    validateStorageName(key);
    const selectedVersion = version ?? await this.activeVersion(namespace);
    if (selectedVersion === null) throw new StorageCorruptionError();
    const loaded = await this.loadSnapshot(namespace, selectedVersion);
    if (!Object.hasOwn(loaded.keyMap, key)) return undefined;
    return loaded.data === null ? this.readEntityObject(namespace, key, loaded) : loaded.data[key];
  }

  private async loadSnapshot(namespace: string, version: string): Promise<LoadedSnapshot> {
    validateStorageName(namespace);
    const rows = await this.db.query<VersionRow>('SELECT * FROM storage_versions WHERE namespace=? AND version=?', [namespace, version]);
    const row = rows[0];
    if (!row || row.format !== this.format || !Number.isSafeInteger(row.created_at) || row.created_at < 0) throw new StorageCorruptionError();
    if (row.object_key !== objectKey(namespace, version, row.sha256)) throw new StorageCorruptionError();
    const payload = await this.objects.read(row.object_key);
    if (payload === null || await sha256(payload) !== row.sha256) throw new StorageCorruptionError();
    const envelope = parseJsonMap(payload);
    if (canonicalJson(envelope) !== payload) throw new StorageCorruptionError();
    const manifest = parseJsonMap(row.manifest);
    exactKeys(envelope, this.format === 'map'
      ? ['schemaVersion', 'namespace', 'version', 'format', 'data', 'keyMap']
      : ['schemaVersion', 'namespace', 'version', 'format', 'keyMap', 'keyObjects']);
    if (envelope.schemaVersion !== 1 || envelope.namespace !== namespace || envelope.version !== version || envelope.format !== this.format) {
      throw new StorageCorruptionError();
    }
    const hashes = hashMap(envelope.keyMap);
    let data: Record<string, unknown> | null = null;
    let keyObjects: Record<string, string> | null = null;
    if (this.format === 'map') {
      data = jsonMap(envelope.data);
      if (canonicalJson(hashes) !== canonicalJson(await keyHashes(data))) throw new StorageCorruptionError();
    } else {
      const references = jsonMap(envelope.keyObjects);
      exactKeys(references, Object.keys(hashes));
      for (const [key, reference] of Object.entries(references)) {
        if (typeof reference !== 'string') throw new StorageCorruptionError();
        validateEntityObjectKey(reference, namespace, key);
      }
      if (new Set(Object.values(references)).size !== Object.keys(references).length) throw new StorageCorruptionError();
      keyObjects = references as Record<string, string>;
    }
    if (canonicalJson(manifest) !== canonicalJson({ namespace, version, format: this.format, objectKey: row.object_key, sha256: row.sha256, keyMap: hashes,
      ...(keyObjects === null ? {} : { keyObjects }) })) throw new StorageCorruptionError();
    return { row, data, keyMap: hashes, keyObjects };
  }

  private async readEntityObject(namespace: string, key: string, loaded: LoadedSnapshot): Promise<unknown> {
    const reference = loaded.keyObjects?.[key];
    const expectedHash = loaded.keyMap[key];
    if (!reference || !expectedHash) throw new StorageCorruptionError();
    const objectHash = validateEntityObjectKey(reference, namespace, key);
    const payload = await this.objects.read(reference);
    if (payload === null || await sha256(payload) !== objectHash) throw new StorageCorruptionError();
    const entity = parseJsonMap(payload);
    exactKeys(entity, ['schemaVersion', 'namespace', 'key', 'sha256', 'data']);
    if (canonicalJson(entity) !== payload || entity.schemaVersion !== 1 || entity.namespace !== namespace || entity.key !== key ||
      entity.sha256 !== expectedHash || await sha256(canonicalJson(entity.data)) !== expectedHash) throw new StorageCorruptionError();
    return entity.data;
  }
}
