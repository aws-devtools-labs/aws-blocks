// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * CDK-side regression tests for FileBucket.
 *
 * History: FileBucket.fromExisting was advertised in types but the CDK
 * constructor unconditionally provisioned a new S3 bucket. These tests pin
 * the fix.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import * as cdk from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { Template } from 'aws-cdk-lib/assertions';
import { Scope, DEFAULT_NODE_RUNTIME } from '@aws-blocks/core/cdk';
import { FileBucket } from './index.cdk.js';

class StubBlocksStack extends cdk.Stack {
  public readonly handler: cdk.aws_lambda.Function;
  public readonly executionRole: cdk.aws_iam.IRole;
  public readonly id: string;
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

function setup(): { stack: StubBlocksStack; parent: Scope } {
  const app = new cdk.App();
  // S3 bucket names must be lowercase. The default-mode FileBucket derives
  // its bucket name from the scope chain, so keep ids lowercase.
  const stack = new StubBlocksStack(app, 'teststack');
  const parent = new Scope('app');
  return { stack, parent };
}

test('CDK: default FileBucket provisions an S3 bucket', () => {
  const { stack, parent } = setup();
  new FileBucket(parent, 'uploads');
  const template = Template.fromStack(stack);
  template.resourceCountIs('AWS::S3::Bucket', 1);
});

test('CDK: FileBucket.fromExisting does NOT provision a bucket (regression)', () => {
  const { stack, parent } = setup();
  new FileBucket(parent, 'uploads', {
    bucket: FileBucket.fromExisting('preexisting-bucket-123'),
  });
  const template = Template.fromStack(stack);
  template.resourceCountIs('AWS::S3::Bucket', 0);
});

test('CDK: FileBucket.fromExisting returns a branded ref', () => {
  const ref = FileBucket.fromExisting('foo');
  assert.strictEqual(ref.bucketName, 'foo');
  assert.strictEqual(ref.__brand, 'ExternalBucketRef');
});

test('CDK: default FileBucket with an over-long derived name throws at synth', () => {
  const { parent } = setup();
  // parent id "app" + "-" + a 60-char id => 64 chars, over the S3 limit.
  assert.throws(
    () => new FileBucket(parent, 'u'.repeat(60)),
    (err: unknown) =>
      err instanceof Error &&
      err.name === 'ValidationFailed' &&
      /63-character limit/.test(err.message),
  );
});

test('CDK: fromExisting skips derived-name validation even when the chain is over-long', () => {
  const { parent } = setup();
  assert.doesNotThrow(() =>
    new FileBucket(parent, 'u'.repeat(60), {
      bucket: FileBucket.fromExisting('preexisting-bucket-123'),
    }),
  );
});
