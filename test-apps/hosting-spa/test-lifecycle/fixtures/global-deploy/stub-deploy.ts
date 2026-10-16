// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Stand-in for test/sandbox-deploy.ts: blocks like a CloudFront deploy, touches no AWS.
import { execFileSync } from 'node:child_process';
import { DEPLOY_BLOCK_S } from '../timing.js';

execFileSync('sleep', [DEPLOY_BLOCK_S]);
if (process.env.LIFECYCLE_DEPLOY_FAILS) {
  console.error('stand-in deploy failed');
  process.exit(1);
}
