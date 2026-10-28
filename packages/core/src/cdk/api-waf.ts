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
 *   When a `Hosting` door also forwards browser traffic to the stage, the rate
 *   rule exempts (CloudFront claim) or leaves out (proxy doors) those requests.
 * - `cloudfront` tier claimed by `Hosting` → nothing; the API is served from
 *   Hosting's distribution, so its WAF belongs there, and a synth warning says so.
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
 * Header a CloudFront `Hosting` distribution that claims the API adds to every
 * request it forwards to the gateway, carrying {@link apiFrontDoorMarkerValue}.
 * The stage ACL's rate rule skips requests that carry it: those arrive from
 * CloudFront edge IPs, so an IP rate limit would throttle every browser user
 * behind one edge together. A viewer can't forge it, because a CloudFront
 * origin custom header replaces any viewer header of the same name.
 */
export const API_FRONT_DOOR_MARKER_HEADER = 'x-blocks-front-door';

/**
 * The marker value for this backend: the UUID part of its stack's
 * `AWS::StackId` (`arn:aws:cloudformation:<region>:<account>:stack/<name>/<uuid>`).
 * CloudFormation assigns it when the stack is created, so it is stable across
 * deploys (the template doesn't change on every synth) but isn't derivable
 * from anything public — stack names, construct paths and this code all are.
 * Both the origin custom header and the WAF byte match take it as a token. It
 * only exempts proxied requests from the rate rule — the managed rule groups
 * still inspect them — so it is a rate-limit scope, not an authorization.
 *
 * @internal
 */
export function apiFrontDoorMarkerValue(owner: Construct): string {
	return cdk.Fn.select(2, cdk.Fn.split('/', cdk.Stack.of(owner).stackId));
}

/**
 * Who reaches the API stage, which decides how the stage ACL's rate rule works:
 * - `direct` — clients call `execute-api` themselves: rate-limit per IP.
 * - `marked` — a CloudFront `Hosting` that claims the API also forwards browser
 *   traffic: rate-limit per IP, except requests carrying the marker header.
 * - `proxied` — a `Hosting` door forwards browser traffic through a proxy
 *   (ALB / API Gateway / bring-your-own doors, or a CloudFront edge over a
 *   router): every browser request comes from the proxy's IPs, so no rate rule.
 */
export type StageWafTraffic = 'direct' | 'marked' | 'proxied';

/** Synth-warning id emitted when `apiWaf` leaves the rate rule off the stage ACL. */
export const API_WAF_NO_RATE_LIMIT_WARNING = 'blocks:api-waf:no-rate-limit-behind-door';

/**
 * Common rule set rules that inspect the request BODY and would reject normal
 * RPC traffic, so the managed web ACL counts instead of blocking them:
 * - `SizeRestrictions_BODY` blocks bodies over 8 KB (RPC arguments, uploads up
 *   to API Gateway's 10 MB limit);
 * - `CrossSiteScripting_BODY`, `GenericLFI_BODY` and `GenericRFI_BODY` match
 *   user-written HTML, Markdown and file paths carried as JSON data.
 * Their query-string, URI and header counterparts still block.
 */
const COUNTED_BODY_RULES = ['SizeRestrictions_BODY', 'CrossSiteScripting_BODY', 'GenericLFI_BODY', 'GenericRFI_BODY'];

/**
 * Create the Blocks-managed web ACL.
 *
 * Same rule set as Hosting's WAF (AWS managed Common + Known Bad Inputs, then a
 * per-IP rate limit), except that the body rules in {@link COUNTED_BODY_RULES}
 * count instead of block, and the rate rule follows {@link StageWafTraffic}.
 */
function createWebAcl(
	owner: Construct,
	scope: 'REGIONAL' | 'CLOUDFRONT',
	rateLimit: number,
	traffic: StageWafTraffic = 'direct',
): CfnWebACL {
	const rules: CfnWebACL.RuleProperty[] = [
		{
			name: 'AWSManagedRulesCommonRuleSet',
			priority: 1,
			overrideAction: { none: {} },
			statement: {
				managedRuleGroupStatement: {
					vendorName: 'AWS',
					name: 'AWSManagedRulesCommonRuleSet',
					ruleActionOverrides: COUNTED_BODY_RULES.map((name) => ({ name, actionToUse: { count: {} } })),
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
	];
	if (traffic !== 'proxied') {
		rules.push({
			name: 'RateLimitRule',
			priority: 3,
			action: { block: {} },
			statement: {
				rateBasedStatement: {
					limit: rateLimit,
					aggregateKeyType: 'IP',
					...(traffic === 'marked'
						? {
							scopeDownStatement: {
								notStatement: {
									statement: {
										byteMatchStatement: {
											fieldToMatch: { singleHeader: { Name: API_FRONT_DOOR_MARKER_HEADER } },
											positionalConstraint: 'EXACTLY',
											searchString: apiFrontDoorMarkerValue(owner),
											textTransformations: [{ priority: 0, type: 'NONE' }],
										},
									},
								},
							},
						}
						: {}),
				},
			},
			visibilityConfig: visibility('BlocksApiRateLimit'),
		});
	}
	return new CfnWebACL(owner, WEB_ACL_ID, {
		scope,
		defaultAction: { allow: {} },
		visibilityConfig: visibility('BlocksApiWebAcl'),
		rules,
	});
}

/**
 * Check a literal `webAclArn` against where it attaches, so a mismatch fails
 * synth rather than the deploy. A token ARN (e.g. from another construct) is
 * left to CloudFormation.
 */
function assertWebAclArnScope(owner: Construct, webAclArn: string, scope: 'REGIONAL' | 'CLOUDFRONT'): void {
	if (cdk.Token.isUnresolved(webAclArn)) return;
	const match = /^arn:aws[a-z-]*:wafv2:([a-z0-9-]+):\d{12}:(regional|global)\/webacl\//.exec(webAclArn);
	if (!match) {
		throw new Error(`apiWaf.webAclArn must be a WAFv2 web ACL ARN (arn:aws:wafv2:…:webacl/…), got ${webAclArn}.`);
	}
	const [, arnRegion, arnScope] = match;
	if (scope === 'CLOUDFRONT') {
		if (arnScope !== 'global' || arnRegion !== 'us-east-1') {
			throw new Error(
				`apiWaf.webAclArn under apiFrontDoor: 'cloudfront' must be a CLOUDFRONT-scoped web ACL in us-east-1 ` +
					`(arn:aws:wafv2:us-east-1:…:global/webacl/…), got ${webAclArn}.`,
			);
		}
		return;
	}
	const region = cdk.Stack.of(owner).region;
	if (arnScope !== 'regional' || (!cdk.Token.isUnresolved(region) && arnRegion !== region)) {
		throw new Error(
			`apiWaf.webAclArn under apiFrontDoor: 'apigateway' must be a REGIONAL web ACL in this stack's region ` +
				`(arn:aws:wafv2:${cdk.Token.isUnresolved(region) ? '<region>' : region}:…:regional/webacl/…), got ${webAclArn}.`,
		);
	}
}

/**
 * `apigateway` tier: associate a `REGIONAL` web ACL (Blocks-managed or the
 * caller's) with the shared REST API's stage. `traffic` says whether a
 * `Hosting` door also forwards browser traffic to the stage (see
 * {@link StageWafTraffic}); a caller-supplied web ACL is attached as-is.
 *
 * @internal
 */
export function attachApiWafToStage(
	owner: Construct,
	stage: Stage,
	waf: ResolvedApiWaf,
	traffic: StageWafTraffic = 'direct',
): void {
	let webAclArn: string;
	if ('webAclArn' in waf) {
		assertWebAclArnScope(owner, waf.webAclArn, 'REGIONAL');
		webAclArn = waf.webAclArn;
	} else {
		webAclArn = createWebAcl(owner, 'REGIONAL', waf.rateLimit, traffic).attrArn;
		if (traffic === 'proxied') {
			cdk.Annotations.of(owner).addWarningV2(
				API_WAF_NO_RATE_LIMIT_WARNING,
				'apiWaf leaves the per-IP rate rule off the API stage: a Hosting door forwards browser requests to it ' +
					"through a proxy, so they'd all share the proxy's IPs. The managed rule groups still apply. Set a rate " +
					"limit on the door's own WAF (frontDoor: { features: { waf: { enabled: true } } }).",
			);
		}
	}
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
	if ('webAclArn' in waf) {
		assertWebAclArnScope(owner, waf.webAclArn, 'CLOUDFRONT');
		return waf.webAclArn;
	}
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
