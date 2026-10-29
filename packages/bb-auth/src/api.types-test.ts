// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Compile-time proof that `createApi()` is typed by the block's options: the
 * `setAuthState` input follows the same gates as the server-side methods
 * (`AuthActionInputOf<O>`), the wide type keeps every action, and a narrowed
 * API stays assignable to the plain `AuthStateApi` the UI helpers take.
 *
 * The compile is the test — nothing here runs. Every `@ts-expect-error`
 * asserts that the next line is a type error (TS2578 fails the build if it
 * stops being one); `Expect<Equal<…>>` pins exact resolutions.
 *
 * @internal
 */

import type { AuthActionInput, AuthStateApi, AuthUser, AuthUserOf } from '@aws-blocks/auth-common';
import {
	AuthenticatedContent,
	Authenticator,
	getAuthStateSnapshot,
	onAuthChange,
	submitAuthAction,
	subscribeAuthState,
} from '@aws-blocks/auth-common/ui';
import type { ScopeParent } from '@aws-blocks/core';
import type {
	AnySignInNextStep,
	AuthActionInputOf,
	AuthenticatedUser,
	AuthFlowOf,
	AuthMockOptions,
	AuthOptions,
	AuthStateApiOf,
	AuthStateUser,
	ConfirmSignInInputOf,
	FederatedActionNameOf,
	MfaFactor,
	SignInNextStep,
	TotpEnabled,
} from './index.mock.js';
import { Auth } from './index.mock.js';

declare const scope: ScopeParent;
declare const session: string;

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;
type OptionsOf<A> = A extends Auth<infer O> ? O : never;
type ActionsOf<A extends { createApi(): AuthStateApi<AuthActionInput> }> =
	ReturnType<A['createApi']> extends AuthStateApi<infer I> ? I['action'] : never;
type ChallengesOf<O extends AuthOptions> = ConfirmSignInInputOf<O>['challenge'];

const okta = { issuer: 'https://dev-12345.okta.com', clientId: '0oa-okta' };
const passwordActions = [
	'signIn',
	'signUp',
	'confirmSignUp',
	'resendSignUpCode',
	'autoSignIn',
	'resetPassword',
	'confirmResetPassword',
	'confirmSignIn',
] as const;
type PasswordActionName = (typeof passwordActions)[number];
type PasskeyActionName =
	| 'signInWithPasskey'
	| 'startPasskeyRegistration'
	| 'completePasskeyRegistration'
	| 'listPasskeys'
	| 'deletePasskey';
type TotpActionName = 'setUpTotp' | 'verifyTotpSetup';
type MfaPreferenceActionName = 'getMfaPreference' | 'updateMfaPreference';

// ─────────────────────────────────────────────────────────────────────────────
// (1) emailPassword: false + one OIDC provider — the reviewer's repro. The
//     password actions are compile errors; signOut is the only action.
// ─────────────────────────────────────────────────────────────────────────────
async function oidcOnly() {
	const auth = new Auth(scope, 'oidc-only', { emailPassword: false, oidcProviders: { okta } });
	const authApi = auth.createApi();
	await authApi.setAuthState({ action: 'signOut' });
	// @ts-expect-error — email + password is off on this block
	await authApi.setAuthState({ action: 'signIn', username: 'u', password: 'p' });
	// @ts-expect-error — email + password is off on this block
	await authApi.setAuthState({ action: 'signUp', username: 'u', password: 'p' });
	// @ts-expect-error — email + password is off on this block
	await authApi.setAuthState({ action: 'resetPassword', username: 'u' });
	// @ts-expect-error — no sign-in challenge without email + password
	await authApi.setAuthState({ action: 'confirmSignIn', challenge: 'newPassword', session, newPassword: 'p' });
	// @ts-expect-error — passkeys need email + password
	await authApi.setAuthState({ action: 'listPasskeys' });
	type _actions = Expect<Equal<ActionsOf<typeof auth>, 'signOut'>>;

	// The federated action name is typed by the configured provider ids.
	const name: FederatedActionNameOf<OptionsOf<typeof auth>> = 'signIn:okta';
	// @ts-expect-error — no provider 'okat'
	const typo: FederatedActionNameOf<OptionsOf<typeof auth>> = 'signIn:okat';
	void name;
	void typo;
	type _none = Expect<Equal<FederatedActionNameOf<{ emailPassword: true }>, never>>;
	type _wide = Expect<Equal<FederatedActionNameOf<AuthOptions>, `signIn:${string}`>>;
}

// ─────────────────────────────────────────────────────────────────────────────
// (2) Email + password, passkeys off, MFA off — the default shape.
// ─────────────────────────────────────────────────────────────────────────────
async function passwordOnly() {
	const auth = new Auth(scope, 'pw-only', { emailPassword: true });
	const authApi = auth.createApi();
	await authApi.setAuthState({ action: 'signIn', username: 'u', password: 'p' });
	await authApi.setAuthState({ action: 'signUp', username: 'u', password: 'p', department: 'eng' });
	await authApi.setAuthState({ action: 'confirmSignIn', challenge: 'newPassword', session, newPassword: 'p' });
	// @ts-expect-error — passkeys are off on this block
	await authApi.setAuthState({ action: 'signInWithPasskey', username: 'u' });
	// @ts-expect-error — passkeys are off on this block
	await authApi.setAuthState({ action: 'startPasskeyRegistration' });
	// @ts-expect-error — passkeys are off: no WebAuthn challenge
	await authApi.setAuthState({ action: 'confirmSignIn', challenge: 'webauthn', session, credential: '{}' });
	// @ts-expect-error — MFA is off: no code challenge
	await authApi.setAuthState({ action: 'confirmSignIn', challenge: 'code', session, code: '123456' });
	// @ts-expect-error — MFA is off: no MFA selection
	await authApi.setAuthState({ action: 'confirmSignIn', challenge: 'mfaType', session, mfaType: 'TOTP' });
	// @ts-expect-error — USER_PASSWORD_AUTH has no first-factor selection
	await authApi.setAuthState({ action: 'confirmSignIn', challenge: 'firstFactor', session, firstFactor: 'PASSWORD' });
	// @ts-expect-error — MFA is off: no authenticator enrolment
	await authApi.setAuthState({ action: 'setUpTotp' });
	// @ts-expect-error — MFA is off: no authenticator enrolment
	await authApi.setAuthState({ action: 'verifyTotpSetup', code: '123456' });
	// @ts-expect-error — MFA is off: no MFA settings
	await authApi.setAuthState({ action: 'getMfaPreference' });
	// @ts-expect-error — MFA is off: no MFA settings
	await authApi.setAuthState({ action: 'updateMfaPreference', totp: 'ENABLED' });
	type _actions = Expect<Equal<ActionsOf<typeof auth>, PasswordActionName | 'signOut'>>;
	type _challenges = Expect<Equal<ChallengesOf<OptionsOf<typeof auth>>, 'newPassword'>>;
}

// ─────────────────────────────────────────────────────────────────────────────
// (3) MFA on: the confirmSignIn payload follows `mfa.types`.
// ─────────────────────────────────────────────────────────────────────────────
async function mfaTotpOnly() {
	const auth = new Auth(scope, 'mfa-totp', { mfa: { mode: 'optional', types: ['TOTP'] } });
	const authApi = auth.createApi();
	await authApi.setAuthState({ action: 'confirmSignIn', challenge: 'code', session, code: '123456' });
	await authApi.setAuthState({ action: 'confirmSignIn', challenge: 'mfaType', session, mfaType: 'TOTP' });
	await authApi.setAuthState({
		action: 'confirmSignIn',
		challenge: 'totpSetup',
		session,
		sharedSecret: 's',
		code: '123456',
	});
	// @ts-expect-error — 'SMS' is not in mfa.types
	await authApi.setAuthState({ action: 'confirmSignIn', challenge: 'mfaType', session, mfaType: 'SMS' });
	// @ts-expect-error — 'EMAIL' is not in mfa.types: no email setup
	await authApi.setAuthState({ action: 'confirmSignIn', challenge: 'email', session, email: 'a@example.com' });
	type _challenges = Expect<
		Equal<ChallengesOf<OptionsOf<typeof auth>>, 'newPassword' | 'code' | 'mfaType' | 'totpSetup'>
	>;
}

// ─────────────────────────────────────────────────────────────────────────────
// (3b) MFA enrolment actions: authenticator setup follows 'TOTP' in
//      `mfa.types`; the preference actions follow MFA, and their factors follow
//      `mfa.types`.
// ─────────────────────────────────────────────────────────────────────────────
async function mfaEnrolmentActions() {
	const auth = new Auth(scope, 'mfa-totp-actions', { mfa: { mode: 'optional', types: ['TOTP'] } });
	const authApi = auth.createApi();
	await authApi.setAuthState({ action: 'setUpTotp' });
	await authApi.setAuthState({ action: 'verifyTotpSetup', code: '123456' });
	await authApi.setAuthState({ action: 'getMfaPreference' });
	await authApi.setAuthState({ action: 'updateMfaPreference', totp: 'PREFERRED' });
	await submitAuthAction(authApi, { action: 'updateMfaPreference', totp: 'DISABLED' });
	// @ts-expect-error — verifyTotpSetup needs the code
	await authApi.setAuthState({ action: 'verifyTotpSetup' });
	// @ts-expect-error — not an MFA setting
	await authApi.setAuthState({ action: 'updateMfaPreference', totp: 'ON' });
	// @ts-expect-error — 'SMS' is not in mfa.types
	await authApi.setAuthState({ action: 'updateMfaPreference', sms: 'ENABLED' });
	type _actions = Expect<
		Equal<ActionsOf<typeof auth>, PasswordActionName | TotpActionName | MfaPreferenceActionName | 'signOut'>
	>;

	// Default `mfa.types` (SMS + TOTP) includes TOTP.
	const byDefault = new Auth(scope, 'mfa-default-types', { mfa: 'required' });
	await byDefault.createApi().setAuthState({ action: 'setUpTotp' });

	const smsOnly = new Auth(scope, 'mfa-sms-actions', { mfa: { mode: 'optional', types: ['SMS'] } });
	const smsApi = smsOnly.createApi();
	await smsApi.setAuthState({ action: 'updateMfaPreference', sms: 'PREFERRED' });
	// @ts-expect-error — 'TOTP' is not in mfa.types: no authenticator enrolment
	await smsApi.setAuthState({ action: 'setUpTotp' });
	// @ts-expect-error — 'TOTP' is not in mfa.types: no authenticator enrolment
	await smsApi.setAuthState({ action: 'verifyTotpSetup', code: '123456' });
	// @ts-expect-error — 'TOTP' is not in mfa.types
	await smsApi.setAuthState({ action: 'updateMfaPreference', totp: 'ENABLED' });
	type _smsActions = Expect<Equal<ActionsOf<typeof smsOnly>, PasswordActionName | MfaPreferenceActionName | 'signOut'>>;

	// MFA needs email + password.
	const oidc = new Auth(scope, 'mfa-oidc', { emailPassword: false, oidcProviders: { okta }, mfa: 'optional' });
	type _oidcActions = Expect<Equal<ActionsOf<typeof oidc>, 'signOut'>>;
	type _totp = Expect<Equal<TotpEnabled<{ mfa: { mode: 'optional'; types: ['TOTP'] } }>, true>>;
	type _noTotp = Expect<Equal<TotpEnabled<{ mfa: { mode: 'optional'; types: ['EMAIL'] } }>, false>>;
	type _off = Expect<Equal<TotpEnabled<{ mfa: 'off' }>, false>>;
	type _unknown = Expect<Equal<TotpEnabled<AuthOptions>, boolean>>;
}

function mfaEmailOnly() {
	type O = { mfa: { mode: 'required'; types: ['EMAIL'] } };
	type _challenges = Expect<Equal<ChallengesOf<O>, 'newPassword' | 'code' | 'mfaType' | 'email'>>;
	type _mfaType = Expect<Equal<Extract<ConfirmSignInInputOf<O>, { challenge: 'mfaType' }>['mfaType'], 'EMAIL'>>;
	// MFA mode off with types listed: still off.
	type _off = Expect<Equal<ChallengesOf<{ mfa: { mode: 'off'; types: ['TOTP'] } }>, 'newPassword'>>;
}

// ─────────────────────────────────────────────────────────────────────────────
// (4) Passkeys on (USER_AUTH): the passkey actions and the USER_AUTH challenges.
// ─────────────────────────────────────────────────────────────────────────────
async function passkeysOn() {
	const auth = new Auth(scope, 'passkeys', {
		users: { authFlow: 'USER_AUTH' },
		passkeys: { relyingPartyId: 'example.com', origins: ['https://example.com'] },
		featurePlan: 'essentials',
	});
	const authApi = auth.createApi();
	await authApi.setAuthState({ action: 'signInWithPasskey', username: 'u' });
	await authApi.setAuthState({ action: 'startPasskeyRegistration' });
	await authApi.setAuthState({ action: 'completePasskeyRegistration', credential: '{}' });
	await authApi.setAuthState({ action: 'listPasskeys' });
	await authApi.setAuthState({ action: 'deletePasskey', credentialId: 'c' });
	await authApi.setAuthState({ action: 'confirmSignIn', challenge: 'webauthn', session, credential: '{}' });
	await authApi.setAuthState({ action: 'confirmSignIn', challenge: 'firstFactor', session, firstFactor: 'PASSWORD' });
	await authApi.setAuthState({ action: 'confirmSignIn', challenge: 'password', session, password: 'p' });
	// First-factor email / SMS codes arrive as the `code` challenge under USER_AUTH, with MFA off.
	await authApi.setAuthState({ action: 'confirmSignIn', challenge: 'code', session, code: '123456' });
	// @ts-expect-error — MFA is off: no MFA selection
	await authApi.setAuthState({ action: 'confirmSignIn', challenge: 'mfaType', session, mfaType: 'TOTP' });
	type _actions = Expect<Equal<ActionsOf<typeof auth>, PasswordActionName | PasskeyActionName | 'signOut'>>;
	type _flow = Expect<Equal<AuthFlowOf<OptionsOf<typeof auth>>, 'USER_AUTH'>>;
}

// ─────────────────────────────────────────────────────────────────────────────
// (5) Unknown at compile time — a gate the compiler cannot resolve keeps its
//     actions (a runtime check backs them), and the wide type is the full union.
// ─────────────────────────────────────────────────────────────────────────────
async function unknownGates(wide: Auth, flag: boolean) {
	type _wide = Expect<Equal<AuthActionInputOf<AuthOptions>, AuthActionInput>>;
	// The wide API takes every action; its user is the wide client user, an `AuthUser`.
	type _wideApi = Expect<Equal<AuthStateApiOf<AuthOptions>, AuthStateApi<AuthActionInput, AuthStateUser>>>;
	type _zero = Expect<Equal<ReturnType<Auth['createApi']>, AuthStateApiOf<AuthOptions>>>;
	const plain: AuthStateApi = wide.createApi();
	void plain;

	const zeroApi = new Auth(scope, 'zero').createApi();
	await zeroApi.setAuthState({ action: 'signInWithPasskey', username: 'u' });
	await wide.createApi().setAuthState({ action: 'confirmSignIn', challenge: 'mfaType', session, mfaType: 'SMS' });

	const maybePassword = new Auth(scope, 'pw-flag', { emailPassword: flag }).createApi();
	await maybePassword.setAuthState({ action: 'signIn', username: 'u', password: 'p' });
}

// ─────────────────────────────────────────────────────────────────────────────
// (6) Source compatibility — the default generic, and a narrowed API passed to
//     helpers typed with the plain `AuthStateApi` (Authenticator, auth-common).
// ─────────────────────────────────────────────────────────────────────────────
function takesPlainApi(_api: AuthStateApi): void {
	/* no-op */
}
async function compatibility() {
	const oidcApi = new Auth(scope, 'c-oidc', { emailPassword: false, oidcProviders: { okta } }).createApi();
	const pwApi = new Auth(scope, 'c-pw', { emailPassword: { selfSignUp: false } }).createApi();
	takesPlainApi(oidcApi);
	takesPlainApi(pwApi);
	const plain: AuthStateApi = oidcApi;
	void plain;
	Authenticator(oidcApi);
	Authenticator(pwApi);

	// `submitAuthAction` checks the input against the API it is given.
	await submitAuthAction(oidcApi, { action: 'signOut' });
	// @ts-expect-error — email + password is off on this block
	await submitAuthAction(oidcApi, { action: 'signIn', username: 'u', password: 'p' });
	await submitAuthAction(pwApi, { action: 'signIn', username: 'u', password: 'p' });
	const anyApi: AuthStateApi = pwApi;
	await submitAuthAction(anyApi, { action: 'listPasskeys' });

	// A renderer that builds a wide input at runtime takes the plain `AuthStateApi`.
	const wideInput: AuthActionInput = JSON.parse('{"action":"signOut"}');
	await renderer(oidcApi, wideInput);
	// @ts-expect-error — the narrowed API does not take an arbitrary action
	await oidcApi.setAuthState(wideInput);
}
async function renderer(api: AuthStateApi, input: AuthActionInput) {
	return submitAuthAction(api, input);
}

// A generic helper over `Auth<O>` still reaches the plain API.
function genericHelper<const O extends AuthMockOptions>(auth: Auth<O>): AuthStateApi {
	return auth.createApi();
}

// ─────────────────────────────────────────────────────────────────────────────
// (7) The signed-in user is typed by the options too, in `AuthState.user` and
//     in every UI helper: groups, attributes and userSub, without the
//     server-only claims.
// ─────────────────────────────────────────────────────────────────────────────
async function typedUser() {
	const auth = new Auth(scope, 'typed-user', {
		users: { groups: ['admins', 'readers'], attributes: [{ name: 'department' }] },
	});
	const authApi = auth.createApi();
	const state = await authApi.getAuthState();
	type _groups = Expect<Equal<NonNullable<typeof state.user>['groups'], ('admins' | 'readers')[]>>;
	const sub: string | undefined = state.user?.userSub;
	const department: string | undefined = state.user?.attributes['custom:department'];
	void [sub, department];
	// @ts-expect-error — `claims` is server-only; it never reaches the client.
	void state.user?.claims;
	type _of = Expect<Equal<AuthUserOf<typeof authApi>, AuthStateUser<OptionsOf<typeof auth>>>>;
	type _plain = Expect<Equal<AuthUserOf<AuthStateApi>, AuthUser>>;
	// The client user is the server's `AuthenticatedUser` without the server-only fields.
	type _keys = Expect<
		Equal<keyof AuthStateUser, Exclude<keyof AuthenticatedUser, 'claims' | 'federatedIdentity'> | 'displayName'>
	>;
	type O = OptionsOf<typeof auth>;
	type _sameFields = Expect<
		Equal<
			Pick<AuthStateUser<O>, 'groups' | 'attributes' | 'signInProvider'>,
			Pick<AuthenticatedUser<O>, 'groups' | 'attributes' | 'signInProvider'>
		>
	>;

	onAuthChange(authApi, (user) => {
		type _cb = Expect<Equal<typeof user, AuthStateUser<OptionsOf<typeof auth>> | null>>;
		const roles: ('admins' | 'readers')[] | undefined = user?.groups;
		void roles;
	});
	subscribeAuthState(authApi, (s) => void s.user?.groups);
	const snapshot = getAuthStateSnapshot(authApi);
	void snapshot?.user?.groups;
	const next = await submitAuthAction(authApi, { action: 'signOut' });
	void next.user?.groups;
	AuthenticatedContent(authApi, (user) => {
		const el = document.createElement('div');
		el.textContent = user.groups.join(', ');
		return el;
	});

	// Assignable to the plain user and API, so existing helpers keep working.
	const plainUser: AuthUser | undefined = state.user;
	const plainApi: AuthStateApi = authApi;
	void [plainUser, plainApi];
	onAuthChange(plainApi, (user) => {
		// @ts-expect-error — the plain `AuthUser` has no groups.
		void user?.groups;
	});
}

// ─────────────────────────────────────────────────────────────────────────────
// (8) Settings the compiler cannot see stay wide — the action input and the
//     sign-in steps alike: a `boolean` emailPassword, a union authFlow, a
//     wrapped pool, and `mfa.types` widened to `MfaFactor[]`.
// ─────────────────────────────────────────────────────────────────────────────
function unseenSettingsStayWide(flag: boolean, flow: 'USER_PASSWORD_AUTH' | 'USER_AUTH', factors: MfaFactor[]) {
	const pwFlag = new Auth(scope, 'w-pw-flag', { emailPassword: flag });
	const flowUnion = new Auth(scope, 'w-flow', { users: { authFlow: flow } });
	const wrapped = new Auth(scope, 'w-wrapped', { userPool: Auth.fromExisting('us-east-1_X', 'client') });
	const widened = new Auth(scope, 'w-factors', { mfa: { mode: 'optional', types: factors } });

	type _pwActions = Expect<Equal<ActionsOf<typeof pwFlag>, PasswordActionName | 'signOut'>>;
	type _pwSteps = Expect<
		Equal<
			SignInNextStep<OptionsOf<typeof pwFlag>>['name'],
			'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED' | 'RESET_PASSWORD' | 'CONFIRM_SIGN_UP'
		>
	>;

	type _flowChallenges = Expect<
		Equal<ChallengesOf<OptionsOf<typeof flowUnion>>, 'newPassword' | 'code' | 'password' | 'firstFactor'>
	>;
	type _flowSteps = Expect<
		Equal<
			Extract<
				SignInNextStep<OptionsOf<typeof flowUnion>>['name'],
				`${string}FIRST_FACTOR${string}` | 'CONFIRM_SIGN_IN_WITH_PASSWORD'
			>,
			| 'CONTINUE_SIGN_IN_WITH_FIRST_FACTOR_SELECTION'
			| 'CONFIRM_SIGN_IN_WITH_PASSWORD'
			| 'CONFIRM_SIGN_IN_WITH_FIRST_FACTOR_EMAIL_OTP'
			| 'CONFIRM_SIGN_IN_WITH_FIRST_FACTOR_SMS_OTP'
		>
	>;

	// A wrapped pool keeps every step and every confirmSignIn challenge.
	type _wrappedSteps = Expect<Equal<SignInNextStep<OptionsOf<typeof wrapped>>, AnySignInNextStep>>;
	type _wrappedChallenges = Expect<
		Equal<
			ChallengesOf<OptionsOf<typeof wrapped>>,
			'newPassword' | 'code' | 'mfaType' | 'totpSetup' | 'email' | 'password' | 'firstFactor' | 'webauthn'
		>
	>;

	// `MfaFactor[]`: every factor's steps and challenges, every mfaType value.
	type _factorChallenges = Expect<
		Equal<ChallengesOf<OptionsOf<typeof widened>>, 'newPassword' | 'code' | 'mfaType' | 'totpSetup' | 'email'>
	>;
	type _factorMfaType = Expect<
		Equal<Extract<ConfirmSignInInputOf<OptionsOf<typeof widened>>, { challenge: 'mfaType' }>['mfaType'], MfaFactor>
	>;
	type _factorActions = Expect<
		Equal<ActionsOf<typeof widened>, PasswordActionName | TotpActionName | MfaPreferenceActionName | 'signOut'>
	>;
	type _factorSteps = Expect<
		Equal<
			Extract<
				SignInNextStep<OptionsOf<typeof widened>>['name'],
				`CONFIRM_SIGN_IN_WITH_${'SMS' | 'TOTP' | 'EMAIL'}_CODE`
			>,
			'CONFIRM_SIGN_IN_WITH_SMS_CODE' | 'CONFIRM_SIGN_IN_WITH_TOTP_CODE' | 'CONFIRM_SIGN_IN_WITH_EMAIL_CODE'
		>
	>;
}

void oidcOnly;
void passwordOnly;
void mfaTotpOnly;
void mfaEnrolmentActions;
void mfaEmailOnly;
void passkeysOn;
void unknownGates;
void compatibility;
void genericHelper;
void typedUser;
void unseenSettingsStayWide;
