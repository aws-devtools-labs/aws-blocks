// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Persistent test VPC stack (bare minimum).
 *
 * VPC quota is 5 per region. Creation takes 2–3 min. Deletion can fail
 * (Lambda ENIs linger 10–20 min). This stack is deployed ONCE and NOT torn
 * down between test runs. CI references the VPC ID via env var or CDK context.
 *
 * Resources:
 * - VPC with 2 AZs, 1 NAT gateway, public/private/isolated subnets
 * - VPC ID output
 *
 * No pre-provisioned endpoints. No Aurora cluster.
 * The test app provisions its own endpoints via `provisionEndpoints: true`,
 * testing the real auto-detection path end-to-end.
 */

import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';

const app = new cdk.App();

const stack = new cdk.Stack(app, 'BlocksTestVpc', {
  description: 'Persistent test VPC for AWS Blocks VPC smoke tests. Do NOT delete between test runs.',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});

// ── VPC ─────────────────────────────────────────────────────────────────────

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

// ── Outputs ─────────────────────────────────────────────────────────────────

new cdk.CfnOutput(stack, 'VpcId', {
  value: vpc.vpcId,
  description: 'VPC ID for downstream test stacks. Set VPC_TEST_VPC_ID env var to this value.',
  exportName: 'BlocksTestVpcId',
});

// Prevent accidental deletion
cdk.Tags.of(stack).add('blocks:purpose', 'persistent-test-vpc');
cdk.Tags.of(stack).add('blocks:do-not-delete', 'true');

app.synth();
