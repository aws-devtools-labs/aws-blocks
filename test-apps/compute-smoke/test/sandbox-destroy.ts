// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Destroy every stack the compute-smoke app synthesizes for the leg selected by
 * `COMPUTE_API_FRONT_DOOR` (default cloudfront): the main stack and its vpc-ref
 * lookup stack. Uses `cdk destroy --all` to ensure complete cleanup. Run it once
 * per leg you deployed.
 */
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cwd = join(__dirname, '..');
const backendPath = process.argv[2];

execFileSync('npx', [
  'cdk', 'destroy', '--all', '--force',
  '--context', 'sandboxMode=true',
  '--context', `projectRoot=${cwd}`,
  '--app', `npx tsx -C cdk ${backendPath}`,
], { cwd, stdio: 'inherit', env: { ...process.env, NODE_OPTIONS: '' } });
