// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The server-side session store and its record format.
 *
 * ## Compatibility contract (the upgrade safety property)
 *
 * An app that switches `AuthCognito` → `Auth` with the same id keeps its
 * `sessions` table, and its signed-in users must stay signed in. So:
 *
 * - The store is a `KVStore` at child id `sessions` of the block (same table,
 *   same mock file `.bb-data/<fullId>-sessions/store.json`).
 * - Keys are `AuthCognito`'s: 24 random bytes, base64url.
 * - A **pool session** (email + password, or any provider federated through
 *   Cognito) is stored exactly as `AuthCognito` stores it:
 *   `{ idToken, accessToken, refreshToken }` with **no discriminator**. A row
 *   `AuthCognito` wrote is therefore read as a pool session unchanged. Its user
 *   is decoded from the ID token, its validity is the access token's `exp`.
 *   `Auth` adds one optional field, `provider`, only for sessions that came
 *   through a hosted-UI federated provider; `AuthCognito` ignores it.
 * - A **direct session** (an OIDC provider federated directly, Q1 — no Cognito
 *   record and no Cognito tokens) carries the discriminator `kind: 'direct'`.
 *   Its identity is `` `${issuer}:${subject}` ``.
 * - Every write stamps the row with a DynamoDB TTL of `now + session ttl`
 *   (default 400 days, `AuthCognito`'s), recomputed per write so a refresh
 *   slides it forward — the same semantics as `AuthCognito`'s `SessionStore`.
 *
 * Anything else in the table — an `AuthOIDC` row (`{ userId, refreshToken,
 * expiresAt, claims, state }`), a row whose ID token does not decode, garbage —
 * parses to `null` and is treated as signed-out. Never a throw.
 *
 * Internal — not exported from any package entry.
 *
 * @internal
 */

import crypto from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { KVStore } from '@aws-blocks/bb-kv-store';
import type { ScopeParent } from '@aws-blocks/core';
import { type SignInMode, signsInWithAttribute } from './sign-in-mode.js';
import type { JWT } from './types.js';

/** `AuthCognito`'s default session lifetime: 400 days. */
export const DEFAULT_SESSION_TTL_SECONDS = 400 * 86400;

/**
 * A pool session row — **byte-compatible with `AuthCognito`'s `SessionRecord`**.
 * The three Cognito tokens *are* the session; nothing is denormalized.
 *
 * @internal
 */
export interface PoolSessionRecord {
	/** Cognito ID token — decoded for username, sub, groups, attributes, `auth_time`. */
	idToken: string;
	/** Cognito access token — its `exp` claim gates validity. */
	accessToken: string;
	/** Cognito refresh token (`''` when none was issued — `AuthCognito`'s convention). */
	refreshToken: string;
	/**
	 * The hosted-UI federated provider id that issued these tokens, so the right
	 * engine refreshes them. Absent for email + password sign-in — and on every
	 * row `AuthCognito` wrote, which is why absence means `'password'`.
	 */
	provider?: string;
}

/**
 * A direct-federation session row (OIDC `federateVia: 'direct'`). No Cognito
 * user and no Cognito tokens, so identity and claims are stored explicitly.
 *
 * @internal
 */
export interface DirectSessionRecord {
	/** The discriminator. Pool rows never carry `kind`. */
	kind: 'direct';
	/** The configured provider id (`oidcProviders` key). */
	provider: string;
	/** The ID token's `iss`. */
	issuer: string;
	/** The ID token's `sub`. */
	subject: string;
	/** Display name: the `name` claim, else `email`, else `sub` (as `AuthOIDC`). */
	username: string;
	/** Group memberships read from the provider's `groupsClaim` at sign-in. */
	groups: string[];
	/** Profile claims (string-valued, reserved claims removed). */
	attributes: Record<string, string>;
	/** When the user authenticated at the IdP, seconds since the epoch. */
	authTime: number;
	/** When the session must be refreshed, ms since the epoch. */
	expiresAt: number;
	/** The raw tokens, when the IdP issued them. */
	idToken?: string;
	accessToken?: string;
	refreshToken?: string;
}

/**
 * Every row shape `Auth` reads or writes.
 *
 * @internal
 */
export type SessionRecord = PoolSessionRecord | DirectSessionRecord;

/**
 * The claims-derived view of a session that `AuthBase` projects into an
 * `AuthenticatedUser`.
 *
 * @internal
 */
export interface SessionIdentity {
	userId: string;
	username: string;
	userSub: string;
	groups: string[];
	attributes: Record<string, string>;
	/** `'password'` or the provider id. */
	signInProvider: string;
	/** Seconds since the epoch; `0` when unknown (never "fresh"). */
	authTime: number;
	/** When the session needs a refresh, ms since the epoch (`0` = now). */
	expiresAt: number;
	/**
	 * A direct-federation session's identity claims (`AuthenticatedUser.claims`):
	 * the stored ID token's, else the profile claims, with the row's `iss` and
	 * `sub` on top. Absent for a pool session.
	 */
	claims?: Record<string, unknown>;
	/**
	 * The session ID token's `email_verified` / `phone_number_verified`, which
	 * are not `attributes` (a Cognito or OIDC ID token carries them as JSON
	 * booleans). Read by the sign-in UI's display name only (R64, FX31).
	 */
	verified: ContactVerification;
}

/**
 * Whether the user's email / phone number is verified, as the session's ID
 * token says — `undefined` when it doesn't say.
 *
 * @internal
 */
export interface ContactVerification {
	email?: boolean;
	phone_number?: boolean;
}

/**
 * The `email_verified` / `phone_number_verified` claims of an ID token (or a
 * provider's profile claims). A JSON boolean, as Cognito and OIDC Core §5.1
 * send them, or the string `'true'` / `'false'`, which some providers send;
 * anything else is unknown.
 *
 * @internal
 */
export function contactVerificationOf(claims: Record<string, unknown>): ContactVerification {
	const flag = (value: unknown): boolean | undefined => {
		if (typeof value === 'boolean') return value;
		if (value === 'true') return true;
		if (value === 'false') return false;
		return undefined;
	};
	const email = flag(claims.email_verified);
	const phone = flag(claims.phone_number_verified);
	return {
		...(email !== undefined ? { email } : {}),
		...(phone !== undefined ? { phone_number: phone } : {}),
	};
}

/**
 * Reserved claims never surfaced as customer-visible `attributes`: standard JWT
 * claims plus Cognito token-lifecycle claims. Same set as `AuthCognito`.
 */
const RESERVED_ID_TOKEN_CLAIMS = new Set([
	'sub',
	'iss',
	'aud',
	'iat',
	'exp',
	'nbf',
	'jti',
	'token_use',
	'auth_time',
	'origin_jti',
	'event_id',
]);

/**
 * String-valued, non-reserved, non-`cognito:` claims — the customer-visible
 * attributes. Same allow-shape as `AuthCognito`'s `extractUserAttributes`.
 *
 * @internal
 */
export function extractUserAttributes(payload: Record<string, unknown>): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(payload)) {
		if (typeof v !== 'string') continue;
		if (RESERVED_ID_TOKEN_CLAIMS.has(k)) continue;
		if (k.startsWith('cognito:')) continue;
		out[k] = v;
	}
	return out;
}

/**
 * Decode a JWT payload without verifying it. `null` for anything that is not
 * `header.payload[.signature]` with a JSON-object payload.
 *
 * Unsafe by design and only used on tokens that were verified before they were
 * stored, read back through an HMAC-signed session cookie (as `AuthCognito`).
 *
 * @internal
 */
export function decodeJwtPayload(token: string): Record<string, unknown> | null {
	const parts = token.split('.');
	if (parts.length < 2) return null;
	try {
		const payload: unknown = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
		if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;
		return Object.fromEntries(Object.entries(payload));
	} catch {
		return null;
	}
}

function stringClaim(payload: Record<string, unknown>, key: string): string {
	const v = payload[key];
	return typeof v === 'string' ? v : '';
}

function numberClaim(payload: Record<string, unknown>, key: string): number {
	const v = payload[key];
	return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function stringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : [];
}

function isStringRecord(value: unknown): value is Record<string, string> {
	return (
		typeof value === 'object' &&
		value !== null &&
		!Array.isArray(value) &&
		Object.values(value).every((v) => typeof v === 'string')
	);
}

/**
 * Validate a raw row read from the store. Returns the typed record, or `null`
 * for anything `Auth` did not write — an `AuthOIDC` row, a malformed row, a
 * pool row whose ID token or access token does not decode. Never throws.
 *
 * @internal
 */
export function parseSessionRecord(raw: unknown): SessionRecord | null {
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
	const kind: unknown = Reflect.get(raw, 'kind');
	if (kind === undefined) {
		const idToken: unknown = Reflect.get(raw, 'idToken');
		const accessToken: unknown = Reflect.get(raw, 'accessToken');
		const refreshToken: unknown = Reflect.get(raw, 'refreshToken');
		const provider: unknown = Reflect.get(raw, 'provider');
		if (typeof idToken !== 'string' || typeof accessToken !== 'string') return null;
		const claims = decodeJwtPayload(idToken);
		if (!claims || !stringClaim(claims, 'sub')) return null;
		if (!decodeJwtPayload(accessToken)) return null;
		if (provider !== undefined && typeof provider !== 'string') return null;
		return {
			idToken,
			accessToken,
			refreshToken: typeof refreshToken === 'string' ? refreshToken : '',
			...(typeof provider === 'string' ? { provider } : {}),
		};
	}
	if (kind === 'direct') {
		const r = {
			provider: Reflect.get(raw, 'provider'),
			issuer: Reflect.get(raw, 'issuer'),
			subject: Reflect.get(raw, 'subject'),
			username: Reflect.get(raw, 'username'),
			groups: Reflect.get(raw, 'groups'),
			attributes: Reflect.get(raw, 'attributes'),
			authTime: Reflect.get(raw, 'authTime'),
			expiresAt: Reflect.get(raw, 'expiresAt'),
			idToken: Reflect.get(raw, 'idToken'),
			accessToken: Reflect.get(raw, 'accessToken'),
			refreshToken: Reflect.get(raw, 'refreshToken'),
		};
		if (
			typeof r.provider !== 'string' ||
			typeof r.issuer !== 'string' ||
			typeof r.subject !== 'string' ||
			!r.subject ||
			typeof r.username !== 'string' ||
			typeof r.authTime !== 'number' ||
			typeof r.expiresAt !== 'number' ||
			!isStringRecord(r.attributes)
		) {
			return null;
		}
		const optional = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
		const idToken = optional(r.idToken);
		const accessToken = optional(r.accessToken);
		const refreshToken = optional(r.refreshToken);
		return {
			kind: 'direct',
			provider: r.provider,
			issuer: r.issuer,
			subject: r.subject,
			username: r.username,
			groups: stringArray(r.groups),
			attributes: r.attributes,
			authTime: r.authTime,
			expiresAt: r.expiresAt,
			...(idToken !== undefined ? { idToken } : {}),
			...(accessToken !== undefined ? { accessToken } : {}),
			...(refreshToken !== undefined ? { refreshToken } : {}),
		};
	}
	return null;
}

/**
 * The identity a session represents. Pool sessions decode the ID token the
 * way `AuthCognito` does (`cognito:username`, `sub`, `cognito:groups`,
 * string claims as attributes); freshness is the ID token's `auth_time`
 * (preserved by Cognito across refreshes), falling back to `iat`.
 *
 * @internal
 */
export function identityOf(record: SessionRecord): SessionIdentity {
	if ('kind' in record) {
		const id = `${record.issuer}:${record.subject}`;
		const claims = record.idToken ? (decodeJwtPayload(record.idToken) ?? record.attributes) : record.attributes;
		return {
			userId: id,
			username: record.username,
			userSub: id,
			groups: record.groups,
			attributes: record.attributes,
			signInProvider: record.provider,
			authTime: record.authTime,
			expiresAt: record.expiresAt,
			claims: { ...claims, iss: record.issuer, sub: record.subject },
			verified: contactVerificationOf(claims),
		};
	}
	const claims = decodeJwtPayload(record.idToken) ?? {};
	const access = decodeJwtPayload(record.accessToken) ?? {};
	const username = stringClaim(claims, 'cognito:username') || stringClaim(claims, 'username');
	return {
		userId: username,
		username,
		userSub: stringClaim(claims, 'sub'),
		groups: stringArray(claims['cognito:groups']),
		attributes: extractUserAttributes(claims),
		signInProvider: record.provider ?? 'password',
		authTime: numberClaim(claims, 'auth_time') || numberClaim(claims, 'iat'),
		expiresAt: numberClaim(access, 'exp') * 1000,
		verified: contactVerificationOf(claims),
	};
}

/**
 * Wrap a raw JWT string as the `JWT` shape `getAuthSession` returns
 * (Amplify-JS-v6-compatible, as `AuthCognito`).
 *
 * @internal
 */
export function rawToJwt(raw: string): JWT {
	const payload = decodeJwtPayload(raw) ?? {};
	return {
		toString: () => raw,
		payload,
		expiresAt: numberClaim(payload, 'exp') * 1000,
	};
}

/**
 * The store. A nested `KVStore` at child id `sessions` — its own DynamoDB table
 * in AWS, a JSON file locally; the same code path in both runtimes.
 *
 * @internal
 */
export class SessionStore {
	private readonly kv: KVStore<unknown>;
	private readonly ttlSeconds?: number;

	/**
	 * @param scope - The `Auth` instance (the store is its `sessions` child).
	 * @param ttlSeconds - When set, every write stamps the row with a DynamoDB
	 *   TTL of `now + ttlSeconds`, so abandoned sessions are reaped instead of
	 *   retaining refresh tokens at rest forever. Callers pass the session
	 *   lifetime, keeping the row's ceiling aligned with the cookie's `Max-Age`.
	 */
	constructor(scope: ScopeParent, ttlSeconds?: number) {
		this.kv = new KVStore<unknown>(scope, 'sessions');
		this.ttlSeconds = ttlSeconds !== undefined && ttlSeconds > 0 ? ttlSeconds : undefined;
	}

	private writeOptions(): { ttlSeconds: number } | undefined {
		return this.ttlSeconds === undefined ? undefined : { ttlSeconds: this.ttlSeconds };
	}

	/** Insert a new session; returns the generated session id. */
	async create(record: SessionRecord): Promise<string> {
		const sessionId = crypto.randomBytes(24).toString('base64url');
		await this.kv.put(sessionId, record, this.writeOptions());
		return sessionId;
	}

	/**
	 * The session, or `null` when it does not exist, has expired, or is not a
	 * row `Auth` can read ({@link parseSessionRecord}).
	 */
	async lookup(sessionId: string): Promise<SessionRecord | null> {
		return parseSessionRecord(await this.kv.get(sessionId));
	}

	/** Replace a session's row (sliding its TTL forward). */
	async replace(sessionId: string, record: SessionRecord): Promise<void> {
		await this.kv.put(sessionId, record, this.writeOptions());
	}

	/** Delete a session. Silent no-op if it does not exist. */
	async delete(sessionId: string): Promise<void> {
		await this.kv.delete(sessionId);
	}

	/**
	 * Delete every **pool** session of `username` (rows `AuthCognito` wrote
	 * included); returns how many. Scans the whole table, so it backs only the
	 * privileged `auth.admin.revokeUserSessions` — never a request path. Direct
	 * (federated) rows and rows `Auth` cannot read are left alone.
	 *
	 * With `signInMode`, `username` may also be a sign-in email / phone, as
	 * Cognito accepts it in `AdminUserGlobalSignOut`: on an email / phone-only
	 * pool the session's username is the generated one, so the row is matched
	 * on the ID token's `email` / `phone_number` (verified, on an alias pool).
	 */
	async deleteByUsername(username: string, signInMode?: SignInMode): Promise<number> {
		const rows = await Array.fromAsync(this.kv.scan({ includeExpired: true }));
		const ids = rows
			.filter(({ value }) => {
				const record = parseSessionRecord(value);
				if (record === null || 'kind' in record) return false;
				if (identityOf(record).username === username) return true;
				return (
					signInMode !== undefined &&
					signsInWithAttribute(signInMode, decodeJwtPayload(record.idToken) ?? {}, username)
				);
			})
			.map(({ key }) => key);
		for (const id of ids) await this.kv.delete(id);
		return ids.length;
	}
}

/**
 * The session-signing secret in the **mock** runtime.
 *
 * `AuthCognito`'s mock keeps its secret in `.bb-data/<fullId>/state.json`
 * (`sessionSecret`), so reading it from there keeps local sessions signed in
 * across the `AuthCognito` → `Auth` switch too. When that file has no secret,
 * one is generated and merged into it (other fields untouched), so the native
 * mock engine (D5b), which owns the rest of that file, must preserve the
 * `sessionSecret` field when it writes.
 *
 * @param dataDir - `getMockDataDir(auth)`.
 *
 * @internal
 */
export function readMockSessionSecret(dataDir: string): string {
	const file = join(dataDir, 'state.json');
	let state: Record<string, unknown> = {};
	if (existsSync(file)) {
		try {
			const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
			if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
				state = Object.fromEntries(Object.entries(parsed));
			}
		} catch {
			// Unreadable: leave it for the engine that owns it, and keep a secret
			// in memory only (sessions then last for this process).
			return crypto.randomBytes(32).toString('hex');
		}
	}
	const existing = state.sessionSecret;
	if (typeof existing === 'string' && existing) return existing;
	const secret = crypto.randomBytes(32).toString('hex');
	const tmp = `${file}.tmp`;
	writeFileSync(tmp, JSON.stringify({ ...state, sessionSecret: secret }, null, 2));
	renameSync(tmp, file);
	return secret;
}
