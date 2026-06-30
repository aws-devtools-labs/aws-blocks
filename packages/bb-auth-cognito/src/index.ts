// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * @aws-blocks/bb-auth-cognito — mock entry.
 *
 * In-memory implementation of the AuthCognito public API, persisted to
 * `.bb-data/<fullId>/users.json` via `getMockDataDir()`. Same class shape
 * as the AWS runtime; the only difference is this one never calls Cognito.
 */

import crypto from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	ApiError,
	ApiNamespace,
	DEFAULT_API_ERROR_NAME,
	Scope,
	registerSdkIdentifiers,
} from '@aws-blocks/core';
import { getMockDataDir } from '@aws-blocks/core/bb-utils';
import type { BlocksContext, ScopeParent } from '@aws-blocks/core';
import type { AuthActionInput, AuthState, AuthStateApi, BlocksAuth } from '@aws-blocks/auth-common';
import { decodeIdToken, decodeJwtPayload, jwtExpMs, safeStringClaim, sessionToTokens, SessionStore, type SessionRecord } from './sessions.js';
import {
	clearAutoSignInCookie,
	clearSessionCookie,
	decryptAutoSignInPayload,
	encryptAutoSignInPayload,
	readAutoSignInCookie,
	readSessionCookie,
	setAutoSignInCookie,
	setSessionCookie,
	signSessionId,
	verifySessionId,
} from './cookies.js';
import {
	confirmingPasswordReset,
	confirmingSignIn,
	confirmingSignUp,
	isStandardAttribute,
	managingPasskeys,
	registeringPasskey,
	signedIn as signedInState,
	signedOut,
} from './state-machine.js';
import {
	AuthCognitoErrors,
	isRetriableAuthError,
	makeExternalUserPoolRef,
	type AdminCreateInit,
	type AdminGetterOf,
	type AdminUser,
	type GroupAdmin,
	type LifecycleAdmin,
	type AuthCognitoOptions,
	type AuthCognitoMockOptions,
	type AttrOf,
	type AuthSession,
	type CodeDeliveryDetails,
	type CognitoUser,
	type ConfirmSignInOptions,
	type ConfirmSignInResponse,
	type DeviceRecord,
	type CompletePasskeyRegistrationResult,
	type PasskeyDescription,
	type StartPasskeyRegistrationResult,
	type FetchAuthSessionOptions,
	type GroupOf,
	type MFAPreference,
	type MFAPreferenceInput,
	type MFASetting,
	type PasswordPolicy,
	type ReadAttrOf,
	type ResetPasswordResult,
	type SignInNextStep,
	type SignInOptions,
	type SignInResult,
	type SignUpOptions,
	type ConfirmSignUpResult,
	type SignUpResult,
	type UpdateAttributeOutcome,
} from './types.js';
import { Logger } from '@aws-blocks/bb-logger';
import type { ChildLogger } from '@aws-blocks/bb-logger';
import { BB_NAME, BB_VERSION } from './version.js';

export * from './types.js';
export { SessionStore, type SessionRecord } from './sessions.js';

// ─────────────────────────────────────────────────────────────────────────────
// Internal record shapes + constants
// ─────────────────────────────────────────────────────────────────────────────

/** Verification-code TTL in seconds. */
const CODE_TTL_SECONDS = 600;

/**
 * Default session-cookie lifetime — 400 days, matching the AWS runtime.
 * The cookie is a pointer to a server-side session record; `getCurrentUser`
 * revalidates the record on each request. Overridable via
 * `AuthCognitoOptions.sessionTtlSeconds`.
 */
const DEFAULT_SESSION_TTL_SECONDS = 400 * 86400;

/** Local alias: the full Cognito MFA factor union. */
type MfaFactor = 'SMS' | 'TOTP' | 'EMAIL';

interface MockPasskeyRecord {
	credentialId: string;
	friendlyName?: string;
	createdAt: number;
}

interface MockUserRecord {
	userSub: string;
	password: string; // plain-text: mock-only; documented in DESIGN.md
	confirmed: boolean;
	disabled: boolean;
	/** `email`, `phone_number`, `custom:department`, … (stored as Cognito would store them). */
	attributes: Record<string, string>;
	mfaPreference: MFAPreference;
	totpSharedSecret?: string;
	totpVerified: boolean;
	devices: Record<string, DeviceRecord>;
	/**
	 * Registered passkeys (mock-side). The mock does not run cose-key
	 * signature verification on assertions — `confirmSignIn` accepts any
	 * well-formed WebAuthn JSON whose `id` matches a registered
	 * `credentialId` (the design doc calls this the "loose mock" path,
	 * deliberately chosen to avoid a runtime dep on `@simplewebauthn/server`).
	 */
	passkeys?: MockPasskeyRecord[];
}

interface CodeRecord {
	code: string;
	exp: number;
}

/** Pending sign-in challenge state. Keyed by mock "session" token echoed to client. */
interface ChallengeRecord {
	username: string;
	step: SignInNextStep['name'];
	/** Present on TOTP-setup challenge. */
	sharedSecret?: string;
	/**
	 * `true` when this EMAIL_CODE challenge was spawned by an EMAIL_SETUP
	 * enrollment (vs. a sign-in of a user already enrolled in EMAIL MFA).
	 * On successful code verification the completion path also marks EMAIL
	 * as enabled in the user's MFA preferences.
	 */
	isEmailSetup?: boolean;
	/**
	 * `'USER_AUTH'` when this challenge is part of a USER_AUTH sign-in. Lets
	 * the mock issue the USER_AUTH-specific next-step names
	 * (`CONFIRM_SIGN_IN_WITH_FIRST_FACTOR_*`) instead of the MFA variants
	 * and validate follow-ups through the USER_AUTH completion path.
	 */
	flow?: 'USER_AUTH';
	exp: number;
}

interface PersistedState {
	users: Record<string, MockUserRecord>;
	groups: Record<string, string[]>;
	codes: Record<string, CodeRecord>;
	/**
	 * In-flight sign-in challenges keyed by client-echoed session token.
	 * Persisted so a dev-server restart mid-MFA doesn't silently invalidate
	 * every active challenge (the user would see "session expired" with no
	 * explanation). Expired entries are naturally filtered by `exp` in
	 * `confirmSignIn`.
	 */
	challenges: Record<string, ChallengeRecord>;
	sessionSecret: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// AuthCognito (mock)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Cognito authentication — username/password + MFA + groups.
 *
 * **When to use:** Auth with MFA, user groups, and custom attributes on top
 * of AWS Cognito. For simple username/password without Cognito, use
 * `AuthBasic`. For direct OIDC (no Cognito), use `AuthOIDC`.
 *
 * **When NOT to use:** Prototypes or internal tools that don't need MFA
 * (use `AuthBasic`).
 *
 * **Best practices:**
 * - Enable MFA for production (`mfa: 'required'`).
 * - Use groups + `requireRole(context, 'admins')` for RBAC rather than
 *   custom attributes.
 * - Keep custom attributes minimal — prefer application-level storage for
 *   mutable user data.
 *
 * **Scaling:** Cognito scales automatically. Default quotas: 40 sign-ups/sec,
 * 120 sign-ins/sec (adjustable via Service Quotas). Session records live
 * in a nested DynamoDB table provisioned by this BB via KVStore — single-
 * digit ms reads, pay-per-request billing.
 */
export class AuthCognito<const O extends AuthCognitoMockOptions = AuthCognitoMockOptions>
	extends Scope
	implements BlocksAuth
{
	public readonly options: O;
	private readonly sessions: SessionStore;
	private readonly stateFile: string;
	private readonly sessionDuration: number;
	private readonly crossDomain: boolean;
	private state: PersistedState;
	private challenges: Map<string, ChallengeRecord>;
	/**
	 * The full admin surface, built once against the live `this.state`. Typed
	 * against the wide base so the single cast in `get admin()` is the only
	 * place the generic projection is applied. `actions` scoping is a
	 * compile-time concern (the type hides ungranted methods); at runtime
	 * every method exists.
	 */
	private readonly adminSurface: GroupAdmin<AuthCognitoOptions> & LifecycleAdmin<AuthCognitoOptions>;

	/** @internal Logger for internal operations. Defaults to error-level when not provided. */
	protected log: ChildLogger;

	constructor(scope: ScopeParent, id: string, options?: O) {
		super(id, { parent: scope, bbName: BB_NAME, bbVersion: BB_VERSION });
		this.log = options?.logger ?? new Logger(this, 'logger', { level: 'error' });
		// `AuthCognitoMockOptions` has all-optional fields so `{}` is assignable
		// to any concrete `O` the customer passes. TS can't see this because
		// `O` is a generic parameter; the cast is sound by the type bound.
		this.options = (options ?? {}) as O;
		// Mirror the CDK + AWS runtime guard so the mock matches behavior —
		// customers relying on `USER_SRP_AUTH` in local dev would otherwise get
		// a silent pass here and a surprise on deploy.
		if (
			this.options.authFlowType &&
			this.options.authFlowType !== 'USER_PASSWORD_AUTH' &&
			this.options.authFlowType !== 'USER_AUTH'
		) {
			throw new Error(
				`AuthCognito: authFlowType '${this.options.authFlowType}' is not yet supported. Supported: 'USER_PASSWORD_AUTH', 'USER_AUTH'.`,
			);
		}
		this.sessionDuration = this.options.sessionTtlSeconds ?? DEFAULT_SESSION_TTL_SECONDS;
		this.crossDomain = this.options.crossDomain ?? false;
		this.sessions = new SessionStore(this, 'sessions');
		this.stateFile = join(getMockDataDir(this), 'state.json');
		this.state = this.loadFromDisk();
		this.challenges = new Map(Object.entries(this.state.challenges));
		this.seedGroups();
		this.adminSurface = this.buildAdminSurface();
		registerSdkIdentifiers(this.fullId, { userPoolId: `mock-pool-${this.fullId}`, clientId: `mock-client-${this.fullId}` });
	}

	/**
	 * Opt-in server-side admin surface (group membership + user lifecycle).
	 *
	 * Returns `AdminDisabled` (any member access is a compile error) unless the
	 * pool was constructed with an `admin` options object, and throws at
	 * runtime for untyped JS callers that reach past the type system. The set
	 * of methods is narrowed by `admin.actions`; the runtime object always
	 * carries every method (the type hides the ungranted ones).
	 *
	 * Because the mock holds a single in-memory `state`, every admin mutation
	 * is immediately visible to this same instance's `signIn` / `requireRole`.
	 *
	 * @category admin
	 */
	get admin(): AdminGetterOf<O> {
		if (!this.options.admin) {
			throw new Error("admin not enabled: construct AuthCognito with { admin: {} }");
		}
		// The only cast: the concrete surface is typed against the wide base;
		// `AdminGetterOf<O>` is a compile-time projection over `O` that the
		// runtime object cannot express. Consumer-side narrowing is unaffected
		// (verified by admin.types-test.ts).
		return this.adminSurface as AdminGetterOf<O>;
	}

	/**
	 * Build the mock admin surface against the live `this.state`. All mutators
	 * call the existing private `flushToDisk()` so changes persist and are seen
	 * by the next request on this instance.
	 */
	private buildAdminSurface(): GroupAdmin<AuthCognitoOptions> & LifecycleAdmin<AuthCognitoOptions> {
		const requireUser = (username: string): MockUserRecord => {
			const user = this.state.users[username];
			if (!user) {
				throw new ApiError(`User '${username}' not found`, 404, { name: AuthCognitoErrors.UserNotFound });
			}
			return user;
		};
		const requireGroup = (group: string): string[] => {
			const members = this.state.groups[group];
			if (!members) {
				throw new ApiError(`Group '${group}' not found`, 404, { name: AuthCognitoErrors.GroupNotFound });
			}
			return members;
		};
		const toAdminUser = (username: string, user: MockUserRecord): AdminUser => ({
			username,
			userSub: user.userSub,
			enabled: !user.disabled,
			attributes: { ...user.attributes },
			groups: Object.keys(this.state.groups).filter((g) => this.state.groups[g].includes(username)),
		});

		return {
			// ── GroupAdmin ───────────────────────────────────────────────────
			addUserToGroup: async (username, group) => {
				requireUser(username);
				const members = requireGroup(group);
				if (!members.includes(username)) members.push(username);
				this.flushToDisk();
			},
			removeUserFromGroup: async (username, group) => {
				requireUser(username);
				const members = requireGroup(group);
				this.state.groups[group] = members.filter((u) => u !== username);
				this.flushToDisk();
			},
			listGroupsForUser: async (username) => {
				requireUser(username);
				return Object.keys(this.state.groups).filter((g) => this.state.groups[g].includes(username));
			},
			listUsersInGroup: async (group) => {
				const members = requireGroup(group);
				return members.map((u) => toAdminUser(u, requireUser(u)));
			},

			// ── LifecycleAdmin ───────────────────────────────────────────────
			createUser: async (username, init) => {
				if (this.state.users[username]) {
					throw new ApiError('User already exists', 409, { name: AuthCognitoErrors.UserAlreadyExists });
				}
				const password = init?.temporaryPassword ?? this.generateTemporaryPassword();
				this.enforcePasswordPolicy(password);
				const attrs = this.prefixCustomAttrs(init?.attributes);
				const aliasAttr = this.usernameAliasAttr();
				if (aliasAttr && !attrs[aliasAttr]) attrs[aliasAttr] = username;
				const userSub = crypto.randomUUID();
				const record: MockUserRecord & { forcePasswordChange?: boolean } = {
					userSub,
					password,
					confirmed: true,
					disabled: false,
					attributes: attrs,
					mfaPreference: { enabled: [] },
					totpVerified: false,
					devices: {},
					// Admin-created users must change the temp password on first
					// sign-in — mirrors Cognito's FORCE_CHANGE_PASSWORD status.
					forcePasswordChange: true,
				};
				this.state.users[username] = record;
				this.flushToDisk();
				return toAdminUser(username, record);
			},
			deleteUser: async (username) => {
				requireUser(username);
				delete this.state.users[username];
				for (const group of Object.keys(this.state.groups)) {
					this.state.groups[group] = this.state.groups[group].filter((u) => u !== username);
				}
				this.flushToDisk();
			},
			disableUser: async (username) => {
				requireUser(username).disabled = true;
				this.flushToDisk();
			},
			enableUser: async (username) => {
				requireUser(username).disabled = false;
				this.flushToDisk();
			},
			resetUserPassword: async (username) => {
				const user = requireUser(username) as MockUserRecord & { forcePasswordChange?: boolean };
				user.forcePasswordChange = true;
				this.flushToDisk();
			},
			setUserPassword: async (username, password, permanent) => {
				this.enforcePasswordPolicy(password);
				const user = requireUser(username) as MockUserRecord & { forcePasswordChange?: boolean };
				user.password = password;
				if (permanent) {
					delete user.forcePasswordChange;
				} else {
					user.forcePasswordChange = true;
				}
				this.flushToDisk();
			},
			getUser: async (username) => {
				const user = this.state.users[username];
				return user ? toAdminUser(username, user) : null;
			},
			scan: async function* (this: AuthCognito<O>) {
				// Snapshot keys so concurrent mutation during iteration is safe.
				for (const username of Object.keys(this.state.users)) {
					const user = this.state.users[username];
					if (user) yield toAdminUser(username, user);
				}
			}.bind(this),
			revokeUserSessions: async (username) => {
				requireUser(username);
				await this.sessions.deleteByUsername(username);
			},
		};
	}

	/** Generate a policy-compliant temporary password for admin-created users. */
	private generateTemporaryPassword(): string {
		// Always satisfies the default policy (upper/lower/digit/symbol, len ≥ 8).
		return `Aa1!${crypto.randomBytes(9).toString('base64url')}`;
	}

	// ── Framework hooks ────────────────────────────────────────────────────

	/**
	 * Wrap a pre-provisioned Cognito User Pool instead of creating one.
	 * Pass the result via `AuthCognitoOptions.userPool`.
	 */
	static fromExisting = makeExternalUserPoolRef;

	// ─────────────────────────────────────────────────────────────────────
	// Client-facing: sign-up
	// ─────────────────────────────────────────────────────────────────────

	/**
	 * Register a new user.
	 *
	 * @param username - The username (typically email).
	 * @param password - The password; must satisfy `options.passwordPolicy`.
	 * @param options - Custom attributes + client metadata.
	 * @returns `{ isSignUpComplete, userId, nextStep }`. In mock mode,
	 *   `nextStep.name === 'CONFIRM_SIGN_UP'` is returned unless `mfa: 'off'`
	 *   and no required attributes are configured.
	 * @throws {AuthCognitoErrors.UserAlreadyExists} If the username is taken.
	 * @throws {AuthCognitoErrors.InvalidPassword} If the password doesn't satisfy the policy.
	 *
	 * @example
	 * ```typescript
	 * const { isSignUpComplete, nextStep } = await auth.signUp('alice', 'P@ssw0rd!', {
	 *   attributes: { email: 'alice@example.com' },
	 * });
	 * if (!isSignUpComplete) { /* prompt for nextStep.codeDeliveryDetails *\/ }
	 * ```
	 *
	 * @category client
	 */
	async signUp(username: string, password: string, options?: SignUpOptions<O>): Promise<SignUpResult>;
	async signUp(username: string, password: string, options: SignUpOptions<O>, context: BlocksContext): Promise<SignUpResult>;
	async signUp(
		username: string,
		password: string,
		options?: SignUpOptions<O>,
		context?: BlocksContext,
	): Promise<SignUpResult> {
		if (this.state.users[username]) {
			throw new ApiError('User already exists', 409, { name: AuthCognitoErrors.UserAlreadyExists });
		}
		this.enforcePasswordPolicy(password);
		const attrs = this.prefixCustomAttrs(options?.attributes);
		const userSub = crypto.randomUUID();

		// Cognito alias resolution. When the pool is configured with
		// `signInWith` listing `email` or `phone` as a sign-in identifier
		// (CDK side maps that to `UsernameAttributes: ['email']` /
		// `UsernameAttributes: ['phone_number']`), Cognito treats the
		// `username` field as a synthetic copy of that attribute. The mock
		// must mirror this so `signInWith: 'email'` pools work in local
		// dev exactly as they do on AWS — verified end-to-end against
		// real Cognito in `scenarios.passwordless-demo.sandbox.test.ts`
		// (the `control: omitting the explicit email attribute` case).
		const aliasAttr = this.usernameAliasAttr();
		if (aliasAttr && !attrs[aliasAttr]) {
			attrs[aliasAttr] = username;
		}

		// Users always start unconfirmed and must complete the verification-
		// code flow.
		this.state.users[username] = {
			userSub,
			password,
			confirmed: false,
			disabled: false,
			attributes: attrs,
			mfaPreference: { enabled: [] },
			totpVerified: false,
			devices: {},
		};

		const code = await this.generateCode('signUp', username);
		this.flushToDisk();

		// Same auto-sign-in bridging cookie as the AWS runtime. Mock
		// synthesises a fake Cognito Session token so the bridging path
		// behaves identically end-to-end (the mock signIn checks for it
		// and short-circuits the OTP challenge). Without this the mock
		// would diverge from real Cognito for autoSignIn flows: real
		// Cognito skips the OTP via Session, mock would resend it.
		if (options?.autoSignIn && context) {
			const fakeSession = `mock-signup-session-${userSub}`;
			const encrypted = encryptAutoSignInPayload(
				{
					username,
					password,
					cognitoSession: fakeSession,
					exp: Date.now() + 15 * 60 * 1000,
				},
				this.state.sessionSecret,
			);
			setAutoSignInCookie(context, this.fullId, encrypted, 15 * 60, this.crossDomain);
		}

		return {
			isSignUpComplete: false,
			userId: userSub,
			nextStep: {
				name: 'CONFIRM_SIGN_UP',
				codeDeliveryDetails: this.codeDeliveryFor(attrs, code),
			},
		};
	}

	/**
	 * Confirm a new user's sign-up with the code delivered to them.
	 *
	 * @throws {AuthCognitoErrors.UserNotFound}
	 * @throws {AuthCognitoErrors.CodeMismatch}
	 * @throws {AuthCognitoErrors.ExpiredCode}
	 *
	 * @category client
	 */
	async confirmSignUp(username: string, code: string): Promise<ConfirmSignUpResult>;
	async confirmSignUp(username: string, code: string, context: BlocksContext): Promise<ConfirmSignUpResult>;
	async confirmSignUp(
		username: string,
		code: string,
		context?: BlocksContext,
	): Promise<ConfirmSignUpResult> {
		const user = this.requireUser(username);
		this.verifyCode('signUp', username, code);
		user.confirmed = true;
		// Real Cognito marks the delivered attribute (email or phone) as
		// verified when the sign-up code is accepted. Mirror that so Email
		// and SMS MFA can auto-use the contact without a separate setup step.
		if (user.attributes.email) user.attributes.email_verified = 'true';
		if (user.attributes.phone_number) user.attributes.phone_number_verified = 'true';
		this.flushToDisk();

		// Mirror the AWS runtime: peek at the autoSignIn cookie (if the
		// caller passed context) and surface COMPLETE_AUTO_SIGN_IN when
		// the cached username matches.
		let autoSignInPending = false;
		if (context) {
			const cookie = readAutoSignInCookie(context, this.fullId);
			if (cookie) {
				const payload = decryptAutoSignInPayload(cookie, this.state.sessionSecret);
				if (payload && payload.username === username) {
					autoSignInPending = true;
				}
			}
		}
		return {
			isSignUpComplete: true,
			nextStep: {
				signUpStep: autoSignInPending ? 'COMPLETE_AUTO_SIGN_IN' : 'DONE',
			},
		};
	}

	/**
	 * Complete the auto-sign-in bridge — see `index.aws.ts` for the full
	 * contract docstring. Mirror implementation: read the encrypted
	 * cookie, clear it, replay `signIn` with the cached credentials.
	 *
	 * @throws {AuthCognitoErrors.NotAuthenticated} when no bridging cookie
	 *   is present, the cookie is expired/tampered, or the username
	 *   doesn't match an active sign-up flow.
	 *
	 * @category client
	 */
	async autoSignIn(context: BlocksContext): Promise<SignInResult<O>> {
		const cookie = readAutoSignInCookie(context, this.fullId);
		if (!cookie) {
			throw new ApiError(
				'No autoSignIn flow in progress. Call signUp with `{ autoSignIn: true }` and confirmSignUp first.',
				401,
				{ name: AuthCognitoErrors.NotAuthenticated },
			);
		}
		const payload = decryptAutoSignInPayload(cookie, this.state.sessionSecret);
		clearAutoSignInCookie(context, this.fullId, this.crossDomain);
		if (!payload) {
			throw new ApiError(
				'autoSignIn session expired or invalid. Call signIn directly.',
				401,
				{ name: AuthCognitoErrors.NotAuthenticated },
			);
		}
		const password = this.options.authFlowType === 'USER_AUTH'
			? ''
			: (payload.password ?? '');
		// Thread the bridging session — mock's signIn recognises it and
		// short-circuits the OTP challenge, mirroring what real Cognito
		// does with the SignUp-issued Session.
		return this.signIn(payload.username, password, context, {
			...(payload.cognitoSession ? { cognitoSession: payload.cognitoSession } : {}),
		});
	}

	/**
	 * Resend the sign-up verification code.
	 *
	 * @throws {AuthCognitoErrors.UserNotFound}
	 *
	 * @category client
	 */
	async resendSignUpCode(username: string): Promise<void> {
		this.requireUser(username);
		await this.generateCode('signUp', username);
		this.flushToDisk();
	}

	// ─────────────────────────────────────────────────────────────────────
	// Client-facing: sign-in + confirm-sign-in
	// ─────────────────────────────────────────────────────────────────────

	/**
	 * Authenticate a user. Returns `{ status: 'signedIn', user }` on success
	 * (also sets the session cookie), or `{ status: 'continueSignIn', nextStep }`
	 * when a challenge is required (MFA, NEW_PASSWORD_REQUIRED, etc.).
	 *
	 * @throws {AuthCognitoErrors.NotAuthorized} Wrong password.
	 * @throws {AuthCognitoErrors.UserNotConfirmed} User hasn't confirmed sign-up.
	 *
	 * @category client
	 */
	async signIn(
		username: string,
		password: string,
		context: BlocksContext,
		options?: SignInOptions,
	): Promise<SignInResult<O>> {
		const user = this.state.users[username];
		if (!user || user.disabled) {
			throw new ApiError('Incorrect username or password', 401, { name: AuthCognitoErrors.NotAuthorized });
		}

		const authFlow = this.options.authFlowType ?? 'USER_PASSWORD_AUTH';
		if (authFlow !== 'USER_PASSWORD_AUTH' && authFlow !== 'USER_AUTH') {
			throw new ApiError(
				`AuthCognito: authFlowType '${authFlow}' is not yet supported.`,
				501,
				{ name: AuthCognitoErrors.InvalidParameter },
			);
		}

		if (authFlow === 'USER_AUTH') {
			// USER_AUTH: no password here. Either emit a first-factor picker or
			// (when a preferred challenge is set) issue the chosen factor
			// directly. Unlike USER_PASSWORD_AUTH, we do NOT reject on
			// `user.confirmed === false`; a passwordless path may well be the
			// first sign-in attempt after self-registration — Cognito's own
			// USER_AUTH flow would route the unconfirmed user through the
			// confirm-sign-up path, which the caller handles at the state
			// machine layer.
			if (!user.confirmed) {
				throw new ApiError('User not confirmed', 400, { name: AuthCognitoErrors.UserNotConfirmed });
			}
			// autoSignIn bridge: a Cognito Session token from the recent
			// signUp + confirmSignUp round-trip lets Cognito skip the
			// email/SMS-OTP challenge entirely. Mirror that behavior in
			// the mock — issue tokens directly without a second OTP. The
			// mock recognises any `cognitoSession` starting with the
			// signed-up user's sub-prefix (`mock-signup-session-<sub>`).
			if (options?.cognitoSession === `mock-signup-session-${user.userSub}`) {
				await this.issueSession(context, username, user);
				return { status: 'signedIn', user: this.toCognitoUser(username, user) };
			}
			const next = this.firstFactorChallenge(
				username,
				options?.preferredChallenge ?? this.options.preferredChallenge,
			);
			return { status: 'continueSignIn', nextStep: next };
		}

		// USER_PASSWORD_AUTH (classic).
		if (user.password !== password) {
			throw new ApiError('Incorrect username or password', 401, { name: AuthCognitoErrors.NotAuthorized });
		}
		if (!user.confirmed) {
			throw new ApiError('User not confirmed', 400, { name: AuthCognitoErrors.UserNotConfirmed });
		}

		// Admin-created users with a temporary password trip Cognito's
		// NEW_PASSWORD_REQUIRED challenge on first sign-in. The mock
		// mirrors that by checking `forcePasswordChange`; seed it to `true`
		// when simulating an `AdminCreateUser({ Permanent: false })` user.
		if ((user as MockUserRecord & { forcePasswordChange?: boolean }).forcePasswordChange) {
			return {
				status: 'continueSignIn',
				nextStep: this.issueChallenge(username, {
					name: 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED',
					session: '',
				}),
			};
		}

		// Challenge selection (mock — matches Cognito's logic at a high level)
		const challenge = await this.selectSignInChallenge(username, user);
		if (challenge) return { status: 'continueSignIn', nextStep: challenge };

		await this.issueSession(context, username, user);
		return { status: 'signedIn', user: this.toCognitoUser(username, user) };
	}

	/**
	 * Mock-side USER_AUTH first-factor picker. When a `preferredChallenge` is
	 * provided the corresponding challenge is issued directly; otherwise the
	 * available factors (derived from pool config + the user's verified
	 * attributes) are surfaced via `CONTINUE_SIGN_IN_WITH_FIRST_FACTOR_SELECTION`.
	 * Mirrors the AWS runtime's USER_AUTH dispatcher so `setAuthState`
	 * sequences line up in both modes.
	 */
	private firstFactorChallenge(
		username: string,
		preferred: 'PASSWORD' | 'EMAIL_OTP' | 'SMS_OTP' | 'WEB_AUTHN' | undefined,
	): SignInNextStep {
		const user = this.state.users[username]!;
		// USER_AUTH first-factor availability: any verified contact attribute
		// enables its passwordless leg. Pool-level `mfaTypes` drives the
		// post-password MFA prompt, which is a separate concern — we don't
		// gate USER_AUTH's PRIMARY passwordless channel on it. Mirrors what
		// Cognito does when computing `AVAILABLE_CHALLENGES` per user.
		const available: ('PASSWORD' | 'EMAIL_OTP' | 'SMS_OTP' | 'WEB_AUTHN')[] = ['PASSWORD'];
		if (user.attributes.email_verified === 'true') {
			available.push('EMAIL_OTP');
		}
		if (user.attributes.phone_number_verified === 'true') {
			available.push('SMS_OTP');
		}
		if (this.options.enablePasskeys && (user.passkeys?.length ?? 0) > 0) {
			available.push('WEB_AUTHN');
		}

		const choice = preferred ?? (available.length === 1 ? available[0] : undefined);
		if (!choice) {
			return this.issueChallenge(
				username,
				{
					name: 'CONTINUE_SIGN_IN_WITH_FIRST_FACTOR_SELECTION',
					session: '',
					availableChallenges: available,
				},
				{ flow: 'USER_AUTH' },
			);
		}

		if (!available.includes(choice)) {
			throw new ApiError(
				`USER_AUTH: first factor '${choice}' not available for this user`,
				400,
				{ name: AuthCognitoErrors.InvalidParameter },
			);
		}

		if (choice === 'PASSWORD') {
			return this.issueChallenge(
				username,
				{ name: 'CONFIRM_SIGN_IN_WITH_PASSWORD', session: '' },
				{ flow: 'USER_AUTH' },
			);
		}
		if (choice === 'EMAIL_OTP') {
			// Fire the code through the existing `mfa` purpose so the
			// `codeDelivery` hook still works with a single handler.
			void this.generateCode('mfa', username);
			return this.issueChallenge(
				username,
				{
					name: 'CONFIRM_SIGN_IN_WITH_FIRST_FACTOR_EMAIL_OTP',
					session: '',
					codeDeliveryDetails: {
						destination: redact(user.attributes.email ?? '', 'email'),
						deliveryMedium: 'EMAIL',
						attributeName: 'email',
					},
				},
				{ flow: 'USER_AUTH' },
			);
		}
		if (choice === 'WEB_AUTHN') {
			// Mock WebAuthn challenge. The browser sees a stable
			// `credentialRequestOptions` blob keyed by username — the
			// "challenge" inside is deterministic so e2e tests can match
			// against it without round-tripping a real authenticator.
			const credentialRequestOptions = JSON.stringify({
				challenge: `mock-challenge-${user.userSub}`,
				rpId: this.options.webAuthnRelyingParty?.id ?? 'localhost',
				allowCredentials: (user.passkeys ?? []).map((p) => ({
					id: p.credentialId,
					type: 'public-key',
				})),
				userVerification: this.options.webAuthnRelyingParty?.userVerification ?? 'preferred',
				timeout: 60000,
			});
			return this.issueChallenge(
				username,
				{
					name: 'CONFIRM_SIGN_IN_WITH_WEB_AUTHN',
					session: '',
					credentialRequestOptions,
				},
				{ flow: 'USER_AUTH' },
			);
		}
		// SMS_OTP
		void this.generateCode('mfa', username);
		return this.issueChallenge(
			username,
			{
				name: 'CONFIRM_SIGN_IN_WITH_FIRST_FACTOR_SMS_OTP',
				session: '',
				codeDeliveryDetails: {
					destination: redact(user.attributes.phone_number ?? '', 'phone'),
					deliveryMedium: 'SMS',
					attributeName: 'phone_number',
				},
			},
			{ flow: 'USER_AUTH' },
		);
	}

	/**
	 * Advance a sign-in challenge (MFA, NEW_PASSWORD_REQUIRED, etc.).
	 *
	 * The `session` argument is whatever the previous call returned in
	 * `nextStep.session`. The `response` is discriminated:
	 *
	 * - `{ code: string }` — SMS / TOTP / Email code + TOTP-setup / Email-setup.
	 * - `{ newPassword: string }` — `CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED`.
	 * - `{ mfaType: MfaTypeOf<O> }` — MFA selection / MFA setup selection.
	 *
	 * For call sites that still need to pass a raw string (internal dispatch
	 * from the state-machine `setAuthState` path), a third overload accepts
	 * `string` and maps it to `{ code: … }` semantics at the implementation
	 * boundary.
	 *
	 * @throws {AuthCognitoErrors.CodeMismatch}
	 * @throws {AuthCognitoErrors.ExpiredCode} Session token expired.
	 * @throws {AuthCognitoErrors.InvalidPassword} NEW_PASSWORD_REQUIRED with a policy-violating password.
	 *
	 * @category client
	 */
	async confirmSignIn(
		session: string,
		response: ConfirmSignInResponse<O>,
		context: BlocksContext,
		options?: ConfirmSignInOptions<O>,
	): Promise<SignInResult<O>>;
	async confirmSignIn(
		session: string,
		response: string,
		context: BlocksContext,
		options?: ConfirmSignInOptions<O>,
	): Promise<SignInResult<O>>;
	async confirmSignIn(
		session: string,
		response: ConfirmSignInResponse<O> | string,
		context: BlocksContext,
		options?: ConfirmSignInOptions<O>,
	): Promise<SignInResult<O>> {
		try {
			return await this.confirmSignInImpl(session, response, context, options);
		} catch (e) {
			// Reclassify ApiErrors with the shared retriability taxonomy so
			// clients can distinguish "bad input, keep the form" from
			// "session dead, start over". Mirrors the AWS runtime's
			// asApiError wrapping so mock + AWS behave identically on the
			// wire.
			if (e instanceof ApiError && !e.retriable && isRetriableAuthError(e.name)) {
				throw new ApiError(e.message, e.status, { name: e.name, retriable: true, cause: e.cause });
			}
			throw e;
		}
	}

	private async confirmSignInImpl(
		session: string,
		response: ConfirmSignInResponse<O> | string,
		context: BlocksContext,
		options?: ConfirmSignInOptions<O>,
	): Promise<SignInResult<O>> {
		const challengeResponse = typeof response === 'string'
			? response
			: 'code' in response
				? response.code
				: 'newPassword' in response
					? response.newPassword
					: 'email' in response
						? response.email
						: 'password' in response
							? response.password
							: 'firstFactor' in response
								? response.firstFactor
								: 'credential' in response
									? response.credential
									: response.mfaType;
		const challenge = this.challenges.get(session);
		if (!challenge || challenge.exp < Date.now()) {
			this.challenges.delete(session);
			throw new ApiError('Challenge session expired', 400, { name: AuthCognitoErrors.ExpiredCode });
		}
		const user = this.state.users[challenge.username];
		if (!user) throw new ApiError('User not found', 404, { name: AuthCognitoErrors.UserNotFound });

		switch (challenge.step) {
			case 'CONFIRM_SIGN_IN_WITH_SMS_CODE':
			case 'CONFIRM_SIGN_IN_WITH_EMAIL_CODE': {
				// Verify against the server-issued mfa code.
				this.verifyCode('mfa', challenge.username, challengeResponse);
				// When this challenge was spawned by an EMAIL_SETUP enrollment,
				// completing the code check also enables EMAIL as an MFA
				// factor and verifies the address — matching real Cognito's
				// behavior where the `RespondToAuthChallenge(EMAIL_OTP,
				// {EMAIL_OTP_CODE})` call simultaneously finishes the MFA
				// setup.
				if (challenge.step === 'CONFIRM_SIGN_IN_WITH_EMAIL_CODE' && challenge.isEmailSetup) {
					const existing = new Set(user.mfaPreference.enabled ?? []);
					existing.add('EMAIL');
					user.mfaPreference = { preferred: 'EMAIL', enabled: Array.from(existing) };
					user.attributes.email_verified = 'true';
				}
				this.challenges.delete(session);
				break;
			}
			case 'CONFIRM_SIGN_IN_WITH_TOTP_CODE': {
				// TOTP codes come from the user's authenticator app. The mock
				// has no RFC-6238 verifier wired, so any 6-digit code passes —
				// see DESIGN.md § "Mock vs AWS Parity Gaps".
				if (!/^\d{6}$/.test(challengeResponse)) {
					throw new ApiError('Invalid code', 400, { name: AuthCognitoErrors.CodeMismatch });
				}
				this.challenges.delete(session);
				break;
			}
			case 'CONTINUE_SIGN_IN_WITH_MFA_SELECTION': {
				// challengeResponse is the chosen MFA type, narrowed at the
				// overload signature (`{ mfaType: MfaTypeOf<O> }`) or provided
				// as a raw string from the state-machine dispatch path. Runtime
				// validation happens inside `challengeForMfaType`.
				const next = await this.challengeForMfaType(
					challenge.username,
					challengeResponse as 'SMS' | 'TOTP' | 'EMAIL',
				);
				this.challenges.delete(session);
				return { status: 'continueSignIn', nextStep: next };
			}
			case 'CONTINUE_SIGN_IN_WITH_MFA_SETUP_SELECTION': {
				const next = await this.challengeForMfaSetup(
					challenge.username,
					challengeResponse as 'TOTP' | 'EMAIL',
				);
				this.challenges.delete(session);
				return { status: 'continueSignIn', nextStep: next };
			}
			case 'CONTINUE_SIGN_IN_WITH_TOTP_SETUP': {
				if (!/^\d{6}$/.test(challengeResponse)) {
					throw new ApiError('Invalid code', 400, { name: AuthCognitoErrors.CodeMismatch });
				}
				user.totpSharedSecret = challenge.sharedSecret;
				user.totpVerified = true;
				user.mfaPreference = { preferred: 'TOTP', enabled: [...(user.mfaPreference.enabled ?? []), 'TOTP'] };
				this.challenges.delete(session);
				this.flushToDisk();
				break;
			}
			case 'CONTINUE_SIGN_IN_WITH_EMAIL_SETUP': {
				// Mirror real Cognito: the user submits an email address, we
				// deliver a code to it, and issue a follow-up
				// `CONFIRM_SIGN_IN_WITH_EMAIL_CODE` challenge for the code to
				// round-trip through. Enrollment completes when that code check
				// passes (see `CONFIRM_SIGN_IN_WITH_EMAIL_CODE` below, which
				// now also enrolls EMAIL as an MFA factor if the challenge
				// originated from a setup flow — tracked on the challenge
				// record via `isEmailSetup`).
				if (!challengeResponse.includes('@')) {
					throw new ApiError('Invalid email address', 400, {
						name: AuthCognitoErrors.InvalidParameter,
					});
				}
				user.attributes.email = challengeResponse;
				user.attributes.email_verified = 'false';
				this.flushToDisk();
				await this.generateCode('mfa', challenge.username);
				this.challenges.delete(session);
				const next: SignInNextStep = {
					name: 'CONFIRM_SIGN_IN_WITH_EMAIL_CODE',
					session: '',
					codeDeliveryDetails: {
						destination: redact(challengeResponse, 'email'),
						deliveryMedium: 'EMAIL',
						attributeName: 'email',
					},
				};
				const issued = this.issueChallenge(challenge.username, next, { isEmailSetup: true });
				return { status: 'continueSignIn', nextStep: issued };
			}
			case 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED': {
				this.enforcePasswordPolicy(challengeResponse);
				user.password = challengeResponse;
				delete (user as MockUserRecord & { forcePasswordChange?: boolean }).forcePasswordChange;
				if (options?.userAttributes) {
					Object.assign(user.attributes, this.prefixCustomAttrs(options.userAttributes));
				}
				this.challenges.delete(session);
				this.flushToDisk();
				break;
			}
			case 'CONTINUE_SIGN_IN_WITH_FIRST_FACTOR_SELECTION': {
				// USER_AUTH: user picked a factor. Consume this challenge and
				// emit the downstream one based on the pick.
				const pick = challengeResponse;
				if (
					pick !== 'PASSWORD'
					&& pick !== 'EMAIL_OTP'
					&& pick !== 'SMS_OTP'
					&& pick !== 'WEB_AUTHN'
				) {
					throw new ApiError(
						`USER_AUTH: unknown first factor '${pick}'`,
						400,
						{ name: AuthCognitoErrors.InvalidParameter },
					);
				}
				this.challenges.delete(session);
				const next = this.firstFactorChallenge(challenge.username, pick);
				return { status: 'continueSignIn', nextStep: next };
			}
			case 'CONFIRM_SIGN_IN_WITH_PASSWORD': {
				// USER_AUTH password leg. Validate the password the way the
				// classic signIn path would have; wrong password keeps the
				// challenge alive so the user can retry.
				if (user.password !== challengeResponse) {
					throw new ApiError('Incorrect username or password', 401, {
						name: AuthCognitoErrors.NotAuthorized,
					});
				}
				this.challenges.delete(session);
				break;
			}
			case 'CONFIRM_SIGN_IN_WITH_FIRST_FACTOR_EMAIL_OTP':
			case 'CONFIRM_SIGN_IN_WITH_FIRST_FACTOR_SMS_OTP': {
				this.verifyCode('mfa', challenge.username, challengeResponse);
				this.challenges.delete(session);
				break;
			}
			case 'CONFIRM_SIGN_IN_WITH_WEB_AUTHN': {
				// Loose-mock verification (per design doc): we accept any
				// well-formed assertion JSON whose `id` (or `rawId`) maps to
				// a registered credential on this user. No signature check —
				// faithfully simulating a CTAP signing ceremony would force
				// a runtime dep on @simplewebauthn/server. Customers who
				// need that fidelity should run against a real Cognito pool.
				let parsed: { id?: unknown; rawId?: unknown };
				try {
					parsed = JSON.parse(challengeResponse) as typeof parsed;
				} catch {
					throw new ApiError('credential must be JSON', 400, {
						name: AuthCognitoErrors.InvalidParameter,
					});
				}
				const cid =
					typeof parsed.id === 'string'
						? parsed.id
						: typeof parsed.rawId === 'string'
							? parsed.rawId
							: '';
				const known = (user.passkeys ?? []).some((p) => p.credentialId === cid);
				if (!cid || !known) {
					throw new ApiError('Unknown passkey credential', 400, {
						name: AuthCognitoErrors.WebAuthnCredentialNotSupported,
					});
				}
				this.challenges.delete(session);
				break;
			}
			default:
				throw new ApiError('Unsupported challenge', 400, { name: AuthCognitoErrors.InvalidParameter });
		}

		await this.issueSession(context, challenge.username, user);
		return { status: 'signedIn', user: this.toCognitoUser(challenge.username, user) };
	}

	/**
	 * Clear the session cookie (and when `global: true`, invalidate the
	 * refresh token at Cognito). In mock mode `global: true` deletes the
	 * stored session record.
	 *
	 * @category client
	 */
	async signOut(context: BlocksContext, options?: { global?: boolean }): Promise<void> {
		const id = await this.sessionIdFromCookie(context);
		if (id) await this.sessions.deleteSession(id);
		void options; // `global` has no additional effect in mock
		clearSessionCookie(context, this.fullId, this.crossDomain);
	}

	// ─────────────────────────────────────────────────────────────────────
	// Client-facing: session / identity (BlocksAuth)
	// ─────────────────────────────────────────────────────────────────────

	/** @category client */
	async requireAuth(context: BlocksContext): Promise<CognitoUser<O>> {
		const user = await this.getCurrentUser(context);
		if (!user) throw new ApiError('Authentication required', 401, { name: AuthCognitoErrors.NotAuthenticated });
		return user;
	}

	/** @category client */
	async checkAuth(context: BlocksContext): Promise<boolean> {
		return (await this.getCurrentUser(context)) !== null;
	}

	/** @category client */
	async getCurrentUser(context: BlocksContext): Promise<CognitoUser<O> | null> {
		const id = await this.sessionIdFromCookie(context);
		if (!id) return null;
		const record = await this.sessions.lookupSession(id);
		if (!record) {
			// Cookie points at a forgotten session — clear it.
			clearSessionCookie(context, this.fullId, this.crossDomain);
			return null;
		}
		if (jwtExpMs(record.accessToken) < Date.now()) {
			// Mock has no refresh-token concept — expired means dead. Drop
			// the record + clear the cookie so the browser stops replaying.
			await this.sessions.deleteSession(id);
			clearSessionCookie(context, this.fullId, this.crossDomain);
			return null;
		}
		// Derive user fields from the record's ID token — same path as the
		// AWS runtime. `decodeIdToken` is unsafe-decode (no signature check)
		// which is fine because the record is reached only through an
		// HMAC-verified cookie.
		//
		// The cast narrows `string[]` / `Record<string, string>` down to
		// `GroupOf<O>[]` / `Partial<Record<AttrOf<O>, string>>`. Sound because
		// the claim values were themselves minted from a constructor-validated
		// `O` when the user was created.
		const { username, userSub, groups, attributes } = decodeIdToken(record.idToken);
		return { userId: username, username, userSub, groups, attributes } as CognitoUser<O>;
	}

	/**
	 * Return the authenticated user, additionally asserting they belong to
	 * `role`. Throws 403 if not a member.
	 *
	 * @throws {AuthCognitoErrors.NotAuthenticated}
	 * @throws {AuthCognitoErrors.NotAuthorized}
	 * @category client
	 */
	/**
	 * Return the current auth session's tokens, or `{ tokens: undefined }`
	 * when there is no valid session. Pass `{ forceRefresh: true }` to rotate
	 * the tokens (mock: re-mints with a fresh `exp`; AWS: calls
	 * `REFRESH_TOKEN_AUTH` against Cognito). Shape mirrors Amplify-JS v6's
	 * `AuthSession` for interoperability — code using Amplify-JS patterns
	 * works without changes.
	 *
	 * The mock intentionally does not model a refresh-token lifecycle — an
	 * expired access token is simply treated as dead and the session is
	 * cleared, matching `getCurrentUser` semantics.
	 *
	 * @category client
	 */
	async fetchAuthSession(context: BlocksContext, options?: FetchAuthSessionOptions): Promise<AuthSession> {
		const id = await this.sessionIdFromCookie(context);
		if (!id) return { tokens: undefined };
		let record = await this.sessions.lookupSession(id);
		if (!record) {
			clearSessionCookie(context, this.fullId, this.crossDomain);
			return { tokens: undefined };
		}
		if (jwtExpMs(record.accessToken) < Date.now()) {
			// Expired — mock has no refresh; drop the record and cookie.
			await this.sessions.deleteSession(id);
			clearSessionCookie(context, this.fullId, this.crossDomain);
			return { tokens: undefined };
		}
		if (options?.forceRefresh) {
			const payload = decodeJwtPayload(record.idToken);
			const username =
				safeStringClaim(payload, 'cognito:username')
				|| safeStringClaim(payload, 'username')
				|| undefined;
			const user = username ? this.state.users[username] : undefined;
			if (!user) {
				// The user record backing this session has been removed (e.g. tests
				// wiped .bb-data mid-session). Clear and return empty — matches
				// what a revoked refresh token would do in AWS.
				await this.sessions.deleteSession(id);
				clearSessionCookie(context, this.fullId, this.crossDomain);
				return { tokens: undefined };
			}
			const expSeconds = Math.floor(Date.now() / 1000) + this.sessionDuration;
			const groups = Object.entries(this.state.groups)
				.filter(([, members]) => members.includes(username!))
				.map(([name]) => name);
			record = {
				idToken: issueMockJwt({
					sub: user.userSub,
					'cognito:username': username!,
					'cognito:groups': groups,
					token_use: 'id',
					exp: expSeconds,
					...user.attributes,
				}),
				accessToken: issueMockJwt({
					sub: user.userSub,
					username: username!,
					token_use: 'access',
					exp: expSeconds,
				}),
				refreshToken: record.refreshToken,
			};
			await this.sessions.updateSession(id, record);
		}
		return {
			tokens: sessionToTokens(record),
			userSub: safeStringClaim(decodeJwtPayload(record.idToken), 'sub') || undefined,
		};
	}

	async requireRole(context: BlocksContext, role: GroupOf<O>): Promise<CognitoUser<O>> {
		const user = await this.requireAuth(context);
		if (!user.groups.includes(role)) {
			throw new ApiError(`Not in group '${role}'`, 403, { name: AuthCognitoErrors.NotAuthorized });
		}
		return user;
	}

	/**
	 * Read live attributes from the user record — mirrors the AWS runtime's
	 * `GetUserCommand` call. Session records are only as current as the last
	 * ID-token issue, so reading them directly would return stale data after
	 * `updateUserAttributes`.
	 *
	 * @category client
	 */
	async fetchUserAttributes(context: BlocksContext): Promise<Partial<Record<ReadAttrOf<O>, string>>> {
		const signed = await this.requireAuth(context);
		const user = this.requireUser(signed.username);
		return { ...user.attributes } as Partial<Record<ReadAttrOf<O>, string>>;
	}

	// ─────────────────────────────────────────────────────────────────────
	// Client-facing: user profile
	// ─────────────────────────────────────────────────────────────────────

	/** @category client */
	async updatePassword(context: BlocksContext, oldPassword: string, newPassword: string): Promise<void> {
		const signed = await this.requireAuth(context);
		const user = this.requireUser(signed.username);
		if (user.password !== oldPassword) {
			throw new ApiError('Incorrect password', 400, { name: AuthCognitoErrors.NotAuthorized });
		}
		this.enforcePasswordPolicy(newPassword);
		user.password = newPassword;
		this.flushToDisk();
	}

	/** @category client */
	async updateUserAttributes(
		context: BlocksContext,
		attributes: Partial<Record<AttrOf<O>, string>>,
	): Promise<Partial<Record<AttrOf<O>, UpdateAttributeOutcome>>> {
		const signed = await this.requireAuth(context);
		const user = this.requireUser(signed.username);
		const prefixed = this.prefixCustomAttrs(attributes);
		const result: Record<string, UpdateAttributeOutcome> = {};
		for (const [name, value] of Object.entries(prefixed)) {
			user.attributes[name] = value;
			// Email / phone_number trigger a verification code like Cognito does.
			if (name === 'email' || name === 'phone_number') {
				const code = await this.generateCode('attribute', signed.username);
				result[name] = {
					isUpdated: false,
					nextStep: {
						name: 'CONFIRM_ATTRIBUTE_WITH_CODE',
						codeDeliveryDetails: {
							destination: value,
							deliveryMedium: name === 'email' ? 'EMAIL' : 'SMS',
							attributeName: name,
						},
					},
				};
				void code;
			} else {
				result[name] = { isUpdated: true };
			}
		}
		this.flushToDisk();
		// `fetchUserAttributes` reads live from this.state.users, so callers see
		// the update on the very next call — no session-record refresh needed.
		return result;
	}

	/** @category client */
	async updateUserAttribute(context: BlocksContext, name: AttrOf<O>, value: string): Promise<UpdateAttributeOutcome> {
		const map = await this.updateUserAttributes(context, { [name]: value } as Partial<Record<AttrOf<O>, string>>);
		const key = isStandardAttribute(String(name)) || String(name).startsWith('custom:') ? name : `custom:${String(name)}`;
		return (map as Record<string, UpdateAttributeOutcome>)[String(key)] ?? { isUpdated: true };
	}

	/** @category client */
	async confirmUserAttribute(context: BlocksContext, name: AttrOf<O>, code: string): Promise<void> {
		const signed = await this.requireAuth(context);
		void name;
		this.verifyCode('attribute', signed.username, code);
	}

	/** @category client */
	async sendUserAttributeVerificationCode(context: BlocksContext, name: AttrOf<O>): Promise<void> {
		const signed = await this.requireAuth(context);
		void name;
		await this.generateCode('attribute', signed.username);
		this.flushToDisk();
	}

	/** @category client */
	async deleteUser(context: BlocksContext): Promise<void> {
		const signed = await this.requireAuth(context);
		delete this.state.users[signed.username];
		for (const group of Object.keys(this.state.groups)) {
			this.state.groups[group] = this.state.groups[group].filter((u) => u !== signed.username);
		}
		this.flushToDisk();
		const id = await this.sessionIdFromCookie(context);
		if (id) await this.sessions.deleteSession(id);
		clearSessionCookie(context, this.fullId, this.crossDomain);
	}

	// ─────────────────────────────────────────────────────────────────────
	// Client-facing: password reset
	// ─────────────────────────────────────────────────────────────────────

	/**
	 * Initiate password reset. Sends a verification code via email/SMS.
	 *
	 * **Security note:** Always returns success (never throws `UserNotFound`),
	 * even for non-existent users, to prevent username enumeration. Callers
	 * should NOT rely on the return value to infer whether an account exists.
	 *
	 * @category client
	 */
	async resetPassword(username: string): Promise<ResetPasswordResult> {
		const user = this.state.users[username];
		if (!user) {
			// Match Cognito: silently succeed to avoid leaking which users exist.
			return {
				isPasswordReset: false,
				nextStep: {
					name: 'CONFIRM_RESET_PASSWORD_WITH_CODE',
					codeDeliveryDetails: this.codeDeliveryFor({}, '------'),
				},
			};
		}
		const code = await this.generateCode('resetPassword', username);
		this.flushToDisk();
		return {
			isPasswordReset: false,
			nextStep: {
				name: 'CONFIRM_RESET_PASSWORD_WITH_CODE',
				codeDeliveryDetails: this.codeDeliveryFor(user.attributes, code),
			},
		};
	}

	/** @category client */
	async confirmResetPassword(username: string, code: string, newPassword: string): Promise<void> {
		const user = this.requireUser(username);
		this.verifyCode('resetPassword', username, code);
		this.enforcePasswordPolicy(newPassword);
		user.password = newPassword;
		this.flushToDisk();
	}

	// ─────────────────────────────────────────────────────────────────────
	// Client-facing: MFA setup
	// ─────────────────────────────────────────────────────────────────────

	/** @category client */
	async setUpTOTP(context: BlocksContext): Promise<{ sharedSecret: string }> {
		const signed = await this.requireAuth(context);
		const user = this.requireUser(signed.username);
		const sharedSecret = generateTotpSecret();
		user.totpSharedSecret = sharedSecret;
		user.totpVerified = false;
		this.flushToDisk();
		return { sharedSecret };
	}

	/** @category client */
	async verifyTOTPSetup(context: BlocksContext, code: string): Promise<void> {
		const signed = await this.requireAuth(context);
		const user = this.requireUser(signed.username);
		if (!user.totpSharedSecret) {
			throw new ApiError('TOTP not set up', 400, { name: AuthCognitoErrors.SoftwareTokenMFANotFound });
		}
		if (!/^\d{6}$/.test(code)) {
			throw new ApiError('Invalid code', 400, { name: AuthCognitoErrors.CodeMismatch });
		}
		user.totpVerified = true;
		// Enroll TOTP as an MFA factor so subsequent sign-ins can challenge it
		// and fetchMFAPreference reflects the enrollment.
		const enabled = new Set(user.mfaPreference.enabled ?? []);
		enabled.add('TOTP');
		user.mfaPreference = { preferred: user.mfaPreference.preferred ?? 'TOTP', enabled: Array.from(enabled) };
		this.flushToDisk();
	}

	/**
	 * Update the MFA preferences for the signed-in user.
	 *
	 * Per-factor delta compatible with Amplify-JS v6. Factors omitted from the
	 * input are left unchanged. At most one factor may be set to
	 * `'PREFERRED'` per call — setting two raises
	 * `InvalidParameterException`. Setting `'PREFERRED'` on a new factor
	 * automatically demotes the previously-preferred factor to
	 * `'NOT_PREFERRED'` (matches Cognito's documented behavior).
	 *
	 * @throws {AuthCognitoErrors.InvalidParameter} multiple `'PREFERRED'`
	 *   factors in one call, OR a factor the pool doesn't advertise in
	 *   `mfaTypes`.
	 *
	 * @category client
	 */
	async updateMFAPreference(context: BlocksContext, input: MFAPreferenceInput<O>): Promise<void> {
		const signed = await this.requireAuth(context);
		const user = this.requireUser(signed.username);

		// Normalize the input to a list of [factor, setting] deltas.
		const raw = input as { sms?: MFASetting; totp?: MFASetting; email?: MFASetting };
		const deltas: [MfaFactor, MFASetting][] = [];
		if (raw.sms)   deltas.push(['SMS',   raw.sms]);
		if (raw.totp)  deltas.push(['TOTP',  raw.totp]);
		if (raw.email) deltas.push(['EMAIL', raw.email]);

		// Validate against the pool's declared `mfaTypes`.
		const allowedTypes: readonly MfaFactor[] = this.options.mfaTypes ?? ['SMS', 'TOTP', 'EMAIL'];
		for (const [factor] of deltas) {
			if (!allowedTypes.includes(factor)) {
				throw new ApiError(
					`MFA factor '${factor}' is not configured on this user pool (mfaTypes: [${allowedTypes.join(', ')}])`,
					400,
					{ name: AuthCognitoErrors.InvalidParameter },
				);
			}
		}

		// Cognito rejects multiple PREFERRED in one call.
		const preferredCount = deltas.filter(([, s]) => s === 'PREFERRED').length;
		if (preferredCount > 1) {
			throw new ApiError(
				'At most one factor may be set to PREFERRED per call',
				400,
				{ name: AuthCognitoErrors.InvalidParameter },
			);
		}

		// Cognito rejects enabling TOTP before it's been associated +
		// verified (`associateSoftwareToken` → `verifySoftwareToken`).
		// Mirror that rule: refuse to enable TOTP on a user whose
		// `totpVerified` flag is false.
		const enabling = deltas.filter(([, s]) => s === 'ENABLED' || s === 'PREFERRED' || s === 'NOT_PREFERRED');
		if (enabling.some(([f]) => f === 'TOTP') && !user.totpVerified) {
			throw new ApiError(
				'TOTP is not associated for this user. Call setUpTOTP + verifyTOTPSetup before enabling it as an MFA factor.',
				400,
				{ name: AuthCognitoErrors.SoftwareTokenMFANotFound },
			);
		}

		// Apply the delta. Start from the current state.
		const enabled = new Set<MfaFactor>(user.mfaPreference.enabled);
		let preferred: MfaFactor | 'NOMFA' | undefined = user.mfaPreference.preferred;

		for (const [factor, setting] of deltas) {
			switch (setting) {
				case 'DISABLED':
					enabled.delete(factor);
					if (preferred === factor) preferred = undefined;
					break;
				case 'ENABLED':
				case 'NOT_PREFERRED':
					enabled.add(factor);
					if (preferred === factor) preferred = undefined;
					break;
				case 'PREFERRED':
					enabled.add(factor);
					// Auto-demote the prior preferred factor — it stays in
					// `enabled` but loses the `preferred` flag.
					preferred = factor;
					break;
			}
		}

		// If the user just disabled every factor and nothing is preferred,
		// surface the `NOMFA` sentinel so callers can distinguish "never
		// configured" from "explicitly opted out."
		if (enabled.size === 0 && preferred === undefined && deltas.some(([, s]) => s === 'DISABLED')) {
			preferred = 'NOMFA';
		}

		user.mfaPreference = {
			enabled: Array.from(enabled),
			preferred,
		};
		this.flushToDisk();
	}

	/**
	 * Read the signed-in user's current MFA preferences.
	 *
	 * `enabled` may contain any number of factors. `preferred` is
	 * zero-or-one of those factors (or the `'NOMFA'` sentinel). Verified
	 * contact attributes (`email_verified`, `phone_number_verified`) are
	 * surfaced as enabled factors if the pool's `mfaTypes` allows them —
	 * this matches Cognito's behavior where a verified email auto-enables
	 * Email MFA without an explicit preference call.
	 *
	 * @category client
	 */
	async fetchMFAPreference(context: BlocksContext): Promise<MFAPreference<O>> {
		const signed = await this.requireAuth(context);
		const user = this.requireUser(signed.username);
		const allowedTypes: readonly MfaFactor[] = this.options.mfaTypes ?? ['SMS', 'TOTP', 'EMAIL'];
		const enabled = new Set<MfaFactor>(user.mfaPreference.enabled);
		if (allowedTypes.includes('EMAIL') && user.attributes.email_verified === 'true') enabled.add('EMAIL');
		if (allowedTypes.includes('SMS') && user.attributes.phone_number_verified === 'true') enabled.add('SMS');
		return {
			preferred: user.mfaPreference.preferred,
			enabled: Array.from(enabled),
		} as MFAPreference<O>;
	}

	// ─────────────────────────────────────────────────────────────────────
	// Client-facing: devices
	// ─────────────────────────────────────────────────────────────────────

	/** @category client */
	async *fetchDevices(context: BlocksContext): AsyncIterable<DeviceRecord> {
		const signed = await this.requireAuth(context);
		const user = this.requireUser(signed.username);
		for (const device of Object.values(user.devices)) yield device;
	}

	/** @category client */
	async rememberDevice(context: BlocksContext): Promise<void> {
		const signed = await this.requireAuth(context);
		const user = this.requireUser(signed.username);
		const deviceKey = crypto.randomUUID();
		user.devices[deviceKey] = {
			deviceKey,
			attributes: {},
			createDate: new Date().toISOString(),
			lastModifiedDate: new Date().toISOString(),
			lastAuthenticatedDate: new Date().toISOString(),
		};
		this.flushToDisk();
	}

	/** @category client */
	async forgetDevice(context: BlocksContext, deviceKey: string): Promise<void> {
		const signed = await this.requireAuth(context);
		const user = this.requireUser(signed.username);
		delete user.devices[deviceKey];
		this.flushToDisk();
	}

	// ─────────────────────────────────────────────────────────────────────
	// Passkeys (WebAuthn) — mock
	// ─────────────────────────────────────────────────────────────────────

	/**
	 * Mock passkey enrolment. Returns a deterministic
	 * `credentialCreationOptions` blob; the browser is expected to feed it
	 * into `navigator.credentials.create(...)` (or, in unit tests, hand the
	 * mock an arbitrary credential JSON with a stable `id`). The signature
	 * is intentionally loose — see {@link confirmSignIn}'s WEB_AUTHN branch.
	 *
	 * @category client
	 */
	async startPasskeyRegistration(context: BlocksContext): Promise<StartPasskeyRegistrationResult> {
		const signed = await this.requireAuth(context);
		const user = this.requireUser(signed.username);
		const challenge = crypto.randomBytes(16).toString('base64url');
		const credentialCreationOptions = JSON.stringify({
			challenge,
			rp: {
				id: this.options.webAuthnRelyingParty?.id ?? 'localhost',
				name: this.fullId,
			},
			user: {
				id: user.userSub,
				name: signed.username,
				displayName: signed.username,
			},
			pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
			authenticatorSelection: {
				userVerification: this.options.webAuthnRelyingParty?.userVerification ?? 'preferred',
			},
			timeout: 60000,
		});
		return { credentialCreationOptions };
	}

	/**
	 * Mock passkey enrolment finalisation. Persists the credential's `id` so
	 * future sign-ins can match against it.
	 *
	 * @category client
	 */
	async completePasskeyRegistration(
		context: BlocksContext,
		credential: string,
	): Promise<CompletePasskeyRegistrationResult> {
		const signed = await this.requireAuth(context);
		const user = this.requireUser(signed.username);
		let parsed: { id?: unknown; rawId?: unknown; response?: { clientDataJSON?: unknown } };
		try {
			parsed = JSON.parse(credential) as typeof parsed;
		} catch {
			throw new ApiError('credential must be JSON', 400, {
				name: AuthCognitoErrors.InvalidParameter,
			});
		}
		const credentialId =
			typeof parsed.id === 'string'
				? parsed.id
				: typeof parsed.rawId === 'string'
					? parsed.rawId
					: '';
		if (!credentialId) {
			throw new ApiError('credential.id is required', 400, {
				name: AuthCognitoErrors.InvalidParameter,
			});
		}
		const passkeys = user.passkeys ?? [];
		if (!passkeys.some((p) => p.credentialId === credentialId)) {
			passkeys.push({ credentialId, createdAt: Date.now() });
		}
		user.passkeys = passkeys;
		this.flushToDisk();
		return { credentialId };
	}

	/** @category client */
	async listPasskeys(context: BlocksContext): Promise<PasskeyDescription[]> {
		const signed = await this.requireAuth(context);
		const user = this.requireUser(signed.username);
		return (user.passkeys ?? []).map((p) => ({
			credentialId: p.credentialId,
			friendlyName: p.friendlyName,
			createdAt: p.createdAt,
		}));
	}

	/** @category client */
	async deletePasskey(context: BlocksContext, credentialId: string): Promise<void> {
		const signed = await this.requireAuth(context);
		const user = this.requireUser(signed.username);
		user.passkeys = (user.passkeys ?? []).filter((p) => p.credentialId !== credentialId);
		this.flushToDisk();
	}

	// ─────────────────────────────────────────────────────────────────────
	// createApi — state machine for <Authenticator>
	// ─────────────────────────────────────────────────────────────────────

	createApi(): AuthStateApi {
		const enablePasskeys = this.options.enablePasskeys === true;
		const baseSignedOut = (error?: string, errorName?: string): AuthState =>
			signedOut({
				selfSignUp: this.options.selfSignUp ?? true,
				userAttributes: this.options.userAttributes ?? [],
				enablePasskeys,
				signInWith: this.options.signInWith,
				error,
				errorName,
			});
		const baseSignedIn = (user: CognitoUser<O>): AuthState =>
			signedInState(user, { enablePasskeys });

		return new ApiNamespace(this, 'auth', (context) => ({
			getAuthState: async (): Promise<AuthState> => {
				const user = await this.getCurrentUser(context);
				return user ? baseSignedIn(user) : baseSignedOut();
			},
			setAuthState: async (input: AuthActionInput): Promise<AuthState> => {
				try {
					switch (input.action) {
						case 'signIn': {
							const r = await this.signIn(input.username, input.password, context);
							if (r.status === 'signedIn') return baseSignedIn(r.user);
							return confirmingSignIn(r.nextStep);
						}
						case 'signInWithPasskey': {
							const r = await this.signIn(
								input.username,
								'',
								context,
								{ preferredChallenge: 'WEB_AUTHN' },
							);
							if (r.status === 'signedIn') return baseSignedIn(r.user);
							return confirmingSignIn(r.nextStep);
						}
						case 'signUp': {
							const { action: _a, username, password, autoSignIn: autoSignInRaw, ...rest } = input;
							void _a;
							const autoSignIn = autoSignInRaw !== 'false';
							// State-machine dispatch receives custom-attribute fields
							// dynamically; the narrow-attr typecheck happens at direct
							// call sites, not here.
							const r = await this.signUp(
								username,
								password,
								{
									attributes: rest as Partial<Record<AttrOf<O>, string>>,
									autoSignIn,
								},
								context,
							);
							void r;
							return confirmingSignUp(username);
						}
						case 'confirmSignUp': {
							const r = await this.confirmSignUp(input.username, input.code, context);
							if (r.nextStep.signUpStep === 'COMPLETE_AUTO_SIGN_IN') {
								return {
									state: 'confirmingSignUp',
									actions: [{
										name: 'autoSignIn',
										label: 'Continue',
										fields: [
											{ name: 'username', label: 'Username', type: 'hidden', required: true, defaultValue: input.username },
										],
									}],
								};
							}
							return baseSignedOut();
						}
						case 'autoSignIn': {
							const r = await this.autoSignIn(context);
							if (r.status === 'signedIn') return baseSignedIn(r.user);
							return confirmingSignIn(r.nextStep);
						}
						case 'resendSignUpCode': {
							await this.resendSignUpCode(input.username);
							return confirmingSignUp(input.username);
						}
						case 'confirmSignIn': {
							// `challenge` carries the discriminator that pairs the payload
							// shape with its `AuthActionPayloadMap.confirmSignIn` arm. Switch
							// on it explicitly so we never accidentally pick the wrong field
							// (the payload itself may share keys with adjacent challenge
							// shapes — e.g. `code` is used by both TOTP_CODE and TOTP_SETUP).
							let response: string;
							switch (input.challenge) {
								case 'code': response = input.code; break;
								case 'totpSetup': response = input.code; break;
								case 'newPassword': response = input.newPassword; break;
								case 'mfaType': response = input.mfaType; break;
								case 'email': response = input.email; break;
								case 'password': response = input.password; break;
								case 'firstFactor': response = input.firstFactor; break;
								case 'webauthn': response = input.credential; break;
								default: response = '';
							}
							const r = await this.confirmSignIn(input.session, response, context);
							if (r.status === 'signedIn') return baseSignedIn(r.user);
							return confirmingSignIn(r.nextStep);
						}
						case 'startPasskeyRegistration': {
							const user = await this.requireAuth(context);
							const r = await this.startPasskeyRegistration(context);
							return registeringPasskey(user, r.credentialCreationOptions);
						}
						case 'completePasskeyRegistration': {
							const user = await this.requireAuth(context);
							await this.completePasskeyRegistration(context, input.credential);
							const passkeys = await this.listPasskeys(context);
							return managingPasskeys(user, passkeys);
						}
						case 'listPasskeys': {
							const user = await this.requireAuth(context);
							const passkeys = await this.listPasskeys(context);
							return managingPasskeys(user, passkeys);
						}
						case 'deletePasskey': {
							const user = await this.requireAuth(context);
							await this.deletePasskey(context, input.credentialId);
							const passkeys = await this.listPasskeys(context);
							return managingPasskeys(user, passkeys);
						}
						case 'resetPassword': {
							await this.resetPassword(input.username);
							return confirmingPasswordReset(input.username);
						}
						case 'confirmResetPassword': {
							await this.confirmResetPassword(input.username, input.code, input.newPassword);
							return baseSignedOut();
						}
						case 'signOut': {
							await this.signOut(context);
							return baseSignedOut();
						}
						default:
							return { ...baseSignedOut(), error: `Unknown action: ${(input as any).action}` };
					}
				} catch (e: unknown) {
					const message = e instanceof Error ? e.message : 'An error occurred';
					const errorName = e instanceof ApiError && e.name !== DEFAULT_API_ERROR_NAME ? e.name : undefined;
					// Match the AWS runtime: retriable failures (wrong MFA
					// code, rejected shape) emit a thin signedOut shape with
					// `retriable: true` so the client can preserve its current
					// challenge form instead of tearing it down.
					if (e instanceof ApiError && e.retriable) {
						return {
							state: 'signedOut',
							actions: [],
							error: message,
							retriable: true,
							...(errorName ? { errorName } : {}),
						};
					}
					return baseSignedOut(message, errorName);
				}
			},
		}));
	}

	// ─────────────────────────────────────────────────────────────────────
	// Internal helpers
	// ─────────────────────────────────────────────────────────────────────

	private requireUser(username: string): MockUserRecord {
		const user = this.state.users[username];
		if (!user) throw new ApiError('User not found', 404, { name: AuthCognitoErrors.UserNotFound });
		return user;
	}

	private prefixCustomAttrs(attrs?: Partial<Record<string, string>>): Record<string, string> {
		if (!attrs) return {};
		const out: Record<string, string> = {};
		const declared = new Set((this.options.userAttributes ?? []).map((a) => a.name));
		for (const [key, value] of Object.entries(attrs)) {
			if (value === undefined) continue;
			if (key.startsWith('custom:')) out[key] = value;
			else if (isStandardAttribute(key)) out[key] = value;
			else if (declared.has(key)) out[`custom:${key}`] = value;
			else out[key] = value;
		}
		return out;
	}

	private async generateCode(
		purpose: 'signUp' | 'resetPassword' | 'mfa' | 'attribute',
		username: string,
	): Promise<string> {
		const code = String(crypto.randomInt(100000, 1000000));
		this.state.codes[`${purpose}:${username}`] = {
			code,
			exp: Date.now() + CODE_TTL_SECONDS * 1000,
		};
		this.writeLastCode(purpose, username, code);
		if (this.options.codeDelivery) await this.options.codeDelivery(username, code, purpose);
		else this.log.info(`${purpose} code for ${username}: ${code}`);
		return code;
	}

	private verifyCode(purpose: string, username: string, code: string): void {
		const key = `${purpose}:${username}`;
		const entry = this.state.codes[key];
		if (!entry) {
			throw new ApiError('Invalid code', 400, { name: AuthCognitoErrors.CodeMismatch });
		}
		if (entry.exp < Date.now()) {
			delete this.state.codes[key];
			this.flushToDisk();
			throw new ApiError('Code expired', 400, { name: AuthCognitoErrors.ExpiredCode });
		}
		if (entry.code !== code) {
			throw new ApiError('Invalid code', 400, { name: AuthCognitoErrors.CodeMismatch });
		}
		delete this.state.codes[key];
		this.flushToDisk();
	}

	private enforcePasswordPolicy(password: string): void {
		const p: PasswordPolicy = this.options.passwordPolicy ?? {};
		const errors: string[] = [];
		const minLength = p.minLength ?? 8;
		if (password.length < minLength) errors.push(`at least ${minLength} characters`);
		if (p.requireUppercase !== false && !/[A-Z]/.test(password)) errors.push('an uppercase letter');
		if (p.requireLowercase !== false && !/[a-z]/.test(password)) errors.push('a lowercase letter');
		if (p.requireDigits !== false && !/\d/.test(password)) errors.push('a digit');
		if (p.requireSymbols !== false && !/[^A-Za-z0-9]/.test(password)) errors.push('a symbol');
		if (errors.length > 0) {
			throw new ApiError(`Password must contain ${errors.join(', ')}`, 400, {
				name: AuthCognitoErrors.InvalidPassword,
			});
		}
	}

	/**
	 * Resolve which attribute the pool treats as a synthetic copy of the
	 * username. Mirrors how Cognito interprets `UsernameAttributes` —
	 * `signInWith: 'email'` (singular) or `signInWith: ['email']` makes
	 * `email` the alias; `'phone'` makes `phone_number` the alias. The
	 * default (`['username', 'email']` / `'username'`) has no alias —
	 * `email` is just a regular configurable attribute.
	 *
	 * Returns the attribute name to populate from the username value at
	 * sign-up time, or `undefined` when no alias resolution applies.
	 */
	private usernameAliasAttr(): string | undefined {
		const v = this.options.signInWith;
		if (v === undefined) return undefined;
		// Single-string forms: `'email'` / `'phone'` mean
		// UsernameAttributes is set to that single value, so the username
		// IS the email/phone.
		if (v === 'email') return 'email';
		if (v === 'phone') return 'phone_number';
		if (v === 'username') return undefined;
		// Array form: only treated as an alias when the array contains
		// JUST the contact attribute (no 'username'). `['username', 'email']`
		// is the alias mode where the username is its own thing and email
		// is a secondary AliasAttribute — Cognito does NOT auto-populate.
		if (Array.isArray(v)) {
			if (v.includes('username')) return undefined;
			if (v.length === 1 && v[0] === 'email') return 'email';
			if (v.length === 1 && v[0] === 'phone') return 'phone_number';
		}
		return undefined;
	}

	private async selectSignInChallenge(username: string, user: MockUserRecord): Promise<SignInNextStep | null> {
		const mfaMode = this.options.mfa ?? 'off';
		const allowedTypes = this.options.mfaTypes ?? ['SMS', 'TOTP'];
		if (mfaMode === 'off') return null;

		// Real Cognito treats a verified email / phone as automatically
		// available for Email / SMS MFA — there is no separate "setup" step
		// for those factors; the verification happened when the user
		// confirmed their sign-up. Only TOTP needs explicit enrollment.
		const enrolled: ('SMS' | 'TOTP' | 'EMAIL')[] = [
			...(user.mfaPreference.enabled ?? []),
		];
		if (allowedTypes.includes('EMAIL') && user.attributes.email_verified === 'true' && !enrolled.includes('EMAIL')) {
			enrolled.push('EMAIL');
		}
		if (allowedTypes.includes('SMS') && user.attributes.phone_number_verified === 'true' && !enrolled.includes('SMS')) {
			enrolled.push('SMS');
		}

		const preferred = user.mfaPreference.preferred;

		// If MFA is required and nothing is available (no verified contact,
		// no TOTP enrolled), route into a setup flow. TOTP + EMAIL can both
		// be enrolled mid-sign-in; SMS cannot (Cognito requires the phone to
		// be verified out-of-band first).
		if (mfaMode === 'required' && enrolled.length === 0) {
			const setupChoices = allowedTypes.filter(
				(t): t is 'TOTP' | 'EMAIL' => t === 'TOTP' || t === 'EMAIL',
			);
			if (setupChoices.length === 0) {
				throw new ApiError(
					'MFA is required but no factor can be enrolled. Configure TOTP / EMAIL or verify an SMS number.',
					400,
					{ name: AuthCognitoErrors.InvalidParameter },
				);
			}
			if (setupChoices.length > 1) {
				return this.issueChallenge(username, {
					name: 'CONTINUE_SIGN_IN_WITH_MFA_SETUP_SELECTION',
					session: '',
					allowedMFATypes: setupChoices,
				});
			}
			return this.challengeForMfaSetup(username, setupChoices[0]);
		}

		// If MFA is optional and user has nothing available, skip.
		if (enrolled.length === 0) return null;

		// Preferred method: issue its challenge directly.
		if (preferred && preferred !== 'NOMFA' && enrolled.includes(preferred)) {
			return this.challengeForMfaType(username, preferred);
		}

		// Multiple methods available, no preference: force user to pick.
		if (enrolled.length > 1) {
			return this.issueChallenge(username, {
				name: 'CONTINUE_SIGN_IN_WITH_MFA_SELECTION',
				session: '',
				allowedMFATypes: enrolled,
			});
		}

		return this.challengeForMfaType(username, enrolled[0]);
	}

	private async challengeForMfaType(username: string, type: 'SMS' | 'TOTP' | 'EMAIL'): Promise<SignInNextStep> {
		const user = this.state.users[username]!;
		switch (type) {
			case 'SMS': {
				// Real Cognito delivers an SMS code per sign-in; mirror that by
				// issuing a fresh code through the normal `mfa` purpose so the
				// `codeDelivery` hook fires and tests can read it.
				await this.generateCode('mfa', username);
				return this.issueChallenge(username, {
					name: 'CONFIRM_SIGN_IN_WITH_SMS_CODE',
					session: '',
					codeDeliveryDetails: {
						destination: user.attributes.phone_number ?? '+1***',
						deliveryMedium: 'SMS',
						attributeName: 'phone_number',
					},
				});
			}
			case 'TOTP':
				// TOTP codes come from the user's authenticator app — no code
				// is delivered from the server, so nothing to generate here.
				return this.issueChallenge(username, { name: 'CONFIRM_SIGN_IN_WITH_TOTP_CODE', session: '' });
			case 'EMAIL':
				await this.generateCode('mfa', username);
				return this.issueChallenge(username, {
					name: 'CONFIRM_SIGN_IN_WITH_EMAIL_CODE',
					session: '',
					codeDeliveryDetails: {
						destination: user.attributes.email ?? 'a***@e***',
						deliveryMedium: 'EMAIL',
						attributeName: 'email',
					},
				});
		}
	}

	private async challengeForMfaSetup(username: string, type: 'TOTP' | 'EMAIL'): Promise<SignInNextStep> {
		if (type === 'TOTP') {
			const sharedSecret = generateTotpSecret();
			return this.issueChallenge(username, {
				name: 'CONTINUE_SIGN_IN_WITH_TOTP_SETUP',
				session: '',
				sharedSecret,
			});
		}
		// Email MFA enrollment: the user has to submit the address they want
		// to enroll first. No code is generated here — the code is issued
		// only after the user responds with the address (see the
		// `CONTINUE_SIGN_IN_WITH_EMAIL_SETUP` branch in `confirmSignIn`).
		return this.issueChallenge(username, { name: 'CONTINUE_SIGN_IN_WITH_EMAIL_SETUP', session: '' });
	}

	/** Mint a new challenge token, store it server-side, and bake it into the returned next-step. */
	private issueChallenge(
		username: string,
		step: SignInNextStep,
		extras?: { isEmailSetup?: boolean; flow?: 'USER_AUTH' },
	): SignInNextStep {
		const token = crypto.randomBytes(16).toString('base64url');
		const record: ChallengeRecord = {
			username,
			step: step.name,
			exp: Date.now() + 180_000, // 3 minutes, matches Cognito
		};
		if (step.name === 'CONTINUE_SIGN_IN_WITH_TOTP_SETUP') record.sharedSecret = step.sharedSecret;
		if (extras?.isEmailSetup) record.isEmailSetup = true;
		if (extras?.flow) record.flow = extras.flow;
		this.challenges.set(token, record);
		// Persist so a dev-server restart mid-MFA doesn't silently drop the
		// challenge (user would otherwise see "session expired" with no cause).
		this.flushToDisk();
		// RESET_PASSWORD and CONFIRM_SIGN_UP have no `session` field — return as-is.
		if (step.name === 'RESET_PASSWORD' || step.name === 'CONFIRM_SIGN_UP') return step;
		return { ...step, session: token } as SignInNextStep;
	}

	private async issueSession(context: BlocksContext, username: string, user: MockUserRecord): Promise<void> {
		const groups = Object.entries(this.state.groups)
			.filter(([, members]) => members.includes(username))
			.map(([name]) => name);
		const expSeconds = Math.floor(Date.now() / 1000) + this.sessionDuration;
		const record: SessionRecord = {
			// Mock tokens are JWT-shaped base64url strings so the real
			// `decodeIdToken` / `jwtExpMs` helpers can parse them. Signature
			// slot is a fixed placeholder — nothing in the mock path verifies
			// it, and the AWS runtime never sees mock tokens.
			idToken: issueMockJwt({
				sub: user.userSub,
				'cognito:username': username,
				'cognito:groups': groups,
				token_use: 'id',
				exp: expSeconds,
				...user.attributes,
			}),
			accessToken: issueMockJwt({
				sub: user.userSub,
				username,
				token_use: 'access',
				exp: expSeconds,
			}),
			refreshToken: `mock-refresh-${crypto.randomBytes(8).toString('hex')}`,
		};
		const sessionId = await this.sessions.createSession(record);
		const signed = signSessionId(sessionId, this.state.sessionSecret);
		setSessionCookie(context, this.fullId, signed, this.sessionDuration, this.crossDomain);
	}

	private async sessionIdFromCookie(context: BlocksContext): Promise<string | null> {
		const cookie = readSessionCookie(context, this.fullId);
		if (!cookie) return null;
		return verifySessionId(cookie, this.state.sessionSecret);
	}

	private toCognitoUser(username: string, user: MockUserRecord): CognitoUser<O> {
		// The mock's in-memory group/attribute state isn't tagged with the
		// caller's literal options. We built `groups` and `attributes` from
		// user-provided data that the constructor validated against `O`, so
		// the narrow cast is sound.
		const groups = Object.entries(this.state.groups)
			.filter(([, members]) => members.includes(username))
			.map(([name]) => name);
		return {
			userId: username,
			username,
			userSub: user.userSub,
			groups,
			attributes: { ...user.attributes },
		} as CognitoUser<O>;
	}

	private codeDeliveryFor(attrs: Record<string, string>, code: string): CodeDeliveryDetails {
		void code;
		if (attrs.email) {
			return { destination: redact(attrs.email, 'email'), deliveryMedium: 'EMAIL', attributeName: 'email' };
		}
		if (attrs.phone_number) {
			return {
				destination: redact(attrs.phone_number, 'phone'),
				deliveryMedium: 'SMS',
				attributeName: 'phone_number',
			};
		}
		return { destination: '(no contact)', deliveryMedium: 'EMAIL', attributeName: 'email' };
	}

	// ── Persistence + registration ────────────────────────────────────────

	private loadFromDisk(): PersistedState {
		if (existsSync(this.stateFile)) {
			try {
				const raw = JSON.parse(readFileSync(this.stateFile, 'utf8')) as PersistedState;
				return {
					users: raw.users ?? {},
					groups: raw.groups ?? {},
					codes: raw.codes ?? {},
					challenges: raw.challenges ?? {},
					sessionSecret: raw.sessionSecret ?? crypto.randomBytes(32).toString('hex'),
				};
			} catch (e) {
				// Parse failure: preserve the bad file instead of silently nuking
				// it. Dev seeing "all my test users disappeared" can inspect the
				// `.corrupt-<ISO>` sibling. T3.6's atomic flush should make
				// partial-write-on-kill impossible, but JSON can still go bad
				// from a manual edit, a bad merge, or a disk error.
				const backup = `${this.stateFile}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
				try {
					renameSync(this.stateFile, backup);
					this.log.warn(
						`state file '${this.stateFile}' failed to parse; preserved as '${backup}' and starting fresh`,
						{ error: e instanceof Error ? e.message : 'unknown' },
					);
				} catch {
					// File may have vanished between existsSync and renameSync;
					// nothing useful to do here.
				}
			}
		}
		return {
			users: {},
			groups: {},
			codes: {},
			challenges: {},
			sessionSecret: crypto.randomBytes(32).toString('hex'),
		};
	}

	private flushToDisk(): void {
		// `this.challenges` is a Map held in memory; mirror it into `state` so
		// the serialized snapshot preserves in-flight MFA challenges across a
		// dev-server restart.
		this.state.challenges = Object.fromEntries(this.challenges);
		// Write-then-rename is atomic on POSIX — either the new file replaces
		// the old atomically, or nothing happens. Prevents a process killed
		// mid-write from leaving a half-serialized JSON that loadFromDisk then
		// fails to parse and (pre-T3.7) silently resets to empty state.
		const tmp = `${this.stateFile}.tmp`;
		writeFileSync(tmp, JSON.stringify(this.state, null, 2));
		renameSync(tmp, this.stateFile);
	}

	/**
	 * Write the most-recently-issued verification code to disk so e2e tests
	 * can retrieve it without mailbox delivery. **Test scaffolding only** —
	 * not secure storage, and the file lives inside `.bb-data/<fullId>/`
	 * which is gitignored at the repo root. Overwritten on every code
	 * issuance, so only the last code of any purpose is visible.
	 */
	private writeLastCode(purpose: string, username: string, code: string): void {
		const path = join(getMockDataDir(this), 'last-code.json');
		writeFileSync(path, JSON.stringify({ username, code, purpose }, null, 2));
	}

	private seedGroups(): void {
		for (const g of this.options.groups ?? []) {
			const name = typeof g === 'string' ? g : g.name;
			if (!this.state.groups[name]) this.state.groups[name] = [];
		}
		this.flushToDisk();
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Utility helpers (module-local)
// ─────────────────────────────────────────────────────────────────────────────

function redact(value: string, kind: 'email' | 'phone'): string {
	if (kind === 'email') {
		const [local, domain] = value.split('@');
		if (!domain) return value;
		return `${local.slice(0, 1)}***@${domain.slice(0, 1)}***`;
	}
	// Phone: show last 4 digits only
	return value.replace(/.(?=.{4})/g, '*');
}

function generateTotpSecret(): string {
	// 20 bytes of entropy, base32-encoded per RFC 4648. `crypto` doesn't
	// ship base32, so hand-roll it — tiny and used only here.
	const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
	const bytes = crypto.randomBytes(20);
	let bits = '';
	for (const b of bytes) bits += b.toString(2).padStart(8, '0');
	let out = '';
	for (let i = 0; i < bits.length; i += 5) {
		const chunk = bits.slice(i, i + 5).padEnd(5, '0');
		out += alphabet[parseInt(chunk, 2)];
	}
	return out;
}

/**
 * Build a JWT-shaped string the real `decodeIdToken` / `jwtExpMs` helpers
 * can parse. The mock never verifies signatures; the "signature" slot is
 * a fixed placeholder. Caller supplies the payload claims (which must
 * include `exp` as seconds-since-epoch for `jwtExpMs` to work).
 */
function issueMockJwt(payload: Record<string, unknown>): string {
	const header = { alg: 'none', typ: 'JWT' };
	const body = {
		iss: 'https://mock.bb-auth-cognito',
		aud: 'mock-client',
		iat: Math.floor(Date.now() / 1000),
		...payload,
	};
	const b64 = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url');
	return `${b64(header)}.${b64(body)}.mock-signature`;
}
