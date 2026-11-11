// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as cdk from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { forEachBlocksRole, isAppOwnedRole, markBlocksOwned } from './blocks-roles.js';

/**
 * Acknowledgement id of the warning reported for an app-owned role in a
 * `BlocksStack` whose service-principal trust has no source condition. Stable:
 * apps acknowledge it with `Annotations.of(scope).acknowledgeWarning(id)`.
 *
 * @internal
 */
export const SERVICE_PRINCIPAL_TRUST_WARNING_ID = '@aws-blocks/core:serviceRoleTrustWithoutSourceCondition';

/**
 * Service principals whose trust statements need no source condition: Lambda
 * execution roles (including the Lambda@Edge replicator principal CDK adds to an
 * `experimental.EdgeFunction` role beside `lambda.amazonaws.com`).
 */
const UNCONDITIONED_SERVICES: ReadonlySet<string> = new Set(['lambda.amazonaws.com', 'edgelambda.amazonaws.com']);

/** Condition keys that scope a service-principal trust to this account's resources (compared case-insensitively). */
const SOURCE_KEYS: ReadonlySet<string> = new Set(['aws:sourceaccount', 'aws:sourcearn']);

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
	if (value === undefined) return [];
	return Array.isArray(value) ? value : [value];
}

/** The role's rendered `AssumeRolePolicyDocument` (property overrides included), or `undefined`. */
function trustDocument(role: cdk.CfnResource): unknown {
	const rendered = cdk.Stack.of(role).resolve(role._toCloudFormation());
	if (!isObject(rendered) || !isObject(rendered.Resources)) return undefined;
	const resource = Object.values(rendered.Resources)[0];
	if (!isObject(resource) || !isObject(resource.Properties)) return undefined;
	return resource.Properties.AssumeRolePolicyDocument;
}

function hasSourceCondition(condition: unknown): boolean {
	if (!isObject(condition)) return false;
	return Object.values(condition).some(
		(block) => isObject(block) && Object.keys(block).some((key) => SOURCE_KEYS.has(key.toLowerCase())),
	);
}

function describe(service: unknown): string {
	return typeof service === 'string' ? service : JSON.stringify(service);
}

/** A service principal an unconditioned trust statement names, with that statement's index. */
interface UnconditionedTrust {
	readonly service: string;
	/** Index of the statement in `AssumeRolePolicyDocument.Statement`. */
	readonly statement: number;
}

/**
 * Every service principal (other than {@link UNCONDITIONED_SERVICES}) in an
 * `Allow` trust statement of `role` that has no source condition, in statement
 * order, each principal once (at its first such statement).
 */
function unconditionedTrusts(role: cdk.CfnResource): UnconditionedTrust[] {
	const doc = trustDocument(role);
	if (!isObject(doc)) return [];
	const found: UnconditionedTrust[] = [];
	asArray(doc.Statement).forEach((statement, index) => {
		if (!isObject(statement) || statement.Effect !== 'Allow' || !isObject(statement.Principal)) return;
		if (hasSourceCondition(statement.Condition)) return;
		for (const service of asArray(statement.Principal.Service)) {
			if (typeof service === 'string' && UNCONDITIONED_SERVICES.has(service)) continue;
			const name = describe(service);
			if (!found.some((f) => f.service === name)) found.push({ service: name, statement: index });
		}
	});
	return found;
}

/**
 * The service principals in `role`'s trust policy that `Allow` an assume-role
 * action with neither an `aws:SourceAccount` nor an `aws:SourceArn` condition,
 * other than the Lambda execution principals ({@link UNCONDITIONED_SERVICES}).
 *
 * @internal
 */
export function unconditionedServicePrincipals(role: cdk.CfnResource): string[] {
	return unconditionedTrusts(role).map((t) => t.service);
}

function trustProblem(role: cdk.CfnResource, service: string): string {
	return (
		`IAM role ${role.node.path} trusts the service principal ${service} without an ` +
		'aws:SourceAccount or aws:SourceArn condition. Add aws:SourceAccount (StringEquals, the stack account) ' +
		'and aws:SourceArn (ArnLike, an ARN pattern for the resources of that service) to its trust statement.'
	);
}

function appOwnedTrustWarning(role: cdk.CfnResource, { service, statement }: UnconditionedTrust): string {
	return (
		`${trustProblem(role, service)} For a role a CDK construct creates with no prop for its trust, set the ` +
		`condition on the role's L1 resource: role.node.defaultChild.addPropertyOverride(` +
		`'AssumeRolePolicyDocument.Statement.${statement}.Condition', { StringEquals: { 'aws:SourceAccount': ... }, ` +
		`ArnLike: { 'aws:SourceArn': ... } }). To keep the trust as it is, acknowledge this warning: ` +
		`Annotations.of(role).acknowledgeWarning('${SERVICE_PRINCIPAL_TRUST_WARNING_ID}'), or on the stack ` +
		'to acknowledge it for every role in the stack.'
	);
}

/**
 * Fail synth when an IAM role AWS Blocks creates for `root` (the set
 * {@link forEachBlocksRole} visits) trusts a service principal without an
 * `aws:SourceAccount` or `aws:SourceArn` condition. Lambda execution roles are
 * accepted as they are ({@link UNCONDITIONED_SERVICES}).
 *
 * In a `BlocksStack` that set is the whole stack, so it also holds roles the
 * app adds itself ({@link isAppOwnedRole}): those get a synth warning instead
 * (id {@link SERVICE_PRINCIPAL_TRUST_WARNING_ID}, which the app can
 * acknowledge), naming the property override that sets the condition. Roles
 * under a Building Block, a compute, or created by the framework at stack
 * scope still fail synth.
 *
 * Checks role trust policies only — not resource policies or KMS grants. Runs
 * as a construct validation, so it sees each trust policy after every block has
 * added its statements. The cross-region reference providers CDK adds while
 * preparing the app are reached after validation and are not checked; they are
 * Lambda execution roles.
 *
 * @internal
 */
export function addServicePrincipalTrustCheck(root: Construct): void {
	forEachBlocksRole(root, (role) => {
		role.node.addValidation({
			validate: () => {
				const found = unconditionedTrusts(role);
				if (found.length === 0) return [];
				// Validation runs before the cloud assembly is written, so a warning
				// added here still reaches the manifest (and `cdk synth` output).
				if (isAppOwnedRole(root, role)) {
					for (const trust of found) {
						cdk.Annotations.of(role).addWarningV2(
							SERVICE_PRINCIPAL_TRUST_WARNING_ID,
							appOwnedTrustWarning(role, trust),
						);
					}
					return [];
				}
				return found.map(({ service }) => trustProblem(role, service));
			},
		});
	});
}

/** Options for {@link sourceScopedConditions}. */
export interface SourceScopedConditionsOptions {
	/**
	 * Whether the service's resource ARNs carry an account segment. `false` for
	 * services whose ARNs leave it empty (`arn:<partition>:apigateway:<region>::/…`).
	 * @defaultValue true
	 */
	readonly accountInArn?: boolean;
}

/**
 * The trust-statement conditions that limit a service principal to `stack`'s
 * account and to resources of `service` in its region:
 * `StringEquals aws:SourceAccount` = the stack account and
 * `ArnLike aws:SourceArn` = `arn:<partition>:<service>:<region>:<account>:<resourcePattern>`
 * (the account segment left empty when `accountInArn` is `false`).
 *
 * @example
 * ```ts
 * new iam.ServicePrincipal('states.amazonaws.com', {
 *   conditions: sourceScopedConditions(stack, 'states', 'stateMachine:*'),
 * });
 * ```
 *
 * @internal
 */
export function sourceScopedConditions(
	stack: cdk.Stack,
	service: string,
	resourcePattern: string,
	options: SourceScopedConditionsOptions = {},
): { StringEquals: { 'aws:SourceAccount': string }; ArnLike: { 'aws:SourceArn': string } } {
	const arnAccount = (options.accountInArn ?? true) ? stack.account : '';
	return {
		StringEquals: { 'aws:SourceAccount': stack.account },
		ArnLike: {
			'aws:SourceArn': `arn:${stack.partition}:${service}:${stack.region}:${arnAccount}:${resourcePattern}`,
		},
	};
}

/**
 * Scope the trust of the waiter state machine role that a
 * `custom_resources.Provider` with an `isCompleteHandler` creates: CDK builds
 * that role trusting `states.amazonaws.com` with no condition and offers no prop
 * to shape it, so its single trust statement gets `aws:SourceAccount` (the stack
 * account) and `aws:SourceArn` (`arn:<partition>:states:<region>:<account>:stateMachine:*`)
 * by property override. No-op for a provider without a waiter.
 *
 * @internal
 */
export function scopeProviderWaiterTrust(provider: Construct): void {
	const role = provider.node.tryFindChild('waiter-state-machine')?.node.tryFindChild('Role')?.node.defaultChild;
	if (!role || !cdk.CfnResource.isCfnResource(role)) return;
	// Providers like these are hoisted to stack scope by a block, so the check
	// treats them as framework roles rather than app-owned ones.
	markBlocksOwned(provider);
	role.addPropertyOverride(
		'AssumeRolePolicyDocument.Statement.0.Condition',
		sourceScopedConditions(cdk.Stack.of(provider), 'states', 'stateMachine:*'),
	);
}
