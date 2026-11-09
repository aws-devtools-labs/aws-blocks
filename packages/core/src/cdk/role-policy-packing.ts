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
 * 1. **Consolidation before packing.** CDK merges combinable statements (same
 *    actions or same resources) only when the document's `minimize` option or the
 *    `@aws-cdk/aws-iam:minimizePolicies` feature flag is on. Turning the flag on
 *    would rewrite every policy in every app, so instead an aspect that runs just
 *    before CDK's split turns merging on for this one role's DefaultPolicy, and
 *    only when it is over budget. A role within budget is untouched, so its
 *    template does not change.
 * 2. **A synth-time quota check.** CDK only warns when a role ends up with more
 *    managed policies than IAM allows; the deploy then fails in CloudFormation. A
 *    validation fails synth instead, with the fix spelled out.
 *
 * Per role, so a future per-compute role can opt in the same way.
 *
 * @internal
 */

import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cxapi from 'aws-cdk-lib/cx-api';
import type { IConstruct } from 'constructs';

/**
 * CDK context key that raises the managed-policies-per-role limit the quota check
 * enforces, for accounts whose IAM "Managed policies per role" quota was raised.
 * Named like other Blocks context keys (`@aws-blocks/<package>:<option>`).
 *
 * @internal
 */
export const MANAGED_POLICIES_PER_ROLE_QUOTA_CONTEXT_KEY = '@aws-blocks/core:managedPoliciesPerRoleQuota';

/** IAM's default "Managed policies per role" quota. */
const DEFAULT_MANAGED_POLICIES_PER_ROLE = 10;
/** The most IAM lets that quota be raised to. */
const MAX_MANAGED_POLICIES_PER_ROLE = 20;

/**
 * The estimated size at which CDK's `Role.splitLargePolicy()` starts moving
 * statements off the DefaultPolicy (`MAX_INLINE_SIZE` in aws-cdk-lib's
 * `aws-iam/lib/role.js`, not exported). Mirrored here so consolidation turns on
 * exactly when CDK would split, and never for a policy CDK leaves inline.
 */
const CDK_INLINE_SPLIT_THRESHOLD = 10_000;

/**
 * Context key and default CDK's own size estimator uses for an unresolved token
 * in `Resource` (`deriveEstimateSizeOptions` in `aws-iam/lib/policy-statement.js`),
 * plus its fixed estimate for an unresolved action.
 */
const CDK_ARN_SIZE_ESTIMATE_CONTEXT_KEY = '@aws-cdk/aws-iam.arnSizeEstimate';
const CDK_DEFAULT_ARN_SIZE_ESTIMATE = 150;
const CDK_ACTION_SIZE_ESTIMATE = 20;

/** Consolidation must run before CDK's split aspect, which uses this priority (`mutatingAspectPrio32333`). */
function cdkSplitPriority(scope: IConstruct): number {
	return cdk.FeatureFlags.of(scope).isEnabled(cxapi.ASPECT_PRIORITIES_MUTATING)
		? cdk.AspectPriority.MUTATING
		: cdk.AspectPriority.DEFAULT;
}

const ENABLED = Symbol.for('blocks:RolePolicyPacking');

/**
 * Turn on statement consolidation and the managed-policy quota check for `role`
 * (see the module docs). Idempotent. Grant helpers are unaffected: blocks keep
 * calling `grant*()` / `addToPrincipalPolicy()` on the role as before.
 *
 * @internal
 */
export function enableRolePolicyPacking(role: iam.Role): void {
	const marker = role as unknown as Record<symbol, boolean | undefined>;
	if (marker[ENABLED]) return;
	marker[ENABLED] = true;

	cdk.Aspects.of(role).add(
		{
			visit(node) {
				if (node === role) consolidateIfOverBudget(role);
			},
		},
		// One below CDK's split, so it runs after any earlier aspect that adds grants
		// and immediately before the split reads the document.
		{ priority: cdkSplitPriority(role) - 1 },
	);

	// Validations run after every aspect, so this sees the OverflowPolicyN children
	// CDK's split created.
	role.node.addValidation({ validate: () => validateManagedPolicyQuota(role) });
}

/**
 * Enable CDK's statement merging on `role`'s DefaultPolicy document when the
 * document is over the inline budget; otherwise leave it alone.
 *
 * Internal coupling: `PolicyDocument` keeps its `minimize` constructor option in a
 * private field that `shouldMerge()` reads (`this.minimize ?? <feature flag>`)
 * from both `_splitDocument()` and `resolve()`. Setting that field to `true` is
 * what passing `minimize: true` to the constructor would have done. There is no
 * public way to change it after construction, and the feature flag can't be
 * scoped to the role (`node.setContext` is refused once a construct has children).
 * If a CDK upgrade removes the field, consolidation is skipped with an info
 * annotation and CDK still packs the unmerged statements.
 */
function consolidateIfOverBudget(role: iam.Role): void {
	const defaultPolicy = role.node.tryFindChild('DefaultPolicy');
	if (!(defaultPolicy instanceof iam.Policy)) return;
	const document = defaultPolicy.document;
	if (estimateDocumentSize(role, document) < CDK_INLINE_SPLIT_THRESHOLD) return;

	if (!('minimize' in document)) {
		addMinimizeUnavailableInfo(role);
		return;
	}
	try {
		(document as unknown as { minimize?: boolean }).minimize = true;
	} catch {
		// A future aws-cdk-lib might make the field read-only (getter-only or frozen).
		addMinimizeUnavailableInfo(role);
	}
}

function addMinimizeUnavailableInfo(role: iam.Role): void {
	cdk.Annotations.of(role).addInfo(
		`AWS Blocks: ${role.node.path}'s grants exceed the inline policy budget, but this aws-cdk-lib version ` +
			"doesn't expose PolicyDocument's 'minimize' field, so statements are packed into managed policies " +
			'without being merged first.',
	);
}

type StatementJson = Record<string, unknown>;

/**
 * Estimate `document`'s size the way CDK's split does (`PolicyStatement._estimateSize`,
 * internal), but from the public `toJSON()` rendering so it doesn't freeze the
 * statements. Exact duplicates are counted once because CDK's split drops them
 * before measuring even without merging.
 */
function estimateDocumentSize(scope: IConstruct, document: iam.PolicyDocument): number {
	const rawArnEstimate = scope.node.tryGetContext(CDK_ARN_SIZE_ESTIMATE_CONTEXT_KEY);
	const arnEstimate = typeof rawArnEstimate === 'number' ? rawArnEstimate : CDK_DEFAULT_ARN_SIZE_ESTIMATE;
	const statements = ((document.toJSON() as { Statement?: StatementJson[] } | undefined)?.Statement ?? []).filter(
		uniqueStatement(),
	);

	let size = 0;
	for (const s of statements) {
		size += `"Effect": "${s.Effect}",`.length;
		size += listSize('Action', s.Action, CDK_ACTION_SIZE_ESTIMATE);
		size += listSize('NotAction', s.NotAction, CDK_ACTION_SIZE_ESTIMATE);
		size += listSize('Resource', s.Resource, arnEstimate);
		size += listSize('NotResource', s.NotResource, arnEstimate);
		// CDK stringifies the (possibly empty) conditions object: `{}` is 2 characters.
		size += JSON.stringify(s.Condition ?? {}).length;
	}
	return size;
}

function listSize(key: string, value: unknown, tokenEstimate: number): number {
	const values = value === undefined ? [] : Array.isArray(value) ? value : [value];
	if (values.length === 0) return 0;
	let size = key.length + 5;
	for (const v of values) {
		size += (typeof v === 'string' && !cdk.Token.isUnresolved(v) ? v.length : tokenEstimate) + 3;
	}
	return size;
}

/** A filter keeping the first of each set of statements that differ only in list order. */
function uniqueStatement(): (s: StatementJson) => boolean {
	const seen = new Set<string>();
	const sorted = (v: unknown) => (Array.isArray(v) ? [...v].map(String).sort() : v);
	return (s) => {
		const key = JSON.stringify({
			...s,
			Action: sorted(s.Action),
			NotAction: sorted(s.NotAction),
			Resource: sorted(s.Resource),
			NotResource: sorted(s.NotResource),
		});
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	};
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
 * role. A role without them keeps CDK's behavior (its own warning, no error), so an
 * app that already attaches more managed policies than the default quota, on an
 * account with a raised quota, synthesizes as before.
 */
function validateManagedPolicyQuota(role: iam.Role): string[] {
	// An unusable value for this new context key is reported regardless of packing.
	const quota = resolveQuota(role);
	if (typeof quota === 'string') return [quota];

	const packed = role.node.children.some(
		(c) => c instanceof iam.ManagedPolicy && /^OverflowPolicy\d+$/.test(c.node.id),
	);
	if (!packed) return [];

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
	return [
		`AWS Blocks: the IAM role ${role.node.path} needs ${attached.size} managed policies, more than the ` +
			`${quota} allowed per role. The Building Blocks granting to it need more permissions than fit on one ` +
			'role, even after merging statements and packing them into managed policies. To fix: check ' +
			`\`${stack.artifactId}.blocks-iam.json\` in cdk.out for the Building Blocks that grant the most, and ` +
			'consolidate resources where possible; or move some Building Blocks into a separate Blocks backend ' +
			'(another BlocksStack or BlocksBackend), which has its own execution role. ' +
			raise,
	];
}

const asArray = (v: unknown): unknown[] => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);
