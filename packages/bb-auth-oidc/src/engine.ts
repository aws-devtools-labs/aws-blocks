// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Internal `AuthEngine` interface that `AuthOIDC` delegates to.
 * Engines handle token exchange, session verification, and sign-out.
 * Lifecycle hooks (`onSignIn`, `onSignOut`) are the `AuthOIDC` class's job.
 */

import type { BlocksContext } from '@aws-blocks/core';
import type { OIDCUser, SignInUrlOptions } from './types.js';

/**
 * Input for the `/aws-blocks/auth/exchange` endpoint. The client sends these values
 * after completing the IdP authorize flow with client-generated PKCE.
 */
export interface ExchangeInput {
	code: string;
	verifier: string;
	state: string;
	nonce: string;
	provider: string;
	callbackUrl: string;
	iss?: string;
}

/**
 * Public authorize parameters returned to the client for building the
 * IdP authorize URL locally. Does NOT include the client secret.
 */
export interface AuthorizeParams {
	authorizeUrl: string;
	clientId: string;
	scopes: readonly string[];
	/** Helps the client know if nonce is relevant (OIDC vs OAuth2). */
	kind: string;
	/** Signed state envelope. Present only on relay requests. */
	state?: string;
	/** OIDC nonce value. Present only on relay requests for OIDC providers. */
	nonce?: string;
}

/**
 * Optional fields the SDK may POST to `/aws-blocks/auth/authorize-params/<provider>`
 * for relay flows.
 */
export interface AuthorizeParamsRequest {
	/** SDK-generated CSRF binding value (≥32 characters). */
	csrf: string;
	/** Absolute URI the SDK wants the callback to 302 to. Validated against `allowedRelayOrigins`. */
	relayTo?: string;
	/** Customer-supplied app state, round-tripped through the IdP. */
	appState?: string;
}

/**
 * Result of a code exchange. Includes tokens when `allowBearerAuth` is enabled.
 */
export interface ExchangeResult {
	user: OIDCUser;
	/** Only present when `allowBearerAuth` is true. */
	accessToken?: string;
	/** Only present when `allowBearerAuth` is true. */
	refreshToken?: string;
	/** Access token lifetime in seconds. Only present when `allowBearerAuth` is true. */
	expiresIn?: number;
}

/** Result of a bearer-token refresh via `/aws-blocks/auth/refresh`. */
export interface BearerRefreshResult {
	accessToken: string;
	/** Rotated refresh token from the IdP, or the original if the IdP didn't rotate. */
	refreshToken: string;
	/** Access token lifetime in seconds. */
	expiresIn: number;
}

export interface BuildSignInUrlInput {
	provider: string;
	opts?: SignInUrlOptions;
	callbackUrl: string;
	/**
	 * The engine uses this to resolve the issuer URL and to read/write cookies.
	 */
	ctx: BlocksContext;
}

export interface BuildSignInUrlOutput {
	url: string;
	/**
	 * `Set-Cookie` header value carrying PKCE verifier, nonce, state, and
	 * the caller's application-level state. Signed, 10-minute TTL.
	 */
	pendingCookie: string;
}

/** Minimal interface implemented by every engine. */
export interface AuthEngine {
	buildSignInUrl(input: BuildSignInUrlInput): Promise<BuildSignInUrlOutput>;

	/**
	 * Exchange the code, verify the ID token, issue the session cookie.
	 * Throws `InvalidState` / `InvalidCallback` / `IdpError`.
	 */
	handleCallback(ctx: BlocksContext): Promise<OIDCUser>;

	/**
	 * Client-initiated PKCE exchange. Same outcome as `handleCallback`
	 * but the client owns the authorize URL construction and PKCE.
	 */
	handleExchange(input: ExchangeInput, ctx: BlocksContext): Promise<ExchangeResult>;

	/** Return public authorize parameters (endpoint, clientId, scopes). */
	getAuthorizeParams(
		provider: string,
		ctx: BlocksContext,
		request?: AuthorizeParamsRequest,
	): Promise<AuthorizeParams>;

	/** Verify the session cookie and refresh if the access token expired. */
	verifySession(ctx: BlocksContext): Promise<OIDCUser | null>;

	/** Verify a Bearer access token. Only called when `allowBearerAuth` is enabled. */
	verifyAccessToken(token: string, ctx: BlocksContext): Promise<OIDCUser | null>;

	/** Refresh the current session using the CAS-based protocol. */
	refreshSession(ctx: BlocksContext): Promise<OIDCUser | null>;

	/** Refresh bearer tokens from a raw refresh token. Returns `null` if rejected. */
	refreshBearerTokens(
		input: { refreshToken: string; provider: string },
		ctx: BlocksContext,
	): Promise<BearerRefreshResult | null>;

	/**
	 * Clear session cookie, evict the row, and best-effort revoke upstream.
	 * Throws `SignOutIncompleteException` (503) when the row could not be evicted.
	 */
	signOut(ctx: BlocksContext): Promise<void>;

	/** Resolve the cookie-signing secret. Used by the relay callback dispatcher. */
	resolveCookieSecret(): Promise<string>;

	/** Check whether a pending-auth cookie is present on the request. */
	hasPendingAuthCookie(ctx: BlocksContext): boolean;
}
