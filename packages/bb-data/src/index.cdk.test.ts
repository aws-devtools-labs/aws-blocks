// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Template } from 'aws-cdk-lib/assertions';
import { materialize } from './infra.js';

function synthWithRemovalPolicy(removalPolicy?: cdk.RemovalPolicy): Template {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'TestStack');
  materialize(stack, 'testdb', { databaseName: 'mydb', removalPolicy });
  return Template.fromStack(stack);
}

// These tests verify the contract that index.cdk.ts relies on:
// - removalPolicy=DESTROY → cluster is deletable (DeletionProtection=false)
// - removalPolicy=RETAIN  → cluster is retained and protected
//
// index.cdk.ts resolves the policy as `options.removalPolicy ?? this.defaults.removalPolicy`
// (the stack-wide sandbox/production posture) and passes it to materialize();
// that resolution is verified via cdk synth (see canary-publish-plan.md) because
// Database requires BlocksStack which can't be unit-tested without a full backend.

test('CDK: removalPolicy=DESTROY sets DeletionPolicy=Delete and DeletionProtection=false', () => {
  const template = synthWithRemovalPolicy(cdk.RemovalPolicy.DESTROY);
  template.hasResource('AWS::RDS::DBCluster', {
    DeletionPolicy: 'Delete',
    Properties: { DeletionProtection: false },
  });
  template.hasResource('AWS::RDS::DBInstance', {
    DeletionPolicy: 'Delete',
  });
});

test('CDK: removalPolicy=undefined sets DeletionPolicy=Retain and DeletionProtection=true', () => {
  const template = synthWithRemovalPolicy(undefined);
  template.hasResource('AWS::RDS::DBCluster', {
    DeletionPolicy: 'Retain',
    Properties: { DeletionProtection: true },
  });
  template.hasResource('AWS::RDS::DBInstance', {
    DeletionPolicy: 'Retain',
  });
});

test('CDK: removalPolicy=SNAPSHOT sets DeletionPolicy=Snapshot and DeletionProtection=true', () => {
  const template = synthWithRemovalPolicy(cdk.RemovalPolicy.SNAPSHOT);
  template.hasResource('AWS::RDS::DBCluster', {
    DeletionPolicy: 'Snapshot',
    Properties: { DeletionProtection: true },
  });
});

test('CDK: migration Lambda log group adopts the resolved logRetention', () => {
  // The migration Lambda is only created when migrationsPath is provided.
  const migrationsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-data-migrations-'));
  fs.writeFileSync(path.join(migrationsDir, '001_init.sql'), 'SELECT 1;');
  try {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'MigrationRetentionStack');
    // index.cdk.ts passes this.defaults.logRetention; here we pass the resolved value directly.
    materialize(stack, 'testdb', {
      databaseName: 'mydb',
      migrationsPath: migrationsDir,
      logRetention: RetentionDays.ONE_WEEK,
    });
    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::Logs::LogGroup', { RetentionInDays: 7 });
  } finally {
    fs.rmSync(migrationsDir, { recursive: true, force: true });
  }
});
