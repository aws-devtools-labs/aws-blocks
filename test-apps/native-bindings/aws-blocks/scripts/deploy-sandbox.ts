// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
//
// One-shot sandbox deploy for CI (native-sdk-e2e.yml): deploys the stack with
// the `sandboxMode` CDK context, writes .blocks-sandbox/config.json (apiUrl),
// then exits instead of entering `cdk watch`. Run from test-apps/native-bindings
// (startSandbox uses process.cwd() as projectRoot). The stack name still comes
// from BLOCKS_STACK_NAME / BLOCKS_STACK_SUFFIX in index.cdk.ts.

import { startSandbox } from '@aws-blocks/blocks/scripts';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

startSandbox({
  backendPath: join(__dirname, '..', 'index.cdk.ts'),
  deployOnly: true,
}).catch((error) => {
  console.error(error);
  process.exit(1);
});
