// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The engine contracts `AuthBase` delegates to (design 04 §7.0).
 *
 * `AuthBase` owns everything engine-agnostic: the session cookie and session
 * store, the auto-sign-in bridge cookie, `requireAuth` / `requireRole` /
 * `checkAuth` / `getCurrentUser` / `getAuthSession` / `signOut`, the
 * `AuthState` machine behind `createApi()`, `validateUser` / `onSignIn` /
 * `onSignOut` dispatch, the runtime mode gates and the error policy. Engines
 * only talk to an identity service and return **data**; they never read or
 * write cookies and never touch the session store.
 *
 * - {@link NativeEngine} — the Cognito user pool: email + password sign-in and
 *   its challenges, token refresh, live group reads, passkeys, the signed-in
 *   user's own account ({@link NativeAccountEngine}: attributes, MFA, devices,
 *   self-deletion) and the opt-in admin surface ({@link NativeAdminEngine}).
 *   Implemented by `engines/native-cognito.ts` (D5c, real SDK; the account and
 *   admin surface by D5c2, the admin half in `native-cognito-admin.ts`) and
 *   `engines/native-mock*.ts` (D5b, local).
 * - {@link FederationEngine} — one per configured provider: the redirect
 *   sign-in, refresh and sign-out. Implemented by `federation-direct.ts`,
 *   `federation-hosted-ui.ts` and `stub-idp.ts` (D6).
 *
 * ## Errors
 *
 * Engines may throw raw service errors (an SDK error whose `name` is the
 * Cognito exception name) or `ApiError`s. `AuthBase` passes everything through
 * `toAuthApiError` (`error-mapping.ts`) with the public flow it knows
 * (`signIn`, `challenge`, `confirmCode`), so engines do not need to mask user
 * enumeration on those paths. Where only the engine knows the flow — a
 * challenge answered with a password — the engine maps with
 * `toAuthApiError(e, host.log, 'signIn')` itself and throws the `ApiError`.
 * Engines must apply the enumeration helpers in `enumeration.ts` on the paths
 * `AuthBase` cannot see into: an unknown user's `resetPassword` returns
 * `fabricateCodeDelivery(...)`, and `resendSignUpCode` for an unknown user
 * resolves normally.
 *
 * Account *state* (FX3) is the opposite: an engine reports it raw, exactly as
 * Cognito does — `confirmSignUp` for a confirmed user throws
 * `NotAuthorizedException`, `resendSignUpCode` for one throws
 * `InvalidParameterException` (and sends nothing) — and `AuthBase` decides,
 * from `emailPassword.revealExistingUsers`, whether the client may see it.
 *
 * ## "No user pool provisioned" (Q6)
 *
 * A configuration with no email + password, social, SAML or
 * `federateVia: 'cognito'` provider provisions no Cognito pool. `AuthBase`
 * decides this from the options alone (`requiresUserPool()` in
 * `cdk/contract.ts`, the same function the CDK layer uses) and then **never
 * constructs a native engine**: {@link AuthLayer.native} is not called, and
 * every pool-dependent path answers without one (password methods: the
 * `EmailPasswordNotEnabled` gate; `requireRole` for a pool session: fail
 * closed with 403). An engine therefore never has to model "no pool" itself.
 *
 * The remaining case is a deployment mismatch: the options say a pool is
 * needed but the runtime has no pool identifiers (the CDK layer did not
 * register them). The Cognito engine reads the config keys named by
 * `cognitoConfigKeys(fullId)` (`cdk/contract.ts`, byte-identical to
 * `AuthCognito`'s), registers them with `registerSdkIdentifiers` in its
 * constructor, resolves them with `getSdkIdentifiers(host.scope)` **at call
 * time** and, when they are empty,
 * throws `userPoolNotProvisioned(host.scope.fullId)` (`error-mapping.ts`): a
 * 500 `InternalErrorException` for the client, with the actionable detail in
 * the server log. Construction must never throw for this — the module is also
 * imported during client code generation, outside Lambda.
 *
 * Internal — not exported from any package entry.
 *
 * @internal
 */

import type { ChildLogger } from '@aws-blocks/bb-logger';
import type { BlocksContext, Scope } from '@aws-blocks/core';
import type { FederationRouteHost } from '../federation-routes.js';
import type { DirectSessionRecord } from '../sessions.js';
import type {
	AdminUserFilter,
	AuthOptions,
	CodeDeliveryDetails,
	ConfirmSignInOptions,
	DeviceRecord,
	MfaFactor,
	MfaSetting,
	OidcProviderOptions,
	PasskeyDescription,
	PreferredChallenge,
	ResetPasswordResult,
	SamlProviderOptions,
	SignInNextStep,
	SignInUrlOptions,
	SocialProviders,
	UpdateAttributeOutcome,
} from '../types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Shared
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Cognito-issued tokens: what a native sign-in, a native refresh, or a
 * hosted-UI federated sign-in yields. Stored verbatim as a pool session row
 * (`sessions.ts`), so `AuthCognito`'s rows and `Auth`'s are the same shape.
 *
 * The engine must have **verified** the ID token before returning it: the row
 * is trusted on later reads without re-verification (it is reached only
 * through the HMAC-signed session cookie).
 */
export interface PoolTokens {
	idToken: string;
	accessToken: string;
	/** `''` when the service issued none. */
	refreshToken: string;
}

/**
 * What every engine factory receives: the `Auth` instance and its resolved
 * configuration. Engines create their own SDK clients lazily from it.
 */
export interface EngineHost {
	/**
	 * The `Auth` instance. Use `scope.fullId` for resource names,
	 * `registerSdkIdentifiers(scope.fullId, …)` in the engine constructor and
	 * `getSdkIdentifiers(scope)` at call time, and `getMockDataDir(scope)` for
	 * mock persistence.
	 */
	readonly scope: Scope;
	/** The `Auth` instance's user-agent chain, for `customUserAgent` on SDK clients. */
	userAgentChain(): [string, string][];
	/** The options the block was constructed with (`{}` when omitted). */
	readonly options: AuthOptions;
	/** The block's logger — for detail that must not reach a client. */
	readonly log: ChildLogger;
	/** The session-signing secret (cached). Also the HMAC key for `fabricateCodeDelivery`. */
	sessionSecret(): Promise<string>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Native (user pool)
// ─────────────────────────────────────────────────────────────────────────────

/** Input to {@link NativeEngine.signUp}. */
export interface NativeSignUpInput {
	username: string;
	password: string;
	/** Attribute names already `custom:`-prefixed where declared custom. */
	attributes: Record<string, string>;
	clientMetadata?: Record<string, string>;
}

/** Result of {@link NativeEngine.signUp}. */
export interface NativeSignUpOutcome {
	/** `true` when the user needs no confirmation (never for self sign-up under Q2). */
	userConfirmed: boolean;
	/** The new user's stable id (Cognito `sub`), when known. */
	userSub?: string;
	/** Where the confirmation code went. */
	codeDeliveryDetails?: CodeDeliveryDetails;
	/**
	 * An opaque continuation for auto sign-in (Cognito's `SignUp` `Session`).
	 * `AuthBase` keeps it in the encrypted bridge cookie and hands it back to
	 * {@link NativeEngine.confirmSignUp} and {@link NativeEngine.signIn}.
	 */
	bridgeSession?: string;
}

/** Result of a native sign-in step. `AuthBase` turns `tokens` into a session. */
export type NativeSignInOutcome =
	| { status: 'signedIn'; tokens: PoolTokens }
	| { status: 'continueSignIn'; nextStep: SignInNextStep };

/**
 * The Cognito user-pool engine. Present only when the configuration has a pool
 * (see the module docs). Every method is called only after `AuthBase` has
 * applied the mode gate.
 *
 * The surface is the sign-in core below (task D5a) plus
 * {@link NativeAccountEngine} (the signed-in user's own account: attributes,
 * MFA, devices, self-deletion) and {@link NativeEngine.admin} (the opt-in admin
 * surface), added by D5b. {@link NativeCoreEngine} names the D5a subset.
 */
export interface NativeEngine extends NativeAccountEngine {
	/** Register a user; a confirmation code follows. Throw `UsernameExistsException` for an existing user. */
	signUp(input: NativeSignUpInput): Promise<NativeSignUpOutcome>;

	/**
	 * Confirm a sign-up with the emailed code. Returns the (possibly renewed)
	 * auto-sign-in continuation. `AuthBase` maps an unknown user like a wrong code.
	 */
	confirmSignUp(input: { username: string; code: string; bridgeSession?: string }): Promise<{
		bridgeSession?: string;
	}>;

	/** Send a new sign-up code. Must resolve normally for an unknown user (no enumeration). */
	resendSignUpCode(username: string): Promise<void>;

	/**
	 * First-factor sign-in. `password` is `''` for a passwordless / passkey
	 * first factor (`preferredChallenge`). `bridgeSession` is set on the
	 * auto-sign-in path. `AuthBase` makes every credential failure uniform.
	 */
	signIn(input: {
		username: string;
		password: string;
		clientMetadata?: Record<string, string>;
		preferredChallenge?: PreferredChallenge;
		bridgeSession?: string;
	}): Promise<NativeSignInOutcome>;

	/** Answer a challenge from a previous step (`session` is `nextStep.session`). */
	confirmSignIn(input: {
		session: string;
		response: string;
		options?: ConfirmSignInOptions;
	}): Promise<NativeSignInOutcome>;

	/** Start a password reset. For an unknown user return fabricated delivery details (`fabricateCodeDelivery`). */
	resetPassword(username: string): Promise<ResetPasswordResult>;

	/** Finish a password reset. `AuthBase` maps an unknown user like a wrong code. */
	confirmResetPassword(input: { username: string; code: string; newPassword: string }): Promise<void>;

	/** Change the signed-in user's password. */
	updatePassword(input: { accessToken: string; oldPassword: string; newPassword: string }): Promise<void>;

	/**
	 * Refresh a session whose access token expired (or on `forceRefresh`).
	 * Return the new tokens (verified; `refreshToken` may be rotated or kept),
	 * or `null` when the pool **rejected** the refresh — revoked token, user
	 * disabled or deleted. On `null`, `AuthBase` deletes the session and clears
	 * the cookie (401 for `requireAuth`). Throw only for a transient failure;
	 * `AuthBase` then keeps the session and surfaces a retriable error.
	 */
	refresh(tokens: PoolTokens): Promise<PoolTokens | null>;

	/**
	 * The user's **current** group memberships (not the token claim). Throw an
	 * error named `UserNotFoundException` when the user no longer exists;
	 * `AuthBase` answers that with 403 (fail closed). `AuthBase` dedupes calls
	 * per request and narrows the result to the declared groups.
	 */
	listGroups(username: string): Promise<string[]>;

	/**
	 * Best-effort upstream revocation on sign-out (`global`: every device).
	 * Errors are logged by `AuthBase` and never block the local sign-out.
	 */
	signOut(tokens: PoolTokens, options: { global: boolean }): Promise<void>;

	/** Passkeys (`passkeys` option). Each takes the signed-in user's access token. */
	startPasskeyRegistration(accessToken: string): Promise<{ credentialCreationOptions: string }>;
	completePasskeyRegistration(accessToken: string, credential: string): Promise<void>;
	listPasskeys(accessToken: string): Promise<PasskeyDescription[]>;
	deletePasskey(accessToken: string, credentialId: string): Promise<void>;

	/**
	 * The opt-in admin surface (`admin` option). `AuthBase` reaches it only
	 * when `options.admin` is set, after the `admin.actions` runtime gate, so an
	 * engine may build it lazily. See {@link NativeAdminEngine}.
	 */
	readonly admin: NativeAdminEngine;
}

/**
 * The D5a subset of {@link NativeEngine}: sign-up, sign-in and its challenges,
 * password reset, refresh, live groups, sign-out and passkeys — everything
 * except {@link NativeAccountEngine} and `admin`. Both shipped engines
 * implement the full `NativeEngine` (the Cognito engine since D5c2, which also
 * removed the `withPendingNativeSurface()` bridge that completed this subset
 * with 501s); the name remains to document the D5a subset.
 */
export type NativeCoreEngine = Omit<NativeEngine, keyof NativeAccountEngine | 'admin'>;

// ─────────────────────────────────────────────────────────────────────────────
// Native — the signed-in user's own account (D5b)
// ─────────────────────────────────────────────────────────────────────────────
//
// Every method takes the signed-in user's **access token** (from the session
// row; `AuthBase` refreshes it first when it has expired) and maps 1:1 onto a
// Cognito access-token API. `AuthBase` owns the guards: it resolves the session
// (401 when signed out), applies the mode gates (`MfaGate`, `PasswordGate`)
// and refuses directly federated sessions (no pool record). Attribute names
// arrive already `custom:`-prefixed where declared custom.
//
// Errors: throw the service error as-is (an SDK error whose `name` is the
// Cognito exception name, or an `ApiError`); `AuthBase` maps it with
// `toAuthApiError` (no enumeration flow — these are authenticated calls). One
// name is special: throw (or pass through) `UserNotFoundException` when the
// token's user no longer exists — `AuthBase` then deletes the session, clears
// the cookie and answers 401 `NotAuthenticatedException`, so no public path
// ever reports `UserNotFoundException`. A revoked token (`NotAuthorizedException`
// "Access Token has been revoked") passes through as the 401 it is.

/** Input to {@link NativeAccountEngine.updateMfaPreference}: a per-factor delta (omitted = unchanged). */
export interface NativeMfaPreferenceInput {
	sms?: MfaSetting;
	totp?: MfaSetting;
	email?: MfaSetting;
}

/** Result of {@link NativeAccountEngine.getMfaPreference}. */
export interface NativeMfaPreference {
	/** Enabled factors, in a stable order. Unfiltered: `AuthBase` narrows to the configured `mfa.types`. */
	enabled: MfaFactor[];
	/** The preferred factor; `'NOMFA'` when the user explicitly disabled every factor; absent when none. */
	preferred?: MfaFactor | 'NOMFA';
}

/** One page of {@link NativeAccountEngine.listDevices}. */
export interface NativeDevicePage {
	devices: DeviceRecord[];
	/** Opaque continuation; absent on the last page. */
	nextToken?: string;
}

/**
 * The signed-in user's own account: attributes, self-deletion, MFA, devices.
 * Part of {@link NativeEngine}.
 */
export interface NativeAccountEngine {
	/**
	 * The user's current attributes, `custom:`-prefixed as stored (Cognito
	 * `GetUser` → `UserAttributes`). Include `sub`; `AuthBase` returns the map
	 * as-is.
	 */
	getUserAttributes(accessToken: string): Promise<Record<string, string>>;

	/**
	 * Write attributes (Cognito `UpdateUserAttributes`). Return one outcome per
	 * input key: `{ isUpdated: false, nextStep: { name: 'CONFIRM_ATTRIBUTE_WITH_CODE',
	 * codeDeliveryDetails } }` for a key the service sent a verification code for
	 * (its `CodeDeliveryDetailsList` entry), `{ isUpdated: true }` otherwise.
	 */
	updateUserAttributes(
		accessToken: string,
		attributes: Record<string, string>,
	): Promise<Record<string, UpdateAttributeOutcome>>;

	/**
	 * Confirm a contact attribute with its code (Cognito `VerifyUserAttribute`).
	 * Throw `CodeMismatchException` / `ExpiredCodeException` for a bad code.
	 */
	confirmUserAttribute(accessToken: string, name: string, code: string): Promise<void>;

	/** Send a verification code for a contact attribute (Cognito `GetUserAttributeVerificationCode`). */
	sendUserAttributeVerificationCode(accessToken: string, name: string): Promise<void>;

	/**
	 * Delete the user (Cognito `DeleteUser`). `AuthBase` then deletes the
	 * session row and clears the cookie.
	 */
	deleteUser(accessToken: string): Promise<void>;

	/**
	 * Start authenticator-app enrolment (Cognito `AssociateSoftwareToken`):
	 * return the base32 shared secret (`SecretCode`).
	 */
	setUpTotp(accessToken: string): Promise<{ sharedSecret: string }>;

	/**
	 * Finish authenticator-app enrolment (Cognito `VerifySoftwareToken`), then
	 * enrol TOTP as an enabled MFA factor (Cognito: `SetUserMFAPreference` with
	 * `SoftwareTokenMfaSettings: { Enabled: true }`, preferred only if the user has
	 * no preferred factor yet — `AuthCognito`'s mock behaviour). Throw
	 * `EnableSoftwareTokenMFAException` (or `CodeMismatchException`) when the code
	 * is rejected — including a `Status: 'ERROR'` response — and
	 * `SoftwareTokenMFANotFoundException` when `setUpTotp` was not called.
	 */
	verifyTotpSetup(accessToken: string, code: string): Promise<void>;

	/**
	 * Apply a per-factor delta (Cognito `SetUserMFAPreference`; `ENABLED` /
	 * `NOT_PREFERRED` → `{ Enabled: true, PreferredMfa: false }`, `PREFERRED` →
	 * `{ Enabled: true, PreferredMfa: true }`, `DISABLED` → `{ Enabled: false }`,
	 * omitted → the setting is left out). The Cognito engine sends `DISABLED` as
	 * `{ Enabled: false, PreferredMfa: false }`, byte-identical to `AuthCognito`. `AuthBase` has already rejected more
	 * than one `PREFERRED` and any factor outside the configured `mfa.types`.
	 * Throw `SoftwareTokenMFANotFoundException` when enabling TOTP for a user who
	 * has not verified an authenticator app (Cognito does this itself).
	 */
	updateMfaPreference(accessToken: string, input: NativeMfaPreferenceInput): Promise<void>;

	/**
	 * The user's MFA settings (Cognito `GetUser` → `UserMFASettingList` /
	 * `PreferredMfaSetting`: `SMS_MFA` → `SMS`, `SOFTWARE_TOKEN_MFA` → `TOTP`,
	 * `EMAIL_OTP` → `EMAIL`). The mock also reports a verified email / phone as
	 * enabled (Cognito treats them as available factors); the AWS engine reports
	 * what Cognito lists. `AuthBase` narrows the result to `mfa.types`.
	 */
	getMfaPreference(accessToken: string): Promise<NativeMfaPreference>;

	/**
	 * One page of the user's remembered devices (Cognito `ListDevices`, `Limit`
	 * ≤ 60, `PaginationToken` ↔ `nextToken`). Dates as ISO-8601 strings.
	 * `AuthBase.scanDevices` pages until `nextToken` is absent.
	 */
	listDevices(accessToken: string, options: { nextToken?: string }): Promise<NativeDevicePage>;

	/**
	 * Remember the current device (Cognito `UpdateDeviceStatus` with
	 * `DeviceRememberedStatus: 'remembered'`). The device key is the access
	 * token's `device_key` claim, present only when device tracking is on and
	 * the device was confirmed at sign-in — which needs the `ConfirmDevice` /
	 * device-verifier flow at sign-in that `Auth` does not run. **Decision
	 * (D5b review): the Cognito engine keeps `AuthCognito`'s `ApiError` 501**,
	 * with a message saying why (since D5c2 the engine itself throws it —
	 * `rememberDeviceUnsupported()` in `engines/native-cognito.ts`; it was in the
	 * deleted `engines/pending.ts`); a real implementation is new feature work,
	 * listed under "Known gaps" in `DESIGN.md` (L25).
	 */
	rememberDevice(accessToken: string): Promise<void>;

	/** Forget a remembered device (Cognito `ForgetDevice`). */
	forgetDevice(accessToken: string, deviceKey: string): Promise<void>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Native — admin (D5b)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A pool user as the admin engine reports it. `attributes` are as stored
 * (`custom:`-prefixed); `groups` is unfiltered — `AuthBase` narrows it to the
 * declared groups — and absent when the engine could not read it (a
 * hand-narrowed IAM policy without `AdminListGroupsForUser`).
 */
export interface NativeAdminUser {
	username: string;
	/** The Cognito `sub` (the `sub` attribute). */
	userSub: string;
	enabled: boolean;
	attributes: Record<string, string>;
	groups?: string[];
}

/** One page of users. */
export interface NativeAdminUserPage {
	users: NativeAdminUser[];
	/** Opaque continuation; absent on the last page. */
	nextToken?: string;
}

/**
 * The privileged admin surface behind `auth.admin` — Cognito's `Admin*` /
 * `List*` APIs on the pool, inside the trust boundary. `AuthBase` applies the
 * `admin` / `admin.actions` gates, prefixes declared custom attributes, narrows
 * groups, pages, and owns the session store (`revokeUserSessions` also deletes
 * this block's session rows).
 *
 * Errors pass through `toAuthApiError` with **no** enumeration masking: throw
 * `UserNotFoundException` for an unknown user and `ResourceNotFoundException`
 * (`AuthErrors.GroupNotFound`) for an unknown group — they reach the caller as
 * 404s. `admin.listGroupsForUser` uses {@link NativeEngine.listGroups}.
 */
export interface NativeAdminEngine {
	/** `AdminAddUserToGroup`. Idempotent. */
	addUserToGroup(username: string, group: string): Promise<void>;
	/** `AdminRemoveUserFromGroup`. Idempotent. */
	removeUserFromGroup(username: string, group: string): Promise<void>;
	/** One page of `ListUsersInGroup` (`NextToken` ↔ `nextToken`). Throw `ResourceNotFoundException` for an unknown group. */
	listUsersInGroup(group: string, options: { nextToken?: string }): Promise<NativeAdminUserPage>;
	/**
	 * `AdminCreateUser`: a confirmed user in `FORCE_CHANGE_PASSWORD`, with
	 * `TemporaryPassword` (the engine generates a policy-compliant one when
	 * omitted), `UserAttributes` (already prefixed; when the pool signs in with
	 * email/phone only, the username is also the alias attribute) and
	 * `MessageAction: 'SUPPRESS'` when `suppressInvite`. Throw
	 * `UsernameExistsException` for an existing user.
	 *
	 * The Cognito engine sends what `AuthCognito` sent: no `TemporaryPassword`
	 * when omitted (Cognito then generates one that meets the pool policy) and
	 * the attributes as given (no alias copy of the username). The result's
	 * `groups` is `[]` (a new user is in no group).
	 */
	createUser(
		username: string,
		init: {
			temporaryPassword?: string;
			attributes: Record<string, string>;
			suppressInvite?: boolean;
			/** `ClientMetadata` for the pool's PreSignUp trigger (the "validated in-process" marker). */
			clientMetadata?: Record<string, string>;
		},
	): Promise<NativeAdminUser>;
	/** `AdminDeleteUser`. */
	deleteUser(username: string): Promise<void>;
	/** `AdminDisableUser`. */
	disableUser(username: string): Promise<void>;
	/** `AdminEnableUser`. */
	enableUser(username: string): Promise<void>;
	/** `AdminResetUserPassword` — the user must reset their password before signing in. */
	resetUserPassword(username: string): Promise<void>;
	/** `AdminSetUserPassword` with `Permanent: options.permanent`. */
	setUserPassword(username: string, password: string, options: { permanent: boolean }): Promise<void>;
	/**
	 * `AdminGetUser` (+ `AdminListGroupsForUser` for `groups`). Return `null` for
	 * an unknown user — never throw `UserNotFoundException` here (G3).
	 */
	getUser(username: string): Promise<NativeAdminUser | null>;
	/**
	 * One page of `ListUsers` (`Limit` ≤ 60, `PaginationToken` ↔ `nextToken`).
	 * `filter` maps to the `Filter` expression
	 * `` `${attribute} ${match === 'startsWith' ? '^=' : '='} "${value}"` `` with
	 * `"` escaped. `groups` may be omitted from listed users.
	 */
	listUsers(options: { filter?: AdminUserFilter; nextToken?: string }): Promise<NativeAdminUserPage>;
	/**
	 * `AdminUserGlobalSignOut`: revoke every refresh token the user holds, so
	 * their sessions end at the next refresh. `AuthBase` additionally deletes
	 * this block's session rows for the user, which makes the revocation
	 * immediate.
	 */
	globalSignOut(username: string): Promise<void>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Federation (per provider)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A configured provider, resolved from the options: which record it came from
 * and which transport serves it. Engine selection is **per provider**.
 */
export type ResolvedProvider =
	| {
			id: string;
			family: 'social';
			/** Social providers always federate through Cognito's managed login. */
			transport: 'hosted-ui';
			label: string;
			config: NonNullable<SocialProviders[keyof SocialProviders]>;
	  }
	| {
			id: string;
			family: 'oidc';
			/** `'direct'` unless the provider sets `federateVia: 'cognito'`. */
			transport: 'direct' | 'hosted-ui';
			label: string;
			config: OidcProviderOptions;
	  }
	| { id: string; family: 'saml'; transport: 'hosted-ui'; label: string; config: SamlProviderOptions };

/**
 * The identity a completed federated sign-in yields. `AuthBase` runs
 * `validateUser`, issues the session and calls `onSignIn`.
 */
export type FederatedIdentity =
	/** Hosted UI (social, SAML, `federateVia: 'cognito'`): Cognito-issued, verified tokens. */
	| { kind: 'pool'; tokens: PoolTokens }
	/** Direct OIDC: the verified ID token's identity; no Cognito record. */
	| {
			kind: 'direct';
			issuer: string;
			subject: string;
			/** Verified ID-token claims, before attribute mapping. */
			claims: Record<string, unknown>;
			/** From `groupsClaim`, before narrowing to the declared groups. */
			groups: string[];
			/** When the session must be refreshed, ms since the epoch. */
			expiresAt: number;
			idToken?: string;
			accessToken?: string;
			refreshToken?: string;
	  };

/**
 * One configured federated provider's transport.
 */
export interface FederationEngine {
	/**
	 * Build the authorize URL (the IdP's, or Cognito managed login's) and set
	 * whatever pending-auth state the callback needs (PKCE verifier, nonce,
	 * `state`) as a cookie on `context.response`. The `GET
	 * /aws-blocks/auth/signin/<id>` route 302s to it.
	 *
	 * @throws `ApiError` `ProviderMisconfiguredException` when the provider cannot be reached (e.g. discovery failed).
	 */
	buildSignInUrl(context: BlocksContext, options: SignInUrlOptions): Promise<string>;

	/**
	 * Complete the redirect on the callback route: check `state`, exchange the
	 * code (with PKCE), verify the ID token, clear the pending-auth cookie.
	 *
	 * @throws `ApiError` `InvalidStateException` / `InvalidCallbackException` / `IdpErrorException`.
	 */
	completeSignIn(context: BlocksContext): Promise<FederatedIdentity>;

	/**
	 * Refresh an expiring session this provider issued. `pool` for hosted-UI
	 * providers, `direct` for direct OIDC. Same contract as
	 * {@link NativeEngine.refresh}: `null` = rejected (signed out), throw =
	 * transient.
	 */
	refresh(
		session: { kind: 'pool'; tokens: PoolTokens } | { kind: 'direct'; record: DirectSessionRecord },
	): Promise<{ kind: 'pool'; tokens: PoolTokens } | { kind: 'direct'; record: DirectSessionRecord } | null>;

	/**
	 * Best-effort upstream revocation. Return `logoutUrl` when the provider
	 * keeps its own session that would otherwise silently re-authenticate the
	 * user (Cognito managed login's `/logout`, an OIDC `end_session_endpoint`);
	 * the sign-out route redirects there (design 04 §4.5).
	 */
	signOut(
		session: { kind: 'pool'; tokens: PoolTokens } | { kind: 'direct'; record: DirectSessionRecord },
		context: BlocksContext,
	): Promise<{ logoutUrl?: string }>;

	// ── Client-driven transports (D6a; optional) ────────────────────────────
	//
	// The browser-PKCE and native-relay transports let the *client* run PKCE
	// and talk to the IdP; the server only hands out public parameters and
	// exchanges the code. An engine that omits these answers the matching
	// routes with 501 (`federation-routes.ts`).

	/**
	 * Exchange a code the client obtained with its own PKCE (`POST
	 * /aws-blocks/auth/exchange`) and verify the result exactly like
	 * {@link completeSignIn}.
	 *
	 * @throws `ApiError` `IdpErrorException` / `InvalidCallbackException`.
	 */
	exchangeCode?(context: BlocksContext, input: CodeExchangeInput): Promise<FederatedIdentity>;

	/**
	 * The public authorize parameters (`GET|POST /aws-blocks/auth/authorize-params/<id>`):
	 * never a secret.
	 */
	authorizeParams?(context: BlocksContext): Promise<PublicAuthorizeParams>;

	/**
	 * Refresh a native client's bearer tokens from a raw refresh token
	 * (`POST /aws-blocks/auth/refresh`, only with `allowBearerAuth`). `null`
	 * when the provider rejected the token.
	 */
	refreshBearer?(context: BlocksContext, refreshToken: string): Promise<BearerTokens | null>;

	/**
	 * Verify an `Authorization: Bearer` access token this provider issued
	 * (`allowBearerAuth`, D6c) and return its subject, or `null` when the token
	 * is not this provider's or does not verify — a foreign issuer, an opaque
	 * token, a bad signature, audience or expiry. **Never throws.** Optional: an
	 * engine without it accepts no bearer tokens. Hosted-UI providers omit it;
	 * their users carry Cognito access tokens, which the layer's
	 * {@link AuthLayer.poolBearer} verifier checks.
	 */
	verifyBearer?(context: BlocksContext, token: string): Promise<DirectBearerIdentity | null>;
}

/**
 * The subject of a verified direct-OIDC bearer access token (see
 * {@link FederationEngine.verifyBearer}). `AuthBase` projects it exactly like a
 * direct sign-in: identity `` `${issuer}:${subject}` ``, groups from `groupsClaim`.
 */
export interface DirectBearerIdentity {
	issuer: string;
	subject: string;
	/** The verified access-token claims. */
	claims: Record<string, unknown>;
	/** From `groupsClaim` in the access token, before narrowing to the declared groups. */
	groups: string[];
	/** The token's `exp`, ms since the epoch. */
	expiresAt: number;
}

/**
 * Verifies a Cognito (pool) access token presented as `Authorization: Bearer`
 * (`allowBearerAuth`, D6c). Built by {@link AuthLayer.poolBearer}: the AWS layer
 * checks a real Cognito access token (`aws-jwt-verify`, `token_use: access`,
 * the native or the hosted-UI client); the local layer accepts only tokens its
 * own mock pool minted and still recognises.
 */
export interface PoolBearerVerifier {
	/**
	 * The verified access-token claims, and whether the token was issued to the
	 * hosted-UI client (a Cognito-federated sign-in) rather than the native one.
	 * `null` for anything else. **Never throws.**
	 */
	verify(accessToken: string): Promise<{ claims: Record<string, unknown>; hostedUi: boolean } | null>;
}

/** Input to {@link FederationEngine.exchangeCode}. */
export interface CodeExchangeInput {
	/** The authorization code the IdP returned to the client. */
	code: string;
	/** The client's PKCE verifier. */
	codeVerifier: string;
	/** The exact `redirect_uri` the client sent to the IdP. */
	redirectUri: string;
	/** The ID-token `nonce` the client sent (`''` when it sent none). */
	nonce: string;
	/** The RFC 9207 `iss` response parameter, when the IdP returned one. */
	iss?: string;
}

/** What {@link FederationEngine.authorizeParams} returns (the native SDKs' wire shape, minus `state`/`nonce`). */
export interface PublicAuthorizeParams {
	/** The IdP's (or managed login's) authorization endpoint. */
	authorizeUrl: string;
	clientId: string;
	scopes: readonly string[];
	/** The provider kind on the wire: `'oidc-custom'`, `'oauth2-custom'` or `'stub'` (as `AuthOIDC`). */
	kind: string;
	/** Whether the provider verifies an OIDC `nonce` (a relay response then carries one). */
	usesNonce: boolean;
}

/** Bearer tokens for a native client (`allowBearerAuth`). */
export interface BearerTokens {
	accessToken: string;
	/** Rotated by the provider, or the one presented when it did not rotate. */
	refreshToken: string;
	/** Access-token lifetime in seconds. */
	expiresIn: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Layer wiring
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What a runtime entry (`index.mock.ts`, `index.aws.ts`) supplies to `AuthBase`.
 * Factories receive the {@link EngineHost} so engines can register and resolve
 * SDK identifiers against the `Auth` instance.
 */
export interface AuthLayer {
	/**
	 * Where the session-signing secret comes from. AWS: the `session-secret`
	 * `AppSetting` child (the same SSM parameter `AuthCognito` uses). Mock:
	 * `.bb-data/<fullId>/state.json` (the same file `AuthCognito`'s mock uses).
	 * Called once, in the constructor; the returned function is called per
	 * request and should cache.
	 */
	sessionSecret(auth: Scope): () => Promise<string>;

	/** Build the native engine. Not called when the configuration has no user pool. */
	native(host: EngineHost): NativeEngine;

	/** Build the engine for one federated provider. */
	federation(host: EngineHost, provider: ResolvedProvider): FederationEngine;

	/**
	 * Mount the federation HTTP routes (D6a — `mountFederationRoutes` from
	 * `federation-routes.ts`). Called once by the constructor, only when a
	 * provider is configured. Optional: a layer without it (a test harness)
	 * mounts no routes.
	 */
	routes?(host: FederationRouteHost): void;

	/**
	 * Build the verifier for pool (Cognito) bearer access tokens. Called once by
	 * the constructor, only with `allowBearerAuth: true` and a user pool.
	 * Optional: a layer without it accepts no pool bearer tokens. What the
	 * verifier trusts is decided **here, per entry** — the local layer's accepts
	 * its mock pool's unsigned tokens; the AWS layer's accepts only
	 * Cognito-signed ones — never by a runtime flag.
	 */
	poolBearer?(host: EngineHost, native: NativeEngine): PoolBearerVerifier;

	/**
	 * Route the user pool's Cognito PreSignUp trigger to this block (decision
	 * Q10; `presignup-trigger.ts`). Called once by the constructor, only when the
	 * configuration has a user pool. The AWS layer registers `host.handle` with
	 * core's Lambda handler under the pool id — only when the CDK layer flagged
	 * this block as the trigger's owner (R2-1) — and the local layer has no
	 * trigger (the in-process check is the whole story there) and omits it.
	 */
	preSignUpTrigger?(host: PreSignUpTriggerHost): void;
}

/** What {@link AuthLayer.preSignUpTrigger} receives. */
export interface PreSignUpTriggerHost {
	/** The `Auth` instance (registers the Lambda event handler). */
	scope: Scope;
	/** Answer one trigger event: resolve to accept, throw to reject. */
	handle(event: unknown): Promise<void>;
}
