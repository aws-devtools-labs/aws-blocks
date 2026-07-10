// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Public types for AuthOIDC. Types only — zero runtime dependencies.
 */

import type { BlocksContext } from '@aws-blocks/core';
import type { ChildLogger } from '@aws-blocks/bb-logger';
import type { RelayOrigin } from './relay.js';

/**
 * A credential value, either inline or resolved lazily at runtime.
 *
 * @example
 * ```typescript
 * const googleSecret = new AppSetting(app, 'google-secret', { secret: true });
 * google({
 *   clientId:     () => googleClientId.get(),
 *   clientSecret: () => googleSecret.get(),
 * })
 * ```
 */
export type SecretLike = string | (() => string | Promise<string>);

/**
 * Common options shared by every provider helper.
 */
export interface ProviderOpts {
	clientId: SecretLike;
	clientSecret: SecretLike;
	scopes?: string[];
}

/**
 * Discriminator for provider configs, used for engine dispatch.
 *
 * - `'oidc-builtin'` — well-known OIDC providers (Google, etc.)
 * - `'oidc-custom'` — any OIDC-compliant IdP via issuer URL
 * - `'oauth2-custom'` — bare OAuth 2.0 (no ID token; userinfo-based)
 * - `'stub'` — co-deployed stub IdP for testing (no real IdP needed)
 */
export type ProviderKind = 'oidc-builtin' | 'oidc-custom' | 'oauth2-custom' | 'stub' | 'cognito-federated';

/**
 * Base shape shared by every provider config. Helper functions (`google`,
 * `github`, `customOidc`, `customOauth2`) return narrower types with the
 * `name` field branded to a literal so the literal-union inference works
 * without `as const` at the call site.
 */
export interface ProviderConfigBase {
	/** Identifier the customer passes to `getSignInUrl(provider)`. */
	readonly name: string;
	readonly kind: ProviderKind;
	readonly clientId: SecretLike;
	readonly clientSecret: SecretLike;
	readonly scopes: readonly string[];
}

export interface GoogleProvider extends ProviderConfigBase {
	readonly name: 'google';
	readonly kind: 'oidc-builtin';
	readonly issuerUrl: 'https://accounts.google.com';
}

export interface GitHubProvider extends ProviderConfigBase {
	readonly name: 'github';
	readonly kind: 'oauth2-custom';
	readonly authUrl: 'https://github.com/login/oauth/authorize';
	readonly tokenUrl: 'https://github.com/login/oauth/access_token';
	readonly userInfoUrl: 'https://api.github.com/user';
	readonly mapClaims: (raw: unknown) => MappedClaims;
}

export interface CustomOidcProvider<N extends string = string> extends ProviderConfigBase {
	readonly name: N;
	readonly kind: 'oidc-custom';
	readonly issuerUrl: string;
	readonly attributeMapping?: { email?: string; name?: string };
}

/** Generic OAuth 2.0 provider (no ID token; `mapClaims` turns userinfo into a user). */
export interface CustomOauth2Provider<N extends string = string> extends ProviderConfigBase {
	readonly name: N;
	readonly kind: 'oauth2-custom';
	readonly authUrl: string;
	readonly tokenUrl: string;
	readonly userInfoUrl: string;
	readonly mapClaims: (raw: unknown) => MappedClaims;
}

/** A local identity the stub IdP can sign in. */
export interface StubUser {
	/** The provider-local subject identifier, surfaced as the ID token `sub`. */
	readonly sub: string;
	/** The user's email address, folded into the ID token `email` claim. */
	readonly email: string;
	/** The user's display name, folded into the ID token `name` claim. */
	readonly name: string;
	/** Extra claims folded into the ID token. */
	readonly extra?: Record<string, unknown>;
}

/**
 * The authorize request handed to `stubIdp({ onAuthorize })`. `users` is the
 * configured local directory so the callback can pick from it; `loginHint` is
 * the standard OIDC `login_hint` param.
 */
export interface StubAuthorizeRequest {
	/** The stub provider name this authorize request targets. */
	readonly provider: string;
	/** The OAuth scopes requested by the client. */
	readonly scopes: readonly string[];
	/** The client's redirect URI the IdP will send the code back to. */
	readonly redirectUri: string;
	/** The opaque OAuth `state` param, round-tripped to the callback. */
	readonly state: string;
	/** The OIDC `nonce` param, echoed into the issued ID token. */
	readonly nonce: string;
	/** The standard OIDC `login_hint` param, if the client supplied one. */
	readonly loginHint?: string;
	/** The configured local directory the callback can pick a user from. */
	readonly users: readonly StubUser[];
}

/**
 * Decide what `/authorize` does for a stub provider:
 *   return a user    → sign in as them, skip the login screen
 *   return undefined → show the interactive login screen (default)
 *   throw            → deny the authorize (negative-path / user-denied)
 */
export type OnStubAuthorize = (req: StubAuthorizeRequest) => StubUser | undefined | Promise<StubUser | undefined>;

/**
 * Stub provider for testing. Co-deploys a fake IdP that auto-approves
 * sign-ins with deterministic test users.
 */
export interface StubProvider<N extends string = string> extends ProviderConfigBase {
	readonly name: N;
	readonly kind: 'stub';
	readonly onAuthorize?: OnStubAuthorize;
}

/**
 * Shape the customer's `mapClaims` returns. `providerSub` becomes the `sub`
 * component of `userId = ${iss}:${sub}`.
 */
export interface MappedClaims {
	/** The provider-local subject; becomes the `sub` in `userId = ${iss}:${sub}`. */
	providerSub: string;
	/** The user's email address, or `null` if the provider did not supply one. */
	email: string | null;
	/** The user's display name, or `null` if the provider did not supply one. */
	name: string | null;
}

/**
 * Cognito-federated provider. Delegates the OIDC flow to a Cognito User
 * Pool's Hosted UI for IdP federation.
 *
 * @example
 * ```typescript
 * import { AuthOIDC, cognitoFederated } from '@aws-blocks/bb-auth-oidc';
 *
 * const auth = new AuthOIDC(app, 'auth', {
 *   providers: [cognitoFederated({
 *     name: 'google',
 *     identityProvider: 'Google',
 *     cognitoDomain: 'myapp',
 *     region: 'us-east-1',
 *     clientId:     cognitoClientId,
 *     clientSecret: cognitoSecret,
 *   })],
 * });
 * ```
 */
export interface CognitoFederatedProvider<N extends string = string> extends ProviderConfigBase {
	readonly name: N;
	readonly kind: 'cognito-federated';
	/**
	 * Cognito domain prefix or full custom domain.
	 * Prefix: `'myapp'` → `https://myapp.auth.{region}.amazoncognito.com`
	 */
	readonly cognitoDomain: string;
	/** AWS region of the Cognito User Pool (e.g. `'us-east-1'`). */
	readonly region: string;
	/**
	 * The identity provider name as registered in Cognito.
	 * Built-in: `'Google'`, `'Facebook'`, `'LoginWithAmazon'`, `'SignInWithApple'`.
	 */
	readonly identityProvider: string;
	/** OIDC issuer URL for custom IdPs. Required when `identityProvider` is not a built-in. */
	readonly idpIssuerUrl?: string;
	/** The IdP's OAuth client ID as an AppSetting-like object. */
	readonly idpClientId: { readonly fullId: string; get(): Promise<string> };
	/** The IdP's OAuth client secret as an AppSetting-like object. */
	readonly idpClientSecret: { readonly fullId: string; get(): Promise<string> };
}

export type ProviderConfig =
	| GoogleProvider
	| GitHubProvider
	| CustomOidcProvider
	| CustomOauth2Provider
	| StubProvider
	| CognitoFederatedProvider;

/** Literal-union helper extracting provider names from the `providers` array. */
export type ProviderName<P extends readonly ProviderConfig[]> = P[number]['name'];

/**
 * The user object surfaced to application code through `requireAuth`,
 * `checkAuth`, `getCurrentUser`, and the `onSignIn` / `onSignOut` hooks.
 */
export interface OIDCUser {
	/**
	 * Stable per-human-per-IdP identifier: `${iss}:${sub}`.
	 * Derived from the verified ID token. Use as a foreign key.
	 */
	userId: string;

	/** Display identifier for UI (`name` → `email` → `sub`). */
	username: string;

	/** The configured provider name (e.g., 'google', 'okta'). */
	provider: string;

	/** The provider-local subject identifier from the verified ID token. */
	sub: string;
	/** For OAuth 2.0 providers, synthesized as `oauth2:<name>`. */
	iss: string;

	/** The user's email address, or `null` if the provider did not supply one. */
	email: string | null;

	/** The user's display name, or `null` if the provider did not supply one. */
	name: string | null;

	/** All verified ID-token claims, frozen, for provider-specific access. */
	claims: Readonly<Record<string, unknown>>;
}

/**
 * Options when building a sign-in URL. `state` is application-level and
 * distinct from the OIDC `state` param.
 */
export interface SignInUrlOptions {
	/** Opaque caller state, round-tripped via the pending-auth cookie. */
	state?: string;
}

/**
 * Internal session row shape. Customers should not reference this directly.
 */
export interface SessionRow {
	userId: string;
	refreshToken: string;
	expiresAt: number;
	claims: Readonly<Record<string, unknown>>;
	state: 'ready' | 'refreshing' | 'expired';
	refreshingSince?: number;
}

/**
 * The session store contract the engine uses internally.
 * NOT part of the public API — the BB provisions its own store.
 * @internal
 */
export interface SessionStore {
	get(key: string): Promise<SessionRow | null>;
	put(
		key: string,
		value: SessionRow,
		conditions?: { ifNotExists?: boolean; ifValueEquals?: SessionRow },
	): Promise<void>;
	delete(key: string): Promise<void>;
}

/**
 * Constructor options for `AuthOIDC`.
 */
export interface AuthOIDCOptions<
	P extends readonly ProviderConfig[] = readonly ProviderConfig[],
> {
	/** Configured IdPs, built via `google()`, `github()`, `customOidc()`, `customOauth2()`. */
	providers: P;

	/**
	 * Enable Bearer token authentication for native clients.
	 * When `true`, `/aws-blocks/auth/exchange` returns tokens in the response body
	 * and `Authorization: Bearer` is accepted for session verification.
	 * Default: `false` (cookie-only mode).
	 */
	allowBearerAuth?: boolean;

	/** Where to send users after sign-in. Relative path; defaults to `/`. */
	postSignInPath?: string;

	/** Callback path registered with each IdP. Defaults to `/aws-blocks/auth/callback`. */
	callbackPath?: string;

	/** Sign-out path. Defaults to `/aws-blocks/auth/signout`. */
	signOutPath?: string;

	/**
	 * Fires after every successful sign-in. Use this to insert a profile row,
	 * send a welcome email, gate sign-in by domain, etc.
	 *
	 * Throwing fails the sign-in (callback returns 500; no session cookie is set).
	 */
	onSignIn?: (user: OIDCUser, ctx: BlocksContext) => Promise<void>;

	/** Fires on explicit sign-out. Throwing is logged but does not prevent sign-out. */
	onSignOut?: (user: OIDCUser, ctx: BlocksContext) => Promise<void>;

	/** Optional logger for internal operations. When omitted, a default Logger at error level is created. */
	logger?: ChildLogger;

	/**
	 * Set `true` only when the frontend and API are served from different
	 * registrable domains in production (e.g. frontend on Vercel, API on
	 * AWS). Switches session cookies to `SameSite=None; Secure; Partitioned`
	 * so they survive the cross-site request. Not needed for same-origin
	 * apps or the local dev proxy, which work with the `SameSite=Lax`
	 * default.
	 *
	 * @default false
	 */
	crossDomain?: boolean;

	/**
	 * Origins the OIDC relay flow may redirect to. Required for native/CLI
	 * clients; ignored by browser flows.
	 *
	 * Each entry is a scheme + authority built via `relayOrigin()`:
	 *
	 * ```typescript
	 * allowedRelayOrigins: [
	 *   relayOrigin('myapp://auth'),
	 *   relayOrigin('https://oauth.myapp.com'),
	 * ],
	 * ```
	 *
	 * Loopback (`127.0.0.1`, `[::1]`) and same-origin are implicitly allowed.
	 * Defaults to `[]`.
	 */
	allowedRelayOrigins?: readonly RelayOrigin[];
}

/** Wire descriptor shape serialized by `toJSON()`. */
export interface OIDCClientDescriptor {
	__blocks: 'oidc/client';
	providers: string[];
	providerConfigs: Record<string, { authorizeUrl: string; clientId: string; scopes: string[]; kind: string }>;
	exchangePath: string;
	signOutPath: string;
}

/**
 * The typed client handle returned by `oidcAuthApi.getClient()`.
 * Server-side serializes via `toJSON()`; client middleware hydrates it.
 * The `Provider` generic carries configured provider names for type safety.
 */
export interface OIDCClient<Provider extends string = string> {
	/**
	 * Initiate client-initiated PKCE sign-in. Navigates the browser to the IdP;
	 * call `handleRedirectCallback()` on the page the IdP returns to.
	 *
	 * @param opts.state - Opaque app state, round-tripped to `onAuthStateChange`.
	 * @param opts.redirectPath - Path (or absolute URL) the IdP redirects back to
	 *   and that runs `handleRedirectCallback()`. This becomes the OAuth
	 *   `redirect_uri`, so it must be a page your frontend serves and a URI
	 *   registered with the provider. Defaults to the current page. Use this for
	 *   SPAs that handle the callback on a dedicated route rather than the
	 *   backend's `/aws-blocks/auth/callback`.
	 *
	 * @returns A promise that resolves once the browser navigates to the IdP and
	 *   **rejects** if PKCE setup fails. `await` it (or `.catch()`) to surface
	 *   sign-in failures instead of leaving them as unhandled rejections.
	 */
	signIn(provider: Provider, opts?: { state?: string; redirectPath?: string }): Promise<void>;
	handleRedirectCallback(): Promise<{ userId: string; username: string } | null>;
	signOut(): Promise<void>;
	onAuthStateChange(handler: (user: OIDCUser | null, meta: { state?: string } | null) => void): () => void;
	/** @internal Transferable serialization. */
	toJSON(): OIDCClientDescriptor;
}
