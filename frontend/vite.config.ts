import { fileURLToPath } from 'node:url';
import { defineConfig, type ProxyOptions } from 'vite';

const target = 'http://127.0.0.1:8787';
const backendProxy: ProxyOptions = {
  target,
  changeOrigin: false,
  configure(proxy) {
    proxy.on('proxyReq', (outgoing, incoming) => {
      if (incoming.headers.origin === 'http://127.0.0.1:5173') outgoing.setHeader('Origin', target);
    });
  },
};
const legacyPaths = '^/(install|login|logout|auth|totp|domain|record|account|dmonitor|schedule|cert|optimizeip|system|user|log|setpwd)(/|$)';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  build: {
    outDir: '../dist/frontend',
    assetsDir: 'assets',
    emptyOutDir: false,
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': backendProxy,
      [legacyPaths]: {
        ...backendProxy,
        bypass(request) {
          if (request.method === 'GET' && request.headers.accept?.includes('text/html')) {
            return '/index.html';
          }
        },
      },
    },
  },
});
