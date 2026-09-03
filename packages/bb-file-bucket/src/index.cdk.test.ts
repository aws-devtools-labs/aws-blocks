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
import { Template, Match } from 'aws-cdk-lib/assertions';
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

// ── Security hardening: secure defaults ─────────────────────────────────────

test('CDK: default FileBucket enforces SSL (aws:SecureTransport deny)', () => {
  const { stack, parent } = setup();
  new FileBucket(parent, 'uploads');
  const template = Template.fromStack(stack);
  // enforceSSL:true makes CDK attach a bucket policy denying non-TLS requests.
  template.hasResourceProperties('AWS::S3::BucketPolicy', Match.objectLike({
    PolicyDocument: Match.objectLike({
      Statement: Match.arrayWith([
        Match.objectLike({
          Effect: 'Deny',
          Condition: { Bool: { 'aws:SecureTransport': 'false' } },
        }),
      ]),
    }),
  }));
});

test('CDK: default FileBucket enables versioning (new secure default)', () => {
  const { stack, parent } = setup();
  new FileBucket(parent, 'uploads');
  const template = Template.fromStack(stack);
  template.hasResourceProperties('AWS::S3::Bucket', Match.objectLike({
    VersioningConfiguration: { Status: 'Enabled' },
  }));
});

test('CDK: versioned:false opt-out disables versioning', () => {
  const { stack, parent } = setup();
  new FileBucket(parent, 'uploads', { versioned: false });
  const template = Template.fromStack(stack);
  // No VersioningConfiguration is emitted when versioning is disabled.
  const buckets = template.findResources('AWS::S3::Bucket');
  const props = Object.values(buckets)[0].Properties ?? {};
  assert.strictEqual((props as any).VersioningConfiguration, undefined);
});

test('CDK: accessLogging provisions a locked-down log bucket with lifecycle + logging config', () => {
  const { stack, parent } = setup();
  new FileBucket(parent, 'uploads', { accessLogging: true });
  const template = Template.fromStack(stack);
  // Main bucket + dedicated access-log bucket.
  template.resourceCountIs('AWS::S3::Bucket', 2);
  // Both buckets are TLS-enforced: enforceSSL:true attaches a bucket policy
  // with an aws:SecureTransport deny to EACH bucket (main + log bucket), so
  // the log bucket is provably locked down, not just the main one.
  template.resourceCountIs('AWS::S3::BucketPolicy', 2);
  const policies = template.findResources('AWS::S3::BucketPolicy');
  for (const policy of Object.values(policies)) {
    assert.ok(
      (policy.Properties.PolicyDocument.Statement as any[]).some(
        (s) =>
          s.Effect === 'Deny' &&
          s.Condition?.Bool?.['aws:SecureTransport'] === 'false',
      ),
      'every bucket (main + log) must have an enforceSSL deny statement',
    );
  }
  // Distinguish the two buckets: the main bucket carries the derived
  // BucketName; the log bucket does not. Prove the MAIN bucket's
  // LoggingConfiguration points at the LOG bucket specifically.
  const buckets = template.findResources('AWS::S3::Bucket');
  const entries = Object.entries(buckets);
  const mainEntry = entries.find(([, r]) => (r.Properties as any).BucketName !== undefined);
  const logEntry = entries.find(([id]) => id !== mainEntry?.[0]);
  assert.ok(mainEntry && logEntry, 'expected one named main bucket and one log bucket');
  const [logLogicalId, logResource] = logEntry;
  // Main bucket delivers its access logs to the log bucket under access-logs/.
  assert.deepStrictEqual(
    (mainEntry[1].Properties as any).LoggingConfiguration,
    { DestinationBucketName: { Ref: logLogicalId }, LogFilePrefix: 'access-logs/' },
  );
  // Log bucket expires access logs after the default retention (90 days).
  assert.ok(
    ((logResource.Properties as any).LifecycleConfiguration.Rules as any[]).some(
      (r) => r.ExpirationInDays === 90 && r.Status === 'Enabled',
    ),
    'log bucket must expire access logs after 90 days',
  );
  // Log bucket blocks all public access.
  assert.deepStrictEqual((logResource.Properties as any).PublicAccessBlockConfiguration, {
    BlockPublicAcls: true,
    BlockPublicPolicy: true,
    IgnorePublicAcls: true,
    RestrictPublicBuckets: true,
  });
});

test('CDK: accessLogging honors custom logRetentionDays', () => {
  const { stack, parent } = setup();
  new FileBucket(parent, 'uploads', { accessLogging: true, logRetentionDays: 7 });
  const template = Template.fromStack(stack);
  template.hasResourceProperties('AWS::S3::Bucket', Match.objectLike({
    LifecycleConfiguration: Match.objectLike({
      Rules: Match.arrayWith([
        Match.objectLike({ ExpirationInDays: 7, Status: 'Enabled' }),
      ]),
    }),
  }));
});

test('CDK: logRetentionDays of 0 throws at synth', () => {
  const { parent } = setup();
  assert.throws(
    () => new FileBucket(parent, 'uploads', { accessLogging: true, logRetentionDays: 0 }),
    (err: unknown) =>
      err instanceof Error &&
      /logRetentionDays must be a positive integer/.test(err.message) &&
      /got 0/.test(err.message),
  );
});

test('CDK: negative logRetentionDays throws at synth', () => {
  const { parent } = setup();
  assert.throws(
    () => new FileBucket(parent, 'uploads', { accessLogging: true, logRetentionDays: -1 }),
    (err: unknown) =>
      err instanceof Error &&
      /logRetentionDays must be a positive integer/.test(err.message) &&
      /got -1/.test(err.message),
  );
});

test('CDK: non-integer logRetentionDays throws at synth', () => {
  const { parent } = setup();
  assert.throws(
    () => new FileBucket(parent, 'uploads', { accessLogging: true, logRetentionDays: 1.5 }),
    (err: unknown) =>
      err instanceof Error &&
      /logRetentionDays must be a positive integer/.test(err.message),
  );
});

test('CDK: logRetentionDays is ignored (no throw) when accessLogging is off', () => {
  const { parent } = setup();
  // Without accessLogging the value is inert, so a non-positive value must
  // NOT fail synth — there is no lifecycle to make degenerate.
  assert.doesNotThrow(
    () => new FileBucket(parent, 'uploads', { logRetentionDays: 0 }),
  );
});

test('CDK: no access-log bucket is created when accessLogging is off', () => {
  const { stack, parent } = setup();
  new FileBucket(parent, 'uploads');
  const template = Template.fromStack(stack);
  template.resourceCountIs('AWS::S3::Bucket', 1);
});

test('CDK: wildcard-origin CORS with a mutating method throws at synth', () => {
  const { parent } = setup();
  assert.throws(
    () =>
      new FileBucket(parent, 'uploads', {
        corsRules: [
          { allowedOrigins: ['*'], allowedMethods: ['GET', 'PUT'] },
        ],
      }),
    (err: unknown) =>
      err instanceof Error &&
      /\*/.test(err.message) &&
      /PUT/.test(err.message),
  );
});

test('CDK: wildcard-origin CORS with only safe methods is allowed', () => {
  const { parent } = setup();
  assert.doesNotThrow(() =>
    new FileBucket(parent, 'uploads', {
      corsRules: [{ allowedOrigins: ['*'], allowedMethods: ['GET', 'HEAD'] }],
    }),
  );
});

test('CDK: explicit-origin CORS with a mutating method is allowed', () => {
  const { parent } = setup();
  assert.doesNotThrow(() =>
    new FileBucket(parent, 'uploads', {
      corsRules: [
        { allowedOrigins: ['https://app.example.com'], allowedMethods: ['PUT', 'POST'] },
      ],
    }),
  );
});
