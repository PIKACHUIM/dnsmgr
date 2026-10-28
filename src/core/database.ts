import type { Bindings } from './types';
import type { SqlDatabase } from '../storage/sql';
import { AppError } from './errors';
import { createStorage, resolveStorageConfig, StorageConfigurationError } from '../storage/config';
import type { StorageConfiguration, StorageRuntime } from '../storage/config';

export interface StorageSelection extends StorageConfiguration {
  identity: string;
}

function tursoIdentity(bindings: Bindings): string {
  if (!bindings.TURSO_DATABASE_URL || !bindings.TURSO_AUTH_TOKEN) throw new AppError(503, '需要配置 Turso URL 和 Token', 'STORAGE_NOT_CONFIGURED');
  try {
    const url = new URL(bindings.TURSO_DATABASE_URL.replace(/^libsql:/, 'https:'));
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error();
    return `${url.origin}${url.pathname}`;
  } catch {
    throw new AppError(503, 'Turso URL 配置无效', 'INVALID_STORAGE_CONFIGURATION');
  }
}

export function selectStorage(bindings: Bindings): StorageSelection {
  let config: ReturnType<typeof resolveStorageConfig>;
  try { config = resolveStorageConfig(bindings); }
  catch (error) {
    if (!(error instanceof StorageConfigurationError)) throw error;
    if (['kv', 'blob'].includes(bindings.DB_DRIVER ?? '') && !bindings.COORDINATOR_DRIVER) throw new AppError(503, 'Blob/KV 必须配置 SQL 协调库', 'COORDINATOR_REQUIRED');
    if ((!bindings.DB_DRIVER || bindings.DB_DRIVER === 'auto') && !bindings.DB && !bindings.TURSO_DATABASE_URL) throw new AppError(503, '需要配置 D1 或 Turso 数据库', 'STORAGE_NOT_CONFIGURED');
    throw new AppError(503, '存储驱动、格式或协调库配置无效', 'INVALID_STORAGE_CONFIGURATION');
  }
  const coordinatorIdentity = config.coordinatorDriver === 'd1'
    ? bindings.COORDINATOR_ID
    : tursoIdentity(bindings);
  if (config.coordinatorDriver === 'd1' && (!bindings.DB || !coordinatorIdentity?.trim())) {
    throw new AppError(503, 'D1 模式需要 DB 绑定和稳定的 COORDINATOR_ID', 'STORAGE_NOT_CONFIGURED');
  }
  if (config.coordinatorDriver === 'turso' && !bindings.TURSO_AUTH_TOKEN) {
    throw new AppError(503, '需要配置 Turso URL 和 Token', 'STORAGE_NOT_CONFIGURED');
  }
  if (config.driver === 'kv' && (!bindings.KV || !bindings.PAYLOAD_STORE_ID?.trim())) {
    throw new AppError(503, 'KV 模式需要 KV 绑定和稳定的 PAYLOAD_STORE_ID', 'STORAGE_NOT_CONFIGURED');
  }
  if (config.driver === 'blob' && (!bindings.BLOB_ADAPTER || !(bindings.PAYLOAD_STORE_ID ?? bindings.BLOB_NAMESPACE)?.trim())) {
    throw new AppError(503, 'Blob 模式需要平台 Blob 适配器和命名空间标识', 'STORAGE_NOT_CONFIGURED');
  }
  const payloadIdentity = config.driver === 'kv'
    ? bindings.PAYLOAD_STORE_ID
    : config.driver === 'blob'
      ? bindings.PAYLOAD_STORE_ID ?? bindings.BLOB_NAMESPACE
      : coordinatorIdentity;
  const identity = `v1:${config.coordinatorDriver}:${coordinatorIdentity}:${config.driver}:${config.format}:${payloadIdentity}`;
  return { ...config, identity };
}

export function storage(bindings: Bindings): StorageRuntime {
  try {
    return createStorage(bindings, { fetch: bindings.BUDGET?.fetch, blobAdapter: bindings.BLOB_ADAPTER });
  } catch (error) {
    if (!(error instanceof StorageConfigurationError)) throw error;
    throw new AppError(503, '持久化存储绑定或格式不可用', 'STORAGE_ADAPTER_NOT_CONFIGURED');
  }
}

export async function assertStorageIdentity(db: SqlDatabase, selected: StorageSelection): Promise<void> {
  const rows = await db.query<{ initialized: number; storage_identity: string | null }>('SELECT initialized, storage_identity FROM system_state WHERE id = 1');
  const state = rows[0];
  if (!state) throw new AppError(503, '数据库尚未执行迁移', 'SCHEMA_NOT_INITIALIZED');
  if (state.initialized === 1 && state.storage_identity !== selected.identity) throw new AppError(503, '存储配置与初始化身份不一致，需要显式导出/导入', 'STORAGE_IDENTITY_MISMATCH');
}
