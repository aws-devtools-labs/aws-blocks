// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Browser entry point for `AuthOIDC`.
 *
 * Ships `AuthOIDCClient` (sign-in via IdP redirect, PKCE exchange, state
 * change notifications) and a 401-handling middleware.
 */

import { ApiError, registerMiddleware } from '@aws-blocks/core/client';

// Provider helpers are pure config builders — safe to ship to the browser.
export {
	google,
	github,
	customOidc,
	customOauth2,
	stubIdp,
	type CustomOidcOpts,
	type CustomOauth2Opts,
	type StubIdpOpts,
} from './providers.js';

export { relayOrigin, type RelayOrigin } from './relay.js';

export { AuthOIDCErrors, type AuthOIDCErrorName } from './errors.js';
export type {
	AuthOIDCOptions,
	OIDCUser,
	ProviderConfig,
	ProviderName,
	ProviderOpts,
	ProviderKind,
	GoogleProvider,
	GitHubProvider,
	CustomOidcProvider,
	CustomOauth2Provider,
	StubProvider,
	MappedClaims,
	SecretLike,
	SignInUrlOptions,
} from './types.js';

/**
 * Module-scoped state for the 401 redirect middleware.
 */
let _defaultSignInProvider: string | null = null;
let _signInBasePath: string = '/aws-blocks/auth/signin';

function _redirectToSignIn(): void {
	if (typeof window === 'undefined') return;
	const provider = _defaultSignInProvider ?? 'google';
	window.location.href = `${_signInBasePath}/${encodeURIComponent(provider)}`;
}

/**
 * Resolve the API URL for retry requests.
 */
let _cachedApiUrl: string | null = null;
async function _getApiUrlForRetry(): Promise<string> {
	if (_cachedApiUrl) return _cachedApiUrl;
	if (typeof process !== 'undefined' && process.env?.BLOCKS_API_URL) {
		_cachedApiUrl = process.env.BLOCKS_API_URL;
		return _cachedApiUrl;
	}
	try {
		const response = await fetch('/.blocks-sandbox/config.json');
		if (response.ok) {
			const config = await response.json();
			_cachedApiUrl = config.apiUrl as string;
			return _cachedApiUrl;
		}
	} catch { /* fall through */ }
	throw new Error('Cannot resolve API URL for retry');
}

/**
 * Resolve the API base **origin** from a (possibly relative) `apiUrl`.
 *
 * The deployed single-origin front door writes a relative `apiUrl`
 * (`"/aws-blocks/api"`); local/sandbox write an absolute one
 * (`"http://localhost:3001/aws-blocks/api"`). Resolving against the current
 * page origin yields the app's own origin for the relative case and is ignored
 * for the absolute case — avoiding `new URL("/aws-blocks/api")` throwing
 * "Invalid URL".
 *
 * @internal Exported for testing.
 */
export function resolveApiBaseOrigin(apiUrl: string, pageOrigin?: string): string {
	return new URL(apiUrl, pageOrigin).origin;
}

/** Resolve the API base URL (origin) for auth endpoint requests. */
let _cachedBaseUrl: string | null = null;
async function _getBaseUrl(): Promise<string> {
	if (_cachedBaseUrl) return _cachedBaseUrl;
	const apiUrl = await _getApiUrlForRetry();
	const pageOrigin = typeof window !== 'undefined' ? window.location.origin : undefined;
	_cachedBaseUrl = resolveApiBaseOrigin(apiUrl, pageOrigin);
	return _cachedBaseUrl;
}

function hydrateOidcResponse(data: unknown): unknown {
	if (typeof data === 'object' && data !== null && (data as any).__blocks === 'oidc/client') {
		return createOidcClient(data as any);
	}
	if (Array.isArray(data)) return data.map(hydrateOidcResponse);
	if (typeof data === 'object' && data !== null) {
		const result: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(data)) result[k] = hydrateOidcResponse(v);
		return result;
	}
	return data;
}

/**
 * Create a plain-object OIDC client from the hydrated descriptor.
 */
function createOidcClient(options: any) {
	const client = new AuthOIDCClient(options);
	return {
		providers: client.providers,
		signIn: client.signIn.bind(client),
		handleRedirectCallback: client.handleRedirectCallback.bind(client),
		signOut: client.signOut.bind(client),
		onAuthStateChange: client.onAuthStateChange.bind(client),
	};
}

registerMiddleware({ onResponse: hydrateOidcResponse });

/**
 * Helper that inspects a caught error and, if it's a 401, redirects to
 * the given provider's sign-in route. Returns `true` when a redirect was
 * scheduled so the caller can early-return without surfacing the error.
 *
 * @example
 * ```typescript
 * import { handle401 } from '@aws-blocks/bb-auth-oidc';
 * import { api } from 'aws-blocks';
 *
 * try {
 *   return await api.listMyPosts();
 * } catch (e) {
 *   if (handle401(e, 'google')) return;
 *   throw e;
 * }
 * ```
 */
export function handle401(err: unknown, provider: string): boolean {
	if (err instanceof ApiError && err.status === 401) {
		if (typeof window !== 'undefined') {
			window.location.href = `${_signInBasePath}/${encodeURIComponent(provider)}`;
		}
		return true;
	}
	return false;
}

/** Optional metadata passed alongside the user to `onAuthStateChange`. */
export interface AuthStateMeta {
	/** Round-tripped app-level state from `signIn(provider, { state })`. */
	state?: string;
}

export type AuthStateHandler<U> = (user: U | null, meta: AuthStateMeta | null) => void;

const subscribers = new Set<AuthStateHandler<unknown>>();
let lastUser: unknown | null = null;

/**
 * In-flight `handleRedirectCallback` guard, keyed by `(exchangePath, code)`.
 *
 * Scoped to same-tab, in-process concurrency: a double invocation — e.g. React
 * StrictMode's mount → unmount → mount, which fires the callback effect twice
 * synchronously — shares this one promise instead of racing to exchange the
 * single-use code twice. The second exchange would fail (or find the pending
 * entry already consumed and return `null`), stranding the app on a signed-out
 * screen despite a successful sign-in.
 *
 * This module variable does not survive a real page reload; cross-reload
 * coordination falls back to the up-front `sessionStorage` removal in
 * `_exchangeCallback` (a late caller finds no pending entry and resolves
 * `null`). Keying on `exchangePath` keeps two clients with distinct exchange
 * endpoints from sharing each other's in-flight exchange.
 *
 * The guard is released once the exchange settles (success or failure) so a
 * genuinely new flow on the same page is never blocked.
 */
let _callbackInflight: { exchangePath: string; code: string; promise: Promise<unknown> } | null = null;

function notify(user: unknown | null, meta: AuthStateMeta | null): void {
	for (const sub of subscribers) {
		try { sub(user, meta); } catch { /* swallow handler errors */ }
	}
}

/**
 * Browser-side `AuthOIDC` handle. Get one via `authApi.getClient()`.
 *
 * @example
 * ```tsx
 * const auth = await authApi.getClient();
 * <button onClick={() => auth.signIn('google')}>Sign in with Google</button>
 * ```
 */
export class AuthOIDCClient<
	Provider extends string = string,
	User = { userId: string; username: string },
> {
	readonly providers: readonly Provider[];

	readonly signInBasePath: string;

	readonly signOutPath: string;

	readonly exchangePath: string;

	readonly callbackPath: string;

	readonly authorizeParamsBasePath: string;

	private readonly providerConfigs?: Record<string, { authorizeUrl: string; clientId: string; scopes: string[]; kind: string }>;

	constructor(options: {
		providers: readonly Provider[];
		providerConfigs?: Record<string, { authorizeUrl: string; clientId: string; scopes: string[]; kind: string }>;
		callbackPath?: string;
		signInBasePath?: string;
		signOutPath?: string;
		exchangePath?: string;
		authorizeParamsBasePath?: string;
	}) {
		this.providers = options.providers;
		this.callbackPath = options.callbackPath ?? '/aws-blocks/auth/callback';
		this.signInBasePath = options.signInBasePath ?? '/aws-blocks/auth/signin';
		this.signOutPath = options.signOutPath ?? '/aws-blocks/auth/signout';
		this.exchangePath = options.exchangePath ?? '/aws-blocks/auth/exchange';
		this.authorizeParamsBasePath = options.authorizeParamsBasePath ?? '/aws-blocks/auth/authorize-params';
		this.providerConfigs = options.providerConfigs;
		if (options.providers.length > 0) {
			_defaultSignInProvider = options.providers[0];
			_signInBasePath = this.signInBasePath;
		}
	}

	/**
	 * Initiate sign-in using client-initiated PKCE. Navigates the
	 * browser to the IdP. Call `handleRedirectCallback()` on return.
	 *
	 * @param opts.state - Opaque app state, round-tripped to `onAuthStateChange`.
	 * @param opts.redirectPath - Path (or absolute URL) the IdP redirects back to
	 *   and that runs `handleRedirectCallback()`. Becomes the OAuth `redirect_uri`,
	 *   so it must be a frontend-served page registered with the provider.
	 *   Defaults to the current page.
	 */
	signIn(provider: Provider, opts?: { state?: string; redirectPath?: string }): void {
		void this._signInPKCE(provider, opts?.state, opts?.redirectPath);
	}

	/**
	 * Client-initiated PKCE sign-in. Fetches authorize params, generates
	 * PKCE + state + nonce, stores in sessionStorage, navigates to IdP.
	 */
	private async _signInPKCE(provider: Provider, appState?: string, redirectPath?: string): Promise<void> {
		let params: { authorizeUrl: string; clientId: string; scopes: string[]; kind: string };

		if (this.providerConfigs && this.providerConfigs[provider as string]) {
			params = this.providerConfigs[provider as string];
		} else {
			const baseUrl = await _getBaseUrl();
			const paramsResp = await fetch(`${baseUrl}${this.authorizeParamsBasePath}/${encodeURIComponent(String(provider))}`, {
				credentials: 'include',
			});
			if (!paramsResp.ok) {
				throw new Error(`AuthOIDC: failed to fetch authorize params for '${String(provider)}': ${paramsResp.status}`);
			}
			params = await paramsResp.json() as typeof params;
		}

		const verifier = _generateCodeVerifier();
		const challenge = await _calculateCodeChallenge(verifier);
		const state = _generateRandom();
		const nonce = _generateRandom();

		// Redirect target = the page that runs handleRedirectCallback(). Default to
		// the current page (strip query/hash so the IdP's appended ?code=&state=
		// lands clean); honor an explicit redirectPath, resolved against the current
		// page so a relative '/spa-callback' works. Deliberately NOT this.callbackPath
		// — that backend route would collide same-origin.
		const redirectTarget = redirectPath ?? `${window.location.origin}${window.location.pathname}`;
		const callbackUrl = new URL(redirectTarget, window.location.href).toString();
		sessionStorage.setItem(_PENDING_STORAGE_KEY, JSON.stringify({
			provider, verifier, state, nonce, callbackUrl, appState,
		}));

		const authorizeUrl = new URL(params.authorizeUrl);
		authorizeUrl.searchParams.set('response_type', 'code');
		authorizeUrl.searchParams.set('client_id', params.clientId);
		authorizeUrl.searchParams.set('redirect_uri', callbackUrl);
		authorizeUrl.searchParams.set('scope', params.scopes.join(' '));
		authorizeUrl.searchParams.set('state', state);
		authorizeUrl.searchParams.set('code_challenge', challenge);
		authorizeUrl.searchParams.set('code_challenge_method', 'S256');
		if (params.kind !== 'oauth2-custom') {
			authorizeUrl.searchParams.set('nonce', nonce);
		}

		window.location.href = authorizeUrl.toString();
	}

	/**
	 * Complete the IdP redirect callback. Reads `code`/`state` from the URL,
	 * verifies state, and POSTs to `/aws-blocks/auth/exchange`.
	 *
	 * Idempotent under double invocation: a second call for the same PKCE
	 * `code` while the exchange is in flight (e.g. React StrictMode's
	 * double-mount) shares the first call's promise rather than replaying the
	 * single-use code, so both callers resolve to the same user.
	 *
	 * @returns The authenticated user, or `null` if no pending PKCE flow.
	 */
	handleRedirectCallback(): Promise<User | null> {
		if (typeof window === 'undefined') return Promise.resolve(null);
		const { searchParams } = new URL(window.location.href);
		const code = searchParams.get('code');
		const returnedState = searchParams.get('state');
		if (!code || !returnedState) return Promise.resolve(null);

		// Share an in-flight exchange for this endpoint + code so a concurrent/
		// double invocation can't consume the single-use code twice.
		if (_callbackInflight && _callbackInflight.code === code && _callbackInflight.exchangePath === this.exchangePath) {
			return _callbackInflight.promise as Promise<User | null>;
		}

		// Forward RFC 9207 `iss` when present — the server-side exchange passes
		// it to openid-client, which fails the exchange if the provider sent it
		// and we drop it.
		const iss = searchParams.get('iss') ?? undefined;
		const promise = this._exchangeCallback(code, returnedState, iss);
		_callbackInflight = { exchangePath: this.exchangePath, code, promise };
		return promise;
	}

	/**
	 * Perform the one-shot PKCE code exchange. Consumes the pending entry up
	 * front (so a late duplicate can't replay it) and releases the in-flight
	 * guard once settled.
	 *
	 * @param iss - RFC 9207 issuer read from the callback URL (forwarded to the
	 *   server-side exchange), or `undefined` when the provider sent none.
	 */
	private async _exchangeCallback(code: string, returnedState: string, iss: string | undefined): Promise<User | null> {
		try {
			// Consume the single-use pending PKCE entry up front. Removing it before
			// the network round-trip (rather than after) means a duplicate call that
			// somehow misses the in-flight guard still can't start a second exchange.
			const raw = sessionStorage.getItem(_PENDING_STORAGE_KEY);
			if (!raw) return null;
			sessionStorage.removeItem(_PENDING_STORAGE_KEY);

			const pending = JSON.parse(raw) as {
				provider: string;
				verifier: string;
				state: string;
				nonce: string;
				callbackUrl: string;
				appState?: string;
			};

			if (returnedState !== pending.state) {
				throw new Error('AuthOIDC: state mismatch in callback');
			}

			const baseUrl = await _getBaseUrl();
			const resp = await fetch(`${baseUrl}${this.exchangePath}`, {
				method: 'POST',
				credentials: 'include',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					code,
					verifier: pending.verifier,
					state: pending.state,
					nonce: pending.nonce,
					provider: pending.provider,
					callbackUrl: pending.callbackUrl,
					...(iss ? { iss } : {}),
				}),
			});

			if (!resp.ok) {
				const err = await resp.json().catch(() => ({ error: 'Exchange failed' }));
				throw new Error(`AuthOIDC exchange failed: ${(err as any).error ?? resp.status}`);
			}

			const body = await resp.json() as { user?: User } & Partial<User>;
			// /aws-blocks/auth/exchange wraps the user (`{ user }`, or `{ user, accessToken, ... }`
			// in bearer mode); unwrap to match the declared `User` return type. `?? body`
			// guards a future engine path that returns a bare user.
			const user = (body.user ?? body) as User;
			lastUser = user;
			notify(user, { state: pending.appState });
			return user;
		} finally {
			// Release the guard once this exchange settles (success or failure) so a
			// brand-new flow on the same page is never blocked by a stale entry.
			if (_callbackInflight?.code === code && _callbackInflight?.exchangePath === this.exchangePath) {
				_callbackInflight = null;
			}
		}
	}

	/** Sign out and reload the page. */
	async signOut(): Promise<void> {
		const baseUrl = await _getBaseUrl();
		await fetch(`${baseUrl}${this.signOutPath}`, { method: 'POST', credentials: 'include' });
		lastUser = null;
		notify(null, null);
		if (typeof window !== 'undefined' && window.location) {
			window.location.reload();
		}
	}

	/**
	 * Subscribe to auth-state changes. Fires immediately with last-known state.
	 * @returns Unsubscribe function.
	 */
	onAuthStateChange(handler: AuthStateHandler<User>): () => void {
		const wrapped = handler as AuthStateHandler<unknown>;
		subscribers.add(wrapped);
		try { handler(lastUser as User | null, null); } catch { /* swallow */ }
		return () => { subscribers.delete(wrapped); };
	}
}

const _PENDING_STORAGE_KEY = '__blocks_oidc_pending';

/** Generate a code verifier per RFC 7636 §4.1. */
function _generateCodeVerifier(): string {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	return _base64UrlEncode(bytes);
}

/** S256 code challenge per RFC 7636 §4.2. */
async function _calculateCodeChallenge(verifier: string): Promise<string> {
	const encoder = new TextEncoder();
	const data = encoder.encode(verifier);
	const digest = await crypto.subtle.digest('SHA-256', data);
	return _base64UrlEncode(new Uint8Array(digest));
}

function _generateRandom(): string {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	return _base64UrlEncode(bytes);
}

function _base64UrlEncode(bytes: Uint8Array): string {
	let binary = '';
	for (let i = 0; i < bytes.length; i++) {
		binary += String.fromCharCode(bytes[i]);
	}
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
