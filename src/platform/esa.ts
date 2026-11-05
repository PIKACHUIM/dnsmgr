import { createApp } from '../app';
import type { Bindings } from '../core/types';
import { createEsaEdgeKvBinding, type EsaEdgeKvClient } from './storage/esa';
import { environment } from './runtime';

const app = createApp();

type EdgeKvConstructor = new (options: { namespace: string }) => EsaEdgeKvClient;

function esaBindings(bindings: Bindings, context: unknown): Bindings {
  const info = context && typeof context === 'object' ? (context as { info?: unknown }).info : undefined;
  const remoteAddr = info && typeof info === 'object' ? (info as { remote_addr?: unknown }).remote_addr : undefined;
  const withClientIp = typeof remoteAddr === 'string' ? { ...bindings, CLIENT_IP: remoteAddr } : bindings;
  if (withClientIp.DB_DRIVER !== 'kv') return withClientIp;
  const namespace = withClientIp.ESA_KV_NAMESPACE;
  const EdgeKV = (globalThis as typeof globalThis & { EdgeKV?: EdgeKvConstructor }).EdgeKV;
  if (!namespace || !EdgeKV) return withClientIp;
  return {
    ...withClientIp,
    KV: createEsaEdgeKvBinding(new EdgeKV({ namespace })),
    PAYLOAD_STORE_ID: withClientIp.PAYLOAD_STORE_ID ?? `edgekv:${namespace}`,
  };
}

export default {
  fetch(request: Request, context: unknown, bindings: Bindings): Promise<Response> {
    return Promise.resolve(app.fetch(request, environment(esaBindings(bindings ?? {}, context), 'esa')));
  },
};
