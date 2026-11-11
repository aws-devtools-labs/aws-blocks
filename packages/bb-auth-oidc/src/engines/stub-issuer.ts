// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Issuer path and URL helpers for `stubIdp()` providers.
 *
 * Pure URL helpers with no engine state, split out of `stub-idp.ts` so code
 * that only needs a stub provider's issuer (`resolveProviderIssuerUrl` in
 * `utils.ts`, the route table in `stub-routes.ts`) can import them without
 * statically importing the stub IdP engine. The AWS runtime relies on that:
 * it loads `stub-idp.ts` only in sandbox deployments.
 */

import { BLOCKS_AUTH_PREFIX } from '@aws-blocks/core';
import { getRequestBaseUrl } from '@aws-blocks/core/bb-utils';

/**
 * Root path under which each provider's stub IdP is mounted. Lives under the
 * reserved `/aws-blocks/auth` subtree so the same CloudFront behavior that
 * proxies the auth flow also covers the co-hosted stub IdP.
 */
export const STUB_ROOT = `${BLOCKS_AUTH_PREFIX}/idp`;

/** Path segment per provider. */
export function stubIssuerPath(providerName: string): string {
	return `${STUB_ROOT}/${encodeURIComponent(providerName)}`;
}

/**
 * Compute the absolute issuer URL for a provider's stub, given the current
 * request. Used at runtime to build discovery + token + jwks URLs.
 *
 * The stub IdP's issuer (and its discovery / token / JWKS / authorize
 * endpoints) is fetched **server-side by the Lambda itself** during
 * `openid-client` discovery and code exchange, so it must resolve to a host
 * the Lambda can reach over HTTPS. We prefer `BLOCKS_API_URL` (the API's own
 * execute-api gateway origin) when the process has it: in sandbox,
 * `ctx.request.url` is rewritten to the loopback dev-server front door
 * (`http://localhost:3000`), which the Lambda can't reach and the AWS runtime's
 * HTTPS-only discovery would reject. Core sets `BLOCKS_API_URL` on Hosting's
 * SSR compute and the sandbox dev server, not on the backend handler, so a
 * deployed handler falls back to the request's base URL: its gateway origin
 * plus stage (`getRequestBaseUrl()`). In local dev that base is the request
 * origin (the in-process mock allows insecure issuers).
 *
 * Like a real external IdP, the stub's authorize/login step then runs on the
 * issuer's own origin (the gateway), not the app front door; that hop sets no
 * cookie and 302s back to the front-door `redirect_uri`.
 *
 * Both sources carry the API Gateway stage prefix (e.g. `/prod`) when there is
 * one, so the issuer URL is the correct external-facing one. `ctx.request.url`
 * itself never does: its pathname is the route path.
 */
export function stubIssuerUrl(providerName: string, ctx: { request: { url: URL } }): string {
	const stubPath = stubIssuerPath(providerName);
	// `BLOCKS_API_URL` is core-owned config (the API's own execute-api gateway
	// URL). Literal key — it's already set under this name on the compute/SSR
	// functions and read by the RPC client.
	const apiUrl = process.env.BLOCKS_API_URL;
	if (!apiUrl) return `${getRequestBaseUrl(ctx)}${stubPath}`;
	// `BLOCKS_API_URL` ends in `/{stage}/aws-blocks/api`: everything before the
	// reserved `/aws-blocks` namespace is the stage prefix.
	const url = new URL(apiUrl);
	const pathname = url.pathname;
	const routeStart = pathname.search(/\/aws-blocks\b/);
	const stagePrefix = routeStart > 0 ? pathname.slice(0, routeStart) : '';
	return `${url.protocol}//${url.host}${stagePrefix}${stubPath}`;
}
