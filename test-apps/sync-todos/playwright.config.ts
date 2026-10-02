// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { defineConfig, devices } from '@playwright/test';

// local:   `npm run dev` — PGlite + the in-process shape emulator.
// sandbox: `npm run sandbox` — deploys Aurora + Electric, then serves the
//          frontend locally with API calls proxied to AWS. The first deploy
//          takes ~15 minutes (Aurora cluster + Fargate service).
const sandbox = process.env.BLOCKS_TEST_ENV === 'sandbox';

export default defineConfig({
  testDir: './test',
  testMatch: '**/*.test.ts',
  timeout: sandbox ? 180_000 : 60_000,
  expect: { timeout: sandbox ? 60_000 : 10_000 },
  retries: 0,
  workers: 1,
  reporter: 'list',
  globalTeardown: sandbox ? './test/sandbox-teardown.ts' : undefined,
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: sandbox ? 'npm run sandbox' : 'npm run dev',
    url: 'http://localhost:3000',
    reuseExistingServer: true,
    timeout: sandbox ? 30 * 60_000 : 120_000,
    stdout: 'pipe',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
