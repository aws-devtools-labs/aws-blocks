// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared `AuthOIDC` base class. Mock and AWS entry points subclass this,
 * injecting their own `AuthEngine`.
 */

import { Scope, type ScopeParent, type BlocksContext, ApiNamespace, BLOCKS_AUTH_PREFIX } from '@aws-blocks/core';
import type { AuthActionInput, AuthState, AuthAction, BlocksAuth } from '@aws-blocks/auth-common';
import type { AuthEngine, ExchangeInput, ExchangeResult, AuthorizeParams, AuthorizeParamsRequest, BearerRefreshResult } from './engine.js';
import type {
	AuthOIDCOptions,
	OIDCUser,
	OIDCClient,
	ProviderConfig,
	ProviderName,
	SignInUrlOptions,
} from './types.js';
import { Logger } from '@aws-blocks/bb-logger';
import type { ChildLogger } from '@aws-blocks/bb-logger';
import { decodeState } from './state.js';
import { validateRelay } from './relay.js';
/** Default paths for the routes `AuthOIDC` owns. All live under the reserved
 * `/aws-blocks/auth` subtree so Hosting proxies the whole flow through one
 * CloudFront behavior (and so they never collide with a customer's `/auth/*`). */
export const DEFAULT_CALLBACK_PATH = `${BLOCKS_AUTH_PREFIX}/callback`;
export const DEFAULT_SIGNOUT_PATH = `${BLOCKS_AUTH_PREFIX}/signout`;
export const DEFAULT_POST_SIGNIN_PATH = '/';

/**
 * OIDC sign-in gate. Turns an OIDC authorization-code flow into an
 * authenticated `BlocksContext` that the rest of your IFC consumes.
 *
 * Sessions outlive the IdP's ~1 hour ID token TTL — the BB refreshes
 * access tokens in the background and invalidates sessions server-side
 * on sign-out. No session storage to configure; the BB provisions what
 * it needs (~$0.25/month for an idle DynamoDB table).
 *
 * ## Usage
 *
 * ```typescript
 * import { AuthOIDC, google } from '@aws-blocks/bb-auth-oidc';
 *
 * const auth = new AuthOIDC(scope, 'auth', {
 *   providers: [google({
 *     clientId:     () => googleClientId.get(),
 *     clientSecret: () => googleSecret.get(),
 *   })],
 *   onSignIn: async (user) => {
 *     await profiles.put(user.userId, { email: user.email, name: user.name });
 *   },
 * });
 * ```
 */
export class AuthOIDC<
	P extends readonly ProviderConfig[] = readonly ProviderConfig[],
> extends Scope implements BlocksAuth {
	protected readonly engine: AuthEngine;
	protected readonly options: AuthOIDCOptions<P>;
	protected readonly providerNames: ReadonlySet<string>;
	/** @internal Logger for internal operations. Defaults to error-level when not provided. */
	protected log: ChildLogger;

	/**
	 * Subclasses pass in a pre-built `AuthEngine` so runtime plumbing
	 * stays in the entry point and shared logic stays here.
	 */

	protected constructor(
		scope: ScopeParent,
		id: string,
		options: AuthOIDCOptions<P>,
		engine: AuthEngine,
		bbMeta?: { bbName: string; bbVersion: string },
	) {
		super(id, { parent: scope, bbName: bbMeta?.bbName, bbVersion: bbMeta?.bbVersion });
		this.log = options?.logger ?? new Logger(this, 'logger', { level: 'error' });
		validateAuthOIDCOptions(options);
		this.options = options;
		this.engine = engine;
		this.providerNames = new Set(options.providers.map((p) => p.name));
		this.registerClientMiddleware('@aws-blocks/bb-auth-oidc/middleware');
	}

	get providers(): readonly ProviderName<P>[] {
		return this.options.providers.map((p) => p.name) as readonly ProviderName<P>[];
	}

	/** Absolute-within-host callback path, defaulting to `/aws-blocks/auth/callback`. */
	get callbackPath(): string {
		return this.options.callbackPath ?? DEFAULT_CALLBACK_PATH;
	}

	/** Absolute-within-host sign-out path, defaulting to `/aws-blocks/auth/signout`. */
	get signOutPath(): string {
		return this.options.signOutPath ?? DEFAULT_SIGNOUT_PATH;
	}

	/** Where to land after a successful sign-in, defaulting to `/`. */
	get postSignInPath(): string {
		return this.options.postSignInPath ?? DEFAULT_POST_SIGNIN_PATH;
	}

	/** Whether bearer-token auth (for native clients) is enabled. */
	get allowBearerAuth(): boolean {
		return this.options.allowBearerAuth === true;
	}

	/**
	 * Derive the absolute callback URL the IdP redirects back to.
	 *
	 * On a full CloudFront deploy the Lambda never sees the public host — the
	 * distribution strips the viewer `Host` header (`ALL_VIEWER_EXCEPT_HOST_HEADER`),
	 * so a request-derived URL would resolve to the raw execute-api host and the
	 * CloudFront-scoped session cookie wouldn't be sent back. So we prefer the
	 * deploy-time-trusted `BLOCKS_PUBLIC_ORIGIN` (the CloudFront / custom-domain
	 * origin, injected by the Hosting construct). It's the public origin only —
	 * no API Gateway stage prefix, since CloudFront proxies the stage via its
	 * origin path.
	 *
	 * When unset (sandbox / local dev) we fall back to the request URL, stripping
	 * any API Gateway stage prefix (e.g. `/prod`) that sits before the route.
	 */
	protected computeCallbackUrl(ctx: BlocksContext): string {
		// `BLOCKS_PUBLIC_ORIGIN` is injected at synth by core Hosting (the public
		// CloudFront/custom-domain origin). Literal key — it's core-owned config,
		// like `CORS_HOSTING_ORIGINS`.
		const publicOrigin = process.env.BLOCKS_PUBLIC_ORIGIN;
		if (publicOrigin) {
			return `${publicOrigin}${this.callbackPath}`;
		}
		const { url } = ctx.request;
		// All auth routes live under the reserved `/aws-blocks` namespace.
		const routeStart = url.pathname.search(/\/aws-blocks\b/);
		const stagePrefix = routeStart > 0 ? url.pathname.slice(0, routeStart) : '';
		return `${url.protocol}//${url.host}${stagePrefix}${this.callbackPath}`;
	}

	/**
	 * Return the authenticated user, or throw `AuthOIDCErrors.NotAuthenticated`
	 * / `TokenExpired` if the session is missing or expired.
	 */
	async requireAuth(ctx: BlocksContext): Promise<OIDCUser> {
		const user = await this._resolveUser(ctx);
		if (user) return user;
		throw notAuthenticated();
	}

	async checkAuth(ctx: BlocksContext): Promise<boolean> {
		const user = await this._resolveUser(ctx);
		return user !== null;
	}

	async getCurrentUser(ctx: BlocksContext): Promise<OIDCUser | null> {
		return this._resolveUser(ctx);
	}

	/**
	 * Resolve the user from session cookie or Bearer header.
	 */
	private async _resolveUser(ctx: BlocksContext): Promise<OIDCUser | null> {
		const user = await this.engine.verifySession(ctx);
		if (user) return user;

		if (this.options.allowBearerAuth) {
			const authHeader = ctx.request.headers.get('authorization');
			if (authHeader?.startsWith('Bearer ')) {
				const token = authHeader.slice(7);
				return this.engine.verifyAccessToken(token, ctx);
			}
		}

		return null;
	}

	/**
	 * Build the authorize URL to redirect the browser to for the given provider.
	 *
	 * Call this from an `ApiNamespace` method, then return the URL to the
	 * client. The client redirects the browser; the user signs in at the IdP;
	 * the IdP redirects back to the callback route registered by this BB.
	 *
	 * @example
	 * ```typescript
	 * async startSignIn(provider: string) {
	 *   return auth.getSignInUrl(ctx, provider);
	 * }
	 * ```
	 */
	async getSignInUrl(
		ctx: BlocksContext,
		provider: ProviderName<P> | (string & {}),
		opts?: SignInUrlOptions,
	): Promise<string> {
		if (!this.providerNames.has(provider)) {
			throw providerNotConfigured(provider);
		}
		const callbackUrl = this.computeCallbackUrl(ctx);
		const result = await this.engine.buildSignInUrl({
			provider,
			opts,
			callbackUrl,
			ctx,
		});
		ctx.response.headers.append('Set-Cookie', result.pendingCookie);
		return result.url;
	}

	/**
	 * Handle the IdP callback. Exchanges the code, verifies the ID token,
	 * fires `onSignIn`, and returns the authenticated user.
	 * If `onSignIn` throws, the session is rolled back (no cookie set).
	 */
	async handleCallback(ctx: BlocksContext): Promise<OIDCUser> {
		const user = await this.engine.handleCallback(ctx);
		if (this.options.onSignIn) {
			try {
				await this.options.onSignIn(user, ctx);
			} catch (err) {
				// Hook failed — the engine already issued the session cookie, so
				// roll it back before rethrowing. The caller sees the original
				// error and the request ends with no cookie and no row.
				try {
					await this.engine.signOut(ctx);
				} catch {
					// Best-effort rollback — let the original hook error surface.
				}
				throw err;
			}
		}
		return user;
	}

	/**
	 * Relay-aware callback dispatcher. Returns which response the route should send.
	 * Branches on pending-auth cookie presence (server-initiated vs relay flow).
	 */
	async handleCallbackDispatch(ctx: BlocksContext): Promise<CallbackResult> {
		// Detection: pending-auth cookie present → server-initiated flow.
		const hasPendingCookie = this.engine.hasPendingAuthCookie(ctx);

		if (hasPendingCookie) {
			return { kind: 'server-exchange' };
		}

		// No pending-auth cookie → relay flow. Decode the state envelope.
		const stateParam = ctx.request.url.searchParams.get('state');
		if (!stateParam) {
			return { kind: 'error', status: 400, code: 'invalid_state', message: 'missing state parameter' };
		}

		const secret = await this.engine.resolveCookieSecret();
		const decoded = decodeState(stateParam, secret);

		if (!decoded.ok) {
			if (decoded.reason === 'version') {
				return { kind: 'error', status: 400, code: 'sdk_outdated', message: 'state envelope version not recognized — update your SDK' };
			}
			if (decoded.reason === 'malformed') {
				// `state` isn't a relay envelope at all, and there's no pending-auth
				// cookie. Most often this is a server-initiated callback whose
				// pending-auth cookie didn't arrive — a host/origin mismatch (the
				// callback landed on a different origin than sign-in, e.g. a sandbox
				// proxy rewriting Host) or a client-PKCE redirect_uri pointing at this
				// backend callback instead of a frontend page. Genuinely malformed
				// relay envelopes also land here.
				return {
					kind: 'error',
					status: 400,
					code: 'invalid_state',
					message: 'state verification failed: not a relay envelope and no pending-auth cookie '
						+ '(server-initiated callback missing its cookie — likely a host/origin mismatch — '
						+ 'or a malformed relay state)',
				};
			}
			// 'signature': envelope-shaped but failed HMAC — tampering or wrong secret.
			return { kind: 'error', status: 400, code: 'invalid_state', message: 'state verification failed: signature mismatch' };
		}

		const payload = decoded.payload;

		// If no relay target in the envelope, this is a relay-path request
		// without a relay URI (e.g., just csrf + appState). Treat as
		// server-exchange since there's nowhere to redirect.
		if (!payload.relay) {
			return { kind: 'server-exchange' };
		}

		// Defense in depth: re-validate the relay target against the current
		// allowlist. Config could have changed between authorize and callback.
		const validation = validateRelay(payload.relay, {
			allowList: this.options.allowedRelayOrigins ?? [],
			sameOrigin: ctx.request.url,
		});
		if (!validation.allowed) {
			return {
				kind: 'error',
				status: 400,
				code: 'invalid_relay',
				message: `relay target no longer allowed: ${validation.reason}`,
			};
		}

		// If the IdP redirected with `error=...`, forward it through the relay
		// so the SDK doesn't time out waiting for a code that never comes.
		const idpError = ctx.request.url.searchParams.get('error');
		if (idpError) {
			const errorDescription = ctx.request.url.searchParams.get('error_description') ?? '';
			const redirectUrl = buildRelayRedirect(payload.relay, {
				error: idpError,
				error_description: errorDescription,
				state: stateParam,
			});
			return { kind: 'relay-error', redirectTo: redirectUrl };
		}

		// Happy path: code present, 302 to relay with code + state.
		const code = ctx.request.url.searchParams.get('code');
		if (!code) {
			return { kind: 'error', status: 400, code: 'invalid_callback', message: 'missing code parameter' };
		}

		const relayParams: Record<string, string> = { code, state: stateParam };
		const iss = ctx.request.url.searchParams.get('iss');
		if (iss) relayParams.iss = iss;

		const redirectUrl = buildRelayRedirect(payload.relay, relayParams);
		return { kind: 'relay', redirectTo: redirectUrl };
	}

	/**
	 * Handle a client-initiated PKCE exchange.
	 * Same outcome as `handleCallback` (authenticated session).
	 * If `onSignIn` throws, the session is rolled back.
	 */
	async handleExchange(input: ExchangeInput, ctx: BlocksContext): Promise<ExchangeResult> {
		if (!this.providerNames.has(input.provider)) {
			throw providerNotConfigured(input.provider);
		}
		const result = await this.engine.handleExchange(input, ctx);
		if (this.options.onSignIn) {
			try {
				await this.options.onSignIn(result.user, ctx);
			} catch (err) {
				try {
					await this.engine.signOut(ctx);
				} catch {
					// Best-effort rollback — let the original hook error surface.
				}
				throw err;
			}
		}
		if (this.options.allowBearerAuth) {
			return result;
		}
		return { user: result.user };
	}

	/**
	 * Return the public authorize parameters for a provider so the client
	 * can build the IdP authorize URL with its own PKCE.
	 * Pass `request` for relay flows to include a signed `state` envelope.
	 */
	async getAuthorizeParams(
		ctx: BlocksContext,
		provider: string,
		request?: AuthorizeParamsRequest,
	): Promise<AuthorizeParams> {
		if (!this.providerNames.has(provider)) {
			throw providerNotConfigured(provider);
		}
		return this.engine.getAuthorizeParams(provider, ctx, request);
	}

	/**
	 * Refresh bearer tokens. Only callable when `allowBearerAuth` is enabled.
	 * Returns `null` if the refresh token is invalid or rejected.
	 */
	async refreshBearerTokens(
		input: { refreshToken: string; provider: string },
		ctx: BlocksContext,
	): Promise<BearerRefreshResult | null> {
		if (!this.options.allowBearerAuth) return null;
		if (!this.providerNames.has(input.provider)) {
			throw providerNotConfigured(input.provider);
		}
		return this.engine.refreshBearerTokens(input, ctx);
	}

	/**
	 * Clear the session. If `onSignOut` is configured, it fires before
	 * clearing state. Hook errors are logged but don't prevent sign-out.
	 */
	async signOut(ctx: BlocksContext): Promise<void> {
		if (this.options.onSignOut) {
			try {
				const user = await this.engine.verifySession(ctx);
				if (user) {
					await this.options.onSignOut(user, ctx);
				}
			} catch (err) {
				// Hook errors are logged but don't block sign-out — the caller
				// asked for a sign-out and the cookie clear must still happen.
				this.log.warn('AuthOIDC onSignOut hook threw — proceeding with sign-out anyway:', { error: err });
			}
		}
		await this.engine.signOut(ctx);
	}

	/**
	 * Return an `ApiNamespace` implementing the `BlocksAuth` state machine
	 * the Authenticator component consumes.
	 *
	 * @example
	 * ```typescript
	 * // aws-blocks/index.ts — IFC layer
	 * const auth = new AuthOIDC(app, 'auth', { providers: [...] });
	 * export const authApi = auth.createApi();
	 * ```
	 */
	createApi() {
		return new ApiNamespace(this, 'auth', (ctx: BlocksContext) => ({
			getAuthState: async (): Promise<AuthState> => {
				const user = await this.engine.verifySession(ctx);
				return user ? signedInState(user) : this.signedOutState(ctx);
			},
			setAuthState: async (input: AuthActionInput): Promise<AuthState> => {
				if (input.action === 'signOut') {
					await this.signOut(ctx);
					return this.signedOutState(ctx);
				}
				// External actions (IdP redirect sign-in) don't reach here — the
				// Authenticator submits them as HTML forms to the authorize URL.
				return {
					...this.signedOutState(ctx),
					error: `Unknown action: ${input.action}`,
				};
			},
			/**
			 * Return a client handle for OIDC authentication.
			 * On the server it serializes via `toJSON()`; the client middleware
			 * hydrates it into a live `AuthOIDCClient`.
			 */
			getClient: async (): Promise<OIDCClient<ProviderName<P>>> => {
				const providerConfigs: Record<string, { authorizeUrl: string; clientId: string; scopes: string[]; kind: string }> = {};
				for (const name of this.providers) {
					const params = await this.engine.getAuthorizeParams(name, ctx);
					providerConfigs[name] = {
						authorizeUrl: params.authorizeUrl,
						clientId: params.clientId,
						scopes: [...params.scopes],
						kind: params.kind,
					};
				}
				const basePath = this.callbackPath.slice(0, this.callbackPath.lastIndexOf('/'));
				const config = {
					providers: [...this.providers],
					providerConfigs,
					callbackPath: this.callbackPath,
					exchangePath: `${basePath}/exchange`,
					signOutPath: this.signOutPath,
					signInBasePath: this.signInBasePath,
					authorizeParamsBasePath: `${basePath}/authorize-params`,
				};
				return {
					async signIn(_provider: ProviderName<P>, _opts?: { state?: string; redirectPath?: string }) { /* server-side no-op */ },
					async handleRedirectCallback() { return null; },
					async signOut() {},
					onAuthStateChange(_handler: (user: OIDCUser | null, meta: { state?: string } | null) => void) { return () => {}; },
					toJSON() {
						return { __blocks: 'oidc/client' as const, ...config };
					},
				} as OIDCClient<ProviderName<P>>;
			},
		}));
	}

	/**
	 * Compose the `signedOut` state. Each provider becomes an external
	 * `AuthAction` pointing at the sign-in kickoff route.
	 */
	protected signedOutState(_ctx: BlocksContext): AuthState {
		const actions: AuthAction[] = this.options.providers.map((p) => ({
			name: p.name,
			label: `Sign in with ${formatProviderLabel(p.name)}`,
			fields: [],
			url: `${this.signInRoutePath(p.name)}`,
			method: 'GET',
		}));
		return { state: 'signedOut', actions };
	}

	/** The absolute-within-host path for a provider's sign-in kickoff route. */
	signInRoutePath(providerName: string): string {
		return `${this.signInBasePath}/${encodeURIComponent(providerName)}`;
	}

	/**
	 * Base path for sign-in kickoff routes, derived from `callbackPath` so the
	 * whole flow shares one base. Default `/aws-blocks/auth/callback` →
	 * `/aws-blocks/auth/signin`; a custom `/aws-blocks/auth/real/callback` →
	 * `/aws-blocks/auth/real/signin` (matching where the
	 * callback/exchange/authorize-params routes are mounted).
	 */
	get signInBasePath(): string {
		const base = this.callbackPath.slice(0, this.callbackPath.lastIndexOf('/'));
		return `${base}/signin`;
	}
}

function signedInState(user: OIDCUser): AuthState {
	return {
		state: 'signedIn',
		user: { userId: user.userId, username: user.username },
		actions: [{ name: 'signOut', label: 'Sign out', fields: [] }],
	};
}

function formatProviderLabel(name: string): string {
	switch (name) {
		case 'google': return 'Google';
		case 'github': return 'GitHub';
		default: return name;
	}
}

function validateAuthOIDCOptions(options: AuthOIDCOptions<readonly ProviderConfig[]>): void {
	if (!Array.isArray(options.providers) || options.providers.length === 0) {
		throw invalidConfig('AuthOIDC requires at least one provider');
	}
	const seenNames = new Set<string>();
	for (const provider of options.providers) {
		if (!provider || typeof provider !== 'object') {
			throw invalidConfig('provider config must be an object');
		}
		if (typeof provider.name !== 'string' || provider.name.length === 0) {
			throw invalidConfig('provider.name is required');
		}
		if (seenNames.has(provider.name)) {
			throw invalidConfig(`duplicate provider name: ${provider.name}`);
		}
		seenNames.add(provider.name);

		if (provider.clientId === undefined || provider.clientId === null) {
			throw invalidConfig(`provider '${provider.name}' is missing clientId`);
		}
		if (provider.clientSecret === undefined || provider.clientSecret === null) {
			throw invalidConfig(`provider '${provider.name}' is missing clientSecret`);
		}

		switch (provider.kind) {
			case 'oidc-builtin':
			case 'oidc-custom': {
				const issuerUrl = (provider as { issuerUrl?: string }).issuerUrl;
				if (!issuerUrl || !isValidUrl(issuerUrl)) {
					throw invalidConfig(
						`provider '${provider.name}' has invalid issuerUrl: ${issuerUrl ?? '(missing)'}`,
					);
				}
				break;
			}
			case 'oauth2-custom': {
				const p = provider as { authUrl?: string; tokenUrl?: string; userInfoUrl?: string; mapClaims?: unknown };
				if (!p.authUrl || !isValidUrl(p.authUrl)) {
					throw invalidConfig(`provider '${provider.name}' has invalid authUrl: ${p.authUrl ?? '(missing)'}`);
				}
				if (!p.tokenUrl || !isValidUrl(p.tokenUrl)) {
					throw invalidConfig(`provider '${provider.name}' has invalid tokenUrl: ${p.tokenUrl ?? '(missing)'}`);
				}
				if (!p.userInfoUrl || !isValidUrl(p.userInfoUrl)) {
					throw invalidConfig(`provider '${provider.name}' has invalid userInfoUrl: ${p.userInfoUrl ?? '(missing)'}`);
				}
				if (typeof p.mapClaims !== 'function') {
					throw invalidConfig(
						`provider '${provider.name}' (OAuth 2.0) must supply mapClaims(raw) => { providerSub, email, name }`,
					);
				}
				break;
			}
			case 'stub':
				// Stub providers resolve the issuer dynamically to the co-deployed stub IdP.
				break;
			case 'cognito-federated': {
				const cf = provider as { cognitoDomain?: string; region?: string; identityProvider?: string; idpIssuerUrl?: string };
				if (!cf.cognitoDomain || typeof cf.cognitoDomain !== 'string') {
					throw invalidConfig(`provider '${provider.name}' (cognito-federated) is missing cognitoDomain`);
				}
				if (!cf.region || typeof cf.region !== 'string') {
					throw invalidConfig(`provider '${provider.name}' (cognito-federated) is missing region`);
				}
				if (!cf.identityProvider || typeof cf.identityProvider !== 'string') {
					throw invalidConfig(`provider '${provider.name}' (cognito-federated) is missing identityProvider`);
				}
				const builtInIdps = ['Google', 'Facebook', 'LoginWithAmazon', 'SignInWithApple'];
				if (!builtInIdps.includes(cf.identityProvider) && !cf.idpIssuerUrl) {
					throw invalidConfig(
						`provider '${provider.name}' (cognito-federated) requires idpIssuerUrl for custom identity provider '${cf.identityProvider}'`,
					);
				}
				break;
			}
			default:
				throw invalidConfig(`provider '${provider.name}' has unknown kind: ${(provider as { kind: string }).kind}`);
		}

		if (!Array.isArray(provider.scopes)) {
			throw invalidConfig(`provider '${provider.name}' scopes must be an array`);
		}
	}

	// postSignInPath is a frontend landing route — any absolute path is fine.
	if (options.postSignInPath !== undefined
		&& (typeof options.postSignInPath !== 'string' || !options.postSignInPath.startsWith('/'))) {
		throw invalidConfig(`postSignInPath must be an absolute path starting with '/', got: ${JSON.stringify(options.postSignInPath)}`);
	}

	// callbackPath / signOutPath are backend routes that must live under the
	// reserved `/aws-blocks/auth/` subtree so Hosting's single CloudFront behavior
	// proxies them on a deployed CloudFront app (otherwise they 404 at the edge).
	for (const [k, v] of [
		['callbackPath', options.callbackPath],
		['signOutPath', options.signOutPath],
	] as const) {
		if (v === undefined) continue;
		if (typeof v !== 'string' || !v.startsWith(`${BLOCKS_AUTH_PREFIX}/`)) {
			throw invalidConfig(
				`${k} must be a path under '${BLOCKS_AUTH_PREFIX}/' (e.g. '${BLOCKS_AUTH_PREFIX}/callback'), got: ${JSON.stringify(v)}. `
					+ `Auth routes live under the reserved namespace so deployed CloudFront apps proxy the whole flow.`,
			);
		}
	}
}

function isValidUrl(s: string): boolean {
	try {
		const u = new URL(s);
		return u.protocol === 'http:' || u.protocol === 'https:';
	} catch {
		return false;
	}
}

function notAuthenticated(): Error {
	const err = new Error('Authentication required');
	err.name = 'NotAuthenticatedException';
	return err;
}

function providerNotConfigured(name: string): Error {
	const err = new Error(`Provider not configured: ${name}`);
	err.name = 'ProviderNotConfiguredException';
	return err;
}

function invalidConfig(message: string): Error {
	const err = new Error(`AuthOIDC config error: ${message}`);
	err.name = 'AuthOIDCConfigError';
	return err;
}

/** Result of the relay-aware callback dispatch. */
export type CallbackResult =
	| { kind: 'server-exchange' }
	| { kind: 'relay'; redirectTo: string }
	| { kind: 'relay-error'; redirectTo: string }
	| { kind: 'error'; status: number; code: string; message: string };

/** Build the relay redirect URL by appending query params. */
function buildRelayRedirect(relay: string, params: Record<string, string>): string {
	const url = new URL(relay);
	for (const [key, value] of Object.entries(params)) {
		if (value) url.searchParams.set(key, value);
	}
	return url.toString();
}
