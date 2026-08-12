// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { RemovalPolicies, Mixins } from 'aws-cdk-lib';
import { BlocksStack, SandboxDisableDeletionProtection, BlocksPresets } from '@aws-blocks/blocks/cdk';
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
  ? `bb-vpc-smoke-${id}${suffix ? `-${suffix}` : ''}`
  : `bb-vpc-smoke-prod-${suffix || 'default'}-${id}`;

const vpcId = app.node.tryGetContext('vpcId') || process.env.VPC_TEST_VPC_ID;

if (!vpcId) {
  throw new Error(
    'Missing VPC ID. Set the VPC_TEST_VPC_ID env var or pass -c vpcId=vpc-xxx.\n' +
    'Deploy the persistent test VPC first: cd test-infra && npx cdk deploy',
  );
}

// fromLookup needs a Stack scope. We use the BlocksStack itself by creating
// it without VPC first, then looking up the VPC inside it.
// NOTE: BlocksStack.create() returns the stack — we pass VPC separately.
const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION || 'us-east-1' };

export const blocksStack = await BlocksStack.create(app, stackName, {
  backendHandlerPath: join(__dirname, 'index.handler.ts'),
  backendCDKPath: join(__dirname, 'index.ts'),
  defaults: BlocksPresets.sandbox,
  vpc: {
    // Use fromLookup with the stack's own env — CDK will resolve it at synth.
    // This works because BlocksStack IS a Stack, satisfying CDK's scope requirement.
    network: ec2.Vpc.fromLookup(new cdk.Stack(app, `${stackName}-vpc-ref`, { env }), 'Vpc', { vpcId }),
    provisionEndpoints: false,
  },
});

// Make the vpc-ref stack depend on nothing and have no resources — it's just
// a context lookup container. Tag it for cleanup.
const refStack = app.node.findChild(`${stackName}-vpc-ref`) as cdk.Stack;
RemovalPolicies.of(refStack).destroy();

RemovalPolicies.of(blocksStack).destroy();
Mixins.of(blocksStack).apply(new SandboxDisableDeletionProtection());

cdk.Tags.of(blocksStack).add('blocks:purpose', 'vpc-smoke-e2e');
cdk.Tags.of(blocksStack).add('blocks:deploy-mode', sandboxMode ? 'sandbox' : 'production');
