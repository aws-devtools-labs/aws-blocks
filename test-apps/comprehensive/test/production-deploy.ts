// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Deploys without sandboxMode context — exercises the production GSI path
// (sequential UpdateTable instead of sandbox drop-and-recreate).
import { deploy, destroy } from '@aws-blocks/blocks/scripts';

const backendPath = process.argv[2];

// Destroy any stale stack left by a previous failed run so we always
// exercise a full fresh deploy.
console.log('🧹 Destroying stale stack (if any)...');
try {
  // force: a local run in a terminal must not wait on the multi-stack confirmation.
  await destroy({ cdkAppPath: backendPath, projectRoot: process.cwd(), force: true });
  console.log('   Stale stack destroyed.');
} catch {
  console.log('   No stale stack found.');
}

console.log('\n🚀 Deploying (production mode — no sandboxMode context)...');
console.log('   (GSIs will be created sequentially via UpdateTable)\n');

await deploy({ cdkAppPath: backendPath, projectRoot: process.cwd() });
