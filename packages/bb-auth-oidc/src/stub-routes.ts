// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Route table for `stubIdp()` providers: mounts the co-hosted stub IdP's
 * discovery, JWKS, authorize, token, userinfo, and revoke endpoints.
 *
 * Split out of `routes.ts` so the AWS runtime has no static import path to
 * the stub IdP engine (`engines/stub-idp.ts`). This module imports only the
 * issuer path helper; the engine is loaded with a dynamic `import()` the first
 * time a mounted stub route needs it. The AWS runtime calls
 * `mountStubIdpRoutes` only in sandbox deployments, so the engine module is
 * not evaluated unless a stub route is called in a sandbox deployment.
 *
 * Why the routes are registered eagerly and only the engine is deferred: core
 * locks the RawRoute registry as soon as the backend module has been imported
 * (the Lambda handler and the HTTP server both do this), so routes must be
 * registered synchronously during construction. A route registered from an
 * `await import(...)` continuation would land after the lock and throw.
 *
 * Bundling trade-off: esbuild CJS bundles inline a dynamically imported module
 * as a lazily-evaluated wrapper rather than a separate file. The engine may
 * therefore still be shipped in a bundle, but its module body (and its key
 * material, code signing, and handlers) is not evaluated unless a stub route
 * is called in a sandbox deployment.
 */

import { RawRoute } from '@aws-blocks/core';
import type { AuthOIDC } from './auth-oidc.js';
import type { StubIdpHandlerOptions } from './engines/stub-idp.js';
import { stubIssuerPath } from './engines/stub-issuer.js';
import type { ProviderConfig, StubProvider } from './types.js';

/** The stub IdP engine module, as loaded by {@link loadStubIdp}. */
type StubIdpModule = typeof import('./engines/stub-idp.js');

/** Memoized dynamic import of the stub IdP engine. */
let stubIdpModule: Promise<StubIdpModule> | undefined;

/**
 * Load the stub IdP engine on first use. Deferred (rather than a static import)
 * so the engine module is evaluated only once a mounted stub route runs. A
 * failed load is not cached, so a later request retries it.
 */
function loadStubIdp(): Promise<StubIdpModule> {
	if (!stubIdpModule) {
		stubIdpModule = import('./engines/stub-idp.js');
		// Retry-reset, not error suppression: the awaiting caller still sees the rejection.
		stubIdpModule.catch(() => {
			stubIdpModule = undefined;
		});
	}
	return stubIdpModule;
}

/** Options for {@link mountStubIdpRoutes}. */
export interface MountStubIdpRoutesOptions {
	/**
	 * The instance's cookie-signing secret, or a resolver for it. The stub
	 * IdP derives its per-provider code-signing key from this value (see
	 * `deriveStubCodeKey`), so it must be the same persistent per-deployment
	 * secret the instance signs cookies with.
	 */
	codeSecret: string | (() => string | Promise<string>);
	/** Directory holding the stub `users.json` (local mock only). */
	dataDir?: string;
}

/**
 * Mount stub IdP routes for a single provider.
 *
 * The routes are registered synchronously (core locks the route registry once
 * the backend has loaded); each handler loads the stub IdP engine on its first
 * call. See the module docs for why.
 */
export function mountStubIdpRoutes(
	parent: AuthOIDC<readonly ProviderConfig[]>,
	provider: StubProvider,
	options: MountStubIdpRoutesOptions,
): void {
	const base = stubIssuerPath(provider.name);
	const { codeSecret, dataDir } = options;

	// Derive the code-signing key once per mount and reuse it. A failed
	// resolution is not cached, so a later request retries it.
	let codeKeyPromise: Promise<Buffer> | undefined;
	const codeKey = (): Promise<Buffer> => {
		if (!codeKeyPromise) {
			codeKeyPromise = (async () => {
				const secret = typeof codeSecret === 'function' ? await codeSecret() : codeSecret;
				const { deriveStubCodeKey } = await loadStubIdp();
				return deriveStubCodeKey(secret, provider.name);
			})();
			// Retry-reset, not error suppression: drop the memoized promise on failure so the
			// next request re-derives; the awaiting caller still sees the rejection.
			codeKeyPromise.catch(() => {
				codeKeyPromise = undefined;
			});
		}
		return codeKeyPromise;
	};
	const handlerOptions: StubIdpHandlerOptions = { codeKey, dataDir };
	const routeId = (suffix: string) => `stub-${provider.name}-${suffix}`;

	new RawRoute(parent, routeId('discovery'), {
		method: 'GET',
		path: `${base}/.well-known/openid-configuration`,
		handler: async (ctx) => (await loadStubIdp()).handleDiscovery(provider.name, ctx),
	});
	new RawRoute(parent, routeId('jwks'), {
		method: 'GET',
		path: `${base}/jwks.json`,
		handler: async (ctx) => (await loadStubIdp()).handleJwks(provider.name, ctx),
	});
	new RawRoute(parent, routeId('authorize'), {
		method: 'GET',
		path: `${base}/authorize`,
		handler: async (ctx) => (await loadStubIdp()).handleAuthorize(provider, ctx, handlerOptions),
	});
	new RawRoute(parent, routeId('authorize-submit'), {
		method: 'POST',
		path: `${base}/authorize`,
		handler: async (ctx) => (await loadStubIdp()).handleAuthorizeSubmit(provider, ctx, handlerOptions),
	});
	new RawRoute(parent, routeId('token'), {
		method: 'POST',
		path: `${base}/token`,
		handler: async (ctx) => (await loadStubIdp()).handleToken(provider.name, ctx, handlerOptions),
	});
	new RawRoute(parent, routeId('userinfo'), {
		method: 'GET',
		path: `${base}/userinfo`,
		handler: async (ctx) => (await loadStubIdp()).handleUserInfo(provider.name, ctx),
	});
	new RawRoute(parent, routeId('revoke'), {
		method: 'POST',
		path: `${base}/revoke`,
		handler: async (ctx) => (await loadStubIdp()).handleRevoke(provider.name, ctx),
	});
}
