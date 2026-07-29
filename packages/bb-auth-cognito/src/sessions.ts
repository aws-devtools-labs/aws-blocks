// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import crypto from 'node:crypto';
import { KVStore } from '@aws-blocks/bb-kv-store';
import type { ScopeParent } from '@aws-blocks/core';

/**
 * Projection of a {@link SessionRecord}'s `idToken` claims into the fields
 * customers see as `CognitoUser`. See {@link decodeIdToken}.
 *
 * @internal
 */
export interface IdTokenClaims {
	username: string;
	userSub: string;
	groups: string[];
	attributes: Record<string, string>;
}

/**
 * Reserved claims we never surface as customer-visible `attributes`.
 * Standard JWT claims (`sub`, `iss`, `aud`, `iat`, `exp`, `nbf`, `jti`) +
 * Cognito-specific token-lifecycle claims (`token_use`, `auth_time`,
 * `origin_jti`, `event_id`).
 */
const RESERVED_ID_TOKEN_CLAIMS = new Set([
	'sub', 'iss', 'aud', 'iat', 'exp', 'nbf', 'jti',
	'token_use', 'auth_time', 'origin_jti', 'event_id',
]);

/**
 * Read a claim from a JWT payload, returning the value only if it's a
 * string. Any other type (including `undefined`, numbers, arrays,
 * objects) yields `fallback` (default: empty string).
 *
 * Use at JWT-claim boundaries instead of `payload.foo as string` — the
 * cast form lies to TypeScript and silently produces `"undefined"` /
 * `"[object Object]"` values when the claim isn't what the call site
 * expected.
 *
 * @internal
 */
export function safeStringClaim(
	payload: Record<string, unknown>,
	key: string,
	fallback = '',
): string {
	const v = payload[key];
	return typeof v === 'string' ? v : fallback;
}

/**
 * Read a claim from a JWT payload, returning only the string entries
 * of the array. Any non-array value yields `fallback` (default: `[]`);
 * mixed-type arrays are filtered down to the string entries only.
 *
 * @internal
 */
export function safeStringArrayClaim(
	payload: Record<string, unknown>,
	key: string,
	fallback: string[] = [],
): string[] {
	const v = payload[key];
	if (!Array.isArray(v)) return fallback;
	return v.filter((x): x is string => typeof x === 'string');
}

/**
 * Decode an ID token's payload and project the claims Blocks cares about.
 *
 * **Unsafe decode** — signature is NOT re-verified. This function is only
 * called on tokens that were verified via `aws-jwt-verify` before being
 * stored in a {@link SessionRecord}, and the record is reached only through
 * an HMAC-signed session cookie. Re-verifying here would add a JWKS fetch
 * to every request for zero additional security.
 *
 * Allow-shape filter for `attributes`: anything non-reserved and not
 * `cognito:`-prefixed flows through. A new Cognito reserved claim added
 * later should be added to `RESERVED_ID_TOKEN_CLAIMS`.
 *
 * @internal
 */
export function decodeIdToken(idToken: string): IdTokenClaims {
	const parts = idToken.split('.');
	if (parts.length < 2) {
		throw new Error('decodeIdToken: malformed token (expected JWT header.payload.signature)');
	}
	const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<string, unknown>;
	const username =
		safeStringClaim(payload, 'cognito:username')
		|| safeStringClaim(payload, 'username');
	const userSub = safeStringClaim(payload, 'sub');
	const groups = safeStringArrayClaim(payload, 'cognito:groups');
	const attributes: Record<string, string> = {};
	for (const [k, v] of Object.entries(payload)) {
		if (typeof v !== 'string') continue;
		if (RESERVED_ID_TOKEN_CLAIMS.has(k)) continue;
		if (k.startsWith('cognito:')) continue;
		attributes[k] = v;
	}
	return { username, userSub, groups, attributes };
}

/**
 * Read a JWT's `exp` claim and return it as absolute ms since epoch.
 *
 * Same unsafe-decode guarantees as {@link decodeIdToken}: the token was
 * verified on sign-in + refresh and is reached only through an HMAC-signed
 * session cookie. Returns `0` (treated as expired by callers) if the token
 * is malformed or missing `exp`.
 *
 * @internal
 */
export function jwtExpMs(token: string): number {
	const parts = token.split('.');
	if (parts.length < 2) return 0;
	try {
		const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<string, unknown>;
		const exp = payload.exp;
		if (typeof exp !== 'number') return 0;
		return exp * 1000; // JWT `exp` is seconds-since-epoch; our callers use ms.
	} catch {
		return 0;
	}
}

/**
 * Decode a JWT's payload (claims object) without verifying the signature.
 *
 * Same unsafe-decode guarantees as {@link decodeIdToken}: only called
 * through the HMAC-signed session cookie, and only on tokens Cognito
 * issued to sign-in / refresh after `aws-jwt-verify` validation.
 *
 * Returns an empty object rather than throwing on malformed input so the
 * caller can surface a reasonable shape when the session store is somehow
 * populated with garbage.
 *
 * @internal
 */
export function decodeJwtPayload(token: string): Record<string, unknown> {
	const parts = token.split('.');
	if (parts.length < 2) return {};
	try {
		return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<string, unknown>;
	} catch {
		return {};
	}
}

/**
 * Wrap a raw JWT string as an Amplify-JS-v6-compatible `JWT` object. Used by
 * {@link AuthCognito.fetchAuthSession} to return tokens in the shape
 * Amplify-JS consumers expect (interoperability).
 *
 * @internal
 */
export function rawToJwt(raw: string): { toString(): string; payload: Record<string, unknown>; expiresAt: number } {
	const payload = decodeJwtPayload(raw);
	return {
		toString: () => raw,
		payload,
		expiresAt: typeof payload.exp === 'number' ? payload.exp * 1000 : 0,
	};
}

/**
 * Build an `AuthSession.tokens` object from a stored session record.
 *
 * @internal
 */
export function sessionToTokens(record: SessionRecord): {
	idToken: ReturnType<typeof rawToJwt>;
	accessToken: ReturnType<typeof rawToJwt>;
} {
	return {
		idToken: rawToJwt(record.idToken),
		accessToken: rawToJwt(record.accessToken),
	};
}

/**
 * Record stored in the session `KVStore` keyed by server-generated session ID.
 *
 * Intentionally minimal — the three tokens ARE the session. User-visible
 * fields (username, sub, groups, attributes) come from decoding the ID
 * token on read; validity comes from the access token's `exp` claim on
 * read. No denormalized copies that could drift from what Cognito asserts.
 *
 * The tokens in this record were verified on sign-in + every refresh via
 * `aws-jwt-verify` before being stored. Once inside the record, they're
 * under the HMAC-signed session-cookie protection (a tampered cookie fails
 * signature check before we ever read the record) — re-verifying on every
 * read would be belt-and-suspenders, not a security property.
 *
 * In the mock runtime, tokens are synthetic base64url-encoded JWT-shaped
 * strings so the same decode path works.
 *
 * @internal
 */
export interface SessionRecord {
	/** ID token — decode for username, sub, groups, attributes. */
	idToken: string;
	/** Access token — passed to Cognito SDK calls; `exp` claim gates validity. */
	accessToken: string;
	/** Refresh token — used by `REFRESH_TOKEN_AUTH`. */
	refreshToken: string;
}

/**
 * Session store backed by a nested `KVStore` — provisioned as a child scope
 * at CDK synth time so it becomes its own DynamoDB table in AWS and a
 * JSON-on-disk mock locally. Same code path in both runtimes.
 *
 * @internal
 */
export class SessionStore {
	private kv: KVStore<SessionRecord>;

	constructor(scope: ScopeParent, id = 'sessions') {
		this.kv = new KVStore<SessionRecord>(scope, id);
	}

	/** Insert a new session record; returns the generated session ID. */
	async createSession(record: SessionRecord): Promise<string> {
		const sessionId = crypto.randomBytes(24).toString('base64url');
		await this.kv.put(sessionId, record);
		return sessionId;
	}

	/** Return the session, or `null` if not found. */
	lookupSession(sessionId: string): Promise<SessionRecord | null> {
		return this.kv.get(sessionId);
	}

	/** Delete a session. Silent no-op if it doesn't exist. */
	async deleteSession(sessionId: string): Promise<void> {
		await this.kv.delete(sessionId);
	}

	async updateSession(sessionId: string, update: Partial<SessionRecord>): Promise<void> {
		const existing = await this.kv.get(sessionId);
		if (!existing) return;
		await this.kv.put(sessionId, { ...existing, ...update });
	}

	/**
	 * Delete every session belonging to a user. Used by the admin surface's
	 * `revokeUserSessions` to force re-authentication (mock parity for
	 * Cognito's `AdminUserGlobalSignOut`). Returns the number deleted.
	 *
	 * `SessionRecord` is deliberately minimal (tokens only — see its docs), so
	 * the owning username is recovered by decoding each session's ID token
	 * rather than read from a denormalized field.
	 */
	async deleteByUsername(username: string): Promise<number> {
		const toDelete: string[] = [];
		for await (const { key, value } of this.kv.scan()) {
			if (decodeIdToken(value.idToken).username === username) toDelete.push(key);
		}
		for (const id of toDelete) await this.kv.delete(id);
		return toDelete.length;
	}
}
