// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from 'node:child_process';

/** Destroy the sandbox after a sandbox run, unless BLOCKS_SANDBOX_KEEP is set. */
export default function teardown(): void {
  if (process.env.BLOCKS_SANDBOX_KEEP) return;
  execFileSync('npm', ['run', 'sandbox:destroy'], { stdio: 'inherit', env: { ...process.env, NODE_OPTIONS: '' } });
}
