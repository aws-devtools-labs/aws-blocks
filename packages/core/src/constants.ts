// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Reserved namespace for AWS-managed framework features.
 * No user routes can be registered under this path.
 */
export const BLOCKS_NAMESPACE = '/aws-blocks';

/**
 * URL path prefix for the Blocks RPC endpoint.
 *
 * CloudFront behaviors route this path (and children) to the API Gateway
 * origin. Namespaced under `/aws-blocks/api` so it doesn't shadow
 * framework-conventional `/api/*` SSR routes (Next.js `pages/api/*`,
 * `app/api/*`, Nuxt `server/api/*`) on CloudFront's first-match-wins
 * behavior resolution.
 */
export const BLOCKS_RPC_PREFIX = '/aws-blocks/api';

/**
 * Whether a request path targets the RPC endpoint or any namespace under it.
 *
 * True for {@link BLOCKS_RPC_PREFIX} itself (the back-compat body-addressed
 * endpoint) and for every per-namespace path beneath it
 * (`/aws-blocks/api/{namespace}`). The whole subtree is RPC: dispatch takes the
 * namespace from the JSON-RPC body, and a per-namespace path must name the same
 * one (see `parseRpcRequest`), so a caller matching against it must treat the
 * prefix and its descendants identically — e.g. the handler skips RawRoute
 * matching for the entire subtree.
 *
 * @param pathname - The request path, without query string.
 */
export function isRpcPath(pathname: string): boolean {
	return pathname === BLOCKS_RPC_PREFIX || pathname.startsWith(`${BLOCKS_RPC_PREFIX}/`);
}

/**
 * Extract the API namespace from a per-namespace RPC path, or `undefined` for
 * the bare {@link BLOCKS_RPC_PREFIX} endpoint.
 *
 * The typed client POSTs to `/aws-blocks/api/{namespace}` so a gateway can route
 * each namespace to the compute that hosts it; this reads that `{namespace}`
 * segment back out on the server, where it is checked against the body's
 * `namespace.method` prefix. Only the first segment after the prefix is the
 * namespace; `parseRpcRequest` rejects a path that goes any deeper. Returns `undefined` for the bare
 * `/aws-blocks/api` path (and a trailing-slash-only variant), where the body's
 * prefix alone names the namespace.
 *
 * The segment is percent-decoded defensively (matching RawRoute param handling),
 * falling back to the raw value on malformed encoding.
 *
 * @param pathname - The request path, without query string.
 */
export function rpcNamespaceFromPath(pathname: string): string | undefined {
	if (!pathname.startsWith(`${BLOCKS_RPC_PREFIX}/`)) return undefined;
	const segment = pathname.slice(BLOCKS_RPC_PREFIX.length + 1).split('/')[0];
	if (!segment) return undefined;
	try {
		return decodeURIComponent(segment);
	} catch {
		return segment;
	}
}

/**
 * Reserved subtree for the auth Building Block's HTTP routes.
 *
 * Like {@link BLOCKS_RPC_PREFIX}, this lives under the reserved `/aws-blocks`
 * namespace so Hosting can proxy the whole auth flow (callback, sign-in,
 * exchange, authorize-params, the stub IdP, …) to the API Gateway origin with a
 * single CloudFront behavior — and so it never collides with a customer's own
 * `/auth/*` frontend routes. The auth BB mounts every route it owns under this
 * prefix; CloudFront forwards the subtree and the Lambda dispatches by path.
 */
export const BLOCKS_AUTH_PREFIX = '/aws-blocks/auth';

/**
 * Reserved path for the client runtime config (`config.json`).
 *
 * In production CloudFront serves `${BLOCKS_SANDBOX_PREFIX}/*` from S3 as
 * static assets (see hosting.ts) so the browser client can resolve its API
 * URL. The local dev server mirrors this by serving the config from the front
 * door itself, instead of proxying the request to the framework dev server —
 * which only serves its own static dir (Next.js `public/`, etc.) and would 404
 * on a project-root file. Keeping this symmetric with production is what makes
 * the browser client work the same in `dev`, `sandbox`, and deployed.
 */
export const BLOCKS_SANDBOX_PREFIX = '/.blocks-sandbox';

/**
 * Header name carrying the native-client token on the RPC hop. A custom header,
 * not `User-Agent`, because browsers forbid scripts from setting `User-Agent`;
 * also non-safelisted, so the CORS preflight must name it.
 *
 * @internal Read by the Lambda handler and both CORS preflight responders; not public API.
 */
export const CLIENT_USER_AGENT_HEADER = 'x-blocks-user-agent';

/**
 * The public host a request to a container compute was made to. The container
 * builds `ctx.request.url` from it, since the request it receives carries the
 * load balancer's host.
 *
 * Set by every front door, overwriting any client-sent value — which is what
 * makes it trustworthy (the load balancer is internal, reachable only through
 * them): the shared gateway's integration maps it from `context.domainName`, and
 * a CloudFront behavior that routes straight to the load balancer sets it from
 * the viewer's host in a viewer-request function. The container server accepts
 * it only as a single host value, so a client copy sent under another letter
 * case is refused rather than merged in.
 *
 * @internal Read by the container HTTP server, written by the front doors; not public API.
 */
export const FORWARDED_HOST_HEADER = 'x-blocks-forwarded-host';

/**
 * Companion to {@link FORWARDED_HOST_HEADER}: the API Gateway stage that prefixes
 * public paths (`context.stage`). Set by the gateway, removed by a CloudFront
 * behavior that routes straight to the load balancer (CloudFront serves the API
 * from the origin root); either way any client-sent value is overwritten.
 *
 * @internal Read by the container HTTP server, written by the front doors; not public API.
 */
export const FORWARDED_STAGE_HEADER = 'x-blocks-forwarded-stage';

/**
 * Container port a container compute's HTTP server listens on: the backend's API
 * when the compute serves API traffic, a health check otherwise.
 *
 * @internal Shared by the container runtime and the container compute's CDK; not public API.
 */
export const CONTAINER_HTTP_PORT = 8080;

/**
 * Container port the API server reports readiness on — the load balancer's health
 * check — when the compute serves API traffic.
 *
 * @internal Shared by the container runtime and the container compute's CDK; not public API.
 */
export const CONTAINER_READINESS_PORT = 8081;

/**
 * Environment variable a container compute that serves API traffic sets (to
 * `true`) on its tasks. The image entry serves the backend's API only then; a
 * container that only runs jobs keeps a plain health check.
 *
 * @internal Shared by the container compute's CDK and its image entry; not public API.
 */
export const CONTAINER_SERVES_API_ENV = 'BLOCKS_CONTAINER_SERVES_API';
