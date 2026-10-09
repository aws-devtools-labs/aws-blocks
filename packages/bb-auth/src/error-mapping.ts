// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Translate anything an engine throws into the `ApiError` a client may see.
 *
 * Policy (LATER-DISCUSSION L10, B6):
 *
 * - **Every client-visible `name` is an `AuthErrors` member.** A raw error
 *   whose name is in the vocabulary keeps it (with the HTTP status from
 *   {@link statusForAuthError}); anything else — an unmapped Cognito exception,
 *   a `TypeError`, a network failure — becomes `InternalErrorException`, HTTP
 *   500, `retriable: true`, with a generic message. The original name and
 *   message are logged server-side only.
 * - **No engine text reaches a client** (FX59, the guarantee `AuthCognito`
 *   0.1.11 shipped in #678). An error an engine throws — Cognito's, or the
 *   local engine's stand-in for it — gets the fixed, BB-authored message for
 *   its name ({@link CLIENT_ERROR_MESSAGES}); its own text is logged
 *   server-side with the login redacted ({@link withoutLogin}), at `error` for
 *   a 5xx name or text naming AWS resources and at `info` otherwise.
 * - **No AWS identifiers reach a client.** AWS access/credential failures (the
 *   function role's IAM policy, not the end user) and any message naming an
 *   ARN or a 12-digit account id are replaced by a generic message; the detail
 *   is logged.
 * - **No SDK metadata reaches a client.** The result is always a fresh
 *   `ApiError`; the original error rides along only as `cause`, which `Error`
 *   installs as a non-enumerable property, so it never serializes.
 * - **Enumeration masking** per {@link ErrorFlow} (design 04 §6.3).
 * - A `UserLambdaValidationException` that carries a `validateUser` rejection
 *   from the PreSignUp trigger (`trigger-rejection.ts`) becomes that
 *   rejection — the same name and message as the in-process check.
 * - An `ApiError` raised deliberately — by `Auth` itself, by an engine, or by
 *   application code in `validateUser` / `onSignIn` — keeps its name, status
 *   and `retriable` flag (its message is still scrubbed of AWS identifiers).
 *
 * Server-only (imports `@aws-blocks/core`'s `ApiError`). Not exported from any
 * entry point.
 *
 * @internal
 */

import type { ChildLogger } from '@aws-blocks/bb-logger';
import { ApiError } from '@aws-blocks/core';
import { incorrectCredentialsError, WRONG_CODE_MESSAGE, wrongCodeError } from './enumeration.js';
import { type AuthErrorName, AuthErrors, isRetriableAuthError, statusForAuthError } from './errors.js';
import { decodeTriggerRejection } from './trigger-rejection.js';

/**
 * Which public flow an error came from — selects the user-enumeration masking
 * {@link toAuthApiError} applies (design 04 §6.3):
 *
 * - `signIn` — a credential check (a password sign-in, or a challenge answered
 *   with a password). Unknown user, wrong password and disabled user all become
 *   the one uniform {@link incorrectCredentialsError}.
 * - `challenge` — any other sign-in challenge answer. A user who vanished
 *   mid-challenge becomes the uniform credential failure, not a 404.
 * - `confirmCode` — confirm-sign-up / confirm-reset-password. An unknown user is
 *   answered exactly like a wrong code, as Cognito itself does when the pool has
 *   `PreventUserExistenceErrors`. With {@link ErrorMappingOptions.hideAccountState}
 *   (`emailPassword.revealExistingUsers` off — the default) the answers that
 *   only an *existing* account can produce are folded into the same wrong-code
 *   error too: `NotAuthorizedException` (an already-confirmed user — "User
 *   cannot be confirmed. Current status is CONFIRMED" — or a disabled one) and
 *   `ExpiredCodeException` (a code that was issued and has expired, or a reset
 *   that was never requested). Cognito does not mask these itself (FX3).
 *   `AliasExistsException` (a right sign-up code for an email / phone another
 *   user holds as a verified alias) is **not** folded: Cognito checks the code
 *   first, so only the holder of the code sent to that email / phone can get
 *   it, and folding it into a wrong code would leave that user retrying a
 *   right code forever (FX49).
 *
 * Omitted for authenticated and `admin.*` calls, which are not enumeration
 * surfaces (the admin API may legitimately report `UserNotFoundException`).
 *
 * @internal
 */
export type ErrorFlow = 'signIn' | 'challenge' | 'confirmCode';

/**
 * Options for {@link toAuthApiError}.
 *
 * @internal
 */
export interface ErrorMappingOptions {
	/**
	 * Hide whether an account exists and what state it is in (unconfirmed,
	 * confirmed, disabled) on the public confirm-code flows. `true` unless
	 * `emailPassword.revealExistingUsers` is set.
	 */
	hideAccountState?: boolean;
	/**
	 * The login the call was made for. Used only to redact it from the
	 * server-side log lines written when an answer or an engine's message is
	 * withheld (see {@link withoutLogin}); never sent anywhere.
	 */
	login?: string;
}

/** The marker substituted for a redacted value — the same as core's `redactForLogging`. */
const REDACTED = '[REDACTED]';

/**
 * `message` with every occurrence of `login` (case-insensitively) replaced by
 * `[REDACTED]`, for a log line that carries a Cognito message.
 *
 * bb-auth's logs identify a failure by its error name, Cognito's message and
 * the request id, never by the user's login. Cognito echoes some request
 * values in its messages (a validation error quotes the value it rejected), so
 * the withheld-answer lines — whose point is to show *why* the client got a
 * uniform answer — strip the login from the message first. Every line in this
 * module that carries a thrown error's own message goes through it, including
 * the AWS-access and out-of-vocabulary lines (FX60): an unmapped name such as
 * `CodeDeliveryFailureException` quotes the delivery destination.
 *
 * @internal
 */
export function withoutLogin(message: string, login: string | undefined): string {
	if (!login) return message;
	const escaped = login.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	return message.replace(new RegExp(escaped, 'giu'), REDACTED);
}

/**
 * On a `confirmCode` flow with `hideAccountState`, these answers reveal that the
 * account exists (or its state), so they become the uniform wrong-code error.
 */
const ACCOUNT_STATE_CONFIRM_ERRORS: ReadonlySet<string> = new Set<string>([
	AuthErrors.NotAuthorized,
	AuthErrors.ExpiredCode,
]);

/**
 * SDK error names that mean AWS refused the *function's own* credentials or IAM
 * policy — a deployment problem, not something the end user did. Their messages
 * name the execution-role ARN and the account id.
 */
const AWS_ACCESS_ERROR_NAMES: ReadonlySet<string> = new Set([
	'AccessDeniedException',
	'UnrecognizedClientException',
	'InvalidClientTokenId',
	'InvalidSignatureException',
	'ExpiredTokenException',
	'CredentialsProviderError',
]);

/**
 * An ARN (any partition) or a 12-digit AWS account id. Exported so the one
 * other place that decides a log level from external text — a federation
 * callback's `error_description`, `engines/idp-callback-error.ts` (FX60) —
 * cannot drift from this test.
 *
 * @internal
 */
export const AWS_IDENTIFIER_PATTERN = /arn:aws[a-z-]*:|(?<!\d)\d{12}(?!\d)/i;

/** Client-facing text for {@link AWS_ACCESS_ERROR_NAMES}; the detail is logged server-side. */
export const ACCESS_DENIED_MESSAGE = 'The authentication service is not permitted to complete this request.';

/** Client-facing text for a message withheld because it named AWS resources. */
export const WITHHELD_MESSAGE = 'The authentication service could not complete this request.';

/** Client-facing text for an error whose name is outside the `AuthErrors` vocabulary. */
export const INTERNAL_ERROR_MESSAGE = 'The authentication service hit an unexpected error. Please try again.';

const AUTH_ERROR_NAMES: ReadonlySet<string> = new Set<string>(Object.values(AuthErrors));

/**
 * The message a client gets for each `AuthErrors` name when the error comes
 * from an engine — Cognito, or the local engine standing in for it (FX59;
 * the guarantee `AuthCognito` 0.1.11 shipped in #678).
 *
 * Cognito's own `message` can quote the request (the login, a rejected
 * value), name an endpoint, a role or the account, and `ApiError.message`
 * crosses the RPC wire verbatim and is what the Authenticator UI shows. So
 * the client only ever sees one of these fixed, BB-authored strings, chosen
 * by the error's name; Cognito's text goes to the server log (login redacted,
 * {@link withoutLogin}). The local engine's errors take the same path, so
 * both runtimes send the same text.
 *
 * Exhaustive over `AuthErrors`, so a new name cannot ship without one. Most
 * strings are `AuthCognito`'s (#678); these differ, each to match a message
 * `Auth` already sends: `CodeMismatchException` and
 * `EnableSoftwareTokenMFAException` use the enumeration-masked wrong-code
 * text ({@link WRONG_CODE_MESSAGE}), so a real wrong code and a masked one are
 * byte-identical (FX3); `InternalErrorException` uses
 * {@link INTERNAL_ERROR_MESSAGE}; `NotAuthenticatedException` and
 * `ReauthenticationRequiredException` use the text `Auth` throws itself.
 *
 * An `ApiError` raised on purpose — by `Auth`, an engine's own check, or app
 * code (`validateUser`, `onSignIn`) — keeps its own message.
 *
 * @internal
 */
export const CLIENT_ERROR_MESSAGES: Readonly<Record<AuthErrorName, string>> = {
	[AuthErrors.NotAuthenticated]: 'Authentication required',
	[AuthErrors.NotAuthorized]: 'Not authorized',
	[AuthErrors.PasswordResetRequired]: 'Password reset required',
	[AuthErrors.TokenExpired]: 'Session expired, sign in again',
	[AuthErrors.ReauthenticationRequired]: 'Please sign in again to continue.',
	[AuthErrors.UserAlreadyExists]: 'User already exists',
	[AuthErrors.UserNotConfirmed]: 'User not confirmed',
	[AuthErrors.UserNotFound]: 'User not found',
	[AuthErrors.AliasExists]: 'Email or phone number already in use',
	[AuthErrors.UnsupportedUserState]: 'Unsupported user state',
	[AuthErrors.InvalidPassword]: 'Password does not meet the password policy',
	[AuthErrors.CodeMismatch]: WRONG_CODE_MESSAGE,
	[AuthErrors.ExpiredCode]: 'Code expired',
	[AuthErrors.InvalidParameter]: 'Invalid parameter',
	[AuthErrors.MFAMethodNotFound]: 'MFA method not found',
	[AuthErrors.SoftwareTokenMFANotFound]: 'TOTP not set up',
	[AuthErrors.EnableSoftwareTokenMFA]: WRONG_CODE_MESSAGE,
	[AuthErrors.WebAuthnNotEnabled]: 'Passkeys are not enabled for this user pool',
	[AuthErrors.WebAuthnOriginNotAllowed]: 'Passkey origin not allowed',
	[AuthErrors.WebAuthnRelyingPartyMismatch]: 'Passkey relying party mismatch',
	[AuthErrors.WebAuthnChallengeNotFound]: 'Passkey challenge expired, start again',
	[AuthErrors.WebAuthnCredentialNotSupported]: 'Passkey credential not supported',
	[AuthErrors.WebAuthnClientMismatch]: 'Passkey client mismatch',
	[AuthErrors.WebAuthnConfigurationMissing]: 'Passkey configuration missing for this user pool',
	[AuthErrors.ProviderNotConfigured]: 'Sign-in provider not configured',
	[AuthErrors.ProviderMisconfigured]: 'Sign-in provider misconfigured',
	[AuthErrors.IdpError]: 'The identity provider could not complete the sign-in',
	[AuthErrors.InvalidState]: 'Invalid sign-in state',
	[AuthErrors.InvalidCallback]: 'Invalid sign-in callback',
	[AuthErrors.InvalidRelay]: 'Invalid sign-in redirect',
	[AuthErrors.SdkOutdated]: 'Client SDK is out of date',
	[AuthErrors.EmailPasswordNotEnabled]: 'Email and password sign-in is not enabled',
	[AuthErrors.NoFederatedProvider]: 'No federated sign-in provider is configured',
	[AuthErrors.LimitExceeded]: 'Limit exceeded, try again later',
	[AuthErrors.TooManyRequests]: 'Too many requests, try again later',
	[AuthErrors.TooManyFailedAttempts]: 'Too many failed attempts, try again later',
	[AuthErrors.GroupNotFound]: 'Resource not found',
	[AuthErrors.InvalidLambdaResponse]: 'User pool Lambda trigger returned an invalid response',
	[AuthErrors.UserLambdaValidation]: 'User pool Lambda trigger rejected the request',
	[AuthErrors.InternalError]: INTERNAL_ERROR_MESSAGE,
};

function isAuthErrorName(name: string): name is AuthErrorName {
	return AUTH_ERROR_NAMES.has(name);
}

/**
 * The fixed client message for an error `name` ({@link CLIENT_ERROR_MESSAGES});
 * a name outside the vocabulary gets {@link INTERNAL_ERROR_MESSAGE}.
 *
 * @internal
 */
export function clientMessageFor(name: string): string {
	return isAuthErrorName(name) ? CLIENT_ERROR_MESSAGES[name] : INTERNAL_ERROR_MESSAGE;
}

function sdkRequestId(e: Error): string | undefined {
	const meta: unknown = Reflect.get(e, '$metadata');
	if (typeof meta !== 'object' || meta === null) return undefined;
	const requestId: unknown = Reflect.get(meta, 'requestId');
	return typeof requestId === 'string' ? requestId : undefined;
}

/** Replace a message that names AWS resources; log the original. */
function scrubMessage(message: string, name: string, log: ChildLogger, e: Error): string {
	if (!AWS_IDENTIFIER_PATTERN.test(message)) return message;
	log.error('[bb-auth] error message withheld from the client (it names AWS resources)', {
		error: name,
		message,
		requestId: sdkRequestId(e),
	});
	return WITHHELD_MESSAGE;
}

/**
 * Translate a thrown value into the `ApiError` the client sees. See the module
 * documentation for the policy.
 *
 * @param e - Whatever was thrown.
 * @param log - Where withheld detail goes.
 * @param flow - The public flow, for enumeration masking.
 * @param options - Account-state hiding (see {@link ErrorMappingOptions}).
 *
 * @internal
 */
export function toAuthApiError(
	e: unknown,
	log: ChildLogger,
	flow?: ErrorFlow,
	options: ErrorMappingOptions = {},
): ApiError {
	if (e instanceof ApiError) {
		const message = scrubMessage(e.message, e.name, log, e);
		if (message === e.message) return e;
		return new ApiError(message, e.status, { name: e.name, cause: e, ...(e.retriable ? { retriable: true } : {}) });
	}
	if (!(e instanceof Error)) {
		log.error('[bb-auth] non-Error value thrown; reported to the client as an internal error', {
			valueType: typeof e,
		});
		return new ApiError(INTERNAL_ERROR_MESSAGE, 500, { name: AuthErrors.InternalError, retriable: true });
	}

	// `validateUser` rejected the sign-up in the Cognito PreSignUp trigger: the
	// trigger encoded the error it mapped (`trigger-rejection.ts`), so the
	// client sees the same name and message as for an in-process rejection.
	if (e.name === AuthErrors.UserLambdaValidation) {
		const decoded = decodeTriggerRejection(e.message);
		if (decoded) return toAuthApiError(decoded, log);
	}

	if (flow === 'signIn' && (e.name === AuthErrors.UserNotFound || e.name === AuthErrors.NotAuthorized)) {
		if (e.name === AuthErrors.NotAuthorized && !/^Incorrect username or password\.?$/.test(e.message)) {
			log.warn('[bb-auth] sign-in rejected; reported to the client as incorrect credentials', {
				error: e.name,
				message: withoutLogin(e.message, options.login),
				requestId: sdkRequestId(e),
			});
		}
		return incorrectCredentialsError();
	}
	if (flow === 'challenge' && e.name === AuthErrors.UserNotFound) return incorrectCredentialsError();
	if (flow === 'confirmCode' && e.name === AuthErrors.UserNotFound) return wrongCodeError();
	if (flow === 'confirmCode' && options.hideAccountState && ACCOUNT_STATE_CONFIRM_ERRORS.has(e.name)) {
		// Warn, not info: an expired code shown as a wrong code is a documented
		// trade-off operators need to be able to see (R2-4).
		log.warn('[bb-auth] confirmation rejected; reported to the client as a wrong code (account state hidden)', {
			error: e.name,
			message: withoutLogin(e.message, options.login),
			requestId: sdkRequestId(e),
		});
		return wrongCodeError();
	}

	if (AWS_ACCESS_ERROR_NAMES.has(e.name)) {
		log.error('[bb-auth] AWS rejected a call made with the function role — check its IAM policy', {
			error: e.name,
			message: withoutLogin(e.message, options.login),
			requestId: sdkRequestId(e),
		});
		return new ApiError(ACCESS_DENIED_MESSAGE, 500, { name: AuthErrors.InternalError, cause: e, retriable: true });
	}

	if (!isAuthErrorName(e.name)) {
		log.error(
			'[bb-auth] error outside the AuthErrors vocabulary; reported to the client as InternalErrorException',
			{
				error: e.name,
				// An unmapped name carries unmapped text too — `CodeDeliveryFailureException`
				// names the destination the code was sent to (FX60).
				message: withoutLogin(e.message, options.login),
				requestId: sdkRequestId(e),
			},
		);
		return new ApiError(INTERNAL_ERROR_MESSAGE, 500, { name: AuthErrors.InternalError, cause: e, retriable: true });
	}

	// FX59 (#678): the client gets the name's fixed message, never the
	// engine's own text; that goes to the log, the login redacted.
	const message = CLIENT_ERROR_MESSAGES[e.name];
	const status = statusForAuthError(e.name);
	const raw = e.message || e.name;
	if (raw !== message) {
		const detail = { error: e.name, message: withoutLogin(raw, options.login), requestId: sdkRequestId(e) };
		// A service fault, or text naming AWS resources, is an operator problem;
		// anything else is the client's (a wrong code, a weak password).
		const text = '[bb-auth] error message withheld from the client; it got the fixed message for its name';
		if (status >= 500 || AWS_IDENTIFIER_PATTERN.test(raw)) log.error(text, detail);
		else log.info(text, detail);
	}
	return new ApiError(message, status, {
		name: e.name,
		cause: e,
		...(isRetriableAuthError(e.name) ? { retriable: true } : {}),
	});
}

/**
 * The error a native engine throws when the configuration needs a Cognito user
 * pool but the runtime has no pool identifiers — the CDK layer registered none
 * (a deployment mismatch; see "No user pool provisioned" in `engines/types.ts`).
 * The client gets a generic 500; the actionable detail goes to the log.
 *
 * @internal
 */
export function userPoolNotProvisioned(fullId: string, log: ChildLogger): ApiError {
	log.error(
		`[bb-auth] '${fullId}' needs a Cognito user pool, but none is configured in this runtime. ` +
			'Redeploy the stack so the CDK layer provisions the pool and registers its identifiers.',
	);
	return new ApiError(INTERNAL_ERROR_MESSAGE, 500, { name: AuthErrors.InternalError, retriable: true });
}
