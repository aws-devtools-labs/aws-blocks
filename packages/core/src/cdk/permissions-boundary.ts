// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';
import type { BlocksDefaults } from './blocks-defaults.js';
import { forEachBlocksRole } from './blocks-roles.js';
import { findBackendRoot } from './root-registry.js';
import { isSandboxContext } from './stack-metadata.js';

/** CDK's own stack-wide boundary context key (see the CDK guide "Permissions boundaries"). */
const CDK_BOUNDARY_CONTEXT_KEY = '@aws-cdk/core:permissionsBoundary';

/** Per-root memo of the resolved boundary (`null` = unset), so the policy is imported once per root. */
const ROOT_BOUNDARY = Symbol.for('blocks:PermissionsBoundary');

/** Per-stack record of which backend applied which boundary — detects a mixed-boundary stack. */
const STACK_BOUNDARIES = Symbol.for('blocks:StackPermissionsBoundaries');

/** IAM managed-policy name charset/length (`[\w+=,.@-]`, 1–128). */
const POLICY_NAME = /^[\w+=,.@-]{1,128}$/;

/** `arn:<partition>:iam::<account|aws>:policy/<optional path/>name`. */
const POLICY_ARN = /^arn:aws[a-z-]*:iam::(\d{12}|aws):policy\/([\w+=,.@-]+\/)*[\w+=,.@-]{1,128}$/;

/**
 * AWS managed policies that don't meaningfully bound a role: `AdministratorAccess`
 * (`*` on `*`), `PowerUserAccess` (everything except most of IAM/Organizations/
 * Account) and `IAMFullAccess` (`iam:*`, so a role could create a new role
 * without the boundary). Kept small and explicit on purpose.
 */
const PERMISSIVE_AWS_MANAGED = /^arn:aws[a-z-]*:iam::aws:policy\/(AdministratorAccess|PowerUserAccess|IAMFullAccess)$/;

function invalid(detail: string): Error {
	return new Error(
		`Invalid defaults.permissionsBoundary: ${detail}\n` +
			'Pass the name of a customer-managed IAM policy in the deploying account (e.g. "app-boundary"), ' +
			'its full ARN (e.g. "arn:aws:iam::123456789012:policy/platform/app-boundary"), or an iam.IManagedPolicy.',
	);
}

function validateAndImport(
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
		// Real IManagedPolicy objects carry a token (Ref / Fn::Join) or a valid ARN;
		// a concrete non-ARN means a hand-built object with the wrong value.
		const arn = input.managedPolicyArn;
		if (!cdk.Token.isUnresolved(arn) && !POLICY_ARN.test(arn)) {
			throw invalid(`managedPolicyArn "${arn}" is not an IAM managed policy ARN.`);
		}
		return input;
	}
	throw invalid('expected a string or an iam.IManagedPolicy.');
}

/**
 * The permissions boundary in force for the backend root that owns `scope`, as
 * an `IManagedPolicy`, or `undefined` when none is set. **The single resolution
 * point** — nothing else reads `defaults.permissionsBoundary`, so a later source
 * (e.g. per-tenant configuration) plugs in here.
 *
 * Validates the input (throwing an actionable error) and imports the policy once
 * per root. A name resolves in the deploying account and partition; an ARN — with
 * a path, or naming a shared policy whose document uses policy variables such as
 * `${aws:PrincipalTag/app}` — is passed through untouched.
 *
 * @internal
 */
export function resolvePermissionsBoundary(scope: Construct): iam.IManagedPolicy | undefined {
	const root = findBackendRoot(scope);
	if (!root) return undefined;
	const store = root as unknown as Record<symbol, iam.IManagedPolicy | null | undefined>;
	const memo = store[ROOT_BOUNDARY];
	if (memo !== undefined) return memo ?? undefined;
	const defaults = (root as { defaults?: BlocksDefaults }).defaults;
	const boundary = validateAndImport(root, defaults?.permissionsBoundary);
	store[ROOT_BOUNDARY] = boundary ?? null;
	return boundary;
}

/**
 * `value` resolved to a concrete string when it is one: a literal, or a
 * `Fn::Join` of literals and `AWS::Partition` (which is how
 * `ManagedPolicy.fromAwsManagedPolicyName()` renders). The partition is read as
 * `aws` — enough to recognize an AWS managed policy name in any partition.
 * `undefined` when any other intrinsic is involved.
 */
function concreteArn(resolved: unknown): string | undefined {
	if (typeof resolved === 'string') return resolved;
	const join = (resolved as { 'Fn::Join'?: unknown } | null)?.['Fn::Join'];
	if (!Array.isArray(join) || join[0] !== '' || !Array.isArray(join[1])) return undefined;
	let out = '';
	for (const part of join[1] as unknown[]) {
		if (typeof part === 'string') out += part;
		else if ((part as { Ref?: unknown } | null)?.Ref === 'AWS::Partition') out += 'aws';
		else return undefined;
	}
	return out;
}

/** The boundary CDK's `@aws-cdk/core:permissionsBoundary` context puts on the stack's roles, resolved. */
function contextBoundary(stack: cdk.Stack, context: unknown): unknown {
	const { arn, name } = (context ?? {}) as { arn?: unknown; name?: unknown };
	if (typeof arn === 'string') return stack.resolve(arn);
	if (typeof name === 'string') {
		return stack.resolve(stack.formatArn({ service: 'iam', resource: 'policy', region: '', resourceName: name }));
	}
	return undefined;
}

/**
 * Apply the root's permissions boundary (see {@link resolvePermissionsBoundary})
 * to every IAM role AWS Blocks creates for it, through the shared role visitor
 * ({@link forEachBlocksRole}). No-op when unset.
 *
 * Warns when CDK's `@aws-cdk/core:permissionsBoundary` context is also set: for
 * Blocks roles this option wins (its override runs after the context's).
 *
 * Outside a sandbox deployment ({@link isSandboxContext}), two checks fail synth
 * instead of warning: the context naming a **different** boundary (so a stricter
 * account-wide boundary is never replaced for Blocks roles), and a boundary that
 * is a permissive AWS managed policy (`AdministratorAccess`, `PowerUserAccess`,
 * `IAMFullAccess`) unless `defaults.permissionsBoundaryAllowPermissive` is set.
 * In a sandbox both stay warnings. A context equal to the option is not a
 * conflict and isn't reported.
 *
 * @internal
 */
export function applyBlocksPermissionsBoundary(root: Construct): iam.IManagedPolicy | undefined {
	const boundary = resolvePermissionsBoundary(root);
	if (!boundary) return undefined;
	const stack = cdk.Stack.of(root);
	const sandbox = isSandboxContext(root);
	const defaults = (root as { defaults?: BlocksDefaults }).defaults;
	const resolvedArn = stack.resolve(boundary.managedPolicyArn);

	const arn = concreteArn(resolvedArn);
	if (
		arn !== undefined &&
		PERMISSIVE_AWS_MANAGED.test(arn) &&
		defaults?.permissionsBoundaryAllowPermissive !== true
	) {
		const detail =
			`defaults.permissionsBoundary is the AWS managed policy "${arn.replace(/^arn:aws[a-z-]*:/, 'arn:<partition>:')}", ` +
			'which is too permissive to bound anything: it allows nearly every action, or lets a role create new ' +
			'roles without the boundary. Use a boundary policy written for this app, or set ' +
			'defaults.permissionsBoundaryAllowPermissive: true to accept it deliberately.';
		if (!sandbox) throw invalid(detail);
		cdk.Annotations.of(root).addWarningV2('blocks:iam:permissionsBoundaryPermissive', detail);
	}

	const context = root.node.tryGetContext(CDK_BOUNDARY_CONTEXT_KEY);
	if (context !== undefined) {
		const equal = JSON.stringify(contextBoundary(stack, context)) === JSON.stringify(resolvedArn);
		if (!equal && !sandbox) {
			throw new Error(
				`defaults.permissionsBoundary differs from the CDK "${CDK_BOUNDARY_CONTEXT_KEY}" context ` +
					`(${JSON.stringify(context)}). Outside a sandbox deployment this fails synth, so the context's ` +
					'boundary is never replaced for the roles AWS Blocks creates. Set both to the same policy in the ' +
					'same form (both a name, or both the same ARN), or set only one of them.',
			);
		}
		if (!equal) {
			cdk.Annotations.of(root).addWarningV2(
				'blocks:iam:permissionsBoundaryOverridesContext',
				`defaults.permissionsBoundary is set while the CDK "${CDK_BOUNDARY_CONTEXT_KEY}" context is also set. ` +
					'For roles AWS Blocks creates, defaults.permissionsBoundary wins; the context still applies to the ' +
					'rest of the stack. Set only one of them unless that split is intended. Outside a sandbox ' +
					'deployment, this conflict fails synth.',
			);
		}
	}

	forEachBlocksRole(root, (role) => role.addPropertyOverride('PermissionsBoundary', boundary.managedPolicyArn));
	return boundary;
}

/**
 * Warn when backends in one stack disagree on the boundary: roles inside each
 * backend get their own, but per-stack CDK singleton roles are shared and keep
 * the boundary of the backend that created them first. Call once per embedded
 * `BlocksBackend`, after it's created.
 *
 * @internal
 */
export function warnOnMixedBoundaries(backend: Construct): void {
	const stack = cdk.Stack.of(backend);
	const boundary = resolvePermissionsBoundary(backend);
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
}
