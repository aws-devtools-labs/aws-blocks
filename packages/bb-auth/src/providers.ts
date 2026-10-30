// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Provider factories for {@link AuthOptions.oidcProviders}: `stubIdp()` (the
 * local stub IdP), `github()` and `customOauth2()` (bare OAuth 2.0, federated
 * directly — Cognito cannot federate OAuth 2.0 without an ID token).
 *
 * A generic OIDC provider needs no factory — write the options object
 * (`{ issuer, clientId }`) directly. These helpers exist where the options
 * carry more than a reader would want to type: a stub's user directory, an
 * OAuth 2.0 provider's endpoints and claim mapping.
 *
 * Pure config builders: no network calls, no secret resolution, no Node
 * built-ins — safe in every entry point, including the browser stub.
 */

import type {
	CustomOauth2Options,
	GitHubOptions,
	OAuth2ProviderOptions,
	StubIdpOptions,
	StubIdpSettings,
	StubOidcProviderOptions,
} from './types.js';

const OIDC_DEFAULT_SCOPES = ['openid', 'email', 'profile'] as const;
const GITHUB_DEFAULT_SCOPES = ['read:user', 'user:email'] as const;

/** The client id every stub IdP provider uses (a public, PKCE-only client). */
const STUB_CLIENT_ID = 'stub-client-id';

/**
 * A provider served by the built-in **stub IdP**, for local development and
 * tests: a real OIDC provider (ES256 ID tokens, discovery, JWKS, PKCE S256,
 * an account picker) mounted on the dev server, so federated sign-in works
 * offline with no IdP account — including with `emailPassword: false`.
 *
 * Local development and sandbox deployments only. `npm run dev` serves it,
 * and so does a sandbox (`npm run sandbox`, CDK context `sandboxMode`), where
 * the deployed backend mounts the stub's routes. Synthesizing any other
 * deployment with a `stubIdp()` provider fails, and deployed compute that is
 * not a sandbox answers its sign-in with an actionable error. Select providers
 * with `getDeploymentType()` so the stub is used only where it is allowed:
 *
 * ```ts
 * import { Auth, getDeploymentType, stubIdp } from '@aws-blocks/blocks';
 *
 * const corp = getDeploymentType() === 'production'
 *   ? { issuer: 'https://login.example.com', clientId: 'my-client-id' }
 *   : stubIdp();
 * const auth = new Auth(scope, 'auth', { emailPassword: false, oidcProviders: { corp } });
 * ```
 *
 * What a sandbox stub exposes: it signs users in **without credentials**.
 * Anyone who can reach the sandbox can open the account picker (or hit
 * `onAuthorize`) and sign in as any of the stub's users — the inline `users`,
 * or the one built-in default user — with every claim in their `extra`, so a
 * user with `extra: { groups: ['admin'] }` passes `requireRole('admin')`. Its
 * signing keys are derived from the block's session secret, so its tokens
 * cannot be forged without it, but the account picker itself is an open door.
 * A deployed stub's refresh tokens are self-contained and revocation is
 * remembered per Lambda instance only, so a revoked refresh token keeps
 * working on other instances until it expires (30 days). Synth emits a
 * `@aws-blocks/bb-auth:StubIdpDeployed` warning for every sandbox stub.
 *
 * @example
 * ```ts
 * const auth = new Auth(scope, 'auth', {
 *   emailPassword: false,
 *   oidcProviders: {
 *     corp: stubIdp({
 *       users: [
 *         { sub: 'u-1', email: 'alice@example.com', name: 'Alice', extra: { groups: ['admin'] } },
 *         { sub: 'u-2', email: 'bob@example.com', name: 'Bob' },
 *       ],
 *     }),
 *   },
 *   users: { groups: ['admin'] },
 * });
 * ```
 */
export function stubIdp(options: StubIdpOptions = {}): StubOidcProviderOptions {
	const stub: StubIdpSettings = {};
	if (options.users) stub.users = options.users;
	if (options.onAuthorize) stub.onAuthorize = options.onAuthorize;
	return {
		issuer: 'aws-blocks:stub-idp',
		clientId: STUB_CLIENT_ID,
		scopes: options.scopes ?? [...OIDC_DEFAULT_SCOPES],
		groupsClaim: options.groupsClaim ?? 'groups',
		...(options.label !== undefined ? { label: options.label } : {}),
		...(options.attributeMapping !== undefined ? { attributeMapping: options.attributeMapping } : {}),
		stubIdp: stub,
	};
}

/**
 * Sign in with GitHub — OAuth 2.0 (GitHub issues no ID token), federated
 * directly by your backend. The profile comes from `https://api.github.com/user`
 * (`id` → `sub`, plus `email` and `name`). `userId` is `oauth2:github:<id>`,
 * the same as `AuthOIDC`'s `github()`.
 *
 * @example
 * ```ts
 * const githubSecret = new AppSetting(scope, 'github-secret', { secret: true });
 * const auth = new Auth(scope, 'auth', {
 *   oidcProviders: { github: github({ clientId: 'Iv1.abc', clientSecret: githubSecret }) },
 * });
 * ```
 */
export function github(options: GitHubOptions): OAuth2ProviderOptions {
	return customOauth2({
		name: 'github',
		clientId: options.clientId,
		clientSecret: options.clientSecret,
		scopes: options.scopes ?? [...GITHUB_DEFAULT_SCOPES],
		...(options.label !== undefined ? { label: options.label } : {}),
		endpoints: {
			authorization: 'https://github.com/login/oauth/authorize',
			token: 'https://github.com/login/oauth/access_token',
			userInfo: 'https://api.github.com/user',
		},
		mapClaims: (raw) => {
			const obj = typeof raw === 'object' && raw !== null ? raw : {};
			const id: unknown = Reflect.get(obj, 'id');
			const email: unknown = Reflect.get(obj, 'email');
			const name: unknown = Reflect.get(obj, 'name');
			return {
				providerSub: typeof id === 'number' || typeof id === 'string' ? String(id) : '',
				email: typeof email === 'string' ? email : null,
				name: typeof name === 'string' ? name : null,
			};
		},
	});
}

/**
 * A bare OAuth 2.0 provider (one that issues no ID token), federated directly
 * by your backend: authorization code + PKCE S256, then the userinfo endpoint
 * — called with the access token — gives the profile, which `mapClaims` turns
 * into a user.
 *
 * Prefer a plain `oidcProviders` entry (`{ issuer, clientId }`) whenever the
 * provider speaks OIDC: an ID token is verified against the provider's keys,
 * which is stronger than trusting a userinfo response.
 */
export function customOauth2(options: CustomOauth2Options): OAuth2ProviderOptions {
	return {
		issuer: `oauth2:${options.name}`,
		clientId: options.clientId,
		...(options.clientSecret ? { clientSecret: options.clientSecret } : {}),
		scopes: options.scopes,
		...(options.label !== undefined ? { label: options.label } : {}),
		oauth2: { endpoints: options.endpoints, mapClaims: options.mapClaims },
	};
}
