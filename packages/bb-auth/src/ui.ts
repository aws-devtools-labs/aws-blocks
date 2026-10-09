// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `@aws-blocks/bb-auth/ui` — the sign-in UI for the `Auth` Building Block.
 *
 * Re-exports the shared, provider-agnostic renderer from
 * `@aws-blocks/auth-common/ui` (the same functions, so they share one
 * per-`api` auth-state store with any other import path), plus
 * {@link authOverrides}: a typed pass-through for `Authenticator` options keyed
 * against `Auth`'s action, next-step and field vocabulary.
 *
 * Browser-safe: imports no server code. The only runtime import is the shared
 * renderer; everything from `./types.js` is type-only.
 *
 * @example
 * ```typescript
 * import { Authenticator, authOverrides, submitAuthAction } from '@aws-blocks/bb-auth/ui';
 * import { authApi } from 'aws-blocks';
 *
 * document.body.appendChild(Authenticator(authApi, authOverrides({
 *   hideActions: ['signUp'],                       // typed: only Auth action names
 *   headings: { confirmingSignUp: 'Verify your email' },
 *   actions: {
 *     signIn: {
 *       fields: {
 *         username: { label: 'Email', autocomplete: 'email' },
 *         password: { hint: 'At least 8 characters' }, // typed: only fields signIn emits
 *       },
 *     },
 *     CONTINUE_SIGN_IN_WITH_TOTP_SETUP: {
 *       heading: 'Scan this with your authenticator app',
 *       fields: { sharedSecret: { hint: 'Or type it in manually' } },
 *     },
 *   },
 * })));
 *
 * // A custom form: one call submits and notifies every component and tab.
 * await submitAuthAction(authApi, { action: 'signOut' });
 * ```
 */

import type { AuthActionOverride, AuthenticatorOptions, AuthFieldOverride } from '@aws-blocks/auth-common/ui';
import type { SignInNextStep } from './types.js';

export type {
	AuthActionInput,
	AuthActionOverride,
	AuthActionPayloadMap,
	AuthenticatorOptions,
	AuthFieldOverride,
	AuthStateApi,
} from '@aws-blocks/auth-common/ui';
export {
	AccountMenuBar,
	AuthenticatedContent,
	Authenticator,
	broadcastAuthChange,
	getAuthStateSnapshot,
	onAuthChange,
	submitAuthAction,
	subscribeAuthState,
} from '@aws-blocks/auth-common/ui';

// ---------------------------------------------------------------------------
// Auth's UI vocabulary
// ---------------------------------------------------------------------------

/**
 * Federated sign-in action names: one `signIn:<id>` action per configured
 * social, OIDC or SAML provider, where `<id>` is the provider's key in
 * `socialProviders` / `oidcProviders` / `samlProviders`. These actions carry a
 * `url`, so the `Authenticator` renders them as a plain form submit (a
 * "Sign in with …" button) rather than calling `setAuthState`.
 */
export type AuthFederatedActionName = `signIn:${string}`;

/**
 * Action names `Auth`'s state machine emits to the `Authenticator` (the values
 * of `AuthAction.name`). Which ones appear depends on the configuration: with
 * `emailPassword: false` the email + password actions are absent.
 */
export type AuthActionName =
	| 'signIn'
	| 'signInWithPasskey'
	| 'signUp'
	| 'confirmSignUp'
	| 'resendSignUpCode'
	| 'autoSignIn'
	| 'confirmSignIn'
	| 'startPasskeyRegistration'
	| 'completePasskeyRegistration'
	| 'listPasskeys'
	| 'deletePasskey'
	| 'resetPassword'
	| 'confirmResetPassword'
	| 'signOut'
	| AuthFederatedActionName;

/**
 * Per-next-step keys the state machine routes through the single
 * `confirmSignIn` action — the `name` of every {@link SignInNextStep}. The
 * `Authenticator` accepts these as `actions[…]` keys too, so you can target
 * one challenge shape (say, TOTP setup) without touching the others.
 */
export type AuthNextStepName = SignInNextStep['name'];

/**
 * Field names per action and per next step, so `actions.signIn.fields.banana`
 * is a compile error. Next steps not listed here (`RESET_PASSWORD`,
 * `CONFIRM_SIGN_UP`) route to the `resetPassword` / `confirmSignUp` actions,
 * which you target by action name.
 *
 * Field names are public API: `data-testid` hooks (`authenticator-<field>`)
 * and the server's log redaction both key off them.
 */
export interface AuthActionFields {
	signIn: 'username' | 'password';
	signInWithPasskey: 'username';
	signUp: 'username' | 'password' | 'email' | 'phone_number' | 'autoSignIn' | string;
	confirmSignUp: 'username' | 'code';
	resendSignUpCode: 'username';
	autoSignIn: 'username';
	resetPassword: 'username';
	confirmResetPassword: 'username' | 'code' | 'newPassword';
	signOut: never;
	startPasskeyRegistration: never;
	completePasskeyRegistration: 'credentialCreationOptions' | 'credential';
	listPasskeys: never;
	deletePasskey: 'credentialId';
	CONFIRM_SIGN_IN_WITH_SMS_CODE: 'session' | 'code';
	CONFIRM_SIGN_IN_WITH_TOTP_CODE: 'session' | 'code';
	CONFIRM_SIGN_IN_WITH_EMAIL_CODE: 'session' | 'code';
	CONTINUE_SIGN_IN_WITH_MFA_SELECTION: 'session' | 'mfaType';
	CONTINUE_SIGN_IN_WITH_MFA_SETUP_SELECTION: 'session' | 'mfaType';
	CONTINUE_SIGN_IN_WITH_TOTP_SETUP: 'session' | 'sharedSecret' | 'code';
	CONTINUE_SIGN_IN_WITH_EMAIL_SETUP: 'session' | 'email';
	CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED: 'session' | 'newPassword';
	CONTINUE_SIGN_IN_WITH_FIRST_FACTOR_SELECTION: 'session' | 'firstFactor';
	CONFIRM_SIGN_IN_WITH_PASSWORD: 'session' | 'password';
	CONFIRM_SIGN_IN_WITH_FIRST_FACTOR_EMAIL_OTP: 'session' | 'code';
	CONFIRM_SIGN_IN_WITH_FIRST_FACTOR_SMS_OTP: 'session' | 'code';
	CONFIRM_SIGN_IN_WITH_WEB_AUTHN: 'session' | 'credentialRequestOptions' | 'credential';
}

/**
 * An `actions[K]` override with `fields` keyed against action `K`'s known
 * field names. Same shape as the generic `AuthActionOverride` otherwise.
 */
export type AuthTypedActionOverride<K extends keyof AuthActionFields> = Omit<AuthActionOverride, 'fields'> & {
	fields?: string extends AuthActionFields[K]
		? Record<string, AuthFieldOverride> // open-ended (sign-up's custom attributes)
		: Partial<Record<AuthActionFields[K], AuthFieldOverride>>;
};

/**
 * `Authenticator` options typed against `Auth`'s vocabulary. Same runtime
 * shape as the generic `AuthenticatorOptions`; only the keys are narrowed.
 * Federated `signIn:<id>` actions render as a provider button, so their
 * override takes the button-level settings (`heading`, `submitLabel`,
 * `render`) but no `fields`.
 */
export interface AuthTypedAuthenticatorOptions {
	hideActions?: AuthActionName[];
	headings?: Partial<
		Record<'signedOut' | 'signedIn' | 'confirmingSignIn' | 'confirmingSignUp' | 'confirmingPasswordReset', string>
	>;
	actions?: { [K in keyof AuthActionFields]?: AuthTypedActionOverride<K> } & {
		[name: AuthFederatedActionName]: Omit<AuthActionOverride, 'fields'>;
	};
}

/**
 * Type-checked pass-through for `Authenticator` options on an `Auth`-backed
 * app. Returns the same object; the only value-add is compile-time validation
 * of action, next-step, state and field names. Zero runtime cost.
 *
 * Typed at the input boundary, widened at the output: the renderer in
 * `@aws-blocks/auth-common/ui` stays provider-agnostic.
 *
 * @param options - The overrides, keyed by `Auth`'s vocabulary.
 * @returns The same object, as the renderer's `AuthenticatorOptions`.
 */
export function authOverrides(options: AuthTypedAuthenticatorOptions): AuthenticatorOptions {
	return options;
}
