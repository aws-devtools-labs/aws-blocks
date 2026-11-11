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
 * re-implementing it, and adds two things:
 *
 * 1. **Opt-in statement merging** ({@link MERGE_EXECUTION_ROLE_POLICIES_CONTEXT_KEY}).
 *    CDK merges statements only when the document's `minimize` option or the
 *    `@aws-cdk/aws-iam:minimizePolicies` feature flag is on. Turning the flag on
 *    would rewrite every policy in the app, so instead, when the context key is
 *    true, an aspect that runs just before CDK's split turns merging on for this
 *    one role's DefaultPolicy, whatever its size. CDK merges statements with the
 *    same effect and conditions (and no `Sid`, `NotAction` or `NotResource`
 *    differences) that share their actions or their resources, never both lists
 *    at once, so no permission is added. With the key unset or false the role is
 *    exactly what CDK produces.
 *
 *    Merging is a context key rather than always on because, for a role that
 *    already overflows, turning it on moves statements between the DefaultPolicy
 *    and the `OverflowPolicyN` policies in one deploy. CloudFormation updates those
 *    policies in parallel, so a statement can be briefly missing while it moves.
 *    New projects (create-blocks-app templates) set the key; existing apps opt in.
 *    Merging is on for every size of role, so it never switches on or off as the
 *    grants grow.
 * 2. **A synth-time quota check.** CDK only warns when a role ends up with more
 *    managed policies than IAM allows; the deploy then fails in CloudFormation. A
 *    validation fails synth instead, naming the Building Blocks that grant the
 *    most.
 *
 * Per role, so a future per-compute role can opt in the same way.
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

import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cxapi from 'aws-cdk-lib/cx-api';
import type { Construct, IConstruct } from 'constructs';
import { cdkVersion } from './cdk-version.js';
import { attributeRoleStatements } from './iam-report.js';

/**
 * CDK context key that raises the managed-policies-per-role limit the quota check
 * enforces, for accounts whose IAM "Managed policies per role" quota was raised.
 * Named like other Blocks context keys (`@aws-blocks/<package>:<option>`).
 *
 * @internal
 */
export const MANAGED_POLICIES_PER_ROLE_QUOTA_CONTEXT_KEY = '@aws-blocks/core:managedPoliciesPerRoleQuota';

/**
 * CDK context key that turns on statement merging for the execution role
 * (boolean; `"true"` / `"false"` strings are accepted for `cdk -c`). Off when
 * unset.
 *
 * @internal
 */
export const MERGE_EXECUTION_ROLE_POLICIES_CONTEXT_KEY = '@aws-blocks/core:mergeExecutionRolePolicies';

/** IAM's default "Managed policies per role" quota. */
const DEFAULT_MANAGED_POLICIES_PER_ROLE = 10;
/** The most IAM lets that quota be raised to. */
const MAX_MANAGED_POLICIES_PER_ROLE = 20;
/** How many Building Blocks the quota error lists. */
const TOP_GRANTING_BLOCKS = 5;

/** Merging must be set before CDK's split aspect reads it, which uses this priority (`mutatingAspectPrio32333`). */
function cdkSplitPriority(scope: IConstruct): number {
	return cdk.FeatureFlags.of(scope).isEnabled(cxapi.ASPECT_PRIORITIES_MUTATING)
		? cdk.AspectPriority.MUTATING
		: cdk.AspectPriority.DEFAULT;
}

/** Roles packing has already been enabled for, so a second call adds nothing. */
const enabledRoles = new WeakMap<iam.Role, true>();

/** Roles whose DefaultPolicy document had `minimize` set, read back by the quota error. */
const mergedRoles = new WeakMap<iam.Role, true>();

/**
 * Turn on opt-in statement merging and the managed-policy quota check for `role`
 * (see the module docs). Idempotent. Grant helpers are unaffected: blocks keep
 * calling `grant*()` / `addToPrincipalPolicy()` on the role as before.
 *
 * @param root - the Blocks root whose Building Blocks the quota error attributes
 *   grants to (defaults to the role's stack).
 * @internal
 */
export function enableRolePolicyPacking(role: iam.Role, root: Construct = cdk.Stack.of(role)): void {
	if (enabledRoles.has(role)) return;
	enabledRoles.set(role, true);

	cdk.Aspects.of(role).add(
		{
			visit(node) {
				if (node === role && resolveMergeSetting(role) === true) requestMerging(role);
			},
		},
		// One below CDK's split, so it runs after aspects with a lower priority and
		// before the split. Merging is a flag on the document, so the split merges
		// every statement the document holds when it runs, including grants added by
		// an inherited aspect at CDK's split priority (those sort between this aspect
		// and the split). A grant added after the split is not packed, as in plain CDK.
		{ priority: cdkSplitPriority(role) - 1 },
	);

	// Validations run after every aspect, so this sees the OverflowPolicyN children
	// CDK's split created.
	role.node.addValidation({
		validate: () => {
			const merge = resolveMergeSetting(role);
			if (typeof merge === 'string') return [merge];
			return validateManagedPolicyQuota(role, root);
		},
	});
}

/**
 * The merge context value as a boolean (unset → false), or an error message for
 * an unusable value.
 */
function resolveMergeSetting(role: iam.Role): boolean | string {
	const raw = role.node.tryGetContext(MERGE_EXECUTION_ROLE_POLICIES_CONTEXT_KEY);
	// `cdk -c key=value` passes strings, cdk.json passes booleans.
	if (raw === undefined || raw === false || raw === 'false') return false;
	if (raw === true || raw === 'true') return true;
	return `Context "${MERGE_EXECUTION_ROLE_POLICIES_CONTEXT_KEY}" must be true or false, got ${JSON.stringify(raw)}.`;
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
		`AWS Blocks: "${MERGE_EXECUTION_ROLE_POLICIES_CONTEXT_KEY}" is on, but this aws-cdk-lib version ` +
			`(${cdkVersion() ?? 'unknown'}) doesn't allow merging ${role.node.path}'s statements through ` +
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
 */
function validateManagedPolicyQuota(role: iam.Role, root: Construct): string[] {
	// An unusable value for this context key is reported regardless of packing.
	const quota = resolveQuota(role);
	if (typeof quota === 'string') return [quota];

	if (overflowPolicies(role).length === 0) return [];

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

	if (attached.size <= quota) return [];
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
		`AWS Blocks: the IAM role ${role.node.path} needs ${attached.size} managed policies, more than the ` +
			`${quota} allowed per role. The Building Blocks granting to it need more permissions than fit on one ` +
			`role, ${packed}.${topText} To fix: consolidate resources where possible; or move some Building ` +
			'Blocks into a separate Blocks backend (another BlocksStack or BlocksBackend), which has its own ' +
			`execution role. ${raise}`,
	];
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

const asArray = (v: unknown): unknown[] => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);
