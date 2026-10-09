// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { AuthErrors } from '@aws-blocks/auth-common';

export type { AuthErrorName } from '@aws-blocks/auth-common';
/**
 * The `Auth` Building Block throws the canonical AWS Blocks auth error
 * vocabulary from `@aws-blocks/auth-common`. It is re-exported here, not
 * redefined, so there is exactly one source of truth for every error `name`.
 *
 * Match a thrown error with `isAuthError(e, AuthErrors.X)` (or `isBlocksError`
 * from `@aws-blocks/core`); both work the same server- and client-side.
 */
export { AuthErrors, isAuthError } from '@aws-blocks/auth-common';

/**
 * The HTTP status `Auth` uses for each error name. Carried over from
 * `AuthCognito` (401 / 404 / 409 / 429 / 500, 400 otherwise), plus the names
 * that are new in `Auth` (`ReauthenticationRequired` 401, the two mode gates
 * 409).
 *
 * Pure and dependency-free (browser-safe). Not exported from any entry point.
 *
 * @internal
 */
export function statusForAuthError(name: string): number {
	switch (name) {
		case AuthErrors.NotAuthenticated:
		case AuthErrors.NotAuthorized:
		case AuthErrors.ReauthenticationRequired:
		case AuthErrors.TokenExpired:
			return 401;
		case AuthErrors.UserNotFound:
		case AuthErrors.GroupNotFound:
			return 404;
		case AuthErrors.UserAlreadyExists:
		case AuthErrors.EmailPasswordNotEnabled:
		case AuthErrors.NoFederatedProvider:
			return 409;
		case AuthErrors.LimitExceeded:
		case AuthErrors.TooManyRequests:
		case AuthErrors.TooManyFailedAttempts:
			return 429;
		// A service-side fault: report it as the upstream failure it is, not a 400.
		case AuthErrors.InternalError:
			return 500;
		default:
			return 400;
	}
}

/**
 * Whether an error with this name is retriable on the same step of a flow (the
 * sign-in UI keeps the current form and overlays the error). Carried over from
 * `AuthCognito`: a wrong code, a rejected TOTP setup code, a malformed
 * parameter, a weak password, and a transient service fault. Everything else
 * fails closed (the flow restarts).
 *
 * @internal
 */
export function isRetriableAuthError(name: string): boolean {
	switch (name) {
		case AuthErrors.CodeMismatch:
		case AuthErrors.EnableSoftwareTokenMFA:
		case AuthErrors.InvalidParameter:
		case AuthErrors.InvalidPassword:
		case AuthErrors.InternalError:
			return true;
		default:
			return false;
	}
}
