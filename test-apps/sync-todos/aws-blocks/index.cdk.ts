// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as cdk from 'aws-cdk-lib';
import { BlocksPresets, BlocksStack } from '@aws-blocks/blocks/cdk';
import { getStackName } from '@aws-blocks/blocks/scripts';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = new cdk.App();

const sandboxMode = app.node.tryGetContext('sandboxMode') === 'true';
const projectRoot = app.node.tryGetContext('projectRoot') || process.cwd();

export const blocksStack = await BlocksStack.create(app, getStackName({ sandbox: sandboxMode, projectRoot }), {
  backendHandlerPath: join(__dirname, 'index.handler.ts'),
  backendCDKPath: join(__dirname, 'index.ts'),
  // Disposable sample stack: always the sandbox posture (DESTROY, no deletion protection).
  defaults: BlocksPresets.sandbox,
});

// The backend picks its engine from this variable at synth and at runtime.
blocksStack.handler.addEnvironment('SYNC_TODOS_ENGINE', process.env.SYNC_TODOS_ENGINE === 'dsql' ? 'dsql' : 'aurora');

if (sandboxMode) {
  // The local frontend and the API Gateway API are on different sites.
  blocksStack.handler.addEnvironment('BLOCKS_SANDBOX', 'true');
}

cdk.Tags.of(blocksStack).add('blocks:purpose', 'sample-sync-todos');
