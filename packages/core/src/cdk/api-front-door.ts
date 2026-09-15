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
import { getApiEndpoints } from './compute/compute-registry.js';

/**
 * CloudFront logical id of the managed front door within its stack. A stable id
 * so the distribution is reused rather than churned across deploys.
 */
const API_FRONT_DOOR_ID = 'BlocksApiFrontDoor';

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
const RESOLVED_URL_KEY = Symbol.for('BLOCKS_API_FRONT_DOOR_RESOLVED_URL');

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
 * Build a CloudFront HTTP origin from a compute's **endpoint base**
 * (`https://{id}.execute-api.{region}.amazonaws.com/{stage}` — no
 * `/aws-blocks/api` suffix, no trailing slash). See `Compute.endpoint`.
 *
 * CloudFront wants the host and the origin path separately, and the endpoint is
 * a CDK token at synth, so the split is done with CloudFormation intrinsics
 * (`Fn::Split`/`Fn::Select`) that resolve at deploy: drop the scheme, then take
 * the host and stage segments. The stage becomes the origin path.
 *
 * This is the single place the framework turns a compute endpoint into an
 * origin, so every front-door path (the Blocks-owned distribution and a reused
 * Hosting distribution) builds origins identically.
 *
 * @param endpoint - A compute's `endpoint` base (may be an unresolved CDK token).
 */
export function httpOriginFromEndpoint(endpoint: string): IOrigin {
	const withoutScheme = cdk.Fn.select(1, cdk.Fn.split('https://', endpoint));
	const hostname = cdk.Fn.select(0, cdk.Fn.split('/', withoutScheme));
	const stage = cdk.Fn.select(1, cdk.Fn.split('/', withoutScheme));
	return new HttpOrigin(hostname, { originPath: `/${stage}` });
}

/**
 * Build a CloudFront HTTP origin from a full Blocks API URL
 * (`…/{stage}/aws-blocks/api`) by stripping the reserved RPC suffix and
 * delegating to {@link httpOriginFromEndpoint}.
 *
 * Prefer `httpOriginFromEndpoint(compute.endpoint)` in new code — this overload
 * exists for callers that only hold the client-facing API URL (e.g. Hosting's
 * `api.apiUrl` prop).
 *
 * @param apiUrl - The compute/stack API URL (may be an unresolved CDK token).
 */
export function httpOriginFromApiUrl(apiUrl: string): IOrigin {
	return httpOriginFromEndpoint(cdk.Fn.select(0, cdk.Fn.split(BLOCKS_RPC_PREFIX, apiUrl)));
}

/**
 * Add one CloudFront behavior per API namespace, each routed to the endpoint of
 * the compute that hosts it — the multi-compute fan-out.
 *
 * Shared by both front-door paths so they route identically: the Blocks-owned
 * distribution (from {@link ApiFrontDoorAspect}) and a `Hosting` app's own
 * distribution. Each caller passes the distribution **it owns** — the aspect
 * never reaches into Hosting's, because the handle is stack-keyed (invisible
 * cross-stack) and mutating another stack's construct is the wrong direction of
 * coupling. Only the endpoint *values* cross a stack boundary.
 *
 * ⚠️ **Call this before adding any broader `/aws-blocks/api*` behavior.**
 * CloudFront evaluates behaviors in the order they were added (first match
 * wins), so a wildcard added earlier would swallow every namespace request and
 * the fan-out would silently do nothing — requests would still succeed, served
 * by the wrong compute, because every compute runs the same bundle.
 *
 * Namespaces that share a compute share a single `IOrigin` instance, so
 * CloudFront gets one origin per distinct endpoint rather than one per
 * namespace.
 *
 * @param distribution - The distribution the caller owns.
 * @param endpoints - namespace → compute endpoint (see `getApiEndpoints`).
 * @param sharedOrigins - Optional endpoint → origin cache, pre-seeded by the
 *   caller with origins it already created, so the same endpoint doesn't produce
 *   a second CloudFront origin. Mutated as new origins are built.
 * @returns The number of namespaces routed (0 when there is nothing to fan out).
 */
export function addNamespaceBehaviors(
	distribution: Distribution,
	endpoints: Readonly<Record<string, string>>,
	sharedOrigins?: Map<string, IOrigin>,
): number {
	// Callers can pass a map pre-seeded with origins they already built (e.g. the
	// fallback origin) so an endpoint never yields two CloudFront origin entries.
	const originFor = sharedOrigins ?? new Map<string, IOrigin>();
	let routed = 0;

	for (const [namespace, endpoint] of Object.entries(endpoints)) {
		let origin = originFor.get(endpoint);
		if (!origin) {
			origin = httpOriginFromEndpoint(endpoint);
			originFor.set(endpoint, origin);
		}
		// Both the exact path and its subtree: a namespace is addressed as
		// `/aws-blocks/api/{ns}` and RawRoutes may hang below it.
		distribution.addBehavior(`${BLOCKS_RPC_PREFIX}/${namespace}`, origin, BEHAVIOR_OPTIONS);
		distribution.addBehavior(`${BLOCKS_RPC_PREFIX}/${namespace}/*`, origin, BEHAVIOR_OPTIONS);
		routed++;
	}

	return routed;
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
export function resolvedApiFrontDoorUrl(stack: cdk.Stack): string | undefined {
	return (stack as unknown as Record<symbol, string | undefined>)[RESOLVED_URL_KEY];
}

/**
 * One-shot aspect that decides the front door at synth — after the whole tree
 * (including a `Hosting` construct built after `create()` returned) exists.
 *
 * - **Hosting present (same stack)** → do nothing: Hosting's own distribution
 *   already fronts `/aws-blocks/api/*`, so provisioning a second distribution
 *   would be a throwaway. Detection is per-stack (the handle is published on the
 *   stack), so a `Hosting` construct in a *different* stack is invisible here —
 *   those apps pass `apiFrontDoor: 'none'` so no redundant distribution is
 *   created. (Per-namespace fan-out onto Hosting's distribution arrives with
 *   multi-compute, D4.)
 * - **No Hosting, provisioning on** → create the Blocks-owned distribution with
 *   a single default behavior → the stack's API origin, publish its URL for the
 *   `ApiUrl` output, and emit a `ApiFrontDoorUrl` output.
 * - **No Hosting, provisioning off** (sandbox / opt-out) → do nothing; the
 *   client keeps hitting the API Gateway directly.
 */
class ApiFrontDoorAspect implements IAspect {
	private done = false;

	constructor(
		private readonly scope: Construct,
		private readonly apiUrl: string,
		private readonly provision: boolean,
		private readonly defaultEndpoint?: string,
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
		// Fallback origin → the default compute. Prefer the compute's own
		// `endpoint` (the identical token the namespace map carries) so a namespace
		// hosted on the default compute reuses this origin instead of creating a
		// second CloudFront origin for the same host. Fall back to deriving it from
		// the API URL when no default endpoint was supplied.
		const fallbackEndpoint =
			this.defaultEndpoint ?? cdk.Fn.select(0, cdk.Fn.split(BLOCKS_RPC_PREFIX, this.apiUrl));
		const fallbackOrigin = httpOriginFromEndpoint(fallbackEndpoint);

		const distribution = new Distribution(this.scope, API_FRONT_DOOR_ID, {
			comment: `Blocks API front door (${stack.stackName})`,
			defaultBehavior: { origin: fallbackOrigin, ...BEHAVIOR_OPTIONS },
		});

		// Fan out: one behavior per namespace → its owning compute. Read the map
		// here (not at create()) so it reflects every namespace recorded by synth.
		// The default behavior above stays as the fallback — it has the lowest
		// precedence in CloudFront, so these always win for their paths, and any
		// namespace without an endpoint still reaches the default compute.
		addNamespaceBehaviors(distribution, getApiEndpoints(this.scope), new Map([[fallbackEndpoint, fallbackOrigin]]));

		const origin = `https://${distribution.distributionDomainName}`;
		// The client resolves the API from the `ApiUrl` output → config.json, so
		// point it at the front-door origin (keeping the reserved RPC path).
		(stack as unknown as Record<symbol, string>)[RESOLVED_URL_KEY] = `${origin}${BLOCKS_RPC_PREFIX}`;
		new cdk.CfnOutput(this.scope, 'ApiFrontDoorUrl', {
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
 * persist). See {@link ApiFrontDoorAspect} for the Hosting-present / provisioning
 * branches.
 *
 * @param stack - The owning stack.
 * @param apiUrl - The stack's API URL (the default compute's), used to build the
 *   front-door origin. A CDK token is fine — it resolves at deploy.
 * @param provision - `defaults.provisionApiFrontDoor` (on in prod, off in sandbox).
 * @param defaultEndpoint - The default compute's `endpoint`, used for the
 *   fallback behavior. Passing the compute's own value (rather than deriving it
 *   from `apiUrl`) lets a namespace hosted on the default compute reuse that
 *   origin instead of adding a duplicate one. Optional; derived from `apiUrl`
 *   when omitted.
 */
export function scheduleApiFrontDoor(
	scope: Construct,
	apiUrl: string,
	provision: boolean,
	defaultEndpoint?: string,
): void {
	// Add the aspect to `scope` (the BlocksStack/BlocksBackend) so its visit runs
	// at synth and the front door is scoped under this owner — several backends
	// in one stack stay independent.
	Aspects.of(scope).add(new ApiFrontDoorAspect(scope, apiUrl, provision, defaultEndpoint));
}
