/**
 * Playwright configuration.
 *
 * Runs against a real build served by `next start`, not `next dev`. The two differ in
 * ways that matter here — server-component caching, error boundaries, and the
 * production React build — and the thing being tested is what a user will actually be
 * served.
 *
 * `E2E_BASE_URL` lets the suite point at an already-running instance; otherwise
 * Playwright builds and starts one.
 */

import { defineConfig } from '@playwright/test';

const PORT = Number(process.env.E2E_PORT ?? 3210);
const baseURL = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${String(PORT)}`;

export default defineConfig({
  testDir: './e2e',
  // Sequential: the suite shares one database and one seeded user, and a parallel run
  // would have tests logging each other out.
  workers: 1,
  fullyParallel: false,
  reporter: [['list']],
  timeout: 30_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL,
    trace: 'retain-on-failure',
  },
  ...(process.env.E2E_BASE_URL === undefined
    ? {
        webServer: {
          command: `node ./node_modules/next/dist/bin/next start -p ${String(PORT)}`,
          url: baseURL,
          reuseExistingServer: true,
          timeout: 120_000,
        },
      }
    : {}),
});
