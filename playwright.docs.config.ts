import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/docs-e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  use: { baseURL: 'http://127.0.0.1:5199', channel: 'chrome', headless: true },
  webServer: {
    command: 'npm run docs:build && npm run docs:verify && npm run docs:preview -- --host 127.0.0.1 --port 5199 --strictPort',
    url: 'http://127.0.0.1:5199/',
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
