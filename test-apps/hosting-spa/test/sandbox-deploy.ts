// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { startSandbox, destroySandbox } from '@aws-blocks/blocks/scripts';
import { waitForHostingReady } from '../../../scripts/ci/hosting-ready.js';

const backendPath = process.argv[2];
if (!backendPath) {
  console.error('Usage: tsx test/sandbox-deploy.ts <backendPath>');
  process.exit(1);
}

// Pre-cleanup: destroy any stale sandbox from previous runs
try {
  await destroySandbox(backendPath);
} catch {
  // Expected — no previous stack to clean up
}

let hostingUrl: string | undefined;
await startSandbox({
  backendPath,
  deployOnly: true,
  onDeployed: (deployed) => { hostingUrl = deployed.hostingUrl; },
});

// The deploy returns before the site serves the app; hold the suite until it
// does (see scripts/ci/hosting-ready.ts).
await waitForHostingReady(hostingUrl);
