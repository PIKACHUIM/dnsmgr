import { createD1Database, createTursoDatabase, type D1Binding, type SqlDatabase } from './sql.js';
import { SqlCoordinator } from './coordinator.js';
import { SqlEntityRepository } from './entities.js';
import { createBlobObjectStore, createKvObjectStore, createSqlObjectStore, type BlobAdapter, type ImmutableObjectStore, type KvBinding } from './objects.js';
import { VersionedSnapshotRepository } from './snapshots.js';

export type StorageDriver = 'd1' | 'turso' | 'kv' | 'blob';
export type StorageFormat = 'sql' | 'map' | 'key';
export type StorageConfiguration = { driver: StorageDriver; format: StorageFormat; coordinatorDriver: 'd1' | 'turso' };
export interface StorageRuntime {
  config: StorageConfiguration;
  db: SqlDatabase;
  coordinator: SqlCoordinator;
  entities: (namespace: string) => SqlEntityRepository;
  snapshots: VersionedSnapshotRepository | null;
}
export class StorageConfigurationError extends Error {
  constructor(message = 'Invalid storage configuration') {
    super(message);
    this.name = 'StorageConfigurationError';
  }
}
export interface StorageBindings {
  DB_DRIVER?: string;
  DB_FORMAT?: string;
  COORDINATOR_DRIVER?: string;
  DB?: D1Binding;
  KV?: KvBinding;
  TURSO_DATABASE_URL?: string;
  TURSO_AUTH_TOKEN?: string;
  COORDINATOR_ID?: string;
  PAYLOAD_STORE_ID?: string;
}
export function resolveStorageConfig(env: Pick<StorageBindings, 'DB_DRIVER' | 'DB_FORMAT' | 'COORDINATOR_DRIVER' | 'DB' | 'TURSO_DATABASE_URL'>): StorageConfiguration {
  let driver = (env.DB_DRIVER ?? 'auto').trim().toLowerCase();
  if (driver === 'auto') driver = env.DB ? 'd1' : env.TURSO_DATABASE_URL ? 'turso' : '';
  if (!['d1', 'turso', 'kv', 'blob'].includes(driver)) throw new StorageConfigurationError('Unsupported or unconfigured storage driver');
  const format = (env.DB_FORMAT ?? (driver === 'd1' || driver === 'turso' ? 'sql' : 'map')).trim().toLowerCase();
  if (!['sql', 'map', 'key'].includes(format)) throw new StorageConfigurationError('Storage format is not implemented');
  if ((driver === 'kv' || driver === 'blob') && format === 'sql') throw new StorageConfigurationError('Object storage requires map or key snapshots');
  const coordinatorDriver = (env.COORDINATOR_DRIVER ?? (driver === 'd1' || driver === 'turso' ? driver : '')).trim().toLowerCase();
  if (coordinatorDriver !== 'd1' && coordinatorDriver !== 'turso') throw new StorageConfigurationError('SQL coordinator is required');
  if ((driver === 'd1' || driver === 'turso') && coordinatorDriver !== driver) {
    throw new StorageConfigurationError('SQL storage and coordinator must share one database');
  }
  return { driver: driver as StorageDriver, format: format as StorageFormat, coordinatorDriver };
}
export function createStorage(env: StorageBindings, options: { fetch?: typeof fetch; blobAdapter?: BlobAdapter } = {}): StorageRuntime {
  const config = resolveStorageConfig(env);
  let db: SqlDatabase;
  if (config.coordinatorDriver === 'd1') {
    if (!env.DB || typeof env.DB.prepare !== 'function' || typeof env.DB.batch !== 'function') {
      throw new StorageConfigurationError('D1 binding is required');
    }
    db = createD1Database(env.DB);
  } else {
    if (!env.TURSO_DATABASE_URL || !env.TURSO_AUTH_TOKEN) throw new StorageConfigurationError('Turso credentials are required');
    db = createTursoDatabase({ url: env.TURSO_DATABASE_URL, token: env.TURSO_AUTH_TOKEN, fetch: options.fetch });
  }
  let objects: ImmutableObjectStore;
  if (config.driver === 'kv') {
    if (!env.KV || typeof env.KV.get !== 'function' || typeof env.KV.put !== 'function') throw new StorageConfigurationError('KV binding is required');
    objects = createKvObjectStore(env.KV);
  } else if (config.driver === 'blob') {
    if (!options.blobAdapter) throw new StorageConfigurationError('A real platform Blob adapter is required');
    objects = createBlobObjectStore(options.blobAdapter);
  } else {
    objects = createSqlObjectStore(db);
  }
  return {
    config, db, coordinator: new SqlCoordinator(db),
    entities: (namespace) => {
      if (config.format !== 'sql') throw new StorageConfigurationError('Use the snapshot repository for map or key storage');
      return new SqlEntityRepository(db, namespace);
    },
    snapshots: config.format === 'sql' ? null : new VersionedSnapshotRepository(db, objects, config.format),
  };
}
