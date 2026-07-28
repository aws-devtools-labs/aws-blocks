// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Persistent test VPC stack.
 *
 * VPC quota is 5 per region. Creation takes 2–3 min. Deletion can fail
 * (Lambda ENIs linger 10–20 min). This stack is deployed ONCE and NOT torn
 * down between test runs. CI references the VPC ID via env var or CDK context.
 *
 * Resources:
 * - VPC with 2 AZs, 1 NAT gateway, public/private/isolated subnets
 * - Gateway endpoints: DynamoDB, S3 (free)
 * - Interface endpoints: SSM, Secrets Manager, CloudWatch Logs
 * - CfnOutput exporting the VPC ID for downstream stacks
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

// ── Gateway Endpoints (free) ────────────────────────────────────────────────

vpc.addGatewayEndpoint('DynamoDbEndpoint', {
  service: ec2.GatewayVpcEndpointAwsService.DYNAMODB,
});

vpc.addGatewayEndpoint('S3Endpoint', {
  service: ec2.GatewayVpcEndpointAwsService.S3,
});

// ── Interface Endpoints (common services used by BBs) ───────────────────────

vpc.addInterfaceEndpoint('SsmEndpoint', {
  service: ec2.InterfaceVpcEndpointAwsService.SSM,
  privateDnsEnabled: true,
});

vpc.addInterfaceEndpoint('SecretsManagerEndpoint', {
  service: ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
  privateDnsEnabled: true,
});

vpc.addInterfaceEndpoint('CloudWatchLogsEndpoint', {
  service: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS,
  privateDnsEnabled: true,
});

// ── Outputs ─────────────────────────────────────────────────────────────────

new cdk.CfnOutput(stack, 'VpcId', {
  value: vpc.vpcId,
  description: 'VPC ID for downstream test stacks. Set VPC_TEST_VPC_ID env var to this value.',
  exportName: 'BlocksTestVpcId',
});

new cdk.CfnOutput(stack, 'PrivateSubnetIds', {
  value: vpc.privateSubnets.map(s => s.subnetId).join(','),
  description: 'Private subnet IDs (comma-separated)',
});

new cdk.CfnOutput(stack, 'IsolatedSubnetIds', {
  value: vpc.isolatedSubnets.map(s => s.subnetId).join(','),
  description: 'Isolated subnet IDs (comma-separated)',
});

// Prevent accidental deletion
cdk.Tags.of(stack).add('blocks:purpose', 'persistent-test-vpc');
cdk.Tags.of(stack).add('blocks:do-not-delete', 'true');

app.synth();
