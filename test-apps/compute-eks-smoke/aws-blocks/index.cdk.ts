// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as cdk from 'aws-cdk-lib';
import { RemovalPolicies, Mixins } from 'aws-cdk-lib';
import { BlocksStack, SandboxDisableDeletionProtection } from '@aws-blocks/blocks/cdk';
import { EksCompute } from '@aws-blocks/compute-eks';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { getSandboxId } from './scripts/sandbox-id.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = new cdk.App();

const sandboxMode = app.node.tryGetContext('sandboxMode') === 'true';
const projectRoot = app.node.tryGetContext('projectRoot') || process.cwd();
const id = getSandboxId(projectRoot);

const stackName = sandboxMode ? `bb-eks-smoke-${id}` : `bb-eks-smoke-prod-${id}`;

export const blocksStack = await BlocksStack.create(app, stackName, {
  backendHandlerPath: join(__dirname, 'index.handler.ts'),
  backendCDKPath: join(__dirname, 'index.ts'),
  // The one-line change that moves this backend to EKS Auto Mode.
  compute: new EksCompute(),
});

// Smoke stacks must be fully deletable regardless of deploy mode.
RemovalPolicies.of(blocksStack).destroy();
Mixins.of(blocksStack).apply(new SandboxDisableDeletionProtection());

cdk.Tags.of(blocksStack).add('blocks:purpose', 'compute-smoke-test');
