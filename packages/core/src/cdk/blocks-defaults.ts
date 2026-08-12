// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as cdk from 'aws-cdk-lib';
import { RemovalPolicy } from 'aws-cdk-lib';
import type { Construct } from 'constructs';

const DEFAULTS_KEY = Symbol.for('BLOCKS_INFRA_DEFAULTS');

/**
 * Stack-wide infrastructure defaults, chosen once at the app entry point and
 * read by every Amazon-authored Building Block at construction time.
 *
 * Building Blocks provision AWS resources (DynamoDB tables, S3 buckets, Cognito
 * user pools, …) that each need the same class of durability decision — what
 * happens to stateful data on stack delete, and whether accidental deletion is
 * blocked. Historically each block re-derived this from the `sandboxMode`
 * context on its own, and the stack-level `RemovalPolicies`/mixin aspects fought
 * with those per-block choices. This replaces both with a single, explicit
 * object the app passes to `BlocksStack.create` / `BlocksBackend.create`.
 *
 * Resolution for any one value is two tiers, highest precedence first:
 *
 *   per-block option  >  stack-level `defaults`
 *
 * i.e. `options.field ?? scope.defaults.field`. There is intentionally **no
 * hidden framework fallback** below the stack default — the app always picks a
 * posture explicitly (start from {@link BlocksPresets}), and a block that needs
 * something different overrides locally.
 *
 * @remarks
 * This is the first step of the Blocks Infrastructure Options design. It covers
 * the removal-policy / deletion-protection knobs that were previously managed
 * via CDK mixins/aspects and per-block `sandboxMode` logic. Further knobs
 * (log retention, API throttling, access logging, point-in-time recovery,
 * secrets backend, VPC, compute) are added to this object in follow-up,
 * per-feature changes, each with its own API review.
 */
export interface BlocksDefaults {
	/**
	 * What happens to stateful resources (tables, buckets, user pools) when the
	 * stack is deleted. `RETAIN` keeps the data behind after a `cdk destroy`;
	 * `DESTROY` tears it down so a sandbox teardown leaves nothing behind.
	 */
	removalPolicy: RemovalPolicy;

	/**
	 * Whether to block accidental deletion of stateful resources. When `true`,
	 * a stray console/CLI delete of the resource is rejected until protection is
	 * turned off. Keep this off in sandbox so `sandbox:destroy` can tear the
	 * stack down in one command.
	 */
	deletionProtection: boolean;
}

/**
 * Prepared, named starting points for {@link BlocksDefaults}. Pick one at the
 * app entry point and override individual fields with a spread:
 *
 * ```ts
 * defaults: { ...BlocksPresets.production, deletionProtection: false }
 * ```
 *
 * The framework's safe posture is production; `BlocksPresets.production` states
 * it explicitly, and `BlocksPresets.sandbox` loosens it for disposable
 * development stacks.
 */
export const BlocksPresets = {
	/** Disposable development stacks: tear down cleanly, no delete guard. */
	sandbox: {
		removalPolicy: RemovalPolicy.DESTROY,
		deletionProtection: false,
	},
	/** Durable, protected posture for real deployments. The framework default. */
	production: {
		removalPolicy: RemovalPolicy.RETAIN,
		deletionProtection: true,
	},
} satisfies Record<string, BlocksDefaults>;

/**
 * Publish the stack-wide defaults. Called once by `BlocksStack.create` /
 * `BlocksBackend.create` (via `setupBlocksInfra`) from the `defaults` prop,
 * before the app's blocks are constructed, so any block can read it.
 *
 * Stored on the stack instance under a `Symbol.for` key — the same
 * stack-scoped, synth-time storage pattern used by the config registry.
 */
export function registerStackBlocksDefaults(scope: Construct, defaults: BlocksDefaults): void {
	const stack = cdk.Stack.of(scope);
	(stack as unknown as Record<symbol, unknown>)[DEFAULTS_KEY] = defaults;
}

/**
 * Read the stack-wide defaults for the stack that owns `scope`.
 *
 * Falls back to {@link BlocksPresets.production} when nothing was registered, so
 * a block created under a bare `cdk.Stack` (e.g. in a unit test) still resolves
 * to the safe posture rather than reading `undefined`. In a real app the
 * `defaults` prop is required, so a value is always registered.
 */
export function getStackBlocksDefaults(scope: Construct): BlocksDefaults {
	const stack = cdk.Stack.of(scope);
	return (
		((stack as unknown as Record<symbol, unknown>)[DEFAULTS_KEY] as BlocksDefaults | undefined) ??
		BlocksPresets.production
	);
}
