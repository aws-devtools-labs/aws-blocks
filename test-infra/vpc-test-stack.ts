// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Persistent test VPC stacks.
 *
 * The VPC quota is 20 per region in the E2E accounts. Creation takes 2-3 min.
 * Deletion can fail (Lambda ENIs linger 10-20 min). These stacks are deployed
 * ONCE and NOT torn down between test runs. CI references each VPC ID via env
 * var or CDK context. The app is `vpc-test-app.ts`; this file only builds the
 * stacks, so they can be unit tested (`vpc-test-stack.test.ts`).
 *
 * Two VPCs, one per smoke suite:
 * - BlocksTestVpc         -> test-apps/vpc-smoke     (E2E VPC Smoke lane), and the
 *                           E2E Compute Endpoints workflow
 * - BlocksComputeTestVpc  -> test-apps/compute-smoke (E2E Compute Smoke lane)
 *
 * Resources (each VPC stack):
 * - VPC with 2 AZs, 1 NAT gateway, public/private/isolated subnets
 * - VPC ID output
 *
 * BlocksTestVpc has no endpoints: the apps that use it deploy with
 * `provisionEndpoints: true`, so the framework creates them in the app stack,
 * one app at a time per account (AWS permits only one private-DNS interface
 * endpoint per service per VPC). Today only the E2E Compute Endpoints workflow
 * does (group `blocks-test-vpc-endpoints-<n>`); E2E VPC Smoke has its own group
 * `blocks-test-vpc-<n>` and deploys nothing while its tests are off.
 *
 * BlocksComputeTestVpc gets permanent endpoints, in their own stack
 * (BlocksComputeTestVpcEndpoints), and compute-smoke deploys with
 * `provisionEndpoints: false`, so any number of Compute Smoke runs can share the
 * VPC without a lock. See `createComputeVpcEndpointsStack` for why the endpoints
 * live in a separate stack.
 */

import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';

export const TEST_VPC_STACK = 'BlocksTestVpc';
export const COMPUTE_TEST_VPC_STACK = 'BlocksComputeTestVpc';
export const COMPUTE_TEST_VPC_ENDPOINTS_STACK = 'BlocksComputeTestVpcEndpoints';

/**
 * The endpoints BlocksComputeTestVpc carries, by the last part of the service
 * name (`com.amazonaws.<region>.<name>`): what the framework would provision
 * for test-apps/compute-smoke with `provisionEndpoints: true` (S3 and CloudWatch
 * Logs always, DynamoDB for KVStore, SQS for AsyncJob). That app's template
 * test checks the two lists match, so a block added to the app that needs
 * another endpoint fails there instead of silently going through the NAT
 * gateway.
 */
export const COMPUTE_TEST_VPC_ENDPOINTS = {
  gateway: ['dynamodb', 's3'],
  interface: ['logs', 'sqs'],
} as const;

/**
 * The `<name>` of a synthesized endpoint's `ServiceName`
 * (`com.amazonaws.<region>.<name>`), whether CDK wrote it as a literal or as a
 * Fn::Join around the region. For the tests here and in test-apps/compute-smoke.
 */
export function endpointServiceName(serviceName: unknown): string {
  if (typeof serviceName === 'string') return serviceName.replace(/^com\.amazonaws\.[a-z0-9-]+\./, '');
  const parts = (serviceName as { 'Fn::Join'?: [string, unknown[]] } | undefined)?.['Fn::Join']?.[1] ?? [];
  const last = parts[parts.length - 1];
  return typeof last === 'string' ? last.replace(/^\./, '') : '';
}

const GATEWAY_SERVICES: Record<(typeof COMPUTE_TEST_VPC_ENDPOINTS.gateway)[number], ec2.GatewayVpcEndpointAwsService> = {
  dynamodb: ec2.GatewayVpcEndpointAwsService.DYNAMODB,
  s3: ec2.GatewayVpcEndpointAwsService.S3,
};
const INTERFACE_SERVICES: Record<
  (typeof COMPUTE_TEST_VPC_ENDPOINTS.interface)[number],
  ec2.InterfaceVpcEndpointAwsService
> = {
  logs: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS,
  sqs: ec2.InterfaceVpcEndpointAwsService.SQS,
};

export interface TestVpcStacks {
  testVpc: cdk.Stack;
  computeTestVpc: cdk.Stack;
  computeTestVpcEndpoints: cdk.Stack;
}

/**
 * Define one bare persistent test VPC in its own stack.
 *
 * @param stackId CloudFormation stack id (also its name)
 * @param purpose value for the `blocks:purpose` tag
 * @param consumer human description of which smoke suite consumes this VPC
 */
function createTestVpcStack(
  app: cdk.App,
  env: cdk.Environment,
  stackId: string,
  purpose: string,
  consumer: string,
): { stack: cdk.Stack; vpc: ec2.Vpc } {
  const stack = new cdk.Stack(app, stackId, {
    description: `Persistent test VPC for AWS Blocks ${consumer}. Do NOT delete between test runs.`,
    env,
  });

  // ── VPC ─────────────────────────────────────────────────────────────────
  const vpc = new ec2.Vpc(stack, 'TestVpc', {
    maxAzs: 2,
    natGateways: 1,
    subnetConfiguration: [
      {
        name: 'public',
        subnetType: ec2.SubnetType.PUBLIC,
        cidrMask: 24,
      },
      {
        name: 'private',
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        cidrMask: 24,
      },
      {
        name: 'isolated',
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        cidrMask: 24,
      },
    ],
  });

  // ── Outputs ───────────────────────────────────────────────────────────────
  new cdk.CfnOutput(stack, 'VpcId', {
    value: vpc.vpcId,
    description: 'VPC ID for downstream test stacks. Set VPC_TEST_VPC_ID env var to this value.',
    exportName: `${stackId}Id`,
  });

  // Prevent accidental deletion
  cdk.Tags.of(stack).add('blocks:purpose', purpose);
  cdk.Tags.of(stack).add('blocks:do-not-delete', 'true');
  return { stack, vpc };
}

/**
 * Permanent endpoints for BlocksComputeTestVpc, configured like the ones the
 * framework creates (`finalizeVpc` in packages/core/src/cdk/vpc.ts): gateway
 * endpoints on the route tables of every subnet, interface endpoints in the
 * private subnets with private DNS on, so the Lambda and the Fargate tasks reach
 * these services through them and not through the NAT gateway.
 *
 * One difference: the framework's endpoint security group admits 443 only from
 * the app's own Blocks compute security group. A permanent endpoint can't name
 * a security group that each test stack creates and deletes, so this one admits
 * 443 from the VPC CIDR. compute-smoke therefore no longer catches a runtime
 * placed in a security group the endpoints don't admit; the template test in
 * test-apps/compute-smoke and the E2E Compute Endpoints workflow (which deploys
 * the app with its own endpoints in BlocksTestVpc) cover that.
 *
 * A separate stack, not part of BlocksComputeTestVpc, because CI deploys the VPC
 * stack from each PR's own checkout. With the endpoints in the VPC stack, a
 * branch from before them would delete them on its next run and add its own,
 * breaking every other run in that account. Instead the VPC stack exports the
 * subnet and route table IDs this stack imports, and CloudFormation refuses to
 * remove an export in use: such a branch fails at "Ensure persistent compute
 * test VPC" and has to be rebased.
 */
function createComputeVpcEndpointsStack(app: cdk.App, env: cdk.Environment, vpc: ec2.IVpc): cdk.Stack {
  const stack = new cdk.Stack(app, COMPUTE_TEST_VPC_ENDPOINTS_STACK, {
    description:
      'Permanent VPC endpoints in BlocksComputeTestVpc for AWS Blocks Compute smoke tests. Do NOT delete between test runs.',
    env,
  });

  for (const name of COMPUTE_TEST_VPC_ENDPOINTS.gateway) {
    new ec2.GatewayVpcEndpoint(stack, `Gw-${name}`, { vpc, service: GATEWAY_SERVICES[name] });
  }

  const securityGroup = new ec2.SecurityGroup(stack, 'EndpointSg', {
    vpc,
    description: 'Permanent interface endpoints of BlocksComputeTestVpc - 443 from the VPC',
    allowAllOutbound: true,
  });
  securityGroup.addIngressRule(ec2.Peer.ipv4(vpc.vpcCidrBlock), ec2.Port.tcp(443), 'HTTPS from the VPC');

  for (const name of COMPUTE_TEST_VPC_ENDPOINTS.interface) {
    new ec2.InterfaceVpcEndpoint(stack, `If-${name}`, {
      vpc,
      service: INTERFACE_SERVICES[name],
      privateDnsEnabled: true,
      securityGroups: [securityGroup],
      // The ingress rule above is the only one; don't let CDK add its own.
      open: false,
    });
  }

  cdk.Tags.of(stack).add('blocks:purpose', 'persistent-compute-test-vpc');
  cdk.Tags.of(stack).add('blocks:do-not-delete', 'true');
  return stack;
}

export function buildTestVpcStacks(app: cdk.App, env: cdk.Environment = {}): TestVpcStacks {
  // VPC smoke suite (test-apps/vpc-smoke) references BlocksTestVpc.
  const testVpc = createTestVpcStack(app, env, TEST_VPC_STACK, 'persistent-test-vpc', 'VPC smoke tests');

  // Compute smoke suite (test-apps/compute-smoke) references BlocksComputeTestVpc.
  // A separate VPC so the compute suite's permanent endpoints don't stop the
  // apps in BlocksTestVpc from creating their own.
  const computeTestVpc = createTestVpcStack(
    app,
    env,
    COMPUTE_TEST_VPC_STACK,
    'persistent-compute-test-vpc',
    'Compute smoke tests',
  );
  const computeTestVpcEndpoints = createComputeVpcEndpointsStack(app, env, computeTestVpc.vpc);

  return { testVpc: testVpc.stack, computeTestVpc: computeTestVpc.stack, computeTestVpcEndpoints };
}
