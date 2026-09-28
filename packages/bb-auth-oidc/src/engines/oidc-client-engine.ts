// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `OidcClientEngine` — the in-box `AuthEngine` implementation.
 *
 * Built on `openid-client` v6 (handles OIDC discovery, PKCE, state/nonce,
 * code exchange, and ID-token verification) plus `jose` (surfaced
 * indirectly for remote JWKS caching via `openid-client`).
 *
 * Always-stateful sign-in flow backed by a `SessionStore`:
 *
 * - `buildSignInUrl` — PKCE + state + nonce generation, authorize-URL
 *   construction per provider kind, pending-auth cookie issuance.
 * - `handleCallback` — validates state, performs code exchange with PKCE
 *   verifier, verifies ID token (or fetches userinfo for OAuth 2.0),
 *   writes a session row to the store and issues an opaque session-id
 *   cookie.
 * - `verifySession` — reads + validates the session cookie, looks up the
 *   row, returns immediately if fresh, or triggers a silent refresh via
 *   the CAS protocol when the access token has expired.
 * - `refreshSession` — runs the CAS-based refresh protocol with
 *   per-container coalescing and stale-lock recovery.
 * - `signOut` — clears the session cookie, evicts the row, and
 *   best-effort POSTs to the IdP's revocation endpoint.
 */

import {
	allowInsecureRequests,
	authorizationCodeGrant,
	buildAuthorizationUrl,
	calculatePKCECodeChallenge,
	ClientSecretPost,
	type Configuration,
	discovery,
	randomNonce,
	randomPKCECodeVerifier,
	randomState,
} from 'openid-client';

import { createRemoteJWKSet, decodeJwt, jwtVerify } from 'jose';

import { brandBlocksError } from '@aws-blocks/core';
import type { BlocksContext } from '@aws-blocks/core';
import type {
	AuthEngine,
	AuthorizeParams,
	AuthorizeParamsRequest,
	BearerRefreshResult,
	BuildSignInUrlInput,
	BuildSignInUrlOutput,
	ExchangeInput,
	ExchangeResult,
} from '../engine.js';
import {
	PENDING_AUTH_TTL_SECONDS,
	type PendingAuthPayload,
	readCookie,
} from '../session-cookie.js';
import type {
	CustomOauth2Provider,
	MappedClaims,
	OIDCUser,
	ProviderConfig,
	SecretLike,
	SessionStore,
} from '../types.js';
import { memoizedSecretResolver } from '../providers.js';
import { encodeState, type StatePayload } from '../state.js';
import { type RelayOrigin, validateRelay } from '../relay.js';
import { InvalidRelayError } from '../errors.js';
import { SessionManager, pendingCookieName } from './session-manager.js';

/**
 * Build the authorization-code-exchange URL for the server-initiated flow.
 *
 * Takes the **stored** callback URL (the exact `redirect_uri` sent at the
 * authorize step, derived from `BLOCKS_PUBLIC_ORIGIN` / the front door) and layers
 * on the IdP's returned query params (`code`, `state`, `iss`, …) from the actual
 * callback request. `openid-client` derives the token request's `redirect_uri`
 * from this URL's origin + path, so basing it on the stored callback URL — not
 * the raw inbound request — keeps authorize and token byte-identical. Behind
 * CloudFront/API Gateway the inbound request resolves to the execute-api host,
 * which would otherwise mismatch the public authorize `redirect_uri` and make
 * the IdP reject the exchange with `invalid_grant`.
 *
 * @internal Exported for testing only.
 */
export function buildExchangeUrl(callbackUrl: string, requestUrl: URL): URL {
	const exchangeUrl = new URL(callbackUrl);
	for (const [key, value] of requestUrl.searchParams) {
		exchangeUrl.searchParams.set(key, value);
	}
	return exchangeUrl;
}

export interface OidcClientEngineOptions {
	/** Providers configured on the `AuthOIDC` instance. */
	providers: readonly ProviderConfig[];
	/** Session store for stateful sessions + refresh. Always provisioned by the BB. */
	sessionStore: SessionStore;
	/**
	 * HMAC signing key for session + pending-auth cookies.
	 *
	 * Accepts either a literal string (used by the mock runtime with a fixed
	 * value) or a resolver closure. Resolvers fire lazily on the first
	 * cookie operation per Lambda container and are memoized thereafter —
	 * matching the `SecretLike` pattern used for provider credentials.
	 */
	cookieSecret: SecretLike;
	/** Cookie name used for the session + pending-auth cookies on this instance. */
	cookieNamePrefix: string;
	/** Attributes to set on issued cookies (Secure, Partitioned, etc.). */
	cookieAttributes: {
		secure: boolean;
		partitioned: boolean;
		sameSite: 'Strict' | 'Lax' | 'None';
		path: string;
	};
	/**
	 * Path under which the callback handler is mounted. Used to detect
	 * whether the inbound request is already the callback when we compute
	 * `callbackUrl` for the authorize redirect.
	 */
	callbackPath: string;
	/** Path the engine redirects to after a successful sign-in. Used when no app-level `state` overrides it. */
	postSignInPath: string;
	/**
	 * Per-provider issuer URL resolver. For built-in providers this returns
	 * a constant (e.g. `https://accounts.google.com`); for the mock runtime
	 * it returns the stub IdP URL derived from the current request.
	 *
	 * Parameterized so the AWS and mock runtimes can share the engine.
	 */
	resolveIssuerUrl: (provider: ProviderConfig, ctx: BlocksContext) => string;
	/**
	 * Whether to tolerate HTTP (insecure) issuer URLs. Enabled for the mock
	 * runtime only. AWS runtime always runs over HTTPS.
	 */
	allowInsecureIssuers: boolean;
	/**
	 * How long to treat a `state: 'refreshing'` row as owned before
	 * reclaiming it via CAS. Default: 30 seconds.
	 */
	staleLockTimeoutMs?: number;
	/**
	 * Validated relay-origin allowlist used by `getAuthorizeParams` to
	 * accept or reject `relayTo` values from native/CLI SDKs. Empty by
	 * default; loopback and same-origin are implicitly allowed without
	 * an entry.
	 */
	allowedRelayOrigins?: readonly RelayOrigin[];
}

/** Algorithms allowed for JWT signature verification. Never accept `none`. */
const ALLOWED_ALGORITHMS = ['RS256', 'RS384', 'RS512', 'ES256', 'ES384', 'ES512', 'PS256', 'PS384', 'PS512'] as const;

/** Maximum number of JWKS resolvers to cache. Prevents unbounded growth. */
const JWKS_CACHE_MAX_SIZE = 20;

export class OidcClientEngine implements AuthEngine {
	private readonly providerByName: Map<string, ProviderConfig>;
	private readonly clientIdResolvers: Map<string, () => Promise<string>>;
	private readonly clientSecretResolvers: Map<string, () => Promise<string>>;
	private readonly sessionManager: SessionManager;
	/** Issuer-URL-keyed cache of discovered `openid-client` Configurations. */
	private readonly configCache = new Map<string, Promise<Configuration>>();
	/** JWKS-URL-keyed cache of remote JWKS resolvers for bearer token verification. */
	private readonly jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

	constructor(private readonly options: OidcClientEngineOptions) {
		this.providerByName = new Map(options.providers.map((p) => [p.name, p]));
		this.clientIdResolvers = new Map(
			options.providers.map((p) => [p.name, memoizedSecretResolver(p.clientId)]),
		);
		this.clientSecretResolvers = new Map(
			options.providers.map((p) => [p.name, memoizedSecretResolver(p.clientSecret)]),
		);
		this.sessionManager = new SessionManager({
			sessionStore: options.sessionStore,
			cookieSecret: options.cookieSecret,
			cookieNamePrefix: options.cookieNamePrefix,
			cookieAttributes: options.cookieAttributes,
			staleLockTimeoutMs: options.staleLockTimeoutMs,
		});
	}

	async buildSignInUrl(input: BuildSignInUrlInput): Promise<BuildSignInUrlOutput> {
		const provider = this.providerByName.get(input.provider);
		if (!provider) throw providerNotConfigured(input.provider);

		const codeVerifier = randomPKCECodeVerifier();
		const codeChallenge = await calculatePKCECodeChallenge(codeVerifier);
		const state = randomState();
		const nonce = randomNonce();

		const clientId = await this.resolveClientId(input.provider);

		let authorizeUrl: string;
		if (provider.kind === 'oauth2-custom') {
			const url = new URL((provider as CustomOauth2Provider).authUrl);
			url.searchParams.set('response_type', 'code');
			url.searchParams.set('client_id', clientId);
			url.searchParams.set('redirect_uri', input.callbackUrl);
			url.searchParams.set('scope', provider.scopes.join(' '));
			url.searchParams.set('state', state);
			url.searchParams.set('code_challenge', codeChallenge);
			url.searchParams.set('code_challenge_method', 'S256');
			authorizeUrl = url.toString();
		} else {
			const config = await this.loadConfig(provider, input.ctx);
			const url = buildAuthorizationUrl(config, {
				redirect_uri: input.callbackUrl,
				scope: provider.scopes.join(' '),
				state,
				nonce,
				code_challenge: codeChallenge,
				code_challenge_method: 'S256',
			});
			authorizeUrl = url.toString();
		}

		const pending: PendingAuthPayload = {
			provider: input.provider,
			state,
			nonce,
			codeVerifier,
			callbackUrl: input.callbackUrl,
			appState: input.opts?.state,
			exp: Math.floor(Date.now() / 1000) + PENDING_AUTH_TTL_SECONDS,
		};

		const pendingCookie = await this.sessionManager.buildPendingAuthCookie(pending);

		return { url: authorizeUrl, pendingCookie };
	}

	async handleCallback(ctx: BlocksContext): Promise<OIDCUser> {
		const pending = await this.sessionManager.readPendingAuth(ctx);
		if (!pending) throw invalidCallback('missing or invalid pending-auth cookie');

		const provider = this.providerByName.get(pending.provider);
		if (!provider) throw providerNotConfigured(pending.provider);

		const returnedState = ctx.request.url.searchParams.get('state');
		if (!returnedState || returnedState !== pending.state) {
			throw invalidState('state mismatch');
		}

		let user: OIDCUser;
		let refreshToken: string | undefined;
		if (provider.kind === 'oauth2-custom') {
			const result = await this.exchangeOAuth2(provider as CustomOauth2Provider, pending, ctx);
			user = result.user;
			refreshToken = result.refreshToken;
		} else {
			const result = await this.exchangeOidc(provider, pending, ctx);
			user = result.user;
			refreshToken = result.refreshToken;
		}

		await this.sessionManager.writeStatefulSession(user, refreshToken, ctx);
		this.sessionManager.clearPendingAuthCookie(ctx);

		return user;
	}

	/**
	 * Handle a client-initiated PKCE exchange. The client generated PKCE
	 * locally, navigated directly to the IdP, received the code back, and
	 * is now POSTing the code + verifier to the server.
	 *
	 * The server exchanges the code using the client-provided verifier +
	 * its own client_secret, verifies the ID token, writes the session,
	 * and issues the session cookie on the response.
	 */
	async handleExchange(input: ExchangeInput, ctx: BlocksContext): Promise<ExchangeResult> {
		const provider = this.providerByName.get(input.provider);
		if (!provider) throw providerNotConfigured(input.provider);

		// Reuse the exchangeOidc / exchangeOAuth2 code paths.
		const pending: PendingAuthPayload = {
			provider: input.provider,
			state: input.state,
			nonce: input.nonce,
			codeVerifier: input.verifier,
			callbackUrl: input.callbackUrl,
			exp: Math.floor(Date.now() / 1000) + PENDING_AUTH_TTL_SECONDS,
		};

		const syntheticUrl = new URL(input.callbackUrl);
		syntheticUrl.searchParams.set('code', input.code);
		syntheticUrl.searchParams.set('state', input.state);
		if (input.iss) syntheticUrl.searchParams.set('iss', input.iss);

		const exchangeCtx: BlocksContext = {
			...ctx,
			request: {
				...ctx.request,
				url: syntheticUrl,
			},
		};

		let user: OIDCUser;
		let refreshToken: string | undefined;
		let accessToken: string | undefined;
		let expiresIn: number | undefined;
		if (provider.kind === 'oauth2-custom') {
			const result = await this.exchangeOAuth2(provider as CustomOauth2Provider, pending, exchangeCtx);
			user = result.user;
			refreshToken = result.refreshToken;
			accessToken = result.accessToken;
			expiresIn = result.expiresIn;
		} else {
			// Use real ctx for config/discovery (correct host), synthetic URL for the code.
			const config = await this.loadConfig(provider, ctx);
			let tokens: Awaited<ReturnType<typeof authorizationCodeGrant>>;
			try {
				tokens = await authorizationCodeGrant(config, syntheticUrl, {
					expectedState: pending.state,
					expectedNonce: pending.nonce,
					pkceCodeVerifier: pending.codeVerifier,
					idTokenExpected: true,
				});
			} catch (err) {
				throw idpError(`code exchange failed: ${describeError(err)}`);
			}
			const claims = tokens.claims();
			if (!claims) throw idpError('code exchange did not return an ID token');
			if (!tokens.id_token) throw idpError('code exchange did not include `id_token`');
			user = claimsToUser(claims as Record<string, unknown>, provider.name);
			refreshToken = tokens.refresh_token;
			accessToken = tokens.access_token;
			expiresIn = typeof tokens.expires_in === 'number' ? tokens.expires_in : undefined;
		}

		await this.sessionManager.writeStatefulSession(user, refreshToken, ctx);

		return { user, accessToken, refreshToken, expiresIn };
	}

	/**
	 * Return the public authorize parameters for a provider so the client
	 * can build the authorize URL locally with its own PKCE.
	 *
	 * If `request` is supplied, the caller is on the relay path: validate
	 * `relayTo`, sign `csrf`/`relay`/`app` into a state envelope, and
	 * include it (plus a fresh `nonce`) in the response. Otherwise the
	 * server-initiated GET path returns just authorize URL + clientId + scopes.
	 */
	async getAuthorizeParams(
		provider: string,
		ctx: BlocksContext,
		request?: AuthorizeParamsRequest,
	): Promise<AuthorizeParams> {
		const providerConfig = this.providerByName.get(provider);
		if (!providerConfig) throw providerNotConfigured(provider);

		const clientId = await this.resolveClientId(provider);

		let authorizeUrl: string;
		if (providerConfig.kind === 'oauth2-custom') {
			authorizeUrl = (providerConfig as CustomOauth2Provider).authUrl;
		} else {
			const config = await this.loadConfig(providerConfig, ctx);
			const serverMetadata = config.serverMetadata();
			const endpoint = serverMetadata.authorization_endpoint;
			if (!endpoint) {
				throw idpError(`provider '${provider}' discovery did not return an authorization_endpoint`);
			}
			authorizeUrl = endpoint;
		}

		// Server-initiated GET path: no relay, no state envelope.
		if (!request) {
			return {
				authorizeUrl,
				clientId,
				scopes: providerConfig.scopes,
				kind: providerConfig.kind,
			};
		}

		// Relay path: validate `relayTo` (when provided) against the
		// allowlist, sign the envelope.
		let signedRelay: string | undefined;
		if (request.relayTo !== undefined) {
			const validation = validateRelay(request.relayTo, {
				allowList: this.options.allowedRelayOrigins ?? [],
				sameOrigin: ctx.request.url,
			});
			if (!validation.allowed) {
				throw new InvalidRelayError(
					validation.reason,
					(this.options.allowedRelayOrigins ?? []) as readonly string[],
				);
			}
			signedRelay = request.relayTo;
		}

		const payload: StatePayload = {
			v: 1,
			csrf: request.csrf,
			...(signedRelay !== undefined && { relay: signedRelay }),
			...(request.appState !== undefined && { app: request.appState }),
		};

		const secret = await this.sessionManager.resolveCookieSecret();
		const state = encodeState(payload, secret);

		// Nonce only matters to OIDC providers (where the IdP echoes it
		// into the ID token claim and `openid-client` verifies the
		// match). For OAuth2-only providers it's a meaningless field —
		// omit so the SDK can decide whether to include it.
		const nonce = providerConfig.kind === 'oauth2-custom' ? undefined : randomNonce();

		return {
			authorizeUrl,
			clientId,
			scopes: providerConfig.scopes,
			kind: providerConfig.kind,
			state,
			nonce,
		};
	}

	/**
	 * Verify a Bearer access token by cryptographically validating its
	 * signature against the IdP's JWKS endpoint. For OIDC providers, we
	 * discover the JWKS URI, verify signature + standard claims. For
	 * OAuth2-only providers, we call the userinfo endpoint to validate.
	 *
	 * @returns The authenticated user, or `null` if the token is invalid.
	 */
	async verifyAccessToken(token: string, ctx: BlocksContext): Promise<OIDCUser | null> {
		try {
			// Match the token's issuer to a configured OIDC provider.
			// We need to peek at the unverified payload to find the issuer,
			// then verify the full token against that issuer's JWKS.
			const parts = token.split('.');
			if (parts.length !== 3) return null;
			let unverifiedIss: string | undefined;
			try {
				const payloadJson = Buffer.from(parts[1], 'base64url').toString('utf8');
				unverifiedIss = JSON.parse(payloadJson).iss;
			} catch {
				return null;
			}
			if (!unverifiedIss) return null;

			let matchedProvider: ProviderConfig | undefined;
			let resolvedIssuerUrl: string | undefined;
			for (const provider of this.options.providers) {
				if (provider.kind === 'oidc-builtin' || provider.kind === 'oidc-custom') {
					const issuerUrl = (provider as { issuerUrl: string }).issuerUrl;
					if (unverifiedIss === issuerUrl || unverifiedIss === issuerUrl + '/') {
						matchedProvider = provider;
						resolvedIssuerUrl = issuerUrl;
						break;
					}
				} else if (provider.kind === 'stub') {
					// Stubs derive their issuer URL from the request context.
					const issuerUrl = this.options.resolveIssuerUrl(provider, ctx);
					if (unverifiedIss === issuerUrl || unverifiedIss === issuerUrl + '/') {
						matchedProvider = provider;
						resolvedIssuerUrl = issuerUrl;
						break;
					}
				}
			}

			if (!matchedProvider || !resolvedIssuerUrl) return null;

			// Discover JWKS URI from the provider's OIDC configuration.
			const config = await this.loadConfig(matchedProvider, ctx);
			const metadata = config.serverMetadata();
			const jwksUri = metadata.jwks_uri;
			if (!jwksUri) return null;

			// Reject non-HTTPS JWKS URIs unless insecure issuers are allowed (mock only).
			const jwksUrl = new URL(jwksUri);
			if (!this.options.allowInsecureIssuers && jwksUrl.protocol !== 'https:') return null;

			// Get or create a cached JWKS resolver for this endpoint.
			let jwks = this.jwksCache.get(jwksUri);
			if (!jwks) {
				if (this.jwksCache.size >= JWKS_CACHE_MAX_SIZE) {
					const oldest = this.jwksCache.keys().next().value!;
					this.jwksCache.delete(oldest);
				}
				jwks = createRemoteJWKSet(jwksUrl);
				this.jwksCache.set(jwksUri, jwks);
			}

			// Verify signature, exp, nbf, and issuer.
			const clientId = await this.resolveClientId(matchedProvider.name);
			const { payload } = await jwtVerify(token, jwks, {
				algorithms: ALLOWED_ALGORITHMS as unknown as string[],
				issuer: [resolvedIssuerUrl, resolvedIssuerUrl + '/'],
				audience: clientId,
				clockTolerance: 30,
			});

			return claimsToUser(payload as Record<string, unknown>, matchedProvider.name);
		} catch {
			return null;
		}
	}

	async verifySession(ctx: BlocksContext): Promise<OIDCUser | null> {
		return this.sessionManager.verifyStatefulSession(ctx, (refreshToken, providerName) =>
			this.callTokenRefreshForProvider(refreshToken, providerName, ctx),
		);
	}

	async refreshSession(ctx: BlocksContext): Promise<OIDCUser | null> {
		return this.sessionManager.forceRefresh(ctx, (refreshToken, providerName) =>
			this.callTokenRefreshForProvider(refreshToken, providerName, ctx),
		);
	}

	async refreshBearerTokens(
		input: { refreshToken: string; provider: string },
		ctx: BlocksContext,
	): Promise<BearerRefreshResult | null> {
		const provider = this.providerByName.get(input.provider);
		if (!provider) return null;
		try {
			const clientId = await this.resolveClientId(provider.name);
			const clientSecret = await this.resolveClientSecret(provider.name);

			let tokenUrl: string;
			if (provider.kind === 'oauth2-custom') {
				tokenUrl = (provider as CustomOauth2Provider).tokenUrl;
			} else {
				const config = await this.loadConfig(provider, ctx);
				const metadata = config.serverMetadata();
				tokenUrl = metadata.token_endpoint!;
			}

			const body = new URLSearchParams({
				grant_type: 'refresh_token',
				refresh_token: input.refreshToken,
				client_id: clientId,
				client_secret: clientSecret,
			});
			const resp = await fetch(tokenUrl, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/x-www-form-urlencoded',
					Accept: 'application/json',
				},
				body,
			});
			if (!resp.ok) return null;
			const json = (await resp.json()) as {
				access_token?: string;
				expires_in?: number;
				refresh_token?: string;
			};
			if (!json.access_token) return null;
			return {
				accessToken: json.access_token,
				refreshToken: json.refresh_token ?? input.refreshToken,
				expiresIn: typeof json.expires_in === 'number' ? json.expires_in : 3600,
			};
		} catch {
			return null;
		}
	}

	async signOut(ctx: BlocksContext): Promise<void> {
		const { refreshToken, provider } = await this.sessionManager.signOutSession(ctx);
		if (refreshToken && provider) {
			await this.bestEffortRevoke(provider, refreshToken, ctx);
		}
	}

	async resolveCookieSecret(): Promise<string> {
		return this.sessionManager.resolveCookieSecret();
	}

	hasPendingAuthCookie(ctx: BlocksContext): boolean {
		const cookieHeader = ctx.request.headers.get('cookie');
		return !!readCookie(cookieHeader, pendingCookieName(this.options.cookieNamePrefix));
	}

	private async loadConfig(provider: ProviderConfig, ctx: BlocksContext): Promise<Configuration> {
		const issuerUrl = this.options.resolveIssuerUrl(provider, ctx);
		const cacheKey = `${provider.name}::${issuerUrl}`;
		let cached = this.configCache.get(cacheKey);
		if (cached) return cached;
		cached = this.discoverConfig(provider, issuerUrl);
		this.configCache.set(cacheKey, cached);
		try {
			return await cached;
		} catch (err) {
			this.configCache.delete(cacheKey); // don't memoize failures
			throw err;
		}
	}

	private async discoverConfig(provider: ProviderConfig, issuerUrl: string): Promise<Configuration> {
		const clientId = await this.resolveClientId(provider.name);
		const clientSecret = await this.resolveClientSecret(provider.name);
		const config = await discovery(
			new URL(issuerUrl),
			clientId,
			undefined,
			ClientSecretPost(clientSecret),
			// `execute` hooks run during discovery, so HTTP issuers work in the
			// mock runtime where the stub IdP is served over HTTP.
			this.options.allowInsecureIssuers
				? { execute: [allowInsecureRequests] }
				: undefined,
		);
		return config;
	}

	private async exchangeOidc(
		provider: ProviderConfig,
		pending: PendingAuthPayload,
		ctx: BlocksContext,
	): Promise<{ user: OIDCUser; refreshToken: string | undefined; accessToken: string | undefined; expiresIn: number | undefined }> {
		const config = await this.loadConfig(provider, ctx);
		// Build the code-exchange URL from the *stored* callback URL — the exact
		// redirect_uri sent at the authorize step — carrying the IdP's returned
		// query params (code/state/iss). `openid-client` derives the token
		// request's `redirect_uri` from this URL, so it must byte-match what
		// authorize sent. Using the raw `ctx.request.url` breaks behind
		// CloudFront/API Gateway: the callback request resolves to the execute-api
		// host, not the public callback origin, so the token `redirect_uri` no
		// longer matches authorize → the IdP returns `invalid_grant`. (PKCE's
		// `handleExchange` avoids this the same way, via its `syntheticUrl`.)
		const exchangeUrl = buildExchangeUrl(pending.callbackUrl, ctx.request.url);
		let tokens: Awaited<ReturnType<typeof authorizationCodeGrant>>;
		try {
			tokens = await authorizationCodeGrant(config, exchangeUrl, {
				expectedState: pending.state,
				expectedNonce: pending.nonce,
				pkceCodeVerifier: pending.codeVerifier,
				idTokenExpected: true,
			});
		} catch (err) {
			throw idpError(`code exchange failed: ${describeError(err)}`);
		}
		const claims = tokens.claims();
		if (!claims) throw idpError('code exchange did not return an ID token');
		if (!tokens.id_token) throw idpError('code exchange did not include `id_token`');
		const user = claimsToUser(claims as Record<string, unknown>, provider.name);
		return {
			user,
			refreshToken: tokens.refresh_token,
			accessToken: tokens.access_token,
			expiresIn: typeof tokens.expires_in === 'number' ? tokens.expires_in : undefined,
		};
	}

	private async exchangeOAuth2(
		provider: CustomOauth2Provider,
		pending: PendingAuthPayload,
		ctx: BlocksContext,
	): Promise<{ user: OIDCUser; refreshToken: string | undefined; accessToken: string | undefined; expiresIn: number | undefined }> {
		const code = ctx.request.url.searchParams.get('code');
		if (!code) throw invalidCallback('missing `code` param');

		const clientId = await this.resolveClientId(provider.name);
		const clientSecret = await this.resolveClientSecret(provider.name);

		const tokenBody = new URLSearchParams({
			grant_type: 'authorization_code',
			code,
			redirect_uri: pending.callbackUrl,
			client_id: clientId,
			client_secret: clientSecret,
			code_verifier: pending.codeVerifier,
		});
		const tokenResp = await fetch(provider.tokenUrl, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded',
				Accept: 'application/json',
			},
			body: tokenBody,
		});
		if (!tokenResp.ok) {
			throw idpError(`token endpoint ${tokenResp.status} ${await tokenResp.text().catch(() => '')}`);
		}
		const tokenJson = (await tokenResp.json()) as { access_token?: string; refresh_token?: string; expires_in?: number };
		if (!tokenJson.access_token) throw idpError('token response missing access_token');

		const userInfoResp = await fetch(provider.userInfoUrl, {
			headers: { Authorization: `Bearer ${tokenJson.access_token}` },
		});
		if (!userInfoResp.ok) {
			throw idpError(`userinfo ${userInfoResp.status} ${await userInfoResp.text().catch(() => '')}`);
		}
		const raw = await userInfoResp.json();
		const mapped = applyMapClaims(provider, raw);

		const iss = `oauth2:${provider.name}`;
		const now = Math.floor(Date.now() / 1000);
		const synthClaims = {
			iss,
			sub: mapped.providerSub,
			email: mapped.email,
			name: mapped.name,
			exp: now + 3600,
			iat: now,
			__raw_userinfo: raw,
		};
		return {
			user: claimsToUser(synthClaims, provider.name),
			refreshToken: tokenJson.refresh_token,
			accessToken: tokenJson.access_token,
			expiresIn: tokenJson.expires_in,
		};
	}

	/**
	 * Refresh a token for a specific provider.
	 */
	private async callTokenRefreshForProvider(
		refreshToken: string,
		providerName: string,
		ctx: BlocksContext,
	): Promise<{ refreshToken: string; exp: number; claims: Readonly<Record<string, unknown>> }> {
		const provider = this.providerByName.get(providerName);
		if (!provider) throw idpError(`refresh failed: provider '${providerName}' not found`);
		return this.callTokenRefresh(provider, refreshToken, ctx);
	}

	/**
	 * Call the IdP's token endpoint with a refresh grant. Returns the
	 * rotated refresh token, new access-token expiry, and verified claims.
	 */
	private async callTokenRefresh(
		provider: ProviderConfig,
		refreshToken: string,
		ctx: BlocksContext,
	): Promise<{ refreshToken: string; exp: number; claims: Readonly<Record<string, unknown>> }> {
		if (!refreshToken) throw idpError('missing refresh token');
		const clientId = await this.resolveClientId(provider.name);
		const clientSecret = await this.resolveClientSecret(provider.name);

		let tokenUrl: string;
		if (provider.kind === 'oauth2-custom') {
			tokenUrl = (provider as CustomOauth2Provider).tokenUrl;
		} else {
			const config = await this.loadConfig(provider, ctx);
			const metadata = config.serverMetadata();
			tokenUrl = metadata.token_endpoint!;
		}

		const body = new URLSearchParams({
			grant_type: 'refresh_token',
			refresh_token: refreshToken,
			client_id: clientId,
			client_secret: clientSecret,
		});
		const resp = await fetch(tokenUrl, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded',
				Accept: 'application/json',
			},
			body,
		});
		if (!resp.ok) {
			const text = await resp.text().catch(() => '');
			throw idpError(`refresh_token grant failed: ${resp.status} ${text}`);
		}
		const json = (await resp.json()) as {
			access_token?: string;
			expires_in?: number;
			refresh_token?: string;
			id_token?: string;
		};
		if (!json.access_token) throw idpError('refresh response missing access_token');
		// Many IdPs rotate the refresh token; some (Cognito without rotation)
		// keep the same value and omit the field. Preserve the old token when
		// no rotation is returned.
		const rotated = json.refresh_token ?? refreshToken;
		const ttl = typeof json.expires_in === 'number' ? json.expires_in : 3600;
		const exp = Math.floor(Date.now() / 1000) + ttl;
		let claims: Readonly<Record<string, unknown>>;
		if (json.id_token) {
			try {
				claims = decodeJwt(json.id_token) as Readonly<Record<string, unknown>>;
			} catch {
				claims = {};
			}
		} else {
			claims = {};
		}
		return { refreshToken: rotated, exp, claims };
	}

	private async bestEffortRevoke(providerName: string, refreshToken: string, ctx: BlocksContext): Promise<void> {
		const provider = this.providerByName.get(providerName);
		if (!provider || !refreshToken) return;
		if (provider.kind === 'oauth2-custom') return; // no standard revocation endpoint
		try {
			const config = await this.loadConfig(provider, ctx);
			const metadata = config.serverMetadata();
			const revocationEndpoint = metadata.revocation_endpoint;
			if (!revocationEndpoint) return;
			const clientId = await this.resolveClientId(provider.name);
			const clientSecret = await this.resolveClientSecret(provider.name);
			const body = new URLSearchParams({
				token: refreshToken,
				token_type_hint: 'refresh_token',
				client_id: clientId,
				client_secret: clientSecret,
			});
			await fetch(revocationEndpoint, {
				method: 'POST',
				headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
				body,
			});
		} catch {
		}
	}

	private async resolveClientId(providerName: string): Promise<string> {
		const resolver = this.clientIdResolvers.get(providerName);
		if (!resolver) throw providerNotConfigured(providerName);
		try {
			return await resolver();
		} catch (err) {
			throw providerNotConfigured(`${providerName}: clientId resolver threw: ${describeError(err)}`);
		}
	}

	private async resolveClientSecret(providerName: string): Promise<string> {
		const resolver = this.clientSecretResolvers.get(providerName);
		if (!resolver) throw providerNotConfigured(providerName);
		try {
			return await resolver();
		} catch (err) {
			throw providerNotConfigured(`${providerName}: clientSecret resolver threw: ${describeError(err)}`);
		}
	}

}

function applyMapClaims(provider: CustomOauth2Provider, raw: unknown): MappedClaims {
	const mapped = provider.mapClaims(raw);
	if (!mapped || typeof mapped.providerSub !== 'string' || mapped.providerSub.length === 0) {
		throw idpError('mapClaims did not return a valid providerSub');
	}
	return mapped;
}

function claimsToUser(claims: Record<string, unknown>, providerName: string): OIDCUser {
	const sub = String(claims.sub ?? '');
	const iss = String(claims.iss ?? '');
	const email = typeof claims.email === 'string' ? claims.email : null;
	const name = typeof claims.name === 'string' ? claims.name : null;
	const userId = iss && sub ? `${iss}:${sub}` : sub;
	const username = name ?? email ?? sub;
	return {
		userId,
		username,
		provider: providerName,
		sub,
		iss,
		email,
		name,
		claims,
	};
}

function describeError(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function blocksError(name: string, message: string): Error {
	const err = new Error(message);
	err.name = name;
	return brandBlocksError(err);
}

function invalidState(msg: string): Error {
	return blocksError('InvalidStateException', `invalid OIDC state: ${msg}`);
}

function invalidCallback(msg: string): Error {
	return blocksError('InvalidCallbackException', `invalid OIDC callback: ${msg}`);
}

function idpError(msg: string): Error {
	return blocksError('IdpErrorException', `IdP error: ${msg}`);
}

function providerNotConfigured(msg: string): Error {
	return blocksError('ProviderNotConfiguredException', `provider not configured: ${msg}`);
}
