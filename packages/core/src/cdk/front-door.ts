// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as cdk from 'aws-cdk-lib';
import { Aspects, type IAspect } from 'aws-cdk-lib';
import {
	type AddBehaviorOptions,
	AllowedMethods,
	CachePolicy,
	Distribution,
	type IOrigin,
	OriginRequestPolicy,
	ViewerProtocolPolicy,
} from 'aws-cdk-lib/aws-cloudfront';
import { HttpOrigin } from 'aws-cdk-lib/aws-cloudfront-origins';
import type { Construct, IConstruct } from 'constructs';
import { BLOCKS_RPC_PREFIX } from '../constants.js';

/**
 * CloudFront construct id of the managed front door within its owner. A stable
 * id so the distribution is reused rather than churned across deploys.
 */
const FRONT_DOOR_ID = 'BlocksApiFrontDoor';

/**
 * Behavior config for the front-door route. The backend API is dynamic and
 * auth-bearing, so we forward all viewer headers (cookies + `Authorization`)
 * except `Host` — an API Gateway origin rejects a mismatched `Host` — and
 * disable caching.
 */
const BEHAVIOR_OPTIONS = {
	allowedMethods: AllowedMethods.ALLOW_ALL,
	cachePolicy: CachePolicy.CACHING_DISABLED,
	originRequestPolicy: OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
	viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
} satisfies AddBehaviorOptions;

/**
 * Build a CloudFront HTTP origin from a Blocks API URL
 * (`https://{id}.execute-api.{region}.amazonaws.com/{stage}/aws-blocks/api`).
 *
 * The URL is a CDK token at synth, so the hostname/stage split is done with
 * CloudFormation intrinsics (`Fn::Split`/`Fn::Select`) that resolve at deploy:
 * strip the `/aws-blocks/api` suffix, drop the scheme, then take the host and
 * stage segments. The stage becomes the origin path. This is the single place
 * the framework turns a Blocks API URL into an origin.
 *
 * @param apiUrl - The compute/stack API URL (may be an unresolved CDK token).
 */
export function httpOriginFromApiUrl(apiUrl: string): IOrigin {
	const base = cdk.Fn.select(0, cdk.Fn.split(BLOCKS_RPC_PREFIX, apiUrl));
	const withoutScheme = cdk.Fn.select(1, cdk.Fn.split('https://', base));
	const hostname = cdk.Fn.select(0, cdk.Fn.split('/', withoutScheme));
	const stage = cdk.Fn.select(1, cdk.Fn.split('/', withoutScheme));
	return new HttpOrigin(hostname, { originPath: `/${stage}` });
}

/**
 * One-shot aspect that provisions the managed front door at synth — after the
 * whole tree exists.
 *
 * - **Provisioning on** (production) → create one Blocks-owned CloudFront
 *   distribution whose single default behavior proxies the stack's API origin,
 *   and emit a `FrontDoorUrl` output so the distribution can be deployed and
 *   smoke-tested. The client is **not** switched to it here — nothing routes
 *   through the distribution yet.
 * - **Provisioning off** (sandbox / opt-out) → do nothing; the client keeps
 *   hitting the API Gateway directly.
 */
class FrontDoorAspect implements IAspect {
	private done = false;

	constructor(
		private readonly scope: Construct,
		private readonly apiUrl: string,
		private readonly provision: boolean,
	) {}

	visit(_node: IConstruct): void {
		// The tree is fully built by the time any aspect visit runs, so act once.
		if (this.done) return;
		this.done = true;

		if (!this.provision) return;

		const stack = cdk.Stack.of(this.scope);
		// Scoped under the owning BlocksStack/BlocksBackend (not the raw stack) so
		// several front-door-enabled backends in one stack each get their own
		// distribution rather than colliding on a stack-level construct id.
		const distribution = new Distribution(this.scope, FRONT_DOOR_ID, {
			comment: `Blocks API front door (${stack.stackName})`,
			defaultBehavior: { origin: httpOriginFromApiUrl(this.apiUrl), ...BEHAVIOR_OPTIONS },
		});

		new cdk.CfnOutput(this.scope, 'FrontDoorUrl', {
			value: `https://${distribution.distributionDomainName}`,
			description: 'Blocks API CloudFront front door URL',
		});
	}
}

/**
 * Schedule the managed CloudFront **API front door** for synth-time resolution.
 *
 * Registered from `create()` via a CDK aspect so the decision is deferred until
 * the whole app exists. The front door is the stable public origin for the
 * backend HTTP surface, so adding/scaling compute never changes the browser
 * hostname (auth cookies persist). In this stage the distribution is provisioned
 * and its URL published, but the client still calls the API Gateway directly.
 *
 * @param scope - The owning BlocksStack/BlocksBackend. The aspect is added to it
 *   so the distribution is scoped under this owner (several backends in one
 *   stack stay independent).
 * @param apiUrl - The stack's API URL (the default compute's), used to build the
 *   front-door origin. A CDK token is fine — it resolves at deploy.
 * @param provision - `defaults.provisionApiFrontDoor` (on in prod, off in sandbox).
 */
export function scheduleFrontDoor(scope: Construct, apiUrl: string, provision: boolean): void {
	Aspects.of(scope).add(new FrontDoorAspect(scope, apiUrl, provision));
}
