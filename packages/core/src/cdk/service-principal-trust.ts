// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as cdk from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { forEachBlocksKmsKey, forEachBlocksRole, isAppOwnedRole, markBlocksOwned } from './blocks-roles.js';

/**
 * Acknowledgement id of the warning reported for an app-owned role in a
 * `BlocksStack` whose service-principal trust has no source condition. Stable:
 * apps acknowledge it with `Annotations.of(scope).acknowledgeWarning(id)`.
 *
 * @internal
 */
export const SERVICE_PRINCIPAL_TRUST_WARNING_ID = '@aws-blocks/core:serviceRoleTrustWithoutSourceCondition';

/**
 * Acknowledgement id of the warning reported for an app-owned KMS key whose key
 * policy lets a service principal use the key without a source condition. Stable:
 * apps acknowledge it with `Annotations.of(scope).acknowledgeWarning(id)`.
 *
 * @internal
 */
export const KMS_KEY_POLICY_WARNING_ID = '@aws-blocks/core:kmsKeyPolicyWithoutSourceCondition';

/**
 * Service principals whose trust statements need no source condition: Lambda
 * execution roles (including the Lambda@Edge replicator principal CDK adds to an
 * `experimental.EdgeFunction` role beside `lambda.amazonaws.com`).
 */
const UNCONDITIONED_SERVICES: ReadonlySet<string> = new Set(['lambda.amazonaws.com', 'edgelambda.amazonaws.com']);

/** CloudFormation type of the account-level API Gateway settings resource. */
const APIGATEWAY_ACCOUNT_TYPE = 'AWS::ApiGateway::Account';

/**
 * The logical id of the role an `AWS::ApiGateway::Account`'s rendered
 * `CloudWatchRoleArn` (property overrides included) points at, when it is a
 * `Fn::GetAtt` of a role's `Arn` in the same stack; otherwise `undefined`.
 */
function cloudWatchRoleLogicalId(account: cdk.CfnResource): string | undefined {
	const rendered = cdk.Stack.of(account).resolve(account._toCloudFormation());
	if (!isObject(rendered) || !isObject(rendered.Resources)) return undefined;
	const resource = Object.values(rendered.Resources)[0];
	if (!isObject(resource) || !isObject(resource.Properties)) return undefined;
	const arn = resource.Properties.CloudWatchRoleArn;
	if (!isObject(arn)) return undefined;
	const getAtt = arn['Fn::GetAtt'];
	if (Array.isArray(getAtt) && getAtt.length === 2 && getAtt[1] === 'Arn' && typeof getAtt[0] === 'string') {
		return getAtt[0];
	}
	if (typeof getAtt === 'string' && getAtt.endsWith('.Arn')) return getAtt.slice(0, -'.Arn'.length);
	return undefined;
}

/**
 * Whether `service` on `role` is the `apigateway.amazonaws.com` trust of an API
 * Gateway CloudWatch Logs role: a role that an `AWS::ApiGateway::Account` in
 * the same stack names as its `CloudWatchRoleArn`. That covers the stack-level
 * role `ensureApiGatewayAccount` creates (`@aws-blocks/core` and
 * `@aws-blocks/hosting`) and the `cloudWatchRole` a CDK `RestApi` creates by
 * default. The trust stays unconditioned: API Gateway does not send
 * `aws:SourceAccount` or `aws:SourceArn` when it delivers logs with this role,
 * so either condition stops log delivery. Only that principal on such a role
 * is exempt.
 */
function isApiGatewayCloudWatchTrust(role: cdk.CfnResource, service: string): boolean {
	if (service !== 'apigateway.amazonaws.com') return false;
	const stack = cdk.Stack.of(role);
	const roleId = stack.resolve(role.logicalId);
	return stack.node
		.findAll()
		.some(
			(c) =>
				cdk.CfnResource.isCfnResource(c) &&
				c.cfnResourceType === APIGATEWAY_ACCOUNT_TYPE &&
				cdk.Stack.of(c) === stack &&
				cloudWatchRoleLogicalId(c) === roleId,
		);
}

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

/** The resource's rendered property `name` (property overrides included), or `undefined`. */
function renderedProperty(resource: cdk.CfnResource, name: string): unknown {
	const rendered = cdk.Stack.of(resource).resolve(resource._toCloudFormation());
	if (!isObject(rendered) || !isObject(rendered.Resources)) return undefined;
	const body = Object.values(rendered.Resources)[0];
	if (!isObject(body) || !isObject(body.Properties)) return undefined;
	return body.Properties[name];
}

/** The role's rendered `AssumeRolePolicyDocument` (property overrides included), or `undefined`. */
function trustDocument(role: cdk.CfnResource): unknown {
	return renderedProperty(role, 'AssumeRolePolicyDocument');
}

/**
 * Whether a trust statement's `Condition` scopes it with `aws:SourceAccount` or
 * `aws:SourceArn`, under the same operator and value rules as the key-policy
 * check ({@link scopingKeys}).
 */
function hasSourceCondition(condition: unknown): boolean {
	const keys = scopingKeys(condition);
	return [...SOURCE_KEYS].some((key) => keys.has(key));
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
			if (typeof service === 'string' && isApiGatewayCloudWatchTrust(role, service)) continue;
			const name = describe(service);
			if (!found.some((f) => f.service === name)) found.push({ service: name, statement: index });
		}
	});
	return found;
}

/**
 * The service principals in `role`'s trust policy that `Allow` an assume-role
 * action with neither an `aws:SourceAccount` nor an `aws:SourceArn` condition,
 * other than the Lambda execution principals ({@link UNCONDITIONED_SERVICES})
 * and the trust of an API Gateway CloudWatch Logs role ({@link isApiGatewayCloudWatchTrust}).
 *
 * @internal
 */
export function unconditionedServicePrincipals(role: cdk.CfnResource): string[] {
	return unconditionedTrusts(role).map((t) => t.service);
}

/**
 * The sentence both checks' messages end with: the operators and values under
 * which a condition key doesn't count ({@link scopingKeys}).
 */
const CONDITION_RULES =
	'A key does not count under an IfExists, negated (StringNotEquals, ArnNotLike, ...), Null or ForAllValues: ' +
	'operator, or with a value that leaves the account open (* alone, a wildcard or empty account); nor do ' +
	'aws:SourceOrgID and aws:SourceOrgPaths, which admit every account in the organization.';

function trustProblem(role: cdk.CfnResource, service: string): string {
	return (
		`IAM role ${role.node.path} trusts the service principal ${service} without an ` +
		'aws:SourceAccount or aws:SourceArn condition. Add aws:SourceAccount (StringEquals, the stack account) ' +
		'and aws:SourceArn (ArnLike, an ARN pattern for the resources of that service) to its trust statement. ' +
		CONDITION_RULES
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
 * That set also holds roles the app creates itself ({@link isAppOwnedRole}:
 * its backend module's constructs in a `BlocksStack` or an embedded
 * `BlocksBackend`, a custom block it writes, and in a `BlocksStack` whatever
 * it adds after `create()`): those get a synth warning instead (id
 * {@link SERVICE_PRINCIPAL_TRUST_WARNING_ID}, which the app can acknowledge),
 * naming the property override that sets the condition. Roles under an AWS
 * Blocks Building Block or a compute, or created by the framework at stack
 * scope, still fail synth.
 *
 * Also registers {@link addKmsKeyPolicyCheck}, the same check for the key
 * policies of the KMS keys in those scopes. Other resource policies and KMS
 * grants are not checked. Runs as a construct validation, so it sees each trust policy after every block has
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
	addKmsKeyPolicyCheck(root);
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

/**
 * Service principals that may use an AWS Blocks KMS key without any of the
 * {@link KEY_POLICY_SCOPES}, each with the only actions (lowercased) a statement
 * may grant it to be exempt. Add a principal only with a code comment citing the
 * AWS documentation that says the service sends none of those keys.
 *
 * - `events.amazonaws.com`, for `kms:GenerateDataKey*` and `kms:Decrypt`:
 *   Amazon SNS documents that `aws:SourceAccount`, `aws:SourceArn` and
 *   `aws:SourceOrgID` in a key policy are not supported for EventBridge
 *   publishing to an encrypted topic, so either condition stops delivery
 *   (https://docs.aws.amazon.com/sns/latest/dg/sns-key-management.html#compatibility-with-aws-services).
 *
 * Actions are compared as literal strings (case-insensitively), not as
 * patterns: a statement granting `kms:GenerateDataKey` alone, which is narrower
 * than `kms:GenerateDataKey*`, is not exempt. Grant the exact actions listed
 * here, or add the narrower form to the set.
 */
const KEY_POLICY_UNCONDITIONED_SERVICES: ReadonlyMap<string, ReadonlySet<string>> = new Map([
	['events.amazonaws.com', new Set(['kms:generatedatakey*', 'kms:decrypt'])],
]);

/**
 * Whether `statement` grants `service` only actions {@link KEY_POLICY_UNCONDITIONED_SERVICES}
 * exempts for it. A `NotAction` statement is never exempt.
 */
function isUnconditionedKeyGrant(service: unknown, statement: Json): boolean {
	if (typeof service !== 'string') return false;
	const allowed = KEY_POLICY_UNCONDITIONED_SERVICES.get(service);
	if (!allowed || statement.NotAction !== undefined) return false;
	const actions = asArray(statement.Action);
	return actions.length > 0 && actions.every((a) => typeof a === 'string' && allowed.has(a.toLowerCase()));
}

/** The CloudWatch Logs service principal, `logs.<region>.amazonaws.com` (or `.amazonaws.com.cn`). */
const LOGS_PRINCIPAL = /^logs\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/;

/**
 * The condition-key sets that scope a service principal's use of a KMS key in a
 * key policy statement. The statement is scoped when it carries every key of at
 * least one set (keys compared case-insensitively, see {@link scopingKeys} for
 * the operators and values that count):
 *
 * - `aws:SourceAccount`, or `aws:SourceArn`: the global condition keys AWS KMS
 *   documents for limiting a service principal in a key policy to requests made
 *   on behalf of a given account or resource
 *   (https://docs.aws.amazon.com/kms/latest/developerguide/conditions-aws.html).
 *   Either one alone names this account or this account's resource.
 * - `kms:EncryptionContext:aws:logs:arn`, for the CloudWatch Logs principal
 *   (`logs.<region>.amazonaws.com`): CloudWatch Logs documents it as the
 *   condition that limits the key to a log group
 *   (https://docs.aws.amazon.com/AmazonCloudWatch/latest/logs/encrypt-log-data-kms.html).
 *
 * `aws:SourceOrgID` and `aws:SourceOrgPaths` don't count: they admit every
 * account in the organization. Nor does `kms:ViaService`: it applies to an IAM
 * principal calling through a service, and a request a service principal makes
 * under its own identity doesn't carry it.
 */
const KEY_POLICY_SCOPES: readonly { readonly principal?: RegExp; readonly keys: readonly string[] }[] = [
	{ keys: ['aws:sourceaccount'] },
	{ keys: ['aws:sourcearn'] },
	{ principal: LOGS_PRINCIPAL, keys: ['kms:encryptioncontext:aws:logs:arn'] },
];

/**
 * The operators (lowercased) under which a condition key constrains the
 * request: the positive string and ARN operators, alone or as `ForAnyValue:`
 * set operators. Not an `…IfExists` operator (which lets a request without the
 * key through), `Null`, a `ForAllValues:` set operator (both of which match a
 * request without it), or a negated operator (`StringNotEquals`, `ArnNotLike`,
 * …), which matches a request without the key and admits every account except
 * the listed ones.
 */
const SCOPING_OPERATORS: ReadonlySet<string> = new Set(
	['stringequals', 'stringequalsignorecase', 'stringlike', 'arnequals', 'arnlike'].flatMap((op) => [
		op,
		`foranyvalue:${op}`,
	]),
);

/** Whether a key under `operator` constrains the request (see {@link SCOPING_OPERATORS}). */
function isScopingOperator(operator: string): boolean {
	return SCOPING_OPERATORS.has(operator.toLowerCase());
}

/** ARN-valued condition keys (lowercased) whose account segment must name an account. */
const ARN_KEYS: ReadonlySet<string> = new Set(['aws:sourcearn', 'kms:encryptioncontext:aws:logs:arn']);

/**
 * Whether one value of condition `key` (lowercased) pins an account: not `*`
 * alone; for `aws:SourceAccount`, no `*` or `?`; for an ARN-valued key, an
 * account segment (the fifth `:` field) that is neither empty nor holds a
 * wildcard. An `Fn::Join` is read by its literal parts ({@link renderedText}),
 * so `arn:${stack.partition}:…:*:…` is still caught while an intrinsic in the
 * account segment (the stack account of an environment-agnostic stack) counts.
 * An `Fn::Join` whose text has fewer than five `:` fields, such as
 * `${topic.topicArn}/*`, counts too: an intrinsic in it stands for a whole ARN
 * of unknown fields, so there is no literal account segment to check. Any other
 * intrinsic counts.
 */
function pinsAccount(key: string, rendered: unknown): boolean {
	const value = renderedText(rendered);
	if (value === undefined) return true;
	if (value === '*') return false;
	if (key === 'aws:sourceaccount') return !/[*?]/.test(value);
	if (ARN_KEYS.has(key)) {
		const fields = value.split(':');
		if (typeof rendered !== 'string' && fields.length < 5) return true;
		const account = fields[4];
		return account !== undefined && account !== '' && !/[*?]/.test(account);
	}
	return true;
}

/** Whether every value of condition `key` (lowercased) pins an account ({@link pinsAccount}). */
function isConstrainingValue(key: string, value: unknown): boolean {
	const values = asArray(value);
	return values.length > 0 && values.every((v) => pinsAccount(key, v));
}

/**
 * The condition keys (lowercased) a statement's `Condition` constrains: each
 * under a scoping operator ({@link isScopingOperator}) with values that pin an
 * account ({@link isConstrainingValue}). Shared by the role trust check and the
 * key-policy check.
 */
function scopingKeys(condition: unknown): Set<string> {
	const keys = new Set<string>();
	if (!isObject(condition)) return keys;
	for (const [operator, block] of Object.entries(condition)) {
		if (!isObject(block) || !isScopingOperator(operator)) continue;
		for (const [key, value] of Object.entries(block)) {
			const lower = key.toLowerCase();
			if (isConstrainingValue(lower, value)) keys.add(lower);
		}
	}
	return keys;
}

/**
 * The text a rendered value (a service principal or a condition value) stands
 * for, for matching: the string itself, or an `Fn::Join`'s literal parts with
 * `Ref AWS::URLSuffix` read as `amazonaws.com` and any other intrinsic as the
 * placeholder `token`, so `logs.${stack.region}.amazonaws.com` in an
 * environment-agnostic stack still reads as the CloudWatch Logs principal.
 * `undefined` for any other value.
 */
function renderedText(value: unknown): string | undefined {
	if (typeof value === 'string') return value;
	if (!isObject(value)) return undefined;
	const join = value['Fn::Join'];
	if (!Array.isArray(join) || join.length !== 2 || typeof join[0] !== 'string' || !Array.isArray(join[1])) {
		return undefined;
	}
	const delimiter = join[0];
	return join[1]
		.map((part: unknown) => {
			if (typeof part === 'string') return part;
			if (isObject(part) && part.Ref === 'AWS::URLSuffix') return 'amazonaws.com';
			return 'token';
		})
		.join(delimiter);
}

/** A service principal an unscoped key-policy statement names, with that statement's index. */
interface UnscopedKeyPolicyGrant {
	readonly service: string;
	/** Index of the statement in `KeyPolicy.Statement`. */
	readonly statement: number;
}

/**
 * Every service principal (other than {@link KEY_POLICY_UNCONDITIONED_SERVICES})
 * in an `Allow` statement of `key`'s rendered key policy that carries none of the
 * {@link KEY_POLICY_SCOPES}, in statement order, each principal once.
 */
function unscopedKeyPolicyGrants(key: cdk.CfnResource): UnscopedKeyPolicyGrant[] {
	const doc = renderedProperty(key, 'KeyPolicy');
	if (!isObject(doc)) return [];
	const found: UnscopedKeyPolicyGrant[] = [];
	asArray(doc.Statement).forEach((statement, index) => {
		if (!isObject(statement) || statement.Effect !== 'Allow' || !isObject(statement.Principal)) return;
		const keys = scopingKeys(statement.Condition);
		for (const service of asArray(statement.Principal.Service)) {
			if (isUnconditionedKeyGrant(service, statement)) continue;
			const text = renderedText(service);
			const scoped = KEY_POLICY_SCOPES.some(
				(scope) =>
					(!scope.principal || (text !== undefined && scope.principal.test(text))) &&
					scope.keys.every((k) => keys.has(k)),
			);
			if (scoped) continue;
			const name = describe(service);
			if (!found.some((f) => f.service === name)) found.push({ service: name, statement: index });
		}
	});
	return found;
}

/**
 * The service principals that `key`'s key policy lets use the key, in an `Allow`
 * statement scoped by none of the {@link KEY_POLICY_SCOPES}.
 *
 * @internal
 */
export function unscopedKeyPolicyServicePrincipals(key: cdk.CfnResource): string[] {
	return unscopedKeyPolicyGrants(key).map((g) => g.service);
}

function keyPolicyProblem(key: cdk.CfnResource, { service, statement }: UnscopedKeyPolicyGrant): string {
	return (
		`KMS key ${key.node.path} lets the service principal ${service} use it (key policy statement ${statement}) ` +
		'without an aws:SourceAccount or aws:SourceArn condition. Add aws:SourceAccount (StringEquals, the stack ' +
		"account) or aws:SourceArn (ArnLike, an ARN pattern for this account's resources of that service) to the " +
		'statement. kms:EncryptionContext:aws:logs:arn also counts for CloudWatch Logs. ' +
		CONDITION_RULES
	);
}

function appOwnedKeyPolicyWarning(key: cdk.CfnResource, grant: UnscopedKeyPolicyGrant): string {
	return (
		`${keyPolicyProblem(key, grant)} To keep the statement as it is, acknowledge this warning: ` +
		`Annotations.of(key).acknowledgeWarning('${KMS_KEY_POLICY_WARNING_ID}'), or on the stack ` +
		'to acknowledge it for every key in the stack.'
	);
}

/**
 * Fail synth when a KMS key AWS Blocks creates for `root` (the keys in the
 * scopes {@link forEachBlocksKmsKey} covers, the same scopes as the role check)
 * lets a service principal use it in an `Allow` key-policy statement scoped by
 * none of the {@link KEY_POLICY_SCOPES}. A key the app creates
 * ({@link isAppOwnedRole}) gets a synth warning instead (id
 * {@link KMS_KEY_POLICY_WARNING_ID}). Checks key policies only, not KMS grants
 * (`AWS::KMS::Grant` or `CreateGrant` calls).
 *
 * @internal
 */
export function addKmsKeyPolicyCheck(root: Construct): void {
	forEachBlocksKmsKey(root, (key) => {
		key.node.addValidation({
			validate: () => {
				const found = unscopedKeyPolicyGrants(key);
				if (found.length === 0) return [];
				if (isAppOwnedRole(root, key)) {
					for (const grant of found) {
						cdk.Annotations.of(key).addWarningV2(
							KMS_KEY_POLICY_WARNING_ID,
							appOwnedKeyPolicyWarning(key, grant),
						);
					}
					return [];
				}
				return found.map((grant) => keyPolicyProblem(key, grant));
			},
		});
	});
}
