// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './test',
  testMatch: '**/*.test.ts',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  // Warmup requests in the test suite handle Lambda cold starts (the actual
  // root cause of flakiness). One retry covers transient network blips
  // through CloudFront/APIGW; a second retry would mask residual
  // non-determinism we'd rather see fail loudly.
  retries: 1,
  reporter: 'list',
  use: {
    baseURL: process.env.HOSTING_URL,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
