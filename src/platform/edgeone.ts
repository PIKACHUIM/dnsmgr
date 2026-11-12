import { getStore } from '@edgeone/pages-blob';
import { createApp } from '../app';
import type { Bindings } from '../core/types';
import { createEdgeOneBlobAdapter } from './storage/edgeone';
import { createMakersKvBridge } from './storage/makers-kv';
import { environment } from './runtime';

export interface MakersContext {
  request: Request;
  clientIp?: string;
  env?: Bindings;
  params?: Record<string, string | string[]>;
}

export function clientIpFromMakersContext(context: MakersContext): string | undefined {
  const ip = context.clientIp?.trim();
  return ip && ip.length <= 128 && !/[\s,]/.test(ip) ? ip : undefined;
}

const app = createApp();

export function onRequest(context: MakersContext): Promise<Response> {
  const bindings = context.env ?? {};
  const bridgedKv = bindings.KV ?? (bindings.MAKERS_KV_BRIDGE_URL && bindings.MAKERS_KV_BRIDGE_TOKEN
    ? createMakersKvBridge({ url: bindings.MAKERS_KV_BRIDGE_URL, token: bindings.MAKERS_KV_BRIDGE_TOKEN })
    : undefined);
  const runtimeBindings = {
    ...bindings,
    CLIENT_IP: clientIpFromMakersContext(context),
    KV: bridgedKv,
    BLOB_ADAPTER: bindings.BLOB_ADAPTER ?? (bindings.BLOB_NAMESPACE ? createEdgeOneBlobAdapter(getStore(bindings.BLOB_NAMESPACE)) : undefined),
  };
  return Promise.resolve(app.fetch(context.request, environment(runtimeBindings, 'edgeone')));
}

export default onRequest;
