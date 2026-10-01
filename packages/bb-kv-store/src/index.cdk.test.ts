// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * CDK-side regression tests for KVStore.
 *
 * History: KVStore.fromExisting was advertised in the README + types but the
 * CDK constructor unconditionally provisioned a new DynamoDB table, defeating
 * the point of `fromExisting`. These tests pin the fix.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import * as cdk from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { Template, Match, Annotations } from 'aws-cdk-lib/assertions';
import { Scope, DEFAULT_NODE_RUNTIME, BlocksPresets, type BlocksDefaults } from '@aws-blocks/core/cdk';
import { KVStore, type KVStoreOptions } from './index.cdk.js';

// Minimal BlocksStack-shaped parent. The production code path uses BlocksStack,
// which exposes the shared `executionRole` (blocks grant to it) plus `handler`,
// both living inside a `cdk.Stack`. We reproduce them here so KVStore can call
// grantReadWriteData(this.executionRole) and still synth into a real stack. It
// also carries `defaults` — Building Blocks resolve `scope.defaults` by walking
// up to the owning BlocksStack/BlocksBackend, falling back to
// `globalThis.CURRENT_BLOCKS_STACK`, which is this stub in these tests.
class StubBlocksStack extends cdk.Stack {
  public readonly handler: cdk.aws_lambda.Function;
  public readonly executionRole: cdk.aws_iam.IRole;
  public readonly id: string;
  public defaults: BlocksDefaults = BlocksPresets.production;
  constructor(scope: Construct, id: string) {
    super(scope, id);
    this.id = id;
    (globalThis as any).CURRENT_BLOCKS_STACK = this;
    this.executionRole = new cdk.aws_iam.Role(this, 'BlocksRole', {
      assumedBy: new cdk.aws_iam.ServicePrincipal('lambda.amazonaws.com'),
    });
    this.handler = new cdk.aws_lambda.Function(this, 'StubHandler', {
      runtime: DEFAULT_NODE_RUNTIME,
      handler: 'index.handler',
      code: cdk.aws_lambda.Code.fromInline('exports.handler = async () => {};'),
      role: this.executionRole,
    });
  }
}

function setup(defaults: BlocksDefaults = BlocksPresets.production): { stack: StubBlocksStack; parent: Scope } {
  const app = new cdk.App();
  const stack = new StubBlocksStack(app, 'TestStack');
  stack.defaults = defaults;
  const parent = new Scope('app');
  return { stack, parent };
}

test('CDK: default KVStore provisions a DynamoDB table', () => {
  const { stack, parent } = setup();
  new KVStore(parent, 'sessions');
  const template = Template.fromStack(stack);
  template.resourceCountIs('AWS::DynamoDB::Table', 1);
});

test('CDK: KVStore.fromExisting does NOT provision a table (regression)', () => {
  const { stack, parent } = setup();
  new KVStore(parent, 'sessions', {
    table: KVStore.fromExisting('preexisting-table-123'),
  });
  const template = Template.fromStack(stack);
  template.resourceCountIs('AWS::DynamoDB::Table', 0);
});

test('CDK: KVStore.fromExisting returns a branded ref', () => {
  const ref = KVStore.fromExisting('foo');
  assert.strictEqual(ref.tableName, 'foo');
  assert.strictEqual(ref.__brand, 'ExternalTableRef');
});

test('CDK: table adopts the sandbox defaults (DESTROY, deletion protection off)', () => {
  const { stack, parent } = setup(BlocksPresets.sandbox);
  new KVStore(parent, 'sessions');
  const template = Template.fromStack(stack);
  template.hasResource('AWS::DynamoDB::Table', { DeletionPolicy: 'Delete' });
  template.hasResourceProperties('AWS::DynamoDB::Table', { DeletionProtectionEnabled: false });
});

test('CDK: table adopts the production defaults (RETAIN, deletion protection on)', () => {
  const { stack, parent } = setup(BlocksPresets.production);
  new KVStore(parent, 'sessions');
  const template = Template.fromStack(stack);
  template.hasResource('AWS::DynamoDB::Table', { DeletionPolicy: 'Retain' });
  template.hasResourceProperties('AWS::DynamoDB::Table', { DeletionProtectionEnabled: true });
});

test('CDK: per-block removalPolicy overrides the resolved default', () => {
  const { stack, parent } = setup(BlocksPresets.production);
  new KVStore(parent, 'sessions', { removalPolicy: 'destroy' });
  const template = Template.fromStack(stack);
  // Per-block 'destroy' wins over the production RETAIN default; deletion
  // protection still follows the default (no per-block option given for it).
  template.hasResource('AWS::DynamoDB::Table', { DeletionPolicy: 'Delete' });
  template.hasResourceProperties('AWS::DynamoDB::Table', { DeletionProtectionEnabled: true });
});

test('CDK: per-block deletionProtection overrides the resolved default', () => {
  const { stack, parent } = setup(BlocksPresets.production);
  new KVStore(parent, 'sessions', { deletionProtection: false });
  const template = Template.fromStack(stack);
  // Per-block false wins over the production (protected) default; removal
  // policy still follows the default (RETAIN).
  template.hasResourceProperties('AWS::DynamoDB::Table', { DeletionProtectionEnabled: false });
  template.hasResource('AWS::DynamoDB::Table', { DeletionPolicy: 'Retain' });
});

test('CDK: calling a runtime data method throws an actionable error (not a cryptic TypeError)', () => {
  const { parent } = setup();
  const store = new KVStore(parent, 'sessions') as any;
  for (const method of ['get', 'put', 'delete', 'scan']) {
    assert.throws(
      () => store[method]('k'),
      /cannot be called during CDK synth/,
      `${method}() should throw the actionable synth-time error`,
    );
  }
});

// TTL is opt-in: switching it on for a table that already exists is an update
// to the live table, so the default must never emit a TimeToLiveSpecification.

test('CDK: TTL is off by default', () => {
  const { stack, parent } = setup();
  new KVStore(parent, 'sessions');
  Template.fromStack(stack).hasResourceProperties('AWS::DynamoDB::Table', {
    TimeToLiveSpecification: Match.absent(),
  });
});

test('CDK: { ttl: false } does not enable TTL', () => {
  const { stack, parent } = setup();
  new KVStore(parent, 'sessions', { ttl: false });
  Template.fromStack(stack).hasResourceProperties('AWS::DynamoDB::Table', {
    TimeToLiveSpecification: Match.absent(),
  });
});

test('CDK: { ttl: true } enables TTL on the ttl attribute', () => {
  const { stack, parent } = setup();
  new KVStore(parent, 'sessions', { ttl: true });
  Template.fromStack(stack).hasResourceProperties('AWS::DynamoDB::Table', {
    TimeToLiveSpecification: { AttributeName: 'ttl', Enabled: true },
  });
});

test('CDK: TTL composes with removalPolicy', () => {
  const { stack, parent } = setup();
  new KVStore(parent, 'sessions', { ttl: true, removalPolicy: 'destroy' });
  const template = Template.fromStack(stack);
  template.hasResourceProperties('AWS::DynamoDB::Table', {
    TimeToLiveSpecification: { AttributeName: 'ttl', Enabled: true },
  });
  template.hasResource('AWS::DynamoDB::Table', { DeletionPolicy: 'Delete' });
});

test('CDK: fromExisting + ttl still provisions nothing (no table to configure)', () => {
  const { stack, parent } = setup();
  new KVStore(parent, 'sessions', { ttl: true, table: KVStore.fromExisting('preexisting-table-123') });
  Template.fromStack(stack).resourceCountIs('AWS::DynamoDB::Table', 0);
});

// ── Point-in-Time Recovery & encryption (secure-by-default in production) ────
// Regression: KVStore's production DynamoDB table previously shipped with PITR
// disabled and no customer-managed encryption option, so a consumer on the
// production preset believed PITR was on (bb-distributed-table honors it) when
// it was NOT.

test('CDK: prod KVStore enables PITR by default', () => {
  const { stack, parent } = setup(BlocksPresets.production);
  new KVStore(parent, 'sessions');
  const template = Template.fromStack(stack);
  template.hasResourceProperties('AWS::DynamoDB::Table', {
    PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
  });
});

test('CDK: PITR follows the stack defaults — off under the sandbox preset', () => {
  const { stack, parent } = setup(BlocksPresets.sandbox);
  new KVStore(parent, 'sessions');
  const template = Template.fromStack(stack);
  template.hasResourceProperties('AWS::DynamoDB::Table', {
    PointInTimeRecoverySpecification: Match.absent(),
  });
});

test('CDK: pointInTimeRecovery { retentionDays } enables PITR and pins the window', () => {
  const { stack, parent } = setup();
  new KVStore(parent, 'sessions', { pointInTimeRecovery: { retentionDays: 7 } });
  const template = Template.fromStack(stack);
  template.hasResourceProperties('AWS::DynamoDB::Table', {
    PointInTimeRecoverySpecification: {
      PointInTimeRecoveryEnabled: true,
      RecoveryPeriodInDays: 7,
    },
  });
});

test('CDK: customer-managed encryption provisions a KMS key', () => {
  const { stack, parent } = setup();
  new KVStore(parent, 'sessions', { encryption: 'customer-managed' });
  const template = Template.fromStack(stack);
  template.resourceCountIs('AWS::KMS::Key', 1);
  template.hasResourceProperties('AWS::DynamoDB::Table', {
    SSESpecification: { SSEEnabled: true, SSEType: 'KMS' },
  });
});

test('CDK: fromKmsKey encrypts with an existing key and provisions no new KMS key', () => {
  const { stack, parent } = setup();
  const keyArn = 'arn:aws:kms:us-east-1:111122223333:key/abcd-1234-ef56';
  new KVStore(parent, 'sessions', { encryption: KVStore.fromKmsKey(keyArn) });
  const template = Template.fromStack(stack);
  // Bringing an existing key must NOT mint a new one (the whole point — a
  // shared key across tables instead of one dedicated key each).
  template.resourceCountIs('AWS::KMS::Key', 0);
  template.hasResourceProperties('AWS::DynamoDB::Table', {
    SSESpecification: { SSEEnabled: true, SSEType: 'KMS', KMSMasterKeyId: keyArn },
  });
});

// Item 1: pin the default (aws-managed) SSE shape. The PR flips the default
// from the AWS-owned key (no SSESpecification emitted) to AWS_MANAGED, which
// emits SSEEnabled:true with no SSEType (the aws/dynamodb key) — an in-place
// SSE change on an already-deployed table. Mirrors bb-distributed-table.

test('CDK: default KVStore emits aws-managed SSE (SSEEnabled, no SSEType)', () => {
  const { stack, parent } = setup();
  new KVStore(parent, 'sessions');
  const template = Template.fromStack(stack);
  // AWS_MANAGED emits SSEEnabled:true with no SSEType (the aws/dynamodb key).
  // Contrast with the AWS-owned default, which emits no SSESpecification at all,
  // and customer-managed, which adds SSEType:'KMS' + a KMSMasterKeyId.
  template.hasResourceProperties('AWS::DynamoDB::Table', {
    SSESpecification: { SSEEnabled: true, SSEType: Match.absent() },
  });
});

// ── PITR opt-out / override / out-of-range (parallel to bb-distributed-table) ──

test('CDK: pointInTimeRecovery: false disables PITR', () => {
  const { stack, parent } = setup();
  // Production default is PITR on; the `??` resolution keeps an explicit
  // `false` (only null/undefined fall through to the stack default), so this
  // pins the opt-out path.
  new KVStore(parent, 'sessions', { pointInTimeRecovery: false });
  const template = Template.fromStack(stack);
  template.hasResourceProperties('AWS::DynamoDB::Table', {
    PointInTimeRecoverySpecification: Match.absent(),
  });
});

test('CDK: options.pointInTimeRecovery overrides the stack defaults (on under sandbox)', () => {
  const { stack, parent } = setup(BlocksPresets.sandbox);
  // Sandbox default is PITR off; the per-block `true` must win. (The existing
  // { retentionDays: 7 } test runs under the production preset, where PITR is
  // already on, so it never exercises the override.)
  new KVStore(parent, 'sessions', { pointInTimeRecovery: true });
  const template = Template.fromStack(stack);
  template.hasResourceProperties('AWS::DynamoDB::Table', {
    PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
  });
});

test('CDK: an out-of-range retentionDays falls back to the default window (still enabled)', () => {
  const { stack, parent } = setup();
  new KVStore(parent, 'sessions', { pointInTimeRecovery: { retentionDays: 60 } });
  const template = Template.fromStack(stack);
  // PITR stays on; the invalid window is dropped so DynamoDB keeps its 35-day
  // default (no RecoveryPeriodInDays emitted).
  template.hasResourceProperties('AWS::DynamoDB::Table', {
    PointInTimeRecoverySpecification: {
      PointInTimeRecoveryEnabled: true,
      RecoveryPeriodInDays: Match.absent(),
    },
  });
});

// ── Synth-time warnings actually fire (not just the fallback values) ─────────

test('CDK: an unrecognized encryption value warns at synth', () => {
  const { stack, parent } = setup();
  // The typed `encryption` union can't express an unrecognized value, so build
  // it at runtime via Object.assign (no cast) to exercise the UnknownEncryption
  // synth guard.
  const options: KVStoreOptions<unknown> = {};
  Object.assign(options, { encryption: 'kms' });
  new KVStore(parent, 'sessions', options);
  Annotations.fromStack(stack).hasWarning('*', Match.stringLikeRegexp('Unrecognized encryption'));
});

test('CDK: an out-of-range retentionDays warns at synth', () => {
  const { stack, parent } = setup();
  new KVStore(parent, 'sessions', { pointInTimeRecovery: { retentionDays: 60 } });
  Annotations.fromStack(stack).hasWarning('*', Match.stringLikeRegexp('retentionDays must be an integer'));
});

test('CDK: durability options passed alongside fromExisting warn at synth', () => {
  const { stack, parent } = setup();
  new KVStore(parent, 'sessions', {
    table: KVStore.fromExisting('preexisting-table-123'),
    pointInTimeRecovery: { retentionDays: 14 },
    encryption: 'customer-managed',
  });
  Annotations.fromStack(stack).hasWarning('*', Match.stringLikeRegexp('wrapped via fromExisting'));
});

test('CDK: two stores sharing one fromKmsKey ref provision zero KMS keys', () => {
  const { stack, parent } = setup();
  const sharedKey = KVStore.fromKmsKey('arn:aws:kms:us-east-1:111122223333:key/shared-1');
  new KVStore(parent, 'orders', { encryption: sharedKey });
  new KVStore(parent, 'events', { encryption: sharedKey });
  const template = Template.fromStack(stack);
  // Bringing one existing key across two stores must NOT mint any new key.
  template.resourceCountIs('AWS::KMS::Key', 0);
  template.resourceCountIs('AWS::DynamoDB::Table', 2);
});
