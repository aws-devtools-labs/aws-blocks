// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Helper scripts for running sandbox operations in a clean subprocess.
// Used by e2e tests to avoid browser condition pollution.
import { startSandbox, destroySandbox } from 'aws-cdk-blocks/scripts';

const backendPath = process.argv[2];

// Pre-cleanup: destroy any stale sandbox left by a previous failed run.
// Skip if BLOCKS_SANDBOX_KEEP is set (reuse existing stack for faster iteration).
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
