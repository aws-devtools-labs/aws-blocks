// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Keep a role that many Building Blocks grant to deployable when its grants
 * outgrow the inline-policy budget.
 *
 * Every block grants onto a role through `grant*()` / `addToPrincipalPolicy()`,
 * which lands on the role's `DefaultPolicy` (an inline `AWS::IAM::Policy`; IAM
 * caps a role's inline policies at 10,240 characters in aggregate). aws-cdk-lib's
 * `iam.Role` already handles overflow: an aspect it adds in its constructor
 * (`Role.splitLargePolicy()`) keeps statements on the DefaultPolicy up to an
 * estimated 10,000 characters and packs the rest, first-fit, into
 * `OverflowPolicy1..N` managed policies (estimated 6,000 characters each, under
 * IAM's 6,144 limit) attached to the role, re-pointing each grant's dependables at
 * the policy its statements moved to. This module builds on that rather than
 * re-implementing it, and adds three things:
 *
 * 1. **Statement merging.** CDK merges statements only when the document's
 *    `minimize` option or the `@aws-cdk/aws-iam:minimizePolicies` feature flag is
 *    on. Turning the flag on would rewrite every policy in the app, so instead an
 *    aspect that runs just before CDK's split turns merging on for this one role's
 *    DefaultPolicy, whatever its size. CDK merges statements with the same effect
 *    and conditions (and no `Sid`, `NotAction` or `NotResource` differences) that
 *    share their actions or their resources, never both lists at once, so no
 *    permission is added. Merging is on for every size of role, so it never
 *    switches on or off as the grants grow.
 * 2. **Content-derived logical IDs for the overflow policies.** CDK assigns
 *    statements to the DefaultPolicy and `OverflowPolicyN` by position (first-fit),
 *    so adding or removing a grant, or merging, moves statements between those
 *    policies. CloudFormation updates sibling policies in parallel, so a moved
 *    statement can briefly be attached through none of them
 *    (https://github.com/aws/aws-cdk/issues/35611). An aspect that runs after
 *    CDK's split gives each overflow policy a logical ID derived from its content
 *    (`BlocksOverflowPolicy<hash>`) and makes the DefaultPolicy depend on every
 *    overflow policy. A changed overflow policy is then a new resource, created
 *    before the DefaultPolicy is updated, and the old one is deleted in
 *    CloudFormation's cleanup phase, so a statement is not removed from its old
 *    policy before its new policy is attached. IAM is eventually consistent, so a
 *    newly attached policy can still take a few seconds to apply. Because the
 *    DefaultPolicy depends on every overflow policy, making a resource depend on
 *    one specific grant to the role (e.g. `grant.applyBefore()`, a grant's
 *    `policyDependable`, or constructs such as AgentCore Memory given the role)
 *    while the role is also granted access to that resource can make
 *    CloudFormation report a circular dependency. Depend on the whole role
 *    instead, or use a separate role. See {@link StableOverflowPolicyIds}.
 * 3. **A synth-time quota check.** CDK only warns when a role ends up with more
 *    managed policies than IAM allows; the deploy then fails in CloudFormation. A
 *    validation fails synth instead, naming the Building Blocks that grant the
 *    most.
 *
 * Per role, so a future per-compute role can use it the same way.
 *
 * **aws-cdk-lib coupling.** Checked against aws-cdk-lib 2.257.0 (the oldest
 * version in core's peer range `^2.257.0`) and 2.274.0: in both, `PolicyDocument`
 * has an own, writable `minimize` field that `shouldMerge()` reads, and
 * `Role.splitLargePolicy()` calls `_splitDocument()`, which merges when
 * `shouldMerge()` is true. Only the `minimize` field is used. If a CDK upgrade
 * removes it or makes it read-only, merging is skipped with an info annotation
 * and CDK still packs the unmerged statements, which never changes permissions.
 * A CDK that keeps the field but ignores it isn't detected at synth;
 * `role-policy-packing.test.ts` asserts that merging takes effect with the
 * installed aws-cdk-lib, so such an upgrade fails a test rather than an app.
 *
 * @internal
 */

import { createHash } from 'node:crypto';
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cxapi from 'aws-cdk-lib/cx-api';
import type { Construct, IConstruct } from 'constructs';
import { cdkVersion } from './cdk-version.js';
import { attributeRoleStatements } from './iam-report.js';

/**
 * CDK context key that raises the managed-policies-per-role limit the quota check
 * enforces, for accounts whose IAM "Managed policies per role" quota was raised.
 * Named like other CDK Blocks context keys (`@aws-cdk-blocks/<package>:<option>`).
 *
 * @internal
 */
export const MANAGED_POLICIES_PER_ROLE_QUOTA_CONTEXT_KEY = '@aws-cdk-blocks/core:managedPoliciesPerRoleQuota';

/** IAM's default "Managed policies per role" quota. */
const DEFAULT_MANAGED_POLICIES_PER_ROLE = 20;
/** The most IAM lets that quota be raised to. */
const MAX_MANAGED_POLICIES_PER_ROLE = 25;
/** How many Building Blocks the quota error lists. */
const TOP_GRANTING_BLOCKS = 5;

/** Merging must be set before CDK's split aspect reads it, which uses this priority (`mutatingAspectPrio32333`). */
function cdkSplitPriority(scope: IConstruct): number {
	return cdk.FeatureFlags.of(scope).isEnabled(cxapi.ASPECT_PRIORITIES_MUTATING)
		? cdk.AspectPriority.MUTATING
		: cdk.AspectPriority.DEFAULT;
}

/**
 * Priority of {@link StableOverflowPolicyIds}. CDK's split runs at MUTATING (200)
 * or DEFAULT (500), depending on `@aws-cdk/core:aspectPrioritiesMutating`; 600 is
 * after both, so every `OverflowPolicyN` exists, and before READONLY (1000)
 * aspects such as validators, so they see the final logical IDs.
 */
const OVERFLOW_ID_PRIORITY = cdk.AspectPriority.DEFAULT + 100;

/** Logical-ID prefix of the overflow policies; the rest is a content hash. */
const OVERFLOW_POLICY_ID_PREFIX = 'BlocksOverflowPolicy';

/** Roles packing has already been enabled for, so a second call adds nothing. */
const enabledRoles = new WeakMap<iam.Role, true>();

/** Roles whose DefaultPolicy document had `minimize` set, read back by the quota error. */
const mergedRoles = new WeakMap<iam.Role, true>();

/**
 * Turn on statement merging, content-derived overflow-policy logical IDs and the
 * managed-policy quota check for `role` (see the module docs). Idempotent. Grant helpers are unaffected: blocks keep
 * calling `grant*()` / `addToPrincipalPolicy()` on the role as before.
 *
 * @param root - the CDK Blocks root whose Building Blocks the quota error attributes
 *   grants to (defaults to the role's stack).
 * @internal
 */
export function enableRolePolicyPacking(role: iam.Role, root: Construct = cdk.Stack.of(role)): void {
	if (enabledRoles.has(role)) return;
	enabledRoles.set(role, true);

	cdk.Aspects.of(role).add(
		{
			visit(node) {
				if (node === role) requestMerging(role);
			},
		},
		// One below CDK's split, so it runs after aspects with a lower priority and
		// before the split. Merging is a flag on the document, so the split merges
		// every statement the document holds when it runs, including grants added by
		// an inherited aspect at CDK's split priority (those sort between this aspect
		// and the split). A grant added after the split is not packed, as in plain CDK.
		{ priority: cdkSplitPriority(role) - 1 },
	);
	cdk.Aspects.of(role).add(new StableOverflowPolicyIds(role), { priority: OVERFLOW_ID_PRIORITY });

	// Validations run after every aspect, so this sees the OverflowPolicyN children
	// CDK's split created.
	role.node.addValidation({
		validate: () => validateManagedPolicyQuota(role, root),
	});
}

/**
 * Turn on CDK's statement merging for `role`'s DefaultPolicy document.
 *
 * Internal coupling: `PolicyDocument` keeps its `minimize` constructor option in a
 * field that `shouldMerge()` reads (`this.minimize ?? <feature flag>`) from both
 * `_splitDocument()` and `resolve()`. Setting that field to `true` is what passing
 * `minimize: true` to the constructor would have done. There is no public way to
 * change it after construction, and the feature flag can't be scoped to the role
 * (`node.setContext` is refused once a construct has children). If a CDK upgrade
 * removes the field or makes it read-only, merging is skipped with an info
 * annotation and CDK still packs the unmerged statements. A CDK that keeps the
 * field but stops reading it isn't detected here (see the module docs).
 */
function requestMerging(role: iam.Role): void {
	if (mergedRoles.has(role)) return;
	const defaultPolicy = role.node.tryFindChild('DefaultPolicy');
	if (!(defaultPolicy instanceof iam.Policy)) return;
	const document = defaultPolicy.document;

	if (!('minimize' in document)) {
		addMergeNotAppliedInfo(role);
		return;
	}
	try {
		(document as unknown as { minimize?: boolean }).minimize = true;
	} catch {
		// A future aws-cdk-lib might make the field read-only (getter-only or frozen).
		addMergeNotAppliedInfo(role);
		return;
	}
	mergedRoles.set(role, true);
}

/** Roles the merge-not-applied annotation was added to, so an aspect revisited by CDK doesn't repeat it. */
const mergeNotAppliedAnnotated = new WeakMap<iam.Role, true>();
function addMergeNotAppliedInfo(role: iam.Role): void {
	if (mergeNotAppliedAnnotated.has(role)) return;
	mergeNotAppliedAnnotated.set(role, true);
	cdk.Annotations.of(role).addInfo(
		`AWS CDK Blocks: this aws-cdk-lib version (${cdkVersion() ?? 'unknown'}) doesn't allow merging ${role.node.path}'s statements through ` +
			"PolicyDocument's 'minimize' field (the field is missing or read-only), so statements are packed into " +
			'managed policies without being merged first.',
	);
}

/** OverflowPolicyN managed policies CDK's split created on the role. */
function overflowPolicies(role: iam.Role): iam.ManagedPolicy[] {
	return role.node.children.filter(
		(c): c is iam.ManagedPolicy => c instanceof iam.ManagedPolicy && /^OverflowPolicy\d+$/.test(c.node.id),
	);
}

/**
 * The managed-policies-per-role limit to enforce: the context override when set,
 * else IAM's default. Returns an error message for an unusable value.
 */
function resolveQuota(role: iam.Role): number | string {
	const raw = role.node.tryGetContext(MANAGED_POLICIES_PER_ROLE_QUOTA_CONTEXT_KEY);
	if (raw === undefined) return DEFAULT_MANAGED_POLICIES_PER_ROLE;
	// `cdk -c key=value` passes strings, cdk.json passes numbers.
	const value = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
	if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_MANAGED_POLICIES_PER_ROLE) {
		return (
			`Context "${MANAGED_POLICIES_PER_ROLE_QUOTA_CONTEXT_KEY}" must be a whole number from 1 to ` +
			`${MAX_MANAGED_POLICIES_PER_ROLE} (IAM's maximum managed policies per role), got ${JSON.stringify(raw)}.`
		);
	}
	return value;
}

/**
 * Fail synth when `role` would carry more managed policies than IAM allows: the
 * ARNs in the role's `ManagedPolicyArns` plus every `AWS::IAM::ManagedPolicy` in
 * the role's stack that lists the role in `Roles` (CDK's `OverflowPolicyN`, and any
 * customer managed policy attached that way). Counted by identity, so a policy
 * attached both ways counts once.
 *
 * Only checked when CDK's split actually created `OverflowPolicyN` policies on the
 * role, i.e. when the grants themselves need managed policies. A role without
 * them keeps CDK's behavior (its own warning, no error), so an app that already
 * attaches more AWS-managed policies than the default quota, on an account with a
 * raised quota, synthesizes as before without having to set the quota key.
 *
 * The error lists the Building Blocks granting the most, because this runs in
 * CDK's validation phase, before synthesis writes the IAM report.
 *
 * The count is the role's steady state. While a deploy replaces changed overflow
 * policies (see {@link StableOverflowPolicyIds}), the role briefly carries both
 * the old and the new copy of each one, so a role at or near the quota can fail
 * that deploy in CloudFormation. This check doesn't add headroom for that (it
 * stays an error only for the steady state); {@link warnReplacementHeadroom}
 * adds a synth warning instead, and the README documents it.
 */
function validateManagedPolicyQuota(role: iam.Role, root: Construct): string[] {
	// An unusable value for this context key is reported regardless of packing.
	const quota = resolveQuota(role);
	if (typeof quota === 'string') return [quota];

	if (overflowPolicies(role).length === 0) return [];

	const attached = attachedManagedPolicyCount(role);
	if (attached <= quota) return [];
	const raise =
		quota < MAX_MANAGED_POLICIES_PER_ROLE
			? `If this account's IAM "Managed policies per role" quota has been raised, set the CDK context ` +
				`"${MANAGED_POLICIES_PER_ROLE_QUOTA_CONTEXT_KEY}" to the new quota (at most ` +
				`${MAX_MANAGED_POLICIES_PER_ROLE}), e.g. in cdk.json.`
			: `${MAX_MANAGED_POLICIES_PER_ROLE} is IAM's maximum, so the grants must be split across roles.`;
	const packed = mergedRoles.has(role)
		? 'even after merging statements and packing them into managed policies'
		: 'even after packing them into managed policies';
	const top = topGrantingBlocks(role, root);
	const topText =
		top.length > 0
			? ` The Building Blocks granting the most (approximate characters of policy statements): ${top
					.map((b) => `${b.fullId} (${b.path}): ~${b.chars}`)
					.join('; ')}.`
			: '';
	return [
		`AWS CDK Blocks: the IAM role ${role.node.path} needs ${attached} managed policies, more than the ` +
			`${quota} allowed per role. The Building Blocks granting to it need more permissions than fit on one ` +
			`role, ${packed}.${topText} To fix: consolidate resources where possible; or move some Building ` +
			'Blocks into a separate CDK Blocks backend (another BlocksStack or BlocksBackend), which has its own ' +
			`execution role. ${raise}`,
	];
}

/**
 * How many managed policies `role` carries: the ARNs in its `ManagedPolicyArns`
 * plus every `AWS::IAM::ManagedPolicy` in the role's stack that lists the role in
 * `Roles`, counted by identity so a policy attached both ways counts once.
 */
function attachedManagedPolicyCount(role: iam.Role): number {
	const stack = cdk.Stack.of(role);
	const roleCfn = role.node.defaultChild as iam.CfnRole;
	const roleRef = JSON.stringify({ Ref: stack.resolve(roleCfn.logicalId) });
	const attached = new Set<string>();
	for (const arn of asArray(stack.resolve(roleCfn.managedPolicyArns))) attached.add(JSON.stringify(arn));
	// Search the whole stack, not just the role's children: a managed policy can be
	// defined anywhere in the stack and attach itself to the role through `Roles`.
	for (const node of stack.node.findAll()) {
		if (!(node instanceof iam.CfnManagedPolicy) || cdk.Stack.of(node) !== stack) continue;
		if (!asArray(stack.resolve(node.roles)).some((r) => JSON.stringify(r) === roleRef)) continue;
		attached.add(JSON.stringify({ Ref: stack.resolve(node.logicalId) }));
	}
	return attached.size;
}

/** Roles the replacement-headroom warning was added to, so a forced re-synth doesn't repeat it. */
const headroomWarned = new WeakSet<iam.Role>();

/**
 * Warn (not fail) when `role` is within the managed-policies-per-role quota but
 * would exceed it while a deploy replaces every overflow policy: during that
 * deploy the new copies are attached before the old ones are deleted, so the role
 * briefly carries both. Over the quota in the steady state is the validation's
 * error instead, so this only covers the gap between the two.
 */
function warnReplacementHeadroom(role: iam.Role, overflowCount: number): void {
	if (headroomWarned.has(role)) return;
	const quota = resolveQuota(role);
	// An unusable quota value is reported by the validation.
	if (typeof quota === 'string') return;
	const attached = attachedManagedPolicyCount(role);
	if (attached > quota || attached + overflowCount <= quota) return;
	headroomWarned.add(role);
	cdk.Annotations.of(role).addWarningV2(
		'@aws-cdk-blocks/core:overflowPolicyReplacementQuota',
		`AWS CDK Blocks: the IAM role ${role.node.path} carries ${attached} managed policies, ${overflowCount} of them ` +
			`overflow policies, against a quota of ${quota} per role. A deploy that changes an overflow policy ` +
			'attaches the new copy before it deletes the old one, so a deploy that replaces every overflow policy ' +
			`would briefly need ${attached + overflowCount} and could fail in CloudFormation. Consolidate grants, ` +
			'move some Building Blocks into a separate CDK Blocks backend, or raise the quota ' +
			`("${MANAGED_POLICIES_PER_ROLE_QUOTA_CONTEXT_KEY}") if the account's IAM quota allows it.`,
	);
}

/**
 * The Building Blocks whose grants take the most room on `role`, by rendered
 * statement characters. A statement referencing several blocks' resources (e.g.
 * after merging) is split evenly between them, so the figures are approximate.
 */
function topGrantingBlocks(role: iam.Role, root: Construct): { fullId: string; path: string; chars: number }[] {
	const totals = new Map<string, { fullId: string; path: string; chars: number }>();
	for (const { statement, blocks } of attributeRoleStatements(root, role)) {
		if (blocks.length === 0) continue;
		const share = JSON.stringify(statement).length / blocks.length;
		for (const b of blocks) {
			const entry = totals.get(b.fullId) ?? { fullId: b.fullId, path: b.path, chars: 0 };
			entry.chars += share;
			totals.set(b.fullId, entry);
		}
	}
	return [...totals.values()]
		.map((b) => ({ ...b, chars: Math.round(b.chars) }))
		.sort((a, b) => b.chars - a.chars || a.fullId.localeCompare(b.fullId))
		.slice(0, TOP_GRANTING_BLOCKS);
}

/**
 * Give each `OverflowPolicyN` managed policy that CDK's split created on `role` a
 * logical ID derived from its content, and make the role's DefaultPolicy depend
 * on each of them (see the module docs for why, and for the circular dependency
 * this can cause when a resource depends on one specific grant to the role).
 *
 * Works around https://github.com/aws/aws-cdk/issues/35611 (CloudFormation
 * updates sibling policies in parallel while statements move between them). It
 * can be removed if aws-cdk-lib fixes that issue.
 *
 * Coupling: relies on the split naming its policies `OverflowPolicy<N>` as direct
 * children of the role. If a CDK upgrade renames them, this does nothing and the
 * role keeps CDK's own logical IDs; `role-policy-packing.test.ts` asserts that no
 * other overflow-policy logical ID is left, so such an upgrade fails a test.
 */
class StableOverflowPolicyIds implements cdk.IAspect {
	constructor(private readonly role: iam.Role) {}

	visit(node: IConstruct): void {
		// Visit the role, not each managed policy: by now the split has created every
		// overflow policy, so the full set is available in one place.
		if (node !== this.role) return;
		const overflow = overflowPolicies(this.role);
		if (overflow.length === 0) return;

		const stack = cdk.Stack.of(this.role);
		const defaultCfn = this.role.node.tryFindChild('DefaultPolicy')?.node.defaultChild;
		// Logical IDs already taken in this stack, for the collision check below.
		const byLogicalId = new Map<string, cdk.CfnElement>();
		for (const c of stack.node.findAll()) {
			if (c instanceof cdk.CfnElement && cdk.Stack.of(c) === stack)
				byLogicalId.set(stack.resolve(c.logicalId), c);
		}
		for (const policy of overflow) {
			const cfn = policy.node.defaultChild;
			if (!(cfn instanceof iam.CfnManagedPolicy)) continue;
			// Resolving gives the document as it will be written: merged statements and
			// `Ref` / `Fn::GetAtt` intrinsics (whose logical IDs are stable).
			const document = canonicalJson(stack.resolve(cfn.policyDocument));
			// The role path is hashed too, so two roles in one stack with identical
			// overflow documents get different IDs.
			const hash = createHash('sha256')
				.update(this.role.node.path)
				.update('\0')
				.update(document)
				.digest('hex')
				.slice(0, 8)
				.toUpperCase();
			const id = `${OVERFLOW_POLICY_ID_PREFIX}${hash}`;
			// 32 bits of hash: a collision is unlikely. CDK would fail synth on the
			// duplicate logical ID anyway; checking here gives a message that says why.
			const owner = byLogicalId.get(id);
			if (owner !== undefined && owner !== cfn) {
				throw new Error(
					`AWS CDK Blocks: overflow policy ${policy.node.path} got the logical ID ${id}, which ${owner.node.path} ` +
						'already has. Adding or removing a grant on the role changes its policy contents and so its ID.',
				);
			}
			cfn.overrideLogicalId(id);
			byLogicalId.set(id, cfn);
			if (!(defaultCfn instanceof cdk.CfnResource)) continue;
			// The DefaultPolicy keeps its logical ID and is updated in place. Ordering its
			// update after every overflow policy means a statement moving from it into a
			// new overflow policy is attached there before it is removed here; a statement
			// moving the other way is removed only when the old overflow policy is deleted,
			// in CloudFormation's cleanup phase, after the DefaultPolicy update.
			defaultCfn.node.addDependency(cfn);
		}
		warnReplacementHeadroom(this.role, overflow.length);
	}
}

/**
 * JSON with object keys sorted recursively, so equal documents hash equally.
 * Array order is kept: statement order is part of a policy's content.
 */
function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
	if (value !== null && typeof value === 'object') {
		const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
		return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
	}
	return JSON.stringify(value);
}

const asArray = (v: unknown): unknown[] => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);
