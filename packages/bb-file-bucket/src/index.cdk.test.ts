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
import { RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Scope, DEFAULT_NODE_RUNTIME, BlocksPresets, type BlocksDefaults } from '@aws-blocks/core/cdk';
import { FileBucket } from './index.cdk.js';

// Minimal BlocksStack-shaped parent. The production code path uses BlocksStack,
// which exposes the shared `executionRole` (blocks grant to it) plus `handler`,
// both living inside a `cdk.Stack`. We reproduce them here so FileBucket can
// call grantReadWrite(this.executionRole) and still synth into a real stack. It
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
  // S3 bucket names must be lowercase. The default-mode FileBucket derives
  // its bucket name from the scope chain, so keep ids lowercase.
  const stack = new StubBlocksStack(app, 'teststack');
  stack.defaults = defaults;
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

// ── Posture routed through BlocksDefaults (PR review comment C) ──────────────

test('CDK: default FileBucket adopts the SANDBOX removal posture (DESTROY + autoDelete)', () => {
  const { stack, parent } = setup(BlocksPresets.sandbox);
  new FileBucket(parent, 'uploads');
  const template = Template.fromStack(stack);
  // DESTROY removal policy plus the auto-delete custom resource CDK wires in
  // only when autoDeleteObjects is true.
  template.hasResource('AWS::S3::Bucket', { DeletionPolicy: 'Delete' });
  template.resourceCountIs('Custom::S3AutoDeleteObjects', 1);
});

test('CDK: default FileBucket adopts the PRODUCTION removal posture (RETAIN, no autoDelete)', () => {
  const { stack, parent } = setup(BlocksPresets.production);
  new FileBucket(parent, 'uploads');
  const template = Template.fromStack(stack);
  template.hasResource('AWS::S3::Bucket', { DeletionPolicy: 'Retain' });
  template.resourceCountIs('Custom::S3AutoDeleteObjects', 0);
});

test('CDK: per-block removalPolicy overrides the resolved default', () => {
  const { stack, parent } = setup(BlocksPresets.production);
  new FileBucket(parent, 'uploads', { removalPolicy: 'destroy' });
  const template = Template.fromStack(stack);
  // Per-block 'destroy' wins over the production RETAIN default and enables
  // autoDeleteObjects alongside it.
  template.hasResource('AWS::S3::Bucket', { DeletionPolicy: 'Delete' });
  template.resourceCountIs('Custom::S3AutoDeleteObjects', 1);
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
  // Log bucket expires access logs after the framework logRetention default
  // (production preset => ONE_YEAR => 365 days).
  assert.ok(
    ((logResource.Properties as any).LifecycleConfiguration.Rules as any[]).some(
      (r) => r.ExpirationInDays === 365 && r.Status === 'Enabled',
    ),
    'log bucket must expire access logs after the production logRetention (365 days)',
  );
  // Log bucket blocks all public access.
  assert.deepStrictEqual((logResource.Properties as any).PublicAccessBlockConfiguration, {
    BlockPublicAcls: true,
    BlockPublicPolicy: true,
    IgnorePublicAcls: true,
    RestrictPublicBuckets: true,
  });
});

test('CDK: accessLogging resolves from defaults — a preset opting in creates the log bucket with no per-block option', () => {
  const { stack, parent } = setup({ ...BlocksPresets.production, accessLogging: true });
  new FileBucket(parent, 'uploads');
  const template = Template.fromStack(stack);
  // No per-block accessLogging option, yet the resolved default enables it.
  template.resourceCountIs('AWS::S3::Bucket', 2);
});

test('CDK: access-log lifecycle expiration equals Duration.days(defaults.logRetention) — sandbox = 7', () => {
  const { stack, parent } = setup({ ...BlocksPresets.sandbox, accessLogging: true });
  new FileBucket(parent, 'uploads', { removalPolicy: 'retain' });
  const template = Template.fromStack(stack);
  // The per-block 'retain' override wins over the sandbox DESTROY default: the
  // main bucket is retained on teardown.
  template.hasResource('AWS::S3::Bucket', { DeletionPolicy: 'Retain' });
  const buckets = template.findResources('AWS::S3::Bucket');
  const logEntry = Object.values(buckets).find(
    (r) => (r.Properties as any).BucketName === undefined,
  );
  assert.ok(logEntry, 'expected a log bucket');
  assert.ok(
    ((logEntry!.Properties as any).LifecycleConfiguration.Rules as any[]).some(
      (r) => r.ExpirationInDays === 7 && r.Status === 'Enabled',
    ),
    'log bucket must expire access logs after the sandbox logRetention (ONE_WEEK = 7 days)',
  );
});

test('CDK: no access-log bucket is created when accessLogging resolves false', () => {
  const { stack, parent } = setup();
  new FileBucket(parent, 'uploads');
  const template = Template.fromStack(stack);
  template.resourceCountIs('AWS::S3::Bucket', 1);
});

test('CDK: logRetention INFINITE omits the access-log lifecycle rule (logs kept indefinitely)', () => {
  const { stack, parent } = setup({
    ...BlocksPresets.production,
    logRetention: RetentionDays.INFINITE,
    accessLogging: true,
  });
  new FileBucket(parent, 'uploads');
  const template = Template.fromStack(stack);
  // Main bucket + log bucket both exist.
  template.resourceCountIs('AWS::S3::Bucket', 2);
  // The access-LOG bucket (the one without a derived BucketName) must carry NO
  // LifecycleConfiguration at all — INFINITE means "never expire", so the rule
  // is omitted rather than emitted at a spurious 9999-day expiry.
  const buckets = template.findResources('AWS::S3::Bucket');
  const logEntry = Object.values(buckets).find(
    (r) => (r.Properties as any).BucketName === undefined,
  );
  assert.ok(logEntry, 'expected a log bucket');
  assert.strictEqual(
    (logEntry!.Properties as any).LifecycleConfiguration,
    undefined,
    'INFINITE logRetention must omit the access-log LifecycleConfiguration entirely',
  );
});

test('CDK: per-block accessLogging:false overrides a defaults-enabled preset (?? treats explicit false as non-nullish)', () => {
  const { stack, parent } = setup({ ...BlocksPresets.production, accessLogging: true });
  new FileBucket(parent, 'uploads', { accessLogging: false });
  const template = Template.fromStack(stack);
  // Defaults opt logging in, but the explicit per-block `false` wins: only the
  // main bucket is provisioned, no dedicated access-log bucket.
  template.resourceCountIs('AWS::S3::Bucket', 1);
});

// ── Noncurrent-version expiration (PR review comment A) ──────────────────────

test('CDK: versioned bucket expires noncurrent versions after the default 90 days', () => {
  const { stack, parent } = setup();
  new FileBucket(parent, 'uploads');
  const template = Template.fromStack(stack);
  template.hasResourceProperties('AWS::S3::Bucket', Match.objectLike({
    VersioningConfiguration: { Status: 'Enabled' },
    LifecycleConfiguration: Match.objectLike({
      Rules: Match.arrayWith([
        Match.objectLike({
          NoncurrentVersionExpiration: { NoncurrentDays: 90 },
          Status: 'Enabled',
        }),
      ]),
    }),
  }));
});

test('CDK: noncurrentVersionExpirationDays is honored', () => {
  const { stack, parent } = setup();
  new FileBucket(parent, 'uploads', { noncurrentVersionExpirationDays: 30 });
  const template = Template.fromStack(stack);
  template.hasResourceProperties('AWS::S3::Bucket', Match.objectLike({
    LifecycleConfiguration: Match.objectLike({
      Rules: Match.arrayWith([
        Match.objectLike({ NoncurrentVersionExpiration: { NoncurrentDays: 30 } }),
      ]),
    }),
  }));
});

test('CDK: noncurrentVersionExpirationDays of 0 throws at synth', () => {
  const { parent } = setup();
  assert.throws(
    () => new FileBucket(parent, 'uploads', { noncurrentVersionExpirationDays: 0 }),
    (err: unknown) =>
      err instanceof Error &&
      /noncurrentVersionExpirationDays must be a positive integer/.test(err.message) &&
      /got 0/.test(err.message),
  );
});

test('CDK: negative noncurrentVersionExpirationDays throws at synth', () => {
  const { parent } = setup();
  assert.throws(
    () => new FileBucket(parent, 'uploads', { noncurrentVersionExpirationDays: -1 }),
    (err: unknown) =>
      err instanceof Error &&
      /noncurrentVersionExpirationDays must be a positive integer/.test(err.message) &&
      /got -1/.test(err.message),
  );
});

test('CDK: non-integer noncurrentVersionExpirationDays throws at synth', () => {
  const { parent } = setup();
  assert.throws(
    () => new FileBucket(parent, 'uploads', { noncurrentVersionExpirationDays: 1.5 }),
    (err: unknown) =>
      err instanceof Error &&
      /noncurrentVersionExpirationDays must be a positive integer/.test(err.message),
  );
});

test('CDK: versioned:false bucket has NO noncurrent-version expiration rule', () => {
  const { stack, parent } = setup();
  new FileBucket(parent, 'uploads', { versioned: false });
  const template = Template.fromStack(stack);
  const buckets = template.findResources('AWS::S3::Bucket');
  const props = (Object.values(buckets)[0].Properties ?? {}) as any;
  const rules: any[] = props.LifecycleConfiguration?.Rules ?? [];
  assert.ok(
    !rules.some((r) => r.NoncurrentVersionExpiration !== undefined),
    'a non-versioned bucket must not carry a noncurrent-version expiration rule',
  );
});

test('CDK: noncurrentVersionExpirationDays FORMAT is validated even when versioned:false', () => {
  // The format guard is decoupled from the `versioned` gate: a malformed value
  // must fail loudly at synth regardless of whether versioning is on, rather
  // than being silently ignored because the rule would not be applied.
  for (const bad of [0, -1, 1.5]) {
    const { parent } = setup();
    assert.throws(
      () => new FileBucket(parent, 'uploads', { versioned: false, noncurrentVersionExpirationDays: bad }),
      (err: unknown) =>
        err instanceof Error &&
        /noncurrentVersionExpirationDays must be a positive integer/.test(err.message) &&
        new RegExp(`got ${bad}`).test(err.message),
      `versioned:false with noncurrentVersionExpirationDays=${bad} must throw at synth`,
    );
  }
});

test('CDK: versioned:false with NO noncurrent option does not throw and adds no noncurrent rule', () => {
  const { stack, parent } = setup();
  assert.doesNotThrow(() => new FileBucket(parent, 'uploads', { versioned: false }));
  const template = Template.fromStack(stack);
  const buckets = template.findResources('AWS::S3::Bucket');
  const props = (Object.values(buckets)[0].Properties ?? {}) as any;
  const rules: any[] = props.LifecycleConfiguration?.Rules ?? [];
  assert.ok(
    !rules.some((r) => r.NoncurrentVersionExpiration !== undefined),
    'versioned:false with no noncurrent option must add no noncurrent-version expiration rule',
  );
});

// ── CORS synth guard (unchanged behavior) ───────────────────────────────────

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

// ── Encryption at rest ──────────────────────────────────────────────────────

const KEY_ARN = 'arn:aws:kms:us-east-1:111122223333:key/abcd-1234';

function dataBucket(template: Template): Record<string, any> {
  const buckets = template.findResources('AWS::S3::Bucket', {
    Properties: { BucketName: Match.stringLikeRegexp('uploads') },
  });
  const [only] = Object.values(buckets);
  assert.ok(only, 'expected the data bucket');
  return only.Properties;
}

test('CDK: default encryption stays SSE-S3 with no KMS key', () => {
  const { stack, parent } = setup();
  new FileBucket(parent, 'uploads');
  const template = Template.fromStack(stack);
  assert.deepStrictEqual(dataBucket(template).BucketEncryption, {
    ServerSideEncryptionConfiguration: [{ ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }],
  });
  template.resourceCountIs('AWS::KMS::Key', 0);
});

test("CDK: encryption 'customer-managed' mints a rotating CMK and uses SSE-KMS with a Bucket Key", () => {
  const { stack, parent } = setup();
  new FileBucket(parent, 'uploads', { encryption: 'customer-managed' });
  const template = Template.fromStack(stack);
  template.resourceCountIs('AWS::KMS::Key', 1);
  template.hasResourceProperties('AWS::KMS::Key', { EnableKeyRotation: true });
  const [rule] = dataBucket(template).BucketEncryption.ServerSideEncryptionConfiguration;
  assert.strictEqual(rule.ServerSideEncryptionByDefault.SSEAlgorithm, 'aws:kms');
  assert.ok(rule.ServerSideEncryptionByDefault.KMSMasterKeyID, 'bucket points at the minted key');
  assert.strictEqual(rule.BucketKeyEnabled, true);
});

test("CDK: the 'customer-managed' key follows the bucket's removal policy (sandbox DESTROY, production RETAIN)", () => {
  for (const [defaults, policy] of [[BlocksPresets.sandbox, 'Delete'], [BlocksPresets.production, 'Retain']] as const) {
    const { stack, parent } = setup(defaults);
    new FileBucket(parent, 'uploads', { encryption: 'customer-managed' });
    Template.fromStack(stack).hasResource('AWS::KMS::Key', { DeletionPolicy: policy, UpdateReplacePolicy: policy });
  }
});

test('CDK: encryption FileBucket.fromKmsKey(arn) uses that key and mints none', () => {
  const { stack, parent } = setup();
  new FileBucket(parent, 'uploads', { encryption: FileBucket.fromKmsKey(KEY_ARN) });
  const template = Template.fromStack(stack);
  template.resourceCountIs('AWS::KMS::Key', 0);
  const [rule] = dataBucket(template).BucketEncryption.ServerSideEncryptionConfiguration;
  assert.deepStrictEqual(rule.ServerSideEncryptionByDefault, { SSEAlgorithm: 'aws:kms', KMSMasterKeyID: KEY_ARN });
  assert.strictEqual(rule.BucketKeyEnabled, true);
});

test('CDK: SSE-KMS grants the runtime role encrypt/decrypt on the key', () => {
  const { stack, parent } = setup();
  new FileBucket(parent, 'uploads', { encryption: FileBucket.fromKmsKey(KEY_ARN) });
  Template.fromStack(stack).hasResourceProperties('AWS::IAM::Policy', {
    PolicyDocument: {
      Statement: Match.arrayWith([
        Match.objectLike({
          Action: Match.arrayWith(['kms:Decrypt', 'kms:GenerateDataKey*']),
          Resource: KEY_ARN,
        }),
      ]),
    },
  });
});

test('CDK: the access-log bucket stays SSE-S3 when the data bucket uses SSE-KMS', () => {
  const { stack, parent } = setup();
  new FileBucket(parent, 'uploads', { encryption: 'customer-managed', accessLogging: true });
  const template = Template.fromStack(stack);
  const logBuckets = Object.values(template.findResources('AWS::S3::Bucket')).filter(
    (b: any) => b.Properties.BucketName === undefined,
  );
  assert.strictEqual(logBuckets.length, 1);
  assert.deepStrictEqual((logBuckets[0] as any).Properties.BucketEncryption, {
    ServerSideEncryptionConfiguration: [{ ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }],
  });
});

test('CDK: an unrecognized encryption value warns and falls back to SSE-S3', () => {
  const { stack, parent } = setup();
  // Deliberately invalid input (a typo a JS caller could pass).
  new FileBucket(parent, 'uploads', { encryption: 'kms' as unknown as 'aws-managed' });
  const template = Template.fromStack(stack);
  template.resourceCountIs('AWS::KMS::Key', 0);
  const warnings = cdk.assertions.Annotations.fromStack(stack).findWarning('*', Match.stringLikeRegexp('Unrecognized encryption'));
  assert.strictEqual(warnings.length, 1);
});

test('CDK: fromExisting ignores encryption (no key minted for a wrapped bucket)', () => {
  const { stack, parent } = setup();
  new FileBucket(parent, 'uploads', { bucket: FileBucket.fromExisting('existing'), encryption: 'customer-managed' });
  Template.fromStack(stack).resourceCountIs('AWS::KMS::Key', 0);
});

// ── Object Lock ─────────────────────────────────────────────────────────────

test('CDK: objectLock enables Object Lock with the default retention (governance)', () => {
  const { stack, parent } = setup();
  new FileBucket(parent, 'uploads', { objectLock: { mode: 'governance', retentionDays: 30 } });
  const props = dataBucket(Template.fromStack(stack));
  assert.strictEqual(props.ObjectLockEnabled, true);
  assert.deepStrictEqual(props.ObjectLockConfiguration, {
    ObjectLockEnabled: 'Enabled',
    Rule: { DefaultRetention: { Mode: 'GOVERNANCE', Days: 30 } },
  });
  assert.deepStrictEqual(props.VersioningConfiguration, { Status: 'Enabled' });
});

test('CDK: objectLock compliance mode maps to COMPLIANCE', () => {
  const { stack, parent } = setup();
  new FileBucket(parent, 'uploads', { objectLock: { mode: 'compliance', retentionDays: 365 } });
  assert.deepStrictEqual(dataBucket(Template.fromStack(stack)).ObjectLockConfiguration.Rule, {
    DefaultRetention: { Mode: 'COMPLIANCE', Days: 365 },
  });
});

test('CDK: no objectLock leaves Object Lock off', () => {
  const { stack, parent } = setup();
  new FileBucket(parent, 'uploads');
  const props = dataBucket(Template.fromStack(stack));
  assert.strictEqual(props.ObjectLockEnabled, undefined);
  assert.strictEqual(props.ObjectLockConfiguration, undefined);
});

test('CDK: objectLock with versioned:false throws at synth', () => {
  const { parent } = setup();
  assert.throws(
    () => new FileBucket(parent, 'uploads', { versioned: false, objectLock: { mode: 'governance', retentionDays: 30 } }),
    (err: Error) => /objectLock requires versioning/.test(err.message),
  );
});

test('CDK: objectLock under the sandbox preset (DESTROY) throws at synth', () => {
  const { parent } = setup(BlocksPresets.sandbox);
  assert.throws(
    () => new FileBucket(parent, 'uploads', { objectLock: { mode: 'governance', retentionDays: 30 } }),
    (err: Error) => /objectLock can't be combined with a 'destroy' removal policy/.test(err.message)
      && /removalPolicy: 'retain'/.test(err.message),
  );
});

test("CDK: objectLock with an explicit removalPolicy 'destroy' throws at synth", () => {
  const { parent } = setup();
  assert.throws(
    () => new FileBucket(parent, 'uploads', { removalPolicy: 'destroy', objectLock: { mode: 'governance', retentionDays: 30 } }),
    /objectLock can't be combined with a 'destroy' removal policy/,
  );
});

test("CDK: objectLock in a sandbox works with removalPolicy 'retain' (no auto-delete)", () => {
  const { stack, parent } = setup(BlocksPresets.sandbox);
  new FileBucket(parent, 'uploads', { removalPolicy: 'retain', objectLock: { mode: 'governance', retentionDays: 1 } });
  const template = Template.fromStack(stack);
  assert.strictEqual(dataBucket(template).ObjectLockEnabled, true);
  template.resourceCountIs('Custom::S3AutoDeleteObjects', 0);
});

test('CDK: invalid objectLock retentionDays / mode throw at synth', () => {
  for (const retentionDays of [0, -1, 1.5, 36501]) {
    const { parent } = setup();
    assert.throws(
      () => new FileBucket(parent, 'uploads', { objectLock: { mode: 'governance', retentionDays } }),
      /objectLock\.retentionDays must be an integer between 1 and 36500/,
    );
  }
  const { parent } = setup();
  assert.throws(
    () => new FileBucket(parent, 'uploads', { objectLock: { mode: 'legal-hold' as unknown as 'governance', retentionDays: 1 } }),
    /objectLock\.mode must be 'governance' or 'compliance'/,
  );
});

// ── storageAccessLogging default ────────────────────────────────────────────

function logBucketCount(stack: cdk.Stack): number {
  return Object.values(Template.fromStack(stack).findResources('AWS::S3::Bucket')).filter(
    (b: any) => b.Properties.BucketName === undefined,
  ).length;
}

test('CDK: defaults.storageAccessLogging true enables S3 access logs while API accessLogging stays off', () => {
  const { stack, parent } = setup({ ...BlocksPresets.production, storageAccessLogging: true });
  new FileBucket(parent, 'uploads');
  assert.strictEqual(logBucketCount(stack), 1);
});

test('CDK: defaults.storageAccessLogging false wins over accessLogging true', () => {
  const { stack, parent } = setup({ ...BlocksPresets.production, accessLogging: true, storageAccessLogging: false });
  new FileBucket(parent, 'uploads');
  assert.strictEqual(logBucketCount(stack), 0);
});

test('CDK: per-block accessLogging wins over defaults.storageAccessLogging', () => {
  const { stack, parent } = setup({ ...BlocksPresets.production, storageAccessLogging: true });
  new FileBucket(parent, 'uploads', { accessLogging: false });
  assert.strictEqual(logBucketCount(stack), 0);
});

test('CDK: both presets leave storageAccessLogging unset, so behavior is unchanged', () => {
  assert.ok(!('storageAccessLogging' in BlocksPresets.production));
  assert.ok(!('storageAccessLogging' in BlocksPresets.sandbox));
  const { stack, parent } = setup();
  new FileBucket(parent, 'uploads');
  assert.strictEqual(logBucketCount(stack), 0);
});
