// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Destroy ALL stacks created by the vpc-smoke app (main + vpc-ref lookup stack).
 * Uses `cdk destroy --all` to ensure complete cleanup.
 */
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cwd = join(__dirname, '..');
const backendPath = process.argv[2];

// Destroy all stacks in the CDK app (handles both main + lookup stacks)
execFileSync('npx', [
  'cdk', 'destroy', '--all', '--force',
  '--context', 'sandboxMode=true',
  '--context', `projectRoot=${cwd}`,
  '--app', `npx tsx -C cdk ${backendPath}`,
], { cwd, stdio: 'inherit', env: { ...process.env, NODE_OPTIONS: '' } });
