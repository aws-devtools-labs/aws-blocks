// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import type { Construct } from 'constructs';
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
 */
function ensureConfigBucket(scope: Construct): s3.Bucket {
	const stack = cdk.Stack.of(scope);
	const registry = getRegistry(stack);
	if (!registry.bucket) {
		const owner = ((globalThis as any).CURRENT_BLOCKS_STACK as Construct | undefined) ?? stack;
		registry.bucket = new s3.Bucket(owner, 'BlocksConfigBucket', {
			removalPolicy: cdk.RemovalPolicy.DESTROY,
			autoDeleteObjects: true,
			encryption: s3.BucketEncryption.S3_MANAGED,
			blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
			lifecycleRules: [
				{ noncurrentVersionExpiration: cdk.Duration.days(1) },
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
