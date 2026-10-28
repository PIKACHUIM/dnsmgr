import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  use: { baseURL: 'http://127.0.0.1:8789', channel: 'chrome', headless: true },
  webServer: {
    command: 'npm run build:frontend && node scripts/dev.mjs',
    url: 'http://127.0.0.1:8789/health',
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      PORT: '8789', LOCAL_EPHEMERAL: '1',
      APP_KEY: 'MTIzNDU2Nzg5MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTI=',
      SETUP_TOKEN: 'local-browser-test-setup-token-2026',
    },
  },
});
