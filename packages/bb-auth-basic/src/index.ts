// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Scope, type ScopeParent, type BlocksContext, ApiNamespace, ApiError } from '@aws-blocks/core';
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

export type { BlocksAuth, AuthUser, AuthState, AuthActionInput } from '@aws-blocks/auth-common';
export type { AuthAction, AuthField } from '@aws-blocks/auth-common';

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
	/** Optional logger for internal operations. When omitted, a default Logger at error level is created. */
	logger?: ChildLogger;
}

/**
 * Error constants for AuthBasic. Use with `isBlocksError()` for typed error handling.
 *
 * @example
 * ```typescript
 * import { isBlocksError } from '@aws-blocks/core';
 * import { AuthBasicErrors } from '@aws-blocks/bb-auth-basic';
 *
 * try {
 *   await auth.signIn('alice', 'wrong', context);
 * } catch (e) {
 *   if (isBlocksError(e, AuthBasicErrors.InvalidCredentials)) {
 *     // handle bad credentials
 *   }
 * }
 * ```
 */
export const AuthBasicErrors = {
	InvalidCredentials: 'InvalidCredentialsException',
	UserAlreadyExists: 'UserAlreadyExistsException',
	InvalidCode: 'InvalidCodeException',
	SessionExpired: 'SessionExpiredException',
	InvalidPassword: 'InvalidPasswordException',
} as const;

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
	/** Optional logger for internal operations. When omitted, a default Logger at error level is created. */
	logger?: ChildLogger;

	/** @internal Logger for internal operations. Defaults to error-level when not provided. */
	protected log: ChildLogger;

	constructor(scope: ScopeParent, id: string, options?: AuthBasicOptions) {
		super(id, { parent: scope });
		this.log = options?.logger ?? new Logger(this, 'logger', { level: 'error' });
		this.users = new KVStore(this, 'users');
		this.jwtSecret = new AppSetting(this, 'jwt-secret', { secret: true });
		this.codes = new KVStore(this, 'codes');
		this.sessionDuration = options?.sessionDuration ?? 86400;
		this.passwordPolicy = options?.passwordPolicy ?? {};
		this.codeDelivery = options?.codeDelivery;
		this.crossDomain = options?.crossDomain ?? false;
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
		await this.codes.put(`${purpose}:${username}`, JSON.stringify({ hmac, expires: Date.now() + CODE_TTL * 1000 }));
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
	 */
	async signIn(username: string, password: string, context: BlocksContext): Promise<AuthBasicUser> {
		const record = await this.getUserRecord(username);
		if (!record || record.unconfirmed) {
			throw new ApiError('Invalid username or password', 401, { name: AuthBasicErrors.InvalidCredentials });
		}
		const valid = await bcrypt.compare(password, record.hash);
		if (!valid) {
			throw new ApiError('Invalid username or password', 401, { name: AuthBasicErrors.InvalidCredentials });
		}
		await this.setCookie(context, username);
		return this.toAuthBasicUser(username, record);
	}

	/**
	 * End the current session and clear the session cookie.
	 */
	async signOut(context: BlocksContext): Promise<void> {
		this.clearCookie(context);
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
		const token = jwt.sign({ username }, secret, { expiresIn: this.sessionDuration, issuer: `bb-auth-basic:${this.fullId}`, subject: username });
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

	private async getUserFromCookie(context: BlocksContext): Promise<AuthBasicUser | null> {
		const secret = await this.getSecret();
		const cookieName = `auth_${this.fullId}`;
		const cookies = context.request.headers.get('cookie') || '';
		const match = cookies.match(new RegExp(`${cookieName}=([^;]+)`));
		if (!match) return null;
		try {
			const payload = jwt.verify(match[1], secret, { algorithms: ['HS256'], issuer: `bb-auth-basic:${this.fullId}` }) as { username: string };
			const record = await this.getUserRecord(payload.username);
			if (!record || record.unconfirmed) return null;
			return this.toAuthBasicUser(payload.username, record);
		} catch {
			return null;
		}
	}

	// ── BlocksAuth interface ────────────────────────────────────────────────

	async requireAuth(context: BlocksContext): Promise<AuthBasicUser> {
		const user = await this.getUserFromCookie(context);
		if (!user) throw new ApiError('Authentication required', 401, { name: AuthBasicErrors.SessionExpired });
		return user;
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
								return confirmingSignUpState();
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
							return confirmingPasswordResetState();
						}
						case 'confirmResetPassword': {
							await this.confirmResetPassword(input.username, input.code, input.newPassword);
							return this.signedOutState();
						}
						default:
							return { ...this.signedOutState(), error: `Unknown action: ${(input as any).action}` };
					}
				} catch (e: any) {
					const currentUser = await this.getUserFromCookie(context);
					const base = currentUser ? signedInState(currentUser) : this.signedOutState();
					const errorName = e instanceof ApiError && e.name && e.name !== 'ApiError' ? e.name : undefined;
					return { ...base, error: e.message, ...(errorName ? { errorName } : {}) };
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

function confirmingSignUpState(): AuthState {
	return {
		state: 'confirmingSignUp',
		actions: [
			{
				name: 'confirmSignUp',
				label: 'Confirm Account',
				fields: [
					{ name: 'username', label: 'Username', type: 'text', required: true },
					{ name: 'code', label: 'Verification Code', type: 'text', required: true },
					{ name: 'password', label: 'Password', type: 'password', required: true },
				],
			},
		],
	};
}

function confirmingPasswordResetState(): AuthState {
	return {
		state: 'confirmingPasswordReset',
		actions: [
			{
				name: 'confirmResetPassword',
				label: 'Reset Password',
				fields: [
					{ name: 'username', label: 'Username', type: 'text', required: true },
					{ name: 'code', label: 'Reset Code', type: 'text', required: true },
					{ name: 'newPassword', label: 'New Password', type: 'password', required: true },
				],
			},
		],
	};
}
