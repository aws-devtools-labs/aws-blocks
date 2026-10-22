// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `@aws-blocks/bb-auth/browser-client` — redirect sign-in for a web frontend
 * served from a **different origin** than the `Auth` block's API (decision
 * L69). It replaces `AuthOIDC`'s `getClient()` browser PKCE client.
 *
 * It speaks the block's existing routes, so there is no new server protocol
 * for sign-in. It is the browser twin of the native SDKs' relay sign-in:
 *
 * 1. `signInWithRedirect()` asks `POST <base>/authorize-params/<provider>` for
 *    a signed `state` envelope bound to a fresh CSRF value and to `relayTo` =
 *    this app's return page. The server checks `relayTo` against
 *    `redirects.allowedRelayOrigins`. Then it sends the browser to the
 *    provider with PKCE (S256), the provider's `redirect_uri` being the
 *    block's own HTTPS callback.
 * 2. The provider returns to the block's callback, which verifies the envelope,
 *    re-checks `relayTo` against the allowlist and 302s the one-time `code`
 *    to the return page.
 * 3. `handleSignInRedirect()` on that page checks the returned `state` and
 *    its CSRF value, then POSTs the code and the PKCE verifier to
 *    `<base>/exchange` with credentials. The server answers with the user and
 *    sets the session cookie.
 *
 * Afterwards `getCurrentUser()` / `fetchAuthSession()` read
 * `GET <base>/session`, and `signOut()` POSTs to the sign-out route. The
 * session stays in the block's HttpOnly cookie: this module never stores
 * tokens.
 *
 * The method names follow Amplify JS v6 (`signInWithRedirect`,
 * `fetchAuthSession`, `getCurrentUser`, `signOut`), so a future unified client
 * can sit behind the same calls. The types are the block's own: errors carry
 * {@link AuthErrors} names, and the user is the shape the browser already
 * receives from `getAuthState()`.
 *
 * Browser-safe: no Node built-ins. It uses `fetch`, Web Crypto,
 * `sessionStorage`, `location` and `history`, each replaceable through
 * {@link AuthClientOptions.environment} (tests, other runtimes).
 *
 * @example
 * ```typescript
 * import { createAuthClient } from '@aws-blocks/bb-auth/browser-client';
 *
 * const auth = createAuthClient({ baseUrl: 'https://api.example.com' });
 *
 * // Sign-in button:
 * await auth.signInWithRedirect({ provider: 'okta' });
 *
 * // On every page load (the provider returns to this page):
 * const result = await auth.handleSignInRedirect();
 * const session = await auth.fetchAuthSession();
 * if (session.signedIn) console.log(`Hello ${session.user.displayName}`);
 * ```
 */

// From `@aws-blocks/core`'s browser entry in a browser bundle: only its client-safe exports.
import { ApiError } from '@aws-blocks/core';
import { AuthErrors } from './errors.js';
import type {
	AuthClient,
	AuthClientEnvironment,
	AuthClientOptions,
	BrowserAuthSession,
	BrowserUser,
	SignInRedirectResult,
	SignInWithRedirectInput,
	SignOutResult,
} from './types.js';

export type {
	AuthClient,
	AuthClientEnvironment,
	AuthClientOptions,
	BrowserAuthSession,
	BrowserUser,
	SignInRedirectResult,
	SignInWithRedirectInput,
	SignOutResult,
} from './types.js';

// `BLOCKS_AUTH_PREFIX` is not in core's browser entry, so the defaults are spelled out (pinned by a test).
const DEFAULT_CALLBACK_PATH = '/aws-blocks/auth/callback';
const DEFAULT_SIGN_OUT_PATH = '/aws-blocks/auth/signout';
/** A pending sign-in older than this is discarded (the provider round trip is minutes, not hours). */
const PENDING_TTL_MS = 10 * 60 * 1000;
/** The OAuth response parameters `handleSignInRedirect()` reads and then removes from the URL. */
const RETURN_PARAMS = ['code', 'state', 'iss', 'error', 'error_description', 'error_uri'] as const;

/** What `signInWithRedirect()` keeps in storage for the return page. */
interface PendingSignIn {
	provider: string;
	csrf: string;
	verifier: string;
	state: string;
	nonce: string;
	createdAt: number;
}

function base64url(bytes: Uint8Array): string {
	let binary = '';
	for (const b of bytes) binary += String.fromCharCode(b);
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomToken(): string {
	return base64url(globalThis.crypto.getRandomValues(new Uint8Array(32)));
}

async function s256(verifier: string): Promise<string> {
	const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
	return base64url(new Uint8Array(digest));
}

/**
 * The payload of a state envelope (`base64url(JSON(payload)).<sig>`) — the
 * `csrf` this tab generated and the round-tripped `app` state. Not verified:
 * the signature is the server's to check; the tab only compares its own CSRF
 * value. `null` when `state` is not an envelope.
 */
function envelopePayload(state: string): { csrf?: string; app?: string } | null {
	const dot = state.indexOf('.');
	if (dot <= 0) return null;
	try {
		const body = state.slice(0, dot).replace(/-/g, '+').replace(/_/g, '/');
		const json: unknown = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(body), (c) => c.charCodeAt(0))));
		if (typeof json !== 'object' || json === null) return null;
		const csrf: unknown = Reflect.get(json, 'csrf');
		const app: unknown = Reflect.get(json, 'app');
		return {
			...(typeof csrf === 'string' ? { csrf } : {}),
			...(typeof app === 'string' ? { app } : {}),
		};
	} catch {
		return null;
	}
}

/** Whether a route's `user` field has the shape the block sends. */
function isBrowserUser(value: unknown): value is BrowserUser {
	if (typeof value !== 'object' || value === null) return false;
	return ['userId', 'username', 'userSub'].every((k) => typeof Reflect.get(value, k) === 'string');
}

/** The `user` field of a route response, checked. */
async function userOf(res: Response, what: string): Promise<BrowserUser> {
	const body: unknown = await res.json();
	const user: unknown = typeof body === 'object' && body !== null ? Reflect.get(body, 'user') : undefined;
	if (!isBrowserUser(user)) {
		throw new ApiError(`The ${what} response had no user`, 502, { name: AuthErrors.InternalError });
	}
	return user;
}

/** The same `<base>` the server derives: the directory of the callback path. */
function basePathOf(callbackPath: string): string {
	return callbackPath.slice(0, callbackPath.lastIndexOf('/'));
}

function browserEnvironment(): AuthClientEnvironment {
	const win: unknown = Reflect.get(globalThis, 'window');
	const unavailable = (what: string) => (): never => {
		throw new Error(
			`@aws-blocks/bb-auth/browser-client: ${what} is not available here. Call it in a browser, ` +
				'or pass `environment` to createAuthClient().',
		);
	};
	const storage = win ? Reflect.get(globalThis, 'sessionStorage') : undefined;
	const location = win ? Reflect.get(globalThis, 'location') : undefined;
	const history = win ? Reflect.get(globalThis, 'history') : undefined;
	return {
		fetch: (input, init) => globalThis.fetch(input, init),
		storage: storage ?? {
			getItem: unavailable('sessionStorage'),
			setItem: unavailable('sessionStorage'),
			removeItem: unavailable('sessionStorage'),
		},
		currentUrl: location ? () => String(Reflect.get(location, 'href')) : unavailable('location'),
		navigate: location ? (url) => Reflect.apply(Reflect.get(location, 'assign'), location, [url]) : unavailable('location'),
		replaceUrl: history
			? (url) => Reflect.apply(Reflect.get(history, 'replaceState'), history, [Reflect.get(history, 'state'), '', url])
			: unavailable('history'),
	};
}

/** Turn a non-2xx route response into an `ApiError` with the block's error name. */
async function routeError(res: Response, fallbackName: string, fallbackMessage: string): Promise<ApiError> {
	let body: unknown;
	try {
		body = await res.json();
	} catch {
		body = undefined;
	}
	const field = (key: string): string | undefined => {
		if (typeof body !== 'object' || body === null) return undefined;
		const v: unknown = Reflect.get(body, key);
		return typeof v === 'string' && v.length > 0 ? v : undefined;
	};
	if (field('error') === 'invalid_relay') {
		return new ApiError(
			`This page's address is not allowed to receive the sign-in (${field('reason') ?? 'unknown-origin'}). ` +
				"Add its origin to the Auth block's redirects.allowedRelayOrigins with relayOrigin().",
			res.status,
			{ name: AuthErrors.InvalidRelay },
		);
	}
	return new ApiError(field('message') ?? field('error') ?? fallbackMessage, res.status, {
		name: field('name') ?? fallbackName,
	});
}

/**
 * Create a redirect sign-in client for an `Auth` block whose routes are served
 * under {@link AuthClientOptions.baseUrl}.
 *
 * Server setup for a frontend on another origin:
 * - `redirects.allowedRelayOrigins: [relayOrigin('https://app.example.com')]`
 *   on the `Auth` block (loopback `http://127.0.0.1:<port>` is always allowed,
 *   for local development);
 * - the frontend origin in the stack's CORS allowlist (`defaults.allowedOrigins`);
 * - `session: { crossDomain: true }` when the frontend and the API are on
 *   different registrable domains (not needed for `app.example.com` →
 *   `api.example.com`).
 *
 * `P` narrows `provider` to your provider ids, e.g.
 * `createAuthClient<'okta' | 'google'>(…)`.
 */
export function createAuthClient<P extends string = string>(options: AuthClientOptions = {}): AuthClient<P> {
	const env: AuthClientEnvironment = { ...browserEnvironment(), ...options.environment };
	const callbackPath = options.callbackPath ?? DEFAULT_CALLBACK_PATH;
	const signOutPath = options.signOutPath ?? DEFAULT_SIGN_OUT_PATH;
	const base = basePathOf(callbackPath);
	const baseUrl = (): string => (options.baseUrl ?? new URL(env.currentUrl()).origin).replace(/\/+$/, '');
	const apiUrl = (path: string): string => `${baseUrl()}${path}`;
	const pendingKey = (): string => `blocks-auth:pending:${baseUrl()}${base}`;
	const defaultRedirectUri = (): string => {
		const here = new URL(env.currentUrl());
		return `${here.origin}${here.pathname}`;
	};

	const readPending = (): PendingSignIn | null => {
		const raw = env.storage.getItem(pendingKey());
		if (!raw) return null;
		try {
			const value: unknown = JSON.parse(raw);
			if (typeof value !== 'object' || value === null) return null;
			const get = (k: string): unknown => Reflect.get(value, k);
			const pending: PendingSignIn = {
				provider: String(get('provider') ?? ''),
				csrf: String(get('csrf') ?? ''),
				verifier: String(get('verifier') ?? ''),
				state: String(get('state') ?? ''),
				nonce: String(get('nonce') ?? ''),
				createdAt: Number(get('createdAt') ?? 0),
			};
			return pending.provider && pending.csrf && pending.verifier && pending.state ? pending : null;
		} catch {
			return null;
		}
	};

	const readSession = async (): Promise<BrowserUser | null> => {
		const res = await env.fetch(apiUrl(`${base}/session`), { method: 'GET', credentials: 'include' });
		if (res.status === 401) return null;
		if (!res.ok) throw await routeError(res, AuthErrors.InternalError, 'Could not read the session');
		return userOf(res, 'session');
	};

	return {
		async signInWithRedirect(input: SignInWithRedirectInput<P>): Promise<void> {
			const provider = input.provider;
			const csrf = randomToken();
			const verifier = randomToken();
			const relayTo = input.redirectUri ?? options.redirectUri ?? defaultRedirectUri();
			const res = await env.fetch(apiUrl(`${base}/authorize-params/${encodeURIComponent(provider)}`), {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					csrf,
					relayTo,
					...(input.customState !== undefined ? { appState: input.customState } : {}),
				}),
			});
			if (!res.ok) throw await routeError(res, AuthErrors.ProviderNotConfigured, `Cannot sign in with '${provider}'`);
			const params: unknown = await res.json();
			const get = (k: string): unknown =>
				typeof params === 'object' && params !== null ? Reflect.get(params, k) : undefined;
			const authorizeUrl = get('authorizeUrl');
			const clientId = get('clientId');
			const state = get('state');
			const scopes = get('scopes');
			const nonce = get('nonce');
			if (typeof authorizeUrl !== 'string' || typeof clientId !== 'string' || typeof state !== 'string') {
				throw new ApiError('The sign-in parameters response was incomplete', 502, {
					name: AuthErrors.ProviderMisconfigured,
				});
			}
			const pending: PendingSignIn = {
				provider,
				csrf,
				verifier,
				state,
				nonce: typeof nonce === 'string' ? nonce : '',
				createdAt: Date.now(),
			};
			env.storage.setItem(pendingKey(), JSON.stringify(pending));
			const url = new URL(authorizeUrl);
			url.searchParams.set('response_type', 'code');
			url.searchParams.set('client_id', clientId);
			url.searchParams.set('redirect_uri', apiUrl(callbackPath));
			if (Array.isArray(scopes)) url.searchParams.set('scope', scopes.filter((s) => typeof s === 'string').join(' '));
			url.searchParams.set('state', state);
			url.searchParams.set('code_challenge', await s256(verifier));
			url.searchParams.set('code_challenge_method', 'S256');
			if (pending.nonce) url.searchParams.set('nonce', pending.nonce);
			env.navigate(url.toString());
		},

		async handleSignInRedirect(): Promise<SignInRedirectResult | null> {
			const here = new URL(env.currentUrl());
			const params = here.searchParams;
			if (!params.has('code') && !params.has('error')) return null;
			const pending = readPending();
			// Whatever happens next, this tab's pending sign-in and the one-time
			// parameters in the address bar are used up.
			env.storage.removeItem(pendingKey());
			const clean = new URL(here.toString());
			for (const key of RETURN_PARAMS) clean.searchParams.delete(key);
			env.replaceUrl(clean.toString());

			if (!pending || Date.now() - pending.createdAt > PENDING_TTL_MS) {
				throw new ApiError('No sign-in was started in this tab, or it expired. Start the sign-in again.', 400, {
					name: AuthErrors.InvalidCallback,
				});
			}
			const state = params.get('state');
			if (!state || state !== pending.state || envelopePayload(state)?.csrf !== pending.csrf) {
				throw new ApiError('The sign-in response did not match the sign-in this tab started.', 400, {
					name: AuthErrors.InvalidState,
				});
			}
			const error = params.get('error');
			if (error) {
				// The provider's own description is not shown: it is external text.
				throw new ApiError(`Sign-in with '${pending.provider}' was not completed (${error}).`, 400, {
					name: AuthErrors.IdpError,
				});
			}
			const code = params.get('code') ?? '';
			const iss = params.get('iss');
			const res = await env.fetch(apiUrl(`${base}/exchange`), {
				method: 'POST',
				credentials: 'include',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					code,
					verifier: pending.verifier,
					state,
					provider: pending.provider,
					callbackUrl: apiUrl(callbackPath),
					nonce: pending.nonce,
					...(iss ? { iss } : {}),
				}),
			});
			if (!res.ok) throw await routeError(res, AuthErrors.InvalidCallback, 'The sign-in could not be completed');
			// The response may also carry bearer tokens (`allowBearerAuth`): they
			// are ignored here. The browser's session is the HttpOnly cookie.
			const exchanged = await userOf(res, 'sign-in');
			// The session route adds the display name the exchange response lacks.
			const user = (await readSession()) ?? exchanged;
			const customState = envelopePayload(state)?.app;
			return { user, ...(customState !== undefined ? { customState } : {}) };
		},

		async getCurrentUser(): Promise<BrowserUser> {
			const user = await readSession();
			if (!user) throw new ApiError('Not signed in', 401, { name: AuthErrors.NotAuthenticated });
			return user;
		},

		async fetchAuthSession(): Promise<BrowserAuthSession> {
			const user = await readSession();
			return user ? { signedIn: true, user } : { signedIn: false };
		},

		async signOut(signOutOptions?: { endProviderSession?: boolean }): Promise<SignOutResult> {
			const res = await env.fetch(`${apiUrl(signOutPath)}?format=json`, {
				method: 'POST',
				credentials: 'include',
				headers: { 'Content-Type': 'application/json' },
				body: '{}',
			});
			if (!res.ok) throw await routeError(res, AuthErrors.InternalError, 'Sign-out failed');
			const body: unknown = await res.json();
			const logoutUrl: unknown = typeof body === 'object' && body !== null ? Reflect.get(body, 'logoutUrl') : undefined;
			const result: SignOutResult = typeof logoutUrl === 'string' ? { logoutUrl } : {};
			if (signOutOptions?.endProviderSession && result.logoutUrl) env.navigate(result.logoutUrl);
			return result;
		},
	};
}
