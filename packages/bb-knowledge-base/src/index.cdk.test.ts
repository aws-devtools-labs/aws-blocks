// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * CDK-side teardown tests for KnowledgeBase.
 *
 * History: the data `s3.Bucket` paired `RemovalPolicy.DESTROY` with
 * `autoDeleteObjects` on a `destroy`/sandbox teardown, but the S3 Vectors L1
 * resources (`CfnVectorBucket` + `CfnIndex`) relied solely on their default
 * CloudFormation `DeletionPolicy` and leaked. These tests pin the fix: the
 * vector resources now mirror the data bucket's removal policy.
 */
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import * as cdk from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { Template } from 'aws-cdk-lib/assertions';
import * as s3vectors from 'aws-cdk-lib/aws-s3vectors';
import { Scope, DEFAULT_NODE_RUNTIME } from '@aws-blocks/core/cdk';
import { KnowledgeBase } from './index.cdk.js';

// Real local-folder source so BucketDeployment + sidecar generation synth.
const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'test-fixtures', 'knowledge');

// Pull CFN type names off the L1 classes so the assertions don't drift if AWS
// renames the underlying resource types.
const VECTOR_BUCKET_TYPE = s3vectors.CfnVectorBucket.CFN_RESOURCE_TYPE_NAME;
const VECTOR_INDEX_TYPE = s3vectors.CfnIndex.CFN_RESOURCE_TYPE_NAME;

// Minimal BlocksStack-shaped parent — KnowledgeBase calls
// `this.handler.addToRolePolicy(...)` and `cdk.Stack.of(this)`, both of which
// resolve through CURRENT_BLOCKS_STACK (mirrors the production BlocksStack).
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

function synth(options: { removalPolicy?: 'destroy' | 'retain'; sandbox?: boolean } = {}): Template {
  const app = new cdk.App(options.sandbox ? { context: { sandboxMode: 'true' } } : undefined);
  // S3 bucket names must be lowercase; the data bucket derives its name from
  // the scope chain, so keep ids lowercase.
  const stack = new StubBlocksStack(app, 'teststack');
  const parent = new Scope('app');
  new KnowledgeBase(parent, 'docs', {
    source: FIXTURES,
    ...(options.removalPolicy ? { removalPolicy: options.removalPolicy } : {}),
  });
  return Template.fromStack(stack);
}

test("CDK: removalPolicy 'destroy' makes the data bucket + vector store deletable and adds auto-delete", () => {
  const template = synth({ removalPolicy: 'destroy' });

  // Data bucket: force-deletable and auto-empties on teardown.
  template.hasResource('AWS::S3::Bucket', { DeletionPolicy: 'Delete' });
  template.resourceCountIs('Custom::S3AutoDeleteObjects', 1);

  // S3 Vectors resources mirror the data bucket — dropped on teardown.
  template.hasResource(VECTOR_BUCKET_TYPE, { DeletionPolicy: 'Delete' });
  template.hasResource(VECTOR_INDEX_TYPE, { DeletionPolicy: 'Delete' });
});

test("CDK: removalPolicy 'retain' keeps the data bucket + vector store and omits auto-delete", () => {
  const template = synth({ removalPolicy: 'retain' });

  template.hasResource('AWS::S3::Bucket', { DeletionPolicy: 'Retain' });
  template.resourceCountIs('Custom::S3AutoDeleteObjects', 0);

  template.hasResource(VECTOR_BUCKET_TYPE, { DeletionPolicy: 'Retain' });
  template.hasResource(VECTOR_INDEX_TYPE, { DeletionPolicy: 'Retain' });
});

test('CDK: sandboxMode context defaults the data bucket + vector store to destroy', () => {
  const template = synth({ sandbox: true });

  template.hasResource('AWS::S3::Bucket', { DeletionPolicy: 'Delete' });
  template.resourceCountIs('Custom::S3AutoDeleteObjects', 1);

  template.hasResource(VECTOR_BUCKET_TYPE, { DeletionPolicy: 'Delete' });
  template.hasResource(VECTOR_INDEX_TYPE, { DeletionPolicy: 'Delete' });
});
