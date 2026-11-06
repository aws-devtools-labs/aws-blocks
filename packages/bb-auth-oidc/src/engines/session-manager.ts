// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `SessionManager` — shared session/cookie logic for all `AuthEngine` implementations.
 * Handles session persistence, cookie management, and CAS-based refresh coordination.
 */

import { ApiError, type BlocksContext } from '@aws-blocks/core';
import { AuthOIDCErrors } from '../errors.js';
import {
	buildClearCookie,
	buildSetCookie,
	decodeSignedCookie,
	encodeSignedCookie,
	isExpired,
	PENDING_AUTH_TTL_SECONDS,
	readCookie,
	type PendingAuthPayload,
	type SessionCookiePayload,
} from '../session-cookie.js';
import type { OIDCUser, SecretLike, SessionRow, SessionStore } from '../types.js';
import { memoizedSecretResolver } from '../providers.js';

export interface SessionManagerOptions {
	/** Session store for stateful sessions + refresh. Always provisioned by the BB. */
	sessionStore: SessionStore;
	/**
	 * HMAC signing key for session + pending-auth cookies.
	 * Accepts a literal string or a lazily-resolved closure.
	 */
	cookieSecret: SecretLike;
	/** Cookie name prefix for this instance. */
	cookieNamePrefix: string;
	/** Attributes to set on issued cookies (Secure, Partitioned, etc.). */
	cookieAttributes: {
		secure: boolean;
		partitioned: boolean;
		sameSite: 'Strict' | 'Lax' | 'None';
		path: string;
	};
	/**
	 * How long to treat a `state: 'refreshing'` row as owned before
	 * reclaiming it via CAS. Default: 30 seconds.
	 */
	staleLockTimeoutMs?: number;
}

/** Engine-supplied callback to perform the actual token refresh. */
export type RefreshFn = (refreshToken: string, providerName: string) => Promise<{
		refreshToken: string;
		exp: number;
		claims: Readonly<Record<string, unknown>>;
	}>

const SESSION_COOKIE_SUFFIX = 'session';
const PENDING_COOKIE_SUFFIX = 'pending';

export function sessionCookieName(prefix: string): string {
	return `${prefix}_${SESSION_COOKIE_SUFFIX}`;
}

export function pendingCookieName(prefix: string): string {
	return `${prefix}_${PENDING_COOKIE_SUFFIX}`;
}

export class SessionManager {
	private readonly cookieSecretResolver: () => Promise<string>;
	/** Per-Lambda-container refresh coalescer. */
	private readonly refreshInFlight = new Map<string, Promise<OIDCUser | null>>();

	constructor(private readonly options: SessionManagerOptions) {
		this.cookieSecretResolver = memoizedSecretResolver(options.cookieSecret);
	}

	/** Expose the cookie name prefix for external cookie-presence checks. */
	get cookieNamePrefix(): string {
		return this.options.cookieNamePrefix;
	}

	/** Expose the session store for engines that need direct access (e.g. sign-out revocation). */
	get sessionStore(): SessionStore {
		return this.options.sessionStore;
	}

	/** Resolve the cookie-signing secret (memoized per container). */
	resolveCookieSecret(): Promise<string> {
		return this.cookieSecretResolver();
	}

	/** Persist a stateful session: mint session id, write the row, issue the cookie. */
	async writeStatefulSession(
		user: OIDCUser,
		refreshToken: string | undefined,
		ctx: BlocksContext,
	): Promise<void> {
		const sessionId = randomSessionId();
		const exp = typeof (user.claims as { exp?: number }).exp === 'number'
			? (user.claims as { exp: number }).exp
			: Math.floor(Date.now() / 1000) + 3600;
		const row: SessionRow = {
			userId: user.userId,
			refreshToken: refreshToken ?? '',
			expiresAt: exp,
			claims: user.claims,
			state: 'ready',
		};
		await this.options.sessionStore.put(sessionId, row, { ifNotExists: true });

		// Cookie envelope `exp` is generous — token rotations keep the session
		// alive, so the browser should retain the cookie well past the access
		// token's TTL. 30 days matches most refresh-token TTLs; the server
		// still gates access by checking the stored row.
		const cookieExp = Math.floor(Date.now() / 1000) + 30 * 24 * 3600;
		const payload: SessionCookiePayload = {
			mode: 'stateful',
			provider: user.provider,
			sessionId,
			exp: cookieExp,
		};
		await this.setSessionCookie(ctx, payload);
	}

	/** Verify a stateful session cookie and refresh if access token expired. */
	async verifyStatefulSession(
		ctx: BlocksContext,
		refreshFn: RefreshFn,
	): Promise<OIDCUser | null> {
		const cookieHeader = ctx.request.headers.get('cookie');
		const raw = readCookie(cookieHeader, sessionCookieName(this.options.cookieNamePrefix));
		if (!raw) return null;
		const secret = await this.cookieSecretResolver();
		const payload = decodeSignedCookie<SessionCookiePayload>(raw, secret);
		if (!payload) return null;
		if (isExpired(payload)) return null;

		const row = await this.options.sessionStore.get(payload.sessionId);
		if (!row) return null;
		if (row.state === 'expired') return null;

		const now = Math.floor(Date.now() / 1000);
		if (row.expiresAt > now) {
			return statefulRowToUser(row, payload.provider);
		}

		// Access token expired — try to refresh via the CAS protocol.
		return this.refreshStatefulSession(payload.sessionId, row, payload.provider, refreshFn);
	}

	/**
	 * Force a refresh of the current session. Used by the engine's
	 * `refreshSession` method.
	 */
	async forceRefresh(
		ctx: BlocksContext,
		refreshFn: RefreshFn,
	): Promise<OIDCUser | null> {
		const cookieHeader = ctx.request.headers.get('cookie');
		const raw = readCookie(cookieHeader, sessionCookieName(this.options.cookieNamePrefix));
		if (!raw) return null;
		const secret = await this.cookieSecretResolver();
		const payload = decodeSignedCookie<SessionCookiePayload>(raw, secret);
		if (!payload) return null;
		const row = await this.options.sessionStore.get(payload.sessionId);
		if (!row) return null;
		return this.refreshStatefulSession(payload.sessionId, row, payload.provider, refreshFn);
	}

	/**
	 * Clear session cookie, evict row, and revoke the refresh token upstream.
	 *
	 * The row is read before it is deleted so the refresh token is captured even
	 * when the delete then fails. Cookies are always cleared and `revoke` always
	 * runs when a refresh token was captured, so this device is signed out and the
	 * IdP grant is revoked whenever possible. If the row delete fails, the
	 * server-side session was NOT invalidated (a copy of the cookie keeps
	 * authenticating), so this throws a branded `SignOutIncompleteException`
	 * (503) rather than reporting success. The raw store error is logged, never
	 * thrown — it can carry SDK metadata/ARNs. A failed read alone is logged:
	 * the delete still invalidates the session, only upstream revocation is lost.
	 */
	async signOutSession(
		ctx: BlocksContext,
		revoke: (refreshToken: string, provider: string) => Promise<void>,
	): Promise<void> {
		const cookieHeader = ctx.request.headers.get('cookie');
		const raw = readCookie(cookieHeader, sessionCookieName(this.options.cookieNamePrefix));
		const payload = raw ? decodeSignedCookie<SessionCookiePayload>(raw, await this.cookieSecretResolver()) : null;
		let refreshToken: string | undefined;
		let deleteFailed = false;
		if (payload) {
			try {
				const row = await this.options.sessionStore.get(payload.sessionId);
				refreshToken = row?.refreshToken || undefined;
			} catch (err) {
				// eslint-disable-next-line no-console
				console.warn('AuthOIDC signOut: session read failed; upstream revocation skipped:', describeError(err));
			}
			try {
				await this.options.sessionStore.delete(payload.sessionId);
			} catch (err) {
				deleteFailed = true;
				// eslint-disable-next-line no-console
				console.error('AuthOIDC signOut: session delete failed; session not invalidated:', describeError(err));
			}
		}
		this.clearSessionCookie(ctx);
		this.clearPendingAuthCookie(ctx);
		if (payload && refreshToken) {
			await revoke(refreshToken, payload.provider);
		}
		if (deleteFailed) {
			throw new ApiError('Sign-out could not be completed: the server-side session was not invalidated', 503, {
				name: AuthOIDCErrors.SignOutIncomplete,
			});
		}
	}

	/**
	 * Read and verify the pending-auth cookie from the request.
	 */
	async readPendingAuth(ctx: BlocksContext): Promise<PendingAuthPayload | null> {
		const cookie = readCookie(ctx.request.headers.get('cookie'), pendingCookieName(this.options.cookieNamePrefix));
		if (!cookie) return null;
		const secret = await this.cookieSecretResolver();
		const payload = decodeSignedCookie<PendingAuthPayload>(cookie, secret);
		if (!payload) return null;
		if (isExpired(payload)) return null;
		return payload;
	}

	/**
	 * Build a pending-auth `Set-Cookie` header value.
	 */
	async buildPendingAuthCookie(pending: PendingAuthPayload): Promise<string> {
		const secret = await this.cookieSecretResolver();
		return buildSetCookie(
			encodeSignedCookie(pending, secret),
			{
				name: pendingCookieName(this.options.cookieNamePrefix),
				path: this.options.cookieAttributes.path,
				maxAge: PENDING_AUTH_TTL_SECONDS,
				sameSite: this.options.cookieAttributes.sameSite,
				secure: this.options.cookieAttributes.secure,
				partitioned: this.options.cookieAttributes.partitioned,
				httpOnly: true,
			},
		);
	}

	/**
	 * Clear the pending-auth cookie on the response.
	 */
	clearPendingAuthCookie(ctx: BlocksContext): void {
		appendSetCookie(ctx, buildClearCookie(pendingCookieName(this.options.cookieNamePrefix), {
			path: this.options.cookieAttributes.path,
			sameSite: this.options.cookieAttributes.sameSite,
			secure: this.options.cookieAttributes.secure,
			partitioned: this.options.cookieAttributes.partitioned,
			httpOnly: true,
		}));
	}

	/**
	 * CAS-based refresh protocol for cross-container coordination.
	 */
	private async refreshStatefulSession(
		sessionId: string,
		row: SessionRow,
		providerName: string,
		refreshFn: RefreshFn,
	): Promise<OIDCUser | null> {
		// Per-container coalesce: one refresh per sessionId per container.
		const existing = this.refreshInFlight.get(sessionId);
		if (existing) return existing;

		const attempt = this._doRefresh(sessionId, row, providerName, refreshFn)
			.finally(() => this.refreshInFlight.delete(sessionId));
		this.refreshInFlight.set(sessionId, attempt);
		return attempt;
	}

	private async _doRefresh(
		sessionId: string,
		currentRow: SessionRow,
		providerName: string,
		refreshFn: RefreshFn,
	): Promise<OIDCUser | null> {
		const staleLockTimeoutMs = this.options.staleLockTimeoutMs ?? 30_000;

		const row = currentRow;
		// If another holder owns the lock and hasn't timed out, back off and
		// read their result when they're done.
		if (row.state === 'refreshing') {
			const age = Date.now() - (row.refreshingSince ?? 0);
			if (age < staleLockTimeoutMs) {
				return this.waitForWinner(sessionId, staleLockTimeoutMs - age, providerName);
			}
			// Stale lock — fall through and try to reclaim via CAS.
		}

		// Try to acquire the lock.
		const lockedRow: SessionRow = {
			...row,
			state: 'refreshing',
			refreshingSince: Date.now(),
		};
		try {
			await this.options.sessionStore.put(sessionId, lockedRow, { ifValueEquals: row });
		} catch {
			// CAS failed — someone else took the lock. Re-read and use their
			// result. Do not call the token endpoint.
			const refreshed = await this.options.sessionStore.get(sessionId);
			if (!refreshed || refreshed.state !== 'ready') return null;
			return statefulRowToUser(refreshed, providerName);
		}

		// We own the lock — call the engine's refresh function.
		let newAccessExp: number;
		let newRefreshToken: string;
		let newClaims: Readonly<Record<string, unknown>>;
		try {
			const result = await refreshFn(row.refreshToken, providerName);
			newAccessExp = result.exp;
			newRefreshToken = result.refreshToken;
			newClaims = result.claims;
		} catch {
			// Refresh failed — mark expired so the next request surfaces
			// cleanly. CAS-write against `lockedRow` (our acquired state).
			const expiredRow: SessionRow = {
				...lockedRow,
				state: 'expired',
				refreshingSince: undefined,
			};
			try {
				await this.options.sessionStore.put(sessionId, expiredRow, { ifValueEquals: lockedRow });
			} catch {
			}
			return null;
		}

		const newRow: SessionRow = {
			userId: row.userId,
			refreshToken: newRefreshToken,
			expiresAt: newAccessExp,
			claims: newClaims,
			state: 'ready',
		};
		try {
			await this.options.sessionStore.put(sessionId, newRow, { ifValueEquals: lockedRow });
		} catch {
			// Unexpected — lost the row between acquire and write. Re-read to
			// surface whatever state actually won.
			const refreshed = await this.options.sessionStore.get(sessionId);
			if (!refreshed || refreshed.state !== 'ready') return null;
			return statefulRowToUser(refreshed, providerName);
		}
		return statefulRowToUser(newRow, providerName);
	}

	/** Poll the session store waiting for the lock holder to complete. */
	private async waitForWinner(sessionId: string, maxWaitMs: number, providerName: string): Promise<OIDCUser | null> {
		const deadline = Date.now() + maxWaitMs;
		while (Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, 100));
			const refreshed = await this.options.sessionStore.get(sessionId);
			if (!refreshed) return null;
			if (refreshed.state === 'ready') {
				return statefulRowToUser(refreshed, providerName);
			}
			if (refreshed.state === 'expired') return null;
		}
		return null;
	}

	private async setSessionCookie(ctx: BlocksContext, payload: SessionCookiePayload): Promise<void> {
		const nowSeconds = Math.floor(Date.now() / 1000);
		const maxAge = Math.max(0, payload.exp - nowSeconds);
		const secret = await this.cookieSecretResolver();
		const header = buildSetCookie(
			encodeSignedCookie(payload, secret),
			{
				name: sessionCookieName(this.options.cookieNamePrefix),
				path: this.options.cookieAttributes.path,
				maxAge,
				sameSite: this.options.cookieAttributes.sameSite,
				secure: this.options.cookieAttributes.secure,
				partitioned: this.options.cookieAttributes.partitioned,
				httpOnly: true,
			},
		);
		appendSetCookie(ctx, header);
	}

	private clearSessionCookie(ctx: BlocksContext): void {
		appendSetCookie(ctx, buildClearCookie(sessionCookieName(this.options.cookieNamePrefix), {
			path: this.options.cookieAttributes.path,
			sameSite: this.options.cookieAttributes.sameSite,
			secure: this.options.cookieAttributes.secure,
			partitioned: this.options.cookieAttributes.partitioned,
			httpOnly: true,
		}));
	}
}

/** Build an `OIDCUser` from a stored session row. */
export function statefulRowToUser(row: SessionRow, providerName: string): OIDCUser {
	const claims = row.claims;
	const sub = typeof claims.sub === 'string' ? claims.sub : (row.userId.split(':').pop() ?? '');
	const iss = typeof claims.iss === 'string' ? claims.iss : row.userId.split(':')[0];
	const email = typeof claims.email === 'string' ? claims.email : null;
	const name = typeof claims.name === 'string' ? claims.name : null;
	const username = name ?? email ?? sub;
	return {
		userId: row.userId,
		username,
		provider: providerName,
		sub,
		iss,
		email,
		name,
		claims,
	};
}

/** Mint an opaque, unguessable session id (256 bits of entropy). */
function randomSessionId(): string {
	const bytes = new Uint8Array(32);
	globalThis.crypto.getRandomValues(bytes);
	return Buffer.from(bytes).toString('base64url');
}

function appendSetCookie(ctx: BlocksContext, header: string): void {
	ctx.response.headers.append('Set-Cookie', header);
}

function describeError(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
