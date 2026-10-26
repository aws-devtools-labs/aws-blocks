// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Persistent test VPC stacks (bare minimum).
 *
 * VPC quota is 5 per region. Creation takes 2–3 min. Deletion can fail
 * (Lambda ENIs linger 10–20 min). These stacks are deployed ONCE and NOT torn
 * down between test runs. CI references each VPC ID via env var or CDK context.
 *
 * Two VPCs, one per smoke suite, so the two suites never contend for the same
 * VPC's endpoints (AWS permits only one private-DNS interface endpoint per
 * service per VPC). Keeping them separate lets the VPC-smoke and Compute-smoke
 * CI lanes run in parallel under their own concurrency groups:
 * - BlocksTestVpc         → test-apps/vpc-smoke     (E2E VPC Smoke lane)
 * - BlocksComputeTestVpc  → test-apps/compute-smoke (E2E Compute Smoke lane)
 *
 * Resources (each stack):
 * - VPC with 2 AZs, 1 NAT gateway, public/private/isolated subnets
 * - VPC ID output
 *
 * No pre-provisioned endpoints. No Aurora cluster.
 * Each test app provisions its own endpoints via `provisionEndpoints: true`,
 * testing the real auto-detection path end-to-end.
 */

import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';

const app = new cdk.App();

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
};

/**
 * Define one bare persistent test VPC in its own stack.
 *
 * @param stackId CloudFormation stack id (also its name)
 * @param purpose value for the `blocks:purpose` tag
 * @param consumer human description of which smoke suite consumes this VPC
 */
function createTestVpcStack(stackId: string, purpose: string, consumer: string): void {
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
}

// VPC smoke suite (test-apps/vpc-smoke) — references BlocksTestVpc.
createTestVpcStack('BlocksTestVpc', 'persistent-test-vpc', 'VPC smoke tests');

// Compute smoke suite (test-apps/compute-smoke) — references BlocksComputeTestVpc.
// A separate VPC so the two suites don't contend for one VPC's per-service
// private-DNS interface endpoints.
createTestVpcStack('BlocksComputeTestVpc', 'persistent-compute-test-vpc', 'Compute smoke tests');

app.synth();
