// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './test',
  testMatch: '**/*.test.ts',
  // Sandbox runs deploy the stack once in globalSetup and destroy it once in
  // globalTeardown — never in a test hook, which would run under the test
  // timeout below and again on every retry. See test/sandbox-lifecycle.ts.
  globalSetup: './test/global-setup.ts',
  globalTeardown: './test/global-teardown.ts',
  // After the sandbox deploy, globalSetup waits until the hosting URL answers
  // 200 with this in the page (the app's status line), as the deploy can finish
  // before CloudFront serves the app.
  metadata: { servingMarker: 'id="app-status"' },
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
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
