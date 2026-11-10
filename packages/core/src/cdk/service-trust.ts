// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Cross-service confused-deputy check for the trust policies of the IAM roles
 * AWS Blocks creates.
 *
 * A role that an AWS service assumes on your behalf should only be assumable
 * when that service acts for a resource in your own account. IAM's documented
 * way to say so is to put both global condition keys on the trust statement:
 * `aws:SourceAccount` (the account that owns the calling resource) and
 * `aws:SourceArn` (the calling resource itself, or a wildcard over this
 * account's resources of that service). See the IAM User Guide, "The confused
 * deputy problem":
 * https://docs.aws.amazon.com/IAM/latest/UserGuide/confused-deputy.html
 *
 * {@link findUnscopedServiceTrust} reports every service principal in a trust
 * policy whose statement is missing either key, unless the principal is in
 * {@link SERVICE_TRUST_EXCLUSIONS} (services whose documented trust policy for
 * that role carries neither key).
 *
 * Two consumers use it: a repo test that synthesizes every Building Block and
 * fails on any of them (`test-apps/comprehensive/test/service-trust-synth.test.ts`),
 * and {@link warnOnUnscopedServiceTrust}, which adds a synth warning in apps.
 *
 * @internal
 */

import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { finalizeBlocksRoles } from './blocks-roles.js';
import { renderedProperties } from './iam-report.js';

/** The two condition keys every service-principal trust statement should carry. */
export const SERVICE_TRUST_KEYS = ['aws:SourceAccount', 'aws:SourceArn'] as const;

/** A service principal allowed to trust a role without {@link SERVICE_TRUST_KEYS}. */
export interface ServiceTrustExclusion {
	/** The service principal, e.g. `lambda.amazonaws.com`. */
	readonly principal: string;
	/**
	 * Limits the exclusion to roles whose construct path or logical id matches.
	 * Unset: every role trusting {@link principal} is excluded.
	 */
	readonly role?: RegExp;
	/** Why the keys can't be used for this principal. */
	readonly reason: string;
	/** The AWS documentation the reason relies on. */
	readonly reference: string;
}

/**
 * Service principals that may trust a Blocks role without `aws:SourceAccount`
 * and `aws:SourceArn`. Each entry names the AWS documentation it relies on. Add
 * an entry only with such a citation; prefer adding the keys.
 */
export const SERVICE_TRUST_EXCLUSIONS: readonly ServiceTrustExclusion[] = [
	{
		// Every Lambda function's execution role (the shared BlocksRole, Hosting's
		// server functions, CDK's custom-resource and BucketDeployment providers).
		principal: 'lambda.amazonaws.com',
		reason:
			'Lambda assumes a function execution role when it invokes the function; the documented execution-role ' +
			'trust policy names only the service principal, and Lambda does not document aws:SourceAccount or ' +
			'aws:SourceArn for that assumption.',
		reference: 'https://docs.aws.amazon.com/lambda/latest/dg/lambda-intro-execution-role.html',
	},
	{
		// Hosting's Lambda@Edge functions run as a role trusted by both Lambda principals.
		principal: 'edgelambda.amazonaws.com',
		reason:
			'Lambda@Edge assumes the function execution role in the edge Regions; the documented trust policy names ' +
			'lambda.amazonaws.com and edgelambda.amazonaws.com with no condition keys.',
		reference: 'https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/lambda-edge-permissions.html',
	},
	{
		// The account-level CloudWatch Logs role API Gateway uses for REST and
		// WebSocket access logging (core's and Hosting's ensureApiGatewayAccount).
		principal: 'apigateway.amazonaws.com',
		role: /(^|\/)BlocksApiGatewayCloudWatchRole/,
		reason:
			"API Gateway's CloudWatch Logs role is set once per account and Region (AWS::ApiGateway::Account), not " +
			'per API. The documented trust policy names only the service principal, and API Gateway does not ' +
			'document aws:SourceAccount or aws:SourceArn for this role, so a role carrying them could stop logs ' +
			'from being delivered.',
		reference: 'https://docs.aws.amazon.com/apigateway/latest/developerguide/set-up-logging.html',
	},
];

/** One service principal in a trust policy that is missing a confused-deputy key. */
export interface UnscopedServiceTrust {
	/** The service principal, e.g. `bedrock.amazonaws.com`. */
	readonly principal: string;
	/** Which of {@link SERVICE_TRUST_KEYS} its statement lacks. */
	readonly missing: readonly (typeof SERVICE_TRUST_KEYS)[number][];
}

const asArray = (v: unknown): unknown[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

/** Condition keys in a statement's `Condition`, lowercased (IAM condition keys are case-insensitive). */
function conditionKeys(condition: unknown): Set<string> {
	const keys = new Set<string>();
	if (!condition || typeof condition !== 'object') return keys;
	for (const block of Object.values(condition as Record<string, unknown>)) {
		if (!block || typeof block !== 'object') continue;
		for (const key of Object.keys(block as Record<string, unknown>)) keys.add(key.toLowerCase());
	}
	return keys;
}

/** The literal service principals of a statement (`Principal.Service`); tokens and intrinsics are skipped. */
function servicePrincipals(statement: Record<string, unknown>): string[] {
	const principal = statement.Principal;
	if (!principal || typeof principal !== 'object') return [];
	return asArray((principal as Record<string, unknown>).Service).filter((s): s is string => typeof s === 'string');
}

function isExcluded(principal: string, roleIds: readonly string[]): boolean {
	return SERVICE_TRUST_EXCLUSIONS.some(
		(e) => e.principal === principal && (!e.role || roleIds.some((id) => e.role?.test(id))),
	);
}

/**
 * Every service principal in `trustPolicy` (a resolved `AssumeRolePolicyDocument`)
 * whose `Allow` statement lacks `aws:SourceAccount` or `aws:SourceArn`, minus
 * the {@link SERVICE_TRUST_EXCLUSIONS}. Any condition operator counts
 * (`StringEquals`, `ArnLike`, …); key names match case-insensitively.
 *
 * @param trustPolicy - the role's trust policy, as rendered for the template.
 * @param roleIds - the role's construct path and/or logical id, matched against
 *   an exclusion's `role` pattern.
 * @returns one entry per principal per statement; empty when every
 *   service trust is scoped or excluded.
 */
export function findUnscopedServiceTrust(trustPolicy: unknown, roleIds: readonly string[] = []): UnscopedServiceTrust[] {
	const gaps: UnscopedServiceTrust[] = [];
	const statements = asArray((trustPolicy as { Statement?: unknown } | undefined)?.Statement);
	for (const raw of statements) {
		if (!raw || typeof raw !== 'object') continue;
		const statement = raw as Record<string, unknown>;
		if (statement.Effect !== 'Allow') continue;
		const keys = conditionKeys(statement.Condition);
		const missing = SERVICE_TRUST_KEYS.filter((k) => !keys.has(k.toLowerCase()));
		if (missing.length === 0) continue;
		for (const principal of servicePrincipals(statement)) {
			if (!isExcluded(principal, roleIds)) gaps.push({ principal, missing });
		}
	}
	return gaps;
}

/** One line per unscoped principal, for warnings and test failures. */
export function describeUnscopedServiceTrust(role: string, gaps: readonly UnscopedServiceTrust[]): string {
	return gaps.map((f) => `${role}: ${f.principal} trust lacks ${f.missing.join(' and ')}`).join('\n');
}

/**
 * Scope the trust policy of the Step Functions waiter role inside a CDK
 * custom-resource `Provider` that has an `isCompleteHandler`. CDK creates that
 * role trusted by `states.amazonaws.com` with no conditions and doesn't expose
 * it; this rewrites its trust to the documented Step Functions form —
 * `aws:SourceAccount` = this account, `aws:SourceArn` like
 * `arn:<partition>:states:<region>:<account>:stateMachine:*`
 * (https://docs.aws.amazon.com/step-functions/latest/dg/procedure-create-iam-role.html,
 * "Prevent cross-service confused deputy issue").
 *
 * No-op for a provider without a waiter. If a CDK release moves the role, this
 * stays a no-op and the repo's service-trust test reports the unscoped role.
 *
 * @internal
 */
export function scopeProviderWaiterTrust(provider: Construct): void {
	const role = provider.node.tryFindChild('waiter-state-machine')?.node.tryFindChild('Role');
	const cfn = role?.node.defaultChild;
	if (!cdk.CfnResource.isCfnResource(cfn) || cfn.cfnResourceType !== 'AWS::IAM::Role') return;
	const stack = cdk.Stack.of(provider);
	cfn.addPropertyOverride('AssumeRolePolicyDocument', {
		Version: '2012-10-17',
		Statement: [
			{
				Effect: 'Allow',
				Principal: { Service: 'states.amazonaws.com' },
				Action: 'sts:AssumeRole',
				Condition: {
					StringEquals: { 'aws:SourceAccount': stack.account },
					ArnLike: { 'aws:SourceArn': `arn:${stack.partition}:states:${stack.region}:${stack.account}:stateMachine:*` },
				},
			},
		],
	});
}

/** Warning id of {@link warnOnUnscopedServiceTrust}; pass it to `Annotations.acknowledgeWarning` to silence it. */
export const UNSCOPED_SERVICE_TRUST_WARNING = 'blocks:iam:unscopedServiceTrust';

/**
 * At synth, add a warning to every role AWS Blocks created for `root` whose
 * trust policy lets an AWS service assume it without `aws:SourceAccount` and
 * `aws:SourceArn` ({@link findUnscopedServiceTrust}). Synth never fails on it.
 *
 * The check runs from a custom-synthesis hook, so it sees each trust policy as
 * written to the template (statements added after the role was created, and
 * escape-hatch overrides, included).
 *
 * @internal
 */
export function warnOnUnscopedServiceTrust(root: Construct): void {
	cdk.attachCustomSynthesis(new Construct(root, 'BlocksServiceTrustCheck'), {
		onSynthesize: () => {
			for (const role of finalizeBlocksRoles(root)) {
				const logicalId = cdk.Stack.of(role).resolve(role.logicalId) as string;
				const gaps = findUnscopedServiceTrust(renderedProperties(role).AssumeRolePolicyDocument, [
					role.node.path,
					logicalId,
				]);
				if (gaps.length === 0) continue;
				cdk.Annotations.of(role).addWarningV2(
					UNSCOPED_SERVICE_TRUST_WARNING,
					`${describeUnscopedServiceTrust(role.node.path, gaps)}. ` +
						'Any resource of that service, in any account, could get it to assume this role. Add ' +
						'"StringEquals": { "aws:SourceAccount": <account> } and "ArnLike": { "aws:SourceArn": ' +
						'<this account\'s resources of that service> } to the trust statement ' +
						'(https://docs.aws.amazon.com/IAM/latest/UserGuide/confused-deputy.html).',
				);
			}
		},
	});
}
