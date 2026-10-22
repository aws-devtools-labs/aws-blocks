/**
 * Shared route helpers for the two API Gateway front-door flavors
 * ({@link ApiGatewayConstruct} HTTP API v2 and {@link ApiGatewayRestConstruct}
 * REST API). The two flavors emit routes onto different CDK surfaces (HTTP
 * `addRoutes` vs the REST resource tree), so the constructs stay separate — but
 * the plan-derived path math is identical and lives here.
 */
import { Annotations, Fn } from 'aws-cdk-lib';
import type { IConstruct } from 'constructs';
import { HostingError } from '../hosting_error.js';

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
 * Warn at synth (`@aws-blocks/hosting:CatchAllApiPathNotRouted`) when the
 * backend's raw routes include the catch-all `/*` (e.g.
 * `RawRoute('/{proxy+}')`): routing it to the API would send every page and
 * asset there, so the regional doors leave it out and the site keeps its own
 * routes. Every regional door applies the same rule.
 *
 * @param patterns the backend path patterns the door received.
 * @returns the patterns the door routes (without the catch-all).
 * @internal Framework-only.
 */
export const routableApiPaths = (scope: IConstruct, door: string, patterns: Iterable<string>): string[] => {
	const all = [...new Set(patterns)];
	const routable = all.filter((p) => globToProxyPath(p) !== null);
	if (routable.length < all.length) {
		Annotations.of(scope).addWarningV2(
			'@aws-blocks/hosting:CatchAllApiPathNotRouted',
			`The ${door} front door does not route the backend's catch-all raw route ('/*'): it would send every page ` +
				'and asset to the API. Register the raw routes under a path prefix (`/hooks/*`).',
		);
	}
	return routable;
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

/** Whether a route-table pattern has a wildcard API Gateway can't express (anything but one trailing `/*`). */
export const hasInnerWildcard = (pattern: string): boolean => {
	const body = pattern.endsWith('/*') ? pattern.slice(0, -2) : pattern;
	return body.includes('*');
};

/**
 * One backend API path as API Gateway routes: each route path, and the
 * backend URL suffix to proxy it to (`{proxy}` carries the greedy tail).
 * `/hooks/*` → `/hooks/{proxy+}` → `/hooks/{proxy}`, plus `/hooks` itself —
 * `{proxy+}` needs at least one character, and `/hooks/` matches `/hooks/*` on
 * the CloudFront and ALB doors; `/hooks/door-probe` → itself. Returns `[]` for
 * the catch-all `/*`, which would swallow the whole site (the CloudFront door
 * can't route it either).
 *
 * @param door the door's name, for the error.
 * @throws HostingError('UnsupportedRoutePatternError') for a wildcard other than one trailing `/*` (e.g. `/files*`).
 */
export const apiPathToRoutes = (pattern: string, door: string): Array<{ path: string; target: string }> => {
	if (hasInnerWildcard(pattern)) {
		throw new HostingError('UnsupportedRoutePatternError', {
			message:
				`The backend route pattern '${pattern}' can't be routed by the ${door} front door: API Gateway paths take a ` +
				'wildcard only as a whole trailing segment (`/files/*`).',
			resolution:
				'Register the route as `/files/{name}` or `/files/*` (a whole segment), or use the CloudFront or ALB door.',
		});
	}
	const path = globToProxyPath(pattern);
	if (path === null) return [];
	if (!path.endsWith('/{proxy+}')) return [{ path, target: path }];
	const prefix = path.slice(0, -'/{proxy+}'.length);
	return [
		...(prefix ? [{ path: prefix, target: prefix }] : []),
		{ path, target: `${prefix}/{proxy}` },
	];
};

/** API Gateway's default per-API route/resource quota (adjustable). */
export const APIGW_DEFAULT_ROUTE_QUOTA = 300;
