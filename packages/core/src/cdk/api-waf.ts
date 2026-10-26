// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * AWS WAF for the backend API (`apiWaf`), attached to whichever front door
 * clients reach the API through.
 *
 * The decision is made by the API front-door aspect at synth (see
 * `api-front-door.ts`), because only then is it known whether a `Hosting`
 * distribution claimed the API:
 *
 * - `apigateway` tier → a `REGIONAL` web ACL associated with the REST API stage.
 * - `cloudfront` tier → a `CLOUDFRONT` web ACL on the managed distribution
 *   (CloudFront web ACLs can only be created in us-east-1).
 * - claimed by `Hosting` → nothing; Hosting's own front-door WAF covers the
 *   distribution, and a synth warning says so.
 */

import * as cdk from 'aws-cdk-lib';
import type { Stage } from 'aws-cdk-lib/aws-apigateway';
import { CfnWebACL, CfnWebACLAssociation } from 'aws-cdk-lib/aws-wafv2';
import type { Construct } from 'constructs';
import type { ApiWafOptions } from '../common/index.js';

/** Construct id of the Blocks-managed web ACL, under the backend owner. */
const WEB_ACL_ID = 'ApiWaf';

/** Default per-IP request limit per 5-minute window (matches Hosting's WAF). */
const DEFAULT_RATE_LIMIT = 1000;

/** AWS WAF's minimum rate-based rule limit. */
const MIN_RATE_LIMIT = 100;

/** Synth-warning id emitted when `apiWaf` is set but `Hosting` fronts the API. */
export const API_WAF_DEFERRED_WARNING = 'blocks:api-waf:deferred-to-hosting';

/** A validated `apiWaf` setting; `undefined` when WAF is off. */
export type ResolvedApiWaf = { readonly webAclArn: string } | { readonly rateLimit: number };

/**
 * Validate the `apiWaf` prop. Runs in the `BlocksStack` / `BlocksBackend`
 * constructor, so a bad value fails before any app code is imported.
 *
 * @returns the resolved setting, or `undefined` when WAF is off.
 * @internal
 */
export function resolveApiWaf(apiWaf: ApiWafOptions | undefined): ResolvedApiWaf | undefined {
	if (apiWaf === undefined) return undefined;
	if (apiWaf === null || typeof apiWaf !== 'object') {
		throw new Error(`apiWaf must be an object like { enabled: true } or { webAclArn } (got ${JSON.stringify(apiWaf)}).`);
	}
	const { enabled, rateLimit, webAclArn } = apiWaf;
	if (webAclArn !== undefined) {
		if (typeof webAclArn !== 'string' || webAclArn.length === 0) {
			throw new Error('apiWaf.webAclArn must be a non-empty web ACL ARN.');
		}
		if (enabled !== undefined || rateLimit !== undefined) {
			throw new Error(
				'apiWaf takes either { webAclArn } (your own web ACL) or { enabled: true, rateLimit? } (a Blocks-managed one), not both.',
			);
		}
		return { webAclArn };
	}
	if (rateLimit !== undefined && (!Number.isInteger(rateLimit) || rateLimit < MIN_RATE_LIMIT)) {
		throw new Error(
			`apiWaf.rateLimit must be an integer of at least ${MIN_RATE_LIMIT} (an AWS WAF minimum; got ${rateLimit}).`,
		);
	}
	if (enabled !== true) {
		if (rateLimit !== undefined) {
			throw new Error('apiWaf.rateLimit only applies with enabled: true.');
		}
		return undefined;
	}
	return { rateLimit: rateLimit ?? DEFAULT_RATE_LIMIT };
}

/** Visibility settings shared by the web ACL and each rule. */
function visibility(metricName: string): CfnWebACL.VisibilityConfigProperty {
	return { cloudWatchMetricsEnabled: true, metricName, sampledRequestsEnabled: true };
}

/**
 * Create the Blocks-managed web ACL.
 *
 * Same rule set as Hosting's WAF (AWS managed Common + Known Bad Inputs, then a
 * per-IP rate limit) with one difference: the Common rule set's
 * `SizeRestrictions_BODY` rule is set to count. It blocks request bodies over
 * 8 KB, which an API receives routinely (RPC arguments, uploads up to API
 * Gateway's 10 MB limit), so blocking on it would reject normal traffic.
 */
function createWebAcl(owner: Construct, scope: 'REGIONAL' | 'CLOUDFRONT', rateLimit: number): CfnWebACL {
	return new CfnWebACL(owner, WEB_ACL_ID, {
		scope,
		defaultAction: { allow: {} },
		visibilityConfig: visibility('BlocksApiWebAcl'),
		rules: [
			{
				name: 'AWSManagedRulesCommonRuleSet',
				priority: 1,
				overrideAction: { none: {} },
				statement: {
					managedRuleGroupStatement: {
						vendorName: 'AWS',
						name: 'AWSManagedRulesCommonRuleSet',
						ruleActionOverrides: [{ name: 'SizeRestrictions_BODY', actionToUse: { count: {} } }],
					},
				},
				visibilityConfig: visibility('BlocksApiCommonRuleSet'),
			},
			{
				name: 'AWSManagedRulesKnownBadInputsRuleSet',
				priority: 2,
				overrideAction: { none: {} },
				statement: {
					managedRuleGroupStatement: { vendorName: 'AWS', name: 'AWSManagedRulesKnownBadInputsRuleSet' },
				},
				visibilityConfig: visibility('BlocksApiKnownBadInputs'),
			},
			{
				name: 'RateLimitRule',
				priority: 3,
				action: { block: {} },
				statement: { rateBasedStatement: { limit: rateLimit, aggregateKeyType: 'IP' } },
				visibilityConfig: visibility('BlocksApiRateLimit'),
			},
		],
	});
}

/**
 * `apigateway` tier: associate a `REGIONAL` web ACL (Blocks-managed or the
 * caller's) with the shared REST API's stage.
 *
 * @internal
 */
export function attachApiWafToStage(owner: Construct, stage: Stage, waf: ResolvedApiWaf): void {
	const webAclArn = 'webAclArn' in waf ? waf.webAclArn : createWebAcl(owner, 'REGIONAL', waf.rateLimit).attrArn;
	new CfnWebACLAssociation(owner, `${WEB_ACL_ID}Association`, { resourceArn: stage.stageArn, webAclArn });
}

/**
 * `cloudfront` tier: the web ACL ARN to set as the managed distribution's
 * `webAclId` — the caller's, or a Blocks-managed `CLOUDFRONT` one. Creating one
 * requires a us-east-1 stack; a region that is a token (an environment-agnostic
 * stack) can't be checked here and is left to CloudFormation.
 *
 * @internal
 */
export function webAclArnForDistribution(owner: Construct, waf: ResolvedApiWaf): string {
	if ('webAclArn' in waf) return waf.webAclArn;
	const region = cdk.Stack.of(owner).region;
	if (!cdk.Token.isUnresolved(region) && region !== 'us-east-1') {
		throw new Error(
			`apiWaf: { enabled: true } under apiFrontDoor: 'cloudfront' needs a CLOUDFRONT-scoped web ACL, which AWS only ` +
				`creates in us-east-1, but this stack is in ${region}. Create the web ACL in a us-east-1 stack and pass its ARN ` +
				`as apiWaf: { webAclArn }, or use apiFrontDoor: 'apigateway' (a REGIONAL web ACL on the API stage).`,
		);
	}
	return createWebAcl(owner, 'CLOUDFRONT', waf.rateLimit).attrArn;
}

/**
 * Warn that `apiWaf` creates nothing because a `Hosting` distribution fronts
 * the API, so its WAF belongs on Hosting's front door.
 *
 * @internal
 */
export function warnApiWafDeferredToHosting(owner: Construct): void {
	cdk.Annotations.of(owner).addWarningV2(
		API_WAF_DEFERRED_WARNING,
		"apiWaf creates no web ACL: Hosting's CloudFront distribution fronts this API, so set the WAF on Hosting " +
			'instead (frontDoor: { features: { waf: { enabled: true } } }).',
	);
}
