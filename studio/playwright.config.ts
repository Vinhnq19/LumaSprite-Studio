import { defineConfig } from '@playwright/test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
export default defineConfig({ testDir: './e2e', testIgnore: '**/rig-approved-art.spec.ts', timeout: 45000, workers: 1, reporter: 'list', outputDir: join(tmpdir(), 'pxl-studio-playwright-results'),
  use: { baseURL: 'http://127.0.0.1:4329', browserName: 'chromium', channel: 'chrome', headless: true, viewport: { width: 1440, height: 960 }, screenshot: 'off', video: 'off', trace: 'off' },
  webServer: { command: 'node --experimental-strip-types --disable-warning=ExperimentalWarning studio/test-server.ts', cwd: fileURLToPath(new URL('../', import.meta.url)), url: 'http://127.0.0.1:4329', reuseExistingServer: false, timeout: 15000, gracefulShutdown: { signal: 'SIGTERM', timeout: 10000 } },
});
