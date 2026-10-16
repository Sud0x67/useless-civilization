import { defineConfig, devices } from '@playwright/test';
const port = process.env.TEST_PORT || '4180';
const baseURL = `http://127.0.0.1:${port}`;
export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: true,
  workers: process.env.CI ? 2 : 3,
  timeout: process.env.CI ? 60000 : 30000,
  use: { baseURL, trace: 'retain-on-failure', reducedMotion: 'reduce' },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 } },
    },
    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'], viewport: { width: 1366, height: 900 } },
    },
    { name: 'mobile', use: { ...devices['iPhone 13'] } },
  ],
  webServer: {
    command: 'npm run dev',
    url: baseURL,
    env: { PORT: port, LOCAL_PREVIEW: '1' },
    reuseExistingServer: !process.env.CI,
    timeout: 30000,
  },
});
