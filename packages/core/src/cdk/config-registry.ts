// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import type { Construct } from 'constructs';
import type { ComputeBase } from './compute/compute.js';
import { getBlocksRoot } from './root-registry.js';

const REGISTRY_KEY = Symbol.for('BLOCKS_CONFIG_REGISTRY');

/** The object key of the config JSON under {@link getConfigLocation}'s bucket. */
const CONFIG_KEY = 'blocks-config.json';

interface ConfigRegistryState {
	entries: Map<string, unknown>;
	finalized: boolean;
	/** The shared config bucket, created once per backend root by {@link getConfigLocation}. */
	bucket?: s3.Bucket;
	/**
	 * The S3 deployment that uploads the config JSON, set by
	 * {@link finalizeConfigRegistry}. A compute that loads config at boot (e.g. a
	 * container's parent process) depends on this so CloudFormation doesn't start
	 * the service before the config object exists. See {@link getConfigDeployment}.
	 */
	deployment?: s3deploy.BucketDeployment;
}

/**
 * Get or create the config registry for a given backend root. Stored on the root
 * object (keyed by a Symbol), so each `BlocksStack`/`BlocksBackend` gets its own —
 * a config entry never leaks into another backend's registry, even when two
 * backends share one `cdk.Stack`. The registry collects BB config entries (env var
 * key → CDK token value) and serializes them to an S3 JSON file at synth time.
 */
function getRegistry(root: Construct): ConfigRegistryState {
	let state = (root as any)[REGISTRY_KEY] as ConfigRegistryState | undefined;
	if (!state) {
		state = { entries: new Map(), finalized: false };
		(root as any)[REGISTRY_KEY] = state;
	}
	return state;
}

/**
 * Register a config entry for a Building Block or an app. This replaces
 * `handler.addEnvironment(key, value)` for BB resource mappings and app
 * settings alike.
 *
 * The entry will be serialized into a JSON config file in S3, loaded
 * by the Lambda at cold start. This avoids the 4KB env var limit.
 *
 * Every compute loads the same config, so at runtime the entry is available as
 * `process.env[key]` on all of them — before the backend module is imported, so
 * module-level reads see it. An existing environment variable of the same name
 * wins; if its value differs, the compute logs a warning at cold start naming
 * the ignored key. It can be called from a Building Block constructor or from app code
 * after `BlocksStack.create()` / `BlocksBackend.create()` resolves:
 *
 * ```ts
 * const blocksStack = await BlocksStack.create(app, 'App', { ... });
 * registerConfig(blocksStack, 'EXTERNAL_QUEUE_URL', externalQueue.queueUrl);
 * ```
 *
 * Config is stored as plain JSON in a private S3 bucket; use `AppSetting` with
 * `secret: true` for secrets.
 *
 * @param scope - The CDK construct (used to find the owning backend root)
 * @param key - The config key (same string the runtime will use to look it up)
 * @param value - The config value (can be a CDK token that resolves at deploy time)
 */
export function registerConfig(scope: Construct, key: string, value: unknown): void {
	const registry = getRegistry(getBlocksRoot(scope));
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
 * @param scope - Any construct in the backend; the bucket is created under the backend root.
 */
export function getConfigLocation(scope: Construct): { bucketName: string; key: string } {
	return { bucketName: ensureConfigBucket(scope).bucketName, key: CONFIG_KEY };
}

/**
 * The config S3 deployment for the backend root that owns `scope`, or `undefined`
 * if no config was registered (so no deployment was created). A compute that reads
 * config at boot — a container parent calls `loadConfigToProcessEnv()` once at
 * startup, with no later retry — should add a CDK dependency on this so
 * CloudFormation finishes uploading the config object before the service starts.
 * Without the dependency the ordering is a race (a Lambda tolerates it because it
 * reloads config per request; a long-lived container does not).
 *
 * Call from a compute's `finalize()` — it runs after `finalizeConfigRegistry`, so
 * the deployment exists by then.
 *
 * @param scope - Any construct in the backend (used to locate the backend root).
 */
export function getConfigDeployment(scope: Construct): s3deploy.BucketDeployment | undefined {
	return getRegistry(getBlocksRoot(scope)).deployment;
}

/**
 * Create-or-return the shared config bucket (memoized on the per-backend-root registry). Created
 * under the owning `BlocksStack`/`BlocksBackend` (resolved by walking the construct tree, see
 * `getBlocksRoot`), so its logical ID is stable regardless of which caller creates it first: a
 * co-located BB (e.g. the AgentCore Runtime, a deep construct) may be the first to call it, and a
 * `BlocksBackend` embedded in a customer stack must keep `Blocks/BlocksConfigBucket` (no replacement).
 * Keying on the resolved root (not `cdk.Stack.of`) also keeps two backends in one stack independent —
 * each gets its own bucket. Returns a concrete `s3.Bucket` so callers don't need a non-null assertion.
 */
function ensureConfigBucket(scope: Construct): s3.Bucket {
	const root = getBlocksRoot(scope);
	const registry = getRegistry(root);
	if (!registry.bucket) {
		registry.bucket = new s3.Bucket(root, 'BlocksConfigBucket', {
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
 *   to locate the owning backend root).
 * @param executionRole - The shared role every compute assumes; config read is
 *   granted to it once.
 * @param computes - The computes to stamp `BLOCKS_CONFIG_BUCKET` / `BLOCKS_CONFIG_KEY` on.
 */
export function finalizeConfigRegistry(
	root: Construct,
	executionRole: cdk.aws_iam.IRole,
	computes: readonly ComputeBase[],
): void {
	const registry = getRegistry(getBlocksRoot(root));

	if (registry.finalized) return;
	registry.finalized = true;

	// Always deploy, even with zero entries so far: the JSON is a Lazy read at synth, so config
	// registered after this point (e.g. by app code after `create()` resolves) is still included —
	// as long as the deployment exists. An empty registry uploads `{}`.
	// Ensure the bucket exists (a co-located BB may already have created it via getConfigLocation).
	const configBucket = ensureConfigBucket(root);
	const configKey = CONFIG_KEY;

	const configObject = cdk.Lazy.any({
		produce: () => Object.fromEntries(registry.entries),
	});

	const deployment = new s3deploy.BucketDeployment(root, 'BlocksConfigDeployment', {
		sources: [s3deploy.Source.jsonData(configKey, configObject)],
		destinationBucket: configBucket,
		prune: false,
	});
	registry.deployment = deployment;

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
