// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Sandbox teardown for CI (native-sdk-e2e.yml), the counterpart of
// deploy-sandbox.ts: destroySandbox re-synthesizes with the `sandboxMode` CDK
// context, so sandbox-only constructs synth the same way they did at deploy
// time. Run from test-apps/native-bindings (destroySandbox uses process.cwd()).
// The stack name still comes from BLOCKS_STACK_NAME / BLOCKS_STACK_SUFFIX in
// index.cdk.ts.

import { destroySandbox } from '@aws-blocks/blocks/scripts';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

destroySandbox(join(__dirname, '..', 'index.cdk.ts')).catch((error) => {
  console.error(error);
  process.exit(1);
});
