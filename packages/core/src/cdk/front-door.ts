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
 * CloudFront logical id of the managed front door within its stack. A stable id
 * so the distribution is reused rather than churned across deploys.
 */
const FRONT_DOOR_ID = 'BlocksApiFrontDoor';

/**
 * Per-stack handle to Hosting's CloudFront distribution, published by the
 * `Hosting` construct (see {@link registerHostingDistribution}). When present,
 * Hosting is already the app's front door (it proxies `/aws-blocks/api/*` to the
 * backend on its own distribution), so the managed front door does **not**
 * create a second distribution.
 */
const HOSTING_DISTRIBUTION_KEY = Symbol.for('BLOCKS_HOSTING_DISTRIBUTION');

/**
 * Per-stack holder for the resolved public front-door URL. Set by the aspect at
 * synth (only in the Blocks-owned branch) and read lazily by the `ApiUrl`
 * CfnOutput so the deployed client resolves the front-door origin.
 */
const RESOLVED_URL_KEY = Symbol.for('BLOCKS_FRONT_DOOR_RESOLVED_URL');

/**
 * Behavior config for the front-door route. The backend API is dynamic and
 * auth-bearing, so we forward all viewer headers (cookies + `Authorization`)
 * except `Host` — an API Gateway origin rejects a mismatched `Host` — and
 * disable caching. Mirrors the defaults Hosting uses for its own
 * `/aws-blocks/api/*` proxy so both front-door paths behave identically.
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
 * the framework turns a Blocks API URL into an origin — Hosting's
 * `addApiBehaviors` reuses it so the two front-door paths stay identical.
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
 * Publish Hosting's CloudFront distribution on the stack so the managed front
 * door reuses it instead of provisioning a second one. Called from the
 * `Hosting` construct's constructor when it fronts the API.
 *
 * @param stack - The owning stack.
 * @param distribution - Hosting's CloudFront distribution.
 */
export function registerHostingDistribution(stack: cdk.Stack, distribution: Distribution): void {
	(stack as unknown as Record<symbol, Distribution>)[HOSTING_DISTRIBUTION_KEY] = distribution;
}

/**
 * The resolved public front-door URL for the stack, or `undefined` when no
 * Blocks-owned front door was provisioned (sandbox / opt-out, or a Hosting app
 * whose client resolves the origin via Hosting's own `config.json`). Read
 * lazily by the `ApiUrl` output so it reflects whatever the aspect decided at
 * synth.
 *
 * @param stack - The owning stack.
 */
export function resolvedFrontDoorUrl(stack: cdk.Stack): string | undefined {
	return (stack as unknown as Record<symbol, string | undefined>)[RESOLVED_URL_KEY];
}

/**
 * One-shot aspect that decides the front door at synth — after the whole tree
 * (including a `Hosting` construct built after `create()` returned) exists.
 *
 * - **Hosting present** → do nothing: Hosting's own distribution already fronts
 *   `/aws-blocks/api/*`, so provisioning a second distribution would be a
 *   throwaway. (Per-namespace fan-out onto Hosting's distribution arrives with
 *   multi-compute, D4.)
 * - **No Hosting, provisioning on** → create the Blocks-owned distribution with
 *   a single default behavior → the stack's API origin, publish its URL for the
 *   `ApiUrl` output, and emit a `FrontDoorUrl` output.
 * - **No Hosting, provisioning off** (sandbox / opt-out) → do nothing; the
 *   client keeps hitting the API Gateway directly.
 */
class FrontDoorAspect implements IAspect {
	private done = false;

	constructor(
		private readonly scope: Construct,
		private readonly apiUrl: string,
		private readonly provision: boolean,
	) {}

	visit(_node: IConstruct): void {
		// The tree is fully built by the time any aspect visit runs, so we only
		// need to act once — the first invocation. Everything we read (the Hosting
		// handle) is already present.
		if (this.done) return;
		this.done = true;

		const stack = cdk.Stack.of(this.scope);
		const hosting = (stack as unknown as Record<symbol, Distribution | undefined>)[HOSTING_DISTRIBUTION_KEY];
		// Hosting is the front door when present — it already proxies the API.
		if (hosting) return;
		// Sandbox / opt-out: no managed front door; client uses the gateway.
		if (!this.provision) return;

		// Scoped under the owning BlocksStack/BlocksBackend (not the raw stack) so
		// multiple BlocksBackends in one parent stack each get their own front door
		// rather than colliding on a stack-level construct id.
		const distribution = new Distribution(this.scope, FRONT_DOOR_ID, {
			comment: `Blocks API front door (${stack.stackName})`,
			defaultBehavior: { origin: httpOriginFromApiUrl(this.apiUrl), ...BEHAVIOR_OPTIONS },
		});

		const origin = `https://${distribution.distributionDomainName}`;
		// The client resolves the API from the `ApiUrl` output → config.json, so
		// point it at the front-door origin (keeping the reserved RPC path).
		(stack as unknown as Record<symbol, string>)[RESOLVED_URL_KEY] = `${origin}${BLOCKS_RPC_PREFIX}`;
		new cdk.CfnOutput(this.scope, 'FrontDoorUrl', {
			value: origin,
			description: 'Blocks API CloudFront front door URL',
		});
	}
}

/**
 * Schedule the managed CloudFront **API front door** for synth-time resolution.
 *
 * Registered from `create()` (so the decision is deferred until the whole app —
 * including any `Hosting` construct built afterward — exists) via a CDK aspect.
 * The front door is the stable public origin for the backend HTTP surface, so
 * adding/scaling compute never changes the browser hostname (auth cookies
 * persist). See {@link FrontDoorAspect} for the Hosting-present / provisioning
 * branches.
 *
 * @param stack - The owning stack.
 * @param apiUrl - The stack's API URL (the default compute's), used to build the
 *   front-door origin. A CDK token is fine — it resolves at deploy.
 * @param provision - `defaults.provisionApiFrontDoor` (on in prod, off in sandbox).
 */
export function scheduleFrontDoor(scope: Construct, apiUrl: string, provision: boolean): void {
	// Add the aspect to `scope` (the BlocksStack/BlocksBackend) so its visit runs
	// at synth and the front door is scoped under this owner — several backends
	// in one stack stay independent.
	Aspects.of(scope).add(new FrontDoorAspect(scope, apiUrl, provision));
}
