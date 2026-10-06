// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The `edge` tier: a managed CloudFront front door for API traffic.
 *
 * The stack's single shared HTTP API v2 gateway is reachable directly on its own
 * regional `execute-api` domain — that is the implicit `regional` tier, and the
 * default. The `edge` tier puts one CloudFront distribution in front of that
 * gateway so the API is served from a global, CDN-backed domain instead
 * (CloudFront → API Gateway → Lambda).
 *
 * It is a single catch-all default behavior forwarding to the shared gateway
 * origin: every API path already resolves to that one gateway, so there is no
 * per-path fan-out. Per-path routing to distinct origins becomes load-bearing
 * only once a compute-assignment surface exists to send a namespace elsewhere.
 *
 * The decision is deferred to synth rather than made in `create()`, because
 * `Hosting` is typically constructed *after* `BlocksStack.create()` resolves and
 * brings a distribution of its own — in which case the API belongs on that one
 * (same domain as the frontend, no CORS, no second hop), and this standalone
 * distribution stands down (see `claimApiFrontDoor`).
 */

import * as cdk from 'aws-cdk-lib';
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

/** Construct id of the managed distribution. */
const FRONT_DOOR_ID = 'ApiFrontDoor';

/**
 * CloudFront behavior settings for API traffic.
 *
 * No caching, and forward everything except `Host` — an API response is
 * request-specific, and the origin is API Gateway, which rejects a forwarded
 * `Host` that isn't its own domain. All methods, since RPC is `POST` and raw
 * routes can be anything. HTTPS-only via redirect rather than block: a
 * plain-HTTP GET (a raw route) is recovered — the browser follows the 301. A
 * plain-HTTP RPC `POST` is NOT recovered: the redirect re-issues it as a GET
 * with the body dropped. That path is marginal (SDK clients always use HTTPS),
 * so the redirect is kept for the GET UX rather than blocking plain-HTTP outright.
 *
 * Exported so `Hosting` can apply the same settings when it fronts the API, and
 * the two paths cannot drift.
 */
export const API_BEHAVIOR_OPTIONS = {
	allowedMethods: AllowedMethods.ALLOW_ALL,
	cachePolicy: CachePolicy.CACHING_DISABLED,
	originRequestPolicy: OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
	viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
} satisfies AddBehaviorOptions;

/**
 * The front-door signal, carried on the owner instance (`BlocksStack` /
 * `BlocksBackend`) rather than in ambient per-stack state.
 *
 * A later `Hosting` holds a direct reference to its backend (`props.api`), so it
 * records its claim on that object — and the synth-time aspect, scheduled on the
 * same object, reads it back. Because the signal travels through a live object
 * reference, it works even when `Hosting` and its backend live in **different
 * stacks** (the previous `Symbol.for` per-stack state did not: the two stacks
 * never shared it, so a cross-stack `Hosting` could not suppress the managed
 * `edge` distribution and the app got two). The fields are `@internal` and set
 * only through {@link claimApiFrontDoor} and the aspect.
 */
export interface ApiFrontDoorOwner {
	/** Set when a `Hosting` distribution has claimed the API front-door role. */
	_apiFrontDoorClaimedByHosting?: boolean;
	/** Public origin of whichever front door ended up fronting the API. */
	_apiFrontDoorResolvedUrl?: string;
}

/**
 * Build a CloudFront origin from the shared gateway's URL.
 *
 * The shared HTTP API v2 `$default` stage serves at the API root, so the URL is
 * `https://{host}/aws-blocks/api` with NO `/{stage}` segment: the origin is just
 * the host, with no `originPath` (unlike the old per-compute REST URL, whose
 * `/{stage}` prefix had to be re-added as `originPath`). The URL is a
 * CloudFormation token, so the host is sliced out in-template via `Fn::Split`
 * rather than in JS — string methods here would operate on the unresolved
 * placeholder text.
 */
export function httpOriginFromEndpoint(gatewayUrl: string): IOrigin {
	const withoutScheme = cdk.Fn.select(1, cdk.Fn.split('https://', gatewayUrl));
	const hostname = cdk.Fn.select(0, cdk.Fn.split('/', withoutScheme));
	return new HttpOrigin(hostname);
}

/**
 * Claim the API front-door role for a `Hosting` distribution.
 *
 * When the app already fronts its frontend with CloudFront, the API belongs on
 * that same distribution — same domain means no CORS and no second hop. Claiming
 * suppresses the managed `edge` distribution and makes `distributionUrl` the
 * origin clients are pointed at.
 *
 * @param owner the backend the `Hosting` was given as `props.api` (a `BlocksStack`
 *   or `BlocksBackend`) — the same object the aspect is scheduled on. Recording
 *   the claim on this instance, not its stack, is what lets a `Hosting` in a
 *   different stack than its backend still suppress that backend's front door.
 * @param distributionUrl the distribution's public origin — custom domain when one
 *   is configured, else the CloudFront default. A URL rather than the
 *   `Distribution` because that public origin is the only thing anyone reads, and
 *   it is not always derivable from the distribution.
 * @internal Framework-only; `Hosting` calls it (via `BlocksStackApi.claimApiFrontDoor`).
 */
export function claimApiFrontDoor(owner: Construct & ApiFrontDoorOwner, distributionUrl: string): void {
	owner._apiFrontDoorClaimedByHosting = true;
	owner._apiFrontDoorResolvedUrl = distributionUrl;
}

/**
 * The URL of whichever distribution ended up fronting this backend's API, or
 * `undefined` when nothing did (the `regional` tier, and no `Hosting` claim), in
 * which case callers fall back to the raw gateway URL.
 *
 * @internal
 */
export function resolvedApiFrontDoorUrl(owner: Construct & ApiFrontDoorOwner): string | undefined {
	return owner._apiFrontDoorResolvedUrl;
}

/**
 * Decide and build the API front door at synth time.
 *
 * One-shot: CDK invokes an aspect once per construct in the tree, and this has
 * to run exactly once, after the tree is complete.
 *
 * Why an aspect that *creates* a construct (rather than mutating one): the
 * distribution must be built after `Hosting` is constructed, so a Hosting
 * front-door claim can suppress it (see `claimApiFrontDoor`). Hosting
 * is usually built after `create()` returns, which is after the in-`create()`
 * `finalize*` registries have already run — too early. `Lazy` was considered but
 * only defers *value* resolution, not construct *creation*; a stack-synthesis
 * hook carries the same "add a node late" caveat this does. So we add the
 * `Distribution` from `visit()`.
 *
 * CDK-version assumption: aws-cdk-lib (pinned in this repo) permits adding a
 * construct from an aspect's `visit()`. Newer CDK may warn or throw "cannot add
 * nodes during synthesis"; if that lands, move this into an explicit
 * post-`create()` finalize step the app invokes, keeping the Hosting-claim
 * ordering. Build + e2e cover the current pin.
 */
class ApiFrontDoorAspect implements cdk.IAspect {
	private done = false;

	constructor(
		private readonly owner: Construct & ApiFrontDoorOwner,
		private readonly provision: boolean,
		private readonly gatewayUrl?: string,
	) {}

	visit(_node: IConstruct): void {
		if (this.done) return;
		this.done = true;

		const stack = cdk.Stack.of(this.owner);

		// `Hosting` fronts the API itself, and has already published its origin
		// (recorded on this same owner instance, so a cross-stack `Hosting` claim
		// is seen here too). Provisioning a second distribution would double the
		// hops and split the domain.
		if (this.owner._apiFrontDoorClaimedByHosting) return;

		// The `regional` tier: the shared gateway is reached directly, so there is no
		// CloudFront distribution to build.
		if (!this.provision) return;

		// No gateway URL means no origin, so there is nothing coherent to put behind
		// the default behavior.
		if (!this.gatewayUrl) return;

		const origin = httpOriginFromEndpoint(this.gatewayUrl);
		// Under the owner, not the stack: a `BlocksBackend` is a construct inside
		// someone else's stack, and two of them in one stack would otherwise collide
		// on this construct id.
		const distribution = new Distribution(this.owner, FRONT_DOOR_ID, {
			comment: `Blocks API front door for ${stack.stackName}`,
			// One catch-all behavior: every API path resolves to the shared gateway
			// today, so a single default behavior routes RPC, auth, and raw routes
			// alike. Per-path behaviors would only carry traffic once a namespace
			// resolves to a distinct origin.
			defaultBehavior: { origin, ...API_BEHAVIOR_OPTIONS },
		});

		// Record the resolved origin on the owner so the `ApiUrl` output (and
		// Hosting) resolve to the CloudFront URL. No separate CloudFront-domain
		// output is emitted — `ApiUrl` is the single client endpoint, and the bare
		// domain was never read by any tooling (it's `ApiUrl` minus the RPC prefix).
		this.owner._apiFrontDoorResolvedUrl = `https://${distribution.distributionDomainName}`;
	}
}

/**
 * Resolve the API front-door tier: the app's explicit choice if it made one,
 * otherwise the constant `regional` default.
 *
 * The default is a constant — never derived from app shape or preset — so adding
 * or removing Building Blocks never silently moves the API onto (or off) a
 * CloudFront distribution, which would change the endpoint domain and invalidate
 * existing cookies/sessions.
 *
 * @internal
 */
export function resolveApiFrontDoor(apiFrontDoor: 'regional' | 'edge' | undefined): 'regional' | 'edge' {
	return apiFrontDoor ?? 'regional';
}

/**
 * Schedule the API front-door decision for synth.
 *
 * Deferred rather than decided in `create()`: `Hosting` is usually constructed
 * after `create()` resolves, and if it brings a distribution the API belongs on
 * that one instead of a second managed distribution.
 *
 * @param owner the `BlocksStack` or `BlocksBackend` whose API is being fronted.
 *   Everything hangs off this rather than off its stack, because it is also the
 *   identity that routes are registered under — and a `BlocksBackend` is a
 *   construct inside a stack it does not own, possibly alongside siblings.
 * @param provision whether to build the `edge` CloudFront distribution
 * @param gatewayUrl the shared HTTP API v2 gateway URL (`https://{host}/aws-blocks/api`),
 *   the origin the distribution forwards to
 */
export function scheduleApiFrontDoor(
	owner: Construct & ApiFrontDoorOwner,
	provision: boolean,
	gatewayUrl?: string,
): void {
	cdk.Aspects.of(owner).add(new ApiFrontDoorAspect(owner, provision, gatewayUrl));
}
