// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The federation HTTP routes — one `RawRoute` per path, shared by every
 * runtime layer and every federation engine (direct, stub IdP, and the
 * hosted-UI engine of D6b, which plugs in through the same
 * {@link FederationEngine} contract and the shared pending-auth cookie).
 *
 * ## The route table
 *
 * `<base>` is the directory of `redirects.callbackPath` — `/aws-blocks/auth`
 * by default — and `<id>` is `encodeURIComponent(providerId)`. Every path is
 * explicit: **no wildcard and no root route** (AGENTS.md rule 12). They are
 * the paths `AuthOIDC` serves, so the native SDKs keep working.
 *
 * | Construct id | Method | Path | |
 * |---|---|---|---|
 * | `auth-signin-<id>` | GET | `<base>/signin/<id>` | `302` to the IdP + pending cookie |
 * | `auth-callback` | GET | `<base>/callback` | the {@link dispatchCallback} → `302` landing / relay, or 4xx JSON |
 * | `auth-signout` | POST | `<base>/signout` | ends the session; a browser form gets `303` to the IdP logout (or `postSignOutPath`), an API client `204` |
 * | `auth-signout-landing` | GET | `<base>/signout` | where Cognito's `/logout` returns (with a GET): `302` to `postSignOutPath`; changes no state |
 * | `auth-exchange` | POST | `<base>/exchange` | browser-PKCE / native code exchange → `{ user, …tokens }` |
 * | `auth-authorize-params-<id>` | GET | `<base>/authorize-params/<id>` | public authorize parameters |
 * | `auth-authorize-params-post-<id>` | POST | `<base>/authorize-params/<id>` | + a signed relay `state` and a `nonce` |
 * | `auth-refresh` | POST | `<base>/refresh` | bearer refresh — only with `allowBearerAuth` |
 * | `auth-refresh-exchange` | POST | `<base>/exchange/refresh` | the same — the path the Swift and Dart SDKs default to |
 *
 * plus, on the mock only, the stub IdP's routes under `/aws-blocks/auth/idp/<id>/`
 * (`engines/stub-idp.ts`).
 *
 * ## Three transports
 *
 * 1. **Server-initiated** (the `signIn:<id>` UI button): `signin/<id>` sets the
 *    signed pending cookie and 302s to the IdP; the IdP 302s to `callback`;
 *    the engine named in the cookie exchanges the code; the session cookie is
 *    set and the browser lands on `redirectPath ?? postSignInPath ?? '/'`.
 * 2. **Browser PKCE**: the client runs PKCE itself (authorize parameters from
 *    `authorize-params/<id>`), then POSTs the code + verifier to `exchange`.
 * 3. **Relay** (native / CLI): the client POSTs `{ csrf, relayTo }` to
 *    `authorize-params/<id>`, gets an HMAC-signed `state` envelope
 *    (`state-envelope.ts`), sends the IdP to *this* backend's HTTPS
 *    `callback` (IdPs reject custom schemes), and the callback — finding no
 *    pending cookie — verifies the envelope and 302s the code to the
 *    allow-listed `relayTo` (e.g. `myapp://auth`). The app then POSTs it to
 *    `exchange`.
 *
 * The callback's wire error codes (`invalid_state`, `sdk_outdated`,
 * `invalid_relay`, `invalid_callback`) and every JSON body shape are the
 * `AuthOIDC` ones; the native SDKs match on them.
 *
 * @internal
 */

import crypto from 'node:crypto';
import type { ChildLogger } from '@aws-blocks/bb-logger';
import { ApiError, BLOCKS_AUTH_PREFIX, type BlocksContext, RawRoute, type Scope } from '@aws-blocks/core';
import { clearPendingAuth, hasPendingAuth, readPendingAuth } from './engines/pending-auth.js';
import type {
	CodeExchangeInput,
	FederatedIdentity,
	FederationEngine,
	PublicAuthorizeParams,
	ResolvedProvider,
} from './engines/types.js';
import { AuthErrors } from './errors.js';
import { safeRedirectPath } from './redirect-path.js';
import { validateRelay } from './relay.js';
import { decodeState, encodeState, relayStateKey, type StatePayload } from './state-envelope.js';
import type { AuthenticatedUser, AuthOptions, SignInUrlOptions } from './types.js';

const DEFAULT_CALLBACK_PATH = `${BLOCKS_AUTH_PREFIX}/callback`;
const DEFAULT_SIGN_OUT_PATH = `${BLOCKS_AUTH_PREFIX}/signout`;
const DEFAULT_POST_SIGN_IN_PATH = '/';
const DEFAULT_POST_SIGN_OUT_PATH = '/';
/** Minimum length of the SDK-generated relay `csrf` value. */
const CSRF_MIN_LENGTH = 32;

/**
 * What the routes need from the `Auth` instance. `AuthBase` builds it
 * (`federationRouteHost()`), so the routes never reach into its private state.
 *
 * @internal
 */
export interface FederationRouteHost {
	/** The `Auth` instance — the routes' parent scope. */
	readonly scope: Scope;
	readonly options: AuthOptions;
	readonly log: ChildLogger;
	/** Every configured provider and its engine, in declaration order. */
	readonly providers: readonly { provider: ResolvedProvider; engine: FederationEngine }[];
	sessionSecret(): Promise<string>;
	/** `auth.getSignInUrl()` — gate, lookup and error mapping included. */
	signInUrl(context: BlocksContext, providerId: string, options: SignInUrlOptions): Promise<string>;
	/** Complete a server-initiated callback: the engine verifies, `AuthBase` issues the session. */
	completeSignIn(context: BlocksContext, providerId: string): Promise<AuthenticatedUser>;
	/** Complete a client-driven exchange; also returns the identity, for the bearer-token response. */
	completeExchange(
		context: BlocksContext,
		providerId: string,
		input: CodeExchangeInput,
	): Promise<{ user: AuthenticatedUser; identity: FederatedIdentity }>;
	/** `auth.signOut()`; returns the provider's logout URL when it keeps its own session. */
	signOut(context: BlocksContext): Promise<string | undefined>;
	/** The block's error policy (`toAuthApiError`). */
	mapError(e: unknown): ApiError;
}

/** The paths the routes are mounted at, derived from `redirects`. */
export interface FederationRoutePaths {
	base: string;
	callback: string;
	signOut: string;
	exchange: string;
	refresh: string;
	/** `<exchange>/refresh` — the Swift and Dart SDKs' default refresh path. */
	refreshCompat: string;
	signIn(providerId: string): string;
	authorizeParams(providerId: string): string;
	/** `redirects.postSignInPath`, normalised by `safeRedirectPath` — the form emitted as `Location`. */
	postSignIn: string;
	/** `redirects.postSignOutPath`, normalised by `safeRedirectPath` — the form emitted as `Location`. */
	postSignOut: string;
}

/**
 * Derive (and validate) the route paths. Throws a plain configuration `Error`
 * at construction for a path outside `/aws-blocks/auth/` — a deployed
 * CloudFront app only proxies that subtree.
 */
export function federationRoutePaths(options: AuthOptions): FederationRoutePaths {
	const redirects = options.redirects ?? {};
	for (const [key, value] of [
		['callbackPath', redirects.callbackPath],
		['signOutPath', redirects.signOutPath],
	] as const) {
		if (value !== undefined && (typeof value !== 'string' || !value.startsWith(`${BLOCKS_AUTH_PREFIX}/`))) {
			throw new Error(
				`Auth: redirects.${key} must be a path under '${BLOCKS_AUTH_PREFIX}/' (e.g. '${BLOCKS_AUTH_PREFIX}/callback'), ` +
					`got ${JSON.stringify(value)}. Auth routes live under the reserved namespace so a deployed CloudFront app proxies them.`,
			);
		}
	}
	// The landing paths become `Location` headers (and the path of the IdP's
	// `post_logout_redirect_uri`): the shared same-origin check, and the
	// normalised form is what is emitted.
	const landing = (key: 'postSignInPath' | 'postSignOutPath', fallback: string): string => {
		const value: unknown = redirects[key];
		if (value === undefined) return fallback;
		const safe = safeRedirectPath(value);
		if (safe === null) {
			throw new Error(
				`Auth: redirects.${key} must be an absolute path starting with '/', got ${JSON.stringify(value)}. ` +
					'It must stay on the app origin: no scheme, no `//host`, no backslash and no control characters (TAB, CR, LF).',
			);
		}
		return safe;
	};
	const postSignIn = landing('postSignInPath', DEFAULT_POST_SIGN_IN_PATH);
	const postSignOut = landing('postSignOutPath', DEFAULT_POST_SIGN_OUT_PATH);
	const callback = redirects.callbackPath ?? DEFAULT_CALLBACK_PATH;
	const base = callback.slice(0, callback.lastIndexOf('/'));
	return {
		base,
		callback,
		signOut: redirects.signOutPath ?? DEFAULT_SIGN_OUT_PATH,
		exchange: `${base}/exchange`,
		refresh: `${base}/refresh`,
		refreshCompat: `${base}/exchange/refresh`,
		signIn: (id) => `${base}/signin/${encodeURIComponent(id)}`,
		authorizeParams: (id) => `${base}/authorize-params/${encodeURIComponent(id)}`,
		postSignIn,
		postSignOut,
	};
}

// ── Responses ───────────────────────────────────────────────────────────────

function sendJson(ctx: BlocksContext, status: number, body: unknown): void {
	ctx.response.status = status;
	ctx.response.headers.set('Content-Type', 'application/json');
	ctx.response.headers.set('Cache-Control', 'no-store');
	ctx.response.send(body);
}

function sendRedirect(ctx: BlocksContext, location: string, status = 302): void {
	ctx.response.status = status;
	ctx.response.headers.set('Location', location);
	ctx.response.headers.set('Cache-Control', 'no-store');
	ctx.response.send('');
}

/** `{ error, name }` with the error's status — `AuthOIDC`'s error body. */
function sendError(host: FederationRouteHost, ctx: BlocksContext, e: unknown): void {
	const err = host.mapError(e);
	sendJson(ctx, err.status, { error: err.message, name: err.name });
}

// ── The callback dispatcher ─────────────────────────────────────────────────

/** What the callback route does next. The `error` codes are on the wire for native SDKs. */
export type CallbackResult =
	| { kind: 'server-exchange' }
	| { kind: 'relay'; redirectTo: string }
	| { kind: 'relay-error'; redirectTo: string }
	| {
			kind: 'error';
			status: number;
			code: 'invalid_state' | 'sdk_outdated' | 'invalid_relay' | 'invalid_callback';
			message: string;
	  };

/** The error `name` each wire code is reported with. */
const CALLBACK_ERROR_NAMES = {
	invalid_state: AuthErrors.InvalidState,
	sdk_outdated: AuthErrors.SdkOutdated,
	invalid_relay: AuthErrors.InvalidRelay,
	invalid_callback: AuthErrors.InvalidCallback,
} as const;

function relayRedirect(relay: string, params: Record<string, string>): string {
	const url = new URL(relay);
	for (const [key, value] of Object.entries(params)) {
		if (value) url.searchParams.set(key, value);
	}
	return url.toString();
}

/**
 * Decide what a callback request is (`AuthOIDC`'s `handleCallbackDispatch`):
 * a `state` that is a relay envelope signed by this backend → relay,
 * re-validated against the current allowlist; otherwise a pending-auth cookie
 * → server-initiated; otherwise an error. (`AuthOIDC` checked the cookie
 * first, so a stale pending cookie — a web sign-in abandoned in the same
 * browser — broke a native relay; a server-initiated `state` is never an
 * envelope, so checking the envelope first is unambiguous.)
 *
 * @internal
 */
export async function dispatchCallback(host: FederationRouteHost, ctx: BlocksContext): Promise<CallbackResult> {
	const pending = hasPendingAuth(ctx, host.scope.fullId);
	const params = ctx.request.url.searchParams;
	const stateParam = params.get('state');
	if (!stateParam) {
		if (pending) return { kind: 'server-exchange' };
		return { kind: 'error', status: 400, code: 'invalid_state', message: 'missing state parameter' };
	}

	const decoded = decodeState(stateParam, relayStateKey(await host.sessionSecret()));
	if (!decoded.ok) {
		// A server-initiated `state` is a random token, never an envelope: with
		// the pending cookie present this is the server-initiated callback.
		if (pending) return { kind: 'server-exchange' };
		if (decoded.reason === 'version') {
			return {
				kind: 'error',
				status: 400,
				code: 'sdk_outdated',
				message: 'state envelope version not recognized — update your SDK',
			};
		}
		if (decoded.reason === 'malformed') {
			// Not a relay envelope and no pending cookie: most often a
			// server-initiated callback whose cookie did not arrive (it landed on
			// another origin than the sign-in started on).
			return {
				kind: 'error',
				status: 400,
				code: 'invalid_state',
				message:
					'state verification failed: not a relay envelope and no pending-auth cookie ' +
					'(server-initiated callback missing its cookie — likely a host/origin mismatch — ' +
					'or a malformed relay state)',
			};
		}
		return {
			kind: 'error',
			status: 400,
			code: 'invalid_state',
			message: 'state verification failed: signature mismatch',
		};
	}

	const payload = decoded.payload;
	// An envelope with nowhere to relay to: nothing for the relay path to do.
	if (!payload.relay) return { kind: 'server-exchange' };

	// Defense in depth: the allowlist may have changed since authorize-params.
	const validation = validateRelay(payload.relay, {
		allowList: host.options.redirects?.allowedRelayOrigins ?? [],
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

	// Forward an IdP error so the SDK does not wait for a code that never comes.
	// Only reached with a `state` this backend signed (verified above), as RFC
	// 6749 §4.1.2.1 has it on error responses; a server-initiated error is
	// checked against the pending state by the engine before it is honoured (R2-2).
	// FX60 deliberately leaves `error_description` verbatim here, unlike the two
	// engine callbacks: this is the OAuth error response itself being handed back
	// to the native / CLI app that started the sign-in (`relayTo`, signed into the
	// state envelope and re-validated above), not a message rendered to a browser —
	// the 302 answers with an empty body, so a browser only ever carries the
	// parameters on to that app. See L71.
	const idpError = params.get('error');
	if (idpError) {
		return {
			kind: 'relay-error',
			redirectTo: relayRedirect(payload.relay, {
				error: idpError,
				error_description: params.get('error_description') ?? '',
				state: stateParam,
			}),
		};
	}
	const code = params.get('code');
	if (!code) return { kind: 'error', status: 400, code: 'invalid_callback', message: 'missing code parameter' };
	const relayParams: Record<string, string> = { code, state: stateParam };
	const iss = params.get('iss');
	if (iss) relayParams.iss = iss;
	return { kind: 'relay', redirectTo: relayRedirect(payload.relay, relayParams) };
}

// ── Request parsing ─────────────────────────────────────────────────────────

async function jsonBody(ctx: BlocksContext): Promise<Record<string, unknown> | null> {
	let raw: unknown;
	try {
		raw = await ctx.request.json();
	} catch {
		return null;
	}
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
	return Object.fromEntries(Object.entries(raw));
}

function str(body: Record<string, unknown>, key: string): string | undefined {
	const v = body[key];
	return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/**
 * A browser navigation (an HTML form post) rather than an API client: the
 * `<Authenticator>`'s federated sign-out is a real form submit, which must
 * be redirected; the native SDKs POST JSON and expect `204`.
 */
function isFormNavigation(ctx: BlocksContext): boolean {
	const type = (ctx.request.headers.get('content-type') ?? '').toLowerCase();
	if (
		type.startsWith('application/x-www-form-urlencoded') ||
		type.startsWith('multipart/form-data') ||
		type.startsWith('text/plain')
	) {
		return true;
	}
	return ctx.request.headers.get('sec-fetch-mode') === 'navigate';
}

/**
 * Append `state=<appState>` to a same-origin landing path. `path` must already
 * be a {@link safeRedirectPath} result; the output is re-serialised the same way.
 */
function landingWithState(path: string, appState: string | undefined): string {
	if (appState === undefined) return path;
	const url = new URL(path, 'http://landing.invalid');
	url.searchParams.set('state', appState);
	return `${url.pathname}${url.search}${url.hash}`;
}

// ── Mounting ────────────────────────────────────────────────────────────────

/**
 * Mount the federation routes on the `Auth` instance. Called by each runtime
 * entry after `AuthBase` is constructed, only when a provider is configured.
 *
 * @internal
 */
export function mountFederationRoutes(host: FederationRouteHost): void {
	const paths = federationRoutePaths(host.options);
	const postSignIn = paths.postSignIn;
	const postSignOut = paths.postSignOut;
	const crossDomain = host.options.session?.crossDomain ?? false;
	const byId = new Map(host.providers.map((p) => [p.provider.id, p]));
	const scope = host.scope;

	// ── Sign-in kickoff (server-initiated) ─────────────────────────────────
	for (const { provider } of host.providers) {
		new RawRoute(scope, `auth-signin-${provider.id}`, {
			method: 'GET',
			path: paths.signIn(provider.id),
			handler: async (ctx) => {
				try {
					const redirectPath = ctx.request.url.searchParams.get('redirectPath') ?? undefined;
					const url = await host.signInUrl(ctx, provider.id, redirectPath ? { redirectPath } : {});
					sendRedirect(ctx, url);
				} catch (e) {
					sendError(host, ctx, e);
				}
			},
		});
	}

	// ── Callback (all providers, all transports) ───────────────────────────
	new RawRoute(scope, 'auth-callback', {
		method: 'GET',
		path: paths.callback,
		handler: async (ctx) => {
			let dispatch: CallbackResult;
			try {
				dispatch = await dispatchCallback(host, ctx);
			} catch (e) {
				sendError(host, ctx, e);
				return;
			}
			switch (dispatch.kind) {
				case 'relay':
				case 'relay-error':
					sendRedirect(ctx, dispatch.redirectTo);
					return;
				case 'error':
					sendJson(ctx, dispatch.status, {
						error: dispatch.code,
						message: dispatch.message,
						name: CALLBACK_ERROR_NAMES[dispatch.code],
					});
					return;
				case 'server-exchange':
					break;
			}
			try {
				const pending = readPendingAuth(ctx, scope.fullId, await host.sessionSecret());
				if (!pending || !byId.has(pending.provider)) {
					clearPendingAuth(ctx, scope.fullId, crossDomain);
					throw new ApiError(
						'Invalid sign-in callback: the pending sign-in cookie is missing or expired. Start the sign-in again.',
						400,
						{ name: AuthErrors.InvalidCallback },
					);
				}
				await host.completeSignIn(ctx, pending.provider);
				// Re-checked here, not only when the cookie was written: the cookie
				// may predate the current check. An unsafe one lands on postSignInPath.
				let landing = postSignIn;
				if (pending.redirectPath !== undefined) {
					const safe = safeRedirectPath(pending.redirectPath);
					if (safe === null) {
						host.log.warn(
							'[bb-auth] ignoring an unsafe redirectPath in the pending sign-in; landing on postSignInPath',
						);
					} else {
						landing = safe;
					}
				}
				sendRedirect(ctx, landingWithState(landing, pending.appState));
			} catch (e) {
				sendError(host, ctx, e);
			}
		},
	});

	// ── Sign-out ───────────────────────────────────────────────────────────
	new RawRoute(scope, 'auth-signout', {
		method: 'POST',
		path: paths.signOut,
		handler: async (ctx) => {
			let logoutUrl: string | undefined;
			try {
				logoutUrl = await host.signOut(ctx);
			} catch (e) {
				host.log.warn('[bb-auth] sign-out failed; the session cookie is cleared anyway', {
					error: e instanceof Error ? e.name : typeof e,
				});
			}
			clearPendingAuth(ctx, scope.fullId, crossDomain);
			if (isFormNavigation(ctx)) {
				// Follow the IdP's logout so its own session cannot silently sign
				// the user back in; otherwise to `postSignOutPath`.
				sendRedirect(ctx, logoutUrl ?? postSignOut, 303);
				return;
			}
			ctx.response.status = 204;
			if (logoutUrl) ctx.response.headers.set('Location', logoutUrl);
			ctx.response.send('');
		},
	});

	// ── Sign-out landing (GET) ─────────────────────────────────────────────
	// Cognito managed login's `/logout` redirects back to its `logout_uri` —
	// `<origin><signOutPath>`, the URL the CDK layer registers on the hosted-UI
	// client — with a GET. The session was already ended by the POST above, so
	// this only forwards the browser to `postSignOutPath`. It deliberately
	// changes no state: a GET that signed users out could be triggered by any
	// third-party page (logout CSRF).
	new RawRoute(scope, 'auth-signout-landing', {
		method: 'GET',
		path: paths.signOut,
		handler: async (ctx) => {
			sendRedirect(ctx, postSignOut);
		},
	});

	// ── Browser-PKCE / native exchange ─────────────────────────────────────
	new RawRoute(scope, 'auth-exchange', {
		method: 'POST',
		path: paths.exchange,
		handler: async (ctx) => {
			try {
				// JSON only: a cross-site HTML form cannot send it, so a third-party
				// page cannot sign the browser into the attacker's account (login CSRF).
				// Every SDK (and the old browser client) sends application/json.
				if (!(ctx.request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) {
					sendJson(ctx, 415, { error: 'Content-Type must be application/json' });
					return;
				}
				const body = await jsonBody(ctx);
				const code = body && str(body, 'code');
				const verifier = body && str(body, 'verifier');
				const state = body && str(body, 'state');
				const providerId = body && str(body, 'provider');
				const callbackUrl = body && str(body, 'callbackUrl');
				if (!body || !code || !verifier || !state || !providerId || !callbackUrl) {
					sendJson(ctx, 400, {
						error: 'Missing required fields: code, verifier, state, provider, callbackUrl',
					});
					return;
				}
				const iss = str(body, 'iss');
				const { user, identity } = await host.completeExchange(ctx, providerId, {
					code,
					codeVerifier: verifier,
					redirectUri: callbackUrl,
					nonce: str(body, 'nonce') ?? '',
					...(iss ? { iss } : {}),
				});
				const tokens =
					host.options.allowBearerAuth === true && identity.kind === 'direct' && identity.accessToken
						? {
								accessToken: identity.accessToken,
								...(identity.refreshToken ? { refreshToken: identity.refreshToken } : {}),
								expiresIn: Math.max(0, Math.round((identity.expiresAt - Date.now()) / 1000)),
							}
						: {};
				// `claims` is server-side only (AuthenticatedUser.claims): never on the wire.
				const { claims: _claims, ...wireUser } = user;
				sendJson(ctx, 200, { user: wireUser, ...tokens });
			} catch (e) {
				sendError(host, ctx, e);
			}
		},
	});

	// ── Authorize parameters (browser PKCE GET; native relay POST) ─────────
	for (const { provider, engine } of host.providers) {
		const params = async (ctx: BlocksContext): Promise<PublicAuthorizeParams> => {
			if (!engine.authorizeParams) {
				throw new ApiError(`Sign-in provider '${provider.id}' does not support client-driven sign-in.`, 501, {
					name: AuthErrors.ProviderMisconfigured,
				});
			}
			return engine.authorizeParams(ctx);
		};
		new RawRoute(scope, `auth-authorize-params-${provider.id}`, {
			method: 'GET',
			path: paths.authorizeParams(provider.id),
			handler: async (ctx) => {
				try {
					const p = await params(ctx);
					sendJson(ctx, 200, {
						authorizeUrl: p.authorizeUrl,
						clientId: p.clientId,
						scopes: p.scopes,
						kind: p.kind,
					});
				} catch (e) {
					sendError(host, ctx, e);
				}
			},
		});
		new RawRoute(scope, `auth-authorize-params-post-${provider.id}`, {
			method: 'POST',
			path: paths.authorizeParams(provider.id),
			handler: async (ctx) => {
				try {
					const body = await jsonBody(ctx);
					const csrf = body?.csrf;
					if (!body || typeof csrf !== 'string' || csrf.length < CSRF_MIN_LENGTH) {
						sendJson(ctx, 400, { error: `csrf is required and must be at least ${CSRF_MIN_LENGTH} chars` });
						return;
					}
					const relayTo = body.relayTo;
					if (relayTo !== undefined && (typeof relayTo !== 'string' || relayTo.length === 0)) {
						sendJson(ctx, 400, { error: 'relayTo must be a non-empty string when provided' });
						return;
					}
					const appState = body.appState;
					if (appState !== undefined && typeof appState !== 'string') {
						sendJson(ctx, 400, { error: 'appState must be a string when provided' });
						return;
					}
					if (relayTo !== undefined) {
						const allowList = host.options.redirects?.allowedRelayOrigins ?? [];
						const validation = validateRelay(relayTo, { allowList, sameOrigin: ctx.request.url });
						if (!validation.allowed) {
							sendJson(ctx, 400, {
								error: 'invalid_relay',
								reason: validation.reason,
								allowedOrigins: [...allowList],
							});
							return;
						}
					}
					const p = await params(ctx);
					const payload: StatePayload = {
						v: 1,
						csrf,
						...(relayTo !== undefined ? { relay: relayTo } : {}),
						...(appState !== undefined ? { app: appState } : {}),
					};
					const state = encodeState(payload, relayStateKey(await host.sessionSecret()));
					sendJson(ctx, 200, {
						authorizeUrl: p.authorizeUrl,
						clientId: p.clientId,
						scopes: p.scopes,
						kind: p.kind,
						state,
						...(p.usesNonce ? { nonce: crypto.randomBytes(32).toString('base64url') } : {}),
					});
				} catch (e) {
					sendError(host, ctx, e);
				}
			},
		});
	}

	// ── Bearer refresh (native clients; opt-in) ────────────────────────────
	if (host.options.allowBearerAuth === true) {
		const refresh = async (ctx: BlocksContext): Promise<void> => {
			try {
				const body = await jsonBody(ctx);
				const refreshToken = body && str(body, 'refreshToken');
				// `provider` may be omitted when only one provider is configured
				// (the Swift and Dart SDKs send only the refresh token).
				const providerId =
					(body && str(body, 'provider')) ??
					(host.providers.length === 1 ? host.providers[0].provider.id : undefined);
				if (!refreshToken || !providerId) {
					sendJson(ctx, 400, { error: 'Missing required fields: refreshToken, provider' });
					return;
				}
				const entry = byId.get(providerId);
				if (!entry) {
					throw new ApiError(`Sign-in provider '${providerId}' is not configured.`, 400, {
						name: AuthErrors.ProviderNotConfigured,
					});
				}
				if (!entry.engine.refreshBearer) {
					throw new ApiError(`Sign-in provider '${providerId}' does not support bearer refresh.`, 501, {
						name: AuthErrors.ProviderMisconfigured,
					});
				}
				const tokens = await entry.engine.refreshBearer(ctx, refreshToken);
				if (!tokens) {
					sendJson(ctx, 401, { error: 'Refresh failed', name: AuthErrors.TokenExpired });
					return;
				}
				sendJson(ctx, 200, tokens);
			} catch (e) {
				sendError(host, ctx, e);
			}
		};
		new RawRoute(scope, 'auth-refresh', { method: 'POST', path: paths.refresh, handler: refresh });
		new RawRoute(scope, 'auth-refresh-exchange', { method: 'POST', path: paths.refreshCompat, handler: refresh });
	}
}
