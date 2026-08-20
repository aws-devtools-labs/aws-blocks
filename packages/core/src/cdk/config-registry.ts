// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import type { Construct } from 'constructs';
import type { Compute } from './compute/compute.js';

const REGISTRY_KEY = Symbol.for('BLOCKS_CONFIG_REGISTRY');

interface ConfigRegistryState {
	entries: Map<string, unknown>;
	finalized: boolean;
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

	if (registry.entries.size === 0) return;

	const configBucket = new s3.Bucket(root, 'BlocksConfigBucket', {
		removalPolicy: cdk.RemovalPolicy.DESTROY,
		autoDeleteObjects: true,
		encryption: s3.BucketEncryption.S3_MANAGED,
		blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
		lifecycleRules: [
			{ noncurrentVersionExpiration: cdk.Duration.days(1) },
		],
	});

	const configKey = 'blocks-config.json';

	const configObject = cdk.Lazy.any({
		produce: () => Object.fromEntries(registry.entries),
	});

	new s3deploy.BucketDeployment(root, 'BlocksConfigDeployment', {
		sources: [s3deploy.Source.jsonData(configKey, configObject)],
		destinationBucket: configBucket,
		prune: false,
	});

	// Grant read once to the shared role (scoped to the config key), so every
	// compute assuming the role can read it.
	configBucket.grantRead(executionRole, configKey);

	// Stamp the config coordinates on every compute — env vars can't live on a
	// role, so each compute needs them to locate the object at runtime.
	for (const compute of computes) {
		compute.setEnv('BLOCKS_CONFIG_BUCKET', configBucket.bucketName);
		compute.setEnv('BLOCKS_CONFIG_KEY', configKey);
	}
}
