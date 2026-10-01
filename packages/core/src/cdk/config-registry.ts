// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as cdk from 'aws-cdk-lib';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import { Construct } from 'constructs';
import { type BlocksDefaults, BlocksPresets } from './blocks-defaults.js';
import type { Compute } from './compute/compute.js';

const REGISTRY_KEY = Symbol.for('BLOCKS_CONFIG_REGISTRY');

/** The object key of the config JSON under {@link getConfigLocation}'s bucket. */
const CONFIG_KEY = 'blocks-config.json';

interface ConfigRegistryState {
	entries: Map<string, unknown>;
	finalized: boolean;
	/** The shared config bucket, created once per stack by {@link getConfigLocation}. */
	bucket?: s3.Bucket;
}

/**
 * Get or create the config registry for a given stack.
 * The registry collects BB config entries (env var key → CDK token value)
 * and serializes them to an S3 JSON file at synth time.
 */
function getRegistry(stack: cdk.Stack): ConfigRegistryState {
	let state = (stack as any)[REGISTRY_KEY] as ConfigRegistryState | undefined;
	if (!state) {
		state = { entries: new Map(), finalized: false };
		(stack as any)[REGISTRY_KEY] = state;
	}
	return state;
}

/**
 * Register a config entry for a Building Block. This replaces
 * `handler.addEnvironment(key, value)` for BB resource mappings.
 *
 * The entry will be serialized into a JSON config file in S3, loaded
 * by the Lambda at cold start. This avoids the 4KB env var limit.
 *
 * @param scope - The CDK construct (used to find the parent stack)
 * @param key - The config key (same string the runtime will use to look it up)
 * @param value - The config value (can be a CDK token that resolves at deploy time)
 */
export function registerConfig(scope: Construct, key: string, value: unknown): void {
	const stack = cdk.Stack.of(scope);
	const registry = getRegistry(stack);
	registry.entries.set(key, value);
}

/**
 * Ensure the shared config bucket exists and return where the config JSON lives
 * (`{ bucketName, key }`). The bucket is created **once per stack** (memoized on
 * the registry) and this is idempotent — the first caller creates it, later
 * callers get the same bucket regardless of order.
 *
 * Any compute that loads config at runtime (`loadConfigToProcessEnv()`) injects
 * these two values as `BLOCKS_CONFIG_BUCKET` / `BLOCKS_CONFIG_KEY`. The Lambda
 * handler gets them from {@link finalizeConfigRegistry}; other compute that runs
 * as the shared execution role (e.g. the Agent BB's AgentCore Runtime) calls this
 * at construction to inject them too, so it loads the same app config the handler
 * does. IAM is not granted here — `finalizeConfigRegistry` grants read on the config
 * object to the shared execution role, which such compute inherits.
 *
 * @param scope - Any construct in the stack; the bucket is created under the stack.
 */
export function getConfigLocation(scope: Construct): { bucketName: string; key: string } {
	return { bucketName: ensureConfigBucket(scope).bucketName, key: CONFIG_KEY };
}

/**
 * Create-or-return the shared config bucket (memoized on the per-stack registry). Created under the
 * owning `BlocksStack`/`BlocksBackend` (`globalThis.CURRENT_BLOCKS_STACK` — the construct finalize
 * historically used), so its logical ID is stable regardless of which caller creates it first: a
 * co-located BB (e.g. the AgentCore Runtime, a deep construct) may be the first to call it, and a
 * `BlocksBackend` embedded in a customer stack must keep `Blocks/BlocksConfigBucket` (no replacement).
 * Falls back to the stack when no owner is registered (isolated unit tests). Returns a concrete
 * `s3.Bucket` so callers don't need a non-null assertion.
 *
 * This bucket holds `blocks-config.json`, which feeds `process.env` (incl. `CORS_HOSTING_ORIGINS`) for
 * every compute in the stack, so it enforces TLS, is versioned (an overwritten config stays recoverable
 * for ~24h — see the versioning note at the props below), and ships S3 server access logs to a
 * dedicated, locked-down log bucket. The per-bucket removal and retention posture is documented inline
 * at the props below: the config bucket is deliberately DESTROY (a per-deploy derived artifact), while
 * the log bucket resolves its posture from the stack `defaults`.
 */
function ensureConfigBucket(scope: Construct): s3.Bucket {
	const stack = cdk.Stack.of(scope);
	const registry = getRegistry(stack);
	if (!registry.bucket) {
		const owner = ((globalThis as any).CURRENT_BLOCKS_STACK as Construct | undefined) ?? stack;

		// Resolve the log bucket's teardown + retention posture from the stack defaults, the way
		// Scope.defaults does: `owner` is the owning BlocksStack/BlocksBackend
		// (globalThis.CURRENT_BLOCKS_STACK), which exposes `.defaults`; fall back to the production
		// preset when none is registered (isolated unit tests). Access logs are the one artifact here
		// that is NOT re-derived every deploy, so under production (RETAIN, logRetention ONE_YEAR) they
		// must not silently expire at a fixed window or be wiped by autoDelete.
		const defaults = (owner as { defaults?: BlocksDefaults }).defaults ?? BlocksPresets.production;
		const logDestroy = defaults.removalPolicy === cdk.RemovalPolicy.DESTROY;
		// Access-log retention follows the framework `logRetention` default (a `RetentionDays` enum
		// whose member value IS the day count — ONE_WEEK === 7, ONE_YEAR === 365 — so it maps directly
		// to Duration.days). INFINITE ("retain forever") omits the rule rather than expiring at a
		// spurious 9999 days. Same conversion bb-file-bucket's access-logs bucket uses.
		const logLifecycleRules =
			defaults.logRetention === RetentionDays.INFINITE
				? undefined
				: [{ id: 'ExpireAccessLogs', expiration: cdk.Duration.days(defaults.logRetention) }];

		// Dedicated, locked-down bucket that receives the config bucket's S3 server access logs, so any
		// access to blocks-config.json is attributable. Kept separate from the config bucket (rather
		// than self-logging) so log delivery can't loop back onto the audited data. Mirrors the
		// access-logs bucket in packages/bb-file-bucket/src/index.cdk.ts — the closest precedent: same
		// S3-server-access-log target with BLOCK_ALL / S3_MANAGED / enforceSSL, and removal + retention
		// resolved from the stack defaults (INFINITE retention left unexpired). storage_construct.ts is
		// the CloudFront/ACL variant and is deliberately NOT mirrored here (see the ACL note below).
		// Teardown race: a plain `cdk destroy` can empty this bucket before S3 finishes delivering the
		// last access logs, yielding BucketNotEmpty; under production the posture is RETAIN so it does
		// not arise, which narrows it to non-sandbox DESTROY — acknowledged, not worth a teardown
		// dependency/retry here.
		//
		// Scoped under a child construct that enables the `serverAccessLogsUseBucketPolicy` feature flag
		// so CDK grants log delivery via a bucket policy. Without it CDK takes the legacy path and
		// re-enables S3 ACLs on the log bucket (AccessControl: LogDeliveryWrite / ObjectOwnership:
		// ObjectWriter); that flag is unset in shipped cdk.json. storage_construct.ts instead keeps ACLs
		// on via BUCKET_OWNER_PREFERRED because CloudFront log delivery needs them — this bucket has no
		// such constraint, so the bucket-policy path (ACLs off entirely) is preferred.
		const logScope = new Construct(owner, 'ConfigLogDelivery');
		logScope.node.setContext('@aws-cdk/aws-s3:serverAccessLogsUseBucketPolicy', true);
		const logBucket = new s3.Bucket(logScope, 'BlocksConfigLogsBucket', {
			blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
			encryption: s3.BucketEncryption.S3_MANAGED,
			enforceSSL: true,
			// Removal + retention follow the stack defaults (production ⇒ RETAIN + 365-day expiry,
			// sandbox ⇒ DESTROY + 7-day expiry): the access logs are a genuine audit artifact, not a
			// per-deploy derived file like blocks-config.json, so they inherit the stack's durability
			// posture rather than being hardcoded to tear down.
			removalPolicy: defaults.removalPolicy,
			autoDeleteObjects: logDestroy,
			lifecycleRules: logLifecycleRules,
		});

		registry.bucket = new s3.Bucket(owner, 'BlocksConfigBucket', {
			// removalPolicy DESTROY + autoDeleteObjects are DELIBERATE, NOT preset-driven: the only
			// object here is blocks-config.json, which `BlocksConfigDeployment` (BucketDeployment, in
			// finalizeConfigRegistry) regenerates from the CDK app and re-uploads on every deploy. It is
			// a derived artifact with no source of truth on the bucket, so it is safe to destroy with the
			// stack even under the production preset — kept DESTROY on purpose so a torn-down stack leaves
			// no orphaned bucket, not an oversight.
			removalPolicy: cdk.RemovalPolicy.DESTROY,
			autoDeleteObjects: true,
			encryption: s3.BucketEncryption.S3_MANAGED,
			blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
			// Deny non-TLS access (aws:SecureTransport=false). This bucket feeds process.env
			// (incl. CORS_HOSTING_ORIGINS) for every compute, so protect it in transit — matches every
			// other bucket in the repo (bb-file-bucket, bb-knowledge-base, bb-async-job, hosting).
			enforceSSL: true,
			// Keep an overwritten blocks-config.json recoverable for ~24h — the noncurrent-version
			// expiry rule below (now effective) deletes noncurrent versions after 1 day. This is a
			// short in-transit safety net, not the durable recovery path: blocks-config.json is derived
			// from the CDK app, so the way to restore a prior config is to redeploy. (Enabling
			// versioning is one-way — S3 can only move a versioned bucket to Suspended, never back to
			// unversioned — so reverting this leaves the bucket Suspended rather than unversioned.)
			versioned: true,
			serverAccessLogsBucket: logBucket,
			serverAccessLogsPrefix: 'access-logs/',
			// 1-day noncurrent-version expiry is a deliberate fixed literal (NOT the stack `logRetention`
			// default, which drives the log bucket): it only bounds storage of superseded copies of a
			// per-deploy derived file, so it stays short regardless of the stack's retention posture.
			lifecycleRules: [
				{ id: 'ExpireNoncurrentVersions', noncurrentVersionExpiration: cdk.Duration.days(1) },
			],
		});
	}
	return registry.bucket;
}

/**
 * Finalize the config registry: create an S3 bucket, upload the config JSON,
 * grant read to the shared execution role, and stamp the config coordinates
 * (`BLOCKS_CONFIG_BUCKET` / `BLOCKS_CONFIG_KEY`) onto every compute.
 *
 * Read access is granted once to the shared role (`root.executionRole`) rather
 * than to a single function, so every compute that assumes the role can read
 * the object. The bucket/key coordinates can't live on a role (env vars are
 * per-compute), so they are set on each compute via `setEnv`.
 *
 * Must be called after all BBs are constructed (i.e., after the backendCDKPath
 * import completes in BlocksStack.create() / BlocksBackend.create()).
 *
 * @param root - The construct to create the config resources under (also used
 *   to locate the owning stack).
 * @param executionRole - The shared role every compute assumes; config read is
 *   granted to it once.
 * @param computes - The computes to stamp `BLOCKS_CONFIG_BUCKET` / `BLOCKS_CONFIG_KEY` on.
 */
export function finalizeConfigRegistry(
	root: Construct,
	executionRole: cdk.aws_iam.IRole,
	computes: readonly Compute[],
): void {
	const stack = cdk.Stack.of(root);
	const registry = getRegistry(stack);

	if (registry.finalized) return;
	registry.finalized = true;

	// Nothing to do only if no config was registered AND no bucket was created (via
	// getConfigLocation). If a co-located BB created the bucket, still upload (even an empty {}) and
	// wire the handler so that compute's loadConfigToProcessEnv() resolves instead of 404-ing forever.
	if (registry.entries.size === 0 && !registry.bucket) return;

	// Ensure the bucket exists (a co-located BB may already have created it via getConfigLocation).
	const configBucket = ensureConfigBucket(root);
	const configKey = CONFIG_KEY;

	const configObject = cdk.Lazy.any({
		produce: () => Object.fromEntries(registry.entries),
	});

	new s3deploy.BucketDeployment(root, 'BlocksConfigDeployment', {
		sources: [s3deploy.Source.jsonData(configKey, configObject)],
		destinationBucket: configBucket,
		prune: false,
	});

	// Grant read once to the shared role (scoped to the config key), so every
	// compute assuming the role can read it. We intentionally use `grantRead`
	// (which also adds s3:GetBucket*/s3:List* alongside s3:GetObject*) rather
	// than a hand-rolled GetObject-only statement: this is a dedicated,
	// block-all-public, config-only bucket, so the broader action set carries
	// negligible exposure, and grantRead stays correct automatically if the
	// bucket ever moves to KMS encryption (it would add kms:Decrypt).
	configBucket.grantRead(executionRole, configKey);

	// Stamp the config coordinates on every compute — env vars can't live on a
	// role, so each compute needs them to locate the object at runtime.
	for (const compute of computes) {
		compute.setEnv('BLOCKS_CONFIG_BUCKET', configBucket.bucketName);
		compute.setEnv('BLOCKS_CONFIG_KEY', configKey);
	}
}
