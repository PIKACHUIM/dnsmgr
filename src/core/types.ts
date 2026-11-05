import type { D1Binding, SqlDatabase } from '../storage/sql';
import type { BlobAdapter, KvBinding } from '../storage/objects';
import type { StorageRuntime } from '../storage/config';

export type Platform = 'cloudflare' | 'edgeone' | 'esa' | 'local';

export interface RequestBudget {
  consume(): void;
  fetch: typeof fetch;
  remainingMs(): number;
}

export interface Bindings {
  DB?: D1Binding;
  KV?: KvBinding;
  BUCKET?: { get(key: string): Promise<{ text(): Promise<string> } | null>; put(key: string, value: string, options: { onlyIf: Headers }): Promise<{ key: string } | null> };
  BLOB_ADAPTER?: BlobAdapter;
  BLOB_NAMESPACE?: string;
  ESA_KV_NAMESPACE?: string;
  BUDGET?: RequestBudget;
  COORDINATOR_ID?: string;
  PAYLOAD_STORE_ID?: string;
  TURSO_DATABASE_URL?: string;
  TURSO_AUTH_TOKEN?: string;
  DB_DRIVER?: string;
  DB_FORMAT?: string;
  COORDINATOR_DRIVER?: string;
  APP_KEY?: string;
  SETUP_TOKEN?: string;
  PUBLIC_ORIGIN?: string;
  CLIENT_IP?: string;
  EXECUTOR_URL?: string;
  ASSETS?: { fetch(request: Request): Promise<Response> };
}

export interface UserRow extends Record<string, unknown> {
  id: number;
  username: string;
  password_hash: string;
  level: number;
  status: number;
  is_api: number;
  apikey_cipher: string | null;
  totp_cipher: string | null;
  permission_version: number;
  expires_at: number | null;
}

export interface Principal {
  user: UserRow;
  sessionHash?: string;
  csrfHash?: string;
  domainId?: number;
  mode: 'session' | 'api';
}

export interface Runtime {
  platform: Platform;
  maxFetches: number;
  maxDurationMs: number;
}

export interface AppEnv {
  Bindings: Bindings & { RUNTIME: Runtime; BUDGET: RequestBudget };
  Variables: {
    db: SqlDatabase;
    storage: Pick<StorageRuntime, 'config' | 'db' | 'snapshots'>;
    principal: Principal;
    legacyApiBody: Record<string, unknown>;
  };
}
