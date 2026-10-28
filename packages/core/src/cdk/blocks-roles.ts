// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The single internal answer to "which IAM roles did AWS Blocks create for this
 * backend root?" — and a visitor registry over exactly that set.
 *
 * Every consumer that has to touch every Blocks role (the permissions boundary,
 * the synth-time IAM report, and a future tenant-tagging pass) registers a
 * visitor with {@link forEachBlocksRole} instead of walking the tree itself, so
 * the coverage rules below live in one place:
 *
 * - **the root's subtree** — the whole stack for a `BlocksStack`, the backend's
 *   construct subtree for an embedded `BlocksBackend` (roles added later, e.g. by
 *   a new compute, are covered because the walk is an aspect run at synth);
 * - **stack-level additions** — roles CDK hoists to stack scope on a block's
 *   behalf while an embedded backend is created (custom-resource providers,
 *   `BucketDeployment`, log retention, the API Gateway CloudWatch role);
 * - **Hosting** — its subtree, the stack-level singletons and the helper stacks
 *   it adds (the `us-east-1` CloudFront monitoring stack), and its Lambda@Edge
 *   functions' peers in the shared `edge-lambda-stack-*`;
 * - **prepare-time roles** — the cross-region export writer/reader providers CDK
 *   adds while *preparing* the app, after every aspect has run. These are visited
 *   from a custom-synthesis hook ({@link finalizeBlocksRoles}).
 *
 * Each role is visited once per visitor, whichever way it was reached.
 *
 * @internal
 */

import * as cdk from 'aws-cdk-lib';
import * as cxapi from 'aws-cdk-lib/cx-api';
import { Construct, type IConstruct } from 'constructs';

/** A function called once for every IAM role AWS Blocks created for a root. */
export type BlocksRoleVisitor = (role: cdk.CfnResource) => void;

/** Construct ids of the per-stack providers CDK adds for cross-region references. */
const CROSS_REGION_PROVIDER = /^Custom::CrossRegionExport(Writer|Reader)CustomResourceProvider$/;

const ROLE_TYPE = 'AWS::IAM::Role';

interface RoleCoverage {
	readonly visitors: BlocksRoleVisitor[];
	/** Roles reached so far, in visit order; each has been passed to every visitor. */
	readonly roles: cdk.CfnResource[];
	readonly seen: WeakSet<cdk.CfnResource>;
	/** Scopes already walked by an aspect (avoids stacking duplicate aspects). */
	readonly scopes: WeakSet<IConstruct>;
	/** Stacks whose prepare-time cross-region provider roles belong to this root. */
	readonly lateStacks: Set<cdk.Stack>;
	finalized: boolean;
}

const COVERAGE = Symbol.for('blocks:RoleCoverage');

function coverageOf(root: Construct): RoleCoverage {
	const store = root as unknown as Record<symbol, RoleCoverage | undefined>;
	const existing = store[COVERAGE];
	if (existing) return existing;
	const created: RoleCoverage = {
		visitors: [],
		roles: [],
		seen: new WeakSet(),
		scopes: new WeakSet(),
		lateStacks: new Set(),
		finalized: false,
	};
	store[COVERAGE] = created;
	return created;
}

function isRole(node: IConstruct): node is cdk.CfnResource {
	return cdk.CfnResource.isCfnResource(node) && node.cfnResourceType === ROLE_TYPE;
}

function visitRole(coverage: RoleCoverage, role: cdk.CfnResource): void {
	if (coverage.seen.has(role)) return;
	coverage.seen.add(role);
	coverage.roles.push(role);
	for (const visitor of coverage.visitors) visitor(role);
}

/**
 * Same priority CDK's own `PermissionsBoundary` aspect uses, so ordering against
 * CDK's `@aws-cdk/core:permissionsBoundary` context stays as it was: ours is added
 * later or deeper, so it runs after (and wins over) the context's.
 */
function mutatingPriority(scope: IConstruct): number | undefined {
	return cdk.FeatureFlags.of(scope).isEnabled(cxapi.ASPECT_PRIORITIES_MUTATING)
		? cdk.AspectPriority.MUTATING
		: undefined;
}

function coverScope(coverage: RoleCoverage, scope: IConstruct): void {
	if (coverage.scopes.has(scope)) return;
	coverage.scopes.add(scope);
	cdk.Aspects.of(scope).add(
		{
			visit(node) {
				if (isRole(node)) visitRole(coverage, node);
			},
		},
		{ priority: mutatingPriority(scope) },
	);
}

/**
 * Start covering a backend root (`BlocksStack` or `BlocksBackend`): its subtree,
 * plus a custom-synthesis hook that reaches the prepare-time roles. Idempotent.
 * Called from `setupBlocksInfra`.
 */
export function coverBlocksRoot(root: Construct): void {
	const coverage = coverageOf(root);
	if (coverage.scopes.has(root)) return;
	coverScope(coverage, root);
	// A plain child construct carries the hook: CDK runs custom synthesis after
	// prepare and before any template is written.
	cdk.attachCustomSynthesis(new Construct(root, 'BlocksRoleCoverage'), {
		onSynthesize: () => finalizeBlocksRoles(root),
	});
}

/**
 * Register `visitor` for every IAM role AWS Blocks creates for `root` — including
 * roles added after this call and the prepare-time ones. Visitors run at synth,
 * in registration order.
 */
export function forEachBlocksRole(root: Construct, visitor: BlocksRoleVisitor): void {
	const coverage = coverageOf(root);
	coverage.visitors.push(visitor);
	// Roles already reached (only possible once synthesis has begun) get it too.
	for (const role of coverage.roles) visitor(role);
}

/**
 * Snapshot `scope`'s direct children — take it before building something that
 * may hoist constructs to `scope`, then pass it to the cover* functions.
 */
export function snapshotChildren(scope: Construct): ReadonlySet<IConstruct> {
	return new Set(scope.node.children);
}

function coverNewChildren(
	coverage: RoleCoverage,
	parent: Construct,
	before: ReadonlySet<IConstruct>,
	exclude: IConstruct,
): void {
	for (const child of parent.node.children) {
		if (child === exclude || before.has(child)) continue;
		coverScope(coverage, child);
	}
}

/**
 * Cover the constructs added **directly at stack scope** while an embedded
 * `BlocksBackend` was created (`before` = {@link snapshotChildren} of its stack,
 * taken first). Those per-stack singletons exist only because a block asked for
 * them; roles the stack already had (the customer's own) are left alone. A
 * singleton is created once per stack, so with several backends it belongs to
 * the backend that created it first.
 */
export function coverStackLevelAdditions(backend: Construct, before: ReadonlySet<IConstruct>): void {
	coverNewChildren(coverageOf(backend), cdk.Stack.of(backend), before, backend);
}

/** Constructs added to the stack and to the stage while `Hosting` was built. */
export interface HostingSnapshot {
	readonly stack: ReadonlySet<IConstruct>;
	readonly stage: ReadonlySet<IConstruct>;
}

/** Snapshot the stack's and stage's children before `Hosting` builds anything. */
export function snapshotForHosting(hosting: Construct): HostingSnapshot {
	const stage = cdk.Stage.of(hosting);
	return { stack: snapshotChildren(cdk.Stack.of(hosting)), stage: stage ? snapshotChildren(stage) : new Set() };
}

/**
 * Cover a `Hosting` construct's roles on behalf of the backend it fronts
 * (`owner`): its subtree, the stack-level singletons and the helper stacks it
 * added, and its Lambda@Edge functions. On a stack outside `us-east-1`,
 * `experimental.EdgeFunction` builds the real function (and its role) in a shared
 * `edge-lambda-stack-*` under the same construct id and doesn't expose that role,
 * so it's found there by id. The helper stacks' cross-region providers are
 * reached at finalize. No-op without an owning root.
 */
export function coverHosting(
	hosting: Construct,
	owner: Construct | undefined,
	before: HostingSnapshot,
	edgeFunctions: readonly IConstruct[],
): void {
	if (!owner) return;
	const coverage = coverageOf(owner);
	const stack = cdk.Stack.of(hosting);
	coverScope(coverage, hosting);
	coverNewChildren(coverage, stack, before.stack, hosting);

	const stage = cdk.Stage.of(hosting);
	const helperStacks = (stage?.node.children ?? []).filter(
		(c): c is cdk.Stack => cdk.Stack.isStack(c) && !before.stage.has(c),
	);
	for (const helper of helperStacks) coverScope(coverage, helper);

	// The edge stack is CDK's `edge-lambda-stack-<hash>`, or `<app id>-edge` under
	// `defaults.app`. `EdgeFunction` keeps the real function in its private
	// `_edgeFunction`, so that function's own stack is the edge stack exactly;
	// if a CDK version drops the field, fall back to a dependency holding a child
	// with the edge function's id.
	const edgeStacks: cdk.Stack[] = [];
	const addEdge = (edgeStack: cdk.Stack, scope: IConstruct) => {
		coverScope(coverage, scope);
		if (!edgeStacks.includes(edgeStack)) edgeStacks.push(edgeStack);
	};
	for (const fn of edgeFunctions) {
		const real = (fn as { _edgeFunction?: unknown })._edgeFunction;
		if (real && Construct.isConstruct(real)) {
			const edgeStack = cdk.Stack.of(real);
			if (edgeStack !== stack) addEdge(edgeStack, real);
			continue;
		}
		for (const dependency of stack.dependencies) {
			const peer = dependency.node.tryFindChild(fn.node.id);
			if (peer) addEdge(dependency, peer);
		}
	}

	for (const s of [stack, ...helperStacks, ...edgeStacks]) coverage.lateStacks.add(s);
}

/**
 * Visit the roles CDK adds during *prepare* — after aspects, so no aspect reaches
 * them: the cross-region export writer/reader providers in the stacks Hosting
 * touched. Called from the coverage hook, and by any synthesis-time consumer
 * (the IAM report) that needs the complete set first. Idempotent; only valid
 * once synthesis has begun.
 */
export function finalizeBlocksRoles(root: Construct): readonly cdk.CfnResource[] {
	const coverage = coverageOf(root);
	if (!coverage.finalized) {
		coverage.finalized = true;
		for (const stack of coverage.lateStacks) {
			for (const provider of stack.node.children) {
				if (!CROSS_REGION_PROVIDER.test(provider.node.id)) continue;
				for (const node of provider.node.findAll()) if (isRole(node)) visitRole(coverage, node);
			}
		}
	}
	return coverage.roles;
}
