// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { basename, join } from 'node:path';
import { DEPLOY_TIMEOUT_MS, isSandboxRun, projectRoot, runSandboxScript } from './sandbox-lifecycle.js';

/**
 * Playwright `globalSetup`: deploy the sandbox once per run (sandbox mode only).
 * The deployed stack's outputs land in `.blocks-sandbox/outputs.json`, which the
 * spec's `beforeAll` reads. See `sandbox-lifecycle.ts` for why this is not a hook.
 */
export default async function globalSetup(): Promise<void> {
  if (!isSandboxRun()) return;
  console.log(`🚀 Deploying ${basename(projectRoot)} sandbox...\n`);
  await runSandboxScript(join(projectRoot, 'test', 'sandbox-deploy.ts'), DEPLOY_TIMEOUT_MS);
}
