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

test('CDK: security group allows inbound PostgreSQL from VPC CIDR', () => {
  const template = synthTemplate({ databaseName: 'mydb' });
  template.hasResourceProperties('AWS::EC2::SecurityGroup', {
    SecurityGroupIngress: Match.arrayWith([
      Match.objectLike({
        FromPort: 5432,
        ToPort: 5432,
        IpProtocol: 'tcp',
      }),
    ]),
  });
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
