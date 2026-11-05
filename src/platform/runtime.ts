import type { Bindings, Platform, RequestBudget, Runtime } from '../core/types';
import type { BlobAdapter, KvBinding } from '../storage/objects';
import { AppError } from '../core/errors';

export function runtime(platform: Platform): Runtime {
  return {
    platform,
    maxFetches: platform === 'esa' ? 4 : platform === 'cloudflare' ? 50 : 100,
    maxDurationMs: platform === 'esa' ? 8_000 : 25_000,
  };
}

export function createRequestBudget(policy: Runtime, transport: typeof fetch = fetch): RequestBudget {
  let requests = 0;
  const deadline = Date.now() + policy.maxDurationMs;
  const remainingMs = () => Math.max(0, deadline - Date.now());
  const consume = () => {
    if (requests >= policy.maxFetches) throw new AppError(503, '本次请求已达平台子请求上限，请使用分步任务', 'REQUEST_BUDGET_EXCEEDED');
    if (remainingMs() <= 0) throw new AppError(503, '本次请求执行时间已达上限', 'REQUEST_TIMEOUT');
    requests++;
  };
  const requestFetch: typeof fetch = async (request, init) => {
    consume();
    const timeout = AbortSignal.timeout(remainingMs());
    const original = init?.signal ?? (request instanceof Request ? request.signal : null);
    const signal = original ? AbortSignal.any([original, timeout]) : timeout;
    return transport(request, { ...init, redirect: 'manual', signal });
  };
  return { consume, fetch: requestFetch, remainingMs };
}

function budgetedKv(binding: KvBinding | undefined, budget: RequestBudget): KvBinding | undefined {
  if (!binding) return undefined;
  return {
    async get(key) { budget.consume(); return binding.get(key); },
    async put(key, value) { budget.consume(); return binding.put(key, value); },
  };
}

function budgetedBlob(adapter: BlobAdapter | undefined, budget: RequestBudget): BlobAdapter | undefined {
  if (!adapter) return undefined;
  return {
    async getText(key) { budget.consume(); return adapter.getText(key); },
    async putIfAbsent(key, payload) { budget.consume(); return adapter.putIfAbsent(key, payload); },
  };
}

export function environment(bindings: Bindings, platform: Platform) {
  const policy = runtime(platform);
  const budget = bindings.BUDGET ?? createRequestBudget(policy);
  return {
    DB: bindings.DB,
    KV: budgetedKv(bindings.KV, budget),
    BUCKET: bindings.BUCKET,
    BLOB_ADAPTER: budgetedBlob(bindings.BLOB_ADAPTER, budget),
    BLOB_NAMESPACE: bindings.BLOB_NAMESPACE,
    ESA_KV_NAMESPACE: bindings.ESA_KV_NAMESPACE,
    COORDINATOR_ID: bindings.COORDINATOR_ID,
    PAYLOAD_STORE_ID: bindings.PAYLOAD_STORE_ID,
    TURSO_DATABASE_URL: bindings.TURSO_DATABASE_URL,
    TURSO_AUTH_TOKEN: bindings.TURSO_AUTH_TOKEN,
    DB_DRIVER: bindings.DB_DRIVER,
    DB_FORMAT: bindings.DB_FORMAT,
    COORDINATOR_DRIVER: bindings.COORDINATOR_DRIVER,
    APP_KEY: bindings.APP_KEY,
    SETUP_TOKEN: bindings.SETUP_TOKEN,
    PUBLIC_ORIGIN: bindings.PUBLIC_ORIGIN,
    CLIENT_IP: bindings.CLIENT_IP,
    EXECUTOR_URL: bindings.EXECUTOR_URL,
    ASSETS: bindings.ASSETS,
    RUNTIME: policy,
    BUDGET: budget,
  };
}

export function budgetedFetch(policy: Runtime, transport: typeof fetch = fetch): typeof fetch {
  return createRequestBudget(policy, transport).fetch;
}
