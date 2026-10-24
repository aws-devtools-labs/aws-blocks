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

// The suite's variant axis: each CI leg deploys this same app with
// COMPUTE_API_FRONT_DOOR set (as E2E Hosting does with HOSTING_COMPUTE_TYPE); the
// legs that run are the `e2e-compute-smoke` matrix in pr-checks.yml (today:
// cloudfront only). Each test module declares the legs it applies to.
const FRONT_DOORS = ['apigateway', 'cloudfront'] as const;
const apiFrontDoor = (process.env.COMPUTE_API_FRONT_DOOR ?? 'cloudfront') as (typeof FRONT_DOORS)[number];
if (!FRONT_DOORS.includes(apiFrontDoor)) {
  throw new Error(`COMPUTE_API_FRONT_DOOR must be one of ${FRONT_DOORS.join(', ')}; got '${apiFrontDoor}'.`);
}

// Each leg gets its own stack name, but every leg provisions the same private-DNS
// endpoints into the one compute test VPC (see `provisionEndpoints` below), so
// deploy one leg at a time per VPC. `bb-test-` keeps the stacks inside the
// scheduled CI cleanup's sweep (cleanup-stacks.yml) and the CI role's E2E
// prefixes. Keep the name short: resource names derive from it, and in sandbox
// mode the FileBucket's must fit S3's 63 characters with a CI suffix like
// `compute-1234-12` (61).
const leg = { apigateway: 'gw', cloudfront: 'cf' }[apiFrontDoor];
const stackName = sandboxMode
  ? `bb-test-compute-${id}-${leg}${suffix ? `-${suffix}` : ''}`
  : `bb-test-compute-prod-${leg}-${suffix || 'default'}-${id}`;

const vpcId = app.node.tryGetContext('vpcId') || process.env.VPC_TEST_VPC_ID;

if (!vpcId) {
  throw new Error(
    'Missing VPC ID. Set the VPC_TEST_VPC_ID env var or pass -c vpcId=vpc-xxx.\n' +
    'Deploy the persistent test VPC first: cd test-infra && npx cdk deploy BlocksComputeTestVpc',
  );
}

const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION || 'us-east-1' };
const vpcRefStack = new cdk.Stack(app, `${stackName}-vpc-ref`, { env });

export const blocksStack = await BlocksStack.create(app, stackName, {
  backendHandlerPath: join(__dirname, 'index.handler.ts'),
  backendCDKPath: join(__dirname, 'index.ts'),
  apiFrontDoor,
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
      network: ec2.Vpc.fromLookup(vpcRefStack, 'Vpc', { vpcId }),
      // Provision endpoints into THIS per-PR stack. Concurrency is serialized at
      // the CI job level (group: blocks-test-compute) because AWS permits only
      // one private-DNS interface endpoint per service per VPC — and this suite
      // uses its own persistent VPC (BlocksComputeTestVpc), separate from the
      // VPC smoke suite's, so the two don't contend.
      provisionEndpoints: true,
    },
  },
});

for (const stack of [blocksStack, vpcRefStack]) cdk.Tags.of(stack).add('blocks:purpose', 'compute-smoke-e2e');
cdk.Tags.of(blocksStack).add('blocks:api-front-door', apiFrontDoor);
cdk.Tags.of(blocksStack).add('blocks:deploy-mode', sandboxMode ? 'sandbox' : 'production');
