// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { isBlocksError } from '@aws-blocks/core';

/**
 * The canonical auth error vocabulary shared by AWS Blocks auth Building Blocks.
 *
 * Each value is the `name` of the `ApiError` an auth BB throws (and the
 * `errorName` it puts on a failed `AuthState`). Errors cross the wire by
 * `name`, so these values are a public contract: match on them with
 * {@link isAuthError} (or `isBlocksError` from `@aws-blocks/core`) on a thrown
 * error, and with `hasAuthError(state, AuthErrors.X)` on a returned
 * `AuthState` — both work the same server- and client-side.
 *
 * Values keep Amazon Cognito's wire names wherever Cognito has one, so they
 * are familiar and searchable; the federation (redirect-flow) names keep the
 * same `*Exception` suffix for consistency.
 *
 * `Auth` throws these names, as `AuthCognito` and `AuthOIDC` did. The removed
 * `AuthBasic` threw its own `AuthBasicErrors` names (for example
 * `SessionExpiredException` rather than `NotAuthenticatedException`); code moving
 * from it must switch to these names (see `@aws-blocks/bb-auth`'s `MIGRATION.md`).
 *
 * @example
 * ```typescript
 * import { AuthErrors, isAuthError } from '@aws-blocks/auth-common';
 *
 * try {
 *   await api.getProfile();
 * } catch (e: unknown) {
 *   if (isAuthError(e, AuthErrors.NotAuthenticated)) {
 *     showSignIn();
 *   }
 * }
 * ```
 */
export const AuthErrors = {
	// ── session / authorization ────────────────────────────────────────────────
	/** No valid session (HTTP 401). The client should send the user to sign-in. */
	NotAuthenticated: 'NotAuthenticatedException',
	/**
	 * Credentials rejected, or the signed-in user lacks the required role. Sign-in
	 * reports unknown user, wrong password and disabled user identically under
	 * this name so the response does not reveal which accounts exist.
	 */
	NotAuthorized: 'NotAuthorizedException',
	/** The user must reset their password before they can sign in. */
	PasswordResetRequired: 'PasswordResetRequiredException',
	/** The session's refresh token was rejected or has expired. */
	TokenExpired: 'TokenExpiredException',
	/** The session is valid but too old for an operation that requires a recent sign-in. */
	ReauthenticationRequired: 'ReauthenticationRequiredException',

	// ── sign-up / users ───────────────────────────────────────────────────────
	/** A user with this username already exists. */
	UserAlreadyExists: 'UsernameExistsException',
	/** The user signed up but has not confirmed their account yet. */
	UserNotConfirmed: 'UserNotConfirmedException',
	/** No such user. Returned by privileged (admin) operations only — never by a public sign-in path. */
	UserNotFound: 'UserNotFoundException',
	/** Email or phone alias already in use on another user in this pool. */
	AliasExists: 'AliasExistsException',
	/** The user is in a state that does not allow this operation. */
	UnsupportedUserState: 'UnsupportedUserStateException',

	// ── credentials / codes ───────────────────────────────────────────────────
	/** The password does not meet the password policy. */
	InvalidPassword: 'InvalidPasswordException',
	/** The submitted verification or MFA code is wrong. Retry with the correct code. */
	CodeMismatch: 'CodeMismatchException',
	/** The verification code has expired. Request a new code. */
	ExpiredCode: 'ExpiredCodeException',
	/** A request parameter is missing or malformed. */
	InvalidParameter: 'InvalidParameterException',

	// ── MFA ───────────────────────────────────────────────────────────────────
	/** The requested MFA method is not set up for this user. */
	MFAMethodNotFound: 'MFAMethodNotFoundException',
	/** Authenticator-app (TOTP) MFA is not set up for this user. */
	SoftwareTokenMFANotFound: 'SoftwareTokenMFANotFoundException',
	/**
	 * The TOTP code submitted while setting up an authenticator app does not
	 * match. Distinct from `CodeMismatchException`, which the post-enrollment
	 * sign-in challenge throws. Retriable on the same session.
	 */
	EnableSoftwareTokenMFA: 'EnableSoftwareTokenMFAException',

	// ── passkeys / WebAuthn ───────────────────────────────────────────────────
	/** Passkeys are not enabled for this user pool. */
	WebAuthnNotEnabled: 'WebAuthnNotEnabledException',
	/** The passkey assertion came from an origin that is not allow-listed. */
	WebAuthnOriginNotAllowed: 'WebAuthnOriginNotAllowedException',
	/** The credential's relying-party id does not match the pool's configuration. */
	WebAuthnRelyingPartyMismatch: 'WebAuthnRelyingPartyMismatchException',
	/** The WebAuthn challenge expired or the session was lost — restart the flow. */
	WebAuthnChallengeNotFound: 'WebAuthnChallengeNotFoundException',
	/** The credential type or algorithm is not supported by the pool's configuration. */
	WebAuthnCredentialNotSupported: 'WebAuthnCredentialNotSupportedException',
	/** The passkey assertion was issued for a different app client. */
	WebAuthnClientMismatch: 'WebAuthnClientMismatchException',
	/** The pool is missing the WebAuthn configuration (relying-party id / origins) passkeys need. */
	WebAuthnConfigurationMissing: 'WebAuthnConfigurationMissingException',

	// ── federation / redirect flow ────────────────────────────────────────────
	/** The requested sign-in provider is not configured on this auth block. */
	ProviderNotConfigured: 'ProviderNotConfiguredException',
	/** The sign-in provider is configured but its configuration is unusable at runtime. */
	ProviderMisconfigured: 'ProviderMisconfiguredException',
	/** The identity provider returned an error, or the token exchange with it failed. */
	IdpError: 'IdpErrorException',
	/** The sign-in `state` parameter is missing, invalid, or does not match. */
	InvalidState: 'InvalidStateException',
	/** The provider callback is missing required parameters. */
	InvalidCallback: 'InvalidCallbackException',
	/** A post-sign-in relay target was rejected. */
	InvalidRelay: 'InvalidRelayException',
	/** The client SDK is too old for this server's sign-in flow. */
	SdkOutdated: 'SdkOutdatedException',

	// ── mode gates ────────────────────────────────────────────────────────────
	/** An email-and-password method was called on an auth block that has email and password sign-in turned off. */
	EmailPasswordNotEnabled: 'EmailPasswordNotEnabledException',
	/** A federated sign-in method was called on an auth block with no federated provider. */
	NoFederatedProvider: 'NoFederatedProviderException',

	// ── throttling / service ──────────────────────────────────────────────────
	/** A service limit was exceeded (for example, too many codes requested). Retry later. */
	LimitExceeded: 'LimitExceededException',
	/** Request rate too high. Retry with backoff. */
	TooManyRequests: 'TooManyRequestsException',
	/** Too many failed attempts; the operation is temporarily locked. */
	TooManyFailedAttempts: 'TooManyFailedAttemptsException',
	/**
	 * The named group does not exist. Deliberately carries Cognito's wire name
	 * `ResourceNotFoundException` rather than a group-specific one.
	 */
	GroupNotFound: 'ResourceNotFoundException',
	/** An auth Lambda trigger returned a malformed response. */
	InvalidLambdaResponse: 'InvalidLambdaResponseException',
	/** An auth Lambda trigger rejected the request. */
	UserLambdaValidation: 'UserLambdaValidationException',
	/** Rare service-side failure. Safe to retry with backoff. */
	InternalError: 'InternalErrorException',
} as const;

/**
 * Union of every error-name string literal in {@link AuthErrors} — the values
 * {@link isAuthError} matches against.
 */
export type AuthErrorName = (typeof AuthErrors)[keyof typeof AuthErrors];

const AUTH_ERROR_NAMES: ReadonlySet<string> = new Set<string>(Object.values(AuthErrors));

/**
 * Whether `value` is one of the names in {@link AuthErrors}.
 *
 * Useful on the `setAuthState` path, where a failed `AuthState` carries the
 * error as a plain `errorName` string rather than a thrown `Error`.
 *
 * @example
 * ```typescript
 * const next = await authApi.setAuthState({ action: 'signIn', username, password });
 * if (isAuthErrorName(next.errorName)) {
 *   // next.errorName is narrowed to AuthErrorName
 * }
 * ```
 */
export function isAuthErrorName(value: unknown): value is AuthErrorName {
	return typeof value === 'string' && AUTH_ERROR_NAMES.has(value);
}

/**
 * Type guard for narrowing an `unknown` catch variable against the
 * {@link AuthErrors} vocabulary.
 *
 * - With a `name`, it is `isBlocksError` from `@aws-blocks/core` restricted to
 *   auth names, so a typo or a name outside the vocabulary is a compile error.
 * - Without a `name`, it matches any error whose `name` is in
 *   {@link AuthErrors}. This checks vocabulary membership only: names such as
 *   `InvalidParameterException` or `ResourceNotFoundException` are not unique
 *   to auth, so prefer passing the specific `name` you handle.
 *
 * Checks `error.name`, so it behaves identically on the server and on the
 * client, where the `ApiError` reconstructed from the wire keeps its name.
 *
 * @param e - The caught value.
 * @param name - The specific `AuthErrors` value to match. Omit to match any auth error name.
 * @returns `true` when `e` is an `Error` whose `name` matches.
 *
 * @example
 * ```typescript
 * try {
 *   await api.getProfile();
 * } catch (e: unknown) {
 *   if (isAuthError(e, AuthErrors.NotAuthenticated)) {
 *     // e is narrowed to Error & { name: 'NotAuthenticatedException' }
 *   } else if (isAuthError(e)) {
 *     // e.name is narrowed to AuthErrorName
 *   }
 * }
 * ```
 */
export function isAuthError<N extends AuthErrorName = AuthErrorName>(e: unknown, name?: N): e is Error & { name: N } {
	if (name !== undefined) return isBlocksError(e, name);
	return e instanceof Error && isAuthErrorName(e.name);
}
