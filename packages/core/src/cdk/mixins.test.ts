// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test, describe } from 'node:test';
import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { Table, AttributeType, BillingMode } from 'aws-cdk-lib/aws-dynamodb';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { RemovalPolicies, Mixins } from 'aws-cdk-lib';
import { SandboxDisableDeletionProtection } from './mixins.js';

describe('sandbox removal policy', () => {
  test('sandbox mode: DeletionPolicy is Delete on all resources', () => {
    const app = new cdk.App({ context: { sandboxMode: 'true' } });
    const stack = new cdk.Stack(app, 'TestStack');

    new Table(stack, 'MyTable', {
      partitionKey: { name: 'pk', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
    });

    RemovalPolicies.of(stack).destroy();

    const template = Template.fromStack(stack);
    template.hasResource('AWS::DynamoDB::Table', {
      DeletionPolicy: 'Delete',
    });
  });

  test('sandbox mode: deletionProtection disabled on RDS cluster', () => {
    const app = new cdk.App({ context: { sandboxMode: 'true' } });
    const stack = new cdk.Stack(app, 'TestStack');

    const vpc = new ec2.Vpc(stack, 'Vpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        { name: 'isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      ],
    });
    new rds.DatabaseCluster(stack, 'Cluster', {
      engine: rds.DatabaseClusterEngine.auroraPostgres({
        version: rds.AuroraPostgresEngineVersion.VER_16_4,
      }),
      writer: rds.ClusterInstance.serverlessV2('Writer'),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      deletionProtection: true,
    });

    RemovalPolicies.of(stack).destroy();
    Mixins.of(stack).apply(new SandboxDisableDeletionProtection());

    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::RDS::DBCluster', {
      DeletionProtection: false,
    });
    template.hasResource('AWS::RDS::DBCluster', {
      DeletionPolicy: 'Delete',
    });
  });

  test('production mode: default DeletionPolicy is Retain (CDK default, no explicit call needed)', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TestStack');

    new Table(stack, 'MyTable', {
      partitionKey: { name: 'pk', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
    });

    // No removal policy call — CDK defaults to RETAIN
    const template = Template.fromStack(stack);
    template.hasResource('AWS::DynamoDB::Table', {
      DeletionPolicy: 'Retain',
    });
  });

  test('SandboxDisableDeletionProtection mixin: does not set deletionProtection on Aurora instances', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TestStack');

    const vpc = new ec2.Vpc(stack, 'Vpc', {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        { name: 'isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      ],
    });
    new rds.DatabaseCluster(stack, 'Cluster', {
      engine: rds.DatabaseClusterEngine.auroraPostgres({
        version: rds.AuroraPostgresEngineVersion.VER_16_4,
      }),
      writer: rds.ClusterInstance.serverlessV2('Writer'),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    RemovalPolicies.of(stack).destroy();
    Mixins.of(stack).apply(new SandboxDisableDeletionProtection());

    const template = Template.fromStack(stack);
    // Aurora DB instance should NOT have DeletionProtection set at all
    // (RDS rejects it for cluster members)
    template.hasResourceProperties('AWS::RDS::DBInstance', {
      DeletionProtection: Match.absent(),
    });
  });

  test('SandboxDisableDeletionProtection mixin: deletionProtection disabled on DynamoDB table', () => {
    const app = new cdk.App({ context: { sandboxMode: 'true' } });
    const stack = new cdk.Stack(app, 'TestStack');

    new Table(stack, 'MyTable', {
      partitionKey: { name: 'pk', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      deletionProtection: true,
    });

    RemovalPolicies.of(stack).destroy();
    Mixins.of(stack).apply(new SandboxDisableDeletionProtection());

    const template = Template.fromStack(stack);
    // DynamoDB refuses DeleteTable while protection is on, regardless of DeletionPolicy
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      DeletionProtectionEnabled: false,
    });
    template.hasResource('AWS::DynamoDB::Table', {
      DeletionPolicy: 'Delete',
    });
  });

  test('production mode: deletionProtection stays enabled on DynamoDB table when mixin is not applied', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TestStack');

    new Table(stack, 'MyTable', {
      partitionKey: { name: 'pk', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      deletionProtection: true,
    });

    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      DeletionProtectionEnabled: true,
    });
  });

  test('SandboxDisableDeletionProtection mixin: does not set DeletionProtectionEnabled on unprotected tables', () => {
    const app = new cdk.App({ context: { sandboxMode: 'true' } });
    const stack = new cdk.Stack(app, 'TestStack');

    new Table(stack, 'MyTable', {
      partitionKey: { name: 'pk', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
    });

    Mixins.of(stack).apply(new SandboxDisableDeletionProtection());

    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      DeletionProtectionEnabled: Match.absent(),
    });
  });

  test('SandboxDisableDeletionProtection mixin: skips constructs without deletionProtection', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TestStack');

    new Table(stack, 'MyTable', {
      partitionKey: { name: 'pk', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
    });

    // Should not throw — DynamoDB Table has no deletionProtection property
    Mixins.of(stack).apply(new SandboxDisableDeletionProtection());

    const template = Template.fromStack(stack);
    // Table should still synthesize normally
    template.resourceCountIs('AWS::DynamoDB::Table', 1);
  });
});
