// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The managed CloudFront front door for API traffic.
 *
 * The front door presents the API on a single stable domain and forwards every
 * request to the default compute's API Gateway origin. The single stable domain
 * is the point: browser auth cookies are origin-bound, so the origin a client
 * talks to must stay put as the backend evolves.
 *
 * Today every API path resolves to the default compute, so one catch-all default
 * behavior is all the routing the front door needs. Per-path fan-out to distinct
 * computes is deliberately not built here yet — it becomes load-bearing only once
 * a compute-assignment surface exists to send a namespace to a non-default origin.
 *
 * The decision is deferred to synth rather than made in `create()`, because
 * `Hosting` is typically constructed *after* `BlocksStack.create()` resolves and
 * brings a distribution of its own — in which case the API belongs on that one.
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
import { BLOCKS_AUTH_PREFIX, BLOCKS_RPC_PREFIX, isAuthPath, isRpcPath } from '../constants.js';
import { getRegisteredRoutes, type RegisteredRoute } from '../raw-route.js';

/** Construct id of the managed distribution. */
const FRONT_DOOR_ID = 'ApiFrontDoor';

/** CloudFormation output name carrying the managed front door's URL. */
const FRONT_DOOR_OUTPUT_ID = 'ApiFrontDoorUrl';

/**
 * CloudFront behavior settings for API traffic.
 *
 * No caching, and forward everything except `Host` — an API response is
 * request-specific, and the origin is API Gateway, which rejects a forwarded
 * `Host` that isn't its own domain. All methods, since RPC is `POST` and raw
 * routes can be anything. HTTPS-only, redirecting rather than blocking so a
 * plain-HTTP client recovers instead of failing.
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
 * Per-stack front-door state, attached to the stack construct under a global
 * symbol.
 *
 * On the stack rather than in a module-level map because a dependency tree can
 * carry more than one physical copy of `@aws-blocks/core` — `hosting` registers
 * its distribution through whichever copy it resolved, and the stack must read
 * it through whichever copy it resolved. `Symbol.for` shares the key across
 * copies; hanging the value off the construct keeps it inherently per-stack.
 */
const STATE_KEY = Symbol.for('AWS_BLOCKS_API_FRONT_DOOR');

interface ApiFrontDoorState {
	/** Whether a `Hosting` distribution has claimed the API front-door role. */
	claimedByHosting?: boolean;
	/** Public origin of whichever front door ended up fronting the API. */
	resolvedUrl?: string;
}

function stateOf(stack: cdk.Stack): ApiFrontDoorState {
	const holder = stack as cdk.Stack & { [STATE_KEY]?: ApiFrontDoorState };
	if (!holder[STATE_KEY]) holder[STATE_KEY] = {};
	return holder[STATE_KEY];
}

/**
 * Build a CloudFront origin from a compute's `endpoint`.
 *
 * `endpoint` is `https://{host}/{stage}`, and CloudFront wants those two parts
 * separately: the domain on the origin, the stage as `originPath` so it is
 * prefixed onto every forwarded request. It is a CloudFormation token, so the
 * split has to happen in the template via `Fn::Split` rather than in JS — string
 * methods here would operate on the unresolved placeholder text.
 */
export function httpOriginFromEndpoint(endpoint: string): IOrigin {
	const withoutScheme = cdk.Fn.select(1, cdk.Fn.split('https://', endpoint));
	const hostname = cdk.Fn.select(0, cdk.Fn.split('/', withoutScheme));
	const stage = cdk.Fn.select(1, cdk.Fn.split('/', withoutScheme));
	return new HttpOrigin(hostname, { originPath: `/${stage}` });
}

/**
 * Add the CloudFront behaviors that route API traffic, from the shared route
 * registry — the multi-compute fan-out.
 *
 * Both front-door paths call this so they route identically from one table: the
 * Blocks-owned distribution ({@link ApiFrontDoorAspect}) and a `Hosting` app's own
 * distribution. Each passes the distribution **it owns**; only endpoint *values*
 * cross a stack boundary.
 *
 * Each route (an `ApiNamespace`'s routing entry, or a `RawRoute`) carries the
 * `endpoint` of the compute that serves it. A path whose endpoint differs from
 * `defaultEndpoint` gets its own behavior to that compute's origin; that is the
 * fan-out. Behaviors are added in registry order and the reserved-prefix
 * fallbacks (mode `'shared-frontend'`) are added **last**, so a specific
 * `/aws-blocks/api/{ns}` behavior wins over the `/aws-blocks/api/*` catch-all
 * (CloudFront is first-match-wins by insertion order).
 *
 * Two modes differ only in what the distribution's *default* behavior already
 * covers:
 * - `'api-front-door'`: the default behavior points at the default compute, so a
 *   path served by the default compute needs no behavior — only genuine fan-out
 *   (endpoint ≠ default) is emitted.
 * - `'shared-frontend'`: the default behavior serves the frontend, so every API
 *   path must be diverted — the reserved RPC/auth subtrees and every RawRoute get
 *   a behavior (to the default compute unless assigned elsewhere).
 *
 * Namespaces/endpoints that share a compute share one `IOrigin`, so CloudFront
 * gets one origin per distinct endpoint rather than one per path.
 *
 * @param distribution - The distribution the caller owns.
 * @param routes - The registry snapshot (`getRegisteredRoutes()`).
 * @param defaultEndpoint - The default compute's origin base — the fallback.
 * @param mode - See above.
 * @param sharedOrigins - Optional endpoint → origin cache, pre-seeded by the
 *   caller with origins it already built (e.g. the default origin), so an
 *   endpoint never yields two CloudFront origins. Mutated as new origins are built.
 */
export function addRouteBehaviors(
	distribution: Distribution,
	routes: readonly RegisteredRoute[],
	defaultEndpoint: string,
	mode: 'api-front-door' | 'shared-frontend',
	sharedOrigins?: Map<string, IOrigin>,
): void {
	const coverBaseline = mode === 'shared-frontend';
	const originFor = sharedOrigins ?? new Map<string, IOrigin>();
	const added = new Set<string>();

	const addBehavior = (pattern: string, endpoint: string): void => {
		if (added.has(pattern)) return;
		added.add(pattern);
		let origin = originFor.get(endpoint);
		if (!origin) {
			origin = httpOriginFromEndpoint(endpoint);
			originFor.set(endpoint, origin);
		}
		distribution.addBehavior(pattern, origin, API_BEHAVIOR_OPTIONS);
	};

	for (const route of routes) {
		const endpoint = route.endpoint ?? defaultEndpoint;

		// Routing-only namespace entry (`/aws-blocks/api/{ns}` + subtree). Emitted
		// only for genuine fan-out — a default-compute namespace is already covered
		// by the default behavior (`api-front-door`) or the RPC catch-all (`shared-frontend`).
		if (route.subtree) {
			if (endpoint === defaultEndpoint) continue;
			addBehavior(route.path, endpoint);
			addBehavior(`${route.path}/*`, endpoint);
			continue;
		}

		// Other routing-only entries never shape behaviors directly.
		if (route.handler === undefined) continue;

		// Reserved subtrees are handled by the RPC namespace entries (api) and the
		// auth fallback below — never as individual RawRoute behaviors.
		if (isRpcPath(route.path)) continue;
		if (isAuthPath(route.path)) continue;

		// A default-compute RawRoute needs a behavior only on a shared frontend
		// distribution (to divert it off the frontend origin); the API-only
		// distribution's default behavior already serves it.
		if (!coverBaseline && endpoint === defaultEndpoint) continue;

		// A path parameter can only be expressed to CloudFront as a prefix
		// wildcard, which matches more than the route does — warn when it could
		// shadow frontend/SSR paths under the same prefix on a shared distribution.
		const paramIndex = route.path.indexOf('/{');
		const pattern = paramIndex === -1 ? route.path : `${route.path.substring(0, paramIndex)}/*`;
		if (coverBaseline && pattern.endsWith('/*') && !added.has(pattern)) {
			// A synth-time diagnostic, not a runtime log: use CDK Annotations so it
			// surfaces in `cdk synth`/`diff` structured output (and can be promoted to
			// a blocking error with `--strict`), rather than a `console.warn` that CI
			// swallows. Attached to the distribution so the message points at a node.
			cdk.Annotations.of(distribution).addWarning(
				`RawRoute '${route.path}' creates CloudFront behavior '${pattern}' ` +
					'which may shadow SSR/frontend routes under the same prefix. ' +
					`Consider placing this route under ${BLOCKS_RPC_PREFIX}/ to avoid conflicts.`,
			);
		}
		addBehavior(pattern, endpoint);
	}

	// Reserved subtrees → default compute, added last so per-namespace behaviors
	// win first-match. The RPC wildcard catches the bare endpoint and any unrouted
	// namespace; the auth wildcard proxies the whole auth flow with one behavior.
	if (coverBaseline) {
		addBehavior(BLOCKS_RPC_PREFIX, defaultEndpoint);
		addBehavior(`${BLOCKS_RPC_PREFIX}/*`, defaultEndpoint);
		addBehavior(`${BLOCKS_AUTH_PREFIX}/*`, defaultEndpoint);
	}
}

/**
 * Claim the API front-door role for a `Hosting` distribution.
 *
 * When the app already fronts its frontend with CloudFront, the API belongs on
 * that same distribution — same domain means no CORS and no second hop. Claiming
 * suppresses the managed distribution for the stack and makes `distributionUrl`
 * the origin clients are pointed at.
 *
 * @param distributionUrl the distribution's public origin — custom domain when one
 *   is configured, else the CloudFront default. A URL rather than the
 *   `Distribution` because that public origin is the only thing anyone reads, and
 *   it is not always derivable from the distribution.
 * @internal Framework-only; `Hosting` calls it.
 */
export function registerHostingDistribution(stack: cdk.Stack, distributionUrl: string): void {
	const state = stateOf(stack);
	state.claimedByHosting = true;
	state.resolvedUrl = distributionUrl;
}

/**
 * The URL of whichever distribution ended up fronting this stack's API, or
 * `undefined` when nothing did (no front door was provisioned and none was
 * claimed), in which case callers fall back to the default compute's endpoint.
 *
 * @internal
 */
export function resolvedApiFrontDoorUrl(stack: cdk.Stack): string | undefined {
	return stateOf(stack).resolvedUrl;
}

/**
 * Decide and build the API front door at synth time.
 *
 * One-shot: CDK invokes an aspect once per construct in the tree, and this has
 * to run exactly once, after the tree is complete.
 */
class ApiFrontDoorAspect implements cdk.IAspect {
	private done = false;

	constructor(
		private readonly owner: Construct,
		private readonly provision: boolean,
		private readonly defaultEndpoint?: string,
	) {}

	visit(_node: IConstruct): void {
		if (this.done) return;
		this.done = true;

		const stack = cdk.Stack.of(this.owner);
		const state = stateOf(stack);

		// `Hosting` fronts the API itself, and has already published its origin.
		// Provisioning a second distribution would double the hops and split the domain.
		if (state.claimedByHosting) return;

		// Opted out, or the sandbox posture — a sandbox reaches API Gateway directly,
		// so a CloudFront distribution would only add propagation delay to the
		// deploy/test loop.
		if (!this.provision) return;

		// No default compute endpoint means no fallback origin, so there is nothing
		// coherent to put behind the default behavior.
		if (!this.defaultEndpoint) return;

		const origin = httpOriginFromEndpoint(this.defaultEndpoint);
		// Under the owner, not the stack: a `BlocksBackend` is a construct inside
		// someone else's stack, and two of them in one stack would otherwise collide
		// on this construct id.
		const distribution = new Distribution(this.owner, FRONT_DOOR_ID, {
			comment: `Blocks API front door for ${stack.stackName}`,
			// The default (lowest-precedence) behavior forwards to the default compute
			// and catches every unrouted path — RPC on the default compute, auth, and
			// raw routes alike. Per-namespace fan-out behaviors added below take
			// precedence for their own paths.
			defaultBehavior: { origin, ...API_BEHAVIOR_OPTIONS },
		});

		// Fan out: a namespace or RawRoute assigned to a non-default compute gets a
		// behavior to that compute's origin. Read the registry here (not at
		// `create()`) so it reflects every route recorded during synth. Seed the
		// origin cache with the default endpoint → its origin so a path back on the
		// default compute reuses it. With no assignments (today) nothing extra is
		// emitted — the default behavior covers everything.
		addRouteBehaviors(
			distribution,
			getRegisteredRoutes(),
			this.defaultEndpoint,
			'api-front-door',
			new Map([[this.defaultEndpoint, origin]]),
		);

		state.resolvedUrl = `https://${distribution.distributionDomainName}`;
		new cdk.CfnOutput(this.owner, FRONT_DOOR_OUTPUT_ID, {
			value: state.resolvedUrl,
			description: 'CloudFront domain fronting the Blocks API',
		});
	}
}

/**
 * Resolve whether to provision a managed front door: the app's explicit choice
 * if it made one, otherwise the stack posture's default.
 *
 * @internal
 */
export function resolveApiFrontDoor(
	override: 'cloudfront' | 'none' | undefined,
	defaults: { provisionApiFrontDoor: boolean },
): boolean {
	if (override) return override === 'cloudfront';
	return defaults.provisionApiFrontDoor;
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
 * @param provision whether the stack's posture wants a managed distribution
 * @param defaultEndpoint the default compute's origin base — the fallback origin
 */
export function scheduleApiFrontDoor(owner: Construct, provision: boolean, defaultEndpoint?: string): void {
	cdk.Aspects.of(owner).add(new ApiFrontDoorAspect(owner, provision, defaultEndpoint));
}
