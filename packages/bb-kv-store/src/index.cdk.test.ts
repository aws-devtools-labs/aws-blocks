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
import { Template } from 'aws-cdk-lib/assertions';
import { Scope, DEFAULT_NODE_RUNTIME } from '@aws-blocks/core/cdk';
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

test('CDK: calling a runtime data method throws an actionable error (not a cryptic TypeError)', () => {
  const { parent } = setup();
  const store = new KVStore(parent, 'sessions') as any;
  for (const method of ['get', 'put', 'delete', 'scan', 'toAgentTools']) {
    assert.throws(
      () => store[method]('k'),
      /cannot be called during CDK synth/,
      `${method}() should throw the actionable synth-time error`,
    );
  }
});
