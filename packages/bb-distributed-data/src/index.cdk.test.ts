// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * CDK construct tests for DistributedDatabase.
 * Pattern follows bb-auth-cognito/src/index.cdk.test.ts — sets up a plain Stack
 * with a placeholder handler on globalThis to satisfy Scope.handler lookups.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { ScopeParent } from '@aws-blocks/core';
import { DEFAULT_NODE_RUNTIME, finalizeConfigRegistry } from '@aws-blocks/core/cdk';
import { DistributedDatabase } from './index.cdk.js';

const MIGRATIONS_DIR = '.bb-data/__test_cdk_migrations__';

function synth(build: (stack: cdk.Stack) => void): Template {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'TestStack');
  const handler = new lambda.Function(stack, 'Handler', {
    runtime: DEFAULT_NODE_RUNTIME,
    handler: 'index.handler',
    code: lambda.Code.fromInline('exports.handler = async () => {};'),
  });
  (stack as any).handler = handler;
  (globalThis as any).CURRENT_BLOCKS_STACK = stack;
  try {
    build(stack);
    finalizeConfigRegistry(stack, handler);
    return Template.fromStack(stack);
  } finally {
    delete (globalThis as any).CURRENT_BLOCKS_STACK;
  }
}

function scope(stack: cdk.Stack): ScopeParent {
  return stack as unknown as ScopeParent;
}

// --- DSQL Cluster ---

test('CDK: synthesized stack contains AWS::DSQL::Cluster', () => {
  const template = synth((stack) => {
    new DistributedDatabase(scope(stack), 'mydsql');
  });
  template.resourceCountIs('AWS::DSQL::Cluster', 1);
});

test('CDK: cluster has DeletionProtectionEnabled=true by default', () => {
  const template = synth((stack) => {
    new DistributedDatabase(scope(stack), 'mydsql');
  });
  template.hasResource('AWS::DSQL::Cluster', {
    Properties: { DeletionProtectionEnabled: true },
    DeletionPolicy: 'Retain',
  });
});

test('CDK: removalPolicy=destroy disables deletion protection', () => {
  const template = synth((stack) => {
    new DistributedDatabase(scope(stack), 'mydsql', { removalPolicy: 'destroy' });
  });
  template.hasResource('AWS::DSQL::Cluster', {
    Properties: { DeletionProtectionEnabled: false },
    DeletionPolicy: 'Delete',
  });
});

test('CDK: sandboxMode=true disables deletion protection', () => {
  const app = new cdk.App({ context: { sandboxMode: 'true' } });
  const stack = new cdk.Stack(app, 'SandboxStack');
  const handler = new lambda.Function(stack, 'Handler', {
    runtime: DEFAULT_NODE_RUNTIME,
    handler: 'index.handler',
    code: lambda.Code.fromInline('exports.handler = async () => {};'),
  });
  (stack as any).handler = handler;
  (globalThis as any).CURRENT_BLOCKS_STACK = stack;
  try {
    new DistributedDatabase(scope(stack), 'mydsql');
    const template = Template.fromStack(stack);
    template.hasResource('AWS::DSQL::Cluster', {
      Properties: { DeletionProtectionEnabled: false },
      DeletionPolicy: 'Delete',
    });
  } finally {
    delete (globalThis as any).CURRENT_BLOCKS_STACK;
  }
});

// --- IAM ---

test('CDK: handler gets dsql:DbConnect policy (least privilege)', () => {
  const template = synth((stack) => {
    new DistributedDatabase(scope(stack), 'mydsql');
  });
  template.hasResourceProperties('AWS::IAM::Policy', {
    PolicyDocument: {
      Statement: Match.arrayWith([
        Match.objectLike({
          Action: 'dsql:DbConnect',
          Effect: 'Allow',
        }),
      ]),
    },
  });
});

// --- Runtime configuration ---

test('CDK: runtime endpoint and region use the config registry', () => {
  const template = synth((stack) => {
    new DistributedDatabase(scope(stack), 'mydsql');
  });
  const fns = template.findResources('AWS::Lambda::Function');
  const handlerFn = Object.entries(fns).find(([id]) => id.startsWith('Handler'));
  assert.ok(handlerFn, 'Handler Lambda should exist');
  const env = (handlerFn?.[1] as any).Properties?.Environment?.Variables ?? {};
  const envKeys = Object.keys(env);
  assert.ok(!envKeys.some(k => k.endsWith('_ENDPOINT')), `Unexpected direct ENDPOINT env var: ${envKeys}`);
  assert.ok(!envKeys.some(k => k.endsWith('_REGION')), `Unexpected direct REGION env var: ${envKeys}`);
  assert.ok(env.BLOCKS_CONFIG_BUCKET, 'Handler Lambda should receive the config bucket');
  assert.strictEqual(env.BLOCKS_CONFIG_KEY, 'blocks-config.json');

  const configBlob = JSON.stringify(
    Object.values(template.findResources('Custom::CDKBucketDeployment')),
  );
  assert.match(configBlob, /BLOCKS_[A-Za-z0-9_]+_ENDPOINT/);
  assert.match(configBlob, /BLOCKS_[A-Za-z0-9_]+_REGION/);
});

// --- CfnOutput ---

test('CDK: stack has endpoint output', () => {
  const template = synth((stack) => {
    new DistributedDatabase(scope(stack), 'mydsql');
  });
  const outputs = template.findOutputs('*');
  const outputKeys = Object.keys(outputs);
  assert.ok(outputKeys.some(k => k.includes('DsqlEndpoint')), `Expected DsqlEndpoint output, got: ${outputKeys}`);
});

// --- Migrations ---

test('CDK: migration/provisioning resources always created', () => {
  const template = synth((stack) => {
    new DistributedDatabase(scope(stack), 'mydsql');
  });
  // The provisioning CustomResource is always created (for DB role setup)
  const customResources = template.findResources('AWS::CloudFormation::CustomResource');
  assert.ok(Object.keys(customResources).length > 0, 'Should have provisioning CustomResource');

  // Migration Lambda should have dsql:DbConnectAdmin for role management
  const policies = template.findResources('AWS::IAM::Policy');
  const policyValues = Object.values(policies);
  const hasDsqlGrant = policyValues.some((p: any) =>
    JSON.stringify(p).includes('dsql:DbConnectAdmin')
  );
  assert.ok(hasDsqlGrant, 'Migration Lambda should have dsql:DbConnectAdmin');
});

test('CDK: migration resources created when migrationsPath is provided', () => {
  rmSync(MIGRATIONS_DIR, { recursive: true, force: true });
  mkdirSync(MIGRATIONS_DIR, { recursive: true });
  writeFileSync(join(MIGRATIONS_DIR, '001_create.sql'), 'CREATE TABLE t (id TEXT PRIMARY KEY)');

  try {
    const template = synth((stack) => {
      new DistributedDatabase(scope(stack), 'mydsql', { migrationsPath: MIGRATIONS_DIR });
    });
    const customResources = template.findResources('AWS::CloudFormation::CustomResource');
    assert.ok(Object.keys(customResources).length > 0, 'Should have migration CustomResource');

    // Migration Lambda should have dsql:DbConnectAdmin
    const policies = template.findResources('AWS::IAM::Policy');
    const policyValues = Object.values(policies);
    const hasDsqlGrant = policyValues.some((p: any) =>
      JSON.stringify(p).includes('dsql:DbConnectAdmin')
    );
    assert.ok(hasDsqlGrant, 'Migration Lambda should have dsql:DbConnectAdmin');

    // Migration Lambda should have APP_ROLE_ARN and DB_ROLE_NAME env vars
    const fns = template.findResources('AWS::Lambda::Function');
    const migrationFn = Object.entries(fns).find(([id]) => id.includes('MigrationFn'));
    assert.ok(migrationFn, 'Migration Lambda should exist');
    const env = (migrationFn![1] as any).Properties?.Environment?.Variables ?? {};
    assert.ok(env.APP_ROLE_ARN, 'Migration Lambda should have APP_ROLE_ARN env var');
    assert.ok(env.DB_ROLE_NAME, 'Migration Lambda should have DB_ROLE_NAME env var');
  } finally {
    rmSync(MIGRATIONS_DIR, { recursive: true, force: true });
  }
});

test('CDK: migration CustomResource has migrationsHash property', () => {
  rmSync(MIGRATIONS_DIR, { recursive: true, force: true });
  mkdirSync(MIGRATIONS_DIR, { recursive: true });
  writeFileSync(join(MIGRATIONS_DIR, '001_create.sql'), 'CREATE TABLE t (id TEXT PRIMARY KEY)');

  try {
    const template = synth((stack) => {
      new DistributedDatabase(scope(stack), 'mydsql', { migrationsPath: MIGRATIONS_DIR });
    });
    const customResources = template.findResources('AWS::CloudFormation::CustomResource');
    const cr = Object.values(customResources)[0] as any;
    assert.ok(cr.Properties?.migrationsHash, 'CustomResource should have migrationsHash property');
    assert.strictEqual(typeof cr.Properties.migrationsHash, 'string');
    assert.strictEqual(cr.Properties.migrationsHash.length, 16);
  } finally {
    rmSync(MIGRATIONS_DIR, { recursive: true, force: true });
  }
});
