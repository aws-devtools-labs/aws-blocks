// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The local (mock) user-pool engine — a port of `AuthCognito`'s mock behind
 * the {@link NativeEngine} contract. Runs fully offline: users, groups, codes,
 * challenges, MFA / TOTP, devices, passkeys and the admin surface live in
 * `.bb-data/<fullId>/state.json` (`native-mock-store.ts`, `AuthCognito`'s file
 * format, read as-is).
 *
 * Throws Cognito-shaped service errors (`serviceError`), never `ApiError`s for
 * service conditions, so `AuthBase` maps them exactly as it maps the Cognito
 * engine's — the same statuses, `retriable` flags and enumeration masking.
 *
 * Mock vs AWS differences are listed in `DESIGN.md` ("Mock vs AWS behaviour
 * differences"). In short: TOTP accepts any 6-digit code, passkey assertions
 * are matched by credential id without a signature check, passwords are stored
 * in plain text, and tokens are unsigned (`alg: 'none'`).
 *
 * Mock-only, never imported by the AWS or browser entries.
 *
 * @internal
 */

import crypto from 'node:crypto';
import { registerSdkIdentifiers } from '@aws-blocks/core';
import { getMockDataDir } from '@aws-blocks/core/bb-utils';
import { selfSignUpEnabled } from '../cdk/contract.js';
import {
	DECOY_FIRST_FACTORS,
	fabricateCodeDelivery,
	incorrectCredentialsError,
	maskEmail,
	maskPhone,
	WRONG_CODE_MESSAGE,
} from '../enumeration.js';
import { AuthErrors } from '../errors.js';
import { decodeJwtPayload } from '../sessions.js';
import { type ContactAttribute, isInFormatOf, resolveSignInMode, type SignInMode } from '../sign-in-mode.js';
import type {
	CodeDeliveryDetails,
	CodeDeliveryFn,
	ConfirmSignInOptions,
	DeviceRecord,
	EmailPasswordOptions,
	MfaFactor,
	MfaMode,
	PasskeyDescription,
	PasskeyOptions,
	PreferredChallenge,
	ResetPasswordResult,
	SignInNextStep,
	UpdateAttributeOutcome,
} from '../types.js';
import { signUpNotPermitted } from './attribute-write-rules.js';
import { MockAttributeSchema } from './mock-attribute-schema.js';
import { mockAdminEngine } from './native-mock-admin.js';
import { MockStore, type MockUserRecord, revisionOf, serviceError, userNotFound } from './native-mock-store.js';
import type {
	EngineHost,
	NativeAdminEngine,
	NativeDevicePage,
	NativeEngine,
	NativeMfaPreference,
	NativeMfaPreferenceInput,
	NativeSignInOutcome,
	NativeSignUpInput,
	NativeSignUpOutcome,
	PoolTokens,
} from './types.js';

/** Options only the local runtime understands. */
export interface MockEngineOptions {
	/** The mock-only `codeDelivery` hook (`AuthMockOptions.codeDelivery`). */
	codeDelivery?: CodeDeliveryFn;
}

/** The `mfa` option, resolved: mode plus permitted factors (default `['SMS', 'TOTP']`, the CDK layer's). */
function resolveMfa(mfa: MfaMode | { mode?: MfaMode; types?: readonly MfaFactor[] } | undefined): {
	mode: MfaMode;
	types: readonly MfaFactor[];
} {
	if (mfa === undefined) return { mode: 'off', types: ['SMS', 'TOTP'] };
	if (typeof mfa === 'string') return { mode: mfa, types: ['SMS', 'TOTP'] };
	return { mode: mfa.mode ?? 'off', types: mfa.types ?? ['SMS', 'TOTP'] };
}

/** Parse a WebAuthn credential JSON (rejecting non-JSON as Cognito does); `null` when it is not an object. */
function parseCredential(credential: string): object | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(credential);
	} catch {
		throw serviceError(AuthErrors.InvalidParameter, 'credential must be JSON');
	}
	return typeof parsed === 'object' && parsed !== null ? parsed : null;
}

/** Parse a WebAuthn credential JSON and return its `id` (or `rawId`); `''` when absent. */
function credentialIdOf(credential: string): string {
	const parsed = parseCredential(credential);
	if (!parsed) return '';
	const id: unknown = Reflect.get(parsed, 'id');
	const rawId: unknown = Reflect.get(parsed, 'rawId');
	return typeof id === 'string' ? id : typeof rawId === 'string' ? rawId : '';
}

/**
 * What Cognito records from a registration credential besides its id (L22):
 * `response.transports` (→ `AuthenticatorTransports`) and
 * `authenticatorAttachment` (→ `AuthenticatorAttachment`).
 */
function authenticatorInfoOf(credential: string): { transports?: string[]; authenticatorAttachment?: string } {
	const parsed = parseCredential(credential);
	if (!parsed) return {};
	const out: { transports?: string[]; authenticatorAttachment?: string } = {};
	const response: unknown = Reflect.get(parsed, 'response');
	const transports: unknown =
		typeof response === 'object' && response !== null ? Reflect.get(response, 'transports') : undefined;
	if (Array.isArray(transports)) {
		const list = transports.filter((t): t is string => typeof t === 'string');
		if (list.length > 0) out.transports = list;
	}
	const attachment: unknown = Reflect.get(parsed, 'authenticatorAttachment');
	if (typeof attachment === 'string' && attachment) out.authenticatorAttachment = attachment;
	return out;
}

/** 20 random bytes, base32 (RFC 4648) — a TOTP shared secret. */
function generateTotpSecret(): string {
	const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
	let bits = '';
	for (const b of crypto.randomBytes(20)) bits += b.toString(2).padStart(8, '0');
	let out = '';
	for (let i = 0; i < bits.length; i += 5) out += alphabet[Number.parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)];
	return out;
}

const SIX_DIGITS = /^\d{6}$/;

/** The contact attributes, each with a `<name>_verified` flag. */
const CONTACT_ATTRIBUTES: readonly ContactAttribute[] = ['email', 'phone_number'];

/** Which auto-verified contact Cognito sends the sign-up code to when the user has both: the phone first. */
const SIGN_UP_CODE_PREFERENCE: readonly ContactAttribute[] = ['phone_number', 'email'];

/**
 * Where `ForgotPassword` sends a reset code: the first **verified** contact in
 * the pool's `AccountRecoverySetting` priority, skipping the one whose factor
 * is the user's preferred MFA (FX39, R75). Every pool the CDK layer provisions
 * has `verified_phone_number` (1), `verified_email` (2) — CDK's default
 * `AccountRecovery.PHONE_WITHOUT_MFA_AND_EMAIL` — which is also Cognito's
 * order for a pool without the setting (developer guide, "Passwords, account
 * recovery, and password policies").
 */
const RECOVERY_PRIORITY: readonly (readonly [ContactAttribute, MfaFactor])[] = [
	['phone_number', 'SMS'],
	['email', 'EMAIL'],
];

/**
 * The local user pool behind `Auth`'s default entry.
 *
 * @internal
 */
export class MockNativeEngine implements NativeEngine {
	readonly admin: NativeAdminEngine;
	private readonly store: MockStore;
	private readonly host: EngineHost;
	private readonly mfa: { mode: MfaMode; types: readonly MfaFactor[] };
	private readonly passkeys?: PasskeyOptions;
	private readonly emailPassword: EmailPasswordOptions;
	private readonly signInMode: SignInMode;
	/** Which attributes a write may carry, as the provisioned pool's schema allows (`mock-attribute-schema.ts`). */
	private readonly attributeSchema: MockAttributeSchema;

	constructor(host: EngineHost, options: MockEngineOptions = {}) {
		this.host = host;
		const opts = host.options;
		const ep = opts.emailPassword;
		this.emailPassword = typeof ep === 'object' ? ep : {};
		this.mfa = resolveMfa(opts.mfa);
		this.passkeys = opts.passkeys || undefined;
		this.signInMode = resolveSignInMode(opts.users?.signInWith);
		this.attributeSchema = new MockAttributeSchema({
			...(opts.users?.attributes ? { attributes: opts.users.attributes } : {}),
			externalPool: opts.userPool !== undefined,
		});
		const fullId = host.scope.fullId;
		this.store = new MockStore({
			dataDir: getMockDataDir(host.scope),
			fullId,
			log: host.log,
			...(options.codeDelivery ? { codeDelivery: options.codeDelivery } : {}),
			...(this.emailPassword.passwordPolicy ? { passwordPolicy: this.emailPassword.passwordPolicy } : {}),
			groups: (opts.users?.groups ?? []).map((g) => (typeof g === 'string' ? g : g.name)),
			signInMode: this.signInMode,
		});
		this.admin = mockAdminEngine(this.store, (login, attrs, exists) => {
			// `AdminCreateUser` validates the attributes against the pool's schema first.
			this.attributeSchema.check(attrs, 'adminCreateUser');
			const created = this.newUser(login, attrs, exists);
			// Then an email / phone the admin marks verified must not be another
			// user's verified alias: `Auth` sends no `ForceAliasCreation`, so
			// Cognito answers `AliasExistsException` (FX49). On a username-attribute
			// pool `newUser` has already refused one in use (`UsernameExistsException`).
			for (const attr of this.signInMode.aliasAttributes) {
				const value = created.attributes[attr];
				if (value && created.attributes[`${attr}_verified`] === 'true') this.refuseAliasInUse(attr, value);
			}
			return created;
		});
		registerSdkIdentifiers(fullId, { userPoolId: `mock-pool-${fullId}`, clientId: `mock-client-${fullId}` });
	}

	// ── Sign-up ─────────────────────────────────────────────────────────────

	async signUp(input: NativeSignUpInput): Promise<NativeSignUpOutcome> {
		const { password } = input;
		// Cognito refuses self-service sign-up on a pool with AllowAdminCreateUserOnly.
		// Before any attribute rule, on both engines (FX44).
		if (!selfSignUpEnabled(this.host.options)) throw signUpNotPermitted();
		// As Cognito does: an unknown or non-string attribute is refused, not stored.
		this.attributeSchema.check(input.attributes, 'signUp');
		const { username, userSub, attributes } = this.newUser(
			input.username,
			{ ...input.attributes },
			'User already exists',
		);
		this.store.enforcePasswordPolicy(password);
		// As on Cognito, a new user's email / phone starts unverified; the
		// confirmation code verifies the one it is sent to (`confirmSignUp`).
		for (const contact of CONTACT_ATTRIBUTES) {
			if (attributes[contact]) attributes[`${contact}_verified`] ??= 'false';
		}
		// Users always start unconfirmed and must complete the emailed-code flow (Q2).
		this.store.addUser(username, {
			userSub,
			password,
			confirmed: false,
			disabled: false,
			attributes,
			mfaPreference: { enabled: [] },
			totpVerified: false,
			devices: {},
		});
		await this.store.generateCode('signUp', username);
		return {
			userConfirmed: false,
			userSub,
			codeDeliveryDetails: this.signUpCodeDelivery(attributes),
			// Stands in for Cognito's SignUp `Session`: `signIn` recognises it on the
			// auto-sign-in path and skips the USER_AUTH one-time code, as Cognito does.
			bridgeSession: bridgeFor(userSub),
		};
	}

	async confirmSignUp(input: { username: string; code: string; bridgeSession?: string }): Promise<{
		bridgeSession?: string;
	}> {
		const found = this.store.resolve(input.username);
		// `AuthBase` answers an unknown user exactly like a wrong code.
		if (!found) throw userNotFound();
		const { user } = found;
		// Cognito's answer for a CONFIRMED user, whatever the code. `AuthBase`
		// folds it into the wrong-code error unless `revealExistingUsers` is set.
		if (user.confirmed) {
			throw serviceError(AuthErrors.NotAuthorized, 'User cannot be confirmed. Current status is CONFIRMED');
		}
		// Cognito marks verified only the contact attribute the sign-up code was
		// sent to ("the attribute that was used to confirm"), so Email / SMS MFA
		// and the one-time-code first factors can use that one right away. Any
		// other email / phone stays unverified until `confirmUserAttribute` (R67).
		const delivered = this.signUpCodeAttribute(user.attributes);
		// A valid code for an email / phone another user holds as a verified alias
		// is `AliasExistsException`: the user stays unconfirmed and the code stays
		// valid (FX49). Checked only once the code matches, as Cognito does, so a
		// caller without the code learns nothing.
		this.store.verifyCode(`signUp:${found.username}`, input.code, () => {
			if (delivered) this.refuseAliasInUse(delivered, user.attributes[delivered], found.username);
		});
		user.confirmed = true;
		if (delivered) user.attributes[`${delivered}_verified`] = 'true';
		this.store.flush();
		return { bridgeSession: bridgeFor(user.userSub) };
	}

	async resendSignUpCode(username: string): Promise<void> {
		// Resolves for an unknown username too (no code is sent), so the call
		// cannot be used to probe which accounts exist.
		const found = this.store.resolve(username);
		if (!found) return;
		// Cognito's answer for a CONFIRMED user — and no code goes out. `AuthBase`
		// turns it into the same silent success unless `revealExistingUsers` is set.
		if (found.user.confirmed) throw serviceError(AuthErrors.InvalidParameter, 'User is already confirmed.');
		await this.store.generateCode('signUp', found.username);
	}

	// ── Sign-in ─────────────────────────────────────────────────────────────

	async signIn(input: {
		username: string;
		password: string;
		clientMetadata?: Record<string, string>;
		preferredChallenge?: PreferredChallenge;
		bridgeSession?: string;
	}): Promise<NativeSignInOutcome> {
		const found = this.store.resolve(input.username);
		if (!found) {
			// Choice-based sign-in has no password to reject yet: Cognito (with
			// PreventUserExistenceErrors) issues an unknown user a challenge, so the
			// first step looks like a real user's. Every answer to it then fails.
			if (this.host.options.users?.authFlow === 'USER_AUTH') {
				return {
					status: 'continueSignIn',
					nextStep: await this.decoyFirstFactor(input.username, input.preferredChallenge),
				};
			}
			// `AuthBase` makes this indistinguishable from a wrong password.
			throw userNotFound();
		}
		// From here on, the stored (Cognito) username — what the tokens carry.
		const { username, user } = found;
		if (user.disabled) throw serviceError(AuthErrors.NotAuthorized, 'User is disabled.');

		if (this.host.options.users?.authFlow === 'USER_AUTH') {
			// Choice-based sign-in: no password yet. Issue a first-factor picker,
			// or the preferred factor's challenge directly.
			if (!user.confirmed) throw serviceError(AuthErrors.UserNotConfirmed, 'User is not confirmed.');
			// The auto-sign-in bridge: the user just proved they own the contact by
			// entering the sign-up code, so Cognito skips the one-time code.
			if (input.bridgeSession && input.bridgeSession === bridgeFor(user.userSub)) {
				return this.signedIn(username, user);
			}
			return {
				status: 'continueSignIn',
				nextStep: await this.firstFactorChallenge(username, user, input.preferredChallenge),
			};
		}

		// USER_PASSWORD_AUTH (classic).
		if (user.password !== input.password) {
			throw serviceError(AuthErrors.NotAuthorized, 'Incorrect username or password.');
		}
		return this.afterPassword(username, user);
	}

	/** What follows a correct password: confirmation, reset, forced change, MFA, or tokens. */
	private async afterPassword(username: string, user: MockUserRecord): Promise<NativeSignInOutcome> {
		if (!user.confirmed) throw serviceError(AuthErrors.UserNotConfirmed, 'User is not confirmed.');
		if (user.passwordResetRequired) {
			throw serviceError(AuthErrors.PasswordResetRequired, 'Password reset required for the user');
		}
		// Admin-created users (temporary password) hit NEW_PASSWORD_REQUIRED on first sign-in.
		if (user.forcePasswordChange) {
			return {
				status: 'continueSignIn',
				nextStep: this.store.issueChallenge(username, {
					name: 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED',
					session: '',
				}),
			};
		}
		const challenge = await this.selectMfaChallenge(username, user);
		if (challenge) return { status: 'continueSignIn', nextStep: challenge };
		return this.signedIn(username, user);
	}

	private signedIn(username: string, user: MockUserRecord): NativeSignInOutcome {
		return { status: 'signedIn', tokens: this.store.mintTokens(username, user) };
	}

	/**
	 * `USER_AUTH` first factor: with a preferred challenge, issue it directly;
	 * otherwise offer the available factors (`PASSWORD`, plus a passwordless leg
	 * per verified contact attribute, plus `WEB_AUTHN` when the user has a
	 * passkey) — as Cognito computes `AVAILABLE_CHALLENGES` per user.
	 */
	private async firstFactorChallenge(
		username: string,
		user: MockUserRecord,
		preferred: PreferredChallenge | undefined,
	): Promise<SignInNextStep> {
		const available: PreferredChallenge[] = ['PASSWORD'];
		if (user.attributes.email_verified === 'true') available.push('EMAIL_OTP');
		if (user.attributes.phone_number_verified === 'true') available.push('SMS_OTP');
		if (this.passkeys && (user.passkeys?.length ?? 0) > 0) available.push('WEB_AUTHN');

		const choice = preferred ?? (available.length === 1 ? available[0] : undefined);
		if (!choice) {
			return this.store.issueChallenge(
				username,
				{ name: 'CONTINUE_SIGN_IN_WITH_FIRST_FACTOR_SELECTION', session: '', availableChallenges: available },
				{ flow: 'USER_AUTH' },
			);
		}
		if (!available.includes(choice)) {
			throw serviceError(AuthErrors.InvalidParameter, `First factor '${choice}' is not available for this user.`);
		}
		switch (choice) {
			case 'PASSWORD':
				return this.store.issueChallenge(
					username,
					{ name: 'CONFIRM_SIGN_IN_WITH_PASSWORD', session: '' },
					{ flow: 'USER_AUTH' },
				);
			case 'EMAIL_OTP':
				await this.store.generateCode('mfa', username);
				return this.store.issueChallenge(
					username,
					{
						name: 'CONFIRM_SIGN_IN_WITH_FIRST_FACTOR_EMAIL_OTP',
						session: '',
						codeDeliveryDetails: {
							destination: maskEmail(user.attributes.email ?? ''),
							deliveryMedium: 'EMAIL',
							attributeName: 'email',
						},
					},
					{ flow: 'USER_AUTH' },
				);
			case 'SMS_OTP':
				await this.store.generateCode('mfa', username);
				return this.store.issueChallenge(
					username,
					{
						name: 'CONFIRM_SIGN_IN_WITH_FIRST_FACTOR_SMS_OTP',
						session: '',
						codeDeliveryDetails: {
							destination: maskPhone(user.attributes.phone_number ?? ''),
							deliveryMedium: 'SMS',
							attributeName: 'phone_number',
						},
					},
					{ flow: 'USER_AUTH' },
				);
			case 'WEB_AUTHN': {
				// A deterministic request-options blob keyed by the user, so e2e
				// tests can match it without a real authenticator.
				const credentialRequestOptions = JSON.stringify({
					challenge: `mock-challenge-${user.userSub}`,
					rpId: this.passkeys?.relyingPartyId ?? 'localhost',
					allowCredentials: (user.passkeys ?? []).map((p) => ({ id: p.credentialId, type: 'public-key' })),
					userVerification: this.passkeys?.userVerification ?? 'preferred',
					timeout: 60000,
				});
				return this.store.issueChallenge(
					username,
					{ name: 'CONFIRM_SIGN_IN_WITH_WEB_AUTHN', session: '', credentialRequestOptions },
					{ flow: 'USER_AUTH' },
				);
			}
		}
	}

	/**
	 * {@link firstFactorChallenge} for an unknown user: the same steps a
	 * confirmed user with a verified email is offered, but marked as a decoy so
	 * no answer can succeed, and no code is sent. The one-time-code destination
	 * is fabricated the way password reset fabricates one.
	 */
	private async decoyFirstFactor(login: string, preferred: PreferredChallenge | undefined): Promise<SignInNextStep> {
		const available: readonly PreferredChallenge[] = DECOY_FIRST_FACTORS;
		const extras = { flow: 'USER_AUTH' as const, decoy: true };
		if (!preferred) {
			return this.store.issueChallenge(
				login,
				{
					name: 'CONTINUE_SIGN_IN_WITH_FIRST_FACTOR_SELECTION',
					session: '',
					availableChallenges: [...available],
				},
				extras,
			);
		}
		if (!available.includes(preferred)) {
			throw serviceError(
				AuthErrors.InvalidParameter,
				`First factor '${preferred}' is not available for this user.`,
			);
		}
		if (preferred === 'PASSWORD') {
			return this.store.issueChallenge(login, { name: 'CONFIRM_SIGN_IN_WITH_PASSWORD', session: '' }, extras);
		}
		return this.store.issueChallenge(
			login,
			{
				name: 'CONFIRM_SIGN_IN_WITH_FIRST_FACTOR_EMAIL_OTP',
				session: '',
				codeDeliveryDetails: fabricateCodeDelivery(login, await this.host.sessionSecret()),
			},
			extras,
		);
	}

	/** Answer a {@link decoyFirstFactor} challenge: fail exactly as a real user's wrong answer does. */
	private async answerDecoy(
		session: string,
		challenge: { username: string; step: SignInNextStep['name'] },
		response: string,
	): Promise<NativeSignInOutcome> {
		switch (challenge.step) {
			case 'CONTINUE_SIGN_IN_WITH_FIRST_FACTOR_SELECTION':
				if (
					response !== 'PASSWORD' &&
					response !== 'EMAIL_OTP' &&
					response !== 'SMS_OTP' &&
					response !== 'WEB_AUTHN'
				) {
					throw serviceError(AuthErrors.InvalidParameter, `Unknown first factor '${response}'.`);
				}
				this.store.consumeChallenge(session);
				return {
					status: 'continueSignIn',
					nextStep: await this.decoyFirstFactor(challenge.username, response),
				};
			case 'CONFIRM_SIGN_IN_WITH_PASSWORD':
				throw incorrectCredentialsError();
			case 'CONFIRM_SIGN_IN_WITH_FIRST_FACTOR_EMAIL_OTP':
				throw serviceError(AuthErrors.CodeMismatch, WRONG_CODE_MESSAGE);
			default:
				throw serviceError(AuthErrors.InvalidParameter, 'Unsupported challenge');
		}
	}

	/** MFA challenge selection after a correct password (Cognito's logic at a high level). */
	private async selectMfaChallenge(username: string, user: MockUserRecord): Promise<SignInNextStep | null> {
		const { mode, types } = this.mfa;
		if (mode === 'off') return null;
		// A verified email / phone is automatically available for Email / SMS
		// MFA; only TOTP needs explicit enrolment.
		const enrolled: MfaFactor[] = [...user.mfaPreference.enabled];
		if (types.includes('EMAIL') && user.attributes.email_verified === 'true' && !enrolled.includes('EMAIL')) {
			enrolled.push('EMAIL');
		}
		if (types.includes('SMS') && user.attributes.phone_number_verified === 'true' && !enrolled.includes('SMS')) {
			enrolled.push('SMS');
		}
		// MFA required, nothing enrolled: route into enrolment. TOTP and EMAIL can
		// be enrolled mid-sign-in; SMS cannot (the phone must be verified first).
		if (mode === 'required' && enrolled.length === 0) {
			const setup = types.filter((t): t is 'TOTP' | 'EMAIL' => t === 'TOTP' || t === 'EMAIL');
			if (setup.length === 0) {
				throw serviceError(
					AuthErrors.InvalidParameter,
					'MFA is required but no factor can be enrolled. Configure TOTP / EMAIL or verify an SMS number.',
				);
			}
			if (setup.length > 1) {
				return this.store.issueChallenge(username, {
					name: 'CONTINUE_SIGN_IN_WITH_MFA_SETUP_SELECTION',
					session: '',
					allowedMFATypes: setup,
				});
			}
			return this.challengeForMfaSetup(username, setup[0]);
		}
		if (enrolled.length === 0) return null;
		const preferred = user.mfaPreference.preferred;
		if (preferred && preferred !== 'NOMFA' && enrolled.includes(preferred)) {
			return this.challengeForMfaType(username, user, preferred);
		}
		if (enrolled.length > 1) {
			return this.store.issueChallenge(username, {
				name: 'CONTINUE_SIGN_IN_WITH_MFA_SELECTION',
				session: '',
				allowedMFATypes: enrolled,
			});
		}
		return this.challengeForMfaType(username, user, enrolled[0]);
	}

	private async challengeForMfaType(
		username: string,
		user: MockUserRecord,
		type: MfaFactor,
	): Promise<SignInNextStep> {
		switch (type) {
			case 'SMS':
				await this.store.generateCode('mfa', username);
				return this.store.issueChallenge(username, {
					name: 'CONFIRM_SIGN_IN_WITH_SMS_CODE',
					session: '',
					codeDeliveryDetails: {
						destination: maskPhone(user.attributes.phone_number ?? ''),
						deliveryMedium: 'SMS',
						attributeName: 'phone_number',
					},
				});
			case 'TOTP':
				// The code comes from the user's authenticator app; nothing to send.
				return this.store.issueChallenge(username, { name: 'CONFIRM_SIGN_IN_WITH_TOTP_CODE', session: '' });
			case 'EMAIL':
				await this.store.generateCode('mfa', username);
				return this.store.issueChallenge(username, {
					name: 'CONFIRM_SIGN_IN_WITH_EMAIL_CODE',
					session: '',
					codeDeliveryDetails: {
						destination: maskEmail(user.attributes.email ?? ''),
						deliveryMedium: 'EMAIL',
						attributeName: 'email',
					},
				});
		}
	}

	private challengeForMfaSetup(username: string, type: 'TOTP' | 'EMAIL'): SignInNextStep {
		if (type === 'TOTP') {
			return this.store.issueChallenge(username, {
				name: 'CONTINUE_SIGN_IN_WITH_TOTP_SETUP',
				session: '',
				sharedSecret: generateTotpSecret(),
			});
		}
		// EMAIL enrolment: the user submits the address first; the code follows.
		return this.store.issueChallenge(username, { name: 'CONTINUE_SIGN_IN_WITH_EMAIL_SETUP', session: '' });
	}

	async confirmSignIn(input: {
		session: string;
		response: string;
		options?: ConfirmSignInOptions;
	}): Promise<NativeSignInOutcome> {
		const { session, response } = input;
		const challenge = this.store.challenge(session);
		if (challenge.decoy) return this.answerDecoy(session, challenge, response);
		const username = challenge.username;
		const user = this.store.user(username);
		// A user removed mid-challenge looks like any other credential failure.
		if (!user) throw incorrectCredentialsError();

		switch (challenge.step) {
			case 'CONFIRM_SIGN_IN_WITH_SMS_CODE':
			case 'CONFIRM_SIGN_IN_WITH_EMAIL_CODE': {
				this.store.verifyCode(`mfa:${username}`, response);
				// An EMAIL code spawned by EMAIL enrolment also finishes the enrolment.
				if (challenge.step === 'CONFIRM_SIGN_IN_WITH_EMAIL_CODE' && challenge.isEmailSetup) {
					const enabled = new Set(user.mfaPreference.enabled);
					enabled.add('EMAIL');
					user.mfaPreference = { preferred: 'EMAIL', enabled: [...enabled] };
					user.attributes.email_verified = 'true';
				}
				break;
			}
			case 'CONFIRM_SIGN_IN_WITH_TOTP_CODE':
				// No RFC 6238 verifier locally: any 6-digit code passes (DESIGN.md).
				if (!SIX_DIGITS.test(response)) {
					throw serviceError(AuthErrors.CodeMismatch, 'Invalid code received for user');
				}
				break;
			case 'CONTINUE_SIGN_IN_WITH_MFA_SELECTION': {
				if (response !== 'SMS' && response !== 'TOTP' && response !== 'EMAIL') {
					throw serviceError(AuthErrors.InvalidParameter, `Unknown MFA type '${response}'.`);
				}
				this.store.consumeChallenge(session);
				return { status: 'continueSignIn', nextStep: await this.challengeForMfaType(username, user, response) };
			}
			case 'CONTINUE_SIGN_IN_WITH_MFA_SETUP_SELECTION': {
				if (response !== 'TOTP' && response !== 'EMAIL') {
					throw serviceError(AuthErrors.InvalidParameter, `Unknown MFA type '${response}'.`);
				}
				this.store.consumeChallenge(session);
				return { status: 'continueSignIn', nextStep: this.challengeForMfaSetup(username, response) };
			}
			case 'CONTINUE_SIGN_IN_WITH_TOTP_SETUP': {
				if (!SIX_DIGITS.test(response)) {
					throw serviceError(AuthErrors.EnableSoftwareTokenMFA, 'Code mismatch');
				}
				user.totpSharedSecret = challenge.sharedSecret;
				user.totpVerified = true;
				const enabled = new Set(user.mfaPreference.enabled);
				enabled.add('TOTP');
				user.mfaPreference = { preferred: 'TOTP', enabled: [...enabled] };
				break;
			}
			case 'CONTINUE_SIGN_IN_WITH_EMAIL_SETUP': {
				if (!response.includes('@')) throw serviceError(AuthErrors.InvalidParameter, 'Invalid email address');
				user.attributes.email = response;
				user.attributes.email_verified = 'false';
				this.store.consumeChallenge(session);
				await this.store.generateCode('mfa', username);
				return {
					status: 'continueSignIn',
					nextStep: this.store.issueChallenge(
						username,
						{
							name: 'CONFIRM_SIGN_IN_WITH_EMAIL_CODE',
							session: '',
							codeDeliveryDetails: {
								destination: maskEmail(response),
								deliveryMedium: 'EMAIL',
								attributeName: 'email',
							},
						},
						{ isEmailSetup: true },
					),
				};
			}
			case 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED':
				this.store.enforcePasswordPolicy(response);
				// Written through the app client to an existing user, like `UpdateUserAttributes`;
				// checked before anything changes.
				if (input.options?.userAttributes) this.attributeSchema.check(input.options.userAttributes, 'update');
				user.password = response;
				delete user.forcePasswordChange;
				if (input.options?.userAttributes) {
					for (const [k, v] of Object.entries(input.options.userAttributes)) {
						if (v !== undefined) user.attributes[k] = v;
					}
				}
				break;
			case 'CONTINUE_SIGN_IN_WITH_FIRST_FACTOR_SELECTION': {
				if (
					response !== 'PASSWORD' &&
					response !== 'EMAIL_OTP' &&
					response !== 'SMS_OTP' &&
					response !== 'WEB_AUTHN'
				) {
					throw serviceError(AuthErrors.InvalidParameter, `Unknown first factor '${response}'.`);
				}
				this.store.consumeChallenge(session);
				return {
					status: 'continueSignIn',
					nextStep: await this.firstFactorChallenge(username, user, response),
				};
			}
			case 'CONFIRM_SIGN_IN_WITH_PASSWORD':
				// A challenge answered with a password: only the engine knows the flow,
				// so it raises the uniform credential failure itself. The challenge
				// stays alive so the user can retry.
				if (user.password !== response) throw incorrectCredentialsError();
				this.store.consumeChallenge(session);
				// The password leg of USER_AUTH continues like a classic sign-in
				// (reset / forced change / MFA).
				return this.afterPassword(username, user);
			case 'CONFIRM_SIGN_IN_WITH_FIRST_FACTOR_EMAIL_OTP':
			case 'CONFIRM_SIGN_IN_WITH_FIRST_FACTOR_SMS_OTP':
				this.store.verifyCode(`mfa:${username}`, response);
				break;
			case 'CONFIRM_SIGN_IN_WITH_WEB_AUTHN': {
				// Loose mock: any well-formed assertion JSON whose `id` / `rawId` is a
				// registered credential of this user. No signature check (DESIGN.md).
				const credentialId = credentialIdOf(response);
				if (!credentialId || !(user.passkeys ?? []).some((p) => p.credentialId === credentialId)) {
					throw serviceError(AuthErrors.WebAuthnCredentialNotSupported, 'Unknown passkey credential');
				}
				break;
			}
			default:
				throw serviceError(AuthErrors.InvalidParameter, 'Unsupported challenge');
		}
		this.store.consumeChallenge(session);
		return this.signedIn(username, user);
	}

	// ── Password reset & change ─────────────────────────────────────────────

	async resetPassword(login: string): Promise<ResetPasswordResult> {
		const found = this.store.resolve(login);
		// As Cognito with PreventUserExistenceErrors: an unknown or disabled user
		// gets a simulated delivery, and no code is sent.
		if (!found || found.user.disabled) {
			// Never reveal whether the account exists: plausible delivery details.
			return {
				isPasswordReset: false,
				nextStep: {
					name: 'CONFIRM_RESET_PASSWORD_WITH_CODE',
					codeDeliveryDetails: fabricateCodeDelivery(login, await this.host.sessionSecret()),
				},
			};
		}
		const { user } = found;
		const contact = RECOVERY_PRIORITY.find(
			([name, factor]) =>
				Boolean(user.attributes[name]) &&
				user.attributes[`${name}_verified`] === 'true' &&
				user.mfaPreference.preferred !== factor,
		)?.[0];
		// Cognito's answer for a user with no eligible verified contact (an
		// unconfirmed user has none yet), and no code goes out. `AuthBase` turns
		// it into the simulated delivery unless `revealExistingUsers` is set.
		if (!contact) {
			throw serviceError(
				AuthErrors.InvalidParameter,
				'Cannot reset password for the user as there is no registered/verified email or phone_number',
			);
		}
		await this.store.generateCode('resetPassword', found.username);
		return {
			isPasswordReset: false,
			nextStep: {
				name: 'CONFIRM_RESET_PASSWORD_WITH_CODE',
				codeDeliveryDetails: contactDelivery(contact, user.attributes[contact] ?? ''),
			},
		};
	}

	async confirmResetPassword(input: { username: string; code: string; newPassword: string }): Promise<void> {
		const found = this.store.resolve(input.username);
		// `AuthBase` answers an unknown user exactly like a wrong code.
		if (!found) throw userNotFound();
		const { user } = found;
		this.store.verifyCode(`resetPassword:${found.username}`, input.code);
		this.store.enforcePasswordPolicy(input.newPassword);
		user.password = input.newPassword;
		delete user.passwordResetRequired;
		delete user.forcePasswordChange;
		this.store.flush();
	}

	async updatePassword(input: { accessToken: string; oldPassword: string; newPassword: string }): Promise<void> {
		const { user } = this.store.userForAccessToken(input.accessToken);
		if (user.password !== input.oldPassword) {
			throw serviceError(AuthErrors.NotAuthorized, 'Incorrect username or password.');
		}
		this.store.enforcePasswordPolicy(input.newPassword);
		user.password = input.newPassword;
		this.store.flush();
	}

	// ── Session lifecycle ───────────────────────────────────────────────────

	async refresh(tokens: PoolTokens): Promise<PoolTokens | null> {
		const access = decodeJwtPayload(tokens.accessToken) ?? {};
		const id = decodeJwtPayload(tokens.idToken) ?? {};
		const username = typeof access.username === 'string' ? access.username : '';
		const user = username ? this.store.user(username) : undefined;
		// Rejected — as Cognito rejects the refresh token of a deleted or
		// disabled user, or one revoked by a global sign-out.
		if (!user || user.userSub !== access.sub || user.disabled) return null;
		if (revisionOf(access) < (user.tokenRevision ?? 0)) return null;
		const authTime = typeof id.auth_time === 'number' ? id.auth_time : undefined;
		return this.store.mintTokens(username, user, {
			...(authTime !== undefined ? { authTime } : {}),
			...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
		});
	}

	async listGroups(login: string): Promise<string[]> {
		return this.store.groupsOf(this.store.requireResolved(login).username);
	}

	async signOut(tokens: PoolTokens, options: { global: boolean }): Promise<void> {
		if (!options.global) return; // A local sign-out has nothing to revoke in the mock.
		const access = decodeJwtPayload(tokens.accessToken) ?? {};
		const username = typeof access.username === 'string' ? access.username : '';
		const user = username ? this.store.user(username) : undefined;
		if (!user || user.userSub !== access.sub) return;
		user.tokenRevision = (user.tokenRevision ?? 0) + 1;
		this.store.flush();
	}

	// ── Passkeys ────────────────────────────────────────────────────────────

	private requirePasskeys(): PasskeyOptions {
		if (!this.passkeys)
			throw serviceError(AuthErrors.WebAuthnNotEnabled, 'Passkeys are not enabled for this user pool.');
		return this.passkeys;
	}

	async startPasskeyRegistration(accessToken: string): Promise<{ credentialCreationOptions: string }> {
		const passkeys = this.requirePasskeys();
		const { username, user } = this.store.userForAccessToken(accessToken);
		const credentialCreationOptions = JSON.stringify({
			challenge: crypto.randomBytes(16).toString('base64url'),
			rp: { id: passkeys.relyingPartyId, name: this.host.scope.fullId },
			user: { id: user.userSub, name: username, displayName: username },
			pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
			authenticatorSelection: { userVerification: passkeys.userVerification ?? 'preferred' },
			timeout: 60000,
		});
		return { credentialCreationOptions };
	}

	async completePasskeyRegistration(accessToken: string, credential: string): Promise<void> {
		this.requirePasskeys();
		const { user } = this.store.userForAccessToken(accessToken);
		const credentialId = credentialIdOf(credential);
		if (!credentialId) throw serviceError(AuthErrors.InvalidParameter, 'credential.id is required');
		const passkeys = user.passkeys ?? [];
		if (!passkeys.some((p) => p.credentialId === credentialId))
			passkeys.push({ credentialId, createdAt: Date.now(), ...authenticatorInfoOf(credential) });
		user.passkeys = passkeys;
		this.store.flush();
	}

	async listPasskeys(accessToken: string): Promise<PasskeyDescription[]> {
		this.requirePasskeys();
		const { user } = this.store.userForAccessToken(accessToken);
		return (user.passkeys ?? []).map((p) => ({
			credentialId: p.credentialId,
			...(p.friendlyName !== undefined ? { friendlyName: p.friendlyName } : {}),
			...(p.createdAt > 0 ? { createdAt: new Date(p.createdAt).toISOString() } : {}),
			...(p.transports ? { transports: [...p.transports] } : {}),
			...(p.authenticatorAttachment ? { authenticatorAttachment: p.authenticatorAttachment } : {}),
		}));
	}

	async deletePasskey(accessToken: string, credentialId: string): Promise<void> {
		this.requirePasskeys();
		const { user } = this.store.userForAccessToken(accessToken);
		user.passkeys = (user.passkeys ?? []).filter((p) => p.credentialId !== credentialId);
		this.store.flush();
	}

	// ── The signed-in user's account ────────────────────────────────────────

	async getUserAttributes(accessToken: string): Promise<Record<string, string>> {
		const { user } = this.store.userForAccessToken(accessToken);
		return { sub: user.userSub, ...user.attributes };
	}

	async updateUserAttributes(
		accessToken: string,
		attributes: Record<string, string>,
	): Promise<Record<string, UpdateAttributeOutcome>> {
		const { username, user } = this.store.userForAccessToken(accessToken);
		// Validated as a whole first, as Cognito does: a rejected write changes nothing.
		this.attributeSchema.check(attributes, 'update');
		// On a username-attribute pool the email / phone is the username: one
		// another user has, verified or not, is refused (FX49). On an alias pool
		// the new value is unverified, so it is no alias yet: accepted.
		for (const attr of this.signInMode.usernameAttributes) {
			const value = attributes[attr];
			if (value && value !== user.attributes[attr]) this.refuseAliasInUse(attr, value, username);
		}
		const out: Record<string, UpdateAttributeOutcome> = {};
		for (const [name, value] of Object.entries(attributes)) {
			const changedContact = (name === 'email' || name === 'phone_number') && user.attributes[name] !== value;
			user.attributes[name] = value;
			if (!changedContact) {
				out[name] = { isUpdated: true };
				continue;
			}
			// A changed contact attribute is unverified until its code is confirmed.
			user.attributes[`${name}_verified`] = 'false';
			await this.store.generateCode('attribute', username, attributeCodeKey(name, username));
			out[name] = {
				isUpdated: false,
				nextStep: {
					name: 'CONFIRM_ATTRIBUTE_WITH_CODE',
					codeDeliveryDetails: contactDelivery(name, value),
				},
			};
		}
		this.store.flush();
		return out;
	}

	async confirmUserAttribute(accessToken: string, name: string, code: string): Promise<void> {
		const { username, user } = this.store.userForAccessToken(accessToken);
		this.store.verifyCode(attributeCodeKey(name, username), code);
		if (name === 'email' || name === 'phone_number') {
			// Verifying an email / phone that is another user's verified alias moves
			// it here and marks it unverified there, without an error, as Cognito's
			// `VerifyUserAttribute` does (FX49).
			const value = user.attributes[name];
			if (value && this.signInMode.aliasAttributes.includes(name)) {
				for (const holder of this.store.aliasHolders(name, value, username)) {
					const other = this.store.user(holder);
					if (other) other.attributes[`${name}_verified`] = 'false';
				}
			}
			user.attributes[`${name}_verified`] = 'true';
		}
		this.store.flush();
	}

	async sendUserAttributeVerificationCode(accessToken: string, name: string): Promise<void> {
		const { username, user } = this.store.userForAccessToken(accessToken);
		if (!user.attributes[name]) {
			throw serviceError(AuthErrors.InvalidParameter, `The user has no ${name} to verify.`);
		}
		await this.store.generateCode('attribute', username, attributeCodeKey(name, username));
	}

	async deleteUser(accessToken: string): Promise<void> {
		const { username } = this.store.userForAccessToken(accessToken);
		this.store.deleteUser(username);
	}

	// ── MFA ─────────────────────────────────────────────────────────────────

	async setUpTotp(accessToken: string): Promise<{ sharedSecret: string }> {
		const { user } = this.store.userForAccessToken(accessToken);
		const sharedSecret = generateTotpSecret();
		user.totpSharedSecret = sharedSecret;
		user.totpVerified = false;
		this.store.flush();
		return { sharedSecret };
	}

	async verifyTotpSetup(accessToken: string, code: string): Promise<void> {
		const { user } = this.store.userForAccessToken(accessToken);
		if (!user.totpSharedSecret) {
			throw serviceError(AuthErrors.SoftwareTokenMFANotFound, 'Software token TOTP not set up for this user.');
		}
		// No RFC 6238 verifier locally: any 6-digit code passes (DESIGN.md).
		if (!SIX_DIGITS.test(code)) throw serviceError(AuthErrors.EnableSoftwareTokenMFA, 'Code mismatch');
		user.totpVerified = true;
		const enabled = new Set(user.mfaPreference.enabled);
		enabled.add('TOTP');
		user.mfaPreference = { preferred: user.mfaPreference.preferred ?? 'TOTP', enabled: [...enabled] };
		this.store.flush();
	}

	async updateMfaPreference(accessToken: string, input: NativeMfaPreferenceInput): Promise<void> {
		const { user } = this.store.userForAccessToken(accessToken);
		const deltas: [MfaFactor, NonNullable<NativeMfaPreferenceInput['sms']>][] = [];
		if (input.sms) deltas.push(['SMS', input.sms]);
		if (input.totp) deltas.push(['TOTP', input.totp]);
		if (input.email) deltas.push(['EMAIL', input.email]);
		// Cognito refuses TOTP before an authenticator app is associated + verified.
		if (deltas.some(([f, s]) => f === 'TOTP' && s !== 'DISABLED') && !user.totpVerified) {
			throw serviceError(
				AuthErrors.SoftwareTokenMFANotFound,
				'TOTP is not associated for this user. Call setUpTotp + verifyTotpSetup before enabling it as an MFA factor.',
			);
		}
		const enabled = new Set<MfaFactor>(user.mfaPreference.enabled);
		let preferred = user.mfaPreference.preferred;
		for (const [factor, setting] of deltas) {
			if (setting === 'DISABLED') {
				enabled.delete(factor);
				if (preferred === factor) preferred = undefined;
			} else if (setting === 'PREFERRED') {
				enabled.add(factor);
				preferred = factor; // auto-demotes the previous preferred factor
			} else {
				enabled.add(factor);
				if (preferred === factor) preferred = undefined;
			}
		}
		// Every factor explicitly disabled: the 'NOMFA' sentinel ("chose no MFA").
		if (enabled.size === 0 && preferred === undefined && deltas.some(([, s]) => s === 'DISABLED')) {
			preferred = 'NOMFA';
		}
		user.mfaPreference = { enabled: [...enabled], ...(preferred !== undefined ? { preferred } : {}) };
		this.store.flush();
	}

	async getMfaPreference(accessToken: string): Promise<NativeMfaPreference> {
		const { user } = this.store.userForAccessToken(accessToken);
		const enabled = new Set<MfaFactor>(user.mfaPreference.enabled);
		// A verified contact attribute auto-enables its factor, as on Cognito.
		if (this.mfa.types.includes('EMAIL') && user.attributes.email_verified === 'true') enabled.add('EMAIL');
		if (this.mfa.types.includes('SMS') && user.attributes.phone_number_verified === 'true') enabled.add('SMS');
		const preferred = user.mfaPreference.preferred;
		return { enabled: [...enabled], ...(preferred !== undefined ? { preferred } : {}) };
	}

	// ── Devices ─────────────────────────────────────────────────────────────

	async listDevices(accessToken: string, _options: { nextToken?: string }): Promise<NativeDevicePage> {
		const { user } = this.store.userForAccessToken(accessToken);
		return { devices: Object.values(user.devices).map((d) => ({ ...d, attributes: { ...d.attributes } })) };
	}

	async rememberDevice(accessToken: string): Promise<void> {
		const { user } = this.store.userForAccessToken(accessToken);
		const now = new Date().toISOString();
		const device: DeviceRecord = {
			deviceKey: crypto.randomUUID(),
			attributes: {},
			createDate: now,
			lastModifiedDate: now,
			lastAuthenticatedDate: now,
		};
		user.devices[device.deviceKey] = device;
		this.store.flush();
	}

	async forgetDevice(accessToken: string, deviceKey: string): Promise<void> {
		const { user } = this.store.userForAccessToken(accessToken);
		delete user.devices[deviceKey];
		this.store.flush();
	}

	// ── Helpers ─────────────────────────────────────────────────────────────

	/**
	 * The contact attribute Cognito sends a new user's sign-up code to — and so
	 * the one `confirmSignUp` verifies. The pool's `AutoVerifiedAttributes` are
	 * the contact members of `users.signInWith` (the CDK layer's
	 * `mapAutoVerify`). Cognito verifies one contact per sign-up and, given
	 * both, "chooses to verify the phone number": the phone when it is
	 * auto-verified and the user has one, else the email when it is. `undefined`
	 * when neither applies — Cognito then sends no code at all (DESIGN.md, "Mock
	 * vs AWS": the local pool still issues one, and confirming it verifies
	 * nothing).
	 */
	private signUpCodeAttribute(attributes: Record<string, string>): ContactAttribute | undefined {
		const { usernameAttributes, aliasAttributes } = this.signInMode;
		const autoVerified: readonly ContactAttribute[] = [...usernameAttributes, ...aliasAttributes];
		return SIGN_UP_CODE_PREFERENCE.find((c) => autoVerified.includes(c) && Boolean(attributes[c]));
	}

	/**
	 * Refuse `value` as `attribute` when a user other than `except` holds it as
	 * a sign-in attribute Cognito keeps unique ({@link MockStore.aliasHolders}):
	 * `AliasExistsException`, Cognito's name for it on `ConfirmSignUp`,
	 * `UpdateUserAttributes` and `AdminCreateUser` (FX49).
	 */
	private refuseAliasInUse(attribute: ContactAttribute, value: string, except?: string): void {
		if (this.store.aliasHolders(attribute, value, except).length === 0) return;
		throw serviceError(AuthErrors.AliasExists, `An account with the given ${attribute} already exists.`);
	}

	/** `signUp`'s `codeDeliveryDetails`: {@link signUpCodeAttribute}'s contact; else the local-only code's. */
	private signUpCodeDelivery(attributes: Record<string, string>): CodeDeliveryDetails {
		const delivered = this.signUpCodeAttribute(attributes);
		return delivered ? contactDelivery(delivered, attributes[delivered]) : codeDeliveryFor(attributes);
	}

	/**
	 * A new user's Cognito `Username`, `sub` and attributes, from the `login`
	 * the caller passed to `signUp` / `admin.createUser` — as Cognito derives
	 * them (`sign-in-mode.ts`; `DESIGN.md`, "Mock vs AWS"):
	 *
	 * - **Username-attribute pool** (`signInWith` without `'username'`): `login`
	 *   must be an email / phone the pool signs in with, not already in use; it
	 *   fills that attribute (unless the caller set it), and the stored username
	 *   is generated and equal to `sub`.
	 * - **Otherwise**: the username is `login`, which must not exist and, on an
	 *   alias pool, must not be in the format of an alias attribute.
	 *
	 * @throws `UsernameExistsException` (with `existsMessage`) or `InvalidParameterException`.
	 */
	private newUser(
		login: string,
		attributes: Record<string, string>,
		existsMessage: string,
	): { username: string; userSub: string; attributes: Record<string, string> } {
		const userSub = crypto.randomUUID();
		const { usernameAttributes, aliasAttributes } = this.signInMode;
		if (usernameAttributes.length > 0) {
			const attr = usernameAttributes.find((a) => isInFormatOf(a, login));
			if (!attr) {
				const expected = usernameAttributes.map((a) => (a === 'email' ? 'an email' : 'a phone number'));
				throw serviceError(AuthErrors.InvalidParameter, `Username should be ${expected.join(' or ')}.`);
			}
			attributes[attr] ??= login;
			// The email / phone is the user's username: it must be unique.
			const taken = [login, ...usernameAttributes.flatMap((a) => (attributes[a] ? [attributes[a]] : []))];
			if (taken.some((value) => this.store.resolve(value))) {
				throw serviceError(AuthErrors.UserAlreadyExists, existsMessage);
			}
			return { username: userSub, userSub, attributes };
		}
		for (const attr of aliasAttributes) {
			if (isInFormatOf(attr, login)) {
				const format = attr === 'email' ? 'email' : 'phone number';
				throw serviceError(
					AuthErrors.InvalidParameter,
					`Username cannot be of ${format} format, since user pool is configured for ${attr} alias.`,
				);
			}
		}
		if (this.store.user(login)) throw serviceError(AuthErrors.UserAlreadyExists, existsMessage);
		return { username: login, userSub, attributes };
	}
}

/** `AuthCognito`'s mock bridge token: Cognito's SignUp `Session`, stood in for. */
function bridgeFor(userSub: string): string {
	return `mock-signup-session-${userSub}`;
}

function attributeCodeKey(name: string, username: string): string {
	return `attribute:${name}:${username}`;
}

function contactDelivery(name: string, value: string): CodeDeliveryDetails {
	return name === 'email'
		? { destination: maskEmail(value), deliveryMedium: 'EMAIL', attributeName: 'email' }
		: { destination: maskPhone(value), deliveryMedium: 'SMS', attributeName: 'phone_number' };
}

/**
 * Where the local-only sign-up code goes when the pool auto-verifies none of
 * the user's contacts: the email if any, else the phone, masked as Cognito
 * masks it.
 */
function codeDeliveryFor(attributes: Record<string, string>): CodeDeliveryDetails {
	if (attributes.email) return contactDelivery('email', attributes.email);
	if (attributes.phone_number) return contactDelivery('phone_number', attributes.phone_number);
	return { destination: '(no contact)', deliveryMedium: 'EMAIL', attributeName: 'email' };
}
