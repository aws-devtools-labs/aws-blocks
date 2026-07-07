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

function setup(opts?: { sandbox?: boolean }): { stack: StubBlocksStack; parent: Scope } {
  // Sandbox mode is read via `stack.node.tryGetContext('sandboxMode')`, so
  // seed it on the app context when requested.
  const app = new cdk.App(
    opts?.sandbox ? { context: { sandboxMode: 'true' } } : undefined,
  );
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

// ── removalPolicy / autoDeleteObjects (R6 regression) ────────────────────────
//
// autoDeleteObjects provisions a hidden `Custom::S3AutoDeleteObjects` Lambda
// whose delete behavior stack-level retention Aspects cannot override. It must
// be attached ONLY in sandbox mode — never to a prod bucket, even with an
// explicit `removalPolicy: 'destroy'` — or a "retained" prod bucket would be
// silently emptied on `cdk destroy`.

test('CDK: sandbox default enables DESTROY + auto-delete Lambda', () => {
  const { stack, parent } = setup({ sandbox: true });
  new FileBucket(parent, 'uploads');
  const template = Template.fromStack(stack);
  // Sandbox cleanup ergonomics preserved: bucket is dropped and auto-emptied.
  template.hasResource('AWS::S3::Bucket', { DeletionPolicy: 'Delete' });
  template.resourceCountIs('Custom::S3AutoDeleteObjects', 1);
});

test('CDK: non-sandbox explicit destroy sets DESTROY but NO auto-delete Lambda (regression)', () => {
  const { stack, parent } = setup();
  new FileBucket(parent, 'uploads', { removalPolicy: 'destroy' });
  const template = Template.fromStack(stack);
  // Bucket is marked for deletion, but the un-overridable auto-delete Lambda
  // must NOT be present in a prod stack — this is the core fix.
  template.hasResource('AWS::S3::Bucket', { DeletionPolicy: 'Delete' });
  template.resourceCountIs('Custom::S3AutoDeleteObjects', 0);
});

test('CDK: non-sandbox explicit retain sets RETAIN and no auto-delete Lambda', () => {
  const { stack, parent } = setup();
  new FileBucket(parent, 'uploads', { removalPolicy: 'retain' });
  const template = Template.fromStack(stack);
  template.hasResource('AWS::S3::Bucket', { DeletionPolicy: 'Retain' });
  template.resourceCountIs('Custom::S3AutoDeleteObjects', 0);
});

test('CDK: non-sandbox default omits DESTROY (Aspect-overridable RETAIN) and no auto-delete Lambda', () => {
  const { stack, parent } = setup();
  new FileBucket(parent, 'uploads');
  const template = Template.fromStack(stack);
  // No explicit removalPolicy → CDK default RETAIN, driven by Aspects.
  const buckets = template.findResources('AWS::S3::Bucket', { DeletionPolicy: 'Delete' });
  assert.strictEqual(Object.keys(buckets).length, 0);
  template.resourceCountIs('Custom::S3AutoDeleteObjects', 0);
});
