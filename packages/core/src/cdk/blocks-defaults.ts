// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { RemovalPolicy } from 'aws-cdk-lib';
import { Architecture } from 'aws-cdk-lib/aws-lambda';

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
	 *
	 * `true` enables backups with the service's default window; `false` disables
	 * them; `{ retentionDays: n }` enables them and pins the window (a block
	 * clamps/validates `n` to its service's supported range — DynamoDB PITR is
	 * 1–35 days). Backups only have a window when on, so the two are one field.
	 */
	pointInTimeRecovery: boolean | { retentionDays: number };

	/**
	 * The instruction-set architecture for framework-provisioned Lambda compute
	 * (the shared Blocks handler). Defaults to **`Architecture.ARM_64`** (AWS
	 * Graviton) in every preset: arm64 Lambda is ~20% cheaper per GB-second than
	 * x86_64 at the same performance, and the Blocks handler is a pure-JavaScript
	 * esbuild bundle with no architecture-specific native dependencies, so the
	 * switch is free.
	 *
	 * Override to `Architecture.X86_64` if you bundle an x86-only native addon
	 * into your backend:
	 *
	 * ```ts
	 * import { Architecture } from 'aws-cdk-lib/aws-lambda';
	 * defaults: { ...BlocksPresets.production, lambdaArchitecture: Architecture.X86_64 }
	 * ```
	 */
	lambdaArchitecture: Architecture;
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
		lambdaArchitecture: Architecture.ARM_64,
	},
	/** Durable, protected posture for permanent deployments. */
	production: {
		removalPolicy: RemovalPolicy.RETAIN,
		deletionProtection: true,
		pointInTimeRecovery: true,
		lambdaArchitecture: Architecture.ARM_64,
	},
} satisfies Record<string, BlocksDefaults>;
