// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { RemovalPolicy } from 'aws-cdk-lib';

/**
 * Default values for every Amazon-authored Building Block created within a
 * `BlocksStack` or `BlocksBackend`. A per-block option always overrides the
 * corresponding default (`option ?? scope.defaults.field`).
 *
 * Start from {@link BlocksPresets} and override individual fields as needed.
 */
export interface BlocksDefaults {
	/**
	 * What happens to a stateful resource (table, bucket, user pool) when the
	 * stack is deleted, via CDK/CloudFormation: `RETAIN` keeps the resource (and
	 * its data) behind; `DESTROY` tears it down. Applies only to CDK/CloudFormation
	 * deletions.
	 */
	removalPolicy: RemovalPolicy;

	/**
	 * Whether to block deletion of a stateful resource. Unlike `removalPolicy`,
	 * this guards against deletion through **any** path — CDK/CloudFormation as
	 * well as the CLI, API, and AWS console — until it is turned off.
	 */
	deletionProtection: boolean;

	/**
	 * Whether stateful resources that support continuous backups keep them on by
	 * default — e.g. DynamoDB Point-in-Time Recovery, letting you restore to any
	 * second in the retention window. On in `production`, off in `sandbox` (where
	 * throwaway data isn't worth the backup-storage cost). Blocks whose service
	 * has no equivalent simply ignore it.
	 */
	pointInTimeRecovery: boolean;
}

/**
 * Prepared starting points for {@link BlocksDefaults}. Pick one and override
 * individual fields with a spread:
 *
 * ```ts
 * defaults: { ...BlocksPresets.production, deletionProtection: false }
 * ```
 */
export const BlocksPresets = {
	/** Disposable development stacks: tear down cleanly, no delete guard, no backups. */
	sandbox: {
		removalPolicy: RemovalPolicy.DESTROY,
		deletionProtection: false,
		pointInTimeRecovery: false,
	},
	/** Durable, protected posture for permanent deployments. */
	production: {
		removalPolicy: RemovalPolicy.RETAIN,
		deletionProtection: true,
		pointInTimeRecovery: true,
	},
} satisfies Record<string, BlocksDefaults>;
