import path from 'node:path';

import { defineConfig } from '@playwright/test';

const port = Number(process.env.FINANCE_COMPANION_E2E_PORT) || 4174;
const externalStartUrl = process.env.FINANCE_COMPANION_E2E_START_URL;
const baseURL = externalStartUrl ?? `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  retries: 0,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL,
    browserName: 'chromium',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer:
    externalStartUrl === undefined
      ? {
          cwd: path.resolve(import.meta.dirname, '..', '..'),
          command: `yarn workspace @actual-app/finance-companion build && yarn workspace @actual-app/finance-companion exec vite preview . --outDir dist/ui --host 127.0.0.1 --port ${port} --strictPort`,
          url: baseURL,
          reuseExistingServer: false,
          timeout: 120_000,
        }
      : undefined,
});
