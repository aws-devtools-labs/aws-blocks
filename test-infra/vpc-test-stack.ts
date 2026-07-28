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
 * - Interface endpoints: SSM, Secrets Manager, CloudWatch Logs, RDS Data API
 * - Aurora Serverless v2 cluster (PostgreSQL, minimal capacity) in isolated subnets
 * - CfnOutput exporting the VPC ID, Aurora cluster ARN, and secret ARN
 */

import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';

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

vpc.addInterfaceEndpoint('RdsDataEndpoint', {
  service: ec2.InterfaceVpcEndpointAwsService.RDS_DATA,
  privateDnsEnabled: true,
});

// ── Aurora Serverless v2 (PostgreSQL) ───────────────────────────────────────
// Primary reason customers need VPC support — Aurora requires VPC placement.
// Minimal capacity (0.5–1 ACU) to keep costs low for persistent test infra.

const auroraSg = new ec2.SecurityGroup(stack, 'AuroraSg', {
  vpc,
  description: 'Security group for test Aurora cluster',
  allowAllOutbound: false,
});

// Allow inbound PostgreSQL from the entire VPC (test Lambdas use private subnets)
auroraSg.addIngressRule(
  ec2.Peer.ipv4(vpc.vpcCidrBlock),
  ec2.Port.tcp(5432),
  'Allow PostgreSQL from VPC',
);

const auroraCluster = new rds.DatabaseCluster(stack, 'TestAurora', {
  engine: rds.DatabaseClusterEngine.auroraPostgres({
    version: rds.AuroraPostgresEngineVersion.VER_16_6,
  }),
  serverlessV2MinCapacity: 0.5,
  serverlessV2MaxCapacity: 1,
  writer: rds.ClusterInstance.serverlessV2('Writer'),
  vpc,
  vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
  securityGroups: [auroraSg],
  defaultDatabaseName: 'blockstest',
  enableDataApi: true,
  deletionProtection: true,
  removalPolicy: cdk.RemovalPolicy.RETAIN,
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

new cdk.CfnOutput(stack, 'AuroraClusterArn', {
  value: auroraCluster.clusterArn,
  description: 'Aurora cluster ARN for Database BB smoke tests. Set VPC_TEST_AURORA_CLUSTER_ARN env var.',
  exportName: 'BlocksTestAuroraClusterArn',
});

new cdk.CfnOutput(stack, 'AuroraSecretArn', {
  value: auroraCluster.secret!.secretArn,
  description: 'Aurora secret ARN for Database BB smoke tests. Set VPC_TEST_AURORA_SECRET_ARN env var.',
  exportName: 'BlocksTestAuroraSecretArn',
});

// Prevent accidental deletion
cdk.Tags.of(stack).add('blocks:purpose', 'persistent-test-vpc');
cdk.Tags.of(stack).add('blocks:do-not-delete', 'true');

app.synth();
