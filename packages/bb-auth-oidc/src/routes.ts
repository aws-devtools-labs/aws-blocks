// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared route-mounting logic for `AuthOIDC`. Both mock and AWS entry
 * points mount identical route handlers.
 */

import { RawRoute, type BlocksContext, ApiError, isWireSafeError } from '@aws-blocks/core';
import type { ChildLogger } from '@aws-blocks/bb-logger';
import type { AuthOIDC } from './auth-oidc.js';
import type { ProviderConfig, StubProvider } from './types.js';
import type { AuthorizeParamsRequest } from './engine.js';
import { InvalidRelayError, AuthOIDCErrors } from './errors.js';
import {
	handleDiscovery,
	handleJwks,
	handleAuthorize,
	handleAuthorizeSubmit,
	handleToken,
	handleUserInfo,
	handleRevoke,
	stubIssuerPath,
} from './engines/stub-idp.js';

/** Minimum acceptable length of the SDK-generated `csrf` value. */
const CSRF_MIN_LENGTH = 32;

/** Discriminated result of body validation for POST `/aws-blocks/auth/authorize-params/<provider>`. */
type BodyResult =
	| { ok: true; body: AuthorizeParamsRequest }
	| { ok: false; error: string };

/**
 * Validate the JSON body for POST `/aws-blocks/auth/authorize-params/<provider>`.
 * Schema: `csrf` (string, ≥32), `relayTo` (optional string), `appState` (optional string).
 */
function validateAuthorizeParamsBody(raw: unknown): BodyResult {
	if (!raw || typeof raw !== 'object') {
		return { ok: false, error: 'Body must be a JSON object' };
	}
	const obj = raw as Record<string, unknown>;

	if (typeof obj.csrf !== 'string' || obj.csrf.length < CSRF_MIN_LENGTH) {
		return { ok: false, error: `csrf is required and must be at least ${CSRF_MIN_LENGTH} chars` };
	}
	const out: AuthorizeParamsRequest = { csrf: obj.csrf };

	if (obj.relayTo !== undefined) {
		if (typeof obj.relayTo !== 'string' || obj.relayTo.length === 0) {
			return { ok: false, error: 'relayTo must be a non-empty string when provided' };
		}
		out.relayTo = obj.relayTo;
	}
	if (obj.appState !== undefined) {
		if (typeof obj.appState !== 'string') {
			return { ok: false, error: 'appState must be a string when provided' };
		}
		out.appState = obj.appState;
	}
	return { ok: true, body: out };
}

/**
 * Answer a route handler's caught error without leaking raw backend text.
 *
 * These routes catch their own errors, so core's RawRoute sanitizer never sees
 * them; this applies the same rule. An `ApiError` keeps its status, and an
 * `ApiError` or branded Building Block error (an expected auth failure such as
 * `InvalidStateException`, status 400) keeps its `name` and `message`. Anything
 * else — an `onSignIn` hook's driver error, an SSM/SDK failure — is logged and
 * answered with a nameless generic 500, so its message and class name never
 * reach the caller.
 *
 * A branded error that carries a `cause` (an IdP failure, a Cognito token-endpoint
 * response body) keeps that raw detail off the wire, so it is logged here instead.
 * The cause is passed as its own field: the logger drops non-enumerable properties,
 * so logging the error alone would lose it.
 */
function sendRouteError(ctx: BlocksContext, err: unknown, log: ChildLogger, route: string): void {
	ctx.response.headers.set('Content-Type', 'application/json');
	if (isWireSafeError(err)) {
		if (err.cause !== undefined) log.error('AuthOIDC route rejected request', { route, error: err, cause: err.cause });
		ctx.response.status = err instanceof ApiError ? err.status : 400;
		ctx.response.send({ error: err.message, name: err.name });
		return;
	}
	log.error('AuthOIDC route failed', { route, error: err });
	ctx.response.status = 500;
	ctx.response.send({ error: 'Internal error' });
}

/** Mount the core auth routes on the given `AuthOIDC` instance; `log` receives unexpected route errors. */
export function mountAuthRoutes(auth: AuthOIDC<readonly ProviderConfig[]>, log: ChildLogger): void {
	new RawRoute(auth, 'oidc-callback', {
		method: 'GET',
		path: auth.callbackPath,
		handler: async (ctx: BlocksContext) => {
			// Relay-aware callback dispatcher.
			// Branches on pending-auth cookie presence:
			// - Cookie present → server-initiated flow (exchange + 302 to postSignInPath)
			// - Cookie absent → relay flow (decode state envelope, 302 to relay target)
			try {
				const dispatch = await auth.handleCallbackDispatch(ctx);

				switch (dispatch.kind) {
					case 'relay': {
						// Happy path: 302 to relay target with code + state.
						ctx.response.status = 302;
						ctx.response.headers.set('Location', dispatch.redirectTo);
						ctx.response.send('');
						return;
					}
					case 'relay-error': {
						// IdP error forwarding: 302 to relay
						// with error params so the SDK doesn't time out.
						ctx.response.status = 302;
						ctx.response.headers.set('Location', dispatch.redirectTo);
						ctx.response.send('');
						return;
					}
					case 'error': {
						ctx.response.status = dispatch.status;
						ctx.response.headers.set('Content-Type', 'application/json');
						ctx.response.send({
							error: dispatch.code,
							message: dispatch.message,
							name: dispatch.code === 'invalid_state' ? AuthOIDCErrors.InvalidState
								: dispatch.code === 'sdk_outdated' ? AuthOIDCErrors.SdkOutdated
								: dispatch.code === 'invalid_relay' ? AuthOIDCErrors.InvalidRelay
								: AuthOIDCErrors.InvalidCallback,
						});
						return;
					}
					case 'server-exchange': {
						// Fall through to the server-initiated flow.
						break;
					}
				}
			} catch (err) {
				// Dispatch itself threw (unexpected).
				sendRouteError(ctx, err, log, 'callback');
				return;
			}

			// Server-initiated flow: exchange code, set session cookie, 302 to postSignInPath.
			try {
				await auth.handleCallback(ctx);
			} catch (err) {
				sendRouteError(ctx, err, log, 'callback');
				return;
			}
			ctx.response.status = 302;
			ctx.response.headers.set('Location', auth.postSignInPath);
			ctx.response.send('');
		},
	});
	new RawRoute(auth, 'oidc-signout', {
		method: 'POST',
		path: auth.signOutPath,
		handler: async (ctx: BlocksContext) => {
			await auth.signOut(ctx);
			ctx.response.status = 204;
			ctx.response.send('');
		},
	});

	// Per-provider sign-in kickoff: Authenticator's external action form
	// submits here; the handler 302s to the IdP's authorize URL.
	for (const provider of auth.providers) {
		new RawRoute(auth, `oidc-signin-${provider}`, {
			method: 'GET',
			path: auth.signInRoutePath(provider),
			handler: async (ctx: BlocksContext) => {
				try {
					const url = await auth.getSignInUrl(ctx, provider);
					ctx.response.status = 302;
					ctx.response.headers.set('Location', url);
					ctx.response.send('');
				} catch (err) {
					sendRouteError(ctx, err, log, 'signin');
				}
			},
		});
	}

	const basePath = auth.callbackPath.slice(0, auth.callbackPath.lastIndexOf('/'));

	new RawRoute(auth, 'oidc-exchange', {
		method: 'POST',
		path: `${basePath}/exchange`,
		handler: async (ctx: BlocksContext) => {
			try {
				// A malformed body reads as `null` and is answered by the missing-fields 400 below.
				const body = await ctx.request.json().catch(() => null) as {
					code?: string;
					verifier?: string;
					state?: string;
					nonce?: string;
					provider?: string;
					callbackUrl?: string;
				};
				if (!body?.code || !body?.verifier || !body?.state || !body?.provider || !body?.callbackUrl) {
					ctx.response.status = 400;
					ctx.response.headers.set('Content-Type', 'application/json');
					ctx.response.send({ error: 'Missing required fields: code, verifier, state, provider, callbackUrl' });
					return;
				}
				const result = await auth.handleExchange({
					code: body.code,
					verifier: body.verifier,
					state: body.state,
					nonce: body.nonce ?? '',
					provider: body.provider,
					callbackUrl: body.callbackUrl,
					iss: (body as any).iss,
				}, ctx);
				ctx.response.status = 200;
				ctx.response.headers.set('Content-Type', 'application/json');
				ctx.response.send(result);
			} catch (err) {
				sendRouteError(ctx, err, log, 'exchange');
			}
		},
	});

	const authorizeParamsBase = `${basePath}/authorize-params`;
	for (const provider of auth.providers) {
		// Browser GET path: returns the server-initiated authorize-params shape
		// (no state envelope, no nonce).
		new RawRoute(auth, `oidc-authorize-params-${provider}`, {
			method: 'GET',
			path: `${authorizeParamsBase}/${encodeURIComponent(provider)}`,
			handler: async (ctx: BlocksContext) => {
				try {
					const params = await auth.getAuthorizeParams(ctx, provider);
					ctx.response.status = 200;
					ctx.response.headers.set('Content-Type', 'application/json');
					ctx.response.send(params);
				} catch (err) {
					sendRouteError(ctx, err, log, 'authorize-params');
				}
			},
		});

		// Native/CLI POST path: takes `{ csrf, relayTo?, appState? }`,
		// validates `relayTo` against `allowedRelayOrigins`, signs the
		// state envelope. Returns the same `AuthorizeParams` shape with
		// `state` and `nonce` populated.
		new RawRoute(auth, `oidc-authorize-params-post-${provider}`, {
			method: 'POST',
			path: `${authorizeParamsBase}/${encodeURIComponent(provider)}`,
			handler: async (ctx: BlocksContext) => {
				try {
					const raw = await ctx.request.json().catch(() => null);
					const validated = validateAuthorizeParamsBody(raw);
					if (!validated.ok) {
						ctx.response.status = 400;
						ctx.response.headers.set('Content-Type', 'application/json');
						ctx.response.send({ error: validated.error });
						return;
					}
					const params = await auth.getAuthorizeParams(ctx, provider, validated.body);
					ctx.response.status = 200;
					ctx.response.headers.set('Content-Type', 'application/json');
					ctx.response.send(params);
				} catch (err) {
					if (err instanceof InvalidRelayError) {
						// Surface the structured rejection so customers
						// debugging integration get an actionable error.
						ctx.response.status = 400;
						ctx.response.headers.set('Content-Type', 'application/json');
						ctx.response.send({
							error: 'invalid_relay',
							reason: err.reason,
							allowedOrigins: err.allowedOrigins,
						});
						return;
					}
					sendRouteError(ctx, err, log, 'authorize-params');
				}
			},
		});
	}

	// Bearer-token refresh endpoint. Only mounted when `allowBearerAuth` is
	// enabled — native clients post their stored refresh token here and get
	// a new access token back. Web apps should use the session cookie and
	// the silent server-side refresh path instead.
	if (auth.allowBearerAuth) {
		new RawRoute(auth, 'oidc-refresh', {
			method: 'POST',
			path: `${basePath}/refresh`,
			handler: async (ctx: BlocksContext) => {
				try {
					// A malformed body reads as `null` and is answered by the missing-fields 400 below.
					const body = await ctx.request.json().catch(() => null) as {
						refreshToken?: string;
						provider?: string;
					};
					if (!body?.refreshToken || !body?.provider) {
						ctx.response.status = 400;
						ctx.response.headers.set('Content-Type', 'application/json');
						ctx.response.send({ error: 'Missing required fields: refreshToken, provider' });
						return;
					}
					const result = await auth.refreshBearerTokens({
						refreshToken: body.refreshToken,
						provider: body.provider,
					}, ctx);
					if (!result) {
						ctx.response.status = 401;
						ctx.response.headers.set('Content-Type', 'application/json');
						ctx.response.send({ error: 'Refresh failed', name: 'TokenExpiredException' });
						return;
					}
					ctx.response.status = 200;
					ctx.response.headers.set('Content-Type', 'application/json');
					ctx.response.send(result);
				} catch (err) {
					sendRouteError(ctx, err, log, 'refresh');
				}
			},
		});
	}
}

/** Mount stub IdP routes for a single provider. */
export function mountStubIdpRoutes(parent: AuthOIDC<readonly ProviderConfig[]>, provider: StubProvider, dataDir?: string): void {
	const base = stubIssuerPath(provider.name);
	const routeId = (suffix: string) => `stub-${provider.name}-${suffix}`;

	new RawRoute(parent, routeId('discovery'), {
		method: 'GET',
		path: `${base}/.well-known/openid-configuration`,
		handler: (ctx) => handleDiscovery(provider.name, ctx),
	});
	new RawRoute(parent, routeId('jwks'), {
		method: 'GET',
		path: `${base}/jwks.json`,
		handler: (ctx) => handleJwks(provider.name, ctx),
	});
	new RawRoute(parent, routeId('authorize'), {
		method: 'GET',
		path: `${base}/authorize`,
		handler: (ctx) => handleAuthorize(provider, ctx, dataDir),
	});
	new RawRoute(parent, routeId('authorize-submit'), {
		method: 'POST',
		path: `${base}/authorize`,
		handler: (ctx) => handleAuthorizeSubmit(provider, ctx, dataDir),
	});
	new RawRoute(parent, routeId('token'), {
		method: 'POST',
		path: `${base}/token`,
		handler: (ctx) => handleToken(provider.name, ctx),
	});
	new RawRoute(parent, routeId('userinfo'), {
		method: 'GET',
		path: `${base}/userinfo`,
		handler: (ctx) => handleUserInfo(provider.name, ctx),
	});
	new RawRoute(parent, routeId('revoke'), {
		method: 'POST',
		path: `${base}/revoke`,
		handler: (ctx) => handleRevoke(provider.name, ctx),
	});
}
