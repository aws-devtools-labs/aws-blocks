// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// The hosting apps' pattern: deploy in globalSetup, destroy in globalTeardown.
import { defineConfig } from '@playwright/test';
import { TEST_TIMEOUT_MS } from '../timing.js';

export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  globalSetup: './global-setup.ts',
  globalTeardown: './global-teardown.ts',
  timeout: TEST_TIMEOUT_MS,
  retries: 1,
  workers: 1,
  reporter: 'list',
});
