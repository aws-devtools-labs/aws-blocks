// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { startSandbox, destroySandbox } from '@aws-blocks/blocks/scripts';

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

// `preview: true`: a preview sandbox (sets the previewMode context, which adds
// Hosting with HostingPresets.preview); a re-deploy hotswaps code changes.
await startSandbox({ backendPath, deployOnly: true, preview: true });
