// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The stub IdP's **route table** and issuer URL, without the IdP itself.
 *
 * `RawRoute`s must be registered while the `Auth` constructor runs, but the
 * stub's handlers (`stub-idp.ts`: key derivation, token signing, the account
 * picker) are needed only when a request arrives. This module mounts the
 * routes and loads the handlers on the first request through the `load`
 * callback it is given. The mock entry passes a static import; the AWS entry
 * passes a dynamic `import('./engines/stub-idp.js')`, and only for a provider
 * that sets `unsafeAllowDeployed` — so a normal deployed app's module graph
 * never contains the stub IdP (`index.aws.bearer.test.ts` pins this).
 *
 * Imports nothing heavier than core's `RawRoute`.
 *
 * @internal
 */

import { BLOCKS_AUTH_PREFIX, type BlocksContext, RawRoute, type Scope } from '@aws-blocks/core';
import type { StubIdpSettings } from '../types.js';

/** Root under which every stub issuer is mounted (inside the reserved auth subtree). */
export const STUB_ROOT = `${BLOCKS_AUTH_PREFIX}/idp`;

/** Path of a provider's stub issuer. */
export function stubIssuerPath(providerId: string): string {
	return `${STUB_ROOT}/${encodeURIComponent(providerId)}`;
}

/**
 * The absolute issuer URL of a provider's stub for this request: the request's
 * origin (or the deploy-injected `BLOCKS_API_URL`, which the server can reach
 * itself) plus any stage prefix before `/aws-blocks` — `bb-auth-oidc`'s rule.
 *
 * `apiUrl` overrides `BLOCKS_API_URL`: the deployed stub passes the gateway URL
 * the CDK layer registered (`stubIdpConfigKeys`), so its issuer is always the
 * HTTPS gateway — reachable by the Lambda itself, and the same value whichever
 * front door the request came through.
 */
export function stubIssuerUrl(
	providerId: string,
	ctx: { request: { url: URL } },
	apiUrl: string | undefined = process.env.BLOCKS_API_URL,
): string {
	const url = apiUrl ? new URL(apiUrl) : ctx.request.url;
	const routeStart = url.pathname.search(/\/aws-blocks\b/);
	const stagePrefix = routeStart > 0 ? url.pathname.slice(0, routeStart) : '';
	return `${url.protocol}//${url.host}${stagePrefix}${stubIssuerPath(providerId)}`;
}

/** Whether a stub provider opted in to being deployed (`unsafeAllowDeployed: true`). */
export function stubAllowsDeployment(settings: StubIdpSettings): boolean {
	return settings.unsafeAllowDeployed === true;
}

/** One request handler of the stub IdP. */
type StubHandler = (ctx: BlocksContext) => Promise<void>;

/** The stub IdP's handlers, one per route (built by `createStubIdp()` in `stub-idp.ts`). */
export interface StubIdpHandlers {
	discovery: StubHandler;
	jwks: StubHandler;
	authorize: StubHandler;
	authorizeSubmit: StubHandler;
	token: StubHandler;
	userinfo: StubHandler;
	revoke: StubHandler;
	logout: StubHandler;
}

/**
 * Mount one provider's stub IdP routes on `scope` (the `Auth` instance). The
 * handlers are built by `load()` on the first request and reused; a failed
 * load is not cached, so the next request retries it.
 */
export function mountStubIdpRoutes(scope: Scope, providerId: string, load: () => Promise<StubIdpHandlers>): void {
	let pending: Promise<StubIdpHandlers> | undefined;
	const handlers = (): Promise<StubIdpHandlers> => {
		if (!pending) {
			const attempt = load();
			pending = attempt;
			attempt.catch(() => {
				if (pending === attempt) pending = undefined;
			});
		}
		return pending;
	};
	const base = stubIssuerPath(providerId);
	const id = (suffix: string) => `auth-idp-${providerId}-${suffix}`;
	const routes: ReadonlyArray<[suffix: string, method: 'GET' | 'POST', path: string, name: keyof StubIdpHandlers]> = [
		['discovery', 'GET', '/.well-known/openid-configuration', 'discovery'],
		['jwks', 'GET', '/jwks.json', 'jwks'],
		['authorize', 'GET', '/authorize', 'authorize'],
		['authorize-submit', 'POST', '/authorize', 'authorizeSubmit'],
		['token', 'POST', '/token', 'token'],
		['userinfo', 'GET', '/userinfo', 'userinfo'],
		['revoke', 'POST', '/revoke', 'revoke'],
		['logout', 'GET', '/logout', 'logout'],
	];
	for (const [suffix, method, path, name] of routes) {
		new RawRoute(scope, id(suffix), {
			method,
			path: `${base}${path}`,
			handler: async (ctx) => (await handlers())[name](ctx),
		});
	}
}
