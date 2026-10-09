// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { startSandbox, destroySandbox } from '@aws-blocks/blocks/scripts';

const backendPath = process.argv[2];

if (!process.env.BLOCKS_SANDBOX_KEEP) {
  console.log('🧹 Destroying stale sandbox (if any)...');
  try {
    await destroySandbox(backendPath);
  } catch {
    console.log('   No stale sandbox found.');
  }
} else {
  console.log('♻️  BLOCKS_SANDBOX_KEEP set — skipping pre-destroy, reusing existing stack.');
}

await startSandbox({ backendPath, deployOnly: true });
