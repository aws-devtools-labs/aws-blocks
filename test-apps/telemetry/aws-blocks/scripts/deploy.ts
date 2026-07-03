// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { deploy, destroy } from '@aws-blocks/blocks/scripts';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cdkAppPath = join(__dirname, '..', 'index.cdk.ts');
const projectRoot = join(__dirname, '..', '..');

// Pre-cleanup: destroy any stale stack left by a previous failed run.
try {
  await destroy({ cdkAppPath, projectRoot });
} catch {
  // No stale stack — continue.
}

deploy({ cdkAppPath, projectRoot }).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
