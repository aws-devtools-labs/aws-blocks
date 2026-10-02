// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * CDK tests for the config registry — specifically the getConfigLocation ↔ finalizeConfigRegistry
 * interaction. `getConfigLocation()` creates the config bucket eagerly (so co-located compute can
 * inject BLOCKS_CONFIG_BUCKET/KEY at construction); finalize must therefore still upload the config
 * object + wire the computes whenever a bucket exists, even if zero entries were registered —
 * otherwise that compute's loadConfigToProcessEnv() would 404 forever against a created-but-empty
 * bucket.
 */
import assert from 'node:assert';
import { afterEach, test } from 'node:test';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import type { IWidget } from 'aws-cdk-lib/aws-cloudwatch';
import { Construct } from 'constructs';
import { type BlocksDefaults, BlocksPresets } from './blocks-defaults.js';
import { Compute } from './compute/compute.js';
import { finalizeConfigRegistry, getConfigLocation, registerConfig } from './config-registry.js';
import { DEFAULT_NODE_RUNTIME } from './node-version.js';

// getConfigLocation reads globalThis.CURRENT_BLOCKS_STACK to place the bucket under the owning
// stack/backend; clear it between tests so one test's owner never leaks into another.
afterEach(() => {
	delete (globalThis as any).CURRENT_BLOCKS_STACK;
});

// A real app's compute comes from @aws-blocks/bb-lambda-compute, which core's own tests can't
// depend on. This is the same shape: a Compute that owns a real Lambda function and injects config
// via addEnvironment — enough for finalizeConfigRegistry to stamp BLOCKS_CONFIG_BUCKET/KEY on it.
class TestCompute extends Compute {
	readonly fn: cdk.aws_lambda.Function;

	constructor(scope: Construct, id: string) {
		super(id, { parent: scope as never });
		this.fn = new cdk.aws_lambda.Function(this, 'Handler', {
			runtime: DEFAULT_NODE_RUNTIME,
			handler: 'index.handler',
			code: cdk.aws_lambda.Code.fromInline('exports.handler = async () => {};'),
		});
	}

	setEnv(key: string, value: string): void {
		this.fn.addEnvironment(key, value);
	}

	// Observability hooks are irrelevant to config-registry tests — stub them so
	// this test double satisfies Compute's abstract contract.
	protected applyTracing(): void {}
	protected healthWidgets(): IWidget[][] {
		return [];
	}
	protected loggingWidgets(): IWidget[][] {
		return [];
	}
	protected tracingWidgets(): IWidget[][] {
		return [];
	}
}

function stackWithCompute(id: string): {
	stack: cdk.Stack;
	role: cdk.aws_iam.Role;
	computes: readonly Compute[];
} {
	const app = new cdk.App();
	const stack = new cdk.Stack(app, id);
	const role = new cdk.aws_iam.Role(stack, 'BlocksRole', {
		assumedBy: new cdk.aws_iam.ServicePrincipal('lambda.amazonaws.com'),
	});
	const compute = new TestCompute(stack, 'Compute');
	return { stack, role, computes: [compute] };
}

// A cdk.Stack that also exposes `.defaults`, standing in for a real BlocksStack/BlocksBackend.
// ensureConfigBucket resolves the log bucket's removal + retention posture from the owning
// stack/backend's `.defaults` (globalThis.CURRENT_BLOCKS_STACK, else the stack). A subclass carrying
// the field exercises that path without a cast and keeps the root-level logical IDs the assertions
// below anchor on.
class PresetStack extends cdk.Stack {
	readonly defaults: BlocksDefaults;
	constructor(scope: Construct, id: string, defaults: BlocksDefaults) {
		super(scope, id);
		this.defaults = defaults;
	}
}

function synthWithPreset(preset: 'sandbox' | 'production'): Template {
	const app = new cdk.App();
	const stack = new PresetStack(app, `Preset${preset}`, BlocksPresets[preset]);
	const role = new cdk.aws_iam.Role(stack, 'BlocksRole', {
		assumedBy: new cdk.aws_iam.ServicePrincipal('lambda.amazonaws.com'),
	});
	const compute = new TestCompute(stack, 'Compute');
	registerConfig(stack, 'BLOCKS_SOMETHING', 'value');
	finalizeConfigRegistry(stack, role, [compute]);
	return Template.fromStack(stack);
}

test('finalize uploads + wires the computes even with zero entries when a bucket was created', () => {
	const { stack, role, computes } = stackWithCompute('EmptyWithBucket');
	// Simulate a co-located BB that creates the bucket but registers no config of its own.
	getConfigLocation(stack);
	finalizeConfigRegistry(stack, role, computes);

	const t = Template.fromStack(stack);
	assert.strictEqual(Object.keys(t.findResources('AWS::S3::Bucket')).length, 2, 'config bucket + its access-log bucket');
	t.resourceCountIs('Custom::CDKBucketDeployment', 1); // the (empty) blocks-config.json is uploaded
	t.hasResourceProperties('AWS::Lambda::Function', {
		Environment: { Variables: Match.objectLike({ BLOCKS_CONFIG_KEY: 'blocks-config.json' }) },
	});
	// Read is granted once to the shared role (not per-function), so every compute that assumes it
	// — including co-located compute that never went through finalize — can read the object.
	t.hasResourceProperties('AWS::IAM::Policy', {
		PolicyDocument: {
			Statement: Match.arrayWith([
				Match.objectLike({ Action: Match.arrayWith([Match.stringLikeRegexp('^s3:GetObject')]) }),
			]),
		},
		Roles: Match.arrayWith([Match.objectLike({ Ref: Match.stringLikeRegexp('BlocksRole') })]),
	});
});

test('finalize is a no-op with zero entries and no bucket', () => {
	const { stack, role, computes } = stackWithCompute('EmptyNoBucket');
	finalizeConfigRegistry(stack, role, computes);

	const t = Template.fromStack(stack);
	assert.strictEqual(Object.keys(t.findResources('AWS::S3::Bucket')).length, 0, 'no config bucket created');
	t.resourceCountIs('Custom::CDKBucketDeployment', 0);
});

test('finalize uploads + wires the computes when config was registered (bucket auto-created)', () => {
	const { stack, role, computes } = stackWithCompute('WithEntries');
	registerConfig(stack, 'BLOCKS_SOMETHING', 'value');
	finalizeConfigRegistry(stack, role, computes);

	const t = Template.fromStack(stack);
	assert.strictEqual(Object.keys(t.findResources('AWS::S3::Bucket')).length, 2, 'config bucket + its access-log bucket');
	t.resourceCountIs('Custom::CDKBucketDeployment', 1);
	t.hasResourceProperties('AWS::Lambda::Function', {
		Environment: { Variables: Match.objectLike({ BLOCKS_CONFIG_KEY: 'blocks-config.json' }) },
	});
});

test('the config bucket is created under the owning stack/backend, not the (deep) caller scope', () => {
	// Mimic a BlocksBackend embedded in a customer stack: the owner is a nested construct, and the
	// first caller of getConfigLocation is a *deep* construct (like the AgentCore Runtime).
	const app = new cdk.App();
	const stack = new cdk.Stack(app, 'CustomerStack');
	const owner = new Construct(stack, 'Embedded'); // stands in for the BlocksBackend construct
	(globalThis as any).CURRENT_BLOCKS_STACK = owner;
	const deepScope = new Construct(new Construct(owner, 'agent'), 'runtime');

	getConfigLocation(deepScope);

	const t = Template.fromStack(stack);
	const bucketIds = Object.keys(t.findResources('AWS::S3::Bucket'));
	assert.strictEqual(bucketIds.length, 2, 'config bucket + its access-log bucket');
	// Logical IDs encode the construct path — under the owner it's `EmbeddedBlocksConfigBucket…`,
	// at the stack root it would be `BlocksConfigBucket…`. Pin that both follow the owner, and that
	// the config bucket specifically is nested under it.
	assert.ok(
		bucketIds.every(id => id.startsWith('Embedded')),
		`buckets should be nested under the owner, got ${bucketIds.join(', ')}`,
	);
	assert.ok(
		bucketIds.some(id => id.startsWith('EmbeddedBlocksConfigBucket')),
		`config bucket should be nested under the owner, got ${bucketIds.join(', ')}`,
	);
});

test('getConfigLocation creates exactly one bucket across repeated calls (idempotent)', () => {
	const app = new cdk.App();
	const stack = new cdk.Stack(app, 'Idempotent');
	const a = getConfigLocation(stack);
	const b = getConfigLocation(stack);
	assert.strictEqual(a.key, b.key, 'same config key');
	assert.strictEqual(a.bucketName, b.bucketName, 'same bucket');
	const t = Template.fromStack(stack);
	assert.strictEqual(Object.keys(t.findResources('AWS::S3::Bucket')).length, 2, 'config bucket + its access-log bucket (created once)');
});

test('the config bucket enforces TLS, enables versioning, and delivers server access logs', () => {
	const { stack, role, computes } = stackWithCompute('SecurePosture');
	registerConfig(stack, 'BLOCKS_SOMETHING', 'value');
	finalizeConfigRegistry(stack, role, computes);

	const t = Template.fromStack(stack);

	// A dedicated access-log bucket is provisioned alongside the config bucket.
	assert.strictEqual(Object.keys(t.findResources('AWS::S3::Bucket')).length, 2, 'config bucket + dedicated access-log bucket');

	// (a) Versioning enabled + (c) the config bucket ships access logs to the dedicated log bucket
	// (not to itself) under a prefix.
	t.hasResourceProperties('AWS::S3::Bucket', {
		VersioningConfiguration: { Status: 'Enabled' },
		LoggingConfiguration: {
			DestinationBucketName: { Ref: Match.stringLikeRegexp('BlocksConfigLogsBucket') },
			LogFilePrefix: 'access-logs/',
		},
	});

	// (b) enforceSSL generates a bucket policy denying non-TLS access (aws:SecureTransport=false),
	// pinned to the CONFIG bucket specifically — the log bucket also enforces SSL, so an unpinned
	// matcher would still pass if the config bucket's enforceSSL were dropped.
	t.hasResourceProperties('AWS::S3::BucketPolicy', {
		Bucket: { Ref: Match.stringLikeRegexp('^BlocksConfigBucket') },
		PolicyDocument: {
			Statement: Match.arrayWith([
				Match.objectLike({
					Effect: 'Deny',
					Condition: { Bool: { 'aws:SecureTransport': 'false' } },
				}),
			]),
		},
	});

	// (d) The log bucket's own posture: BLOCK_ALL public access, S3-managed encryption, and an
	// ExpireAccessLogs lifecycle rule — all pinned to the same resource via the rule id so this
	// asserts the log bucket, not the config bucket. The expiry DAY COUNT and teardown policy are now
	// resolved from the stack defaults, so they're asserted per-preset below; here we pin only the
	// preset-independent lock-down. stackWithCompute registers no BlocksStack/Backend, so the posture
	// falls back to the production preset.
	t.hasResourceProperties('AWS::S3::Bucket', {
		PublicAccessBlockConfiguration: {
			BlockPublicAcls: true,
			BlockPublicPolicy: true,
			IgnorePublicAcls: true,
			RestrictPublicBuckets: true,
		},
		BucketEncryption: {
			ServerSideEncryptionConfiguration: Match.arrayWith([
				Match.objectLike({ ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }),
			]),
		},
		LifecycleConfiguration: {
			Rules: Match.arrayWith([
				Match.objectLike({ Id: 'ExpireAccessLogs', Status: 'Enabled' }),
			]),
		},
	});

	// (b2) enforceSSL on the LOG bucket generates its OWN Deny-non-TLS bucket policy, pinned to the log
	// bucket (Ref ^ConfigLogDelivery). Without this, dropping the log bucket's enforceSSL would still
	// pass the config-bucket SSL assertion above.
	t.hasResourceProperties('AWS::S3::BucketPolicy', {
		Bucket: { Ref: Match.stringLikeRegexp('^ConfigLogDelivery') },
		PolicyDocument: {
			Statement: Match.arrayWith([
				Match.objectLike({
					Effect: 'Deny',
					Condition: { Bool: { 'aws:SecureTransport': 'false' } },
				}),
			]),
		},
	});

	// (e) The log bucket must stay ACL-free: with the serverAccessLogsUseBucketPolicy flag, CDK grants
	// log delivery via a bucket policy, not by re-enabling S3 ACLs. Pin that the log bucket (the one
	// carrying the ExpireAccessLogs rule) has neither the legacy AccessControl: LogDeliveryWrite nor
	// ObjectOwnership: ObjectWriter, so a flag regression is caught.
	const buckets = t.findResources('AWS::S3::Bucket');
	const logBucketEntry = Object.entries(buckets).find(([, res]) =>
		(res.Properties?.LifecycleConfiguration?.Rules ?? []).some(
			(r: { Id?: string }) => r.Id === 'ExpireAccessLogs',
		),
	);
	assert.ok(logBucketEntry, 'access-log bucket present');
	const logBucketProps = logBucketEntry[1].Properties ?? {};
	assert.notStrictEqual(
		logBucketProps.AccessControl,
		'LogDeliveryWrite',
		'log bucket must not re-enable ACLs via AccessControl: LogDeliveryWrite',
	);
	assert.strictEqual(
		logBucketProps.OwnershipControls,
		undefined,
		'log bucket must not set ObjectWriter ownership controls',
	);
});

test('log bucket inherits the sandbox preset posture: DESTROY + autoDelete + 7-day expiry', () => {
	const t = synthWithPreset('sandbox');

	// Teardown + retention follow the sandbox preset: the log bucket is torn down with the stack and
	// its logs expire after sandbox `logRetention` (ONE_WEEK === 7 days). Pinned to the log bucket via
	// the ExpireAccessLogs rule id (the config bucket carries ExpireNoncurrentVersions, not this).
	t.hasResource('AWS::S3::Bucket', {
		DeletionPolicy: 'Delete',
		Properties: Match.objectLike({
			LifecycleConfiguration: {
				Rules: Match.arrayWith([
					Match.objectLike({ Id: 'ExpireAccessLogs', ExpirationInDays: 7, Status: 'Enabled' }),
				]),
			},
		}),
	});
	// autoDeleteObjects is on for BOTH the config bucket (always DESTROY) and the log bucket under
	// sandbox ⇒ two Custom::S3AutoDeleteObjects resources.
	t.resourceCountIs('Custom::S3AutoDeleteObjects', 2);
});

test('log bucket inherits the production preset posture: RETAIN + no autoDelete + 365-day expiry', () => {
	const t = synthWithPreset('production');

	// Access logs are a durable audit artifact under production: the log bucket is RETAIN (not torn
	// down with the stack) and its logs expire after production `logRetention` (ONE_YEAR === 365 days).
	t.hasResource('AWS::S3::Bucket', {
		DeletionPolicy: 'Retain',
		Properties: Match.objectLike({
			LifecycleConfiguration: {
				Rules: Match.arrayWith([
					Match.objectLike({ Id: 'ExpireAccessLogs', ExpirationInDays: 365, Status: 'Enabled' }),
				]),
			},
		}),
	});
	// Only the config bucket (always DESTROY) auto-deletes; the RETAIN log bucket must NOT ⇒ exactly
	// one Custom::S3AutoDeleteObjects resource. This is what guards the "don't wipe production access
	// logs on teardown" guarantee.
	t.resourceCountIs('Custom::S3AutoDeleteObjects', 1);

	// The log bucket keeps its lock-down under RETAIN: BLOCK_ALL public access and its own Deny-non-TLS
	// bucket policy still hold.
	t.hasResourceProperties('AWS::S3::Bucket', {
		PublicAccessBlockConfiguration: {
			BlockPublicAcls: true,
			BlockPublicPolicy: true,
			IgnorePublicAcls: true,
			RestrictPublicBuckets: true,
		},
		LifecycleConfiguration: {
			Rules: Match.arrayWith([Match.objectLike({ Id: 'ExpireAccessLogs', Status: 'Enabled' })]),
		},
	});
	t.hasResourceProperties('AWS::S3::BucketPolicy', {
		Bucket: { Ref: Match.stringLikeRegexp('^ConfigLogDelivery') },
		PolicyDocument: {
			Statement: Match.arrayWith([
				Match.objectLike({
					Effect: 'Deny',
					Condition: { Bool: { 'aws:SecureTransport': 'false' } },
				}),
			]),
		},
	});
});
