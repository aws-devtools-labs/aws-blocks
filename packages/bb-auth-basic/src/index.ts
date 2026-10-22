// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Scope, type ScopeParent, type BlocksContext, ApiNamespace, ApiError, DEFAULT_API_ERROR_NAME, isWireSafeError } from '@aws-blocks/core';
import { constantTimeEquals } from '@aws-blocks/core/bb-utils';
import { KVStore } from '@aws-blocks/bb-kv-store';
import { AppSetting } from '@aws-blocks/bb-app-setting';
import type { BlocksAuth, AuthUser, AuthState, AuthActionInput } from '@aws-blocks/auth-common';
import { buildCookieSecurityAttrs, isLoopbackRequest } from '@aws-blocks/auth-common/cookies';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { Logger } from '@aws-blocks/bb-logger';
import type { ChildLogger } from '@aws-blocks/bb-logger';
import { AuthBasicErrors } from './errors.js';
import { BB_NAME, BB_VERSION } from './version.js';

export type { BlocksAuth, AuthUser, AuthState, AuthActionInput } from '@aws-blocks/auth-common';
export type { AuthAction, AuthField } from '@aws-blocks/auth-common';
export { AuthBasicErrors } from './errors.js';

/**
 * User shape returned by AuthBasic. Extends the common `AuthUser`
 * with AuthBasic-specific fields.
 */
export interface AuthBasicUser extends AuthUser {
	/** When the user was created (ISO 8601). */
	createdAt: string;
}

/**
 * Password policy configuration for AuthBasic.
 */
export interface PasswordPolicy {
	/** Minimum password length. Default: 8. */
	minLength?: number;
	/** Require at least one uppercase letter. Default: false. */
	requireUppercase?: boolean;
	/** Require at least one lowercase letter. Default: false. */
	requireLowercase?: boolean;
	/** Require at least one digit. Default: false. */
	requireDigits?: boolean;
	/** Require at least one special character. Default: false. */
	requireSpecialChars?: boolean;
}

/**
 * Callback for delivering verification codes to users (email, SMS, etc.).
 *
 * When provided, AuthBasic enables code-confirmed signup and password reset.
 * When absent, signup is immediate (no confirmation) and password reset is
 * not available.
 *
 * @param username - The user the code is for.
 * @param code - The 6-digit verification code.
 */
export type CodeDeliveryFn = (username: string, code: string) => Promise<void>;

/**
 * Sign-in throttling / account-lockout policy.
 *
 * When configured (via {@link AuthBasicOptions.lockout}), consecutive failed
 * sign-ins for a given username are counted; once `maxAttempts` is reached the
 * account is locked for `lockoutSeconds`, during which `signIn` is rejected
 * with {@link AuthBasicErrors.AccountLocked} (HTTP 429) **before** the password
 * is ever checked. A successful sign-in clears the counter. Counting is
 * per-username (the credential-stuffing target), matching the Cognito-managed
 * lockout the equivalent CDK stack provides.
 */
export interface LockoutPolicy {
	/**
	 * Number of consecutive failed sign-ins that trips the lock. Must be a
	 * positive integer. Default: 5.
	 */
	maxAttempts?: number;
	/**
	 * Sliding window (seconds) over which failures are counted. A failure older
	 * than this resets the running count, so slow, spaced-out attempts don't
	 * accumulate into a lock. Default: 900 (15 minutes).
	 */
	windowSeconds?: number;
	/**
	 * How long (seconds) the account stays locked, measured from the moment
	 * `maxAttempts` is reached. The lock self-expires after this window (no
	 * manual unlock needed). Default: 900 (15 minutes).
	 */
	lockoutSeconds?: number;
}

/**
 * Options for the AuthBasic Building Block.
 */
export interface AuthBasicOptions {
	/** Session duration in seconds. Default: 86400 (24 hours). */
	sessionDuration?: number;
	/** Password policy configuration. */
	passwordPolicy?: PasswordPolicy;
	/**
	 * Code delivery callback. When provided, enables:
	 * - Code-confirmed signup (user must enter a code after registration)
	 * - Password reset (user requests a code, enters it with new password)
	 *
	 * When absent, signup is immediate and password reset is not available.
	 */
	codeDelivery?: CodeDeliveryFn;
	/**
	 * Set `true` only when the frontend and API are served from different
	 * registrable domains in production (e.g. frontend on Vercel, API on
	 * AWS). Switches session cookies to `SameSite=None; Secure; Partitioned`
	 * so they survive the cross-site request. Not needed for same-origin
	 * apps or the local dev proxy, which work with the `SameSite=Lax`
	 * default.
	 *
	 * @default false
	 */
	crossDomain?: boolean;
	/**
	 * Sign-in throttling / account-lockout policy. When omitted, throttling is
	 * **disabled** — sign-in behaves exactly as before. Pass a (possibly empty)
	 * object to enable it with the defaults; see {@link LockoutPolicy}.
	 *
	 * @example
	 * ```typescript
	 * // Lock an account for 15 min after 5 consecutive failed sign-ins
	 * const auth = new AuthBasic(scope, 'auth', { lockout: {} });
	 *
	 * // Stricter: 3 attempts, 30-minute lock
	 * const auth = new AuthBasic(scope, 'auth', {
	 *   lockout: { maxAttempts: 3, lockoutSeconds: 1800 },
	 * });
	 * ```
	 */
	lockout?: LockoutPolicy;
	/** Optional logger for internal operations. When omitted, a default Logger at error level is created. */
	logger?: ChildLogger;
}

/** Internal user record stored in KVStore. */
interface UserRecord {
	hash: string;
	createdAt: string;
	/** When true, the user has not yet confirmed their signup code. */
	unconfirmed?: boolean;
}

/** Verification code duration in seconds. */
const CODE_TTL = 600; // 10 minutes

/**
 * bcrypt cost factor. 12 is a sensible default aligned with current OWASP
 * guidance; raise it for higher-value credentials.
 */
const BCRYPT_COST = 12;

/**
 * Value stored under a `revoked:<jti>` key to mark a session as revoked. Only
 * this exact marker counts as revoked (`isRevoked` asserts it), so a future
 * writer under the shared `codes` store can't accidentally widen the contract.
 */
const REVOKED_MARKER = '1';

/**
 * Simple username/password authentication composed from KVStore.
 *
 * ## Use Cases
 *
 * - Simple user authentication without external identity providers
 * - Internal tools and admin panels
 * - Prototyping and MVPs
 * - Applications with custom user management requirements
 *
 * ## Usage
 *
 * ```typescript
 * import { Scope, ApiNamespace } from '@aws-blocks/core';
 * import { AuthBasic } from '@aws-blocks/bb-auth-basic';
 *
 * const scope = new Scope('my-app');
 * const auth = new AuthBasic(scope, 'auth', {
 *   // Optional: enable code-confirmed signup and password reset
 *   codeDelivery: async (username, code) => {
 *     await sendEmail(username, `Your code: ${code}`);
 *   },
 * });
 *
 * // Export the auth state machine API for the Authenticator component
 * export const authApi = auth.createApi();
 * ```
 *
 * ## Security
 *
 * - Passwords are hashed with bcrypt
 * - Sessions are signed JWTs stored in HTTP-only cookies
 * - Verification codes are HMAC-hashed before storage (not stored in plain text)
 * - The signing secret is stored in AppSetting (SSM SecureString) and shared across Lambda instances
 * - Password policy enforcement on sign-up and password changes
 *
 * ## Local Development
 *
 * In local dev mode, user data is stored in-memory via KVStore mock.
 * Users are lost on restart.
 */
export class AuthBasic extends Scope implements BlocksAuth {
	private users: KVStore;
	private jwtSecret: AppSetting;
	private codes: KVStore;
	private secretPromise: Promise<string> | null = null;
	private readonly sessionDuration: number;
	private readonly passwordPolicy: PasswordPolicy;
	private readonly codeDelivery?: CodeDeliveryFn;
	private readonly crossDomain: boolean;
	/**
	 * Resolved lockout policy, or `null` when throttling is disabled (no
	 * `lockout` option passed). When set, all three fields are concrete numbers.
	 */
	private readonly lockout: Required<LockoutPolicy> | null;
	/** Optional logger for internal operations. When omitted, a default Logger at error level is created. */
	logger?: ChildLogger;

	/** @internal Logger for internal operations. Defaults to error-level when not provided. */
	protected log: ChildLogger;

	constructor(scope: ScopeParent, id: string, options?: AuthBasicOptions) {
		super(id, { parent: scope, bbName: BB_NAME, bbVersion: BB_VERSION });
		this.log = options?.logger ?? new Logger(this, 'logger', { level: 'error' });
		this.users = new KVStore(this, 'users');
		this.jwtSecret = new AppSetting(this, 'jwt-secret', { secret: true });
		// `ttl: true` lets DynamoDB physically reap expired entries. The store
		// holds short-lived verification codes and sign-out revocation markers
		// (both written with `expiresAt`), so reaping keeps it from growing with
		// dead rows. Reads filter expired items regardless, so correctness does
		// not depend on the reaper — this is storage hygiene.
		this.codes = new KVStore(this, 'codes', { ttl: true });
		this.sessionDuration = options?.sessionDuration ?? 86400;
		this.passwordPolicy = options?.passwordPolicy ?? {};
		this.codeDelivery = options?.codeDelivery;
		this.crossDomain = options?.crossDomain ?? false;
		// Throttling is opt-in: only resolve a policy when `lockout` is present
		// (an empty object enables it with defaults). When absent, `signIn` skips
		// the counter entirely and behaves exactly as before.
		this.lockout = options?.lockout
			? {
					maxAttempts: options.lockout.maxAttempts ?? 5,
					windowSeconds: options.lockout.windowSeconds ?? 900,
					lockoutSeconds: options.lockout.lockoutSeconds ?? 900,
				}
			: null;
		// Surface a misconfigured policy at construction (dev time), not as a
		// runtime surprise: `maxAttempts` must be a positive integer and both
		// windows positive, finite numbers (seconds).
		if (this.lockout) {
			const { maxAttempts, windowSeconds, lockoutSeconds } = this.lockout;
			if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
				throw new Error(`AuthBasic: lockout.maxAttempts must be a positive integer, got ${maxAttempts}`);
			}
			if (!Number.isFinite(windowSeconds) || windowSeconds <= 0) {
				throw new Error(`AuthBasic: lockout.windowSeconds must be a positive number, got ${windowSeconds}`);
			}
			if (!Number.isFinite(lockoutSeconds) || lockoutSeconds <= 0) {
				throw new Error(`AuthBasic: lockout.lockoutSeconds must be a positive number, got ${lockoutSeconds}`);
			}
		}
	}

	// ── Secret management ────────────────────────────────────────────────

	private async getSecret(): Promise<string> {
		if (!this.secretPromise) this.secretPromise = this.jwtSecret.get();
		return this.secretPromise;
	}

	// ── Verification codes (HMAC-hashed) ─────────────────────────────────

	private async generateCode(purpose: string, username: string): Promise<string> {
		const code = String(crypto.randomInt(100000, 1000000));
		const secret = await this.getSecret();
		const hmac = crypto.createHmac('sha256', secret).update(`${purpose}:${username}:${code}`).digest('hex');
		// Reap abandoned sign-up/reset codes via the store's TTL: the DynamoDB row
		// self-expires at the code's own expiry, so unused codes don't pile up.
		const expiresAt = Math.floor(Date.now() / 1000) + CODE_TTL;
		await this.codes.put(`${purpose}:${username}`, JSON.stringify({ hmac, expires: Date.now() + CODE_TTL * 1000 }), {
			expiresAt,
		});
		return code;
	}

	private async verifyCode(purpose: string, username: string, code: string): Promise<void> {
		const raw = await this.codes.get(`${purpose}:${username}`);
		if (!raw) {
			throw new ApiError('Invalid or expired code', 400, { name: AuthBasicErrors.InvalidCode });
		}
		const { hmac, expires } = JSON.parse(raw) as { hmac: string; expires: number };
		if (Date.now() > expires) {
			await this.codes.delete(`${purpose}:${username}`);
			throw new ApiError('Invalid or expired code', 400, { name: AuthBasicErrors.InvalidCode });
		}
		const secret = await this.getSecret();
		const expected = crypto.createHmac('sha256', secret).update(`${purpose}:${username}:${code}`).digest('hex');
		if (!constantTimeEquals(hmac, expected)) {
			throw new ApiError('Invalid or expired code', 400, { name: AuthBasicErrors.InvalidCode });
		}
		await this.codes.delete(`${purpose}:${username}`);
	}

	// ── Validation ───────────────────────────────────────────────────────

	private validatePassword(password: string): void {
		const p = this.passwordPolicy;
		const minLen = p.minLength ?? 8;
		const errors: string[] = [];
		if (password.length < minLen) errors.push(`at least ${minLen} characters`);
		if (p.requireUppercase && !/[A-Z]/.test(password)) errors.push('an uppercase letter');
		if (p.requireLowercase && !/[a-z]/.test(password)) errors.push('a lowercase letter');
		if (p.requireDigits && !/\d/.test(password)) errors.push('a digit');
		if (p.requireSpecialChars && !/[^A-Za-z0-9]/.test(password)) errors.push('a special character');
		if (errors.length > 0) {
			throw new ApiError(`Password must contain ${errors.join(', ')}`, 400, { name: AuthBasicErrors.InvalidPassword });
		}
	}

	// ── User record helpers ──────────────────────────────────────────────

	private async getUserRecord(username: string): Promise<UserRecord | null> {
		const raw = await this.users.get(username);
		if (!raw) return null;
		if (raw.startsWith('{')) return JSON.parse(raw) as UserRecord;
		return { hash: raw, createdAt: new Date(0).toISOString() };
	}

	private toAuthBasicUser(username: string, record: UserRecord): AuthBasicUser {
		return { userId: username, username, createdAt: record.createdAt };
	}

	// ── Public methods ───────────────────────────────────────────────────

	/**
	 * Register a new user with username and password.
	 *
	 * When `codeDelivery` is configured, the user is created in an unconfirmed
	 * state and a verification code is sent. Call `confirmSignUp()` to confirm.
	 *
	 * When `codeDelivery` is not configured, the user is immediately confirmed.
	 *
	 * @param username - Unique username (typically email)
	 * @param password - Plain text password (will be hashed; must satisfy password policy)
	 * @throws {AuthBasicErrors.UserAlreadyExists} If the username is already taken.
	 * @throws {AuthBasicErrors.InvalidPassword} If the password does not satisfy the password policy.
	 */
	async signUp(username: string, password: string): Promise<void> {
		this.validatePassword(password);
		const hash = await bcrypt.hash(password, BCRYPT_COST);
		const record: UserRecord = {
			hash,
			createdAt: new Date().toISOString(),
			...(this.codeDelivery ? { unconfirmed: true } : {}),
		};
		try {
			await this.users.put(username, JSON.stringify(record), { ifNotExists: true });
		} catch {
			throw new ApiError('Username already exists', 409, { name: AuthBasicErrors.UserAlreadyExists });
		}
		// Failed sign-ins against a not-yet-registered username leave a lockout
		// counter behind (we deliberately count absent users to avoid an
		// enumeration oracle). Clear it on successful registration so the real
		// owner of the name isn't locked out on their first sign-in.
		await this.clearLockout(username);
		if (this.codeDelivery) {
			const code = await this.generateCode('signup', username);
			await this.codeDelivery(username, code);
		}
	}

	/**
	 * Confirm a new user's signup with a verification code.
	 * Only applicable when `codeDelivery` is configured.
	 *
	 * @param username - The username to confirm.
	 * @param code - The 6-digit verification code.
	 * @throws {AuthBasicErrors.InvalidCode} If the code is invalid or expired.
	 */
	async confirmSignUp(username: string, code: string): Promise<void> {
		await this.verifyCode('signup', username, code);
		const record = await this.getUserRecord(username);
		if (!record) throw new ApiError('Invalid or expired code', 400, { name: AuthBasicErrors.InvalidCode });
		delete record.unconfirmed;
		await this.users.put(username, JSON.stringify(record));
	}

	/**
	 * Authenticate a user and establish a session.
	 *
	 * @param username - Username to authenticate.
	 * @param password - Plain text password to verify.
	 * @param context - The request context (used to set session cookie).
	 * @returns The authenticated user.
	 * @throws {AuthBasicErrors.InvalidCredentials} If the username or password is incorrect, or user is unconfirmed.
	 * @throws {AuthBasicErrors.AccountLocked} If sign-in throttling is enabled and the account is currently locked out after too many failed attempts.
	 */
	async signIn(username: string, password: string, context: BlocksContext): Promise<AuthBasicUser> {
		// Enforce the lockout BEFORE touching the user record or comparing the
		// password: a locked account sheds the bcrypt cost under a brute-force
		// attack, and the lock decision is independent of whether the password is
		// right (no timing oracle). A no-op when throttling is disabled.
		await this.assertNotLockedOut(username);
		const record = await this.getUserRecord(username);
		if (!record || record.unconfirmed) {
			// Count the failure before throwing so repeated attempts against an
			// existing-but-unconfirmed (or absent) username still trip the lock.
			await this.recordFailedSignIn(username);
			throw new ApiError('Invalid username or password', 401, { name: AuthBasicErrors.InvalidCredentials });
		}
		const valid = await bcrypt.compare(password, record.hash);
		if (!valid) {
			await this.recordFailedSignIn(username);
			throw new ApiError('Invalid username or password', 401, { name: AuthBasicErrors.InvalidCredentials });
		}
		// Success: clear any accumulated failure count so the user starts fresh.
		await this.clearLockout(username);
		await this.setCookie(context, username);
		return this.toAuthBasicUser(username, record);
	}

	/**
	 * End the current session: revoke the presented token server-side (so it is
	 * rejected even if the cookie is replayed) and clear the session cookie.
	 *
	 * Revocation records the token's `jti` in the `codes` store under a
	 * `revoked:` prefix, with an expiry equal to the token's own `exp` — so the
	 * entry self-expires exactly when the token would have, and the revocation
	 * list never grows unbounded. A request with no valid cookie just clears
	 * (nothing to revoke).
	 *
	 * The local cookie is ALWAYS cleared (in `finally`), so sign-out on this
	 * device never leaves the user stuck signed in — even if the server-side
	 * revocation write fails. If that write does fail (e.g. a DynamoDB throttle),
	 * this throws a stable `SignOutIncompleteException` (503) so the caller can
	 * surface or retry: the token was NOT revoked, so a replayed copy keeps
	 * authenticating until `exp`. The raw SDK error is logged, never thrown — it
	 * would leak `$metadata`/ARNs to the client otherwise.
	 */
	async signOut(context: BlocksContext): Promise<void> {
		try {
			await this.revokeCurrentToken(context);
		} finally {
			this.clearCookie(context);
		}
	}

	/**
	 * Initiate a password reset. Only available when `codeDelivery` is configured.
	 * Silently succeeds for non-existent users (don't reveal user existence).
	 *
	 * @param username - The username requesting the reset.
	 */
	async resetPassword(username: string): Promise<void> {
		if (!this.codeDelivery) throw new ApiError('Password reset not configured', 400);
		const record = await this.getUserRecord(username);
		if (!record) return;
		const code = await this.generateCode('reset', username);
		await this.codeDelivery(username, code);
	}

	/**
	 * Complete a password reset with the verification code.
	 *
	 * @param username - The username.
	 * @param code - The 6-digit verification code.
	 * @param newPassword - The new password (must satisfy password policy).
	 * @throws {AuthBasicErrors.InvalidCode} If the code is invalid or expired.
	 * @throws {AuthBasicErrors.InvalidPassword} If the new password does not satisfy the password policy.
	 */
	async confirmResetPassword(username: string, code: string, newPassword: string): Promise<void> {
		await this.verifyCode('reset', username, code);
		this.validatePassword(newPassword);
		const record = await this.getUserRecord(username);
		if (!record) throw new ApiError('Invalid or expired code', 400, { name: AuthBasicErrors.InvalidCode });
		record.hash = await bcrypt.hash(newPassword, BCRYPT_COST);
		await this.users.put(username, JSON.stringify(record));
	}

	// ── Cookie management ────────────────────────────────────────────────

	private async setCookie(context: BlocksContext, username: string): Promise<void> {
		const secret = await this.getSecret();
		// `jwtid` stamps a unique `jti` claim on the token so sign-out can revoke
		// this specific session server-side (see `signOut` / `isRevoked`).
		const token = jwt.sign({ username }, secret, {
			expiresIn: this.sessionDuration,
			issuer: `bb-auth-basic:${this.fullId}`,
			subject: username,
			jwtid: crypto.randomUUID(),
		});
		const cookieName = `auth_${this.fullId}`;
		const security = buildCookieSecurityAttrs({
			crossDomain: this.crossDomain,
			isLocalhost: isLoopbackRequest(context),
		});
		context.response.headers.set(
			'Set-Cookie',
			`${cookieName}=${token}; HttpOnly; ${security}; Max-Age=${this.sessionDuration}; Path=/`,
		);
	}

	private clearCookie(context: BlocksContext): void {
		const cookieName = `auth_${this.fullId}`;
		const security = buildCookieSecurityAttrs({
			crossDomain: this.crossDomain,
			isLocalhost: isLoopbackRequest(context),
		});
		context.response.headers.set('Set-Cookie', `${cookieName}=; Max-Age=0; Path=/; ${security}`);
	}

	/**
	 * Parse and verify the session token from the request cookie, returning its
	 * payload or `null` when the cookie is absent, malformed, expired, or forged.
	 * This is the single place the cookie name, HS256 algorithm, and issuer are
	 * spelled out, so `resolveSession` and `revokeCurrentToken` share one
	 * parse/verify definition instead of each recomputing it.
	 *
	 * A verified token with no `exp` is rejected (treated as absent): a token
	 * this BB issues always carries `exp`, and a token that never naturally
	 * expires could outlive its own revocation marker (the marker self-expires
	 * at the token's `exp`), so a replay could re-authenticate after the marker
	 * is reaped. Requiring `exp` keeps every token's revocation bounded.
	 */
	private async parseSessionToken(
		context: BlocksContext,
	): Promise<{ username: string; jti?: string; exp: number } | null> {
		const secret = await this.getSecret();
		const cookieName = `auth_${this.fullId}`;
		const cookies = context.request.headers.get('cookie') || '';
		const match = cookies.match(new RegExp(`${cookieName}=([^;]+)`));
		if (!match) return null;
		try {
			const payload = jwt.verify(match[1], secret, {
				algorithms: ['HS256'],
				issuer: `bb-auth-basic:${this.fullId}`,
			}) as { username: string; jti?: string; exp?: number };
			if (typeof payload.exp !== 'number') return null;
			return { username: payload.username, jti: payload.jti, exp: payload.exp };
		} catch {
			return null;
		}
	}

	/**
	 * Resolve the session from the request cookie in ONE pass, returning both the
	 * user (or null) and, when null, WHY — so `requireAuth` can pick the right
	 * error name without a second `jwt.verify` + revocation-list read. `revoked`
	 * means a valid, unexpired token whose `jti` was revoked at sign-out;
	 * `absent` covers no cookie, a malformed/expired token, or an unknown user.
	 */
	private async resolveSession(
		context: BlocksContext,
	): Promise<{ user: AuthBasicUser } | { user: null; reason: 'absent' | 'revoked' }> {
		const payload = await this.parseSessionToken(context);
		if (!payload) return { user: null, reason: 'absent' };
		// The revocation check and the user-record lookup don't depend on each
		// other, so run them concurrently — an authenticated request stays at a
		// single round trip rather than two sequential reads.
		const [revoked, record] = await Promise.all([
			payload.jti ? this.isRevoked(payload.jti) : false,
			this.getUserRecord(payload.username),
		]);
		// A token whose jti was revoked at sign-out is rejected even though it
		// is still cryptographically valid and unexpired.
		if (revoked) return { user: null, reason: 'revoked' };
		if (!record || record.unconfirmed) return { user: null, reason: 'absent' };
		return { user: this.toAuthBasicUser(payload.username, record) };
	}

	private async getUserFromCookie(context: BlocksContext): Promise<AuthBasicUser | null> {
		return (await this.resolveSession(context)).user;
	}

	// ── Session revocation ───────────────────────────────────────────────

	/** Revocation-list key for a token id. Stored in the shared `codes` store. */
	private revokedKey(jti: string): string {
		return `revoked:${jti}`;
	}

	/**
	 * Record the currently-presented token's `jti` on the revocation list until
	 * the token's own expiry. A no-op when the cookie is missing, malformed, or
	 * carries no `jti` (there is nothing to revoke).
	 */
	private async revokeCurrentToken(context: BlocksContext): Promise<void> {
		// A missing/malformed/expired/forged cookie is a benign "nothing to
		// revoke" (parseSessionToken returns null). This is kept separate from the
		// revocation write below, so an infrastructure failure of that write is
		// never mistaken for it.
		const payload = await this.parseSessionToken(context);
		if (!payload?.jti) return;

		// Expire the revocation entry exactly when the token would have expired
		// (`exp` is Unix epoch seconds), so the list self-trims and never grows
		// unbounded. `parseSessionToken` guarantees `exp` is present (an exp-less
		// token is rejected there), so the marker can never outlive the token.
		const expiresAt = payload.exp;

		// The write is the security-relevant step: if it fails (e.g. a DynamoDB
		// throttle/5xx), the token was NOT revoked and a replayed copy keeps
		// authenticating until `exp`. Throw a STABLE branded error rather than the
		// raw SDK error (which carries $metadata/ARNs and would leak to the client
		// via the state-machine catch) — the caller can surface or retry.
		try {
			await this.codes.put(this.revokedKey(payload.jti), REVOKED_MARKER, { expiresAt });
		} catch (e) {
			this.log.error('AuthBasic: failed to record session revocation on sign-out', { error: e });
			throw new ApiError('Sign-out could not be completed; please retry', 503, {
				name: AuthBasicErrors.SignOutIncomplete,
			});
		}
	}

	/**
	 * True when a token id is on the revocation list (and not yet expired off it).
	 * Asserts the stored marker value so a future `revoked:`-prefixed writer with
	 * a different value can't silently widen what counts as revoked — only the
	 * literal `REVOKED_MARKER` written by `revokeCurrentToken` is honored.
	 */
	private async isRevoked(jti: string): Promise<boolean> {
		return (await this.codes.get(this.revokedKey(jti))) === REVOKED_MARKER;
	}

	// ── Sign-in throttling / account lockout ─────────────────────────────

	/** Lockout-counter key for a username. Stored in the shared `codes` store. */
	private lockoutKey(username: string): string {
		return `lockout:${username}`;
	}

	/**
	 * Read the current lockout record for a username, or `null` when none exists
	 * or throttling is disabled. `count` is the running consecutive-failure
	 * count; `firstFailAt` is the epoch-ms of the first failure anchoring the
	 * fixed counting window; `lockedAt` is the epoch-ms at which the count first reached
	 * `maxAttempts` (absent until the lock trips) and is what the lockout window
	 * is measured from.
	 */
	private async readLockout(
		username: string,
	): Promise<{ count: number; firstFailAt: number; lockedAt?: number } | null> {
		const raw = await this.codes.get(this.lockoutKey(username));
		if (!raw) return null;
		try {
			const parsed = JSON.parse(raw) as { count: number; firstFailAt: number; lockedAt?: number };
			if (typeof parsed.count !== 'number' || typeof parsed.firstFailAt !== 'number') return null;
			return parsed;
		} catch {
			return null;
		}
	}

	/**
	 * Throw {@link AuthBasicErrors.AccountLocked} (429) when `username` is
	 * currently locked out. Called at the TOP of `signIn` — before the user
	 * record is read or the password is compared — so a locked account sheds the
	 * bcrypt cost under a brute-force attack and the lock decision carries no
	 * password-dependent timing signal. A no-op when throttling is disabled.
	 *
	 * An account is locked when its failure count has reached `maxAttempts` and
	 * the lockout window (measured from `lockedAt`, the moment the threshold was
	 * reached) has not yet elapsed. The counter row's TTL also reaps it, but
	 * reads don't depend on the reaper.
	 */
	private async assertNotLockedOut(username: string): Promise<void> {
		if (!this.lockout) return;
		const record = await this.readLockout(username);
		if (!record) return;
		if (record.count < this.lockout.maxAttempts) return;
		// Anchor the lockout window on when the threshold was reached (`lockedAt`),
		// not on the first failure — otherwise failures spaced across the counting
		// window would trip a lock that expires almost immediately. Fall back to
		// `firstFailAt` for a legacy row written before `lockedAt` existed.
		const lockedAt = record.lockedAt ?? record.firstFailAt;
		const lockExpiresAt = lockedAt + this.lockout.lockoutSeconds * 1000;
		if (Date.now() < lockExpiresAt) {
			throw new ApiError('Too many failed sign-in attempts; try again later', 429, {
				name: AuthBasicErrors.AccountLocked,
			});
		}
	}

	/**
	 * Record one failed sign-in for `username`, incrementing the running count.
	 * A failure older than `windowSeconds` starts a fresh window (count resets to
	 * 1). When the count reaches `maxAttempts` the failure that trips the lock
	 * stamps `lockedAt`, which the lockout window is measured from (a later
	 * failure inside the window preserves the original `lockedAt`). The counter
	 * row's TTL is set to the longer of the counting window and the lockout
	 * window, so a tripped lock survives long enough to be enforced and an
	 * untripped counter still self-expires. A no-op when throttling is disabled.
	 * Best-effort: a write failure is logged, never thrown — a throttle
	 * bookkeeping hiccup must not convert a failed sign-in into a 5xx.
	 */
	private async recordFailedSignIn(username: string): Promise<void> {
		if (!this.lockout) return;
		const now = Date.now();
		const existing = await this.readLockout(username);
		const windowMs = this.lockout.windowSeconds * 1000;
		const withinWindow = existing !== null && now - existing.firstFailAt < windowMs;
		const next: { count: number; firstFailAt: number; lockedAt?: number } = withinWindow
			? { count: existing.count + 1, firstFailAt: existing.firstFailAt, lockedAt: existing.lockedAt }
			: { count: 1, firstFailAt: now };
		// Stamp the moment the lock trips (count first reaches the threshold) so
		// the lockout window is measured from the trip, not from the first
		// failure. Preserve an existing stamp on later failures inside the window.
		if (next.count >= this.lockout.maxAttempts && next.lockedAt === undefined) {
			next.lockedAt = now;
		}
		// Expire the row after whichever window is longer so a tripped lock is
		// enforced for its full duration and a counter that never trips still
		// self-reaps once counting lapses. `ttlSeconds` (a relative duration) is
		// intentional here — the other `codes` writes pass an absolute
		// `expiresAt`, but a duration reads clearer for a rolling counter.
		const ttlSeconds = Math.max(this.lockout.windowSeconds, this.lockout.lockoutSeconds);
		try {
			await this.codes.put(this.lockoutKey(username), JSON.stringify(next), { ttlSeconds });
		} catch (e) {
			this.log.error('AuthBasic: failed to record sign-in throttle counter', { error: e });
		}
	}

	/**
	 * Clear a username's lockout counter after a successful sign-in, so a user
	 * who eventually gets their password right starts fresh. A no-op when
	 * throttling is disabled or no counter exists. Best-effort: a failed clear is
	 * logged, never thrown (the sign-in already succeeded).
	 */
	private async clearLockout(username: string): Promise<void> {
		if (!this.lockout) return;
		try {
			await this.codes.delete(this.lockoutKey(username));
		} catch (e) {
			this.log.error('AuthBasic: failed to clear sign-in throttle counter', { error: e });
		}
	}

	// ── BlocksAuth interface ────────────────────────────────────────────────

	async requireAuth(context: BlocksContext): Promise<AuthBasicUser> {
		const session = await this.resolveSession(context);
		if (!session.user) {
			// One pass already told us WHY: a revoked (signed-out) session reports
			// SessionRevoked; an absent or aged-out one reports SessionExpired.
			const name = session.reason === 'revoked' ? AuthBasicErrors.SessionRevoked : AuthBasicErrors.SessionExpired;
			throw new ApiError('Authentication required', 401, { name });
		}
		return session.user;
	}

	async checkAuth(context: BlocksContext): Promise<boolean> {
		return (await this.getUserFromCookie(context)) !== null;
	}

	async getCurrentUser(context: BlocksContext): Promise<AuthBasicUser | null> {
		return this.getUserFromCookie(context);
	}

	// ── State machine API ────────────────────────────────────────────────

	createApi() {
		return new ApiNamespace(this, 'auth', (context) => ({
			getAuthState: async (): Promise<AuthState> => {
				const user = await this.getUserFromCookie(context);
				if (user) return signedInState(user);
				return this.signedOutState();
			},
			setAuthState: async (input: AuthActionInput): Promise<AuthState> => {
				try {
					switch (input.action) {
						case 'signIn': {
							const user = await this.signIn(input.username, input.password, context);
							return signedInState(user);
						}
						case 'signUp': {
							await this.signUp(input.username, input.password);
							if (this.codeDelivery) {
								return confirmingSignUpState(input.username);
							}
							const user = await this.signIn(input.username, input.password, context);
							return signedInState(user);
						}
						case 'confirmSignUp': {
							await this.confirmSignUp(input.username, input.code);
							// AuthBasic re-authenticates after confirmation, so it
							// requires `password` here even though the common map
							// makes it optional (Cognito doesn't need it).
							if (!input.password) {
								throw new ApiError('Password required to complete confirmSignUp', 400);
							}
							const user = await this.signIn(input.username, input.password, context);
							return signedInState(user);
						}
						case 'signOut': {
							await this.signOut(context);
							return this.signedOutState();
						}
						case 'resetPassword': {
							await this.resetPassword(input.username);
							return confirmingPasswordResetState(input.username);
						}
						case 'confirmResetPassword': {
							await this.confirmResetPassword(input.username, input.code, input.newPassword);
							return this.signedOutState();
						}
						default:
							return { ...this.signedOutState(), error: `Unknown action: ${(input as any).action}` };
					}
				} catch (e: any) {
					// A signOut always clears the cookie (via its finally), so the
					// session is gone even when the revocation write failed — report
					// signed-out rather than the still-valid request cookie's signedIn.
					const currentUser = input.action === 'signOut' ? null : await this.getUserFromCookie(context);
					const base = currentUser ? signedInState(currentUser) : this.signedOutState();
					// Surface the message only for a wire-safe error (an ApiError, or a
					// BB error branded via blocksError) — a raw SDK/driver error's
					// message can carry $metadata/ARNs, so it gets a generic message,
					// never echoed. The name crosses the wire only when it is an
					// intentional, non-default BB error constant.
					const errorMessage = isWireSafeError(e) ? e.message : 'An unexpected error occurred';
					const errorName = e instanceof ApiError && e.name !== DEFAULT_API_ERROR_NAME ? e.name : undefined;
					return { ...base, error: errorMessage, ...(errorName ? { errorName } : {}) };
				}
			},
		}));
	}

	/**
	 * @deprecated Use `createApi()` instead. Retained for backward compatibility.
	 */
	buildApi() {
		return new ApiNamespace(this, 'auth', (context) => ({
			signUp: async (username: string, password: string) => {
				await this.signUp(username, password);
				if (!this.codeDelivery) await this.setCookie(context, username);
				return { username };
			},
			signIn: async (username: string, password: string) => {
				const user = await this.signIn(username, password, context);
				return { username: user.username };
			},
			signOut: async () => {
				await this.signOut(context);
				return { success: true };
			},
			getCurrentUser: async () => {
				return await this.getUserFromCookie(context);
			},
		}));
	}

	// ── State factory (instance method because it depends on codeDelivery) ─

	private signedOutState(): AuthState {
		const actions: AuthState['actions'] = [
			{
				name: 'signIn',
				label: 'Sign In',
				fields: [
					{ name: 'username', label: 'Username', type: 'text', required: true },
					{ name: 'password', label: 'Password', type: 'password', required: true },
				],
			},
			{
				name: 'signUp',
				label: 'Create Account',
				fields: [
					{ name: 'username', label: 'Username', type: 'text', required: true },
					{ name: 'password', label: 'Password', type: 'password', required: true },
				],
			},
		];
		if (this.codeDelivery) {
			actions.push({
				name: 'resetPassword',
				label: 'Forgot Password',
				fields: [{ name: 'username', label: 'Username', type: 'text', required: true }],
			});
		}
		return { state: 'signedOut', actions };
	}
}

// --- Static state factories ---

function signedInState(user: AuthBasicUser): AuthState {
	return {
		state: 'signedIn',
		user,
		actions: [{ name: 'signOut', label: 'Sign Out', fields: [] }],
	};
}

function confirmingSignUpState(username?: string): AuthState {
	return {
		state: 'confirmingSignUp',
		actions: [
			{
				name: 'confirmSignUp',
				label: 'Confirm Account',
				fields: [
					// Echo the just-entered username as a hidden field (mirrors
					// bb-auth-cognito) so the confirm form carries it on submit
					// instead of rendering a blank box the user must retype.
					{ name: 'username', label: 'Username', type: 'hidden', required: true, defaultValue: username },
					{ name: 'code', label: 'Verification Code', type: 'text', required: true },
					{ name: 'password', label: 'Password', type: 'password', required: true },
				],
			},
		],
	};
}

function confirmingPasswordResetState(username?: string): AuthState {
	return {
		state: 'confirmingPasswordReset',
		actions: [
			{
				name: 'confirmResetPassword',
				label: 'Reset Password',
				fields: [
					// Echo the just-entered username (hidden) so the reset-confirm
					// form carries it on submit rather than a blank retype box.
					{ name: 'username', label: 'Username', type: 'hidden', required: true, defaultValue: username },
					{ name: 'code', label: 'Reset Code', type: 'text', required: true },
					{ name: 'newPassword', label: 'New Password', type: 'password', required: true },
				],
			},
		],
	};
}
