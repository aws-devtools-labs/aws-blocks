// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { DEPLOY_TIMEOUT_MS, runSandboxScript } from '../../../test/sandbox-lifecycle.js';
import { record } from '../timing.js';

// Same shape as test/global-setup.ts, with a stand-in deploy script (never AWS).
export default async function globalSetup(): Promise<void> {
  record('deploy');
  await runSandboxScript(new URL('./stub-deploy.ts', import.meta.url).pathname, DEPLOY_TIMEOUT_MS);
}
