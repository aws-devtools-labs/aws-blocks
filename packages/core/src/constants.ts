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
 * Header the shared API gateway stamps with its public host (`context.domainName`)
 * on every request it forwards to a container compute. The container builds
 * `ctx.request.url` from it.
 *
 * Trusted only because every front door controls it: the gateway's integration
 * mapping overwrites any client-sent value, and a CloudFront behavior that routes
 * straight to the container's (internal) load balancer must strip it — together
 * with {@link FORWARDED_STAGE_HEADER} — from viewer requests with an origin request
 * policy deny list.
 *
 * @internal Read by the container HTTP server, written by the shared gateway; not public API.
 */
export const FORWARDED_HOST_HEADER = 'x-blocks-forwarded-host';

/**
 * Companion to {@link FORWARDED_HOST_HEADER}: the API Gateway stage that prefixes
 * public paths (`context.stage`). Same trust requirements: overwritten by the
 * gateway, stripped by any CloudFront behavior that reaches the container directly.
 *
 * @internal Read by the container HTTP server, written by the shared gateway; not public API.
 */
export const FORWARDED_STAGE_HEADER = 'x-blocks-forwarded-stage';
