import { createApp } from '../app';
import type { Bindings } from '../core/types';
import { createCloudflareR2Adapter } from './storage/cloudflare';
import { environment } from './runtime';

const app = createApp();

export default {
  fetch(request: Request, bindings: Bindings): Promise<Response> {
    const runtimeBindings = {
      ...bindings,
      BLOB_ADAPTER: bindings.BLOB_ADAPTER ?? (bindings.BUCKET ? createCloudflareR2Adapter(bindings.BUCKET) : undefined),
    };
    return Promise.resolve(app.fetch(request, environment(runtimeBindings, 'cloudflare')));
  },
};
