import 'dotenv/config';

import { defineConfig } from '@playwright/test';

process.env.E2E_BASE_URL ??= 'http://localhost:5173';
process.env.E2E_EMAIL ??= process.env.ADMIN_EMAIL ?? 'formsatz@gmail.com';
// Fixture password only — shadowing ADMIN_PASSWORD broke specs after reset.
process.env.E2E_PASSWORD ??= 'password';

export default defineConfig({
  testDir: '.',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  retries: 0,
  fullyParallel: false,
  use: {
    baseURL: process.env.E2E_BASE_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'mobile',
      use: {
        viewport: { width: 375, height: 667 },
        isMobile: true,
        hasTouch: true,
      },
    },
    {
      name: 'desktop',
      use: {
        viewport: { width: 1280, height: 800 },
      },
    },
  ],
});
