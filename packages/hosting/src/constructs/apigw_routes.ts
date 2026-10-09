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
