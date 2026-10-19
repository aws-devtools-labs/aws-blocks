// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';
import type { BlocksDefaults } from './blocks-defaults.js';
import { forEachBlocksRole } from './blocks-roles.js';
import { findBackendRoot } from './root-registry.js';

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
 * Apply the root's permissions boundary (see {@link resolvePermissionsBoundary})
 * to every IAM role AWS Blocks creates for it, through the shared role visitor
 * ({@link forEachBlocksRole}). No-op when unset.
 *
 * Warns when CDK's `@aws-cdk/core:permissionsBoundary` context is also set: for
 * Blocks roles this option wins (its override runs after the context's).
 *
 * @internal
 */
export function applyBlocksPermissionsBoundary(root: Construct): iam.IManagedPolicy | undefined {
	const boundary = resolvePermissionsBoundary(root);
	if (!boundary) return undefined;
	forEachBlocksRole(root, (role) => role.addPropertyOverride('PermissionsBoundary', boundary.managedPolicyArn));

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
