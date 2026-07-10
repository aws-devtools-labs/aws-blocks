// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { AuthAction, AuthField, AuthState } from '@aws-blocks/auth-common';
import type { CognitoUser, PasskeyDescription, SignInNextStep, SignInWith, UserAttribute } from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Pure state builders. Zero side effects. Given a situation, produce the
// AuthState the <Authenticator> component should render next.
// ─────────────────────────────────────────────────────────────────────────────

/** Standard Cognito attributes that should NOT be prefixed with `custom:`. */
const STANDARD_ATTRIBUTES = new Set([
	'address',
	'birthdate',
	'email',
	'email_verified',
	'family_name',
	'gender',
	'given_name',
	'locale',
	'middle_name',
	'name',
	'nickname',
	'phone_number',
	'phone_number_verified',
	'picture',
	'preferred_username',
	'profile',
	'updated_at',
	'website',
	'zoneinfo',
]);

/**
 * Whether a given attribute name is a built-in Cognito attribute. Callers use
 * this to decide whether to prefix with `custom:` before sending to Cognito.
 *
 * @internal
 */
export function isStandardAttribute(name: string): boolean {
	return STANDARD_ATTRIBUTES.has(name);
}

// ─────────────────────────────────────────────────────────────────────────────
// signedOut
// ─────────────────────────────────────────────────────────────────────────────

export interface SignedOutInput {
	selfSignUp: boolean;
	userAttributes: readonly UserAttribute[];
	/**
	 * Whether the pool is configured for passkey sign-in. When `true`, the
	 * signed-out state surfaces a "Sign in with passkey" action that the
	 * client routes through `signIn(username, undefined, { preferredChallenge: 'WEB_AUTHN' })`.
	 */
	enablePasskeys?: boolean;
	/**
	 * Same as `AuthCognitoOptions.signInWith`. When `email`/`phone` is in
	 * the list, the CDK construct sets `AutoVerifiedAttributes` on the
	 * pool — Cognito then *requires* the corresponding attribute at
	 * SignUp. We mirror that here so the Authenticator UI collects what
	 * the pool will demand. Default `['username', 'email']` matches the
	 * historical AuthCognito default.
	 */
	signInWith?: SignInWith | readonly SignInWith[];
	error?: string;
	/** Structured name of the failing error (e.g. `ApiError.name`), surfaced on the signed-out state. */
	errorName?: string;
}

/**
 * Normalize {@link SignedOutInput.signInWith} to a flag triple. Mirrors
 * `mapSignInWith` in `index.cdk.ts` — the descriptor and the CDK construct
 * must agree about which sign-in identifiers are active so the SignUp form
 * collects every attribute Cognito's `AutoVerifiedAttributes` will require.
 *
 * Empty arrays fall back to the default; `index.cdk.ts` rejects them at
 * synth time, but the descriptor stays permissive for unit-test ergonomics.
 *
 * @internal
 */
function resolveSignInWith(value?: SignInWith | readonly SignInWith[]): {
	username: boolean;
	email: boolean;
	phone: boolean;
} {
	const list: readonly SignInWith[] = value === undefined
		? ['username', 'email']
		: typeof value === 'string'
			? [value]
			: value.length === 0
				? ['username', 'email']
				: value;
	return {
		username: list.includes('username'),
		email: list.includes('email'),
		phone: list.includes('phone'),
	};
}

/**
 * Emit the signed-out state. Always includes a `signIn` action.
 * Adds a `signUp` action when `selfSignUp` is enabled. Adds a
 * `signInWithPasskey` action when `enablePasskeys` is `true` so customers
 * who registered a passkey on a prior device can skip the password.
 *
 * `resetPassword` is always offered; Cognito handles whether the user exists.
 */
export function signedOut(input: SignedOutInput): AuthState {
	const actions: AuthAction[] = [];

	const signIn = resolveSignInWith(input.signInWith);
	// `email`/`phone` *as username* — the pool's `UsernameAttributes` is
	// the contact attr, so the username field IS the email/phone. The
	// Authenticator should advertise that with the right `type`/`label`.
	const usernameIsEmail = !signIn.username && signIn.email && !signIn.phone;
	const usernameIsPhone = !signIn.username && signIn.phone && !signIn.email;
	const usernameField = (): AuthField =>
		usernameIsEmail
			? { name: 'username', label: 'Email', type: 'email', required: true }
			: usernameIsPhone
				? { name: 'username', label: 'Phone', type: 'tel', required: true }
				: { name: 'username', label: 'Username', type: 'text', required: true };

	// Primary sign-in form
	actions.push({
		name: 'signIn',
		label: 'Sign In',
		fields: [
			usernameField(),
			{ name: 'password', label: 'Password', type: 'password', required: true },
		],
	});

	if (input.enablePasskeys) {
		// Passkey sign-in. Renders as a single "Use a passkey" button that
		// kicks `signIn` with `preferredChallenge: 'WEB_AUTHN'`. The username
		// is required up-front because Cognito's USER_AUTH initiate-auth
		// needs USERNAME to scope the WebAuthn challenge to a specific
		// user's enrolled credentials.
		actions.push({
			name: 'signInWithPasskey',
			label: 'Sign in with passkey',
			fields: [
				{ name: 'username', label: 'Username', type: 'text', required: true },
			],
		});
	}

	// Sign-up form (optional)
	if (input.selfSignUp) {
		const signUpFields: AuthField[] = [
			usernameField(),
			{ name: 'password', label: 'Password', type: 'password', required: true },
		];
		// Cognito requires every attribute named in the pool's
		// `AutoVerifiedAttributes` at SignUp time. The CDK side mirrors
		// `signInAliases` into `autoVerify`, so any contact identifier
		// listed in `signInWith` becomes a required SignUp attribute. Add
		// the corresponding fields up front — but skip them when the
		// username IS that attr (no double-collect) or when the customer
		// already declared the attr explicitly via `userAttributes`.
		const declaredAttrs = new Set((input.userAttributes ?? []).map((a) => a.name));
		if (signIn.email && !usernameIsEmail && !declaredAttrs.has('email')) {
			signUpFields.push({ name: 'email', label: 'Email', type: 'email', required: true });
		}
		if (signIn.phone && !usernameIsPhone && !declaredAttrs.has('phone_number')) {
			signUpFields.push({ name: 'phone_number', label: 'Phone Number', type: 'tel', required: true });
		}
		for (const attr of input.userAttributes ?? []) {
			if (!attr.required) continue;
			signUpFields.push({
				name: attr.name,
				label: humanizeAttributeName(attr.name),
				type: attr.name === 'email' ? 'email' : attr.type === 'Number' ? 'number' : 'text',
				required: true,
			});
		}
		actions.push({ name: 'signUp', label: 'Create Account', fields: signUpFields });
	}

	// Password reset
	actions.push({
		name: 'resetPassword',
		label: 'Forgot Password',
		fields: [usernameField()],
	});

	return {
		state: 'signedOut',
		actions,
		...(input.error ? { error: input.error } : {}),
		...(input.errorName ? { errorName: input.errorName } : {}),
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// confirmingSignUp
// ─────────────────────────────────────────────────────────────────────────────

/**
 * After `signUp` when Cognito requires code confirmation. Offers a single
 * `confirmSignUp` form with `username` as a hidden pre-filled field, plus a
 * `resendSignUpCode` action.
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

// ─────────────────────────────────────────────────────────────────────────────
// confirmingSignIn
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Emit the confirming-sign-in state for any MFA / challenge continuation.
 * The `nextStep.name` drives label + field set:
 *
 *   - SMS / TOTP / Email → one code field
 *   - MFA selection → one field listing allowed types
 *   - MFA-setup selection → one field listing setup choices
 *   - TOTP setup → code field; shared secret carried as hidden so the UI can
 *     display a QR URL if it wants
 *   - Email setup → code field
 *   - NEW_PASSWORD_REQUIRED → newPassword field
 *
 * The Cognito `session` travels as a hidden field with `defaultValue` so the
 * browser echoes it back on submit (per D-005).
 */
export function confirmingSignIn(nextStep: SignInNextStep, error?: string): AuthState {
	const sessionField: AuthField | null =
		'session' in nextStep
			? { name: 'session', label: 'Session', type: 'hidden', required: true, defaultValue: nextStep.session }
			: null;

	let action: AuthAction;
	// `challenge` is a hidden discriminator emitted on every confirmSignIn
	// arm. It pairs the action with its `AuthActionPayloadMap.confirmSignIn`
	// variant so direct callers (and native client codegen) can pick the
	// right shape without inspecting which fields are present.
	const challengeField = (value: 'code' | 'mfaType' | 'newPassword' | 'totpSetup' | 'email' | 'password' | 'firstFactor' | 'webauthn'): AuthField => ({
		name: 'challenge',
		label: 'Challenge',
		type: 'hidden',
		required: true,
		defaultValue: value,
	});
	switch (nextStep.name) {
		case 'CONFIRM_SIGN_IN_WITH_SMS_CODE':
			action = {
				name: 'confirmSignIn',
				label: `Enter SMS Code${nextStep.codeDeliveryDetails.destination ? ` (sent to ${nextStep.codeDeliveryDetails.destination})` : ''}`,
				fields: [
					sessionField!,
					challengeField('code'),
					{ name: 'code', label: 'Code', type: 'text', required: true },
				],
			};
			break;
		case 'CONFIRM_SIGN_IN_WITH_TOTP_CODE':
			action = {
				name: 'confirmSignIn',
				label: 'Enter Authenticator Code',
				fields: [
					sessionField!,
					challengeField('code'),
					{ name: 'code', label: 'Code', type: 'text', required: true },
				],
			};
			break;
		case 'CONFIRM_SIGN_IN_WITH_EMAIL_CODE':
			action = {
				name: 'confirmSignIn',
				label: `Enter Email Code${nextStep.codeDeliveryDetails.destination ? ` (sent to ${nextStep.codeDeliveryDetails.destination})` : ''}`,
				fields: [
					sessionField!,
					challengeField('code'),
					{ name: 'code', label: 'Code', type: 'text', required: true },
				],
			};
			break;
		case 'CONTINUE_SIGN_IN_WITH_MFA_SELECTION':
			action = {
				name: 'confirmSignIn',
				label: 'Choose MFA Method',
				fields: [
					sessionField!,
					challengeField('mfaType'),
					{
						name: 'mfaType',
						label: `Pick one of: ${nextStep.allowedMFATypes.join(', ')}`,
						type: 'text',
						required: true,
					},
				],
			};
			break;
		case 'CONTINUE_SIGN_IN_WITH_MFA_SETUP_SELECTION':
			action = {
				name: 'confirmSignIn',
				label: 'Choose MFA Setup',
				fields: [
					sessionField!,
					challengeField('mfaType'),
					{
						name: 'mfaType',
						label: `Pick one of: ${nextStep.allowedMFATypes.join(', ')}`,
						type: 'text',
						required: true,
					},
				],
			};
			break;
		case 'CONTINUE_SIGN_IN_WITH_TOTP_SETUP':
			action = {
				name: 'confirmSignIn',
				label: 'Set Up Authenticator',
				fields: [
					sessionField!,
					challengeField('totpSetup'),
					{ name: 'sharedSecret', label: 'Shared Secret', type: 'hidden', required: true, defaultValue: nextStep.sharedSecret },
					{ name: 'code', label: 'Code from Authenticator', type: 'text', required: true },
				],
			};
			break;
		case 'CONTINUE_SIGN_IN_WITH_EMAIL_SETUP':
			// Real Cognito's EMAIL setup flow is two-step: the user submits
			// the address they want to enroll first; Cognito then emits an
			// `EMAIL_OTP` challenge that the state machine handles via the
			// existing `CONFIRM_SIGN_IN_WITH_EMAIL_CODE` branch. So here we
			// only ask for the address.
			action = {
				name: 'confirmSignIn',
				label: 'Set Up Email OTP',
				fields: [
					sessionField!,
					challengeField('email'),
					{ name: 'email', label: 'Email Address', type: 'email', required: true },
				],
			};
			break;
		case 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED':
			action = {
				name: 'confirmSignIn',
				label: 'Set New Password',
				fields: [
					sessionField!,
					challengeField('newPassword'),
					{ name: 'newPassword', label: 'New Password', type: 'password', required: true },
				],
			};
			break;
		case 'CONTINUE_SIGN_IN_WITH_FIRST_FACTOR_SELECTION':
			// USER_AUTH first-factor picker. `availableChallenges` is the list
			// Cognito said the user can choose from — may include
			// PASSWORD / EMAIL_OTP / SMS_OTP / WEB_AUTHN. PASSWORD_SRP /
			// CUSTOM_CHALLENGE still reject upstream and never reach here.
			action = {
				name: 'confirmSignIn',
				label: 'Choose Sign-In Method',
				fields: [
					sessionField!,
					challengeField('firstFactor'),
					{
						name: 'firstFactor',
						label: `Pick one of: ${nextStep.availableChallenges.join(', ')}`,
						type: 'text',
						required: true,
					},
				],
			};
			break;
		case 'CONFIRM_SIGN_IN_WITH_PASSWORD':
			// USER_AUTH picked the `PASSWORD` first factor. User supplies their
			// password now (the initial signIn call did not have one).
			action = {
				name: 'confirmSignIn',
				label: 'Enter Password',
				fields: [
					sessionField!,
					challengeField('password'),
					{ name: 'password', label: 'Password', type: 'password', required: true },
				],
			};
			break;
		case 'CONFIRM_SIGN_IN_WITH_FIRST_FACTOR_EMAIL_OTP':
			action = {
				name: 'confirmSignIn',
				label: `Enter Email Code${nextStep.codeDeliveryDetails.destination ? ` (sent to ${nextStep.codeDeliveryDetails.destination})` : ''}`,
				fields: [
					sessionField!,
					challengeField('code'),
					{ name: 'code', label: 'Code', type: 'text', required: true },
				],
			};
			break;
		case 'CONFIRM_SIGN_IN_WITH_FIRST_FACTOR_SMS_OTP':
			action = {
				name: 'confirmSignIn',
				label: `Enter SMS Code${nextStep.codeDeliveryDetails.destination ? ` (sent to ${nextStep.codeDeliveryDetails.destination})` : ''}`,
				fields: [
					sessionField!,
					challengeField('code'),
					{ name: 'code', label: 'Code', type: 'text', required: true },
				],
			};
			break;
		case 'CONFIRM_SIGN_IN_WITH_WEB_AUTHN':
			// Passkey assertion. The browser must call
			// `navigator.credentials.get(...)` with the JSON blob in
			// `credentialRequestOptions` and overwrite the hidden
			// `credential` field's value with the result before submitting.
			// The renderer recognises `capability: 'webauthn-get'` and
			// performs that round-trip; renderers without WebAuthn support
			// see only a labelled button + hidden inputs.
			action = {
				name: 'confirmSignIn',
				label: 'Use Passkey',
				capability: 'webauthn-get',
				fields: [
					sessionField!,
					challengeField('webauthn'),
					{
						name: 'credentialRequestOptions',
						label: 'Credential Request Options',
						type: 'hidden',
						required: true,
						defaultValue: nextStep.credentialRequestOptions,
					},
					{ name: 'credential', label: 'Credential', type: 'hidden', required: true },
				],
			};
			break;
		case 'RESET_PASSWORD':
			// No session token; caller must restart via resetPassword flow.
			action = {
				name: 'resetPassword',
				label: 'Reset Password',
				fields: [{ name: 'username', label: 'Username', type: 'text', required: true }],
			};
			break;
		case 'CONFIRM_SIGN_UP':
			// User needs to finish sign-up confirmation. No session token.
			action = {
				name: 'confirmSignUp',
				label: 'Confirm Account',
				fields: [
					{ name: 'username', label: 'Username', type: 'text', required: true },
					{ name: 'code', label: 'Verification Code', type: 'text', required: true },
				],
			};
			break;
	}

	return { state: 'confirmingSignIn', actions: [action], ...(error ? { error } : {}) };
}

// ─────────────────────────────────────────────────────────────────────────────
// signedIn
// ─────────────────────────────────────────────────────────────────────────────

export interface SignedInInput {
	/**
	 * Surface a `startPasskeyRegistration` action ("Add this device") on
	 * the signed-in card. The state-machine `setAuthState` handler kicks
	 * the WebAuthn enrolment ceremony (browser runs
	 * `navigator.credentials.create` against the returned
	 * `credentialCreationOptions` and dispatches `completePasskeyRegistration`).
	 */
	enablePasskeys?: boolean;
}

export function signedIn(user: CognitoUser, input: SignedInInput = {}): AuthState {
	const actions: AuthAction[] = [
		{ name: 'signOut', label: 'Sign Out', fields: [] },
	];
	if (input.enablePasskeys) {
		actions.push({
			name: 'startPasskeyRegistration',
			label: 'Add a passkey to this device',
			fields: [],
		});
		actions.push({
			name: 'listPasskeys',
			label: 'Manage passkeys',
			fields: [],
		});
	}
	return { state: 'signedIn', user, actions };
}

/**
 * Mid-registration state. Returned after `startPasskeyRegistration` —
 * carries the `credentialCreationOptions` blob the browser feeds into
 * `navigator.credentials.create(...)`. The renderer recognises
 * `capability: 'webauthn-create'`, runs the ceremony, and dispatches
 * `completePasskeyRegistration` with the resulting credential.
 */
export function registeringPasskey(
	user: CognitoUser,
	credentialCreationOptions: string,
	error?: string,
): AuthState {
	return {
		state: 'signedIn',
		user,
		actions: [{
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
		}],
		...(error ? { error } : {}),
	};
}

/**
 * Listing state. After `listPasskeys` returns, render one delete button
 * per registered passkey plus a back-to-signed-in shortcut. The
 * `defaultValue` of the `credentialId` hidden field is the unique
 * identifier the renderer pre-fills before dispatching `deletePasskey`.
 */
export function managingPasskeys(
	user: CognitoUser,
	passkeys: PasskeyDescription[],
	error?: string,
): AuthState {
	const actions: AuthAction[] = [];
	for (const pk of passkeys) {
		actions.push({
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
		});
	}
	actions.push({
		name: 'startPasskeyRegistration',
		label: 'Add a passkey to this device',
		fields: [],
	});
	actions.push({ name: 'signOut', label: 'Sign Out', fields: [] });
	return { state: 'signedIn', user, actions, ...(error ? { error } : {}) };
}

// ─────────────────────────────────────────────────────────────────────────────
// confirmingPasswordReset
// ─────────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function humanizeAttributeName(name: string): string {
	// email → Email; phone_number → Phone Number; custom:department → Department
	const bare = name.startsWith('custom:') ? name.slice(7) : name;
	return bare
		.split('_')
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(' ');
}
