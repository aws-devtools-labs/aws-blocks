// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `CognitoFederationEngine` — delegates OIDC flows to a Cognito User Pool.
 *
 * Instead of talking to IdPs directly (like `OidcClientEngine`), this engine
 * redirects users to Cognito's Hosted UI which handles the IdP federation.
 * Cognito exchanges the code, verifies tokens, and returns its own tokens
 * to our callback. We then extract the original IdP identity from Cognito's
 * `identities` claim to produce the same `OIDCUser` shape.
 *
 * **Why use this over self-hosted?**
 * - Cognito owns the security surface (SOC 2, HIPAA-eligible)
 * - No `openid-client` / JWKS / PKCE code runs in your Lambda
 * - Cognito handles token rotation, MFA (if configured), and brute-force protection
 *
 * **Tradeoffs:**
 * - Adds a Cognito User Pool to your stack (1-3 min deploy time)
 * - Cognito MAU pricing applies
 * - userId mapping uses `identities` claim (stable across engine switches)
 *
 * The mock runtime never uses this engine — it always uses `OidcClientEngine`
 * against the stub IdP. This engine only runs in the AWS runtime when
 * `cognitoFederated()` providers are configured.
 */

import { brandBlocksError } from '@aws-blocks/core';
import type { BlocksContext } from '@aws-blocks/core';
import { createRemoteJWKSet, jwtVerify } from 'jose';
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
	CognitoFederatedProvider,
	OIDCUser,
	ProviderConfig,
} from '../types.js';
import { type SessionManager, pendingCookieName } from './session-manager.js';
import { type RelayOrigin, validateRelay } from '../relay.js';
import { InvalidRelayError } from '../errors.js';
import { encodeState, type StatePayload } from '../state.js';

export interface CognitoFederationEngineOptions {
	/** Providers configured on the `AuthOIDC` instance (only `cognito-federated` kind). */
	providers: readonly ProviderConfig[];
	/** Shared session manager (cookies, KVStore, CAS refresh). */
	sessionManager: SessionManager;
	/**
	 * Cognito App Client ID resolver. The App Client is auto-created by CDK
	 * and its ID is injected via env var. The customer never sees this.
	 */
	cognitoClientId: () => string;
	/**
	 * Cognito App Client Secret resolver. Optional — public clients don't
	 * have a secret. Auto-created by CDK and injected via env var.
	 */
	cognitoClientSecret?: () => string;
	/**
	 * Validated relay-origin allowlist used by `getAuthorizeParams` to
	 * accept or reject `relayTo` values from native/CLI SDKs. Empty by
	 * default; loopback and same-origin are implicitly allowed without
	 * an entry.
	 */
	allowedRelayOrigins?: readonly RelayOrigin[];
	/**
	 * Cognito User Pool ID resolver. Used to construct the expected issuer
	 * URL for bearer token verification. Without this, only the region prefix
	 * is validated — which allows tokens from ANY pool in the same region.
	 *
	 * Expected format: `{region}_{poolSuffix}` (e.g. `us-east-1_abc123XYZ`).
	 * Injected via env var by CDK.
	 */
	cognitoUserPoolId: () => string;
}

/** Algorithms allowed for JWT signature verification. Never accept `none`. */
const ALLOWED_ALGORITHMS = ['RS256'] as const;

/** Maximum number of JWKS resolvers to cache. Prevents unbounded growth. */
const JWKS_CACHE_MAX_SIZE = 20;

export class CognitoFederationEngine implements AuthEngine {
	private readonly providerByName: Map<string, CognitoFederatedProvider>;
	private readonly sessionManager: SessionManager;
	private readonly cognitoClientId: () => string;
	private readonly cognitoClientSecret?: () => string;
	private readonly cognitoUserPoolId: () => string;
	/** JWKS-URL-keyed cache of remote JWKS resolvers for bearer token verification. */
	private readonly jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

	constructor(private readonly options: CognitoFederationEngineOptions) {
		this.providerByName = new Map(
			options.providers
				.filter((p): p is CognitoFederatedProvider => p.kind === 'cognito-federated')
				.map((p) => [p.name, p]),
		);
		this.sessionManager = options.sessionManager;
		this.cognitoClientId = options.cognitoClientId;
		this.cognitoClientSecret = options.cognitoClientSecret;
		this.cognitoUserPoolId = options.cognitoUserPoolId;
	}

	async buildSignInUrl(input: BuildSignInUrlInput): Promise<BuildSignInUrlOutput> {
		const provider = this.providerByName.get(input.provider);
		if (!provider) throw engineError(`Provider not configured: ${input.provider}`);

		const state = randomState();
		const codeVerifier = randomState(); // 32 random bytes, base64url
		const codeChallenge = await s256(codeVerifier);
		const clientId = this.cognitoClientId();

		const baseUrl = cognitoBaseUrl(provider);
		const authorizeUrl = new URL(`${baseUrl}/oauth2/authorize`);
		authorizeUrl.searchParams.set('response_type', 'code');
		authorizeUrl.searchParams.set('client_id', clientId);
		authorizeUrl.searchParams.set('redirect_uri', input.callbackUrl);
		authorizeUrl.searchParams.set('scope', provider.scopes.join(' '));
		authorizeUrl.searchParams.set('state', state);
		authorizeUrl.searchParams.set('identity_provider', provider.identityProvider);
		authorizeUrl.searchParams.set('code_challenge', codeChallenge);
		authorizeUrl.searchParams.set('code_challenge_method', 'S256');

		const pending: PendingAuthPayload = {
			provider: input.provider,
			state,
			nonce: '',
			codeVerifier,
			callbackUrl: input.callbackUrl,
			appState: input.opts?.state,
			exp: Math.floor(Date.now() / 1000) + PENDING_AUTH_TTL_SECONDS,
		};

		const pendingCookie = await this.sessionManager.buildPendingAuthCookie(pending);

		return { url: authorizeUrl.toString(), pendingCookie };
	}

	async handleCallback(ctx: BlocksContext): Promise<OIDCUser> {
		const pending = await this.sessionManager.readPendingAuth(ctx);
		if (!pending) throw engineError('Missing or invalid pending-auth cookie');

		const returnedState = ctx.request.url.searchParams.get('state');
		if (!returnedState || returnedState !== pending.state) {
			throw engineError('State mismatch');
		}

		const code = ctx.request.url.searchParams.get('code');
		if (!code) throw engineError('Missing code parameter');

		const tokens = await this.exchangeCode(code, pending.callbackUrl, pending.provider, pending.codeVerifier);
		const user = extractCognitoFederatedUser(tokens.idToken, pending.provider);

		await this.sessionManager.writeStatefulSession(user, tokens.refreshToken, ctx);
		this.sessionManager.clearPendingAuthCookie(ctx);

		return user;
	}

	async handleExchange(input: ExchangeInput, ctx: BlocksContext): Promise<ExchangeResult> {
		const provider = this.providerByName.get(input.provider);
		if (!provider) throw engineError(`Provider not configured: ${input.provider}`);

		const tokens = await this.exchangeCodeWithVerifier(
			input.code,
			input.callbackUrl,
			input.provider,
			input.verifier,
		);
		const user = extractCognitoFederatedUser(tokens.idToken, input.provider);

		await this.sessionManager.writeStatefulSession(user, tokens.refreshToken, ctx);

		return {
			user,
			accessToken: tokens.accessToken,
			refreshToken: tokens.refreshToken || undefined,
			expiresIn: 3600,
		};
	}

	async getAuthorizeParams(provider: string, ctx: BlocksContext, request?: AuthorizeParamsRequest): Promise<AuthorizeParams> {
		const providerConfig = this.providerByName.get(provider);
		if (!providerConfig) throw engineError(`Provider not configured: ${provider}`);

		const clientId = this.cognitoClientId();
		const baseUrl = cognitoBaseUrl(providerConfig);

		const authorizeUrl = new URL(`${baseUrl}/oauth2/authorize`);
		authorizeUrl.searchParams.set('identity_provider', providerConfig.identityProvider);

		// Server-initiated GET path: no relay, no state envelope.
		if (!request) {
			return {
				authorizeUrl: authorizeUrl.toString(),
				clientId,
				scopes: [...providerConfig.scopes],
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

		// Cognito does not verify a nonce claim — it skips ID-token
		// verification entirely because Cognito already verified the token
		// (D6). Returning a nonce would advertise a replay guarantee the
		// engine doesn't provide. Omit it so SDK authors don't assume it's
		// checked. (Contrast: OidcClientEngine returns a fresh nonce because
		// openid-client verifies the nonce claim against the ID token.)
		return {
			authorizeUrl: authorizeUrl.toString(),
			clientId,
			scopes: [...providerConfig.scopes],
			kind: providerConfig.kind,
			state,
			nonce: undefined,
		};
	}

	async verifySession(ctx: BlocksContext): Promise<OIDCUser | null> {
		return this.sessionManager.verifyStatefulSession(ctx, (refreshToken, _providerName) =>
			this.refreshViaCognito(refreshToken),
		);
	}

	/**
	 * Verify a Bearer access token by cryptographically validating its
	 * signature against Cognito's JWKS endpoint.
	 *
	 * The token's `iss` claim identifies the User Pool
	 * (`https://cognito-idp.{region}.amazonaws.com/{poolId}`) and we
	 * validate it matches the configured user pool ID exactly — not just
	 * the region prefix. This prevents tokens from attacker-controlled
	 * pools in the same region from being accepted.
	 *
	 * @returns The authenticated user, or `null` if the token is invalid.
	 */
	async verifyAccessToken(token: string, _ctx: BlocksContext): Promise<OIDCUser | null> {
		try {
			// Peek at the unverified payload to extract issuer for JWKS discovery.
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

			// Validate the issuer matches the EXACT expected Cognito User Pool.
			// Construct the expected issuer from region + user pool ID.
			const firstProvider = [...this.providerByName.values()][0];
			if (!firstProvider) return null;
			const userPoolId = this.cognitoUserPoolId();
			const expectedIssuer = `https://cognito-idp.${firstProvider.region}.amazonaws.com/${userPoolId}`;
			if (unverifiedIss !== expectedIssuer) return null;

			// Construct the JWKS URI from the validated issuer.
			const jwksUri = `${expectedIssuer}/.well-known/jwks.json`;
			const jwksUrl = new URL(jwksUri);

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

			// Verify signature, exp, nbf, and issuer cryptographically.
			const clientId = this.cognitoClientId();
			const { payload } = await jwtVerify(token, jwks, {
				algorithms: ALLOWED_ALGORITHMS as unknown as string[],
				issuer: expectedIssuer,
				clockTolerance: 30,
			});

			// Cognito access tokens always include `client_id` (not `aud`).
			// Reject if missing or mismatched — a well-formed Cognito token
			// always has this claim.
			const tokenClientId = payload.client_id as string | undefined;
			if (!tokenClientId || tokenClientId !== clientId) return null;

			// Extract from identities claim when present (federated user)
			const identities = payload.identities as Array<{
				providerName: string;
				userId: string;
				providerType: string;
			}> | undefined;

			let iss: string;
			let sub: string;
			if (identities && identities.length > 0) {
				iss = cognitoProviderTypeToIss(identities[0].providerType, identities[0].providerName);
				sub = identities[0].userId;
			} else {
				iss = (payload.iss as string) ?? 'cognito';
				sub = (payload.sub as string) ?? '';
			}

			const email = typeof payload.email === 'string' ? payload.email : null;
			const name = typeof payload.name === 'string' ? payload.name : null;
			const username = name ?? email ?? sub;

			return {
				userId: `${iss}:${sub}`,
				username,
				provider: 'cognito',
				sub,
				iss,
				email,
				name,
				claims: payload as Record<string, unknown>,
			};
		} catch {
			return null;
		}
	}

	async refreshSession(ctx: BlocksContext): Promise<OIDCUser | null> {
		return this.sessionManager.forceRefresh(ctx, (refreshToken, _providerName) =>
			this.refreshViaCognito(refreshToken),
		);
	}

	async refreshBearerTokens(
		input: { refreshToken: string; provider: string },
		_ctx: BlocksContext,
	): Promise<BearerRefreshResult | null> {
		if (!input.refreshToken) return null;
		const provider = this.providerByName.get(input.provider);
		if (!provider) return null;

		try {
			const baseUrl = cognitoBaseUrl(provider);
			const clientId = this.cognitoClientId();
			const body = new URLSearchParams({
				grant_type: 'refresh_token',
				refresh_token: input.refreshToken,
				client_id: clientId,
			});
			const headers: Record<string, string> = {
				'Content-Type': 'application/x-www-form-urlencoded',
			};
			const clientSecret = this.cognitoClientSecret?.();
			if (clientSecret) {
				const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
				headers['Authorization'] = `Basic ${basicAuth}`;
			}
			const resp = await fetch(`${baseUrl}/oauth2/token`, { method: 'POST', headers, body });
			if (!resp.ok) return null;
			const json = await resp.json() as Record<string, unknown>;
			if (!json.access_token) return null;
			return {
				accessToken: json.access_token as string,
				refreshToken: (json.refresh_token as string) ?? input.refreshToken,
				expiresIn: typeof json.expires_in === 'number' ? json.expires_in : 3600,
			};
		} catch {
			return null;
		}
	}

	async signOut(ctx: BlocksContext): Promise<void> {
		const { refreshToken } = await this.sessionManager.signOutSession(ctx);
		if (refreshToken) {
			await this.bestEffortRevoke(refreshToken);
		}
	}

	async resolveCookieSecret(): Promise<string> {
		return this.sessionManager.resolveCookieSecret();
	}

	hasPendingAuthCookie(ctx: BlocksContext): boolean {
		const cookieHeader = ctx.request.headers.get('cookie');
		return !!readCookie(cookieHeader, pendingCookieName(this.sessionManager.cookieNamePrefix));
	}

	/**
	 * Exchange an authorization code at Cognito's token endpoint.
	 */
	private async exchangeCode(
		code: string,
		redirectUri: string,
		providerName: string,
		codeVerifier: string,
	): Promise<{ idToken: string; accessToken: string; refreshToken: string }> {
		const provider = this.providerByName.get(providerName)!;
		const baseUrl = cognitoBaseUrl(provider);
		const clientId = this.cognitoClientId();

		const body = new URLSearchParams({
			grant_type: 'authorization_code',
			code,
			redirect_uri: redirectUri,
			client_id: clientId,
			code_verifier: codeVerifier,
		});

		const headers: Record<string, string> = {
			'Content-Type': 'application/x-www-form-urlencoded',
		};

		const clientSecret = this.cognitoClientSecret?.();
		if (clientSecret) {
			const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
			headers['Authorization'] = `Basic ${basicAuth}`;
		}

		const resp = await fetch(`${baseUrl}/oauth2/token`, { method: 'POST', headers, body });
		if (!resp.ok) {
			const text = await resp.text().catch(() => '');
			throw engineError(`Cognito token exchange failed: ${resp.status} ${text}`);
		}
		const json = await resp.json() as Record<string, unknown>;
		return {
			idToken: json.id_token as string,
			accessToken: json.access_token as string,
			refreshToken: (json.refresh_token as string) ?? '',
		};
	}

	/**
	 * Exchange an authorization code with a client-provided PKCE verifier.
	 */
	private async exchangeCodeWithVerifier(
		code: string,
		redirectUri: string,
		providerName: string,
		codeVerifier: string,
	): Promise<{ idToken: string; accessToken: string; refreshToken: string }> {
		const provider = this.providerByName.get(providerName)!;
		const baseUrl = cognitoBaseUrl(provider);
		const clientId = this.cognitoClientId();

		const body = new URLSearchParams({
			grant_type: 'authorization_code',
			code,
			redirect_uri: redirectUri,
			client_id: clientId,
			code_verifier: codeVerifier,
		});

		const headers: Record<string, string> = {
			'Content-Type': 'application/x-www-form-urlencoded',
		};

		const clientSecret = this.cognitoClientSecret?.();
		if (clientSecret) {
			const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
			headers['Authorization'] = `Basic ${basicAuth}`;
		}

		const resp = await fetch(`${baseUrl}/oauth2/token`, { method: 'POST', headers, body });
		if (!resp.ok) {
			const text = await resp.text().catch(() => '');
			throw engineError(`Cognito token exchange failed: ${resp.status} ${text}`);
		}
		const json = await resp.json() as Record<string, unknown>;
		return {
			idToken: json.id_token as string,
			accessToken: json.access_token as string,
			refreshToken: (json.refresh_token as string) ?? '',
		};
	}

	/**
	 * Refresh via Cognito's token endpoint.
	 */
	private async refreshViaCognito(
		refreshToken: string,
	): Promise<{ refreshToken: string; exp: number; claims: Readonly<Record<string, unknown>> }> {
		if (!refreshToken) throw engineError('missing refresh token');

		// All cognitoFederated providers in one AuthOIDC instance share the
		// same pool — grab the first one for the Cognito domain/region.
		const provider = [...this.providerByName.values()][0];
		if (!provider) throw engineError('no cognito-federated provider configured');

		const baseUrl = cognitoBaseUrl(provider);
		const clientId = this.cognitoClientId();

		const body = new URLSearchParams({
			grant_type: 'refresh_token',
			refresh_token: refreshToken,
			client_id: clientId,
		});

		const headers: Record<string, string> = {
			'Content-Type': 'application/x-www-form-urlencoded',
		};

		const clientSecret = this.cognitoClientSecret?.();
		if (clientSecret) {
			const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
			headers['Authorization'] = `Basic ${basicAuth}`;
		}

		const resp = await fetch(`${baseUrl}/oauth2/token`, { method: 'POST', headers, body });
		if (!resp.ok) {
			throw engineError(`Cognito refresh failed: ${resp.status}`);
		}

		const json = await resp.json() as Record<string, unknown>;
		const rotated = (json.refresh_token as string) ?? refreshToken;
		const ttl = typeof json.expires_in === 'number' ? json.expires_in : 3600;
		const exp = Math.floor(Date.now() / 1000) + ttl;

		let claims: Readonly<Record<string, unknown>>;
		if (json.id_token) {
			claims = decodeJwtPayload(json.id_token as string);
		} else {
			claims = {};
		}

		return { refreshToken: rotated, exp, claims };
	}

	private async bestEffortRevoke(refreshToken: string): Promise<void> {
		try {
			const provider = [...this.providerByName.values()][0];
			if (!provider) return;
			const baseUrl = cognitoBaseUrl(provider);
			const clientId = this.cognitoClientId();

			const body = new URLSearchParams({
				token: refreshToken,
				client_id: clientId,
			});
			await fetch(`${baseUrl}/oauth2/revoke`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
				body,
			});
		} catch { /* best-effort */ }
	}

}

/**
 * Build the Cognito base URL from the provider config.
 * Prefix: `'myapp'` → `https://myapp.auth.{region}.amazoncognito.com`
 * Custom domain (contains a dot): `'auth.myapp.com'` → `https://auth.myapp.com`
 */
function cognitoBaseUrl(provider: CognitoFederatedProvider): string {
	const domain = provider.cognitoDomain;
	if (domain.includes('.')) {
		return `https://${domain}`;
	}
	return `https://${domain}.auth.${provider.region}.amazoncognito.com`;
}

/**
 * Extract the original IdP identity from Cognito's ID token.
 *
 * Cognito's `identities` claim contains the federated identity:
 * ```json
 * [{ "providerName": "Google", "userId": "1234567890", "providerType": "Google" }]
 * ```
 *
 * We use this to produce the same `userId = ${iss}:${sub}` format as
 * the self-hosted engine, so switching engines doesn't change user IDs.
 */
function extractCognitoFederatedUser(idToken: string, providerName: string): OIDCUser {
	const claims = decodeJwtPayload(idToken);

	const identities = claims.identities as Array<{
		providerName: string;
		userId: string;
		providerType: string;
	}> | undefined;

	let iss: string;
	let sub: string;

	if (identities && identities.length > 0) {
		const identity = identities[0];
		iss = cognitoProviderTypeToIss(identity.providerType, identity.providerName);
		sub = identity.userId;
	} else {
		iss = (claims.iss as string) ?? 'cognito';
		sub = (claims.sub as string) ?? '';
	}

	const email = typeof claims.email === 'string' ? claims.email : null;
	const name = typeof claims.name === 'string' ? claims.name : null;
	const username = name ?? email ?? sub;

	return {
		userId: `${iss}:${sub}`,
		username,
		provider: providerName,
		sub,
		iss,
		email,
		name,
		claims,
	};
}

/**
 * Decode a JWT payload without verification. Used for extracting claims
 * from Cognito's ID token — the token was already verified by Cognito's
 * token endpoint (server-to-server exchange over HTTPS).
 */
function decodeJwtPayload(token: string): Record<string, unknown> {
	const parts = token.split('.');
	if (parts.length !== 3) return {};
	try {
		const payload = Buffer.from(parts[1], 'base64url').toString('utf8');
		return JSON.parse(payload);
	} catch {
		return {};
	}
}

/**
 * Map Cognito's `providerType` to an issuer URL that matches what the
 * self-hosted engine would produce. This ensures `userId` is stable
 * across engine switches.
 */
function cognitoProviderTypeToIss(providerType: string, providerName: string): string {
	switch (providerType) {
		case 'Google': return 'https://accounts.google.com';
		case 'Facebook': return 'https://www.facebook.com';
		case 'LoginWithAmazon': return 'https://www.amazon.com';
		case 'SignInWithApple': return 'https://appleid.apple.com';
		case 'OIDC': return `oidc:${providerName}`;
		case 'SAML': return `saml:${providerName}`;
		default: return `cognito:${providerType}`;
	}
}

function randomState(): string {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	return Buffer.from(bytes).toString('base64url');
}

/** SHA-256 → base64url, matching PKCE S256 (RFC 7636 §4.2). */
async function s256(input: string): Promise<string> {
	const data = new TextEncoder().encode(input);
	const hash = await globalThis.crypto.subtle.digest('SHA-256', data);
	return Buffer.from(hash).toString('base64url');
}

function engineError(message: string): Error {
	const err = new Error(`CognitoFederationEngine: ${message}`);
	err.name = 'AuthOIDCEngineError';
	return brandBlocksError(err);
}
