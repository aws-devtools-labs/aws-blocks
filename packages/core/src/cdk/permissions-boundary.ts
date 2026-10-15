// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { Construct, IConstruct } from 'constructs';
import type { BlocksDefaults } from './blocks-defaults.js';

/** CDK's own stack-wide boundary context key (see the CDK guide "Permissions boundaries"). */
const CDK_BOUNDARY_CONTEXT_KEY = '@aws-cdk/core:permissionsBoundary';

/** Per-root slot holding the resolved boundary, so other constructs (e.g. Hosting) can apply the same one. */
const ROOT_BOUNDARY = Symbol.for('blocks:PermissionsBoundary');

/** Per-stack record of which backend applied which boundary — detects a mixed-boundary stack. */
const STACK_BOUNDARIES = Symbol.for('blocks:StackPermissionsBoundaries');

/** IAM managed-policy name charset/length (`[\w+=,.@-]`, 1–128). */
const POLICY_NAME = /^[\w+=,.@-]{1,128}$/;

/** `arn:<partition>:iam::<account|aws>:policy/<optional path/>name`. */
const POLICY_ARN = /^arn:aws[a-z-]*:iam::(\d{12}|aws):policy\/([\w+=,.@-]+\/)*[\w+=,.@-]{1,128}$/;

function invalid(detail: string): Error {
	return new Error(
		`Invalid defaults.permissionsBoundary: ${detail}\n` +
			'Pass the name of a customer-managed IAM policy in the deploying account (e.g. "app-boundary"), ' +
			'its full ARN (e.g. "arn:aws:iam::123456789012:policy/platform/app-boundary"), or an iam.IManagedPolicy.',
	);
}

/**
 * Validate `defaults.permissionsBoundary` and resolve it to an `IManagedPolicy`
 * imported under `root`. Returns `undefined` when the option is unset.
 *
 * @internal
 */
export function resolvePermissionsBoundary(
	root: Construct,
	input: BlocksDefaults['permissionsBoundary'],
): iam.IManagedPolicy | undefined {
	if (input === undefined) return undefined;
	if (typeof input === 'string') {
		const value = input.trim();
		if (value === '') throw invalid('the value is empty.');
		// A token (CfnParameter, Fn.importValue, …) can only be an ARN at deploy time.
		if (cdk.Token.isUnresolved(value) || value.startsWith('arn:')) {
			if (!cdk.Token.isUnresolved(value) && !POLICY_ARN.test(value)) {
				throw invalid(`"${value}" is not an IAM managed policy ARN.`);
			}
			return iam.ManagedPolicy.fromManagedPolicyArn(root, 'BlocksPermissionsBoundary', value);
		}
		if (value.includes('/')) {
			throw invalid(`"${value}" contains a path — a boundary policy with a path needs its full ARN.`);
		}
		if (!POLICY_NAME.test(value)) throw invalid(`"${value}" is not a valid IAM policy name.`);
		return iam.ManagedPolicy.fromManagedPolicyName(root, 'BlocksPermissionsBoundary', value);
	}
	if (typeof input === 'object' && input !== null && typeof input.managedPolicyArn === 'string') {
		return input;
	}
	throw invalid('expected a string or an iam.IManagedPolicy.');
}

/**
 * Resolve `defaults.permissionsBoundary` and apply it (CDK's own
 * `PermissionsBoundary` aspect) to every IAM role and user under `root`,
 * including ones a block adds later. Records the boundary on `root` for
 * {@link getRootPermissionsBoundary}. No-op when unset.
 *
 * Warns when the stack also carries CDK's `@aws-cdk/core:permissionsBoundary`
 * context: for constructs under `root` the Blocks option wins (it is the more
 * specific aspect, so it runs last), which is rarely what a platform expects.
 *
 * @internal
 */
export function applyBlocksPermissionsBoundary(
	root: Construct,
	defaults: BlocksDefaults,
): iam.IManagedPolicy | undefined {
	const boundary = resolvePermissionsBoundary(root, defaults.permissionsBoundary);
	if (!boundary) return undefined;
	(root as unknown as Record<symbol, unknown>)[ROOT_BOUNDARY] = boundary;
	iam.PermissionsBoundary.of(root).apply(boundary);

	if (root.node.tryGetContext(CDK_BOUNDARY_CONTEXT_KEY) !== undefined) {
		cdk.Annotations.of(root).addWarningV2(
			'blocks:iam:permissionsBoundaryOverridesContext',
			`defaults.permissionsBoundary is set while the CDK "${CDK_BOUNDARY_CONTEXT_KEY}" context is also set. ` +
				'For roles AWS Blocks creates, defaults.permissionsBoundary wins; the context still applies to the ' +
				'rest of the stack. Set only one of them unless that split is intended.',
		);
	}
	return boundary;
}

/**
 * The boundary {@link applyBlocksPermissionsBoundary} resolved for `root`, or
 * `undefined` when `defaults.permissionsBoundary` is unset.
 *
 * @internal
 */
export function getRootPermissionsBoundary(root: Construct): iam.IManagedPolicy | undefined {
	return (root as unknown as Record<symbol, iam.IManagedPolicy | undefined>)[ROOT_BOUNDARY];
}

/**
 * Snapshot `scope`'s direct children — call before a backend is built, then pass
 * the result to {@link applyBoundaryToStackLevelAdditions}.
 *
 * @internal
 */
export function snapshotChildren(scope: Construct): ReadonlySet<IConstruct> {
	return new Set(scope.node.children);
}

/**
 * Apply `backend`'s boundary to the constructs added **directly at stack scope**
 * while it was being created (`before` = {@link snapshotChildren} taken first).
 *
 * An embedded `BlocksBackend` is one subtree of a stack it doesn't own, so the
 * aspect {@link applyBlocksPermissionsBoundary} adds on the backend doesn't
 * reach roles CDK hoists to the stack on a block's behalf — the per-stack
 * singletons such as the `Custom::S3AutoDeleteObjects` provider, the
 * `BucketDeployment` handler and the log-retention function. Those exist only
 * because a block asked for them, so they're capped too; roles the stack already
 * had (the customer's own) are left alone.
 *
 * A singleton is created once per stack, so with several backends it carries
 * the boundary of the backend that created it first. When backends in one stack
 * disagree on the boundary this warns, since the shared singletons can only take
 * one of them.
 *
 * @internal
 */
export function applyBoundaryToStackLevelAdditions(backend: Construct, before: ReadonlySet<IConstruct>): void {
	const stack = cdk.Stack.of(backend);
	const boundary = getRootPermissionsBoundary(backend);
	const key = boundary ? JSON.stringify(stack.resolve(boundary.managedPolicyArn)) : 'none';

	const store = stack as unknown as Record<symbol, Map<string, string> | undefined>;
	const seen = store[STACK_BOUNDARIES] ?? new Map<string, string>();
	store[STACK_BOUNDARIES] = seen;
	const others = [...seen.entries()].filter(([, other]) => other !== key).map(([path]) => path);
	seen.set(backend.node.path, key);
	if (others.length > 0) {
		cdk.Annotations.of(backend).addWarningV2(
			'blocks:iam:permissionsBoundaryMixed',
			`This BlocksBackend has a different permissionsBoundary than ${others.join(', ')} in the same stack. ` +
				'Roles inside each backend get their own boundary, but per-stack CDK singleton roles (custom-resource ' +
				'providers, BucketDeployment, log retention) are shared and keep the boundary of the backend that ' +
				'created them first. Use one boundary per stack, or apply one stack-wide with ' +
				'iam.PermissionsBoundary.of(stack).apply(...).',
		);
	}

	if (boundary) applyToNewChildren(stack, before, backend, boundary);
}

function applyToNewChildren(
	parent: Construct,
	before: ReadonlySet<IConstruct>,
	exclude: IConstruct,
	boundary: iam.IManagedPolicy,
): void {
	for (const child of parent.node.children) {
		if (child === exclude || before.has(child)) continue;
		iam.PermissionsBoundary.of(child).apply(boundary);
	}
}

/** Construct ids of the per-stack providers CDK adds for cross-region references (`crossRegionReferences`). */
const CROSS_REGION_PROVIDER = /^Custom::CrossRegionExport(Writer|Reader)CustomResourceProvider$/;

/** Constructs added to the stack and to the stage (separate helper stacks) while `Hosting` was built. */
export interface HostingSnapshot {
	readonly stack: ReadonlySet<IConstruct>;
	readonly stage: ReadonlySet<IConstruct>;
}

/**
 * Snapshot the stack's and stage's children before `Hosting` builds anything —
 * pass the result to {@link applyBoundaryToHosting}.
 *
 * @internal
 */
export function snapshotForHosting(hosting: Construct): HostingSnapshot {
	const stage = cdk.Stage.of(hosting);
	return { stack: snapshotChildren(cdk.Stack.of(hosting)), stage: stage ? snapshotChildren(stage) : new Set() };
}

/**
 * Cap a `Hosting` construct's roles with the boundary of the backend it fronts
 * (`owner`). No-op when the owner has no boundary. Covers:
 *
 * - its own subtree, and the stack-level CDK singletons added while it was built;
 * - the helper stacks it created (e.g. the `us-east-1` CloudFront monitoring
 *   stack) — separate stacks no aspect on the app's stack reaches;
 * - its Lambda@Edge functions: on a stack outside `us-east-1`,
 *   `experimental.EdgeFunction` builds the real function (and its role) in a
 *   shared `edge-lambda-stack-*` under the same construct id, and doesn't expose
 *   that role, so it's found there by id;
 * - the cross-region export writer/reader provider roles those helper stacks
 *   cause. CDK adds them while *preparing* the app — after every aspect has run —
 *   so neither an aspect nor CDK's own `@aws-cdk/core:permissionsBoundary`
 *   context reaches them. A custom-synthesis hook on `hosting` (which CDK runs
 *   after prepare, before any of these stacks' templates are written) caps them.
 *
 * @internal
 */
export function applyBoundaryToHosting(
	hosting: Construct,
	owner: Construct | undefined,
	before: HostingSnapshot,
	edgeFunctions: readonly IConstruct[],
): void {
	const boundary = owner ? getRootPermissionsBoundary(owner) : undefined;
	if (!boundary) return;
	const stack = cdk.Stack.of(hosting);
	iam.PermissionsBoundary.of(hosting).apply(boundary);
	applyToNewChildren(stack, before.stack, hosting, boundary);

	const stage = cdk.Stage.of(hosting);
	const helperStacks = (stage?.node.children ?? []).filter(
		(c): c is cdk.Stack => cdk.Stack.isStack(c) && !before.stage.has(c),
	);
	for (const helper of helperStacks) iam.PermissionsBoundary.of(helper).apply(boundary);

	const edgeStacks = stack.dependencies.filter((s) => s.node.id.startsWith('edge-lambda-stack-'));
	for (const fn of edgeFunctions) {
		for (const edgeStack of edgeStacks) {
			const peer = edgeStack.node.tryFindChild(fn.node.id);
			if (peer) iam.PermissionsBoundary.of(peer).apply(boundary);
		}
	}

	const touched = [stack, ...helperStacks, ...edgeStacks];
	cdk.attachCustomSynthesis(hosting, {
		onSynthesize() {
			for (const target of touched) {
				for (const provider of target.node.children) {
					if (!CROSS_REGION_PROVIDER.test(provider.node.id)) continue;
					for (const node of provider.node.findAll()) {
						if (cdk.CfnResource.isCfnResource(node) && node.cfnResourceType === 'AWS::IAM::Role') {
							node.addPropertyOverride('PermissionsBoundary', boundary.managedPolicyArn);
						}
					}
				}
			}
		},
	});
}
