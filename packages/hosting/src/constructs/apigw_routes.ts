/**
 * Shared route helpers for the two API Gateway front-door flavors
 * ({@link ApiGatewayConstruct} HTTP API v2 and {@link ApiGatewayRestConstruct}
 * REST API). The two flavors emit routes onto different CDK surfaces (HTTP
 * `addRoutes` vs the REST resource tree), so the constructs stay separate — but
 * the plan-derived path math is identical and lives here.
 */
import { Fn } from 'aws-cdk-lib';

/**
 * Convert a route-table glob pattern to an API Gateway proxy path, or `null` for
 * the catch-all (which each flavor maps to its default: HTTP `$default`, REST
 * root). `/*` / `*` → `null`; `/assets/*` → `/assets/{proxy+}`; `/about` → `/about`.
 */
export const globToProxyPath = (pattern: string): string | null => {
	if (pattern === '/*' || pattern === '*') return null;
	if (pattern.endsWith('/*')) return `${pattern.slice(0, -2)}/{proxy+}`;
	return pattern; // exact
};

/**
 * The backend base URL for a same-origin API proxy: split a namespace ingress
 * URL (`https://…/prod/aws-blocks/api`) on the `/aws-blocks/api` suffix to get
 * the base (`https://…/prod`) — token-safe, the same shape whether the ingress is
 * a Lambda API Gateway, a container ALB, or a BYOC endpoint.
 */
export const backendBaseUrl = (ingressUrl: string): string => Fn.select(0, Fn.split('/aws-blocks/api', ingressUrl));

/**
 * The default API path set for a single-compute backend when the door was not
 * handed `DoorInput.origins.api.paths`: the reserved `/aws-blocks/*` subtree
 * (RPC, and sign-in at `/aws-blocks/auth/*`).
 */
export const DEFAULT_API_PATHS: readonly string[] = ['/aws-blocks/*'];

/**
 * One backend API path as an API Gateway route: the route path, and the
 * backend URL suffix to proxy it to (`{proxy}` carries the greedy tail).
 * `/aws-blocks/*` → `/aws-blocks/{proxy+}` → `/aws-blocks/{proxy}`;
 * `/hooks/door-probe` → itself. Returns `null` for the catch-all `/*`, which
 * would swallow the whole site (the CloudFront door can't route it either).
 */
export const apiPathToRoute = (pattern: string): { path: string; target: string } | null => {
	const path = globToProxyPath(pattern);
	if (path === null) return null;
	return { path, target: path.endsWith('/{proxy+}') ? `${path.slice(0, -'{proxy+}'.length)}{proxy}` : path };
};

/** API Gateway's default per-API route/resource quota (adjustable). */
export const APIGW_DEFAULT_ROUTE_QUOTA = 300;
