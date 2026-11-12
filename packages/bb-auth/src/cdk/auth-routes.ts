// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Every route an `Auth` block with providers mounts at runtime, as `'<METHOD> <path>'` keys normalised like core's
 * route table. The CDK layer claims them on the backend root (`claimAuthRoutes`); `auth-routes.test.ts` pins them to
 * what the runtime actually mounts (`mountFederationRoutes`, `mountStubIdpRoutes`).
 *
 * @internal
 */

import { STUB_IDP_ROUTES, stubIssuerPath } from '../engines/stub-idp-routes.js';
import type { ResolvedAuthOptions } from '../resolve-options.js';
import { bearerAuthEnabled, federationRedirectPaths } from './contract.js';

/** One route key, `'<METHOD> <path>'`, with `//` collapsed and no trailing `/`. */
export function authRouteKey(method: 'GET' | 'POST', path: string): string {
	return `${method} ${path.replace(/\/+/g, '/').replace(/\/$/, '')}`;
}

/** A block's routes, grouped as the synth errors name them. `stubKeys` are its `stubIdp()` provider keys. */
export function authRoutes(
	opts: ResolvedAuthOptions,
	stubKeys: readonly string[],
): {
	callbackPath: string;
	signOutPath: string;
	base: string;
	signIn: string[];
	signOut: string[];
	stubs: Array<{ key: string; routes: string[] }>;
} {
	const { callbackPath, signOutPath } = federationRedirectPaths(opts);
	const base = callbackPath.slice(0, callbackPath.lastIndexOf('/'));
	const providerIds = [opts.socialProviders, opts.oidcProviders, opts.samlProviders].flatMap((m) =>
		Object.entries(m ?? {})
			.filter(([, entry]) => Boolean(entry))
			.map(([key]) => encodeURIComponent(key)),
	);
	return {
		callbackPath,
		signOutPath,
		base,
		signIn: [
			authRouteKey('GET', callbackPath),
			authRouteKey('POST', `${base}/exchange`),
			authRouteKey('GET', `${base}/session`),
			...providerIds.flatMap((p) => [
				authRouteKey('GET', `${base}/signin/${p}`),
				authRouteKey('GET', `${base}/authorize-params/${p}`),
				authRouteKey('POST', `${base}/authorize-params/${p}`),
			]),
			...(bearerAuthEnabled(opts)
				? [authRouteKey('POST', `${base}/refresh`), authRouteKey('POST', `${base}/exchange/refresh`)]
				: []),
		],
		signOut: [authRouteKey('POST', signOutPath), authRouteKey('GET', signOutPath)],
		stubs: stubKeys.map((key) => ({
			key,
			routes: STUB_IDP_ROUTES.map(([, method, path]) => authRouteKey(method, `${stubIssuerPath(key)}${path}`)),
		})),
	};
}
