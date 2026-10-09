// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Pure helpers for the Cognito engine's sign-in challenges (`native-cognito.ts`):
 * the signed challenge envelope the client carries between `signIn` and
 * `confirmSignIn`, the Cognito challenge → `SignInNextStep` mapping, and the
 * `ChallengeResponses` each answer is sent as.
 *
 * Ported from `bb-auth-cognito/src/index.aws.ts` unchanged in behaviour; only
 * the types are `Auth`'s. No SDK client here — everything is synchronous and
 * unit-testable.
 *
 * Internal — not exported from any package entry.
 *
 * @internal
 */

import crypto from 'node:crypto';
import { ApiError } from '@aws-blocks/core';
import { constantTimeEquals } from '@aws-blocks/core/bb-utils';
import { ChallengeNameType, type DeliveryMediumType } from '@aws-sdk/client-cognito-identity-provider';
import { AuthErrors } from '../errors.js';
import type { CodeDeliveryDetails, PreferredChallenge, SignInNextStep } from '../types.js';
import { checkAttributeValues } from './attribute-write-rules.js';

/**
 * The client-echoed challenge state. The client never sees the raw Cognito
 * session token: it is packed with the challenge name and username into an
 * HMAC-signed envelope that `confirmSignIn` verifies before calling Cognito.
 *
 * - `flow` is stashed only when the originating call was `USER_AUTH`; it lets
 *   the mapper tell a first-factor `EMAIL_OTP` from an MFA `EMAIL_OTP`.
 * - `sharedSecret` is set while an authenticator-app (TOTP) setup is in progress.
 * - `awaitingPassword` marks the synthetic "enter your password" step after the
 *   user picked `PASSWORD` from `USER_AUTH`'s `SELECT_CHALLENGE`.
 *
 * The wire format is `AuthCognito`'s, byte for byte, so an in-flight challenge
 * survives the switch (both blocks sign with the same `session-secret`).
 *
 * @internal
 */
export interface ChallengeEnvelope {
	name: ChallengeNameType;
	cognitoSession: string;
	username: string;
	sharedSecret?: string;
	flow?: 'USER_AUTH';
	awaitingPassword?: boolean;
}

/**
 * Known Cognito challenge names. An envelope naming anything else is rejected
 * even when its HMAC verifies — it could not be re-driven, and sending a bogus
 * `ChallengeName` only surfaces as a vague `InvalidParameterException`.
 */
const KNOWN_CHALLENGE_NAMES: ReadonlySet<string> = new Set<string>(Object.values(ChallengeNameType));

function isChallengeName(v: unknown): v is ChallengeNameType {
	return typeof v === 'string' && KNOWN_CHALLENGE_NAMES.has(v);
}

/**
 * Sign an envelope. `secret` is the block's session-signing key (from SSM),
 * not a user password.
 *
 * @internal
 */
export function encodeChallengeSession(secret: string, payload: ChallengeEnvelope): string {
	const raw = Buffer.from(JSON.stringify(payload)).toString('base64url');
	const sig = crypto.createHmac('sha256', secret).update(raw).digest('base64url');
	return `${raw}.${sig}`;
}

/**
 * Verify and parse an envelope. `null` for anything that does not verify in
 * constant time or does not have the envelope's shape.
 *
 * @internal
 */
export function decodeChallengeSession(secret: string, token: string): ChallengeEnvelope | null {
	const idx = token.lastIndexOf('.');
	if (idx < 0) return null;
	const raw = token.slice(0, idx);
	const sig = token.slice(idx + 1);
	const expected = crypto.createHmac('sha256', secret).update(raw).digest('base64url');
	if (sig.length !== expected.length) return null;
	if (!constantTimeEquals(sig, expected)) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
	} catch {
		return null;
	}
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
	const name: unknown = Reflect.get(parsed, 'name');
	const cognitoSession: unknown = Reflect.get(parsed, 'cognitoSession');
	const username: unknown = Reflect.get(parsed, 'username');
	const sharedSecret: unknown = Reflect.get(parsed, 'sharedSecret');
	const flow: unknown = Reflect.get(parsed, 'flow');
	const awaitingPassword: unknown = Reflect.get(parsed, 'awaitingPassword');
	if (!isChallengeName(name)) return null;
	if (typeof cognitoSession !== 'string' || cognitoSession.length === 0) return null;
	if (typeof username !== 'string' || username.length === 0) return null;
	if (sharedSecret !== undefined && typeof sharedSecret !== 'string') return null;
	if (flow !== undefined && flow !== 'USER_AUTH') return null;
	if (awaitingPassword !== undefined && typeof awaitingPassword !== 'boolean') return null;
	return {
		name,
		cognitoSession,
		username,
		...(sharedSecret !== undefined ? { sharedSecret } : {}),
		...(flow !== undefined ? { flow } : {}),
		...(awaitingPassword !== undefined ? { awaitingPassword } : {}),
	};
}

/** Parse a JSON-array challenge parameter; `[]` for anything else. */
function jsonArray(raw: string | undefined): unknown[] {
	if (!raw) return [];
	try {
		const parsed: unknown = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

/**
 * The first factors a `SELECT_CHALLENGE` offers, restricted to the ones `Auth`
 * can drive (`PASSWORD`, `EMAIL_OTP`, `SMS_OTP`, `WEB_AUTHN`). `PASSWORD_SRP`
 * and `CUSTOM_CHALLENGE` are dropped so the picker never offers a factor the
 * block cannot honour.
 *
 * @internal
 */
export function parseAvailableChallenges(params: Record<string, string> | undefined): PreferredChallenge[] {
	const out: PreferredChallenge[] = [];
	for (const v of jsonArray(params?.AVAILABLE_CHALLENGES)) {
		if (v === 'PASSWORD' || v === 'EMAIL_OTP' || v === 'SMS_OTP' || v === 'WEB_AUTHN') out.push(v);
	}
	return out;
}

/** Cognito MFA names (`SMS_MFA`, `SOFTWARE_TOKEN_MFA`, `EMAIL_OTP`) → `Auth`'s. @internal */
export function parseMfaTypes(raw?: string): ('SMS' | 'TOTP' | 'EMAIL')[] {
	const out: ('SMS' | 'TOTP' | 'EMAIL')[] = [];
	for (const v of jsonArray(raw)) {
		if (v === 'SMS_MFA') out.push('SMS');
		else if (v === 'SOFTWARE_TOKEN_MFA') out.push('TOTP');
		else if (v === 'EMAIL_OTP') out.push('EMAIL');
	}
	return out;
}

/** The setup-able factors of an `MFA_SETUP` challenge (SMS cannot be set up in-flow). @internal */
export function setupMfaTypes(params: Record<string, string> | undefined): ('TOTP' | 'EMAIL')[] {
	return parseMfaTypes(params?.MFAS_CAN_SETUP).filter((t): t is 'TOTP' | 'EMAIL' => t !== 'SMS');
}

function parseRequiredAttrs(raw?: string): string[] | undefined {
	if (!raw) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (!Array.isArray(parsed)) return undefined;
	if (!parsed.every((v): v is string => typeof v === 'string')) return undefined;
	return parsed;
}

/**
 * `CODE_DELIVERY_DESTINATION` from a challenge, or a visible `'***'`
 * placeholder (an empty string would render "Enter the code sent to _").
 */
function codeDeliveryDestination(params: Record<string, string> | undefined, onMissing: () => void): string {
	const dest = params?.CODE_DELIVERY_DESTINATION;
	if (dest) return dest;
	onMissing();
	return '***';
}

/**
 * Map a Cognito challenge to the `SignInNextStep` the client renders. `session`
 * is the signed envelope. The TOTP-only `MFA_SETUP` case needs an SDK call
 * first and is handled by the engine before this is reached.
 *
 * @throws {ApiError} 501 `InvalidParameterException` for SRP / device-SRP and
 *   custom challenges (not implemented), 400 for an unknown challenge.
 *
 * @internal
 */
export function mapChallengeToNextStep(
	name: ChallengeNameType,
	session: string,
	params: Record<string, string> | undefined,
	flow: 'USER_AUTH' | undefined,
	warn: (message: string) => void,
): SignInNextStep {
	const destination = () =>
		codeDeliveryDestination(params, () =>
			warn(`[bb-auth] ${name} challenge missing CODE_DELIVERY_DESTINATION; using placeholder`),
		);
	switch (name) {
		case 'SMS_MFA':
			return {
				name: 'CONFIRM_SIGN_IN_WITH_SMS_CODE',
				session,
				codeDeliveryDetails: {
					destination: destination(),
					deliveryMedium: 'SMS',
					attributeName: 'phone_number',
				},
			};
		case 'SOFTWARE_TOKEN_MFA':
			return { name: 'CONFIRM_SIGN_IN_WITH_TOTP_CODE', session };
		case 'EMAIL_OTP':
			// Under USER_AUTH, EMAIL_OTP is a *first*-factor challenge (passwordless
			// sign-in), labelled differently from second-factor MFA.
			return {
				name:
					flow === 'USER_AUTH'
						? 'CONFIRM_SIGN_IN_WITH_FIRST_FACTOR_EMAIL_OTP'
						: 'CONFIRM_SIGN_IN_WITH_EMAIL_CODE',
				session,
				codeDeliveryDetails: { destination: destination(), deliveryMedium: 'EMAIL', attributeName: 'email' },
			};
		case 'SMS_OTP':
			// Only USER_AUTH issues SMS_OTP (SMS MFA under USER_PASSWORD_AUTH is SMS_MFA).
			return {
				name: 'CONFIRM_SIGN_IN_WITH_FIRST_FACTOR_SMS_OTP',
				session,
				codeDeliveryDetails: {
					destination: destination(),
					deliveryMedium: 'SMS',
					attributeName: 'phone_number',
				},
			};
		case 'SELECT_CHALLENGE':
			return {
				name: 'CONTINUE_SIGN_IN_WITH_FIRST_FACTOR_SELECTION',
				session,
				availableChallenges: parseAvailableChallenges(params),
			};
		case 'PASSWORD':
			return { name: 'CONFIRM_SIGN_IN_WITH_PASSWORD', session };
		case 'SELECT_MFA_TYPE':
			return {
				name: 'CONTINUE_SIGN_IN_WITH_MFA_SELECTION',
				session,
				allowedMFATypes: parseMfaTypes(params?.MFAS_CAN_CHOOSE),
			};
		case 'MFA_SETUP': {
			// TOTP-only setup is intercepted by the engine (it needs
			// AssociateSoftwareToken). EMAIL-only → the email-setup step; both →
			// the user picks, and the pick is re-routed on confirmSignIn.
			const allowedMFATypes = setupMfaTypes(params);
			if (allowedMFATypes.length === 1 && allowedMFATypes[0] === 'EMAIL') {
				return { name: 'CONTINUE_SIGN_IN_WITH_EMAIL_SETUP', session };
			}
			return { name: 'CONTINUE_SIGN_IN_WITH_MFA_SETUP_SELECTION', session, allowedMFATypes };
		}
		case 'NEW_PASSWORD_REQUIRED': {
			const requiredAttributes = parseRequiredAttrs(params?.requiredAttributes);
			return {
				name: 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED',
				session,
				...(requiredAttributes ? { requiredAttributes } : {}),
			};
		}
		case 'WEB_AUTHN':
			// Cognito's PublicKeyCredentialRequestOptionsJSON, forwarded verbatim for
			// the browser's `parseRequestOptionsFromJSON`.
			return {
				name: 'CONFIRM_SIGN_IN_WITH_WEB_AUTHN',
				session,
				credentialRequestOptions: params?.CREDENTIAL_REQUEST_OPTIONS ?? '',
			};
		case 'PASSWORD_VERIFIER':
		case 'DEVICE_SRP_AUTH':
		case 'DEVICE_PASSWORD_VERIFIER':
			// SRP and remembered-device flows need the SRP key exchange, which is not
			// implemented (the app client does not enable SRP). Fail loudly rather
			// than send a half-built RespondToAuthChallenge.
			throw new ApiError(`Challenge '${name}' requires the SRP flow, which is not yet implemented.`, 501, {
				name: AuthErrors.InvalidParameter,
			});
		case 'CUSTOM_CHALLENGE':
			throw new ApiError('CUSTOM_AUTH / CUSTOM_CHALLENGE is not yet supported.', 501, {
				name: AuthErrors.InvalidParameter,
			});
		default:
			throw new ApiError(`Unsupported challenge: ${name}`, 400, { name: AuthErrors.InvalidParameter });
	}
}

/**
 * The `ChallengeResponses` for answering `challengeName` with `response`.
 * `userAttributes` (new-password-required only) arrive exactly as `AuthBase`
 * prefixed them — declared custom attributes carry `custom:`, everything else
 * passes through. (`AuthCognito` additionally prefixed *undeclared* non-standard
 * names; `Auth` keeps one prefixing rule, `AuthBase`'s, for every path.)
 *
 * The `userAttributes` are checked against the schema-independent write rules
 * first (`attribute-write-rules.ts`, as an `update`): a non-string or
 * over-long value or `sub` throws `InvalidParameterException`, a verified flag
 * `NotAuthorizedException`, before any `RespondToAuthChallenge` (FX43).
 *
 * @internal
 */
export function buildChallengeResponses(
	challengeName: ChallengeNameType,
	username: string,
	response: string,
	userAttributes: Partial<Record<string, string>> | undefined,
): Record<string, string> {
	switch (challengeName) {
		case 'SMS_MFA':
			return { USERNAME: username, SMS_MFA_CODE: response };
		case 'SOFTWARE_TOKEN_MFA':
			return { USERNAME: username, SOFTWARE_TOKEN_MFA_CODE: response };
		case 'EMAIL_OTP':
			return { USERNAME: username, EMAIL_OTP_CODE: response };
		case 'SMS_OTP':
			return { USERNAME: username, SMS_OTP_CODE: response };
		case 'SELECT_MFA_TYPE': {
			const mapped =
				response === 'SMS'
					? 'SMS_MFA'
					: response === 'TOTP'
						? 'SOFTWARE_TOKEN_MFA'
						: response === 'EMAIL'
							? 'EMAIL_OTP'
							: response;
			return { USERNAME: username, ANSWER: mapped };
		}
		case 'MFA_SETUP': {
			const mapped = response === 'TOTP' ? 'SOFTWARE_TOKEN_MFA' : response === 'EMAIL' ? 'EMAIL_OTP' : response;
			return { USERNAME: username, ANSWER: mapped };
		}
		case 'SELECT_CHALLENGE':
			// The first-factor picker: Cognito takes the factor name as ANSWER.
			return { USERNAME: username, ANSWER: response };
		case 'PASSWORD':
			return { USERNAME: username, PASSWORD: response };
		case 'WEB_AUTHN':
			// The JSON-encoded PublicKeyCredential from navigator.credentials.get().
			return { USERNAME: username, CREDENTIAL: response };
		case 'NEW_PASSWORD_REQUIRED': {
			// Written to the existing user through the app client, like
			// `UpdateUserAttributes`: checked before the SDK call (FX43).
			checkAttributeValues(userAttributes ?? {}, 'update');
			const body: Record<string, string> = { USERNAME: username, NEW_PASSWORD: response };
			for (const [name, value] of Object.entries(userAttributes ?? {})) {
				if (value === undefined) continue;
				body[`userAttributes.${name}`] = value;
			}
			return body;
		}
		default:
			return { USERNAME: username, ANSWER: response };
	}
}

/**
 * Cognito `CodeDeliveryDetails` → `Auth`'s. An unknown medium reads as
 * `EMAIL` (the only medium a self sign-up uses under Q2).
 *
 * @internal
 */
export function mapCodeDelivery(d?: {
	Destination?: string;
	DeliveryMedium?: DeliveryMediumType;
	AttributeName?: string;
}): CodeDeliveryDetails {
	const medium = d?.DeliveryMedium;
	return {
		destination: d?.Destination ?? '',
		deliveryMedium: medium === 'SMS' || medium === 'EMAIL' || medium === 'PHONE_NUMBER' ? medium : 'EMAIL',
		attributeName: d?.AttributeName ?? '',
	};
}
