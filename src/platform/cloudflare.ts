import { connect } from 'cloudflare:sockets';
import { createApp } from '../app';
import type { Bindings } from '../core/types';
import { setTcpConnect } from '../net/tcp';
import { createCloudflareR2Adapter } from './storage/cloudflare';
import { environment } from './runtime';

setTcpConnect(async (hostname, port) => {
  const socket = connect({ hostname, port });
  try {
    await socket.opened;
  } finally {
    try { await socket.close(); } catch { /* socket may already be closed */ }
  }
});

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
