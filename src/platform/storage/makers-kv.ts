import type { KvBinding } from '../../storage/objects.js';

export interface MakersKvBridgeOptions {
  url: string;
  token: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const maxValueBytes = 4_000_000;

function bridgeBase(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Invalid Makers KV bridge URL');
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    throw new Error('Makers KV bridge requires HTTPS');
  }
  if (url.username || url.password || url.search || url.hash) throw new Error('Invalid Makers KV bridge URL');
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

export function createMakersKvBridge(options: MakersKvBridgeOptions): KvBinding {
  if (options.token.length < 32) throw new Error('Makers KV bridge token must be at least 32 characters');
  const base = bridgeBase(options.url);
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new Error('Invalid Makers KV bridge timeout');

  async function call(path: string, init: RequestInit): Promise<Response> {
    let response: Response;
    try {
      response = await fetchImpl(`${base}${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${options.token}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new Error('Makers KV bridge is unavailable');
    }
    if (!response.ok) throw new Error(`Makers KV bridge request failed (${response.status})`);
    return response;
  }

  return {
    async get(key) {
      const response = await call(`/get?key=${encodeURIComponent(key)}`, { method: 'GET' });
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new Error('Makers KV bridge returned invalid JSON');
      }
      if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new Error('Makers KV bridge returned invalid payload');
      }
      const value = (payload as { value?: unknown }).value;
      if (value === null || value === undefined) return null;
      if (typeof value !== 'string') throw new Error('Makers KV bridge returned invalid value');
      return value;
    },
    async put(key, value) {
      if (new TextEncoder().encode(value).byteLength > maxValueBytes) {
        throw new Error('Makers KV value exceeds the bridge limit');
      }
      await call('/put', { method: 'PUT', body: JSON.stringify({ key, value }) });
    },
  };
}
