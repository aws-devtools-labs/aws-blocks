// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';

const REGISTRY_KEY = Symbol.for('BLOCKS_CONFIG_REGISTRY');

interface ConfigRegistryState {
	entries: Map<string, unknown>;
	finalized: boolean;
	deployment?: s3deploy.BucketDeployment;
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
 * set env vars on the handler, and grant read access.
 *
 * Must be called after all BBs are constructed (i.e., after the backendCDKPath
 * import completes in BlocksStack.create() / BlocksBackend.create()).
 *
 * @param scope - The CDK construct to create resources under
 * @param handler - The Lambda function that needs to read the config
 */
export function finalizeConfigRegistry(
	scope: Construct,
	handler: cdk.aws_lambda.IFunction,
): void {
	const stack = cdk.Stack.of(scope);
	const registry = getRegistry(stack);

	if (registry.finalized) return;
	registry.finalized = true;

	if (registry.entries.size === 0) return;

	const configBucket = new s3.Bucket(scope, 'BlocksConfigBucket', {
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

	const deployment = new s3deploy.BucketDeployment(scope, 'BlocksConfigDeployment', {
		sources: [s3deploy.Source.jsonData(configKey, configObject)],
		destinationBucket: configBucket,
		prune: false,
	});
	registry.deployment = deployment;

	(handler as cdk.aws_lambda.Function).addEnvironment(
		'BLOCKS_CONFIG_BUCKET',
		configBucket.bucketName,
	);
	(handler as cdk.aws_lambda.Function).addEnvironment(
		'BLOCKS_CONFIG_KEY',
		configKey,
	);

	// Scope IAM grant to the specific config key
	(handler as cdk.aws_lambda.Function).addToRolePolicy(new iam.PolicyStatement({
		actions: ['s3:GetObject'],
		resources: [`${configBucket.bucketArn}/${configKey}`],
	}));
}

/**
 * The config-file BucketDeployment for a stack, if one was created by
 * {@link finalizeConfigRegistry}. Container compute targets depend on it so
 * tasks never boot before `blocks-config.json` exists in S3.
 *
 * Only meaningful after `finalizeConfigRegistry` ran (i.e. inside a compute
 * target's `finalize()` hook); returns `undefined` before that or when no
 * Building Block registered any config.
 */
export function getConfigDeployment(scope: Construct): s3deploy.BucketDeployment | undefined {
	const stack = cdk.Stack.of(scope);
	return ((stack as any)[REGISTRY_KEY] as ConfigRegistryState | undefined)?.deployment;
}
