// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * User-enumeration safety, shared by the mock (`./index.ts`) and the AWS
 * runtime (`./index.aws.ts`) so both answer an unknown username the same way.
 *
 * Rules (design 04 §6.3): sign-in failures are uniform; password reset and
 * code resend always report success with plausible delivery details; confirm-
 * code flows answer an unknown user exactly like a wrong code. `auth.admin.*`
 * is inside the trust boundary and may still report `UserNotFoundException`.
 *
 * Internal — not exported from any package entry.
 *
 * @internal
 */

import crypto from 'node:crypto';
import { ApiError } from '@aws-blocks/core';
import { AuthCognitoErrors, type CodeDeliveryDetails } from './types.js';

/** The one message every sign-in credential failure carries, in both runtimes. */
export const INCORRECT_CREDENTIALS_MESSAGE = 'Incorrect username or password';

/**
 * The uniform sign-in failure: unknown user, wrong password and disabled user
 * all produce exactly this (name, status, message, `retriable: false`).
 *
 * @internal
 */
export function incorrectCredentialsError(): ApiError {
	return new ApiError(INCORRECT_CREDENTIALS_MESSAGE, 401, { name: AuthCognitoErrors.NotAuthorized });
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
