// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Pure `AuthState` builders for the sign-in UI (the D-005 form model). Zero
 * side effects: given a situation, produce the state the `<Authenticator>`
 * renders next.
 *
 * Every action is a form. An action without `url` is submitted through
 * `setAuthState({ action, ...fields })`; an action **with** `url` is a plain
 * HTML form the browser submits to that URL — which is how federated sign-in
 * (`signIn:<providerId>`) and federated sign-out work without a third RPC
 * method.
 *
 * ⚠️ **Action and field names are public API.** The UI renders
 * `data-testid="authenticator-action-<action>"` and
 * `data-testid="authenticator-<field>"` (`auth-common/src/ui.ts`, public since
 * #272), and `packages/core/src/redact.ts` decides what to mask in logs by
 * field name (`password`, `session`, `code`, `sharedSecret`, `credential`, …).
 * Every name below is carried over unchanged from `AuthCognito`'s state
 * machine; renaming one breaks selectors and can silently un-redact a secret.
 * `state-machine.test.ts` pins them against `redact.ts`.
 *
 * Internal — not exported from any package entry.
 *
 * @internal
 */

import type { AuthAction, AuthField, AuthState, AuthUser } from '@aws-blocks/auth-common';
import type { PasskeyDescription, SignInNextStep } from './types.js';

/** A federated provider as the signed-out state shows it. */
export interface ProviderAction {
	/** The provider id (the options-record key). */
	id: string;
	/** Button label. */
	label: string;
	/** Where the browser goes to start the sign-in (a GET). */
	url: string;
}

/** A required custom attribute the sign-up form must collect. */
export interface SignUpAttributeField {
	/** Attribute name without the `custom:` prefix. */
	name: string;
	type?: 'String' | 'Number';
}

/** Inputs for {@link signedOut}. */
export interface SignedOutInput {
	/** Email + password enabled (`emailPassword !== false`). When `false`, no password action is offered. */
	passwordEnabled: boolean;
	/** Self-service sign-up enabled. */
	selfSignUp: boolean;
	/**
	 * `users.signInWith`. When `email` / `phone` is listed, Cognito requires the
	 * matching attribute at sign-up (the CDK layer sets `AutoVerifiedAttributes`),
	 * so the sign-up form collects it. Default `['username', 'email']`.
	 */
	signInWith?: readonly ('username' | 'email' | 'phone')[];
	/** Required custom attributes, collected on the sign-up form. */
	requiredAttributes?: readonly SignUpAttributeField[];
	/** Offer "Sign in with passkey". */
	passkeys?: boolean;
	/** Federated providers, one `signIn:<id>` URL action each, in declaration order. */
	providers?: readonly ProviderAction[];
	error?: string;
	/** Structured name of the failing error, surfaced as `errorName`. */
	errorName?: string;
}

function resolveSignInWith(value?: readonly ('username' | 'email' | 'phone')[]): {
	username: boolean;
	email: boolean;
	phone: boolean;
} {
	const list = value === undefined || value.length === 0 ? ['username', 'email'] : value;
	return {
		username: list.includes('username'),
		email: list.includes('email'),
		phone: list.includes('phone'),
	};
}

function humanizeAttributeName(name: string): string {
	// phone_number → Phone Number; custom:department → Department
	const bare = name.startsWith('custom:') ? name.slice(7) : name;
	return bare
		.split('_')
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(' ');
}

/**
 * The signed-out state.
 *
 * - With email + password: `signIn`, optionally `signInWithPasskey`, `signUp`
 *   when self-service sign-up is on, and `resetPassword` (always offered;
 *   whether the user exists is never revealed).
 * - Then one `signIn:<id>` action per federated provider, carrying `url` and
 *   `method: 'GET'`, with no fields.
 *
 * With `emailPassword: false` only the provider actions remain, so the UI
 * matches the compile-time gate by construction.
 */
export function signedOut(input: SignedOutInput): AuthState {
	const actions: AuthAction[] = [];

	if (input.passwordEnabled) {
		const signIn = resolveSignInWith(input.signInWith);
		// `email`/`phone` *as username* — the pool's `UsernameAttributes` is the
		// contact attribute, so the username field IS the email/phone.
		const usernameIsEmail = !signIn.username && signIn.email && !signIn.phone;
		const usernameIsPhone = !signIn.username && signIn.phone && !signIn.email;
		const usernameField = (): AuthField =>
			usernameIsEmail
				? { name: 'username', label: 'Email', type: 'email', required: true }
				: usernameIsPhone
					? { name: 'username', label: 'Phone', type: 'tel', required: true }
					: { name: 'username', label: 'Username', type: 'text', required: true };

		actions.push({
			name: 'signIn',
			label: 'Sign In',
			fields: [usernameField(), { name: 'password', label: 'Password', type: 'password', required: true }],
		});

		if (input.passkeys) {
			// The username scopes Cognito's USER_AUTH WebAuthn challenge to the
			// user's enrolled credentials.
			actions.push({
				name: 'signInWithPasskey',
				label: 'Sign in with passkey',
				fields: [{ name: 'username', label: 'Username', type: 'text', required: true }],
			});
		}

		if (input.selfSignUp) {
			const fields: AuthField[] = [
				usernameField(),
				{ name: 'password', label: 'Password', type: 'password', required: true },
			];
			const declared = new Set((input.requiredAttributes ?? []).map((a) => a.name));
			if (signIn.email && !usernameIsEmail && !declared.has('email')) {
				fields.push({ name: 'email', label: 'Email', type: 'email', required: true });
			}
			if (signIn.phone && !usernameIsPhone && !declared.has('phone_number')) {
				fields.push({ name: 'phone_number', label: 'Phone Number', type: 'tel', required: true });
			}
			for (const attr of input.requiredAttributes ?? []) {
				fields.push({
					name: attr.name,
					label: humanizeAttributeName(attr.name),
					type: attr.type === 'Number' ? 'number' : 'text',
					required: true,
				});
			}
			actions.push({ name: 'signUp', label: 'Create Account', fields });
		}

		actions.push({ name: 'resetPassword', label: 'Forgot Password', fields: [usernameField()] });
	}

	for (const p of input.providers ?? []) {
		actions.push({ name: `signIn:${p.id}`, label: p.label, fields: [], url: p.url, method: 'GET' });
	}

	return {
		state: 'signedOut',
		actions,
		...(input.error ? { error: input.error } : {}),
		...(input.errorName ? { errorName: input.errorName } : {}),
	};
}

/**
 * After `signUp`: a `confirmSignUp` form (username hidden, pre-filled) plus
 * `resendSignUpCode`. Also the uniform answer to a sign-up for an existing
 * account when `revealExistingUsers` is off.
 */
export function confirmingSignUp(username: string, error?: string): AuthState {
	return {
		state: 'confirmingSignUp',
		actions: [
			{
				name: 'confirmSignUp',
				label: 'Confirm Account',
				fields: [
					{ name: 'username', label: 'Username', type: 'hidden', required: true, defaultValue: username },
					{ name: 'code', label: 'Verification Code', type: 'text', required: true },
				],
			},
			{
				name: 'resendSignUpCode',
				label: 'Resend Code',
				fields: [
					{ name: 'username', label: 'Username', type: 'hidden', required: true, defaultValue: username },
				],
			},
		],
		...(error ? { error } : {}),
	};
}

/**
 * After `confirmSignUp` returned `COMPLETE_AUTO_SIGN_IN`: one `autoSignIn`
 * action, so the client can render whatever challenge the sign-in yields.
 */
export function autoSignInPending(username: string): AuthState {
	return {
		state: 'confirmingSignUp',
		actions: [
			{
				name: 'autoSignIn',
				label: 'Continue',
				fields: [
					{ name: 'username', label: 'Username', type: 'hidden', required: true, defaultValue: username },
				],
			},
		],
	};
}

type ChallengeKind =
	| 'code'
	| 'mfaType'
	| 'newPassword'
	| 'totpSetup'
	| 'email'
	| 'password'
	| 'firstFactor'
	| 'webauthn';

/**
 * A sign-in challenge. `nextStep.name` selects the label and fields; the
 * challenge `session` travels as a hidden field so the browser echoes it back,
 * and a hidden `challenge` discriminator pairs the action with its
 * `AuthActionPayloadMap.confirmSignIn` arm.
 */
export function confirmingSignIn(nextStep: SignInNextStep, error?: string): AuthState {
	const challenge = (value: ChallengeKind): AuthField => ({
		name: 'challenge',
		label: 'Challenge',
		type: 'hidden',
		required: true,
		defaultValue: value,
	});
	const confirm = (
		label: string,
		session: string,
		kind: ChallengeKind,
		rest: AuthField[],
		extra?: Partial<AuthAction>,
	): AuthAction => ({
		name: 'confirmSignIn',
		label,
		...extra,
		fields: [
			{ name: 'session', label: 'Session', type: 'hidden', required: true, defaultValue: session },
			challenge(kind),
			...rest,
		],
	});
	const code = (label = 'Code'): AuthField => ({ name: 'code', label, type: 'text', required: true });
	const sentTo = (destination: string) => (destination ? ` (sent to ${destination})` : '');

	let action: AuthAction;
	switch (nextStep.name) {
		case 'CONFIRM_SIGN_IN_WITH_SMS_CODE':
			action = confirm(
				`Enter SMS Code${sentTo(nextStep.codeDeliveryDetails.destination)}`,
				nextStep.session,
				'code',
				[code()],
			);
			break;
		case 'CONFIRM_SIGN_IN_WITH_TOTP_CODE':
			action = confirm('Enter Authenticator Code', nextStep.session, 'code', [code()]);
			break;
		case 'CONFIRM_SIGN_IN_WITH_EMAIL_CODE':
			action = confirm(
				`Enter Email Code${sentTo(nextStep.codeDeliveryDetails.destination)}`,
				nextStep.session,
				'code',
				[code()],
			);
			break;
		case 'CONTINUE_SIGN_IN_WITH_MFA_SELECTION':
			action = confirm('Choose MFA Method', nextStep.session, 'mfaType', [
				{
					name: 'mfaType',
					label: `Pick one of: ${nextStep.allowedMFATypes.join(', ')}`,
					type: 'text',
					required: true,
				},
			]);
			break;
		case 'CONTINUE_SIGN_IN_WITH_MFA_SETUP_SELECTION':
			action = confirm('Choose MFA Setup', nextStep.session, 'mfaType', [
				{
					name: 'mfaType',
					label: `Pick one of: ${nextStep.allowedMFATypes.join(', ')}`,
					type: 'text',
					required: true,
				},
			]);
			break;
		case 'CONTINUE_SIGN_IN_WITH_TOTP_SETUP':
			action = confirm('Set Up Authenticator', nextStep.session, 'totpSetup', [
				{
					name: 'sharedSecret',
					label: 'Shared Secret',
					type: 'hidden',
					required: true,
					defaultValue: nextStep.sharedSecret,
				},
				code('Code from Authenticator'),
			]);
			break;
		case 'CONTINUE_SIGN_IN_WITH_EMAIL_SETUP':
			// Two-step: the user submits the address first; the follow-up email
			// OTP arrives as CONFIRM_SIGN_IN_WITH_EMAIL_CODE.
			action = confirm('Set Up Email OTP', nextStep.session, 'email', [
				{ name: 'email', label: 'Email Address', type: 'email', required: true },
			]);
			break;
		case 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED':
			action = confirm('Set New Password', nextStep.session, 'newPassword', [
				{ name: 'newPassword', label: 'New Password', type: 'password', required: true },
			]);
			break;
		case 'CONTINUE_SIGN_IN_WITH_FIRST_FACTOR_SELECTION':
			action = confirm('Choose Sign-In Method', nextStep.session, 'firstFactor', [
				{
					name: 'firstFactor',
					label: `Pick one of: ${nextStep.availableChallenges.join(', ')}`,
					type: 'text',
					required: true,
				},
			]);
			break;
		case 'CONFIRM_SIGN_IN_WITH_PASSWORD':
			action = confirm('Enter Password', nextStep.session, 'password', [
				{ name: 'password', label: 'Password', type: 'password', required: true },
			]);
			break;
		case 'CONFIRM_SIGN_IN_WITH_FIRST_FACTOR_EMAIL_OTP':
			action = confirm(
				`Enter Email Code${sentTo(nextStep.codeDeliveryDetails.destination)}`,
				nextStep.session,
				'code',
				[code()],
			);
			break;
		case 'CONFIRM_SIGN_IN_WITH_FIRST_FACTOR_SMS_OTP':
			action = confirm(
				`Enter SMS Code${sentTo(nextStep.codeDeliveryDetails.destination)}`,
				nextStep.session,
				'code',
				[code()],
			);
			break;
		case 'CONFIRM_SIGN_IN_WITH_WEB_AUTHN':
			// The renderer recognises `capability: 'webauthn-get'`, runs
			// `navigator.credentials.get(...)` against `credentialRequestOptions`
			// and overwrites the hidden `credential` field before submitting.
			action = confirm(
				'Use Passkey',
				nextStep.session,
				'webauthn',
				[
					{
						name: 'credentialRequestOptions',
						label: 'Credential Request Options',
						type: 'hidden',
						required: true,
						defaultValue: nextStep.credentialRequestOptions,
					},
					{ name: 'credential', label: 'Credential', type: 'hidden', required: true },
				],
				{ capability: 'webauthn-get' },
			);
			break;
		case 'RESET_PASSWORD':
			action = {
				name: 'resetPassword',
				label: 'Reset Password',
				fields: [{ name: 'username', label: 'Username', type: 'text', required: true }],
			};
			break;
		case 'CONFIRM_SIGN_UP':
			action = {
				name: 'confirmSignUp',
				label: 'Confirm Account',
				fields: [
					{ name: 'username', label: 'Username', type: 'text', required: true },
					code('Verification Code'),
				],
			};
			break;
	}
	return { state: 'confirmingSignIn', actions: [action], ...(error ? { error } : {}) };
}

/** The fields of a signed-in user that {@link displayNameOf} reads. */
export interface DisplayNameSource {
	username: string;
	userSub: string;
	signInProvider: string;
	attributes: Readonly<Record<string, string | undefined>>;
	/**
	 * Whether the email / phone number is verified, from the session's ID
	 * token, whose `email_verified` / `phone_number_verified` are JSON booleans
	 * and so never in `attributes` (FX31). Wins over a string flag in
	 * `attributes`; `undefined` (or absent) when the token doesn't say.
	 */
	verified?: { email?: boolean; phone_number?: boolean };
}

/**
 * The name the sign-in UI shows the signed-in user (`AuthUser.displayName`).
 *
 * An email + password user whose username they chose keeps it. Otherwise the
 * username is not meant for people — Cognito generates it (equal to `userSub`)
 * on a pool where users sign in with their email or phone, and names a
 * hosted-UI federated user `<Provider>_<subject>` — so the display name is the
 * user's email, else their phone number (either skipped when the pool marks it
 * unverified), else `preferred_username`, else the username.
 *
 * "Marks it unverified" reads the same source on both runtimes: the session ID
 * token's `email_verified` / `phone_number_verified` (`verified`), which a
 * Cognito ID token — and an OIDC provider's, per OIDC Core §5.1 — carries as
 * JSON booleans, so they are never in `attributes` (FX26); else a string
 * `'false'` flag in `attributes` (from a direct provider that sends the flag as
 * a string). A flag that says nothing — no claim — doesn't skip the value. So
 * an email changed with `updateUserAttributes` and not yet confirmed is skipped
 * once the session's tokens are refreshed (FX31; before, a pool session's
 * display name could never see the flags and showed it).
 */
export function displayNameOf(user: DisplayNameSource): string {
	const chosenUsername = user.signInProvider === 'password' && user.username !== user.userSub;
	if (chosenUsername) return user.username;
	const { email, email_verified, phone_number, phone_number_verified, preferred_username } = user.attributes;
	const emailVerified = user.verified?.email ?? stringFlag(email_verified);
	const phoneVerified = user.verified?.phone_number ?? stringFlag(phone_number_verified);
	if (email && emailVerified !== false) return email;
	if (phone_number && phoneVerified !== false) return phone_number;
	if (preferred_username) return preferred_username;
	return user.username;
}

/** A `'true'` / `'false'` attribute as a boolean; anything else is unknown. */
function stringFlag(value: string | undefined): boolean | undefined {
	if (value === 'true') return true;
	if (value === 'false') return false;
	return undefined;
}

/** Inputs for {@link signedIn}. */
export interface SignedInInput {
	/** Offer passkey enrolment and management. */
	passkeys?: boolean;
	/**
	 * For a federated session: the sign-out route. The `signOut` action then
	 * carries `url` + `method: 'POST'`, so the browser follows the provider's
	 * logout redirect chain (design 04 §4.5) — otherwise the IdP's own session
	 * would silently sign the user back in.
	 */
	federatedSignOutUrl?: string;
}

/** The signed-in state: `signOut`, plus passkey actions when enabled. */
export function signedIn(user: AuthUser, input: SignedInInput = {}): AuthState {
	const actions: AuthAction[] = [
		input.federatedSignOutUrl
			? { name: 'signOut', label: 'Sign Out', fields: [], url: input.federatedSignOutUrl, method: 'POST' }
			: { name: 'signOut', label: 'Sign Out', fields: [] },
	];
	if (input.passkeys) {
		actions.push({ name: 'startPasskeyRegistration', label: 'Add a passkey to this device', fields: [] });
		actions.push({ name: 'listPasskeys', label: 'Manage passkeys', fields: [] });
	}
	return { state: 'signedIn', user, actions };
}

/**
 * Mid passkey registration: carries `credentialCreationOptions` for
 * `navigator.credentials.create(...)` (`capability: 'webauthn-create'`).
 */
export function registeringPasskey(user: AuthUser, credentialCreationOptions: string, error?: string): AuthState {
	return {
		state: 'signedIn',
		user,
		actions: [
			{
				name: 'completePasskeyRegistration',
				label: 'Register passkey',
				capability: 'webauthn-create',
				fields: [
					{
						name: 'credentialCreationOptions',
						label: 'Credential Creation Options',
						type: 'hidden',
						required: true,
						defaultValue: credentialCreationOptions,
					},
					{ name: 'credential', label: 'Credential', type: 'hidden', required: true },
				],
			},
		],
		...(error ? { error } : {}),
	};
}

/** The passkey list: one delete action per passkey, then add and sign out. */
export function managingPasskeys(user: AuthUser, passkeys: readonly PasskeyDescription[], error?: string): AuthState {
	const actions: AuthAction[] = passkeys.map((pk) => ({
		name: 'deletePasskey',
		label: pk.friendlyName ? `Delete: ${pk.friendlyName}` : `Delete passkey ${pk.credentialId.slice(0, 8)}…`,
		fields: [
			{
				name: 'credentialId',
				label: 'Credential ID',
				type: 'hidden',
				required: true,
				defaultValue: pk.credentialId,
			},
		],
	}));
	actions.push({ name: 'startPasskeyRegistration', label: 'Add a passkey to this device', fields: [] });
	actions.push({ name: 'signOut', label: 'Sign Out', fields: [] });
	return { state: 'signedIn', user, actions, ...(error ? { error } : {}) };
}

/** After `resetPassword`: the code + new-password form (username hidden). */
export function confirmingPasswordReset(username: string, error?: string): AuthState {
	return {
		state: 'confirmingPasswordReset',
		actions: [
			{
				name: 'confirmResetPassword',
				label: 'Reset Password',
				fields: [
					{ name: 'username', label: 'Username', type: 'hidden', required: true, defaultValue: username },
					{ name: 'code', label: 'Reset Code', type: 'text', required: true },
					{ name: 'newPassword', label: 'New Password', type: 'password', required: true },
				],
			},
		],
		...(error ? { error } : {}),
	};
}

/**
 * A retriable failure: the client keeps the current form (and its hidden
 * challenge `session`) and overlays `error`, instead of restarting the flow.
 */
export function retriableFailure(error: string, errorName?: string): AuthState {
	return { state: 'signedOut', actions: [], error, retriable: true, ...(errorName ? { errorName } : {}) };
}
