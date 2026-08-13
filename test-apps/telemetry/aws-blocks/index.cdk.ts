// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as cdk from 'aws-cdk-lib';
import { RemovalPolicies, Mixins } from 'aws-cdk-lib';
import { BlocksStack, SandboxDisableDeletionProtection } from '@aws-blocks/blocks/cdk';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

function getSandboxId(projectRoot: string): string {
  const dir = join(projectRoot, '.blocks-sandbox');
  const file = join(dir, 'sandbox-id.txt');
  if (existsSync(file)) return readFileSync(file, 'utf-8').trim();
  mkdirSync(dir, { recursive: true });
  const id = randomUUID().slice(0, 8);
  writeFileSync(file, id);
  return id;
}

const app = new cdk.App();
const sandboxMode = app.node.tryGetContext('sandboxMode') === 'true';
const projectRoot = app.node.tryGetContext('projectRoot') || process.cwd();
const id = getSandboxId(projectRoot);
const suffix = process.env.BLOCKS_STACK_SUFFIX;

const stackName = sandboxMode
  ? `bb-telemetry-e2e-${id}${suffix ? `-${suffix}` : ''}`
  : `bb-telemetry-e2e-prod-${suffix || 'default'}-${id}`;

export const blocksStack = await BlocksStack.create(app, stackName, {
  backendHandlerPath: join(__dirname, 'index.ts'),
  backendCDKPath: join(__dirname, 'index.ts'),
});

RemovalPolicies.of(blocksStack).destroy();
Mixins.of(blocksStack).apply(new SandboxDisableDeletionProtection());

cdk.Tags.of(blocksStack).add('blocks:purpose', 'telemetry-e2e');
cdk.Tags.of(blocksStack).add('blocks:deploy-mode', sandboxMode ? 'sandbox' : 'production');
