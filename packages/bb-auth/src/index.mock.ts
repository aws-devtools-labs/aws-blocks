// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `@aws-blocks/bb-auth` — default entry (local dev + tests) and the `types`
 * entry every condition type-checks against.
 *
 * `Auth` is the real engine-agnostic `AuthBase` (sessions,
 * cookies, guards, the `createApi()` state machine) over the local user-pool
 * engine (`engines/native-mock.ts`, D5b) — users, groups, codes, MFA, devices,
 * passkeys and the admin surface, persisted to `.bb-data/<fullId>/`.
 * Federation is real (D6a): a direct OIDC / OAuth 2.0 provider talks to its
 * IdP exactly as in Lambda, and a `stubIdp()` provider is served by the
 * in-process stub IdP, so federated sign-in works offline. Hosted-UI providers
 * (social, SAML, `federateVia: 'cognito'`) answer an actionable 501.
 */

import type { ScopeParent } from '@aws-blocks/core';
import { getMockDataDir } from '@aws-blocks/core/bb-utils';
import { AuthBase, type AuthLayer, defineAuthLayer } from './auth-base.js';
import { MockPoolBearerVerifier } from './bearer-mock.js';
import { DirectFederationEngine, isStubProvider } from './engines/federation-direct.js';
import { unavailableFederationEngine } from './engines/federation-unavailable.js';
import { MockNativeEngine } from './engines/native-mock.js';
import { createStubIdp } from './engines/stub-idp.js';
import { mountStubIdpRoutes, stubIssuerUrl } from './engines/stub-idp-routes.js';
import { federationRoutePaths, mountFederationRoutes } from './federation-routes.js';
import { readMockSessionSecret } from './sessions.js';
import type { AuthMockOptions, AuthOptions } from './types.js';

export type { AuthBase } from './auth-base.js';
export type { AuthErrorName } from './errors.js';
export { AuthErrors, isAuthError } from './errors.js';
export { customOauth2, github, stubIdp } from './providers.js';
export { relayOrigin } from './relay.js';
export type * from './types.js';

/**
 * The options as the mock sees them: the cross-runtime {@link AuthOptions}
 * plus the mock-only hooks of {@link AuthMockOptions}, checked at runtime
 * (the backend module is plain JavaScript once compiled).
 */
function isMockOptions(options: AuthOptions): options is AuthMockOptions {
	const codeDelivery: unknown = Reflect.get(options, 'codeDelivery');
	return codeDelivery === undefined || typeof codeDelivery === 'function';
}

/**
 * The local layer: the session secret lives in `.bb-data/<fullId>/state.json`
 * (the same file and field `AuthCognito`'s mock uses, so local sessions
 * survive the switch), and the user pool is the local mock engine over the
 * same file.
 */
const MOCK_LAYER: AuthLayer = {
	sessionSecret(auth) {
		let cached: string | undefined;
		return async () => {
			cached ??= readMockSessionSecret(getMockDataDir(auth));
			return cached;
		};
	},
	native: (host) => {
		const codeDelivery = isMockOptions(host.options) ? host.options.codeDelivery : undefined;
		return new MockNativeEngine(host, codeDelivery ? { codeDelivery } : {});
	},
	// `allowBearerAuth`: the local pool's own (unsigned) access tokens, only
	// while the pool still recognises them. Mock-only by construction — the AWS
	// entry wires the Cognito verifier instead.
	poolBearer: (host, native) => new MockPoolBearerVerifier(host, native),
	federation(host, provider) {
		if (provider.family === 'oidc' && provider.transport === 'direct') {
			const config = provider.config;
			if (isStubProvider(config)) {
				// The stub's registered redirect URIs: the app origin plus the
				// instance's callback route; and its post-logout URIs: the app
				// origin plus the (normalised) sign-out landing and sign-out route.
				const paths = federationRoutePaths(host.options);
				const handlers = createStubIdp({
					providerId: provider.id,
					settings: config.stubIdp,
					dataDir: () => getMockDataDir(host.scope),
					client: {
						clientId: config.clientId,
						redirectPaths: [paths.callback],
						postLogoutPaths: [paths.postSignOut, paths.signOut],
					},
					issuer: (ctx) => stubIssuerUrl(provider.id, ctx),
					secret: () => host.sessionSecret(),
				});
				mountStubIdpRoutes(host.scope, provider.id, () => Promise.resolve(handlers));
				return new DirectFederationEngine(host, provider, {
					allowInsecure: true,
					stubIssuer: (ctx) => stubIssuerUrl(provider.id, ctx),
				});
			}
			// A real IdP, even locally. `http:` is accepted so a local IdP
			// (Keycloak on localhost, …) works in `npm run dev`.
			return new DirectFederationEngine(host, provider, { allowInsecure: true });
		}
		// Social, SAML and `federateVia: 'cognito'`: managed login needs a
		// deployed pool — an actionable 501, never a 404.
		return unavailableFederationEngine(provider, 'hosted-ui-local');
	},
	routes(host) {
		mountFederationRoutes(host);
		// console.log, not the block logger (error level by default): this banner
		// must show in `npm run dev` without extra config.
		for (const { provider } of host.providers) {
			const target =
				provider.family === 'oidc' && provider.transport === 'direct'
					? isStubProvider(provider.config)
						? 'AWS Blocks stub IdP (local sign-in, no real credentials)'
						: `${provider.config.issuer} (real IdP)`
					: 'Cognito managed login (unavailable locally — deploy a sandbox to test it)';
			console.log(`[auth] provider "${provider.id}" → ${target}`);
		}
	},
};

/**
 * The unified auth Building Block, published as `@aws-blocks/bb-auth` and exported
 * from `@aws-blocks/blocks`. See the package README.
 *
 * Locally, `Auth` runs a complete user pool with no AWS account. Every
 * verification code is written to `.bb-data/<fullId>/last-code.json` and
 * passed to the mock-only `codeDelivery` hook ({@link AuthMockOptions}).
 *
 * @typeParam O - The options literal, captured with `const` so inline options
 * narrow the method surface without `as const`.
 */
export class Auth<const O extends AuthMockOptions = AuthMockOptions> extends AuthBase<O> {
	// biome-ignore lint/complexity/noUselessConstructor: pins the documented constructor signature of this entry
	constructor(scope: ScopeParent, id: string, options?: O) {
		super(scope, id, options);
	}
}
defineAuthLayer(Auth, MOCK_LAYER);
