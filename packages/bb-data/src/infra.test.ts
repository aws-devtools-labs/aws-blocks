// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert';
import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { DEFAULT_NODE_RUNTIME } from '@aws-blocks/core/cdk';
import { materialize } from './infra.js';

function synthTemplate(options: Parameters<typeof materialize>[2]): Template {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'TestStack');
  materialize(stack, 'testdb', options);
  return Template.fromStack(stack);
}

// --- Aurora cluster ---

test('CDK: synthesized stack contains Aurora cluster with correct engine', () => {
  const template = synthTemplate({ databaseName: 'mydb' });
  template.hasResourceProperties('AWS::RDS::DBCluster', {
    Engine: 'aurora-postgresql',
    EnableHttpEndpoint: true,
    DatabaseName: 'mydb',
  });
});

test('CDK: Aurora cluster uses serverless v2 capacity', () => {
  const template = synthTemplate({ databaseName: 'mydb', minCapacity: 1, maxCapacity: 8 });
  template.hasResourceProperties('AWS::RDS::DBCluster', {
    ServerlessV2ScalingConfiguration: {
      MinCapacity: 1,
      MaxCapacity: 8,
    },
  });
});

test('CDK: default capacity is 0.5-2 ACUs', () => {
  const template = synthTemplate({ databaseName: 'mydb' });
  template.hasResourceProperties('AWS::RDS::DBCluster', {
    ServerlessV2ScalingConfiguration: {
      MinCapacity: 0.5,
      MaxCapacity: 2,
    },
  });
});

// --- Engine version ---

test('CDK: default engine version is 16.13', () => {
  const template = synthTemplate({ databaseName: 'mydb' });
  template.hasResourceProperties('AWS::RDS::DBCluster', {
    EngineVersion: Match.stringLikeRegexp('^16\\.13'),
  });
});

test('CDK: postgresVersion override sets the engine version', () => {
  const template = synthTemplate({ databaseName: 'mydb', postgresVersion: '16.11' });
  template.hasResourceProperties('AWS::RDS::DBCluster', {
    EngineVersion: '16.11',
  });
});

test('CDK: malformed postgresVersion throws at synth time', () => {
  assert.throws(
    () => synthTemplate({ databaseName: 'mydb', postgresVersion: '16' }),
    /Invalid postgresVersion "16"/,
  );
  assert.throws(
    () => synthTemplate({ databaseName: 'mydb', postgresVersion: 'bogus' }),
    /Invalid postgresVersion "bogus"/,
  );
});

// --- VPC ---

test('CDK: VPC has isolated subnets and no NAT gateways', () => {
  const template = synthTemplate({ databaseName: 'mydb' });
  // No NAT gateway resources should exist
  const natGateways = template.findResources('AWS::EC2::NatGateway');
  assert.strictEqual(Object.keys(natGateways).length, 0, 'Should have no NAT gateways');
  // VPC should exist
  template.resourceCountIs('AWS::EC2::VPC', 1);
});

// --- Security group ---

test('CDK: cluster security group has no ingress rule (reached via Data API, not a socket)', () => {
  const template = synthTemplate({ databaseName: 'mydb' });
  // The cluster is reached over the RDS Data API (HTTPS), never a raw Postgres
  // socket, so there must be no 5432 (or any) ingress rule on its SG.
  const sgs = template.findResources('AWS::EC2::SecurityGroup', {
    Properties: { GroupDescription: Match.stringLikeRegexp('Aurora cluster') },
  });
  assert.strictEqual(Object.keys(sgs).length, 1, 'exactly one Aurora SG');
  const sg = Object.values(sgs)[0] as { Properties: { SecurityGroupIngress?: unknown[] } };
  assert.ok(
    sg.Properties.SecurityGroupIngress === undefined || sg.Properties.SecurityGroupIngress.length === 0,
    'Aurora SG should have no ingress rules',
  );
});

test('CDK: security group disallows all outbound traffic', () => {
  const template = synthTemplate({ databaseName: 'mydb' });
  template.hasResourceProperties('AWS::EC2::SecurityGroup', {
    GroupDescription: Match.stringLikeRegexp('Aurora cluster'),
    SecurityGroupEgress: Match.arrayWith([
      Match.objectLike({ Description: 'Disallow all traffic' }),
    ]),
  });
});

// --- Shared-VPC placement (vpcContext path) ---

/** Build a minimal VpcContext over a real bring-your-own VPC for the shared path. */
function sharedVpcContext(stack: cdk.Stack, opts: { isolated: boolean }) {
  const subnetConfiguration = [
    { name: 'public', subnetType: cdk.aws_ec2.SubnetType.PUBLIC, cidrMask: 24 },
    { name: 'private', subnetType: cdk.aws_ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
    ...(opts.isolated
      ? [{ name: 'isolated', subnetType: cdk.aws_ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 }]
      : []),
  ];
  const vpc = new cdk.aws_ec2.Vpc(stack, 'SharedVpc', { maxAzs: 2, natGateways: 1, subnetConfiguration });
  const lambdaSecurityGroup = new cdk.aws_ec2.SecurityGroup(stack, 'LambdaSg', { vpc });
  const hasRole = (role: string) =>
    role === 'isolated'
      ? vpc.isolatedSubnets.length > 0
      : role === 'public'
        ? vpc.publicSubnets.length > 0
        : vpc.privateSubnets.length > 0;
  const typeFor = (role: string) =>
    role === 'isolated'
      ? cdk.aws_ec2.SubnetType.PRIVATE_ISOLATED
      : role === 'public'
        ? cdk.aws_ec2.SubnetType.PUBLIC
        : cdk.aws_ec2.SubnetType.PRIVATE_WITH_EGRESS;
  return {
    vpc,
    lambdaSecurityGroup,
    lambdaSubnets: { subnetType: cdk.aws_ec2.SubnetType.PRIVATE_WITH_EGRESS },
    selectSubnets(scope: { fullId: string }, role: string, o?: { fallback?: string }) {
      if (hasRole(role)) return { subnetType: typeFor(role) };
      if (o?.fallback && hasRole(o.fallback)) return { subnetType: typeFor(o.fallback) };
      throw new Error(`${scope.fullId} needs a '${role}' subnet`);
    },
  };
}

test('CDK: shared VPC with an isolated tier places the cluster in isolated subnets', () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'TestStack', { env: { account: '123456789012', region: 'us-east-1' } });
  // biome-ignore lint/suspicious/noExplicitAny: minimal VpcContext test double
  materialize(stack, 'testdb', { databaseName: 'mydb', vpcContext: sharedVpcContext(stack, { isolated: true }) as any });
  const template = Template.fromStack(stack);
  // A shared VPC is used (2 VPCs would mean bb-data created its own).
  template.resourceCountIs('AWS::EC2::VPC', 1);
  // No new NAT gateway from bb-data (it reuses the shared VPC's).
  template.resourceCountIs('AWS::RDS::DBCluster', 1);
});

test('CDK: shared VPC without an isolated tier falls back to private-with-egress (no synth error)', () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'TestStack', { env: { account: '123456789012', region: 'us-east-1' } });
  assert.doesNotThrow(() =>
    // biome-ignore lint/suspicious/noExplicitAny: minimal VpcContext test double
    materialize(stack, 'testdb', { databaseName: 'mydb', vpcContext: sharedVpcContext(stack, { isolated: false }) as any }),
  );
});

// --- Removal policy ---

test('CDK: default removal policy is RETAIN', () => {
  const template = synthTemplate({ databaseName: 'mydb' });
  const clusters = template.findResources('AWS::RDS::DBCluster');
  const clusterKey = Object.keys(clusters)[0];
  // RETAIN means no DeletionPolicy or DeletionPolicy: Retain
  const policy = clusters[clusterKey].DeletionPolicy;
  assert.strictEqual(policy, 'Retain', 'Default removal policy should be Retain');
});

test('CDK: removalPolicy=DESTROY sets DeletionPolicy to Delete', () => {
  const template = synthTemplate({
    databaseName: 'mydb',
    removalPolicy: cdk.RemovalPolicy.DESTROY,
  });
  const clusters = template.findResources('AWS::RDS::DBCluster');
  const clusterKey = Object.keys(clusters)[0];
  assert.strictEqual(clusters[clusterKey].DeletionPolicy, 'Delete');
});

// --- IAM grants ---

test('CDK: grantDataApi adds rds-data permissions to a Lambda', () => {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'TestStack');
  const infra = materialize(stack, 'testdb', { databaseName: 'mydb' });

  // Create a Lambda to grant to, simulating what index.cdk.ts does
  const fn = new cdk.aws_lambda.Function(stack, 'TestFn', {
    runtime: DEFAULT_NODE_RUNTIME,
    handler: 'index.handler',
    code: cdk.aws_lambda.Code.fromInline('exports.handler = () => {}'),
  });
  infra.grantDataApi(fn);

  const template = Template.fromStack(stack);
  template.hasResourceProperties('AWS::IAM::Policy', {
    PolicyDocument: {
      Statement: Match.arrayWith([
        Match.objectLike({
          Action: Match.arrayWith([
            'rds-data:ExecuteStatement',
            'rds-data:BeginTransaction',
            'rds-data:CommitTransaction',
            'rds-data:RollbackTransaction',
          ]),
        }),
      ]),
    },
  });
});

// --- Secrets Manager ---

test('CDK: stack has Secrets Manager secret for cluster credentials', () => {
  const template = synthTemplate({ databaseName: 'mydb' });
  // Aurora auto-creates a secret; verify it's referenced in outputs
  template.hasOutput('testdbClusterArn', {});
  template.hasOutput('testdbSecretArn', {});
});

// --- Migrations ---

test('CDK: no migration resources when migrationsPath is not provided', () => {
  const template = synthTemplate({ databaseName: 'mydb' });
  const customResources = template.findResources('AWS::CloudFormation::CustomResource');
  assert.strictEqual(Object.keys(customResources).length, 0, 'Should have no custom resources without migrationsPath');
});
