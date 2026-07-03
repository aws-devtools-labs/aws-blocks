// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { startSandbox, destroySandbox } from '@aws-blocks/blocks/scripts';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const backendPath = join(__dirname, '..', 'index.cdk.ts');

// Pre-cleanup: destroy any stale sandbox left by a previous failed run.
try {
  await destroySandbox(backendPath);
} catch {
  // No stale sandbox — continue.
}

await startSandbox({ backendPath, deployOnly: true });
