import { defineConfig, devices } from '@playwright/test';
import { join } from 'node:path';

const PORT = 8123;
const fixtures = join(import.meta.dirname, 'tests', '.fixtures');

export default defineConfig({
  testDir: 'tests/e2e',
  globalSetup: './tests/e2e/global-setup.mjs',
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  reporter: [['list']],
  use: {
    ...devices['Pixel 7'],
    baseURL: `http://localhost:${PORT}/`,
    serviceWorkers: 'block',
    permissions: ['camera'],
    launchOptions: {
      args: [
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        `--use-file-for-fake-video-capture=${join(fixtures, 'badge-vcard.y4m')}`,
      ],
    },
  },
  webServer: {
    command: 'node scripts/serve.mjs',
    env: { PORT: String(PORT) },
    url: `http://localhost:${PORT}/`,
    reuseExistingServer: !process.env.CI,
  },
});
