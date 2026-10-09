// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Session and auto-sign-in cookies.
 *
 * **Byte-compatible with `AuthCognito`** (ported from
 * `bb-auth-cognito/src/cookies.ts` as fixed by B6), because an app that
 * switches `AuthCognito` → `Auth` with the same id must keep its users signed
 * in:
 *
 * - the session cookie is named `auth_<fullId>`;
 * - its value is `<sessionId>.<base64url(HMAC-SHA256(sessionId, secret))>`,
 *   signed with the `session-secret` the block already has;
 * - its attributes are `HttpOnly; <SameSite/Secure/Partitioned per D-007>;
 *   Path=/; Max-Age=<session ttl>`;
 * - the auto-sign-in bridge cookie is `autosignin_<fullId>`, AES-256-GCM +
 *   HMAC under HKDF-derived keys with the same `info` strings.
 *
 * Reading is anchored and regex-escaped (never `bb-auth-basic`'s unanchored
 * reader, under which `my_auth_foo=` satisfies a lookup for `auth_foo`), and
 * signatures are compared in constant time.
 *
 * Internal — not exported from any package entry.
 *
 * @internal
 */

import crypto from 'node:crypto';
import { buildCookieSecurityAttrs, isLoopbackRequest } from '@aws-blocks/auth-common/cookies';
import type { BlocksContext } from '@aws-blocks/core';
import { constantTimeEquals } from '@aws-blocks/core/bb-utils';
import { sessionCookieName } from './cdk/contract.js';

/**
 * Build the full cookie-attribute string (everything after `name=value`) for a
 * session cookie on this request. Security attributes come from the shared
 * {@link buildCookieSecurityAttrs} helper (D-007); `isLocalhost` is detected
 * per request from the `Origin` / `Host` header.
 */
function cookieAttrsForRequest(ctx: BlocksContext, crossDomain: boolean): string {
	const security = buildCookieSecurityAttrs({
		crossDomain,
		isLocalhost: isLoopbackRequest(ctx),
	});
	return `HttpOnly; ${security}; Path=/`;
}

/**
 * The session-cookie name, `auth_<fullId>`, from the CDK↔runtime contract
 * (`cdk/contract.ts`, pinned by the resource-identity test). One prefix in every
 * runtime (mock and AWS), so a session survives a mock↔AWS switch — and the
 * same name `AuthCognito` uses, so its sessions survive the upgrade.
 */
export { sessionCookieName };

/** Cookie name for the auto-sign-in bridge (distinct lifecycle from the session). */
function autoSignInCookieName(fullId: string): string {
	return `autosignin_${fullId}`;
}

/**
 * Write one cookie's `Set-Cookie` line without disturbing the others on the
 * response. `Headers.set('Set-Cookie', …)` replaces EVERY `Set-Cookie` value,
 * so a plain `set` would silently drop a cookie written earlier in the same
 * request — e.g. the auto-sign-in bridge clear that `autoSignIn` appends just
 * before the session cookie is issued (B6). Only an earlier line for the same
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
 * Regex metacharacter escape — keeps cookie names containing `.`, `+`, `*`
 * (etc.) from being interpreted as regex syntax when embedded in a `RegExp()`.
 * Without this, a `fullId` of `my.app` would match `my.app=`, `myXapp=`, …
 */
function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Read one cookie's raw value from the request `Cookie` header. The match is
 * anchored to the start of the header or a `;` boundary, so a sibling cookie
 * whose name *ends* with this one's (`my_auth_foo` vs `auth_foo`) never leaks
 * its value.
 */
function readCookie(ctx: BlocksContext, name: string): string | null {
	const cookies = ctx.request.headers.get('cookie') ?? '';
	const match = cookies.match(new RegExp(`(?:^|;\\s*)${escapeRegex(name)}=([^;]*)`));
	const value = match?.[1]?.trim();
	return value ? value : null;
}

/**
 * HMAC-sign an opaque session id so tampering with the cookie is detectable.
 * Output format: `<sessionId>.<base64url(hmac)>` — `AuthCognito`'s format.
 *
 * @internal
 */
export function signSessionId(sessionId: string, secret: string): string {
	const sig = crypto.createHmac('sha256', secret).update(sessionId).digest('base64url');
	return `${sessionId}.${sig}`;
}

/**
 * Verify and unwrap a signed session id. Returns the raw session id, or `null`
 * if the signature is missing, malformed, or does not match (constant time).
 *
 * Anything that is not a value this block signed — an `AuthBasic` HS256 JWT
 * under the same cookie name, a cookie signed with another secret, a truncated
 * or hand-edited value — fails here and is treated as signed-out.
 *
 * @internal
 */
export function verifySessionId(signed: string, secret: string): string | null {
	const idx = signed.lastIndexOf('.');
	if (idx <= 0) return null;
	const sessionId = signed.slice(0, idx);
	const sig = signed.slice(idx + 1);
	const expected = crypto.createHmac('sha256', secret).update(sessionId).digest('base64url');
	if (!constantTimeEquals(sig, expected)) return null;
	return sessionId;
}

/**
 * Set the opaque session cookie on the outgoing response.
 * `HttpOnly; SameSite=Lax; Secure; Path=/` by default — see D-007. Pass
 * `crossDomain: true` for the `SameSite=None; Secure; Partitioned` recipe.
 * Other cookies already set on the response are preserved.
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
	const name = sessionCookieName(fullId);
	putSetCookie(
		ctx,
		name,
		`${name}=${signedSessionId}; ${cookieAttrsForRequest(ctx, crossDomain)}; Max-Age=${maxAgeSeconds}`,
	);
}

/**
 * Clear the session cookie (`Max-Age=0`). A *clearing* cookie, so core forwards
 * it on error responses too (A1c) — a `requireAuth` 401 can drop a dead
 * session. Other cookies already set on the response are preserved.
 *
 * @internal
 */
export function clearSessionCookie(ctx: BlocksContext, fullId: string, crossDomain = false): void {
	const name = sessionCookieName(fullId);
	putSetCookie(ctx, name, `${name}=; ${cookieAttrsForRequest(ctx, crossDomain)}; Max-Age=0`);
}

/**
 * Read the raw signed-session value from the request. Pass it through
 * {@link verifySessionId} before trusting it.
 *
 * @internal
 */
export function readSessionCookie(ctx: BlocksContext, fullId: string): string | null {
	return readCookie(ctx, sessionCookieName(fullId));
}

/**
 * HKDF-derive a 32-byte key from `secret` for `info` (RFC 5869, SHA-256, no
 * salt — `secret` is already a high-entropy server-side value and `info`
 * carries the per-key domain separation).
 *
 * Shared by every key bb-auth derives from the session secret this way (the
 * auto-sign-in bridge here, the PreSignUp marker in `presignup-trigger.ts`):
 * each passes its own `info` label.
 *
 * @internal
 */
export function deriveKey(secret: string, info: string): Buffer {
	return Buffer.from(crypto.hkdfSync('sha256', Buffer.from(secret, 'utf8'), Buffer.alloc(0), info, 32));
}

// The `info` strings are `AuthCognito`'s, so a bridge cookie issued just before
// the upgrade can still be redeemed just after it.
const AUTO_SIGN_IN_ENC_INFO = 'auth-cognito.autoSignIn.enc.v1';
const AUTO_SIGN_IN_MAC_INFO = 'auth-cognito.autoSignIn.mac.v1';

/**
 * What the auto-sign-in bridge carries between `signUp`, `confirmSignUp` and
 * `autoSignIn`. `bridgeSession` is the engine's opaque continuation (Cognito's
 * `Session` from `SignUp` / `ConfirmSignUp`); it is stored under the
 * `cognitoSession` key for compatibility with `AuthCognito`'s bridge cookies.
 *
 * @internal
 */
export interface AutoSignInPayload {
	username: string;
	password?: string;
	cognitoSession?: string;
	/** Absolute expiry, ms since the epoch. */
	exp: number;
}

/**
 * Encrypt + sign an auto-sign-in payload. Format:
 * `<b64u(iv)>.<b64u(ciphertext)>.<b64u(gcmTag)>.<b64u(hmac)>` — AES-256-GCM
 * under HKDF(secret, enc info), plus HMAC-SHA256 under HKDF(secret, mac info).
 *
 * @internal
 */
export function encryptAutoSignInPayload(payload: AutoSignInPayload, secret: string): string {
	const encKey = deriveKey(secret, AUTO_SIGN_IN_ENC_INFO);
	const macKey = deriveKey(secret, AUTO_SIGN_IN_MAC_INFO);
	const iv = crypto.randomBytes(12);
	const cipher = crypto.createCipheriv('aes-256-gcm', encKey, iv);
	const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
	const tag = cipher.getAuthTag();
	const ivB64 = iv.toString('base64url');
	const ctB64 = ciphertext.toString('base64url');
	const tagB64 = tag.toString('base64url');
	const hmac = crypto.createHmac('sha256', macKey).update(`${ivB64}.${ctB64}.${tagB64}`).digest('base64url');
	return `${ivB64}.${ctB64}.${tagB64}.${hmac}`;
}

/**
 * Reverse of {@link encryptAutoSignInPayload}. `null` if the cookie is
 * malformed, either MAC fails, or the payload is past its `exp`.
 *
 * @internal
 */
export function decryptAutoSignInPayload(cookie: string, secret: string): AutoSignInPayload | null {
	const parts = cookie.split('.');
	if (parts.length !== 4) return null;
	const [ivB64, ctB64, tagB64, hmacB64] = parts;
	const macKey = deriveKey(secret, AUTO_SIGN_IN_MAC_INFO);
	const expected = crypto.createHmac('sha256', macKey).update(`${ivB64}.${ctB64}.${tagB64}`).digest('base64url');
	if (!constantTimeEquals(hmacB64, expected)) return null;
	try {
		const encKey = deriveKey(secret, AUTO_SIGN_IN_ENC_INFO);
		const decipher = crypto.createDecipheriv('aes-256-gcm', encKey, Buffer.from(ivB64, 'base64url'));
		decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
		const plaintext = Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64url')), decipher.final()]).toString(
			'utf8',
		);
		const parsed: unknown = JSON.parse(plaintext);
		if (typeof parsed !== 'object' || parsed === null) return null;
		const username: unknown = Reflect.get(parsed, 'username');
		const exp: unknown = Reflect.get(parsed, 'exp');
		const password: unknown = Reflect.get(parsed, 'password');
		const cognitoSession: unknown = Reflect.get(parsed, 'cognitoSession');
		if (typeof username !== 'string' || typeof exp !== 'number') return null;
		if (Date.now() > exp) return null;
		return {
			username,
			exp,
			...(typeof password === 'string' ? { password } : {}),
			...(typeof cognitoSession === 'string' ? { cognitoSession } : {}),
		};
	} catch {
		return null;
	}
}

/**
 * Set the auto-sign-in bridge cookie. Replaces any earlier bridge line on this
 * response; other cookies are preserved.
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
	const name = autoSignInCookieName(fullId);
	putSetCookie(
		ctx,
		name,
		`${name}=${encrypted}; ${cookieAttrsForRequest(ctx, crossDomain)}; Max-Age=${maxAgeSeconds}`,
	);
}

/**
 * Read the encrypted auto-sign-in cookie value. Decrypt with
 * {@link decryptAutoSignInPayload}.
 *
 * @internal
 */
export function readAutoSignInCookie(ctx: BlocksContext, fullId: string): string | null {
	return readCookie(ctx, autoSignInCookieName(fullId));
}

/**
 * Clear the auto-sign-in cookie (`Max-Age=0`). It carries an encrypted
 * password, so it is cleared as soon as it is consumed — and survives the
 * session cookie being written after it on the same response (B6).
 *
 * @internal
 */
export function clearAutoSignInCookie(ctx: BlocksContext, fullId: string, crossDomain = false): void {
	const name = autoSignInCookieName(fullId);
	putSetCookie(ctx, name, `${name}=; ${cookieAttrsForRequest(ctx, crossDomain)}; Max-Age=0`);
}

/**
 * Cookie name for a federated sign-in in flight (`authpending_<fullId>`): the
 * PKCE verifier, nonce and `state` the callback needs. Distinct from the
 * session cookie, and short-lived.
 */
function pendingAuthCookieName(fullId: string): string {
	return `authpending_${fullId}`;
}

/**
 * Set the pending federated-sign-in cookie. Its value is opaque here — the
 * federation layer signs it (`engines/pending-auth.ts`). `SameSite=Lax` (the
 * D-007 default) is sent on the IdP's top-level redirect back to the callback.
 * Other cookies already set on the response are preserved.
 *
 * @internal
 */
export function setPendingAuthCookie(
	ctx: BlocksContext,
	fullId: string,
	value: string,
	maxAgeSeconds: number,
	crossDomain = false,
): void {
	const name = pendingAuthCookieName(fullId);
	putSetCookie(ctx, name, `${name}=${value}; ${cookieAttrsForRequest(ctx, crossDomain)}; Max-Age=${maxAgeSeconds}`);
}

/**
 * Read the raw pending federated-sign-in cookie. Verify it before trusting it.
 *
 * @internal
 */
export function readPendingAuthCookie(ctx: BlocksContext, fullId: string): string | null {
	return readCookie(ctx, pendingAuthCookieName(fullId));
}

/**
 * Clear the pending federated-sign-in cookie (`Max-Age=0`). Other cookies
 * already set on the response are preserved.
 *
 * @internal
 */
export function clearPendingAuthCookie(ctx: BlocksContext, fullId: string, crossDomain = false): void {
	const name = pendingAuthCookieName(fullId);
	putSetCookie(ctx, name, `${name}=; ${cookieAttrsForRequest(ctx, crossDomain)}; Max-Age=0`);
}
