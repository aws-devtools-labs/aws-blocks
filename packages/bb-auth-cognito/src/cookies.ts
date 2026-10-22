// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import crypto from 'node:crypto';
import type { BlocksContext } from '@aws-blocks/core';
import { constantTimeEquals } from '@aws-blocks/core/bb-utils';
import { buildCookieSecurityAttrs, isLoopbackRequest } from '@aws-blocks/auth-common/cookies';

/**
 * Build the full cookie-attribute string (everything after `name=value`)
 * for a session cookie on this request. Security attributes come from the
 * shared {@link buildCookieSecurityAttrs} helper (D-007); `isLocalhost` is
 * detected per-request from the `Origin`/`Host` header.
 */
function cookieAttrsForRequest(ctx: BlocksContext, crossDomain: boolean): string {
	const security = buildCookieSecurityAttrs({
		crossDomain,
		isLocalhost: isLoopbackRequest(ctx),
	});
	return `HttpOnly; ${security}; Path=/`;
}

/**
 * Opaque session-cookie name derived from the BB's `fullId`. Module-local
 * because the cookie-naming rule belongs next to the cookie-handling code —
 * no other module constructs cookie names.
 */
function cookieName(fullId: string): string {
	return `auth_${fullId}`;
}

/**
 * Write one cookie's `Set-Cookie` line without disturbing the others on the
 * response. `Headers.set('Set-Cookie', …)` replaces EVERY `Set-Cookie` value,
 * so a plain `set` here would silently drop a cookie written earlier in the
 * same request — e.g. the auto-sign-in bridge clear that `autoSignIn` appends
 * just before the session cookie is issued. Only an earlier line for the same
 * cookie name is replaced (the newest write wins, as a browser would apply it).
 *
 * The new line is written with `set` and the survivors re-appended after it,
 * so callers that only observe `set` still see this cookie.
 */
function putSetCookie(ctx: BlocksContext, name: string, line: string): void {
	const headers = ctx.response.headers;
	const others = headers.getSetCookie().filter((l) => !l.startsWith(`${name}=`));
	headers.set('Set-Cookie', line);
	for (const l of others) headers.append('Set-Cookie', l);
}

/**
 * HMAC-sign an opaque session ID so tampering with the cookie is detectable.
 * Output format: `<sessionId>.<base64url(hmac)>`.
 *
 * @internal
 */
export function signSessionId(sessionId: string, secret: string): string {
	const sig = crypto.createHmac('sha256', secret).update(sessionId).digest('base64url');
	return `${sessionId}.${sig}`;
}

/**
 * Verify and unwrap a signed session ID. Returns the raw session ID on success,
 * or `null` if the signature is missing, malformed, or does not match.
 * Constant-time comparison.
 *
 * @internal
 */
export function verifySessionId(signed: string, secret: string): string | null {
	const idx = signed.lastIndexOf('.');
	if (idx < 0) return null;
	const sessionId = signed.slice(0, idx);
	const sig = signed.slice(idx + 1);
	const expected = crypto.createHmac('sha256', secret).update(sessionId).digest('base64url');
	if (!constantTimeEquals(sig, expected)) return null;
	return sessionId;
}

/**
 * Set the opaque session cookie on the outgoing response.
 * `HttpOnly; SameSite=Lax; Secure; Path=/` by default — see D-007. Pass
 * `crossDomain: true` for the `SameSite=None; Secure; Partitioned`
 * cross-domain recipe.
 *
 * Other cookies already set on the response (e.g. the auto-sign-in bridge
 * clear) are preserved.
 *
 * @internal
 */
export function setSessionCookie(
	ctx: BlocksContext,
	fullId: string,
	signedSessionId: string,
	maxAgeSeconds: number,
	crossDomain = false,
): void {
	putSetCookie(
		ctx,
		cookieName(fullId),
		`${cookieName(fullId)}=${signedSessionId}; ${cookieAttrsForRequest(ctx, crossDomain)}; Max-Age=${maxAgeSeconds}`,
	);
}

/**
 * Clear the session cookie (sets `Max-Age=0`). Other cookies already set on
 * the response are preserved.
 *
 * @internal
 */
export function clearSessionCookie(ctx: BlocksContext, fullId: string, crossDomain = false): void {
	putSetCookie(ctx, cookieName(fullId), `${cookieName(fullId)}=; ${cookieAttrsForRequest(ctx, crossDomain)}; Max-Age=0`);
}

/**
 * Regex metacharacter escape — keeps cookie names containing `.`, `+`, `*`
 * (etc.) from being interpreted as regex syntax when embedded in a
 * `RegExp()`. Without this, a `fullId` of `my.app` would match `my.app=`,
 * `myXapp=`, `myYapp=`, … because `.` matches any character.
 */
function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Read the raw signed-session-ID value from the request cookie header.
 * Caller should pass this through `verifySessionId` before trusting it.
 *
 * The match is anchored to the start of the header or a `; ` boundary, so
 * a sibling cookie whose name *ends* with this one's name (e.g.
 * `my_auth_foo` vs `auth_foo`) doesn't leak a value.
 *
 * @internal
 */
export function readSessionCookie(ctx: BlocksContext, fullId: string): string | null {
	const cookies = ctx.request.headers.get('cookie') ?? '';
	const name = escapeRegex(cookieName(fullId));
	const match = cookies.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
	return match?.[1] ?? null;
}

/**
 * Cookie name for the auto-sign-in bridge. Distinct from the main session
 * cookie so its lifecycle (created on opt-in `signUp`, cleared as soon as
 * `autoSignIn` consumes it) doesn't tangle with the long-lived session.
 */
function autoSignInCookieName(fullId: string): string {
	return `autosignin_${fullId}`;
}

/**
 * HKDF-derive a 32-byte key from `secret` for `info`. RFC 5869, SHA-256.
 * Replaces the prior SHA-256-of-(secret + tag) construction so the key
 * derivation is a real KDF (and so static analysers don't mistake key
 * derivation from a long-lived server secret for password hashing).
 *
 * No salt: `secret` is already a high-entropy server-side value
 * (provisioned via `AppSetting`'s `secret: true`), and the `info`
 * argument carries the per-key domain separation we need
 * (`'auth-cognito.autoSignIn.enc.v1'` vs `'…mac.v1'`).
 */
function deriveKey(secret: string, info: string): Buffer {
	return Buffer.from(crypto.hkdfSync('sha256', Buffer.from(secret, 'utf8'), Buffer.alloc(0), info, 32));
}

/**
 * Encrypt + sign an auto-sign-in payload. The payload contains the
 * username and (when the original sign-up included one) credentials the
 * BB needs to redeem the bridging session via `signIn`. Cookie format:
 * `<base64url(iv)>.<base64url(ciphertext)>.<base64url(authTag)>.
 * <base64url(hmac)>`.
 *
 * Encryption: AES-256-GCM keyed off HKDF-SHA256(secret, "…enc.v1"). The
 * Galois/Counter Mode tag covers integrity of the ciphertext.
 *
 * Signing: HMAC-SHA256 over `${iv}.${ciphertext}.${tag}` keyed off
 * HKDF-SHA256(secret, "…mac.v1"). Belt-and-suspenders against
 * ciphertext substitution even though GCM already authenticates.
 *
 * @internal
 */
export function encryptAutoSignInPayload(
	payload: { username: string; password?: string; cognitoSession?: string; exp: number },
	secret: string,
): string {
	const encKey = deriveKey(secret, 'auth-cognito.autoSignIn.enc.v1');
	const macKey = deriveKey(secret, 'auth-cognito.autoSignIn.mac.v1');
	const iv = crypto.randomBytes(12);
	const cipher = crypto.createCipheriv('aes-256-gcm', encKey, iv);
	const ciphertext = Buffer.concat([
		cipher.update(JSON.stringify(payload), 'utf8'),
		cipher.final(),
	]);
	const tag = cipher.getAuthTag();
	const ivB64 = iv.toString('base64url');
	const ctB64 = ciphertext.toString('base64url');
	const tagB64 = tag.toString('base64url');
	const hmac = crypto.createHmac('sha256', macKey).update(`${ivB64}.${ctB64}.${tagB64}`).digest('base64url');
	return `${ivB64}.${ctB64}.${tagB64}.${hmac}`;
}

/**
 * Reverse of {@link encryptAutoSignInPayload}. Returns the decoded payload
 * on success or `null` if the cookie is malformed, the HMAC fails
 * constant-time comparison, the GCM tag fails verification, or the
 * payload is past its `exp`.
 *
 * @internal
 */
export function decryptAutoSignInPayload(
	cookie: string,
	secret: string,
): { username: string; password?: string; cognitoSession?: string; exp: number } | null {
	const parts = cookie.split('.');
	if (parts.length !== 4) return null;
	const [ivB64, ctB64, tagB64, hmacB64] = parts;
	const macKey = deriveKey(secret, 'auth-cognito.autoSignIn.mac.v1');
	const expected = crypto.createHmac('sha256', macKey).update(`${ivB64}.${ctB64}.${tagB64}`).digest('base64url');
	if (expected.length !== hmacB64!.length) return null;
	if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(hmacB64!))) return null;
	try {
		const encKey = deriveKey(secret, 'auth-cognito.autoSignIn.enc.v1');
		const decipher = crypto.createDecipheriv('aes-256-gcm', encKey, Buffer.from(ivB64!, 'base64url'));
		decipher.setAuthTag(Buffer.from(tagB64!, 'base64url'));
		const plaintext = Buffer.concat([
			decipher.update(Buffer.from(ctB64!, 'base64url')),
			decipher.final(),
		]).toString('utf8');
		const parsed = JSON.parse(plaintext) as { username: string; password?: string; cognitoSession?: string; exp: number };
		if (typeof parsed.username !== 'string' || typeof parsed.exp !== 'number') return null;
		if (Date.now() > parsed.exp) return null;
		return parsed;
	} catch {
		return null;
	}
}

/**
 * Set the auto-sign-in bridging cookie. Cleared automatically by the
 * runtime as soon as `autoSignIn` consumes it.
 *
 * @internal
 */
export function setAutoSignInCookie(
	ctx: BlocksContext,
	fullId: string,
	encrypted: string,
	maxAgeSeconds: number,
	crossDomain = false,
): void {
	ctx.response.headers.append(
		'Set-Cookie',
		`${autoSignInCookieName(fullId)}=${encrypted}; ${cookieAttrsForRequest(ctx, crossDomain)}; Max-Age=${maxAgeSeconds}`,
	);
}

/**
 * Read the encrypted auto-sign-in cookie value. Caller decrypts via
 * {@link decryptAutoSignInPayload}.
 *
 * @internal
 */
export function readAutoSignInCookie(ctx: BlocksContext, fullId: string): string | null {
	const cookies = ctx.request.headers.get('cookie') ?? '';
	const name = escapeRegex(autoSignInCookieName(fullId));
	const match = cookies.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
	return match?.[1] ?? null;
}

/**
 * Clear the auto-sign-in cookie on the outgoing response.
 *
 * @internal
 */
export function clearAutoSignInCookie(ctx: BlocksContext, fullId: string, crossDomain = false): void {
	ctx.response.headers.append(
		'Set-Cookie',
		`${autoSignInCookieName(fullId)}=; ${cookieAttrsForRequest(ctx, crossDomain)}; Max-Age=0`,
	);
}
