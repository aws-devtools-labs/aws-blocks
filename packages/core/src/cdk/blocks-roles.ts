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
 * The same walk reaches the `AWS::KMS::Key` resources in those scopes, for
 * checks that read key policies ({@link forEachBlocksKmsKey}).
 *
 * The covered set also holds roles the app creates itself (in a `BlocksStack`
 * the root's subtree is the whole stack; in either root the app's backend
 * module adds constructs). {@link isAppOwnedRole} tells those apart from the
 * roles AWS Blocks creates, by who created them, for checks that treat the two
 * differently.
 *
 * @internal
 */

import * as cdk from 'aws-cdk-lib';
import * as cxapi from 'aws-cdk-lib/cx-api';
import { Construct, type IConstruct } from 'constructs';

/** A function called once for every IAM role AWS Blocks created for a root. */
export type BlocksRoleVisitor = (role: cdk.CfnResource) => void;

/** A function called once for every KMS key in the scopes covered for a root. */
export type BlocksKmsKeyVisitor = (key: cdk.CfnResource) => void;

/** Construct ids of the per-stack providers CDK adds for cross-region references. */
const CROSS_REGION_PROVIDER = /^Custom::CrossRegionExport(Writer|Reader)CustomResourceProvider$/;

const ROLE_TYPE = 'AWS::IAM::Role';
const KMS_KEY_TYPE = 'AWS::KMS::Key';

interface RoleCoverage {
	readonly visitors: BlocksRoleVisitor[];
	/** Roles reached so far, in visit order; each has been passed to every visitor. */
	readonly roles: cdk.CfnResource[];
	readonly seen: WeakSet<cdk.CfnResource>;
	readonly keyVisitors: BlocksKmsKeyVisitor[];
	/** `AWS::KMS::Key` resources reached so far by the same walk; each has been passed to every key visitor. */
	readonly keys: cdk.CfnResource[];
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
		keyVisitors: [],
		keys: [],
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

function isKmsKey(node: IConstruct): node is cdk.CfnResource {
	return cdk.CfnResource.isCfnResource(node) && node.cfnResourceType === KMS_KEY_TYPE;
}

function visitKmsKey(coverage: RoleCoverage, key: cdk.CfnResource): void {
	if (coverage.seen.has(key)) return;
	coverage.seen.add(key);
	coverage.keys.push(key);
	for (const visitor of coverage.keyVisitors) visitor(key);
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
				else if (isKmsKey(node)) visitKmsKey(coverage, node);
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
 * Register `visitor` for every `AWS::KMS::Key` in the scopes covered for `root`:
 * the same walk, and so the same coverage, as {@link forEachBlocksRole} (the
 * root's subtree, the stack-level additions of an embedded backend, and
 * `Hosting`'s subtree and helper stacks). Keys are visited at synth, in
 * registration order. The prepare-time cross-region providers hold no keys.
 */
export function forEachBlocksKmsKey(root: Construct, visitor: BlocksKmsKeyVisitor): void {
	const coverage = coverageOf(root);
	coverage.keyVisitors.push(visitor);
	for (const key of coverage.keys) visitor(key);
}

/**
 * Snapshot `scope`'s direct children — take it before building something that
 * may hoist constructs to `scope`, then pass it to the cover* functions.
 */
export function snapshotChildren(scope: Construct): ReadonlySet<IConstruct> {
	return new Set(scope.node.children);
}

const BLOCKS_OWNED = Symbol.for('blocks:BlocksOwned');
const FRAMEWORK_CHILDREN = Symbol.for('blocks:FrameworkChildren');
const APP_STACK_CHILDREN = Symbol.for('blocks:AppStackChildren');

/**
 * Mark `construct` (and so every role under it) as created by AWS Blocks, not
 * by the app. A Scope marks itself when its `bbName` is an official Building
 * Block's; computes, `RawRoute` and first-party blocks without an official
 * `bbName` mark themselves in their constructors; framework code that adds a
 * construct to stack (or root) scope on a block's behalf marks it there
 * (`getOrCreateOnRoot` does this for whatever its factory adds). A `Scope` or
 * `Scope` subclass the app writes is not marked.
 */
export function markBlocksOwned(construct: IConstruct): void {
	(construct as unknown as Record<symbol, boolean>)[BLOCKS_OWNED] = true;
}

/**
 * Mark the children `scope` gained since `before` (a snapshot of
 * `scope.node.children`) as AWS Blocks' own — for framework code that adds
 * shared constructs at stack scope on a block's behalf, outside
 * `getOrCreateOnRoot`.
 */
export function markAddedChildrenBlocksOwned(scope: IConstruct, before: ReadonlySet<IConstruct>): void {
	for (const child of scope.node.children) if (!before.has(child)) markBlocksOwned(child);
}

function isMarked(construct: IConstruct): boolean {
	return (construct as unknown as Record<symbol, boolean | undefined>)[BLOCKS_OWNED] === true;
}

/**
 * Record the direct children of a backend root (`BlocksStack` or embedded
 * `BlocksBackend`) that the framework added: everything `create()` added
 * outside the app's backend module (the module's own additions, and whatever
 * the app adds after `create()` returns, are left out). Called once, at the end
 * of `create()`; until then — and for any other root — every covered role
 * counts as framework-owned.
 */
export function recordFrameworkChildren(root: Construct, children: ReadonlySet<IConstruct>): void {
	(root as unknown as Record<symbol, ReadonlySet<IConstruct>>)[FRAMEWORK_CHILDREN] = children;
}

/**
 * Whether `role` is one the app created rather than one AWS Blocks created —
 * classified by who created it, not by where it sits:
 *
 * - **framework-owned** when it, or a construct above it, is marked
 *   ({@link markBlocksOwned}: an official Building Block, a compute, a hoisted
 *   provider, Hosting); when it sits under a direct child of the root that the
 *   framework added ({@link recordFrameworkChildren}); or when it lies outside
 *   the root's stack (Hosting's helper stacks, Lambda@Edge peers);
 * - **app-owned** otherwise: under a direct child of the root that the backend
 *   module (or app code after `create()`) added and no mark above it, including
 *   a `Scope` subclass the app writes; or, for an embedded `BlocksBackend`,
 *   under a stack-level construct the backend module added unmarked.
 *
 * Always `false` for a root with no recorded framework children.
 */
export function isAppOwnedRole(root: Construct, role: IConstruct): boolean {
	const store = root as unknown as Record<symbol, ReadonlySet<IConstruct> | undefined>;
	const framework = store[FRAMEWORK_CHILDREN];
	if (!framework) return false;
	const stack = cdk.Stack.of(root);
	// Walk up to the direct child of the root (or, for a role outside the
	// root's subtree, the direct child of its stack), stopping at any mark.
	let node: IConstruct = role;
	while (node.node.scope && node.node.scope !== root && node.node.scope !== stack) {
		if (isMarked(node)) return false;
		node = node.node.scope;
	}
	if (isMarked(node)) return false;
	if (node.node.scope === root) return !framework.has(node);
	if (node.node.scope === stack) return store[APP_STACK_CHILDREN]?.has(node) === true;
	return false;
}

function coverNewChildren(
	coverage: RoleCoverage,
	parent: Construct,
	before: ReadonlySet<IConstruct>,
	exclude: IConstruct,
	unmarked: ReadonlySet<IConstruct> = new Set(),
): void {
	for (const child of parent.node.children) {
		if (child === exclude || before.has(child)) continue;
		coverScope(coverage, child);
		if (!unmarked.has(child)) markBlocksOwned(child);
	}
}

/**
 * Cover the constructs added **directly at stack scope** while an embedded
 * `BlocksBackend` was created (`before` = {@link snapshotChildren} of its stack,
 * taken first). Those per-stack singletons exist only because a block asked for
 * them; roles the stack already had (the customer's own) are left alone. A
 * singleton is created once per stack, so with several backends it belongs to
 * the backend that created it first.
 *
 * `addedByModule` holds the stack-level constructs added while the app's
 * backend module ran. They are covered too, but only the ones framework code
 * marked count as AWS Blocks'; the rest are recorded as the app's
 * ({@link isAppOwnedRole}). Everything else added is marked.
 */
export function coverStackLevelAdditions(
	backend: Construct,
	before: ReadonlySet<IConstruct>,
	addedByModule: ReadonlySet<IConstruct> = new Set(),
): void {
	coverNewChildren(coverageOf(backend), cdk.Stack.of(backend), before, backend, addedByModule);
	(backend as unknown as Record<symbol, ReadonlySet<IConstruct>>)[APP_STACK_CHILDREN] = addedByModule;
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
	markBlocksOwned(hosting);
	coverNewChildren(coverage, stack, before.stack, hosting);

	const stage = cdk.Stage.of(hosting);
	const helperStacks = (stage?.node.children ?? []).filter(
		(c): c is cdk.Stack => cdk.Stack.isStack(c) && !before.stage.has(c),
	);
	for (const helper of helperStacks) coverScope(coverage, helper);

	const edgeStacks = stack.dependencies.filter((s) => s.node.id.startsWith('edge-lambda-stack-'));
	for (const fn of edgeFunctions) {
		for (const edgeStack of edgeStacks) {
			const peer = edgeStack.node.tryFindChild(fn.node.id);
			if (peer) coverScope(coverage, peer);
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
