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
	 * CORS origins the compute's API accepts, as regular-expression patterns
	 * matched against the request `Origin` header. Empty means no cross-origin
	 * requests are allowed. The `sandbox` preset allows localhost so a local dev
	 * frontend can reach a deployed API; `production` allows none by default.
	 */
	allowedOrigins: string[];
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
	/** Disposable development stacks: tear down cleanly, no delete guard. */
	sandbox: {
		removalPolicy: RemovalPolicy.DESTROY,
		deletionProtection: false,
		allowedOrigins: ['^https?://(localhost|127\\.0\\.0\\.1)(:\\d+)?$'],
	},
	/** Durable, protected posture for permanent deployments. */
	production: {
		removalPolicy: RemovalPolicy.RETAIN,
		deletionProtection: true,
		allowedOrigins: [],
	},
} satisfies Record<string, BlocksDefaults>;
