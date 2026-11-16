import { connect } from 'cloudflare:sockets';
import { createApp } from '../app';
import type { Bindings } from '../core/types';
import { setTcpConnect } from '../net/tcp';
import { storage as createStorage } from '../core/database';
import { executeCertificateIssuance } from '../schedule/acme';
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

function resolvedBindings(bindings: Bindings): Bindings {
  return {
    ...bindings,
    BLOB_ADAPTER: bindings.BLOB_ADAPTER ?? (bindings.BUCKET ? createCloudflareR2Adapter(bindings.BUCKET) : undefined),
  };
}

export default {
  fetch(request: Request, bindings: Bindings): Promise<Response> {
    return Promise.resolve(app.fetch(request, environment(resolvedBindings(bindings), 'cloudflare')));
  },
  /**
   * Cron Trigger 只推进已由用户启动的 ACME 签发任务：
   * 单次请求时间有限，需要等待 DNS 生效或 CA 验证的步骤交给下一次触发继续。
   */
  async scheduled(_controller: unknown, bindings: Bindings): Promise<void> {
    try {
      const env = environment(resolvedBindings(bindings), 'cloudflare');
      if (env.DB_FORMAT !== 'sql') return;
      await executeCertificateIssuance(env, createStorage(env).db);
    } catch (error) {
      console.error(JSON.stringify({ event: 'scheduled_failed', kind: error instanceof Error ? error.name : 'unknown' }));
    }
  },
};
