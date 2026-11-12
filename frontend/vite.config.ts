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
const dependency = (path: string) => fileURLToPath(new URL(`../node_modules/${path}`, import.meta.url));
const canonicalPath = (id: string): string | null => (/^[a-zA-Z]:[\\/]/.test(id) ? `${id[0]!.toUpperCase()}${id.slice(1).replaceAll('\\', '/')}` : null);

// Windows 下 Vite 根路径与 CommonJS 解析可能分别返回 D:/ 与 d:/ 的模块 ID，
// 导致 React 被打包两份并在运行时出现 hooks dispatcher 为 null。
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [{
    name: 'canonical-module-path',
    enforce: 'pre',
    resolveId(id) {
      const canonical = canonicalPath(id);
      return canonical && canonical !== id ? canonical : undefined;
    },
  }],
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: [
      { find: /^react$/, replacement: dependency('react/index.js') },
      { find: /^react\/jsx-runtime$/, replacement: dependency('react/jsx-runtime.js') },
      { find: /^react-dom$/, replacement: dependency('react-dom/index.js') },
      { find: /^react-dom\/client$/, replacement: dependency('react-dom/client.js') },
    ],
  },
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
