// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The **direct** federation engine — the D0 default for `oidcProviders`: your
 * backend talks to the IdP itself. The same code runs in `npm run dev` and in
 * Lambda; only the issuer differs (the built-in stub IdP locally, the real
 * IdP when deployed).
 *
 * - **OIDC discovery** from `{issuer}/.well-known/openid-configuration`, or the
 *   provider's `endpoints` override (no discovery request at all). The
 *   document's `issuer` must equal the configured one (OIDC Discovery §4.3).
 * - **Authorization code + PKCE S256** on every request, so public
 *   (PKCE-only) clients work: `clientSecret` is optional.
 * - **ID token verified against the IdP's JWKS** with `jose`: signature
 *   (asymmetric algorithms only — never `none` or HMAC), `iss`, `aud`
 *   (and `azp` when there are several audiences), `exp` / `nbf` with 30 s of
 *   clock tolerance, and the `nonce` this sign-in sent.
 * - **Userinfo**: fills profile claims the ID token left out (only when its
 *   `sub` matches); for a bare OAuth 2.0 provider (`github()`,
 *   `customOauth2()`) it is the identity source, read with the access token.
 * - **Refresh** with the refresh token (rotation honoured); **revocation**
 *   (RFC 7009) and the **`end_session_endpoint`** logout redirect when
 *   discovery advertises them.
 * - **Groups** for `requireRole` come from the provider's `groupsClaim`.
 *
 * Identity is `` `${iss}:${sub}` `` (Q1) — `AuthOIDC`'s `userId`, so existing
 * keys survive. Sessions are written by `AuthBase` as `kind: 'direct'` rows.
 *
 * Errors are `ApiError`s named from the `AuthErrors` vocabulary; detail that
 * should not reach a browser goes to the block's logger.
 *
 * @internal
 */

import crypto from 'node:crypto';
import { ApiError, type BlocksContext } from '@aws-blocks/core';
import { constantTimeEquals } from '@aws-blocks/core/bb-utils';
import { createRemoteJWKSet, type JWTPayload, jwtVerify } from 'jose';
import { AuthErrors } from '../errors.js';
import { safeRedirectPath, signInRedirectPath } from '../redirect-path.js';
import type { DirectSessionRecord } from '../sessions.js';
import type {
	MappedClaims,
	OAuth2ProviderOptions,
	OidcProviderOptions,
	SignInUrlOptions,
	StubOidcProviderOptions,
} from '../types.js';
import { maskIdpCallbackError } from './idp-callback-error.js';
import { clearPendingAuth, pendingStateMatches, readPendingAuth, writePendingAuth } from './pending-auth.js';
import type {
	BearerTokens,
	CodeExchangeInput,
	DirectBearerIdentity,
	EngineHost,
	FederatedIdentity,
	FederationEngine,
	PublicAuthorizeParams,
	ResolvedProvider,
} from './types.js';

/** Asymmetric JWS algorithms accepted for ID tokens. Never `none`, never HMAC. */
const ALLOWED_ALGORITHMS = ['RS256', 'RS384', 'RS512', 'ES256', 'ES384', 'ES512', 'PS256', 'PS384', 'PS512'];
const DEFAULT_SCOPES = ['openid', 'email', 'profile'];
/** Default when the IdP reports no lifetime: one hour. */
const DEFAULT_TOKEN_LIFETIME_SECONDS = 3600;
const HTTP_TIMEOUT_MS = 10_000;
const DEFAULT_CALLBACK_PATH = '/aws-blocks/auth/callback';
const USER_AGENT = 'aws-blocks-bb-auth';

/** What discovery (or the endpoints override) yields. */
export interface ProviderMetadata {
	issuer: string;
	authorizationEndpoint: string;
	tokenEndpoint: string;
	userInfoEndpoint?: string;
	jwksUri?: string;
	revocationEndpoint?: string;
	endSessionEndpoint?: string;
	/** `token_endpoint_auth_methods_supported`, when advertised. */
	tokenAuthMethods?: readonly string[];
}

/** Engine construction options (per runtime layer). */
export interface DirectEngineOptions {
	/**
	 * Accept `http:` issuers and endpoints. Mock only — the stub IdP is served
	 * by the plain-HTTP dev server. The AWS layer requires HTTPS.
	 */
	allowInsecure: boolean;
	/**
	 * For a stub-IdP provider: the issuer URL, derived per request (the stub is
	 * mounted on the same server). Absent for every real provider.
	 */
	stubIssuer?: (ctx: BlocksContext) => string;
}

/**
 * Whether `config` is a `github()` / `customOauth2()` provider (a structural
 * check of the `oauth2` settings, so a hand-written object works too).
 */
export function isOAuth2Provider(config: OidcProviderOptions): config is OAuth2ProviderOptions {
	if (!('oauth2' in config)) return false;
	const settings: unknown = config.oauth2;
	if (typeof settings !== 'object' || settings === null) return false;
	const endpoints: unknown = Reflect.get(settings, 'endpoints');
	if (typeof endpoints !== 'object' || endpoints === null) return false;
	return (
		typeof Reflect.get(settings, 'mapClaims') === 'function' &&
		typeof Reflect.get(endpoints, 'authorization') === 'string' &&
		typeof Reflect.get(endpoints, 'token') === 'string' &&
		typeof Reflect.get(endpoints, 'userInfo') === 'string'
	);
}

/** Whether `config` is a `stubIdp()` provider. */
export function isStubProvider(config: OidcProviderOptions): config is StubOidcProviderOptions {
	if (!('stubIdp' in config)) return false;
	const settings: unknown = config.stubIdp;
	return typeof settings === 'object' && settings !== null;
}

function idpError(message: string, status = 400, retriable = false): ApiError {
	return new ApiError(message, status, { name: AuthErrors.IdpError, ...(retriable ? { retriable: true } : {}) });
}

function invalidCallback(message: string): ApiError {
	return new ApiError(`Invalid sign-in callback: ${message}`, 400, { name: AuthErrors.InvalidCallback });
}

function invalidState(message: string): ApiError {
	return new ApiError(`Invalid sign-in state: ${message}`, 400, { name: AuthErrors.InvalidState });
}

function misconfigured(message: string): ApiError {
	return new ApiError(message, 502, { name: AuthErrors.ProviderMisconfigured });
}

function randomToken(): string {
	return crypto.randomBytes(32).toString('base64url');
}

/** PKCE S256 challenge for a verifier (RFC 7636 §4.2). */
export function pkceChallenge(verifier: string): string {
	return crypto.createHash('sha256').update(verifier).digest('base64url');
}

function stripSlash(s: string): string {
	return s.endsWith('/') ? s.slice(0, -1) : s;
}

function stringField(obj: object, key: string): string | undefined {
	const v: unknown = Reflect.get(obj, key);
	return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function numberField(obj: object, key: string): number | undefined {
	const v: unknown = Reflect.get(obj, key);
	return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/**
 * A same-origin path (`/x`), never `//host` or a backslash trick. Moved to
 * `redirect-path.ts` (the shared check, which also refuses control characters
 * and dot segments that collapse to `//`); re-exported here for existing imports.
 */
export { isSafeRedirectPath } from '../redirect-path.js';

/**
 * The absolute `redirect_uri` for this request. Prefers the deploy-time
 * `BLOCKS_PUBLIC_ORIGIN` (the CloudFront / custom-domain origin, which the
 * Lambda never sees in `Host`), else the request's origin plus any API Gateway
 * stage prefix before `/aws-blocks` (sandbox / local) — `AuthOIDC`'s rule.
 */
export function computeCallbackUrl(ctx: BlocksContext, callbackPath: string): string {
	const publicOrigin = process.env.BLOCKS_PUBLIC_ORIGIN;
	if (publicOrigin) return `${stripSlash(publicOrigin)}${callbackPath}`;
	return `${appBaseUrl(ctx)}${callbackPath}`;
}

/** Origin plus stage prefix of the app, without a trailing slash. */
export function appBaseUrl(ctx: BlocksContext): string {
	const publicOrigin = process.env.BLOCKS_PUBLIC_ORIGIN;
	if (publicOrigin) return stripSlash(publicOrigin);
	const { url } = ctx.request;
	const routeStart = url.pathname.search(/\/aws-blocks\b/);
	const stagePrefix = routeStart > 0 ? url.pathname.slice(0, routeStart) : '';
	return `${url.protocol}//${url.host}${stagePrefix}`;
}

/** Group names from `claims[groupsClaim]`: a string array, or a single string. */
export function groupsFromClaim(claims: Record<string, unknown>, groupsClaim: string | undefined): string[] {
	if (!groupsClaim) return [];
	const raw = claims[groupsClaim];
	if (typeof raw === 'string') return raw ? [raw] : [];
	if (Array.isArray(raw)) return raw.filter((g): g is string => typeof g === 'string');
	return [];
}

/**
 * One configured direct provider. See the module documentation.
 *
 * @internal
 */
export class DirectFederationEngine implements FederationEngine {
	private readonly config: OidcProviderOptions;
	private readonly oauth2?: OAuth2ProviderOptions['oauth2'];
	private readonly stub: boolean;
	private readonly metadataCache = new Map<string, Promise<ProviderMetadata>>();
	private readonly jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
	private secretPromise?: Promise<string>;

	constructor(
		private readonly host: EngineHost,
		private readonly provider: ResolvedProvider,
		private readonly opts: DirectEngineOptions,
	) {
		if (provider.family !== 'oidc' || provider.transport !== 'direct') {
			throw new Error(`Auth: provider '${provider.id}' is not a directly federated OIDC provider.`);
		}
		this.config = provider.config;
		if (isOAuth2Provider(provider.config)) this.oauth2 = provider.config.oauth2;
		this.stub = isStubProvider(provider.config);
	}

	// ── FederationEngine ────────────────────────────────────────────────────

	async buildSignInUrl(context: BlocksContext, options: SignInUrlOptions): Promise<string> {
		// Validated and normalised up front: the stored form is what the callback emits.
		const redirectPath = signInRedirectPath(options.redirectPath);
		const meta = await this.metadataFor(this.issuerFor(context));
		const callbackUrl = computeCallbackUrl(context, this.callbackPath);
		const codeVerifier = randomToken();
		const state = randomToken();
		const nonce = this.oauth2 ? undefined : randomToken();

		const url = new URL(meta.authorizationEndpoint);
		url.searchParams.set('response_type', 'code');
		url.searchParams.set('client_id', this.config.clientId);
		url.searchParams.set('redirect_uri', callbackUrl);
		url.searchParams.set('scope', this.scopes.join(' '));
		url.searchParams.set('state', state);
		if (nonce) url.searchParams.set('nonce', nonce);
		url.searchParams.set('code_challenge', pkceChallenge(codeVerifier));
		url.searchParams.set('code_challenge_method', 'S256');

		writePendingAuth(
			context,
			this.host.scope.fullId,
			{
				provider: this.provider.id,
				state,
				codeVerifier,
				callbackUrl,
				...(nonce ? { nonce } : {}),
				...(redirectPath ? { redirectPath } : {}),
				...(options.state !== undefined ? { appState: options.state } : {}),
			},
			await this.host.sessionSecret(),
			this.crossDomain,
		);
		return url.toString();
	}

	async completeSignIn(context: BlocksContext): Promise<FederatedIdentity> {
		const pending = readPendingAuth(context, this.host.scope.fullId, await this.host.sessionSecret());
		// Single use, whatever happens next.
		clearPendingAuth(context, this.host.scope.fullId, this.crossDomain);
		if (!pending) {
			throw invalidCallback(
				'the pending sign-in cookie is missing or expired. Start the sign-in again; if this repeats, the ' +
					'callback is landing on a different origin than the sign-in started on.',
			);
		}
		if (pending.provider !== this.provider.id) throw invalidState('the callback is for another provider');
		const params = context.request.url.searchParams;
		// R2-2: `state` first, error response or not (RFC 6749 §4.1.2.1 returns it
		// on both), so an attacker's link cannot put its own `error_description` in
		// front of a user mid-sign-in: without this browser's pending state, every
		// callback is the same generic InvalidState.
		const returnedState = params.get('state');
		if (!pendingStateMatches(returnedState, pending)) throw invalidState('state mismatch');
		const idpErr = params.get('error');
		if (idpErr) {
			// FX60: `error_description` is the IdP's own text — it can name an internal
			// endpoint or echo the login — and `ApiError.message` is what the
			// `<Authenticator>` renders. So the client gets the fixed message and the
			// text goes to the log only, as FX59 does for every other engine error.
			throw idpError(
				maskIdpCallbackError(
					this.host.log,
					'[bb-auth] the identity provider returned an error on the callback',
					{
						provider: this.provider.id,
						error: idpErr,
						description: params.get('error_description'),
					},
				),
			);
		}
		const code = params.get('code');
		if (!code) throw invalidCallback('missing code parameter');
		return this.redeem(context, {
			code,
			codeVerifier: pending.codeVerifier,
			redirectUri: pending.callbackUrl,
			nonce: pending.nonce ?? '',
			...(params.get('iss') ? { iss: params.get('iss') ?? '' } : {}),
		});
	}

	async exchangeCode(context: BlocksContext, input: CodeExchangeInput): Promise<FederatedIdentity> {
		let redirect: URL;
		try {
			redirect = new URL(input.redirectUri);
		} catch {
			throw invalidCallback('callbackUrl must be an absolute URL');
		}
		if (redirect.protocol !== 'https:' && redirect.protocol !== 'http:') {
			throw invalidCallback('callbackUrl must be an http(s) URL');
		}
		return this.redeem(context, input);
	}

	async authorizeParams(context: BlocksContext): Promise<PublicAuthorizeParams> {
		const meta = await this.metadataFor(this.issuerFor(context));
		return {
			authorizeUrl: meta.authorizationEndpoint,
			clientId: this.config.clientId,
			scopes: this.scopes,
			kind: this.stub ? 'stub' : this.oauth2 ? 'oauth2-custom' : 'oidc-custom',
			usesNonce: !this.oauth2,
		};
	}

	async refresh(
		session: Parameters<FederationEngine['refresh']>[0],
	): Promise<{ kind: 'direct'; record: DirectSessionRecord } | null> {
		if (session.kind !== 'direct') return null;
		const record = session.record;
		if (!record.refreshToken) {
			// A bare OAuth 2.0 provider without refresh tokens (GitHub's default):
			// the access token itself is the credential — re-validate it.
			if (this.oauth2 && record.accessToken) {
				const alive = await this.probeUserInfo(this.oauth2.endpoints.userInfo, record.accessToken);
				if (!alive) return null;
				return {
					kind: 'direct',
					record: { ...record, expiresAt: Date.now() + DEFAULT_TOKEN_LIFETIME_SECONDS * 1000 },
				};
			}
			// Nothing to refresh with: the session ends with the IdP's token
			// (request `offline_access` for long sessions) — `AuthOIDC`'s rule.
			return null;
		}
		const meta = await this.metadataFor(this.sessionIssuer(record));
		const tokens = await this.tokenRequest(
			meta,
			{ grant_type: 'refresh_token', refresh_token: record.refreshToken },
			'refresh',
		);
		if (!tokens) return null;
		if (tokens.idToken && !this.oauth2) {
			// A refreshed ID token must still be ours and about the same user.
			const claims = await this.verifyIdToken(meta, tokens.idToken, undefined).catch(() => null);
			if (!claims || claims.sub !== record.subject) return null;
		}
		return {
			kind: 'direct',
			record: {
				...record,
				...(tokens.idToken ? { idToken: tokens.idToken } : {}),
				accessToken: tokens.accessToken,
				refreshToken: tokens.refreshToken ?? record.refreshToken,
				expiresAt: Date.now() + (tokens.expiresIn ?? DEFAULT_TOKEN_LIFETIME_SECONDS) * 1000,
			},
		};
	}

	async signOut(
		session: Parameters<FederationEngine['signOut']>[0],
		context: BlocksContext,
	): Promise<{ logoutUrl?: string }> {
		if (session.kind !== 'direct') return {};
		const record = session.record;
		if (this.oauth2) return {}; // no standard revocation or logout endpoint
		let meta: ProviderMetadata;
		try {
			meta = await this.metadataFor(this.sessionIssuer(record));
		} catch (e) {
			this.host.log.warn('[bb-auth] could not load provider metadata for sign-out; local sign-out only', {
				provider: this.provider.id,
				error: e instanceof Error ? e.message : String(e),
			});
			return {};
		}
		const token = record.refreshToken ?? record.accessToken;
		if (meta.revocationEndpoint && token) {
			await this.revoke(meta.revocationEndpoint, token, record.refreshToken ? 'refresh_token' : 'access_token');
		}
		if (!meta.endSessionEndpoint) return {};
		const logout = new URL(meta.endSessionEndpoint);
		if (record.idToken) logout.searchParams.set('id_token_hint', record.idToken);
		logout.searchParams.set('client_id', this.config.clientId);
		// Checked at construction (`federationRoutePaths`); normalised again here so
		// the raw configured string never reaches the URL.
		const postSignOut = safeRedirectPath(this.host.options.redirects?.postSignOutPath ?? '/') ?? '/';
		logout.searchParams.set('post_logout_redirect_uri', `${appBaseUrl(context)}${postSignOut}`);
		return { logoutUrl: logout.toString() };
	}

	async refreshBearer(context: BlocksContext, refreshToken: string): Promise<BearerTokens | null> {
		const meta = await this.metadataFor(this.issuerFor(context));
		const tokens = await this.tokenRequest(
			meta,
			{ grant_type: 'refresh_token', refresh_token: refreshToken },
			'refresh',
		);
		if (!tokens) return null;
		return {
			accessToken: tokens.accessToken,
			refreshToken: tokens.refreshToken ?? refreshToken,
			expiresIn: tokens.expiresIn ?? DEFAULT_TOKEN_LIFETIME_SECONDS,
		};
	}

	/**
	 * Verify a bearer access token (`allowBearerAuth`, D6c) — the check
	 * `AuthOIDC` makes today, so the native SDKs' tokens keep working: a JWT
	 * whose `iss` is this provider's issuer, signed by a key in the provider's
	 * JWKS (asymmetric algorithms only — never `none` or HMAC), `aud` = the
	 * client id, `exp` / `nbf` with 30 s of clock tolerance, and a subject.
	 * `null` for anything else, including every bare OAuth 2.0 provider (their
	 * access tokens are opaque — `AuthOIDC` does not accept them either).
	 */
	async verifyBearer(context: BlocksContext, token: string): Promise<DirectBearerIdentity | null> {
		if (this.oauth2) return null;
		const parts = token.split('.');
		if (parts.length !== 3) return null;
		let unverifiedIss: unknown;
		try {
			const payload: unknown = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
			unverifiedIss = typeof payload === 'object' && payload !== null ? Reflect.get(payload, 'iss') : undefined;
		} catch {
			return null;
		}
		try {
			const issuer = this.issuerFor(context);
			// Cheap pre-check, so another provider's token never costs a JWKS fetch here.
			if (typeof unverifiedIss !== 'string' || stripSlash(unverifiedIss) !== stripSlash(issuer)) return null;
			const meta = await this.metadataFor(issuer);
			if (!meta.jwksUri) return null;
			const { payload } = await jwtVerify(token, this.jwks(meta.jwksUri), {
				issuer: [meta.issuer, stripSlash(meta.issuer), `${stripSlash(meta.issuer)}/`],
				audience: this.config.clientId,
				algorithms: ALLOWED_ALGORITHMS,
				clockTolerance: 30,
			});
			if (typeof payload.sub !== 'string' || payload.sub.length === 0) return null;
			const claims: Record<string, unknown> = { ...payload };
			return {
				issuer: typeof payload.iss === 'string' ? payload.iss : meta.issuer,
				subject: payload.sub,
				claims,
				groups: groupsFromClaim(claims, this.groupsClaim),
				expiresAt: typeof payload.exp === 'number' ? payload.exp * 1000 : 0,
			};
		} catch (e) {
			const code: unknown = e instanceof Error ? Reflect.get(e, 'code') : undefined;
			this.host.log.warn('[bb-auth] bearer token verification failed', {
				provider: this.provider.id,
				error: typeof code === 'string' ? code : e instanceof Error ? e.name : typeof e,
			});
			return null;
		}
	}

	// ── Internals ───────────────────────────────────────────────────────────

	private get scopes(): string[] {
		return [...(this.config.scopes ?? DEFAULT_SCOPES)];
	}

	private get callbackPath(): string {
		return this.host.options.redirects?.callbackPath ?? DEFAULT_CALLBACK_PATH;
	}

	private get crossDomain(): boolean {
		return this.host.options.session?.crossDomain ?? false;
	}

	/**
	 * The issuer to talk to for a stored session: the configured one, except
	 * for the stub, whose issuer is the local URL recorded at sign-in.
	 */
	private sessionIssuer(record: DirectSessionRecord): string {
		return this.stub ? record.issuer : this.config.issuer;
	}

	private issuerFor(context: BlocksContext): string {
		if (this.stub) {
			if (!this.opts.stubIssuer) {
				throw new ApiError(
					`Sign-in provider '${this.provider.id}' is a stub IdP, which runs only in local development ` +
						'(npm run dev). Replace stubIdp() with the real provider before deploying.',
					501,
					{ name: AuthErrors.ProviderMisconfigured },
				);
			}
			return this.opts.stubIssuer(context);
		}
		return this.config.issuer;
	}

	private clientSecret(): Promise<string | undefined> {
		const ref = this.config.clientSecret;
		if (!ref) return Promise.resolve(undefined);
		this.secretPromise ??= ref.get().then(
			(v) => v,
			(e: unknown) => {
				this.secretPromise = undefined; // never memoize a failure
				this.host.log.error('[bb-auth] could not read the provider client secret', {
					provider: this.provider.id,
					error: e instanceof Error ? e.name : typeof e,
				});
				throw misconfigured(`Sign-in provider '${this.provider.id}' is not configured correctly.`);
			},
		);
		return this.secretPromise;
	}

	private checkUrl(value: string, what: string): string {
		let url: URL;
		try {
			url = new URL(value);
		} catch {
			throw misconfigured(`Sign-in provider '${this.provider.id}': ${what} is not a valid URL.`);
		}
		if (url.protocol !== 'https:' && !(this.opts.allowInsecure && url.protocol === 'http:')) {
			throw misconfigured(`Sign-in provider '${this.provider.id}': ${what} must use https.`);
		}
		return value;
	}

	/** Discovery (cached per issuer; failures are not cached), or the static endpoints. */
	metadataFor(issuer: string): Promise<ProviderMetadata> {
		if (this.oauth2) {
			const e = this.oauth2.endpoints;
			return Promise.resolve({
				issuer: this.config.issuer,
				authorizationEndpoint: this.checkUrl(e.authorization, 'the authorization endpoint'),
				tokenEndpoint: this.checkUrl(e.token, 'the token endpoint'),
				userInfoEndpoint: this.checkUrl(e.userInfo, 'the userinfo endpoint'),
			});
		}
		if (this.config.endpoints) {
			const e = this.config.endpoints;
			return Promise.resolve({
				issuer: this.config.issuer,
				authorizationEndpoint: this.checkUrl(e.authorization, 'endpoints.authorization'),
				tokenEndpoint: this.checkUrl(e.token, 'endpoints.token'),
				userInfoEndpoint: this.checkUrl(e.userInfo, 'endpoints.userInfo'),
				jwksUri: this.checkUrl(e.jwks, 'endpoints.jwks'),
			});
		}
		const cached = this.metadataCache.get(issuer);
		if (cached) return cached;
		const pending = this.discover(issuer);
		this.metadataCache.set(issuer, pending);
		pending.catch(() => {
			if (this.metadataCache.get(issuer) === pending) this.metadataCache.delete(issuer);
		});
		return pending;
	}

	private async discover(issuer: string): Promise<ProviderMetadata> {
		this.checkUrl(issuer, 'issuer');
		const url = `${stripSlash(issuer)}/.well-known/openid-configuration`;
		let doc: unknown;
		try {
			const res = await fetch(url, {
				headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
				signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
			});
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			doc = await res.json();
		} catch (e) {
			this.host.log.error('[bb-auth] OIDC discovery failed', {
				provider: this.provider.id,
				url,
				error: e instanceof Error ? e.message : String(e),
			});
			throw misconfigured(`Sign-in provider '${this.provider.id}' is unreachable (OIDC discovery failed).`);
		}
		if (typeof doc !== 'object' || doc === null) {
			throw misconfigured(`Sign-in provider '${this.provider.id}' returned an invalid discovery document.`);
		}
		const docIssuer = stringField(doc, 'issuer');
		if (!docIssuer || stripSlash(docIssuer) !== stripSlash(issuer)) {
			this.host.log.error('[bb-auth] OIDC discovery issuer mismatch', {
				provider: this.provider.id,
				configured: issuer,
				advertised: docIssuer,
			});
			throw misconfigured(
				`Sign-in provider '${this.provider.id}': the discovery document's issuer does not match the configured issuer.`,
			);
		}
		const authorization = stringField(doc, 'authorization_endpoint');
		const token = stringField(doc, 'token_endpoint');
		const jwks = stringField(doc, 'jwks_uri');
		if (!authorization || !token || !jwks) {
			throw misconfigured(
				`Sign-in provider '${this.provider.id}': discovery is missing authorization_endpoint, token_endpoint or jwks_uri.`,
			);
		}
		const userInfo = stringField(doc, 'userinfo_endpoint');
		const revocation = stringField(doc, 'revocation_endpoint');
		const endSession = stringField(doc, 'end_session_endpoint');
		const methods: unknown = Reflect.get(doc, 'token_endpoint_auth_methods_supported');
		return {
			issuer: docIssuer,
			authorizationEndpoint: this.checkUrl(authorization, 'authorization_endpoint'),
			tokenEndpoint: this.checkUrl(token, 'token_endpoint'),
			jwksUri: this.checkUrl(jwks, 'jwks_uri'),
			...(userInfo ? { userInfoEndpoint: this.checkUrl(userInfo, 'userinfo_endpoint') } : {}),
			...(revocation ? { revocationEndpoint: this.checkUrl(revocation, 'revocation_endpoint') } : {}),
			...(endSession ? { endSessionEndpoint: this.checkUrl(endSession, 'end_session_endpoint') } : {}),
			...(Array.isArray(methods)
				? { tokenAuthMethods: methods.filter((m): m is string => typeof m === 'string') }
				: {}),
		};
	}

	private jwks(uri: string): ReturnType<typeof createRemoteJWKSet> {
		let set = this.jwksCache.get(uri);
		if (!set) {
			if (this.jwksCache.size >= 8) {
				const oldest = this.jwksCache.keys().next().value;
				if (oldest !== undefined) this.jwksCache.delete(oldest);
			}
			set = createRemoteJWKSet(new URL(uri), { timeoutDuration: HTTP_TIMEOUT_MS });
			this.jwksCache.set(uri, set);
		}
		return set;
	}

	/**
	 * Verify an ID token: signature against the JWKS, `iss`, `aud`, `exp`,
	 * `nbf`, `azp` (several audiences), and — when `expectedNonce` is a string
	 * — the nonce (`''` = the token must carry none).
	 */
	async verifyIdToken(
		meta: ProviderMetadata,
		idToken: string,
		expectedNonce: string | undefined,
	): Promise<JWTPayload> {
		if (!meta.jwksUri) throw misconfigured(`Sign-in provider '${this.provider.id}' has no JWKS endpoint.`);
		let payload: JWTPayload;
		try {
			({ payload } = await jwtVerify(idToken, this.jwks(meta.jwksUri), {
				issuer: [meta.issuer, stripSlash(meta.issuer), `${stripSlash(meta.issuer)}/`],
				audience: this.config.clientId,
				algorithms: ALLOWED_ALGORITHMS,
				clockTolerance: 30,
			}));
		} catch (e) {
			const code: unknown = e instanceof Error ? Reflect.get(e, 'code') : undefined;
			this.host.log.warn('[bb-auth] ID token verification failed', {
				provider: this.provider.id,
				error: typeof code === 'string' ? code : e instanceof Error ? e.name : typeof e,
				message: e instanceof Error ? e.message : undefined,
			});
			throw idpError('The identity provider returned an ID token that failed verification.', 401);
		}
		if (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== this.config.clientId) {
			throw idpError('The ID token was issued to another client (azp mismatch).', 401);
		}
		if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
			throw idpError('The ID token has no subject.', 401);
		}
		if (expectedNonce !== undefined) {
			const nonce: unknown = payload.nonce;
			// Constant time, like the callback's `state`: the nonce binds the token to this sign-in.
			const matches =
				expectedNonce === ''
					? nonce === undefined
					: typeof nonce === 'string' && constantTimeEquals(nonce, expectedNonce);
			if (!matches) {
				throw idpError('The ID token nonce does not match this sign-in.', 401);
			}
		}
		return payload;
	}

	/** Exchange the code and turn the result into a verified identity. */
	private async redeem(context: BlocksContext, input: CodeExchangeInput): Promise<FederatedIdentity> {
		const meta = await this.metadataFor(this.issuerFor(context));
		if (input.iss && !this.oauth2 && stripSlash(input.iss) !== stripSlash(meta.issuer)) {
			// RFC 9207: the response came from another authorization server (mix-up).
			throw invalidCallback('the iss parameter does not match the provider');
		}
		const tokens = await this.tokenRequest(
			meta,
			{
				grant_type: 'authorization_code',
				code: input.code,
				redirect_uri: input.redirectUri,
				code_verifier: input.codeVerifier,
			},
			'code',
		);
		if (!tokens) throw idpError('The identity provider rejected the authorization code.');
		const expiresAt = (seconds: number | undefined) =>
			Date.now() + (seconds ?? DEFAULT_TOKEN_LIFETIME_SECONDS) * 1000;

		if (this.oauth2) {
			const raw = await this.fetchUserInfo(this.oauth2.endpoints.userInfo, tokens.accessToken);
			if (raw === null) throw idpError('The identity provider did not return the user profile.', 502, true);
			let mapped: MappedClaims;
			try {
				mapped = this.oauth2.mapClaims(raw);
			} catch (e) {
				this.host.log.error('[bb-auth] mapClaims threw', {
					provider: this.provider.id,
					error: e instanceof Error ? e.message : String(e),
				});
				throw idpError('The user profile could not be read.');
			}
			if (!mapped.providerSub)
				throw idpError('The user profile has no stable id (mapClaims returned no providerSub).');
			const claims: Record<string, unknown> = {
				iss: this.config.issuer,
				sub: mapped.providerSub,
				...(mapped.email ? { email: mapped.email } : {}),
				...(mapped.name ? { name: mapped.name } : {}),
				userinfo: raw,
			};
			return {
				kind: 'direct',
				issuer: this.config.issuer,
				subject: mapped.providerSub,
				claims,
				groups: groupsFromClaim(typeof raw === 'object' && raw !== null ? { ...raw } : {}, this.groupsClaim),
				expiresAt: expiresAt(tokens.expiresIn),
				accessToken: tokens.accessToken,
				...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
			};
		}

		if (!tokens.idToken) throw idpError('The identity provider did not return an ID token.');
		const verified = await this.verifyIdToken(meta, tokens.idToken, input.nonce);
		const claims: Record<string, unknown> = { ...verified };
		if (meta.userInfoEndpoint && tokens.accessToken) {
			const info = await this.fetchUserInfo(meta.userInfoEndpoint, tokens.accessToken).catch(() => null);
			// Userinfo only fills gaps, and only about the same subject (OIDC Core §5.3.2).
			if (info && typeof info === 'object' && Reflect.get(info, 'sub') === verified.sub) {
				for (const [k, v] of Object.entries(info)) {
					if (!(k in claims)) claims[k] = v;
				}
			}
		}
		const issuer = typeof verified.iss === 'string' ? verified.iss : meta.issuer;
		const idExp = typeof verified.exp === 'number' ? verified.exp - Math.floor(Date.now() / 1000) : undefined;
		return {
			kind: 'direct',
			issuer,
			subject: String(verified.sub),
			claims,
			groups: groupsFromClaim(claims, this.groupsClaim),
			expiresAt: expiresAt(tokens.expiresIn ?? idExp),
			idToken: tokens.idToken,
			...(tokens.accessToken ? { accessToken: tokens.accessToken } : {}),
			...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
		};
	}

	private get groupsClaim(): string | undefined {
		return 'groupsClaim' in this.config && typeof this.config.groupsClaim === 'string'
			? this.config.groupsClaim
			: undefined;
	}

	/**
	 * POST the token endpoint. Returns `null` when the IdP **rejected** the
	 * grant (an OAuth error response); throws a retriable `IdpError` for a
	 * transport failure or a 5xx.
	 */
	private async tokenRequest(
		meta: ProviderMetadata,
		params: Record<string, string>,
		purpose: 'code' | 'refresh',
	): Promise<{ accessToken: string; idToken?: string; refreshToken?: string; expiresIn?: number } | null> {
		const secret = await this.clientSecret();
		const body = new URLSearchParams({ ...params, client_id: this.config.clientId });
		const headers: Record<string, string> = {
			'Content-Type': 'application/x-www-form-urlencoded',
			Accept: 'application/json',
			'User-Agent': USER_AGENT,
		};
		if (secret !== undefined) {
			// client_secret_post unless the IdP advertises only client_secret_basic.
			const methods = meta.tokenAuthMethods;
			if (methods && !methods.includes('client_secret_post') && methods.includes('client_secret_basic')) {
				const id = encodeURIComponent(this.config.clientId);
				headers.Authorization = `Basic ${Buffer.from(`${id}:${encodeURIComponent(secret)}`).toString('base64')}`;
			} else {
				body.set('client_secret', secret);
			}
		}
		let res: Response;
		try {
			res = await fetch(meta.tokenEndpoint, {
				method: 'POST',
				headers,
				body,
				signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
			});
		} catch (e) {
			this.host.log.error('[bb-auth] token endpoint unreachable', {
				provider: this.provider.id,
				purpose,
				error: e instanceof Error ? e.message : String(e),
			});
			throw idpError('The identity provider is unreachable. Please try again.', 502, true);
		}
		let json: unknown = null;
		try {
			json = await res.json();
		} catch {
			json = null;
		}
		const obj = typeof json === 'object' && json !== null ? json : {};
		const oauthError = stringField(obj, 'error');
		if (res.status >= 500) {
			this.host.log.error('[bb-auth] token endpoint failed', {
				provider: this.provider.id,
				purpose,
				status: res.status,
			});
			throw idpError('The identity provider failed. Please try again.', 502, true);
		}
		// Some providers (GitHub) answer an OAuth error with 200.
		if (!res.ok || oauthError) {
			this.host.log.warn('[bb-auth] token request rejected', {
				provider: this.provider.id,
				purpose,
				status: res.status,
				error: oauthError,
				description: stringField(obj, 'error_description'),
			});
			return null;
		}
		const accessToken = stringField(obj, 'access_token');
		if (!accessToken) {
			this.host.log.warn('[bb-auth] token response has no access_token', { provider: this.provider.id, purpose });
			return null;
		}
		const idToken = stringField(obj, 'id_token');
		const refreshToken = stringField(obj, 'refresh_token');
		const expiresIn = numberField(obj, 'expires_in');
		return {
			accessToken,
			...(idToken ? { idToken } : {}),
			...(refreshToken ? { refreshToken } : {}),
			...(expiresIn !== undefined ? { expiresIn } : {}),
		};
	}

	/** GET userinfo with the access token; `null` when the token is not accepted. */
	private async fetchUserInfo(endpoint: string, accessToken: string): Promise<unknown> {
		let res: Response;
		try {
			res = await fetch(endpoint, {
				headers: {
					Authorization: `Bearer ${accessToken}`,
					Accept: 'application/json',
					'User-Agent': USER_AGENT,
				},
				signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
			});
		} catch (e) {
			this.host.log.error('[bb-auth] userinfo endpoint unreachable', {
				provider: this.provider.id,
				error: e instanceof Error ? e.message : String(e),
			});
			throw idpError('The identity provider is unreachable. Please try again.', 502, true);
		}
		if (!res.ok) {
			this.host.log.warn('[bb-auth] userinfo rejected the access token', {
				provider: this.provider.id,
				status: res.status,
			});
			return null;
		}
		try {
			return await res.json();
		} catch {
			return null;
		}
	}

	/** `true` while the access token is accepted; `false` once rejected; throws on a transport failure. */
	private async probeUserInfo(endpoint: string, accessToken: string): Promise<boolean> {
		return (await this.fetchUserInfo(endpoint, accessToken)) !== null;
	}

	/** RFC 7009 revocation, best-effort (never throws). */
	private async revoke(endpoint: string, token: string, hint: 'refresh_token' | 'access_token'): Promise<void> {
		try {
			const secret = await this.clientSecret();
			const body = new URLSearchParams({ token, token_type_hint: hint, client_id: this.config.clientId });
			if (secret !== undefined) body.set('client_secret', secret);
			await fetch(endpoint, {
				method: 'POST',
				headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': USER_AGENT },
				body,
				signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
			});
		} catch (e) {
			this.host.log.warn('[bb-auth] token revocation failed (best-effort)', {
				provider: this.provider.id,
				error: e instanceof Error ? e.message : String(e),
			});
		}
	}
}
