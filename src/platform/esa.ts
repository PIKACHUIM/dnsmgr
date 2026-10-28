import { createApp } from '../app';
import type { Bindings } from '../core/types';
import { createEsaEdgeKvBinding, type EsaEdgeKvClient } from './storage/esa';
import { environment } from './runtime';

const app = createApp();

type EdgeKvConstructor = new (options: { namespace: string }) => EsaEdgeKvClient;

function esaBindings(bindings: Bindings): Bindings {
  if (bindings.DB_DRIVER !== 'kv') return bindings;
  const namespace = bindings.ESA_KV_NAMESPACE;
  const EdgeKV = (globalThis as typeof globalThis & { EdgeKV?: EdgeKvConstructor }).EdgeKV;
  if (!namespace || !EdgeKV) return bindings;
  return {
    ...bindings,
    KV: createEsaEdgeKvBinding(new EdgeKV({ namespace })),
    PAYLOAD_STORE_ID: bindings.PAYLOAD_STORE_ID ?? `edgekv:${namespace}`,
  };
}

export default {
  fetch(request: Request, _context: unknown, bindings: Bindings): Promise<Response> {
    return Promise.resolve(app.fetch(request, environment(esaBindings(bindings ?? {}), 'esa')));
  },
};
