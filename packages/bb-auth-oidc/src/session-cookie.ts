// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Signed cookie helpers for AuthOIDC.
 *
 * Two cookie flavors share the same HMAC-signed envelope:
 *
 * 1. **Session cookie.** Long-lived (session duration). Carries an opaque
 *    session id that keys into the internal `KVStore` session store.
 * 2. **Pending-auth cookie.** Short-lived (10 min). Carries the PKCE
 *    code verifier, nonce, CSRF `state` value, callback path, and the
 *    caller's application-level state. Used by the engine to bind the
 *    callback to the original sign-in request.
 *
 * Both cookies are HMAC-signed with a secret the CDK path provisions via
 * `bb-app-setting`.
 */

import { createHmac } from 'node:crypto';
import { constantTimeEquals } from '@aws-blocks/core/bb-utils';

/**
 * `v1.<payload-b64url>.<sig-b64url>`
 *
 * The version prefix lets us rotate the envelope shape without invalidating
 * every deployed cookie.
 */
const ENVELOPE_VERSION = 'v1';

/** Default pending-auth cookie TTL: 10 minutes. */
export const PENDING_AUTH_TTL_SECONDS = 600;

/**
 * Payload stored in the pending-auth cookie. Everything the callback
 * handler needs to verify + complete the sign-in.
 */
export interface PendingAuthPayload {
	/** Which configured provider the user is signing in with. */
	provider: string;
	/** OIDC `state` param — CSRF binding value sent to the IdP. */
	state: string;
	/** OIDC `nonce` claim expected in the returned ID token. */
	nonce: string;
	/** PKCE code verifier; SHA-256 derived from this was sent as `code_challenge`. */
	codeVerifier: string;
	/** Callback URL registered with the IdP. */
	callbackUrl: string;
	/** Application-level state round-tripped for the caller. */
	appState?: string;
	/** Unix timestamp (seconds) at which this cookie expires. */
	exp: number;
}

/**
 * Payload stored in the session cookie.
 *
 * Always `mode: 'stateful'` — `sessionId` keys into the internal session
 * store. The `stateless` variant was removed when the BB moved to
 * always-provision session storage.
 *
 * `provider` is the configured provider name (e.g. `'google'`), so
 * `verifySession` can surface it on the `OIDCUser` without looking it up
 * by `iss`. That lookup is ambiguous in the mock runtime where the stub
 * IdP's `iss` depends on the dev server's host + port, and in production
 * for IdPs that share an issuer across provider configurations.
 */
export type SessionCookiePayload =
	| { mode: 'stateful'; provider: string; sessionId: string; exp: number };

/**
 * Sign and encode a payload into cookie-value form.
 *
 * @param payload - Arbitrary JSON-serializable payload.
 * @param secret - HMAC signing key (32+ random bytes recommended).
 */
export function encodeSignedCookie<T>(payload: T, secret: string): string {
	const body = base64UrlEncode(Buffer.from(JSON.stringify(payload), 'utf8'));
	const sig = hmacSign(`${ENVELOPE_VERSION}.${body}`, secret);
	return `${ENVELOPE_VERSION}.${body}.${sig}`;
}

/**
 * Verify and decode a signed cookie value.
 *
 * @returns The parsed payload, or `null` if the signature is invalid, the
 *   envelope is malformed, or the version prefix is unknown. Does **not**
 *   enforce `exp` — callers that care must check the field themselves.
 */
export function decodeSignedCookie<T>(value: string, secret: string): T | null {
	const parts = value.split('.');
	if (parts.length !== 3) return null;
	const [version, body, sig] = parts;
	if (version !== ENVELOPE_VERSION) return null;
	const expected = hmacSign(`${version}.${body}`, secret);
	if (!constantTimeEquals(sig, expected)) return null;
	try {
		const json = base64UrlDecode(body).toString('utf8');
		return JSON.parse(json) as T;
	} catch {
		return null;
	}
}

/**
 * Check whether a `PendingAuthPayload` has expired. Separated from
 * `decodeSignedCookie` so tests can decode without fighting the clock.
 */
export function isExpired(payload: { exp: number }, nowSeconds: number = Math.floor(Date.now() / 1000)): boolean {
	return payload.exp <= nowSeconds;
}

/**
 * Cookie attribute defaults. Production sets `Secure` + `Partitioned`; the
 * mock runtime over HTTP omits `Secure` so the browser accepts the cookie.
 * The runtime-specific entry points pick the right mode.
 */
export interface CookieAttributes {
	name: string;
	path?: string;
	maxAge?: number;
	sameSite?: 'Strict' | 'Lax' | 'None';
	secure?: boolean;
	partitioned?: boolean;
	httpOnly?: boolean;
}

/** Build a `Set-Cookie` header value with the given attributes. */
export function buildSetCookie(value: string, attrs: CookieAttributes): string {
	const parts: string[] = [`${attrs.name}=${value}`];
	if (attrs.path) parts.push(`Path=${attrs.path}`);
	else parts.push('Path=/');
	if (attrs.maxAge !== undefined) parts.push(`Max-Age=${attrs.maxAge}`);
	if (attrs.sameSite) parts.push(`SameSite=${attrs.sameSite}`);
	if (attrs.httpOnly !== false) parts.push('HttpOnly');
	if (attrs.secure) parts.push('Secure');
	if (attrs.partitioned) parts.push('Partitioned');
	return parts.join('; ');
}

/** Build a `Set-Cookie` header value that clears a cookie. */
export function buildClearCookie(name: string, attrs: Omit<CookieAttributes, 'name' | 'maxAge'> = {}): string {
	return buildSetCookie('', { ...attrs, name, maxAge: 0 });
}

/**
 * Parse the first matching cookie value out of a `Cookie` header.
 *
 * Returns `null` if the header is absent or the cookie isn't present. Does
 * not verify the signature — pass the result through `decodeSignedCookie`.
 */
export function readCookie(cookieHeader: string | null | undefined, name: string): string | null {
	if (!cookieHeader) return null;
	const pairs = cookieHeader.split(';');
	for (const pair of pairs) {
		const idx = pair.indexOf('=');
		if (idx < 0) continue;
		const k = pair.slice(0, idx).trim();
		if (k === name) return pair.slice(idx + 1).trim();
	}
	return null;
}

function hmacSign(body: string, secret: string): string {
	return base64UrlEncode(createHmac('sha256', secret).update(body).digest());
}

function base64UrlEncode(buf: Buffer): string {
	return buf.toString('base64url');
}

function base64UrlDecode(value: string): Buffer {
	return Buffer.from(value, 'base64url');
}
