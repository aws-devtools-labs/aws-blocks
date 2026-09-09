// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Provider helper factories for AuthOIDC.
 *
 * Each helper returns a config object with `name` branded as a literal string
 * (not widened to `string`). This is what lets the literal-union DX work —
 * `blocks.auth.providers` is typed as the union of configured provider names, and
 * `signIn('typo')` is a compile error — without requiring `as const` at the
 * call site.
 *
 * Helpers are pure config builders: no network calls, no secret resolution.
 * Secrets are resolved lazily on the first auth request (see `types.ts`,
 * `SecretLike`).
 */

import type {
	CognitoFederatedProvider,
	CustomOauth2Provider,
	CustomOidcProvider,
	GitHubProvider,
	GoogleProvider,
	MappedClaims,
	OnStubAuthorize,
	ProviderOpts,
	SecretLike,
	StubProvider,
} from './types.js';

/**
 * Minimal interface satisfied by `AppSetting`. Used by `cognitoFederated()`
 * so the CDK layer can extract the SSM parameter name and the runtime can
 * call `.get()` — without importing the full `AppSetting` class (which has
 * conditional exports).
 */
export interface AppSettingLike {
	/** The full scope ID — used to derive the SSM parameter name (`/${fullId}`). */
	readonly fullId: string;
	/** Resolve the secret value at runtime. */
	get(): Promise<string>;
}

const OIDC_DEFAULT_SCOPES = ['openid', 'email', 'profile'] as const;

const GITHUB_DEFAULT_SCOPES = ['read:user', 'user:email'] as const;

/**
 * Google sign-in (OIDC).
 *
 * Uses Google's OIDC discovery document at
 * `https://accounts.google.com/.well-known/openid-configuration`.
 *
 * Default scopes: `openid`, `email`, `profile`. Override via `opts.scopes`.
 *
 * @example
 * ```typescript
 * import { AuthOIDC, google } from '@aws-blocks/bb-auth-oidc';
 *
 * const auth = new AuthOIDC(app, 'auth', {
 *   providers: [google({
 *     clientId:     () => googleClientId.get(),
 *     clientSecret: () => googleSecret.get(),
 *   })],
 * });
 * ```
 */
export function google(opts: ProviderOpts): GoogleProvider {
	return {
		name: 'google',
		kind: 'oidc-builtin',
		issuerUrl: 'https://accounts.google.com',
		clientId: opts.clientId,
		clientSecret: opts.clientSecret,
		scopes: opts.scopes ?? [...OIDC_DEFAULT_SCOPES],
	};
}

/**
 * GitHub sign-in (OAuth 2.0 — not OIDC; GitHub does not issue ID tokens).
 *
 * The engine fetches `https://api.github.com/user` for the profile. GitHub's
 * userinfo shape is well-known, so a built-in `mapClaims` is shipped on the
 * provider config itself — `id` → `sub`, plus `email` + `name`.
 *
 * Default scopes: `read:user`, `user:email`.
 */
export function github(opts: ProviderOpts): GitHubProvider {
	return {
		name: 'github',
		kind: 'oauth2-custom',
		authUrl: 'https://github.com/login/oauth/authorize',
		tokenUrl: 'https://github.com/login/oauth/access_token',
		userInfoUrl: 'https://api.github.com/user',
		clientId: opts.clientId,
		clientSecret: opts.clientSecret,
		scopes: opts.scopes ?? [...GITHUB_DEFAULT_SCOPES],
		mapClaims: (raw: unknown) => {
			const obj = (raw ?? {}) as Record<string, unknown>;
			const id = obj.id;
			const providerSub = id === undefined || id === null ? '' : String(id);
			return {
				providerSub,
				email: typeof obj.email === 'string' ? obj.email : null,
				name: typeof obj.name === 'string' ? obj.name : null,
			};
		},
	};
}

export interface StubIdpOpts<N extends string = string> {
	/**
	 * Provider name — used in `signIn(provider)` and displayed in the
	 * Authenticator UI. Typically mirrors the real provider it replaces
	 * (e.g., `'google'`, `'corporate'`).
	 */
	name: N;
	/** Override default scopes. Defaults to `['openid', 'email', 'profile']`. */
	scopes?: string[];
	/** Decide the `/authorize` response. See {@link OnStubAuthorize}. */
	onAuthorize?: OnStubAuthorize;
}

/**
 * Stub provider for testing. Co-deploys a fake IdP that auto-approves
 * sign-ins with deterministic test users — no real IdP credentials needed.
 *
 * Composable: you can mix real and stub providers in the same instance.
 *
 * @example
 * ```typescript
 * import { AuthOIDC, stubIdp } from '@aws-blocks/blocks';
 *
 * // E2E test app — stub providers, no real IdP needed
 * const auth = new AuthOIDC(app, 'auth', {
 *   providers: [
 *     stubIdp({ name: 'google' }),
 *     stubIdp({ name: 'corporate' }),
 *   ],
 * });
 *
 * // Production — real providers
 * const auth = new AuthOIDC(app, 'auth', {
 *   providers: [
 *     google({ clientId, clientSecret }),
 *     customOidc({ name: 'corporate', issuerUrl: 'https://login.corp.com', ... }),
 *   ],
 * });
 * ```
 */
export function stubIdp<N extends string>(opts: StubIdpOpts<N>): StubProvider<N> {
	return {
		name: opts.name,
		kind: 'stub',
		clientId: 'stub-client-id',
		clientSecret: 'stub-client-secret',
		scopes: opts.scopes ?? [...OIDC_DEFAULT_SCOPES],
		onAuthorize: opts.onAuthorize,
	};
}

export interface CustomOidcOpts<N extends string = string> extends ProviderOpts {
	name: N;
	/** `/.well-known/openid-configuration` is discovered from here. */
	issuerUrl: string;
	attributeMapping?: { email?: string; name?: string };
}

/**
 * Configure any OIDC-compliant identity provider via its issuer URL.
 *
 * Works with Okta, Auth0, Microsoft Entra, Cognito User Pools (pointed at
 * `https://cognito-idp.<region>.amazonaws.com/<pool-id>`), or any other IdP
 * that publishes an OIDC discovery document at
 * `{issuerUrl}/.well-known/openid-configuration`.
 *
 * @example
 * ```typescript
 * const auth = new AuthOIDC(app, 'auth', {
 *   providers: [
 *     customOidc({
 *       name: 'okta',
 *       issuerUrl: 'https://my-org.okta.com/oauth2/default',
 *       clientId:     () => oktaClientId.get(),
 *       clientSecret: () => oktaSecret.get(),
 *     }),
 *   ],
 * });
 * ```
 */
export function customOidc<N extends string>(opts: CustomOidcOpts<N>): CustomOidcProvider<N> {
	return {
		name: opts.name,
		kind: 'oidc-custom',
		issuerUrl: opts.issuerUrl,
		clientId: opts.clientId,
		clientSecret: opts.clientSecret,
		scopes: opts.scopes ?? [...OIDC_DEFAULT_SCOPES],
		attributeMapping: opts.attributeMapping,
	};
}

export interface CustomOauth2Opts<N extends string = string> {
	name: N;
	clientId: SecretLike;
	clientSecret: SecretLike;
	authUrl: string;
	tokenUrl: string;
	userInfoUrl: string;
	scopes: string[];
	/**
	 * Translate the userinfo response into Blocks' user shape. `providerSub`
	 * becomes the `sub` component of `userId = ${iss}:${sub}`.
	 */
	mapClaims: (raw: unknown) => MappedClaims;
}

/**
 * Configure a bare OAuth 2.0 provider that does not implement OIDC.
 *
 * Use when the IdP doesn't issue ID tokens. You provide the authorize /
 * token / userinfo URLs and a `mapClaims` function to translate the
 * userinfo body into a Blocks user.
 */
export function customOauth2<N extends string>(opts: CustomOauth2Opts<N>): CustomOauth2Provider<N> {
	return {
		name: opts.name,
		kind: 'oauth2-custom',
		authUrl: opts.authUrl,
		tokenUrl: opts.tokenUrl,
		userInfoUrl: opts.userInfoUrl,
		clientId: opts.clientId,
		clientSecret: opts.clientSecret,
		scopes: opts.scopes,
		mapClaims: opts.mapClaims,
	};
}

export interface CognitoFederatedOpts<N extends string = string> {
	/** Provider name — used in `signIn(provider)` and displayed in the Authenticator UI. */
	name: N;
	/**
	 * The IdP's OAuth client ID as an `AppSetting` instance.
	 * This is the same credential you'd pass to `google()` — e.g. your Google OAuth client ID.
	 * CDK reads the parameter name for CloudFormation dynamic references.
	 * Runtime calls `.get()` to resolve the value.
	 */
	clientId: AppSettingLike;
	/**
	 * The IdP's OAuth client secret as an `AppSetting` instance.
	 * CDK reads the parameter name for CloudFormation dynamic references.
	 * Runtime calls `.get()` to resolve the value.
	 */
	clientSecret: AppSettingLike;
	/**
	 * Cognito domain prefix or full custom domain.
	 * Prefix: `'myapp'` → `https://myapp.auth.{region}.amazoncognito.com`
	 * Custom: `'auth.myapp.com'` → `https://auth.myapp.com`
	 */
	cognitoDomain: string;
	/** AWS region of the Cognito User Pool (e.g. `'us-east-1'`). */
	region: string;
	/**
	 * The identity provider name as registered in Cognito.
	 * Built-in: `'Google'`, `'Facebook'`, `'LoginWithAmazon'`, `'SignInWithApple'`.
	 * Custom OIDC: whatever name you gave the IdP in Cognito's console.
	 */
	identityProvider: string;
	/**
	 * OIDC issuer URL of the IdP. Required when `identityProvider` is not
	 * one of the built-in social providers (Google, Facebook, Amazon, Apple).
	 * Used by the CDK layer to register a custom OIDC IdP in Cognito.
	 */
	idpIssuerUrl?: string;
	/** Override default scopes. Defaults to `['openid', 'email', 'profile']`. */
	scopes?: string[];
}

/**
 * Cognito-federated sign-in. Delegates the entire OIDC flow to a Cognito
 * User Pool's Hosted UI — Cognito handles PKCE, token verification, MFA,
 * and brute-force protection. Your Lambda only exchanges the code and
 * reads the session.
 *
 * User IDs are stable across engine switches: `userId = ${iss}:${sub}` is
 * derived from the original IdP identity (extracted from Cognito's
 * `identities` claim), not from Cognito's internal UUID.
 *
 * @remarks
 * The IdP is registered on the User Pool by a **deploy-time custom resource**,
 * not a native `AWS::Cognito::UserPoolIdentityProvider` resource. That native
 * path would write the client id/secret into `ProviderDetails` as
 * `{{resolve:ssm-secure:...}}` dynamic references, which CloudFormation rejects
 * on that property. Instead a Lambda reads and decrypts the credential
 * SecureString parameters via the SDK at deploy time and calls Cognito's
 * `CreateIdentityProvider`, so the credentials reach Cognito without ever
 * appearing in the CloudFormation template. Set the credential values with
 * `blocks secret` before deploying — a deploy with unset credentials fails fast
 * with an actionable message.
 *
 * @example
 * ```typescript
 * import { AuthOIDC, cognitoFederated } from '@aws-blocks/bb-auth-oidc';
 * import { AppSetting } from '@aws-blocks/bb-app-setting';
 *
 * const googleClientId = new AppSetting(app, 'google-client-id', { secret: true });
 * const googleSecret   = new AppSetting(app, 'google-client-secret', { secret: true });
 *
 * const auth = new AuthOIDC(app, 'auth', {
 *   providers: [
 *     cognitoFederated({
 *       name: 'google',
 *       identityProvider: 'Google',
 *       cognitoDomain: 'myapp',
 *       region: 'us-east-1',
 *       clientId:     googleClientId,
 *       clientSecret: googleSecret,
 *     }),
 *   ],
 * });
 * ```
 */
export function cognitoFederated<N extends string>(opts: CognitoFederatedOpts<N>): CognitoFederatedProvider<N> {
	return {
		name: opts.name,
		kind: 'cognito-federated',
		clientId: () => opts.clientId.get(),
		clientSecret: () => opts.clientSecret.get(),
		scopes: opts.scopes ?? [...OIDC_DEFAULT_SCOPES],
		cognitoDomain: opts.cognitoDomain,
		region: opts.region,
		identityProvider: opts.identityProvider,
		idpIssuerUrl: opts.idpIssuerUrl,
		idpClientId: opts.clientId,
		idpClientSecret: opts.clientSecret,
	};
}

/**
 * Resolve a `SecretLike` once and memoize the result.
 *
 * Used by the engine to resolve provider credentials on the first auth
 * request per Lambda container. Resolvers that throw surface as
 * `ProviderNotConfigured` on the auth request and are **not** memoized —
 * the next request re-invokes the resolver.
 *
 * Inline strings are returned unchanged and are also cached.
 */
export function memoizedSecretResolver(secret: SecretLike): () => Promise<string> {
	let resolved: string | undefined;
	let inFlight: Promise<string> | undefined;
	return async () => {
		if (resolved !== undefined) return resolved;
		if (inFlight) return inFlight;
		if (typeof secret === 'string') {
			resolved = secret;
			return secret;
		}
		inFlight = Promise.resolve().then(() => secret()).then(
			(value) => {
				resolved = value;
				inFlight = undefined;
				return value;
			},
			(err) => {
				// Intentionally do not memoize failures — the next request retries
				// the resolver.
				inFlight = undefined;
				throw err;
			},
		);
		return inFlight;
	};
}
