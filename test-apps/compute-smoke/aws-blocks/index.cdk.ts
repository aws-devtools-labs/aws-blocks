// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
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

const stackName = sandboxMode
  ? `bb-compute-smoke-${id}${suffix ? `-${suffix}` : ''}`
  : `bb-compute-smoke-prod-${suffix || 'default'}-${id}`;

const vpcId = app.node.tryGetContext('vpcId') || process.env.VPC_TEST_VPC_ID;

if (!vpcId) {
  throw new Error(
    'Missing VPC ID. Set the VPC_TEST_VPC_ID env var or pass -c vpcId=vpc-xxx.\n' +
    'Deploy the persistent test VPC first: cd test-infra && npx cdk deploy BlocksComputeTestVpc BlocksComputeTestVpcEndpoints',
  );
}

const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION || 'us-east-1' };

export const blocksStack = await BlocksStack.create(app, stackName, {
  backendHandlerPath: join(__dirname, 'index.handler.ts'),
  backendCDKPath: join(__dirname, 'index.ts'),
  defaults: {
    ...BlocksPresets.sandbox,
    vpc: {
      // Vpc.fromLookup needs a Stack scope to cache the context lookup, and it
      // must resolve BEFORE this BlocksStack is built (BlocksStack.create wires
      // VPC placement during construction). Host the lookup in a throwaway
      // sibling stack; fromLookup resolves to concrete subnet/AZ/route-table
      // attributes at synth, so the resulting IVpc is safely usable from this
      // stack (including for the finalizeVpc gateway endpoints, which need route
      // tables). The container compute reuses this injected VPC rather than
      // deriving its own — so the app adds zero new VPCs per run.
      network: ec2.Vpc.fromLookup(new cdk.Stack(app, `${stackName}-vpc-ref`, { env }), 'Vpc', { vpcId }),
      // BlocksComputeTestVpc has permanent S3, DynamoDB, SQS and Logs endpoints
      // (test-infra/vpc-test-stack.ts), so by default this stack adds none and
      // any number of runs share the VPC. AWS permits only one private-DNS
      // interface endpoint per service per VPC, so a stack adding its own there
      // would fail. COMPUTE_SMOKE_PROVISION_ENDPOINTS=true makes the framework
      // provision them in this stack instead; the E2E Compute Endpoints workflow
      // does that in the endpoint-free BlocksTestVpc, one run at a time.
      provisionEndpoints: process.env.COMPUTE_SMOKE_PROVISION_ENDPOINTS === 'true',
    },
  },
});

cdk.Tags.of(blocksStack).add('blocks:purpose', 'compute-smoke-e2e');
cdk.Tags.of(blocksStack).add('blocks:deploy-mode', sandboxMode ? 'sandbox' : 'production');
