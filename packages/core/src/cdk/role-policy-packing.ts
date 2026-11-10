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
 * **aws-cdk-lib coupling.** Validated against aws-cdk-lib 2.274.0 (core's peer
 * range is `^2.257.0`). It relies on: the inline split threshold (mirrored as
 * {@link CDK_INLINE_SPLIT_THRESHOLD}, the only size constant that decides
 * whether merging turns on); `PolicyStatement._estimateSize()` and
 * `deriveEstimateSizeOptions()` for sizing; `PolicyDocument`'s private
 * `statements` and `minimize` fields and its `_splitDocument()` method; and, for
 * a heuristic only, CDK's merge size cap ({@link CDK_MAX_MERGE_SIZE}). When the
 * installed version or the peer range moves, re-check these and re-run
 * `role-policy-packing.test.ts`, whose canaries compare packed and unpacked
 * templates across the threshold. At synth time, a missing internal falls back
 * with an info annotation, and a disagreement between the estimate and CDK's split
 * is reported as a `rolePolicyPackingDrift` warning.
 *
 * Residual limitation: "merging was ignored" is detected only when the document
 * had a pair of statements this module considers combinable (a conservative
 * subset of CDK's rules), so a CDK that ignores `minimize` on a document without
 * such a pair goes unreported; nothing would have been merged there anyway.
 *
 * @internal
 */

import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cxapi from 'aws-cdk-lib/cx-api';
import type { IConstruct } from 'constructs';
import { cdkVersion } from './cdk-version.js';

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

/**
 * CDK's cap on the estimated size of a merged statement (`MAX_MERGE_SIZE` in
 * `aws-iam/lib/private/merge-statements.js`). Only used by the heuristic that
 * detects ignored merging, never to decide whether merging turns on.
 */
const CDK_MAX_MERGE_SIZE = 2_000;

/**
 * Warning id for a disagreement between the packing estimate and CDK's split
 * (see {@link checkPackingOutcome}). Stable, so it can be acknowledged.
 *
 * @internal
 */
export const ROLE_POLICY_PACKING_DRIFT_WARNING_ID = '@aws-blocks/core:rolePolicyPackingDrift';

/** Consolidation must run before CDK's split aspect, which uses this priority (`mutatingAspectPrio32333`). */
function cdkSplitPriority(scope: IConstruct): number {
	return cdk.FeatureFlags.of(scope).isEnabled(cxapi.ASPECT_PRIORITIES_MUTATING)
		? cdk.AspectPriority.MUTATING
		: cdk.AspectPriority.DEFAULT;
}

const ENABLED = Symbol.for('blocks:RolePolicyPacking');

/**
 * What the consolidation aspect decided for a role, read back by the validation
 * (which runs after CDK's split) to check that the split behaved as assumed.
 */
interface PackingState {
	/** `minimize` was set on the DefaultPolicy document. */
	mergeRequested: boolean;
	/** Statements after dropping exact duplicates: the count CDK's split starts from. */
	preSplitStatements: number;
	/** At least one pair of statements looked combinable (see {@link hasCombinablePair}). */
	hasCombinablePair: boolean;
	/** The inline threshold CDK's split was called with, when it could be observed. */
	observedInlineThreshold?: number;
}

const packingStates = new WeakMap<iam.Role, PackingState>();

/** Annotation keys already added per role, so an aspect revisited by CDK doesn't repeat them. */
const annotated = new WeakMap<iam.Role, Set<string>>();
function annotateOnce(role: iam.Role, key: string, add: () => void): void {
	const keys = annotated.get(role) ?? new Set<string>();
	annotated.set(role, keys);
	if (keys.has(key)) return;
	keys.add(key);
	add();
}

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
	role.node.addValidation({
		validate: () => {
			checkPackingOutcome(role);
			return validateManagedPolicyQuota(role);
		},
	});
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
 * annotation and CDK still packs the unmerged statements. If the field stays
 * writable but CDK stops reading it, {@link checkPackingOutcome} notices that
 * nothing was merged and adds the same annotation.
 */
function consolidateIfOverBudget(role: iam.Role): void {
	const defaultPolicy = role.node.tryFindChild('DefaultPolicy');
	if (!(defaultPolicy instanceof iam.Policy)) return;
	const document = defaultPolicy.document;
	const statements = sizeStatements(role, document);
	if (statements.reduce((n, s) => n + s.size, 0) < CDK_INLINE_SPLIT_THRESHOLD) return;

	const state: PackingState = {
		mergeRequested: false,
		preSplitStatements: statements.length,
		hasCombinablePair: hasCombinablePair(statements),
	};
	packingStates.set(role, state);

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
	state.mergeRequested = true;
	observeSplitThreshold(role, document);
}

function addMergeNotAppliedInfo(role: iam.Role): void {
	annotateOnce(role, 'mergeNotApplied', () =>
		cdk.Annotations.of(role).addInfo(
			`AWS Blocks: ${role.node.path}'s grants exceed the inline policy budget, but this aws-cdk-lib version ` +
				`(${cdkVersion() ?? 'unknown'}) didn't merge statements through PolicyDocument's 'minimize' field ` +
				'(the field is missing, read-only, or no longer used), so statements are packed into managed ' +
				'policies without being merged first.',
		),
	);
}

const SPLIT_OBSERVED = Symbol.for('blocks:RolePolicyPacking.splitObserved');

/**
 * Record the inline threshold CDK's split is called with for this document, so
 * the validation can compare it with {@link CDK_INLINE_SPLIT_THRESHOLD}. Wraps
 * `_splitDocument` on this one document instance only (an own property that
 * delegates unchanged), and only for a document whose merging was turned on, so
 * no other policy is affected. If CDK renames the method, nothing is recorded and
 * the validation falls back to checking for overflow policies.
 */
function observeSplitThreshold(role: iam.Role, document: iam.PolicyDocument): void {
	const doc = document as unknown as Record<string | symbol, unknown>;
	const split = doc._splitDocument;
	if (typeof split !== 'function' || doc[SPLIT_OBSERVED]) return;
	doc[SPLIT_OBSERVED] = true;
	Object.defineProperty(document, '_splitDocument', {
		configurable: true,
		writable: true,
		value(this: unknown, ...args: unknown[]) {
			// `_splitDocument(scope, selfMaximumSize, splitMaximumSize)`.
			const state = packingStates.get(role);
			if (state && typeof args[1] === 'number') state.observedInlineThreshold = args[1];
			return split.apply(this, args);
		},
	});
}

/** OverflowPolicyN managed policies CDK's split created on the role. */
function overflowPolicies(role: iam.Role): iam.ManagedPolicy[] {
	return role.node.children.filter(
		(c): c is iam.ManagedPolicy => c instanceof iam.ManagedPolicy && /^OverflowPolicy\d+$/.test(c.node.id),
	);
}

/**
 * After CDK's split, check that it behaved the way the consolidation assumed. Only
 * annotates; never fails synth.
 *
 * - **Threshold drift.** Merging was turned on because the estimate reached
 *   {@link CDK_INLINE_SPLIT_THRESHOLD}. If CDK's split was called with a different
 *   threshold, or (when the threshold couldn't be observed) the role ended up with
 *   no overflow policies, the estimate and CDK's split may disagree and the role's
 *   template may differ from what aws-cdk-lib alone would produce: warn.
 *   With the threshold observed and matching, no overflow is expected when merging
 *   alone brought the policy within budget, so that case is not warned about.
 * - **Merging ignored.** If the document had a combinable pair and the split left
 *   as many statements across DefaultPolicy and OverflowPolicyN as it started
 *   with, nothing was merged: CDK no longer honors the `minimize` field.
 */
function checkPackingOutcome(role: iam.Role): void {
	const state = packingStates.get(role);
	if (!state?.mergeRequested) return;
	const defaultPolicy = role.node.tryFindChild('DefaultPolicy');
	if (!(defaultPolicy instanceof iam.Policy)) return;
	const overflow = overflowPolicies(role);

	const threshold = state.observedInlineThreshold;
	const drifted = threshold !== undefined ? threshold !== CDK_INLINE_SPLIT_THRESHOLD : overflow.length === 0;
	if (drifted) {
		annotateOnce(role, 'drift', () =>
			cdk.Annotations.of(role).addWarningV2(
				ROLE_POLICY_PACKING_DRIFT_WARNING_ID,
				`AWS Blocks: the policy size estimate used to merge ${role.node.path}'s statements and ` +
					"aws-cdk-lib's policy split disagreed" +
					(threshold !== undefined
						? ` (aws-cdk-lib split at an estimated ${threshold} characters, AWS Blocks expected ` +
							`${CDK_INLINE_SPLIT_THRESHOLD})`
						: '') +
					(overflow.length === 0
						? ": the role's inline policy was consolidated without overflowing into managed policies"
						: '') +
					`. Please report this to AWS Blocks with the installed aws-cdk-lib version (${cdkVersion() ?? 'unknown'}).`,
			),
		);
	}

	const after = defaultPolicy.document.statementCount + overflow.reduce((n, p) => n + p.document.statementCount, 0);
	// `>=`: AWS Blocks' de-duplication never drops more than CDK's, so a merge always shows as fewer statements.
	if (state.hasCombinablePair && after >= state.preSplitStatements) addMergeNotAppliedInfo(role);
}

type StatementJson = Record<string, unknown>;
/** A statement after de-duplication, with its estimated size. */
interface SizedStatement {
	json: StatementJson;
	size: number;
}

/**
 * The document's statements, exact duplicates dropped, each with its estimated
 * size: CDK's own estimate when available, else AWS Blocks' copy of it.
 */
function sizeStatements(role: iam.Role, document: iam.PolicyDocument): SizedStatement[] {
	const sized = sizeWithCdkEstimator(role, document);
	if (sized) return sized;
	annotateOnce(role, 'estimator', () =>
		cdk.Annotations.of(role).addInfo(
			`AWS Blocks: this aws-cdk-lib version (${cdkVersion() ?? 'unknown'}) doesn't expose the policy size ` +
				`estimate its split uses, so ${role.node.path}'s policy size is estimated by a copy of it. Statement ` +
				"merging may turn on at a slightly different size than aws-cdk-lib's split.",
		),
	);
	return sizeWithMirroredEstimator(role, document);
}

/**
 * Size statements with CDK's own estimator, the one `_splitDocument()` uses:
 * `PolicyStatement._estimateSize(deriveEstimateSizeOptions(scope))`. Both are
 * exported from `aws-cdk-lib/aws-iam` (`_estimateSize` is marked internal); the
 * statement list is the document's private `statements` field. Returns
 * `undefined` when any of these is missing, so the caller falls back.
 *
 * CDK's split first freezes the statements and drops exact duplicates
 * (`mergeStatements` with `mergeIfCombinable: false`). This doesn't freeze (later
 * aspects may still add to a statement); `_estimateSize` doesn't need it. Duplicates
 * are dropped by {@link uniqueStatement} on the public `toStatementJson()`.
 */
function sizeWithCdkEstimator(role: iam.Role, document: iam.PolicyDocument): SizedStatement[] | undefined {
	const statements = (document as unknown as { statements?: unknown }).statements;
	if (!Array.isArray(statements) || typeof iam.deriveEstimateSizeOptions !== 'function') return undefined;
	const usable = statements.every(
		(s): s is iam.PolicyStatement => s instanceof iam.PolicyStatement && typeof s._estimateSize === 'function',
	);
	if (!usable) return undefined;
	const options = iam.deriveEstimateSizeOptions(role);
	const keep = uniqueStatement();
	const sized: SizedStatement[] = [];
	for (const statement of statements as iam.PolicyStatement[]) {
		const json = statement.toStatementJson() as StatementJson;
		if (keep(json)) sized.push({ json, size: statement._estimateSize(options) });
	}
	return sized;
}

/**
 * Estimate statement sizes the way CDK's split does (`PolicyStatement._estimateSize`,
 * internal), but from the public `toJSON()` rendering so it doesn't freeze the
 * statements. Exact duplicates are counted once because CDK's split drops them
 * before measuring even without merging. Only used when CDK's own estimator
 * isn't available ({@link sizeWithCdkEstimator}).
 */
function sizeWithMirroredEstimator(scope: IConstruct, document: iam.PolicyDocument): SizedStatement[] {
	const rawArnEstimate = scope.node.tryGetContext(CDK_ARN_SIZE_ESTIMATE_CONTEXT_KEY);
	const arnEstimate = typeof rawArnEstimate === 'number' ? rawArnEstimate : CDK_DEFAULT_ARN_SIZE_ESTIMATE;
	const statements = ((document.toJSON() as { Statement?: StatementJson[] } | undefined)?.Statement ?? []).filter(
		uniqueStatement(),
	);

	return statements.map((s) => {
		let size = 0;
		size += `"Effect": "${s.Effect}",`.length;
		size += listSize('Action', s.Action, CDK_ACTION_SIZE_ESTIMATE);
		size += listSize('NotAction', s.NotAction, CDK_ACTION_SIZE_ESTIMATE);
		size += listSize('Resource', s.Resource, arnEstimate);
		size += listSize('NotResource', s.NotResource, arnEstimate);
		// CDK stringifies the (possibly empty) conditions object: `{}` is 2 characters.
		size += JSON.stringify(s.Condition ?? {}).length;
		return { json: s, size };
	});
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
 * Whether CDK's merging should combine at least one pair of these statements: a
 * conservative subset of CDK's `mergeIfCombinable` (same effect, condition and
 * either the same actions or the same resources; no Sid, principals or Not*
 * lists), and only when the two together fit CDK's merge size cap, which CDK
 * enforces on the combined statement. Used only to decide whether "nothing was
 * merged" means CDK ignored the request.
 */
function hasCombinablePair(statements: SizedStatement[]): boolean {
	const setKey = (v: unknown) => JSON.stringify(asArray(v).map(String).sort());
	const shapes = statements.map(({ json: s, size }) =>
		s.Sid === undefined &&
		s.Principal === undefined &&
		s.NotPrincipal === undefined &&
		s.NotAction === undefined &&
		s.NotResource === undefined &&
		s.Action !== undefined &&
		s.Resource !== undefined
			? {
					effect: s.Effect,
					condition: JSON.stringify(s.Condition ?? {}),
					actions: setKey(s.Action),
					resources: setKey(s.Resource),
					size,
				}
			: undefined,
	);
	for (let i = 0; i < shapes.length; i++) {
		const a = shapes[i];
		if (!a) continue;
		for (let j = i + 1; j < shapes.length; j++) {
			const b = shapes[j];
			if (!b || a.effect !== b.effect || a.condition !== b.condition) continue;
			if (a.actions !== b.actions && a.resources !== b.resources) continue;
			// The sum overestimates the combined statement (one shared list is dropped), so this stays conservative.
			if (a.size + b.size <= CDK_MAX_MERGE_SIZE) return true;
		}
	}
	return false;
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
