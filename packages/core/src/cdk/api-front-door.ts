// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The `cloudfront` tier: a Blocks-managed CloudFront distribution in front of the
 * API.
 *
 * By default (`apigateway`) clients call the stack's shared API Gateway REST API
 * on its own `execute-api` endpoint. The `cloudfront` tier puts one CloudFront
 * distribution in front of that gateway, which is then built as a `REGIONAL`
 * endpoint so traffic doesn't pass through two CloudFront layers
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
	ResponseHeadersPolicy,
	ViewerProtocolPolicy,
} from 'aws-cdk-lib/aws-cloudfront';
import type { Stage } from 'aws-cdk-lib/aws-apigateway';
import { HttpOrigin } from 'aws-cdk-lib/aws-cloudfront-origins';
import type { Construct, IConstruct } from 'constructs';
import type { ApiFrontDoorTier } from '../common/index.js';
import { BLOCKS_RPC_PREFIX } from '../constants.js';
import {
	attachApiWafToStage,
	type ResolvedApiWaf,
	warnApiWafDeferredToHosting,
	webAclArnForDistribution,
} from './api-waf.js';
import { registerConfig } from './config-registry.js';

/** Construct id of the managed distribution. */
const FRONT_DOOR_ID = 'ApiFrontDoor';

/** Every valid `apiFrontDoor` value. */
const API_FRONT_DOOR_TIERS: readonly ApiFrontDoorTier[] = ['apigateway', 'cloudfront'];

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
 * same object, reads it back. Keying the signal on the backend instance (not on
 * its stack) keeps two backends in one stack independent. The fields are
 * `@internal` and set only through {@link claimApiFrontDoor} and the aspect.
 */
export interface ApiFrontDoorOwner {
	/** Set when a `Hosting` distribution has claimed the API front-door role. */
	_apiFrontDoorClaimedByHosting?: boolean;
	/** Public origin of whichever front door ended up fronting the API. */
	_apiFrontDoorResolvedUrl?: string;
	/** Set when `Hosting` published the browser-facing origin (`BLOCKS_PUBLIC_ORIGIN`). */
	_publicOriginPublishedByHosting?: boolean;
	/**
	 * The resolved `apiFrontDoor` tier, recorded at construction — before the
	 * backend module is imported — so a read from inside that module sees it.
	 */
	_apiFrontDoorTier?: ApiFrontDoorTier;
	/** The validated `apiWaf` setting, recorded at construction; `undefined` when WAF is off. */
	_apiWaf?: ResolvedApiWaf;
}

/**
 * Build a CloudFront origin from the shared gateway's RPC URL.
 *
 * The shared REST API's URL is `https://{host}/{stage}/aws-blocks/api`. The
 * origin is the host, with the `/{stage}` segment set as its `originPath` so a
 * viewer request for `/aws-blocks/api` reaches `/{stage}/aws-blocks/api` on the
 * gateway. The URL is a CloudFormation token, so host and stage are sliced out
 * in-template via `Fn::Split` rather than in JS — string methods here would
 * operate on the unresolved placeholder text.
 */
export function httpOriginFromEndpoint(gatewayUrl: string): IOrigin {
	const baseUrl = cdk.Fn.select(0, cdk.Fn.split(BLOCKS_RPC_PREFIX, gatewayUrl));
	const withoutScheme = cdk.Fn.select(1, cdk.Fn.split('https://', baseUrl));
	const hostname = cdk.Fn.select(0, cdk.Fn.split('/', withoutScheme));
	const stage = cdk.Fn.select(1, cdk.Fn.split('/', withoutScheme));
	return new HttpOrigin(hostname, { originPath: `/${stage}` });
}

/**
 * Claim the API front-door role for a `Hosting` distribution.
 *
 * When the app already fronts its frontend with CloudFront, the API belongs on
 * that same distribution — same domain means no CORS and no second hop. Claiming
 * suppresses the managed `cloudfront` distribution and makes `distributionUrl`
 * the origin clients are pointed at.
 *
 * @param owner the backend the `Hosting` was given as `props.api` (a `BlocksStack`
 *   or `BlocksBackend`) — the same object the aspect is scheduled on.
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
 * Record that `Hosting` published the origin browsers reach `/aws-blocks/*` at
 * (`BLOCKS_PUBLIC_ORIGIN`): its same-origin door. A managed `cloudfront`
 * distribution built anyway — for native clients, when the door doesn't claim
 * the API front-door role (an `http://` door) — then leaves that origin alone,
 * so the OIDC callback and the session cookie stay on the door the browser uses.
 *
 * @param owner the `BlocksStack` or `BlocksBackend` whose API the door serves.
 * @internal Framework-only; `Hosting` calls it (via `BlocksStackApi.publishPublicOrigin`).
 */
export function publishPublicOrigin(owner: Construct & ApiFrontDoorOwner): void {
	owner._publicOriginPublishedByHosting = true;
}

/**
 * The URL of whichever distribution ended up fronting this backend's API, or
 * `undefined` when nothing did (the `apigateway` tier, and no `Hosting` claim), in
 * which case callers fall back to the raw gateway URL.
 *
 * @internal
 */
export function resolvedApiFrontDoorUrl(owner: Construct & ApiFrontDoorOwner): string | undefined {
	return owner._apiFrontDoorResolvedUrl;
}

/**
 * The URL clients should send RPC calls to: under `cloudfront`, the URL of the
 * distribution fronting the API (the managed one, or a `Hosting` distribution that
 * claimed the role) + the RPC prefix; otherwise `apiUrl` itself.
 *
 * A `Lazy` because the answer is only settled at synth: the front-door aspect runs
 * after `create()` (and after any `Hosting`) and before tokens resolve. The tier is
 * read when the token resolves too, not when the getter is called, so the value is
 * the same wherever it is read — including inside the backend module, before
 * `create()` has built the gateway. Under `apigateway` a `Hosting` claim does not
 * move it, so adding Hosting never changes the domain a client is bound to.
 *
 * @internal Backs `BlocksStack.publicApiUrl` / `BlocksBackend.publicApiUrl`.
 */
export function publicApiUrl(owner: Construct & ApiFrontDoorOwner, apiUrl: () => string): string {
	return cdk.Lazy.string({
		produce: () => {
			const cloudfront = resolveApiFrontDoor(owner._apiFrontDoorTier) === 'cloudfront';
			const frontDoorUrl = cloudfront ? resolvedApiFrontDoorUrl(owner) : undefined;
			return frontDoorUrl ? `${frontDoorUrl}${BLOCKS_RPC_PREFIX}` : apiUrl();
		},
	});
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
		private readonly gatewayStage?: Stage,
	) {}

	visit(_node: IConstruct): void {
		if (this.done) return;
		this.done = true;

		const stack = cdk.Stack.of(this.owner);

		const waf = this.owner._apiWaf;

		// `Hosting` fronts the API itself, and has already published its origin
		// (recorded on this same owner instance). Provisioning a second distribution
		// would double the hops and split the domain. The API's WAF then belongs on
		// Hosting's front door too.
		if (this.owner._apiFrontDoorClaimedByHosting) {
			if (waf) warnApiWafDeferredToHosting(this.owner);
			return;
		}

		// The `apigateway` tier: clients call the gateway directly, so there is no
		// CloudFront distribution to build; a WAF attaches to the gateway stage.
		if (!this.provision) {
			if (waf && this.gatewayStage) attachApiWafToStage(this.owner, this.gatewayStage, waf);
			return;
		}

		// No gateway URL means no origin, so there is nothing coherent to put behind
		// the default behavior.
		if (!this.gatewayUrl) return;

		const origin = httpOriginFromEndpoint(this.gatewayUrl);
		// Security headers for the API responses. Use the AWS-managed
		// `SECURITY_HEADERS` policy (HSTS, X-Content-Type-Options, X-Frame-Options,
		// X-XSS-Protection, Referrer-Policy): without it the API responses reach the
		// viewer with no security headers. The managed policy consumes no account
		// quota, so a cloudfront-tier app never fails a deploy against the 20-per-
		// account ResponseHeadersPolicy limit, and it matches what the Hosting-
		// fronted path ships by default. No CSP — the API subtree serves JSON and
		// redirects, not documents, so a document CSP would add nothing here.
		const securityHeadersPolicy = ResponseHeadersPolicy.SECURITY_HEADERS;
		// Under the owner, not the stack: a `BlocksBackend` is a construct inside
		// someone else's stack, and two of them in one stack would otherwise collide
		// on this construct id.
		const distribution = new Distribution(this.owner, FRONT_DOOR_ID, {
			comment: `Blocks API front door for ${stack.stackName}`,
			// One catch-all behavior: every API path resolves to the shared gateway
			// today, so a single default behavior routes RPC, auth, and raw routes
			// alike. Per-path behaviors would only carry traffic once a namespace
			// resolves to a distinct origin.
			defaultBehavior: { origin, ...API_BEHAVIOR_OPTIONS, responseHeadersPolicy: securityHeadersPolicy },
			// The `cloudfront` tier's WAF sits on the distribution, where it sees the
			// real client IP (a REGIONAL ACL behind CloudFront would rate-limit per
			// edge location instead).
			webAclId: waf ? webAclArnForDistribution(this.owner, waf) : undefined,
		});

		// Record the resolved origin on the owner so `publicApiUrl` (and the `ApiUrl`
		// output) resolve to the CloudFront URL. No separate CloudFront-domain
		// output is emitted — `ApiUrl` is the single client endpoint.
		const frontDoorUrl = `https://${distribution.distributionDomainName}`;
		this.owner._apiFrontDoorResolvedUrl = frontDoorUrl;

		// CloudFront forwards with `ALL_VIEWER_EXCEPT_HOST_HEADER`, so the Lambda
		// sees the execute-api host, never the public one. Publish the public origin
		// the same way `Hosting` does, so absolute URLs the runtime builds (e.g.
		// AuthOIDC's callback `redirect_uri`) point at this distribution and its
		// cookies. Registered at synth, before the config JSON (a Lazy) resolves.
		// A `Hosting` door that serves `/aws-blocks/*` to browsers owns the origin
		// (see `publishPublicOrigin`); this distribution then serves native clients only.
		if (!this.owner._publicOriginPublishedByHosting) {
			registerConfig(this.owner, 'BLOCKS_PUBLIC_ORIGIN', frontDoorUrl);
		}
	}
}

/**
 * Resolve the API front-door tier: the app's explicit choice if it made one,
 * otherwise the constant `apigateway` default.
 *
 * The default is a constant — never derived from app shape or preset — so adding
 * or removing Building Blocks never silently moves the API onto (or off) a
 * CloudFront distribution, which would change the endpoint domain and invalidate
 * existing cookies/sessions.
 *
 * Any other value throws rather than falling back to the default: TypeScript
 * rejects it, but plain-JS apps and loosely typed callers (e.g. the Amplify
 * template's `backend: any`) would otherwise silently lose the CloudFront tier.
 *
 * @internal
 */
export function resolveApiFrontDoor(apiFrontDoor: ApiFrontDoorTier | undefined): ApiFrontDoorTier {
	if (apiFrontDoor === undefined) return 'apigateway';
	if (!API_FRONT_DOOR_TIERS.includes(apiFrontDoor)) {
		throw new Error(`apiFrontDoor must be 'apigateway' or 'cloudfront' (got ${JSON.stringify(apiFrontDoor)}).`);
	}
	return apiFrontDoor;
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
 * @param provision whether to build the `cloudfront` tier's distribution
 * @param gatewayUrl the shared REST API gateway URL (`https://{host}/{stage}/aws-blocks/api`),
 *   the origin the distribution forwards to
 * @param gatewayStage the shared REST API's stage, where the `apigateway` tier's
 *   WAF attaches (see `apiWaf`)
 */
export function scheduleApiFrontDoor(
	owner: Construct & ApiFrontDoorOwner,
	provision: boolean,
	gatewayUrl?: string,
	gatewayStage?: Stage,
): void {
	cdk.Aspects.of(owner).add(new ApiFrontDoorAspect(owner, provision, gatewayUrl, gatewayStage));
}
