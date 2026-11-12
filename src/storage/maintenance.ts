import type { SqlDatabase } from './sql.js';
import type { SqlCoordinator } from './coordinator.js';
import { validateStorageName } from './coordinator.js';
import { canonicalJson, jsonMap, parseJsonMap, sha256, StorageCorruptionError } from './format.js';
import type { SnapshotFormat, VersionedSnapshotRepository } from './snapshots.js';

export interface SnapshotVersionInfo {
  version: string;
  format: string;
  createdAt: number;
  active: boolean;
}

export interface SnapshotBackup {
  schemaVersion: 1;
  namespace: string;
  format: SnapshotFormat;
  version: string;
  createdAt: number;
  data: Record<string, unknown>;
  dataSha256: string;
}

export interface PruneResult {
  namespace: string;
  keptVersions: string[];
  removedVersions: number;
  removedObjects: number;
  objectStoreGc: boolean;
}

type VersionRow = { version: string; format: string; created_at: number; manifest: string };

function uuid(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) {
    throw new StorageCorruptionError('Invalid storage version');
  }
  return value;
}

export async function listSnapshotVersions(db: SqlDatabase, namespace: string, limit = 50): Promise<SnapshotVersionInfo[]> {
  validateStorageName(namespace);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error('Invalid version page size');
  const rows = await db.query<{ version: string; format: string; created_at: number; active: number | null }>(
    `SELECT v.version, v.format, v.created_at, CASE WHEN a.version=v.version THEN 1 ELSE 0 END AS active
     FROM storage_versions v LEFT JOIN storage_active a ON a.namespace=v.namespace
     WHERE v.namespace=? ORDER BY CASE WHEN a.version=v.version THEN 0 ELSE 1 END, v.created_at DESC, v.version DESC LIMIT ?`,
    [namespace, limit],
  );
  return rows.map((row) => ({
    version: row.version,
    format: row.format,
    createdAt: Number(row.created_at),
    active: Number(row.active) === 1,
  }));
}

export async function exportSnapshot(
  repository: VersionedSnapshotRepository, namespace: string, version?: string,
): Promise<SnapshotBackup> {
  validateStorageName(namespace);
  const snapshot = version === undefined
    ? await repository.readActive(namespace)
    : await repository.readVersion(namespace, uuid(version));
  const data = jsonMap(snapshot.data);
  return {
    schemaVersion: 1,
    namespace,
    format: repository.format,
    version: snapshot.version,
    createdAt: snapshot.createdAt,
    data,
    dataSha256: await sha256(canonicalJson(data)),
  };
}

async function verifiedData(data: unknown, expectedSha256: string): Promise<Record<string, unknown>> {
  const map = jsonMap(data);
  if (!/^[0-9a-f]{64}$/.test(expectedSha256)) throw new StorageCorruptionError('Invalid backup hash');
  if (await sha256(canonicalJson(map)) !== expectedSha256) throw new StorageCorruptionError('Backup payload hash mismatch');
  return map;
}

async function withNamespaceLease<T>(
  coordinator: SqlCoordinator, namespace: string, owner: string, operation: (lease: Awaited<ReturnType<SqlCoordinator['acquire']>>) => Promise<T>,
): Promise<T> {
  const lease = await coordinator.acquire(`snapshot:${namespace}`, owner, 30);
  try {
    return await operation(lease);
  } finally {
    await coordinator.release(lease).catch(() => undefined);
  }
}

export async function importSnapshot(
  repository: VersionedSnapshotRepository, coordinator: SqlCoordinator, namespace: string,
  data: unknown, dataSha256: string, expectedVersion: string | null, owner: string,
): Promise<{ version: string; previousVersion: string | null; format: SnapshotFormat }> {
  validateStorageName(namespace);
  const verified = await verifiedData(data, dataSha256);
  if (expectedVersion !== null) uuid(expectedVersion);
  const version = await withNamespaceLease(coordinator, namespace, owner, (lease) =>
    repository.write(namespace, verified, expectedVersion, lease));
  return { version, previousVersion: expectedVersion, format: repository.format };
}

export async function restoreSnapshot(
  repository: VersionedSnapshotRepository, coordinator: SqlCoordinator, namespace: string,
  version: string, expectedVersion: string | null, owner: string,
): Promise<{ version: string; restoredFrom: string; previousVersion: string | null }> {
  validateStorageName(namespace);
  const source = await repository.readVersion(namespace, uuid(version));
  const previousVersion = expectedVersion ?? await repository.activeVersion(namespace);
  const created = await withNamespaceLease(coordinator, namespace, owner, (lease) =>
    repository.write(namespace, source.data, previousVersion, lease));
  return { version: created, restoredFrom: source.version, previousVersion };
}

function globEscape(value: string): string {
  return value.replace(/[*?[\]]/g, (character) => `[${character}]`);
}

export async function pruneSnapshotVersions(
  db: SqlDatabase, namespace: string, keep: number, deleteObjects: boolean,
): Promise<PruneResult> {
  validateStorageName(namespace);
  if (!Number.isSafeInteger(keep) || keep < 1 || keep > 100) throw new Error('Invalid retention count');
  const rows = await db.query<VersionRow>(
    `SELECT v.version,v.format,v.created_at,v.manifest FROM storage_versions v
     LEFT JOIN storage_active a ON a.namespace=v.namespace
     WHERE v.namespace=? ORDER BY CASE WHEN a.version=v.version THEN 0 ELSE 1 END, v.created_at DESC, v.version DESC`,
    [namespace],
  );
  const active = (await db.query<{ version: string }>('SELECT version FROM storage_active WHERE namespace=?', [namespace]))[0]?.version;
  const kept = new Set(rows.slice(0, keep).map((row) => row.version));
  if (active && rows.some((row) => row.version === active)) kept.add(active);
  const removed = rows.filter((row) => !kept.has(row.version));
  if (removed.length > 0) {
    const placeholders = [...kept].map(() => '?').join(',');
    await db.execute(
      `DELETE FROM storage_versions WHERE namespace=? AND version NOT IN (${placeholders})`,
      [namespace, ...kept],
    );
  }
  const referenced = new Set<string>();
  for (const row of rows.filter((item) => kept.has(item.version))) {
    const manifest = parseJsonMap(row.manifest);
    if (typeof manifest.objectKey === 'string') referenced.add(manifest.objectKey);
    if (manifest.keyObjects !== null && typeof manifest.keyObjects === 'object' && !Array.isArray(manifest.keyObjects)) {
      for (const value of Object.values(manifest.keyObjects as Record<string, unknown>)) {
        if (typeof value === 'string') referenced.add(value);
      }
    }
  }
  let removedObjects = 0;
  if (deleteObjects) {
    const pattern = globEscape(namespace);
    const candidates = await db.query<{ object_key: string }>(
      "SELECT object_key FROM storage_objects WHERE object_key GLOB ? OR object_key GLOB ?",
      [`snapshots/${pattern}/*`, `entities/${pattern}/*`],
    );
    const stale = candidates.map((row) => row.object_key).filter((key) => !referenced.has(key));
    for (let index = 0; index < stale.length; index += 100) {
      const chunk = stale.slice(index, index + 100);
      const results = await db.batch(chunk.map((key) => ({ sql: 'DELETE FROM storage_objects WHERE object_key=?', args: [key] })));
      removedObjects += results.reduce((total, result) => total + result.changes, 0);
    }
  }
  return {
    namespace,
    keptVersions: [...kept].sort(),
    removedVersions: removed.length,
    removedObjects,
    objectStoreGc: deleteObjects,
  };
}
