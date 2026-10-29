// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * User-enumeration safety, shared by every native engine so the mock and the
 * Cognito engine answer an unknown username the same way. Ported from
 * `bb-auth-cognito/src/enumeration.ts` as fixed by B6.
 *
 * Rules (design 04 §6.3): sign-in failures are uniform; password reset and
 * code resend always report success with plausible delivery details; confirm-
 * code flows answer an unknown user exactly like a wrong code. `auth.admin.*`
 * is inside the trust boundary and may still report `UserNotFoundException`.
 * The public sign-up form does not reveal existing accounts unless
 * `emailPassword.revealExistingUsers` is set (applied in `auth-base.ts`).
 *
 * FX3 (finding A3): with `revealExistingUsers` off, the *state* of an existing
 * account is hidden too, on the steps that follow the sign-up form — an
 * unknown, an unconfirmed and an already-confirmed user are indistinguishable on
 * `confirmSignUp`, `resendSignUpCode`, `resetPassword` and
 * `confirmResetPassword` ({@link isAccountStateAnswer}; `error-mapping.ts`'s
 * `hideAccountState`). Cognito's `PreventUserExistenceErrors` hides only a
 * missing user, not a confirmed one.
 *
 * Internal — not exported from any package entry.
 *
 * @internal
 */

import crypto from 'node:crypto';
import { ApiError } from '@aws-blocks/core';
import { AuthErrors } from './errors.js';
import type { CodeDeliveryDetails } from './types.js';

/** The one message every sign-in credential failure carries, in both runtimes. */
export const INCORRECT_CREDENTIALS_MESSAGE = 'Incorrect username or password';

/** Cognito's own wording for a wrong confirmation code (`CodeMismatchException`). */
export const WRONG_CODE_MESSAGE = 'Invalid verification code provided, please try again.';

/**
 * The uniform sign-in failure: unknown user, wrong password and disabled user
 * all produce exactly this (name, status, message, `retriable: false`).
 *
 * @internal
 */
export function incorrectCredentialsError(): ApiError {
	return new ApiError(INCORRECT_CREDENTIALS_MESSAGE, 401, { name: AuthErrors.NotAuthorized });
}

/**
 * The uniform wrong-code failure: an unknown user on a confirm-code flow is
 * answered exactly like a wrong code (retriable on the same step).
 *
 * @internal
 */
export function wrongCodeError(): ApiError {
	return new ApiError(WRONG_CODE_MESSAGE, 400, { name: AuthErrors.CodeMismatch, retriable: true });
}

/**
 * Mask an email the way Cognito masks a `CodeDeliveryDetails.Destination`:
 * first character of the local part and of the domain, e.g. `a***@e***`.
 *
 * @internal
 */
export function maskEmail(email: string): string {
	const [local, domain] = email.split('@');
	if (!domain) return email;
	return `${local.slice(0, 1)}***@${domain.slice(0, 1)}***`;
}

/**
 * Mask a phone number the way Cognito does: keep a leading `+` and the last
 * four digits, e.g. `+*******0100`.
 *
 * @internal
 */
export function maskPhone(phone: string): string {
	const plus = phone.startsWith('+') ? '+' : '';
	const digits = plus ? phone.slice(1) : phone;
	return `${plus}${digits.replace(/.(?=.{4})/g, '*')}`;
}

const EMAIL_SHAPE = /^[^@\s]+@[^@\s]+$/;
const PHONE_SHAPE = /^\+\d{7,15}$/;

/**
 * Fabricate the `codeDeliveryDetails` an unknown user receives from password
 * reset, so the response is indistinguishable from a real account's:
 *
 * - an email-shaped username → its own masked address (exactly what a real
 *   user signing in with that email would see);
 * - a phone-shaped username → its own masked number over SMS;
 * - anything else → a masked address whose letters are derived from an HMAC of
 *   the username under the server secret: stable across repeat requests (as a
 *   real account's would be) and not computable by a caller who lacks the key.
 *
 * @internal
 */
export function fabricateCodeDelivery(username: string, secret: string): CodeDeliveryDetails {
	if (EMAIL_SHAPE.test(username)) {
		return { destination: maskEmail(username), deliveryMedium: 'EMAIL', attributeName: 'email' };
	}
	if (PHONE_SHAPE.test(username)) {
		return { destination: maskPhone(username), deliveryMedium: 'SMS', attributeName: 'phone_number' };
	}
	const digest = crypto.createHmac('sha256', secret).update(`reset-destination:${username}`).digest();
	const letter = (byte: number) => String.fromCharCode(97 + (byte % 26));
	return {
		destination: `${letter(digest[0])}***@${letter(digest[1])}***`,
		deliveryMedium: 'EMAIL',
		attributeName: 'email',
	};
}

/**
 * Whether a raw engine error from `resendSignUpCode` / `resetPassword` is an
 * answer only an *existing* account can produce, and so must be withheld while
 * account state is hidden (`emailPassword.revealExistingUsers` off):
 *
 * - `InvalidParameterException` — Cognito's "User is already confirmed." on a
 *   resend, and "Cannot reset password for the user as there is no
 *   registered/verified email or phone_number" for an unconfirmed user on a
 *   pool without `PreventUserExistenceErrors`;
 * - `NotAuthorizedException` — a disabled user, or an admin-created user who has
 *   never signed in ("User password cannot be reset in the current state.").
 *
 * An `ApiError` is never an account-state answer: `Auth` and the engines raise
 * those deliberately.
 *
 * @internal
 */
export function isAccountStateAnswer(e: unknown): boolean {
	if (!(e instanceof Error) || e instanceof ApiError) return false;
	return e.name === AuthErrors.InvalidParameter || e.name === AuthErrors.NotAuthorized;
}

/**
 * The first factors a `USER_AUTH` sign-in offers an unknown user in the local
 * runtime — what a confirmed user (verified email) is offered — standing in for
 * the challenge Cognito issues a nonexistent user when the app client has
 * `PreventUserExistenceErrors`.
 *
 * @internal
 */
export const DECOY_FIRST_FACTORS = ['PASSWORD', 'EMAIL_OTP'] as const;
