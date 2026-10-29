// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `validateUser` on the sign-up path, both in-process and as a Cognito
 * PreSignUp trigger (decision Q10).
 *
 * **Why a trigger.** `auth.signUp()` / `auth.admin.createUser()` run
 * `validateUser` in-process, but Cognito also creates pool users that never
 * pass through the app: a `SignUp` called directly against Cognito with the
 * app client id, an `AdminCreateUser` from the console or CLI, and the first
 * sign-in of a social / SAML / `federateVia: 'cognito'` user. When
 * `validateUser` is set and the block owns its pool, the CDK layer wires the
 * pool's PreSignUp trigger to the app's shared backend Lambda; core's handler
 * routes the event here by user pool id
 * (`EventSourceMapping.COGNITO_USER_POOL`). Only the block the trigger was
 * wired for registers that route (the CDK layer flags it; R2-1), so another
 * `Auth` wrapping the same pool cannot take the trigger over.
 *
 * **Order and idempotency.** On the in-process path `validateUser` runs
 * **first**, in the app's request — so a rejection reaches the client exactly
 * as it does locally — and the Cognito call then carries a short-lived HMAC
 * marker in `ClientMetadata` (keyed by a key HKDF-derived from the session
 * secret, bound to the block and the username). The trigger verifies the marker and skips the check, so
 * one sign-up runs `validateUser` once. Cognito passes `ClientMetadata` only
 * server-to-server and the marker cannot be forged without the secret, so a
 * direct `SignUp` cannot skip the check; any marker that does not verify (or a
 * secret that cannot be read) simply means the trigger validates.
 *
 * **Rejecting.** A throw becomes a Cognito-visible rejection: the error is
 * mapped by the same policy as in-process (`toAuthApiError`), encoded
 * (`trigger-rejection.ts`) and thrown; Cognito answers
 * `UserLambdaValidationException` and the app decodes it back to the same
 * `AuthErrors` name and message. The trigger never sets
 * `response.autoConfirmUser` / `autoVerifyEmail` / `autoVerifyPhone`: core
 * returns the event unchanged, and every failure — malformed event, foreign
 * trigger source — rejects.
 *
 * @internal
 */

import crypto from 'node:crypto';
import type { ChildLogger } from '@aws-blocks/bb-logger';
import { ApiError } from '@aws-blocks/core';
import { constantTimeEquals } from '@aws-blocks/core/bb-utils';
import { cognitoFederatedProviders } from './cdk/contract.js';
import { deriveKey } from './cookies.js';
import { INTERNAL_ERROR_MESSAGE, toAuthApiError } from './error-mapping.js';
import { AuthErrors } from './errors.js';
import { isInFormatOf, resolveSignInMode, type SignInMode } from './sign-in-mode.js';
import { encodeTriggerRejection } from './trigger-rejection.js';
import type { AuthOptions, UserCandidate } from './types.js';

/** The PreSignUp trigger sources the trigger answers. */
export const PRE_SIGN_UP_TRIGGER_SOURCES = [
	'PreSignUp_SignUp',
	'PreSignUp_AdminCreateUser',
	'PreSignUp_ExternalProvider',
] as const;
/** One of {@link PRE_SIGN_UP_TRIGGER_SOURCES}. */
export type PreSignUpTriggerSource = (typeof PRE_SIGN_UP_TRIGGER_SOURCES)[number];

/** The `ClientMetadata` key carrying the "already validated in-process" marker. */
export const VALIDATED_MARKER_KEY = 'blocks:auth:validated';
/** How long a marker is accepted: the Cognito call follows the check at once. */
const MARKER_TTL_MS = 5 * 60 * 1000;
const MARKER_CONTEXT = 'bb-auth/pre-sign-up/v1';
/**
 * The HKDF `info` label of the marker key (see `markerKey`): its own label, so
 * the marker key is unrelated to every other key bb-auth derives from the
 * session secret.
 *
 * @internal
 */
export const MARKER_KEY_INFO = 'aws-blocks/bb-auth pre-sign-up marker v1';

/** The fields of a Cognito PreSignUp event the trigger reads. */
export interface PreSignUpEvent {
	triggerSource: PreSignUpTriggerSource;
	userPoolId: string;
	userName: string;
	userAttributes: Record<string, string>;
	clientMetadata: Record<string, string>;
}

function stringRecord(value: unknown): Record<string, string> {
	const out: Record<string, string> = {};
	if (typeof value !== 'object' || value === null) return out;
	for (const [k, v] of Object.entries(value)) if (typeof v === 'string') out[k] = v;
	return out;
}

function isTriggerSource(value: unknown): value is PreSignUpTriggerSource {
	return typeof value === 'string' && (PRE_SIGN_UP_TRIGGER_SOURCES as readonly string[]).includes(value);
}

/**
 * Read a raw Lambda event as a PreSignUp event; `null` for anything else
 * (another trigger source, a missing `userName` / `userPoolId`).
 *
 * @internal
 */
export function parsePreSignUpEvent(event: unknown): PreSignUpEvent | null {
	if (typeof event !== 'object' || event === null) return null;
	const triggerSource: unknown = Reflect.get(event, 'triggerSource');
	const userPoolId: unknown = Reflect.get(event, 'userPoolId');
	const userName: unknown = Reflect.get(event, 'userName');
	if (!isTriggerSource(triggerSource) || typeof userPoolId !== 'string' || typeof userName !== 'string') return null;
	if (!userName) return null;
	const request: unknown = Reflect.get(event, 'request');
	const req = typeof request === 'object' && request !== null ? request : {};
	return {
		triggerSource,
		userPoolId,
		userName,
		userAttributes: stringRecord(Reflect.get(req, 'userAttributes')),
		clientMetadata: stringRecord(Reflect.get(req, 'clientMetadata')),
	};
}

/**
 * The {@link UserCandidate} for an email + password sign-up (`auth.signUp`, a
 * direct `SignUp`) or an admin-created user. `login` is what the user signs up
 * with; on a username-attribute pool (`signInWith` without `'username'`)
 * Cognito fills the matching `email` / `phone_number` attribute from it, and so
 * does this. Shared by the in-process check and the trigger, so both build the
 * same candidate.
 *
 * @internal
 */
export function passwordSignUpCandidate(
	mode: SignInMode,
	login: string,
	attributes: Readonly<Record<string, string>>,
): UserCandidate {
	const claims: Record<string, string> = { ...attributes };
	const attr = mode.usernameAttributes.find((a) => isInFormatOf(a, login));
	if (attr) claims[attr] ??= login;
	return { provider: 'password', subject: '', email: claims.email ?? null, username: login, phase: 'signUp', claims };
}

/**
 * The login a PreSignUp event's user signs up with. On a username-attribute
 * pool Cognito's `userName` is a generated UUID, and the login is the email /
 * phone attribute it was filled from.
 */
function loginOf(mode: SignInMode, event: PreSignUpEvent): string {
	if (mode.usernameAttributes.length === 0) return event.userName;
	if (mode.usernameAttributes.some((a) => isInFormatOf(a, event.userName))) return event.userName;
	for (const attr of mode.usernameAttributes) {
		const value = event.userAttributes[attr];
		if (value) return value;
	}
	return event.userName;
}

/**
 * The configured provider id behind a federated `userName`
 * (`<ProviderName>_<provider user id>`), matched case-insensitively against
 * the Cognito provider names (`google` → `Google`). An unknown prefix is
 * returned as is.
 */
function federatedProviderOf(options: AuthOptions, userName: string): string {
	const lower = userName.toLowerCase();
	let best: { id: string; length: number } | undefined;
	for (const { id, providerName } of cognitoFederatedProviders(options)) {
		const prefix = `${providerName.toLowerCase()}_`;
		if (lower.startsWith(prefix) && (!best || prefix.length > best.length)) best = { id, length: prefix.length };
	}
	if (best) return best.id;
	const idx = userName.indexOf('_');
	return idx > 0 ? userName.slice(0, idx) : userName;
}

/**
 * Map a PreSignUp event to the {@link UserCandidate} `validateUser` receives:
 *
 * | `triggerSource` | `provider` | `username` |
 * |---|---|---|
 * | `PreSignUp_SignUp` | `'password'` | the login (see {@link passwordSignUpCandidate}) |
 * | `PreSignUp_AdminCreateUser` | `'password'` | the login |
 * | `PreSignUp_ExternalProvider` | the provider id (`google`, a SAML / OIDC id) | Cognito's `<ProviderName>_<id>` |
 *
 * `phase` is always `'signUp'` and `subject` is `''` (the pool user does not
 * exist yet); `email` is the `email` attribute; `claims` are the user
 * attributes Cognito passes (for a federated user: after the provider's
 * attribute mapping).
 *
 * @internal
 */
export function candidateFromTrigger(options: AuthOptions, event: PreSignUpEvent): UserCandidate {
	if (event.triggerSource === 'PreSignUp_ExternalProvider') {
		return {
			provider: federatedProviderOf(options, event.userName),
			subject: '',
			email: event.userAttributes.email ?? null,
			username: event.userName,
			phase: 'signUp',
			claims: { ...event.userAttributes },
		};
	}
	const mode = resolveSignInMode(options.users?.signInWith);
	return passwordSignUpCandidate(mode, loginOf(mode, event), event.userAttributes);
}

// ── The "validated in-process" marker ───────────────────────────────────────

/**
 * The marker's HMAC key: HKDF-derived from the session secret with its own
 * `info` label ({@link MARKER_KEY_INFO}), so a marker and a session cookie —
 * both HMAC-SHA256 tags — are made under unrelated keys, not merely over
 * differently formatted messages (R2-5).
 *
 * Markers minted before this key was introduced were HMAC-ed with the raw
 * secret and no longer verify. That is safe: a marker lives five minutes, and
 * a marker that does not verify only means the trigger runs `validateUser`
 * itself — the default, never a bypass.
 */
function markerKey(secret: string): Buffer {
	return deriveKey(secret, MARKER_KEY_INFO);
}

function markerSignature(secret: string, fullId: string, login: string, exp: number): string {
	return crypto
		.createHmac('sha256', markerKey(secret))
		.update(`${MARKER_CONTEXT}\n${fullId}\n${login.toLowerCase()}\n${exp}`)
		.digest('base64url');
}

/**
 * The marker the in-process path sends as `ClientMetadata[VALIDATED_MARKER_KEY]`
 * after `validateUser` accepted `login`: `v1.<exp>.<base64url(login)>.<hmac>`.
 *
 * @internal
 */
export function signValidatedMarker(secret: string, fullId: string, login: string, now = Date.now()): string {
	const exp = now + MARKER_TTL_MS;
	const encodedLogin = Buffer.from(login, 'utf8').toString('base64url');
	return `v1.${exp}.${encodedLogin}.${markerSignature(secret, fullId, login, exp)}`;
}

/**
 * Whether `marker` proves `validateUser` already accepted this event's user
 * in-process: a valid signature for this block, unexpired, for a login the
 * event's user carries (`userName`, or the `email` / `phone_number` a
 * username-attribute pool fills from it).
 *
 * @internal
 */
export function verifyValidatedMarker(
	marker: string | undefined,
	secret: string,
	fullId: string,
	event: PreSignUpEvent,
	now = Date.now(),
): boolean {
	if (!marker || event.triggerSource === 'PreSignUp_ExternalProvider') return false;
	const parts = marker.split('.');
	if (parts.length !== 4 || parts[0] !== 'v1') return false;
	const [, expText = '', encodedLogin = '', signature = ''] = parts;
	const exp = Number(expText);
	if (!Number.isSafeInteger(exp) || exp < now || exp > now + MARKER_TTL_MS + 60_000) return false;
	const login = Buffer.from(encodedLogin, 'base64url').toString('utf8');
	if (!login || !constantTimeEquals(signature, markerSignature(secret, fullId, login, exp))) return false;
	const lower = login.toLowerCase();
	const known = [event.userName, event.userAttributes.email, event.userAttributes.phone_number];
	return known.some((v) => v !== undefined && v.toLowerCase() === lower);
}

// ── The trigger handler ─────────────────────────────────────────────────────

/** What the trigger handler needs from `AuthBase`. */
export interface PreSignUpTriggerDeps {
	options: AuthOptions;
	fullId: string;
	/** The session secret (the marker key). */
	sessionSecret(): Promise<string>;
	log: ChildLogger;
}

function rejection(error: ApiError): Error {
	// A plain Error: Cognito reads only the message. Nothing else is attached.
	return new Error(encodeTriggerRejection(error));
}

/**
 * Answer one PreSignUp trigger event: resolve to accept, throw to reject (see
 * the module documentation). Never modifies the event.
 *
 * @internal
 */
export async function handlePreSignUpTrigger(event: unknown, deps: PreSignUpTriggerDeps): Promise<void> {
	const parsed = parsePreSignUpEvent(event);
	if (!parsed) {
		const source: unknown =
			typeof event === 'object' && event !== null ? Reflect.get(event, 'triggerSource') : undefined;
		deps.log.error('[bb-auth] the user pool trigger received an event it does not handle; rejecting it', {
			triggerSource: typeof source === 'string' ? source : typeof source,
		});
		throw rejection(new ApiError(INTERNAL_ERROR_MESSAGE, 500, { name: AuthErrors.InternalError, retriable: true }));
	}
	const validateUser = deps.options.validateUser;
	if (!validateUser) return;

	const marker = parsed.clientMetadata[VALIDATED_MARKER_KEY];
	if (marker) {
		let secret: string | undefined;
		try {
			secret = await deps.sessionSecret();
		} catch (e) {
			deps.log.warn('[bb-auth] could not read the session secret to verify a sign-up marker; validating', {
				error: e instanceof Error ? e.name : typeof e,
			});
		}
		if (secret && verifyValidatedMarker(marker, secret, deps.fullId, parsed)) return;
	}

	try {
		await validateUser(candidateFromTrigger(deps.options, parsed));
	} catch (e) {
		throw rejection(toAuthApiError(e, deps.log));
	}
}
