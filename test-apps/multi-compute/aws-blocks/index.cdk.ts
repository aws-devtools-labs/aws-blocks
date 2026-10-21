// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as cdk from 'aws-cdk-lib';
import { BlocksStack, BlocksPresets } from '@aws-blocks/blocks/cdk';
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

// `bb-test-` keeps the stack inside the scheduled CI cleanup's sweep.
const stackName = sandboxMode
  ? `bb-test-multi-compute-${id}${suffix ? `-${suffix}` : ''}`
  : `bb-test-multi-compute-prod-${suffix || 'default'}-${id}`;

export const blocksStack = await BlocksStack.create(app, stackName, {
  backendHandlerPath: join(__dirname, 'index.handler.ts'),
  backendCDKPath: join(__dirname, 'index.ts'),
  // Disposable test stack: the sandbox preset (DESTROY, no deletion protection).
  defaults: BlocksPresets.sandbox,
  // The managed CloudFront front door. (The default `apigateway` tier is
  // covered by the comprehensive suite, and Hosting's distribution by hosting-spa.)
  apiFrontDoor: 'cloudfront',
});

cdk.Tags.of(blocksStack).add('blocks:purpose', 'e2e-multi-compute');
cdk.Tags.of(blocksStack).add('blocks:deploy-mode', sandboxMode ? 'sandbox' : 'production');
cdk.Tags.of(blocksStack).add('blocks:created-at', new Date().toISOString().split('T')[0]);
