// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { join } from 'node:path';
import { DESTROY_TIMEOUT_MS, isSandboxRun, projectRoot, runSandboxScript } from './sandbox-lifecycle.js';

/**
 * Playwright `globalTeardown`: destroy the sandbox once, after every test and
 * retry has finished. Runs even when `globalSetup` (the deploy) threw. Set
 * `BLOCKS_SANDBOX_KEEP=1` to leave the stack up for debugging.
 */
export default async function globalTeardown(): Promise<void> {
  if (!isSandboxRun() || process.env.BLOCKS_SANDBOX_KEEP) return;
  console.log('\n🗑️  Destroying sandbox...');
  await runSandboxScript(join(projectRoot, 'test', 'sandbox-destroy.ts'), DESTROY_TIMEOUT_MS);
}
