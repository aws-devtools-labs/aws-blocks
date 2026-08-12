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
import { Template, Match } from 'aws-cdk-lib/assertions';
import { Scope, DEFAULT_NODE_RUNTIME, registerStackBlocksDefaults, BlocksPresets } from '@aws-blocks/core/cdk';
import { KVStore } from './index.cdk.js';

// Minimal BlocksStack-shaped parent. The production code path uses BlocksStack,
// which exposes `handler` on a Lambda that lives inside a `cdk.Stack`. We
// reproduce that here so KVStore can call grantReadWriteData(this.handler)
// and still synth into a real stack.
class StubBlocksStack extends cdk.Stack {
  public readonly handler: cdk.aws_lambda.Function;
  public readonly id: string;
  constructor(scope: Construct, id: string) {
    super(scope, id);
    this.id = id;
    (globalThis as any).CURRENT_BLOCKS_STACK = this;
    this.handler = new cdk.aws_lambda.Function(this, 'StubHandler', {
      runtime: DEFAULT_NODE_RUNTIME,
      handler: 'index.handler',
      code: cdk.aws_lambda.Code.fromInline('exports.handler = async () => {};'),
    });
  }
}

function setup(): { stack: StubBlocksStack; parent: Scope } {
  const app = new cdk.App();
  const stack = new StubBlocksStack(app, 'TestStack');
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

test('CDK: table adopts the stack sandbox defaults (DESTROY, deletion protection off)', () => {
  const { stack, parent } = setup();
  registerStackBlocksDefaults(stack, BlocksPresets.sandbox);
  new KVStore(parent, 'sessions');
  const template = Template.fromStack(stack);
  template.hasResource('AWS::DynamoDB::Table', { DeletionPolicy: 'Delete' });
  template.hasResourceProperties('AWS::DynamoDB::Table', { DeletionProtectionEnabled: false });
});

test('CDK: table adopts the stack production defaults (RETAIN, deletion protection on)', () => {
  const { stack, parent } = setup();
  registerStackBlocksDefaults(stack, BlocksPresets.production);
  new KVStore(parent, 'sessions');
  const template = Template.fromStack(stack);
  template.hasResource('AWS::DynamoDB::Table', { DeletionPolicy: 'Retain' });
  template.hasResourceProperties('AWS::DynamoDB::Table', { DeletionProtectionEnabled: true });
});

test('CDK: per-block removalPolicy overrides the stack default', () => {
  const { stack, parent } = setup();
  registerStackBlocksDefaults(stack, BlocksPresets.production);
  new KVStore(parent, 'sessions', { removalPolicy: 'destroy' });
  const template = Template.fromStack(stack);
  // Per-block 'destroy' wins over the production RETAIN default; deletion
  // protection still follows the stack default (no per-block option for it).
  template.hasResource('AWS::DynamoDB::Table', { DeletionPolicy: 'Delete' });
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
