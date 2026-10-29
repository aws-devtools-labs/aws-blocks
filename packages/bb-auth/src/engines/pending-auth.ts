// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The pending federated-sign-in cookie — shared by every federation engine.
 *
 * A server-initiated sign-in (`GET /aws-blocks/auth/signin/<id>`) stores what
 * the callback needs in one short-lived (10 minute), HMAC-signed, `HttpOnly`
 * cookie: the PKCE verifier, the nonce, the `state` sent to the IdP, the exact
 * `redirect_uri`, and where to land afterwards. **Every engine writes it with
 * {@link writePendingAuth}**, because the callback route reads `provider` from
 * it to pick the engine that completes the sign-in — one callback URL serves
 * every provider. A hosted-UI engine (D6b) plugs in by doing the same.
 *
 * Its presence is also how the callback dispatcher tells a server-initiated
 * callback (cookie present) from a native relay (no cookie; the `state` is a
 * signed envelope instead) — the same rule `AuthOIDC` used.
 *
 * Signed with a key derived from the session secret, domain-separated from
 * the session cookie and the relay `state` envelope, so no signature made for
 * one can be replayed as another.
 *
 * @internal
 */

import { createHmac } from 'node:crypto';
import type { BlocksContext } from '@aws-blocks/core';
import { constantTimeEquals } from '@aws-blocks/core/bb-utils';
import { clearPendingAuthCookie, readPendingAuthCookie, setPendingAuthCookie } from '../cookies.js';

/** Pending sign-in lifetime: 10 minutes (`AuthOIDC`'s). */
export const PENDING_AUTH_TTL_SECONDS = 600;

/** What the callback needs to complete a server-initiated sign-in. */
export interface PendingAuth {
	/** The provider id (options-record key) that started the sign-in. */
	provider: string;
	/** The OAuth `state` sent to the IdP (CSRF binding). */
	state: string;
	/** The OIDC `nonce` sent to the IdP (absent for bare OAuth 2.0). */
	nonce?: string;
	/** PKCE verifier; its S256 challenge went to the IdP. */
	codeVerifier: string;
	/** The exact `redirect_uri` sent to the IdP (the token request must repeat it). */
	callbackUrl: string;
	/** Same-origin path to land on after sign-in. */
	redirectPath?: string;
	/** Opaque application state from `getSignInUrl(…, { state })`. */
	appState?: string;
	/** Expiry, seconds since the epoch. */
	exp: number;
}

const ENVELOPE_VERSION = 'v1';

function signingKey(secret: string): Buffer {
	return createHmac('sha256', secret).update('aws-blocks/bb-auth pending-auth v1').digest();
}

function sign(body: string, secret: string): string {
	return createHmac('sha256', signingKey(secret)).update(`${ENVELOPE_VERSION}.${body}`).digest('base64url');
}

/** Encode and sign a pending payload (`v1.<body>.<sig>`). */
export function encodePendingAuth(payload: PendingAuth, secret: string): string {
	const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
	return `${ENVELOPE_VERSION}.${body}.${sign(body, secret)}`;
}

function optionalString(raw: object, key: string): string | undefined {
	const v: unknown = Reflect.get(raw, key);
	return typeof v === 'string' ? v : undefined;
}

/** Verify and decode; `null` for a bad signature, a malformed body or an expired payload. */
export function decodePendingAuth(value: string, secret: string, nowSeconds = Date.now() / 1000): PendingAuth | null {
	const parts = value.split('.');
	if (parts.length !== 3 || parts[0] !== ENVELOPE_VERSION) return null;
	if (!constantTimeEquals(parts[2], sign(parts[1], secret))) return null;
	let raw: unknown;
	try {
		raw = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
	} catch {
		return null;
	}
	if (typeof raw !== 'object' || raw === null) return null;
	const provider = optionalString(raw, 'provider');
	const state = optionalString(raw, 'state');
	const codeVerifier = optionalString(raw, 'codeVerifier');
	const callbackUrl = optionalString(raw, 'callbackUrl');
	const exp: unknown = Reflect.get(raw, 'exp');
	if (!provider || !state || !codeVerifier || !callbackUrl || typeof exp !== 'number') return null;
	if (exp <= nowSeconds) return null;
	const nonce = optionalString(raw, 'nonce');
	const redirectPath = optionalString(raw, 'redirectPath');
	const appState = optionalString(raw, 'appState');
	return {
		provider,
		state,
		codeVerifier,
		callbackUrl,
		exp,
		...(nonce !== undefined ? { nonce } : {}),
		...(redirectPath !== undefined ? { redirectPath } : {}),
		...(appState !== undefined ? { appState } : {}),
	};
}

/** Set the pending cookie for a new server-initiated sign-in. */
export function writePendingAuth(
	ctx: BlocksContext,
	fullId: string,
	payload: Omit<PendingAuth, 'exp'>,
	secret: string,
	crossDomain: boolean,
): void {
	const full: PendingAuth = { ...payload, exp: Math.floor(Date.now() / 1000) + PENDING_AUTH_TTL_SECONDS };
	setPendingAuthCookie(ctx, fullId, encodePendingAuth(full, secret), PENDING_AUTH_TTL_SECONDS, crossDomain);
}

/**
 * Whether a callback's returned `state` is the pending sign-in's — the OAuth
 * CSRF binding (RFC 6749 §10.12). Compared in constant time
 * (`constantTimeEquals`), never with `===`, so response timing reveals nothing
 * about how much of a guess was right. A missing or empty value, or one of
 * another length or encoding, is `false`; this never throws. (Only the length
 * of a mismatch can show in the timing; every `state` this module issues has
 * the same, public, length.)
 *
 * Every engine's server-initiated callback checks `state` with this, before
 * it looks at anything else the IdP returned (R2-2).
 */
export function pendingStateMatches(returned: string | null | undefined, pending: PendingAuth): boolean {
	if (typeof returned !== 'string' || returned.length === 0 || pending.state.length === 0) return false;
	return constantTimeEquals(returned, pending.state);
}

/** The verified, unexpired pending sign-in on this request, or `null`. */
export function readPendingAuth(ctx: BlocksContext, fullId: string, secret: string): PendingAuth | null {
	const raw = readPendingAuthCookie(ctx, fullId);
	return raw ? decodePendingAuth(raw, secret) : null;
}

/** Whether the request carries a pending-sign-in cookie at all (valid or not). */
export function hasPendingAuth(ctx: BlocksContext, fullId: string): boolean {
	return readPendingAuthCookie(ctx, fullId) !== null;
}

/** Clear the pending cookie (single use). */
export function clearPendingAuth(ctx: BlocksContext, fullId: string, crossDomain: boolean): void {
	clearPendingAuthCookie(ctx, fullId, crossDomain);
}
