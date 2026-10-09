// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Wires both layers of the user-pool immutability guard (decision Q5, task
 * D4) onto an `Auth` block. One call from the constructor: {@link guardUserPool}.
 *
 * **Layer 1 — the committed baseline, at synth** (`immutability-baseline.ts`).
 * A construct validation on the block, so it reads the pool's *final* L1
 * properties (including L1 escape-hatch assignments made after the
 * constructor) and fails `cdk synth` / `cdk deploy` before anything reaches
 * CloudFormation. Runs only when the block lives in a `BlocksStack` /
 * `BlocksBackend` (which gives the app directory). The block claims its file
 * (`claimBaseline`), so the stack-level check in `@aws-blocks/core` — which
 * fails synth for a pool-owning baseline no block claims, i.e. a renamed or
 * removed block (task D4b) — leaves it to this one.
 *
 * **Layer 2 — the deploy-time guard** (`immutability-guard-lambda.ts`). One
 * per stack, shared by every `Auth` block that owns a pool, and created only
 * when one does (Q6): a Lambda, its `cr.Provider`, and one
 * `Custom::BlocksAuthPoolGuard` whose `Pools` property carries each pool's
 * logical id and snapshot. **Each owned pool `DependsOn` the guard** — the
 * reverse of a `Ref` — so CloudFormation runs the guard first and never
 * starts the pool update when the guard refuses. The guard finds the pool by
 * logical id, so nothing in it references the pool. All of it sits at the
 * stack root (like `BlocksSecretsBulk`): new resources only, outside the
 * block's construct subtree, so no existing logical id moves.
 *
 * Not placed in a VPC, like every other Blocks custom-resource Lambda
 * (`BlocksSecretInitFn`, the GSI manager, the OIDC IdP registration): it
 * calls only the CloudFormation and Cognito APIs, over Lambda's own network.
 *
 * @internal
 */

import { dirname, isAbsolute, resolve } from 'node:path';
import type { BuildingBlockScope } from '@aws-blocks/core/cdk';
import { claimBaseline, DEFAULT_NODE_RUNTIME, deployTimeLambdaCode, hasOrphanedBaselines } from '@aws-blocks/core/cdk';
import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cr from 'aws-cdk-lib/custom-resources';
import { type PoolImmutables, snapshotFromTemplate } from './immutability.js';
import { baselinePath, checkBaseline, REBASELINE_ENV, rebaselineRequested } from './immutability-baseline.js';

/** Stack-root construct ids of the shared layer-2 resources. */
export const GUARD_IDS = {
	resource: 'BlocksAuthPoolGuard',
	function: 'BlocksAuthPoolGuardFn',
	functionLogs: 'BlocksAuthPoolGuardLogs',
	provider: 'BlocksAuthPoolGuardProvider',
	providerLogs: 'BlocksAuthPoolGuardProviderLogs',
} as const;

/**
 * `dist/immutability-guard-lambda/` — the esbuild bundle (`npm run build:lambda`).
 * A vendorized copy has no `dist/`, so its source is bundled at synth instead
 * (`deployTimeLambdaCode` in `@aws-blocks/core/cdk`).
 */
const LAMBDA = {
	moduleUrl: import.meta.url,
	bundleDir: '../immutability-guard-lambda',
	source: './immutability-guard-lambda',
	target: 'node22', // = build:lambda
} as const;

/** The four service-immutable properties as `cfnPool` will synthesize them. */
export function snapshotOfPool(cfnPool: cognito.CfnUserPool): PoolImmutables {
	const stack = cdk.Stack.of(cfnPool);
	return snapshotFromTemplate({
		usernameAttributes: stack.resolve(cfnPool.usernameAttributes),
		aliasAttributes: stack.resolve(cfnPool.aliasAttributes),
		usernameConfiguration: stack.resolve(cfnPool.usernameConfiguration),
		schema: stack.resolve(cfnPool.schema),
	});
}

/** Warning id: a block's first-ever baseline records that it owns no pool. */
export const FIRST_BASELINE_WITHOUT_POOL = '@aws-blocks/bb-auth:FirstBaselineWithoutPool';

/** The warning text for {@link FIRST_BASELINE_WITHOUT_POOL}. */
export function firstBaselineWithoutPool(fullId: string): string {
	return (
		`Auth '${fullId}': this is the block's first baseline, and it records no user pool owned by the block ` +
		'(no pool-backed sign-in method, or `userPool` wraps one). If this stack previously had a user pool for this ' +
		'block (e.g. from `AuthCognito`), this deploy will delete it, and every user in it, unless that pool was ' +
		"already deployed with `removalPolicy: 'retain'` — see MIGRATION.md in @aws-blocks/bb-auth (\"Before every " +
		'deploy: the checklist"). Deploy the migrated code unchanged first, commit its baseline, and only then ' +
		'change the configuration; synth then refuses the pool removal. A new app with no earlier pool can ignore this.'
	);
}

interface GuardState {
	resource: cdk.CustomResource;
	pools: { fullId: string; cfnPool: cognito.CfnUserPool }[];
}

const guards = new WeakMap<cdk.Stack, GuardState>();

/**
 * Guard `block`'s user pool. `pool` is the block's `userPool`: an owned
 * `UserPool` gets both layers; a wrapped one (`UserPool.fromUserPoolId`) or
 * none (Q6) gets only the baseline, which records that the block owns no pool.
 */
export function guardUserPool(block: BuildingBlockScope, pool: cognito.IUserPool | undefined): void {
	const child = pool?.node.defaultChild;
	const cfnPool = child instanceof cognito.CfnUserPool ? child : undefined;
	if (cfnPool) addDeployTimeGuard(block, cfnPool);
	addBaselineCheck(block, cfnPool);
}

// ── Layer 1 ─────────────────────────────────────────────────────────────────

/** The app's `aws-blocks/` directory and stack name, or `undefined` outside a Blocks stack/backend. */
function baselineLocation(block: BuildingBlockScope): { appDir: string; stack: string } | undefined {
	let handlerPath: unknown;
	let stack: string;
	try {
		handlerPath = block.backendHandlerPath;
		stack = block.backendStackName;
	} catch {
		return undefined;
	}
	if (typeof handlerPath !== 'string' || handlerPath.length === 0) return undefined;
	const absolute = isAbsolute(handlerPath) ? handlerPath : resolve(handlerPath);
	return { appDir: dirname(absolute), stack };
}

function addBaselineCheck(block: BuildingBlockScope, cfnPool: cognito.CfnUserPool | undefined): void {
	const location = baselineLocation(block);
	if (!location) return;
	const fullId = block.fullId;
	const file = baselinePath(location.appDir, location.stack, fullId);
	// This block reads its own baseline, so the stack-level orphan check
	// (core, task D4b) must not report it. Claimed at construction, so every
	// claim is in before any validation runs.
	claimBaseline(block, file);
	block.node.addValidation({
		validate: () => {
			const outcome = checkBaseline({
				file,
				stack: location.stack,
				fullId,
				current: { ownsPool: cfnPool !== undefined, pool: cfnPool ? snapshotOfPool(cfnPool) : null },
				rebaseline: rebaselineRequested(process.env, fullId),
				mayCreate: !hasOrphanedBaselines(block),
			});
			const annotations = cdk.Annotations.of(block);
			switch (outcome.status) {
				case 'rejected':
					return [outcome.message];
				case 'created':
					annotations.addInfoV2(
						'@aws-blocks/bb-auth:BaselineCreated',
						`Auth '${fullId}': wrote the user-pool baseline ${outcome.file}. Commit it — later synths compare ` +
							'against it and refuse changes Cognito cannot apply to an existing pool.',
					);
					// A first-ever baseline cannot tell a new app from an `AuthCognito`
					// app switching to `Auth`: neither has a file. When it records no
					// owned pool (pool-less, or `userPool` wrapping one), a switching
					// app's pool leaves the template on this deploy, and CloudFormation
					// applies the OLD template's DeletionPolicy (`AuthCognito`: destroy
					// unless `retain`). Nothing else can refuse it: layer 2 exists only
					// while the block owns a pool. So say it loudly.
					if (!cfnPool)
						annotations.addWarningV2(FIRST_BASELINE_WITHOUT_POOL, firstBaselineWithoutPool(fullId));
					break;
				case 'updated':
					annotations.addInfoV2(
						'@aws-blocks/bb-auth:BaselineUpdated',
						`Auth '${fullId}': updated the user-pool baseline ${outcome.file} (a permitted change). Commit it.`,
					);
					break;
				case 'deferred':
					annotations.addInfoV2(
						'@aws-blocks/bb-auth:BaselineDeferred',
						`Auth '${fullId}': not writing its first user-pool baseline yet, because this stack has an orphaned ` +
							'baseline (see the error). If this block is a renamed one, restoring its old id resolves both.',
					);
					break;
				case 'rebaselined':
					annotations.addInfoV2(
						'@aws-blocks/bb-auth:Rebaselined',
						`Auth '${fullId}': ${REBASELINE_ENV} accepted the current user-pool configuration into ${outcome.file}. ` +
							'Commit it. The deploy-time guard still refuses a change the live pool cannot take.',
					);
					break;
				default:
					break;
			}
			return [];
		},
	});
}

// ── Layer 2 ─────────────────────────────────────────────────────────────────

function addDeployTimeGuard(block: BuildingBlockScope, cfnPool: cognito.CfnUserPool): void {
	const stack = cdk.Stack.of(cfnPool);
	let state = guards.get(stack);
	if (!state) {
		const pools: GuardState['pools'] = [];
		state = { resource: createGuardResource(stack, block, pools), pools };
		guards.set(stack, state);
	}
	state.pools.push({ fullId: block.fullId, cfnPool });
	// The ordering: the pool waits for the guard. A `Ref` the other way round
	// would make the guard run *after* the pool update it exists to prevent.
	cfnPool.node.addDependency(state.resource);
}

function createGuardResource(
	stack: cdk.Stack,
	block: BuildingBlockScope,
	pools: GuardState['pools'],
): cdk.CustomResource {
	const logRetention = block.defaults.logRetention;
	const fn = new lambda.Function(stack, GUARD_IDS.function, {
		runtime: DEFAULT_NODE_RUNTIME,
		handler: 'index.handler',
		code: deployTimeLambdaCode(LAMBDA),
		timeout: cdk.Duration.minutes(1),
		description: 'AWS Blocks Auth: refuses user-pool changes Cognito cannot apply, before the pool update runs.',
		logGroup: new logs.LogGroup(stack, GUARD_IDS.functionLogs, {
			retention: logRetention,
			removalPolicy: cdk.RemovalPolicy.DESTROY,
		}),
	});
	// Least privilege. Read-only. DescribeStacks (rollback detection) and
	// DescribeStackResource (find the pool by logical id) on this stack only.
	fn.addToRolePolicy(
		new iam.PolicyStatement({
			actions: ['cloudformation:DescribeStacks', 'cloudformation:DescribeStackResource'],
			resources: [stack.stackId],
		}),
	);
	// The pool id is not known without a reference to the pool, which would
	// invert the ordering — so the read is scoped to user pools in this account
	// and region rather than to one pool.
	fn.addToRolePolicy(
		new iam.PolicyStatement({
			actions: ['cognito-idp:DescribeUserPool'],
			resources: [stack.formatArn({ service: 'cognito-idp', resource: 'userpool', resourceName: '*' })],
		}),
	);
	const provider = new cr.Provider(stack, GUARD_IDS.provider, {
		onEventHandler: fn,
		logGroup: new logs.LogGroup(stack, GUARD_IDS.providerLogs, {
			retention: logRetention,
			removalPolicy: cdk.RemovalPolicy.DESTROY,
		}),
	});
	return new cdk.CustomResource(stack, GUARD_IDS.resource, {
		serviceToken: provider.serviceToken,
		resourceType: 'Custom::BlocksAuthPoolGuard',
		properties: {
			// JSON-encoded: CloudFormation stringifies custom-resource property
			// values, which would turn `false` into "false" and drop nulls.
			Pools: cdk.Lazy.any({
				produce: () =>
					pools.map((p) => ({
						FullId: p.fullId,
						PoolLogicalId: p.cfnPool.logicalId,
						Snapshot: JSON.stringify(snapshotOfPool(p.cfnPool)),
					})),
			}),
		},
	});
}
