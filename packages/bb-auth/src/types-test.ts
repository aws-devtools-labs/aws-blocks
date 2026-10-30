// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Compile-time proof of the `Auth` mode gates (task D1).
 *
 * The compile is the test — nothing here runs. `tsc --build` checks this file
 * with the rest of the package: every `@ts-expect-error` asserts that the next
 * line is a type error, so if a gate stops rejecting a call the directive is
 * unused and the build fails with TS2578. The `Expect<Equal<…>>` lines assert
 * exact resolutions and fail the build with TS2344 if a gate resolves to the
 * wrong tuple.
 *
 * What the compiler *says* when a gate rejects a call (the rest parameter's
 * name, which carries the error message) is asserted separately, by
 * `gate-diagnostics.test.ts`, because `@ts-expect-error` cannot check message
 * text.
 *
 * Runs against the real `Auth` class from the default (types) entry, as
 * `admin.types-test.ts` does for `AuthCognito`.
 *
 * @internal
 */

import type { BlocksAuth } from '@aws-blocks/auth-common';
import type { BlocksContext, ScopeParent } from '@aws-blocks/core';
import type {
	AdminActionGate,
	AdminDisabled,
	AdminGetterOf,
	AdminSurface,
	AnySignInNextStep,
	AppSettingRef,
	AuthenticatedUser,
	AuthFlowOf,
	AuthMockOptions,
	AuthOptions,
	DeviceRecord,
	EmailPasswordEnabled,
	ERROR_EMAIL_is_not_in_mfa_types,
	ERROR_SMS_is_not_in_mfa_types,
	ERROR_TOTP_is_not_in_mfa_types,
	FederationGate,
	GroupOf,
	HasFederatedProvider,
	MfaEnabled,
	MfaGate,
	MfaPreference,
	MfaPreferenceInput,
	MfaTypeOf,
	PasskeyGate,
	PasskeysEnabled,
	PasswordGate,
	ProviderIdOf,
	SignInNextStep,
	SignInOptions,
	SignInResult,
	SignInUrlOptions,
} from './index.mock.js';
import { Auth } from './index.mock.js';
import type { AUTH_OPTIONS_SHAPE } from './option-validation.js';

declare const scope: ScopeParent;
declare const context: BlocksContext;
declare const oktaSecret: AppSettingRef;
declare const googleSecret: AppSettingRef;
/** A provider argument that only the gate can reject (see case 4). */
declare const noProvider: never;
/** Values known only at runtime (a flag read from config, say): the gates must widen, not pick a side. */
declare const runtimeFlag: boolean;
declare const runtimeMfaMode: 'off' | 'optional';

/** Exact type equality (distinguishes `any`, `never`, optionality and unions). */
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;
/** The options literal an `Auth` instance captured. */
type OptionsOf<A> = A extends Auth<infer O> ? O : never;

/** The gate's resolution when the mode is disabled. */
type PasswordOff = [ERROR_emailPassword_is_disabled_on_this_Auth_instance: never];
type FederationOff = [ERROR_no_federated_provider_is_configured: never];

const okta = { issuer: 'https://dev-12345.okta.com', clientId: '0oa-okta' };

// ─────────────────────────────────────────────────────────────────────────────
// (1) PasswordGate on — the password methods are callable normally.
// ─────────────────────────────────────────────────────────────────────────────
async function passwordGateOn() {
	const auth = new Auth(scope, 'pw-on', { oidcProviders: { okta } });
	await auth.signIn('alice', 'pw', context);
	await auth.signIn('alice', 'pw', context, { preferredChallenge: 'PASSWORD' });
	await auth.signUp('alice', 'pw');
	await auth.signUp('alice', 'pw', { attributes: { email: 'a@example.com' } }, context);
	await auth.confirmSignUp('alice', '123456');
	await auth.confirmSignUp('alice', '123456', context);
	await auth.resendSignUpCode('alice');
	await auth.resetPassword('alice');
	await auth.confirmResetPassword('alice', '123456', 'new-pw');
	await auth.updatePassword(context, 'old-pw', 'new-pw');

	// The gate still type-checks the ordinary trailing parameters it absorbs.
	// @ts-expect-error — 'NOPE' is not a PreferredChallenge.
	await auth.signIn('alice', 'pw', context, { preferredChallenge: 'NOPE' });
	// @ts-expect-error — no fifth parameter when email + password is on.
	await auth.signIn('alice', 'pw', context, {}, 'extra');
}

// ─────────────────────────────────────────────────────────────────────────────
// (2) PasswordGate off (`emailPassword: false`) — every password method is a
//     compile error, with or without its optional trailing arguments. The
//     diagnostic text is asserted in gate-diagnostics.test.ts.
// ─────────────────────────────────────────────────────────────────────────────
async function passwordGateOff() {
	const auth = new Auth(scope, 'pw-off', { emailPassword: false, oidcProviders: { okta } });
	type _gate = Expect<Equal<PasswordGate<OptionsOf<typeof auth>>, PasswordOff>>;
	type _signInParams = Expect<Equal<Parameters<typeof auth.signIn>, [string, string, BlocksContext, never]>>;

	// @ts-expect-error — email + password is disabled on this instance.
	await auth.signIn('alice', 'pw', context);
	// @ts-expect-error — passing the options does not get around the gate.
	await auth.signIn('alice', 'pw', context, {});
	// @ts-expect-error — email + password is disabled on this instance.
	await auth.signUp('alice', 'pw');
	// @ts-expect-error — email + password is disabled on this instance.
	await auth.confirmSignUp('alice', '123456');
	// @ts-expect-error — email + password is disabled on this instance.
	await auth.resendSignUpCode('alice');
	// @ts-expect-error — email + password is disabled on this instance.
	await auth.resetPassword('alice');
	// @ts-expect-error — email + password is disabled on this instance.
	await auth.confirmResetPassword('alice', '123456', 'new-pw');
	// @ts-expect-error — email + password is disabled on this instance.
	await auth.updatePassword(context, 'old-pw', 'new-pw');

	// Mode-agnostic methods are unaffected.
	await auth.requireAuth(context);
	await auth.getCurrentUser(context);
	await auth.signOut(context);
}

// ─────────────────────────────────────────────────────────────────────────────
// (3) FederationGate on — getSignInUrl is callable normally.
// ─────────────────────────────────────────────────────────────────────────────
async function federationGateOn() {
	const auth = new Auth(scope, 'fed-on', { oidcProviders: { okta } });
	const url: string = await auth.getSignInUrl(context, 'okta');
	await auth.getSignInUrl(context, 'okta', { redirectPath: '/home' });
	void url;
	type _gate = Expect<Equal<FederationGate<OptionsOf<typeof auth>, [x?: 1]>, [x?: 1]>>;
}

// ─────────────────────────────────────────────────────────────────────────────
// (4) FederationGate off (no providers) — getSignInUrl is a compile error.
//     Zero-config, an empty options object, and options that configure
//     something else all count as "no providers".
// ─────────────────────────────────────────────────────────────────────────────
async function federationGateOff() {
	// With no provider configured, `ProviderIdOf<O>` is `never`, so any provider
	// *literal* is rejected by the `provider` parameter alone. Pass a value of
	// type `never` instead, so the only thing that can fail is the gate itself.
	const zeroConfig = new Auth(scope, 'fed-off-0');
	// @ts-expect-error — no federated provider is configured.
	await zeroConfig.getSignInUrl(context, noProvider);

	const empty = new Auth(scope, 'fed-off-1', {});
	// @ts-expect-error — no federated provider is configured.
	await empty.getSignInUrl(context, noProvider);

	const groupsOnly = new Auth(scope, 'fed-off-2', { users: { groups: ['admins'] } });
	// @ts-expect-error — no federated provider is configured.
	await groupsOnly.getSignInUrl(context, noProvider, { redirectPath: '/' });

	type _noProviders = Expect<Equal<ProviderIdOf<OptionsOf<typeof groupsOnly>>, never>>;
	type _closed = Expect<Equal<FederationGate<{ emailPassword: true }, [x?: 1]>, FederationOff>>;
}

// ─────────────────────────────────────────────────────────────────────────────
// (5) Provider-id narrowing — the record keys are the provider ids.
// ─────────────────────────────────────────────────────────────────────────────
async function providerIdNarrowing() {
	const auth = new Auth(scope, 'ids', {
		socialProviders: { google: { clientId: 'g', clientSecret: googleSecret } },
		oidcProviders: {
			okta,
			entra: {
				issuer: 'https://login.example.com',
				clientId: 'e',
				federateVia: 'cognito',
				clientSecret: oktaSecret,
			},
		},
		samlProviders: { partner: { metadataUrl: 'https://partner.example.com/saml' } },
	});
	await auth.getSignInUrl(context, 'okta');
	await auth.getSignInUrl(context, 'google');
	await auth.getSignInUrl(context, 'entra');
	await auth.getSignInUrl(context, 'partner');
	// @ts-expect-error — 'github' is not a configured provider.
	await auth.getSignInUrl(context, 'github');

	type _ids = Expect<Equal<ProviderIdOf<OptionsOf<typeof auth>>, 'google' | 'okta' | 'entra' | 'partner'>>;
	const user = await auth.requireAuth(context);
	type _provider = Expect<Equal<typeof user.signInProvider, 'password' | 'google' | 'okta' | 'entra' | 'partner'>>;

	// `federateVia: 'cognito'` needs a client secret (Cognito is a confidential client);
	// the default direct engine does not (public / PKCE-only clients are fine).
	// @ts-expect-error — clientSecret is required with federateVia: 'cognito'.
	new Auth(scope, 'ids-2', { oidcProviders: { okta: { ...okta, federateVia: 'cognito' } } });
	new Auth(scope, 'ids-3', { oidcProviders: { okta: { ...okta, federateVia: 'direct' } } });
}

// ─────────────────────────────────────────────────────────────────────────────
// (6)(7)(8) `emailPassword: true`, omitted, and the object form all count as
//     enabled — the gate resolves to the method's ordinary trailing parameters.
// ─────────────────────────────────────────────────────────────────────────────
type SignInTail = [options?: SignInOptions];

async function emailPasswordTrue() {
	const auth = new Auth(scope, 'ep-true', { emailPassword: true });
	await auth.signIn('alice', 'pw', context);
	type _on = Expect<Equal<EmailPasswordEnabled<{ emailPassword: true }>, true>>;
	type _gate = Expect<Equal<PasswordGate<{ emailPassword: true }, SignInTail>, SignInTail>>;
}

async function emailPasswordOmitted() {
	const auth = new Auth(scope, 'ep-omitted', { users: { groups: ['admins'] } });
	await auth.signIn('alice', 'pw', context);
	type _on = Expect<Equal<EmailPasswordEnabled<{ users: { groups: ['admins'] } }>, true>>;
	const empty = new Auth(scope, 'ep-empty', {});
	await empty.signIn('alice', 'pw', context);
	type _onEmpty = Expect<Equal<EmailPasswordEnabled<OptionsOf<typeof empty>>, true>>;
	type _gate = Expect<Equal<PasswordGate<OptionsOf<typeof empty>, SignInTail>, SignInTail>>;
}

async function emailPasswordObject() {
	const auth = new Auth(scope, 'ep-object', {
		emailPassword: { selfSignUp: false, passwordPolicy: { minLength: 12 }, autoSignIn: false },
	});
	await auth.signIn('alice', 'pw', context);
	await auth.signUp('alice', 'pw');
	type _on = Expect<Equal<EmailPasswordEnabled<{ emailPassword: { selfSignUp: false } }>, true>>;
	type _gate = Expect<Equal<PasswordGate<{ emailPassword: { selfSignUp: false } }, SignInTail>, SignInTail>>;
}

// ─────────────────────────────────────────────────────────────────────────────
// (9) Variance regression guard — every narrowly configured `Auth<{…}>` is
//     assignable to the plain `Auth`. A conditional *property* type broke
//     exactly this for `AuthCognito` (14 call sites); the parameter-position
//     gates must not. Includes the gate-OFF configurations, which only work
//     because the wide gates are supertypes of both resolutions.
// ─────────────────────────────────────────────────────────────────────────────
function takesWide(_auth: Auth): void {
	/* no-op */
}
function varianceGuard() {
	takesWide(new Auth(scope, 'v-zero'));
	takesWide(new Auth(scope, 'v-empty', {}));
	takesWide(new Auth(scope, 'v-groups', { users: { groups: ['admins', { name: 'readers' }] } }));
	takesWide(new Auth(scope, 'v-attrs', { users: { attributes: [{ name: 'department' }] } }));
	takesWide(new Auth(scope, 'v-pw-true', { emailPassword: true }));
	takesWide(new Auth(scope, 'v-pw-object', { emailPassword: { selfSignUp: false } }));
	takesWide(new Auth(scope, 'v-oidc-only', { emailPassword: false, oidcProviders: { okta } }));
	takesWide(
		new Auth(scope, 'v-social', { socialProviders: { google: { clientId: 'g', clientSecret: googleSecret } } }),
	);
	takesWide(new Auth(scope, 'v-saml', { samlProviders: { partner: { metadataUrl: 'https://p.example.com' } } }));
	takesWide(
		new Auth(scope, 'v-mixed', {
			emailPassword: { passwordPolicy: { minLength: 12 } },
			oidcProviders: { okta },
			users: { groups: ['admins'] },
			mfa: 'optional',
			admin: { actions: ['groups'] },
		}),
	);
	const flag: boolean = runtimeFlag;
	takesWide(new Auth(scope, 'v-pw-boolean', { emailPassword: flag }));
}

// ─────────────────────────────────────────────────────────────────────────────
// (10) The wide `Auth` — what a helper typed `(auth: Auth)` can call. It
//      behaves like the zero-config default: password methods callable (a
//      runtime check backs them, since the instance might have them off),
//      federation methods closed.
// ─────────────────────────────────────────────────────────────────────────────
async function wideSurface(auth: Auth) {
	await auth.signIn('alice', 'pw', context);
	await auth.signIn('alice', 'pw', context, { preferredChallenge: 'PASSWORD' });
	await auth.requireRole(context, 'any-group');
	// @ts-expect-error — the wide type cannot know a provider is configured.
	await auth.getSignInUrl(context, 'okta');
	type _unknown = Expect<Equal<EmailPasswordEnabled<AuthOptions>, boolean>>;
	type _fedClosed = Expect<Equal<HasFederatedProvider<AuthOptions>, false>>;
	type _urlTail = Expect<Equal<FederationGate<AuthOptions, [options?: SignInUrlOptions]>, FederationOff>>;
}

// ─────────────────────────────────────────────────────────────────────────────
// (11) `GroupOf<O>` narrows `requireRole` and the returned user's `groups`.
// ─────────────────────────────────────────────────────────────────────────────
async function groupNarrowing() {
	const auth = new Auth(scope, 'groups', { users: { groups: ['admins', { name: 'readers', precedence: 1 }] } });
	const admin = await auth.requireRole(context, 'admins');
	await auth.requireRole(context, 'readers');
	// @ts-expect-error — 'admin' (typo) is not a declared group.
	await auth.requireRole(context, 'admin');
	type _groups = Expect<Equal<typeof admin.groups, ('admins' | 'readers')[]>>;
	const noGroups = new Auth(scope, 'no-groups', { users: { signInWith: ['email'] } });
	type _wide = Expect<Equal<GroupOf<OptionsOf<typeof noGroups>>, string>>;

	const user: AuthenticatedUser = admin; // a narrowed user widens to the default
	void user;
}

// ─────────────────────────────────────────────────────────────────────────────
// (12) `Auth<O>` structurally satisfies `BlocksAuth` (the auth-common contract),
//      whatever the configuration.
// ─────────────────────────────────────────────────────────────────────────────
function satisfiesBlocksAuth() {
	const zero: BlocksAuth = new Auth(scope, 'ba-zero');
	const groups: BlocksAuth = new Auth(scope, 'ba-groups', { users: { groups: ['admins'] } });
	const oidcOnly: BlocksAuth = new Auth(scope, 'ba-oidc', { emailPassword: false, oidcProviders: { okta } });
	const wide: BlocksAuth = new Auth(scope, 'ba-wide') satisfies Auth;
	void zero;
	void groups;
	void oidcOnly;
	void wide;
}

// ── Passkey user verification: only what Cognito supports ─────────────────
function passkeyUserVerification() {
	const ok = new Auth(scope, 'pk-ok', {
		passkeys: { relyingPartyId: 'example.com', origins: ['https://example.com'], userVerification: 'required' },
	});
	const bad = new Auth(scope, 'pk-bad', {
		// @ts-expect-error Cognito has no 'discouraged' user verification
		passkeys: { relyingPartyId: 'example.com', origins: ['https://example.com'], userVerification: 'discouraged' },
	});
	void ok;
	void bad;
}

// ─────────────────────────────────────────────────────────────────────────────
// (13) MfaGate — the MFA methods need `mfa` on (and email + password).
// ─────────────────────────────────────────────────────────────────────────────
type MfaOff = [ERROR_mfa_is_off_on_this_Auth_instance: never];
async function mfaGate() {
	const on = new Auth(scope, 'mfa-on', { mfa: 'optional' });
	const { sharedSecret } = await on.setUpTotp(context);
	void sharedSecret;
	await on.verifyTotpSetup(context, '123456');
	await on.updateMfaPreference(context, { totp: 'PREFERRED', sms: 'DISABLED' });
	const pref = await on.getMfaPreference(context);
	type _pref = Expect<Equal<typeof pref, MfaPreference<OptionsOf<typeof on>>>>;
	type _onGate = Expect<Equal<MfaGate<OptionsOf<typeof on>>, []>>;

	const required = new Auth(scope, 'mfa-req', { mfa: { mode: 'required', types: ['TOTP', 'EMAIL'] } });
	await required.setUpTotp(context);
	// mfa.types narrows the per-factor input.
	await required.updateMfaPreference(context, { email: 'ENABLED' });
	// @ts-expect-error — SMS is not in mfa.types.
	await required.updateMfaPreference(context, { sms: 'ENABLED' });
	type _types = Expect<Equal<MfaTypeOf<OptionsOf<typeof required>>, 'TOTP' | 'EMAIL'>>;

	// No options at all is the wide type: callable, backed at runtime (like PasswordGate).
	const zero = new Auth(scope, 'mfa-zero');
	await zero.setUpTotp(context);
	const groupsOnly = new Auth(scope, 'mfa-omitted', { users: { groups: ['admins'] } });
	// @ts-expect-error — MFA is off (omitted).
	await groupsOnly.setUpTotp(context);
	const off = new Auth(scope, 'mfa-off', { mfa: 'off' });
	// @ts-expect-error — MFA is off.
	await off.getMfaPreference(context);
	const offObject = new Auth(scope, 'mfa-off-object', { mfa: { types: ['TOTP'] } });
	// @ts-expect-error — `{ mode }` defaults to 'off'.
	await offObject.verifyTotpSetup(context, '123456');
	const noPassword = new Auth(scope, 'mfa-no-pw', { emailPassword: false, oidcProviders: { okta }, mfa: 'optional' });
	// @ts-expect-error — MFA applies to email + password only (construction also rejects this combination).
	await noPassword.setUpTotp(context);
	type _offGate = Expect<Equal<MfaGate<OptionsOf<typeof off>>, MfaOff>>;
	type _wideUnknown = Expect<Equal<MfaEnabled<AuthOptions>, boolean>>;

	const mode: 'off' | 'optional' = runtimeMfaMode;
	const unknown = new Auth(scope, 'mfa-unknown', { mfa: mode });
	await unknown.setUpTotp(context); // unknown at compile time: callable, the runtime backs it
	type _unknown = Expect<Equal<MfaEnabled<OptionsOf<typeof unknown>>, boolean>>;
}

// ─────────────────────────────────────────────────────────────────────────────
// (14) PasskeyGate — the passkey methods need a `passkeys` options object.
// ─────────────────────────────────────────────────────────────────────────────
async function passkeyGate() {
	const on = new Auth(scope, 'pk-gate-on', {
		users: { authFlow: 'USER_AUTH' },
		passkeys: { relyingPartyId: 'example.com', origins: ['https://example.com'] },
	});
	const { credentialCreationOptions } = await on.startPasskeyRegistration(context);
	void credentialCreationOptions;
	const { credentialId } = await on.completePasskeyRegistration(context, '{"id":"c"}');
	void credentialId;
	const keys = await on.listPasskeys(context);
	void keys;
	await on.deletePasskey(context, 'c');

	const off = new Auth(scope, 'pk-gate-off', { users: { authFlow: 'USER_AUTH' } });
	// @ts-expect-error — passkeys are not enabled.
	await off.listPasskeys(context);
	const explicitOff = new Auth(scope, 'pk-gate-false', { passkeys: false });
	// @ts-expect-error — passkeys are not enabled.
	await explicitOff.startPasskeyRegistration(context);
	type _off = Expect<
		Equal<PasskeyGate<OptionsOf<typeof off>>, [ERROR_passkeys_are_not_enabled_on_this_Auth_instance: never]>
	>;
	type _wideUnknown = Expect<Equal<PasskeysEnabled<AuthOptions>, boolean>>;
}

// ─────────────────────────────────────────────────────────────────────────────
// (17) A generic `Auth<O>` is assignable to the wide `Auth` (test harnesses and
//      generic helpers rely on it) — the reason MfaGate / PasskeyGate are open
//      on the wide type.
// ─────────────────────────────────────────────────────────────────────────────
function genericToWide<O extends AuthOptions>(auth: Auth<O>): Auth {
	return auth;
}

// ─────────────────────────────────────────────────────────────────────────────
// (15) Devices (PasswordGate) and the ungated account surface.
// ─────────────────────────────────────────────────────────────────────────────
async function accountSurface() {
	const auth = new Auth(scope, 'account', { users: { attributes: [{ name: 'department' }] } });
	const devices = await Array.fromAsync(auth.scanDevices(context));
	type _devices = Expect<Equal<typeof devices, DeviceRecord[]>>;
	await auth.rememberDevice(context);
	await auth.forgetDevice(context, 'device-key');
	const attrs = await auth.getUserAttributes(context);
	const dept: string | undefined = attrs['custom:department'];
	void dept;
	// @ts-expect-error — 'custom:deparment' (typo) is not a declared attribute.
	void attrs['custom:deparment'];
	await auth.updateUserAttributes(context, { department: 'eng', email: 'a@example.com' });
	// @ts-expect-error — 'departmnt' (typo) is not a declared attribute.
	await auth.updateUserAttributes(context, { departmnt: 'eng' });
	await auth.confirmUserAttribute(context, 'email', '123456');
	await auth.sendUserAttributeVerificationCode(context, 'email');
	await auth.deleteUser(context);

	const oidcOnly = new Auth(scope, 'account-oidc', { emailPassword: false, oidcProviders: { okta } });
	// @ts-expect-error — devices are email + password only.
	oidcOnly.scanDevices(context);
	// Attributes and deleteUser are available in every configuration.
	await oidcOnly.getUserAttributes(context);
	await oidcOnly.deleteUser(context);
}

// ─────────────────────────────────────────────────────────────────────────────
// (16) The admin gate — `auth.admin` needs an `admin` object; `admin.actions`
//      gates each method; group names narrow. Carried over from AuthCognito's
//      admin.types-test.ts.
// ─────────────────────────────────────────────────────────────────────────────
async function adminGate() {
	const off = new Auth(scope, 'admin-off', { users: { groups: ['admins'] } });
	// @ts-expect-error — admin not enabled; `auth.admin` is AdminDisabled.
	await off.admin.addUserToGroup('u', 'admins');
	type _disabled = Expect<Equal<typeof off.admin, AdminDisabled>>;

	const full = new Auth(scope, 'admin-full', { users: { groups: ['admins', 'readers'] }, admin: {} });
	await full.admin.addUserToGroup('u', 'admins');
	await full.admin.createUser('u');
	await full.admin.createUser('u', { temporaryPassword: 'Aa1!aaaa', attributes: { email: 'u@example.com' } });
	await full.admin.setUserPassword('u', 'Aa1!aaaa', { permanent: true });
	// @ts-expect-error — 'editor' is not in 'admins' | 'readers'.
	await full.admin.addUserToGroup('u', 'editor');
	const user = await full.admin.getUser('u');
	if (user?.groups) {
		const g: 'admins' | 'readers' = user.groups[0];
		void g;
	}
	for await (const u of full.admin.scan({ attribute: 'email', match: 'startsWith', value: 'a' })) void u.username;
	// @ts-expect-error — 'contains' is not a supported match mode.
	full.admin.scan({ attribute: 'email', match: 'contains', value: 'a' });
	type _surface = Expect<Equal<typeof full.admin, AdminSurface<OptionsOf<typeof full>>>>;

	const groupsOnly = new Auth(scope, 'admin-groups', {
		users: { groups: ['admins'] },
		admin: { actions: ['groups'] },
	});
	await groupsOnly.admin.addUserToGroup('u', 'admins');
	// @ts-expect-error — lifecycle not granted by actions: ['groups'].
	await groupsOnly.admin.createUser('u');
	// @ts-expect-error — lifecycle not granted, even with the optional init.
	await groupsOnly.admin.createUser('u', {});
	type _gate = Expect<
		Equal<AdminActionGate<OptionsOf<typeof groupsOnly>, 'lifecycle'>, [ERROR_admin_action_not_granted: never]>
	>;
	const lifecycleOnly = new Auth(scope, 'admin-lifecycle', { admin: { actions: ['lifecycle'] } });
	await lifecycleOnly.admin.deleteUser('u');
	// @ts-expect-error — groups not granted by actions: ['lifecycle'].
	await lifecycleOnly.admin.listGroupsForUser('u');

	// @ts-expect-error — `true` is not AdminOptions (the opt-in must be an object).
	new Auth(scope, 'admin-true', { admin: true });

	// Admin-enabled instances stay assignable to the wide `Auth` (AuthCognito's did not)…
	takesWide(full);
	takesWide(groupsOnly);
	// …and the wide type cannot reach the surface without narrowing.
	const wide: Auth = full;
	// @ts-expect-error — the wide type does not know admin is enabled.
	await wide.admin.createUser('u');
	type _wide = Expect<Equal<AdminGetterOf<AuthOptions>, AdminSurface<AuthOptions> | AdminDisabled>>;
}

// ─────────────────────────────────────────────────────────────────────────────
// (18) Unknown options (D1b). `const O` inference does no excess-property
//      check once the literal shares a key with `AuthOptions` (a literal with
//      *only* unknown keys is caught by TypeScript's weak-type check), so a
//      misspelled or misplaced option is rejected at construction by the
//      runtime validator (`option-validation.ts`), not by the compiler. Its
//      known-key tree is pinned to `types.ts` by `satisfies ShapeOf<…>` on
//      every node; the top-level set is pinned here as well.
//
//      The generic wrappers below must keep compiling without a cast. They are
//      why the constructor parameter is not made exact (`O & NoExcess<O>`): no
//      such check can be proven for a still-generic `O`, so both patterns would
//      need a cast (see DESIGN.md, "Unknown options").
// ─────────────────────────────────────────────────────────────────────────────
type _shapeKeys = Expect<Equal<keyof typeof AUTH_OPTIONS_SHAPE, keyof AuthMockOptions>>;

function wrapperPassThrough<const O extends AuthOptions>(options: O): Auth<O> {
	return new Auth(scope, 'wrapped', options);
}
function wrapperWithDefaults<const O extends AuthOptions>(options: O) {
	return new Auth(scope, 'wrapped-defaults', { ...options, session: { ttlSeconds: 3600 } });
}
function unknownOptionsCompile() {
	takesWide(wrapperPassThrough({ users: { groups: ['admins'] } }));
	takesWide(wrapperWithDefaults({ mfa: 'optional' }));
	// Both compile, and both throw at construction with a "did you mean …?".
	new Auth(scope, 'typo', { emailPasword: false, session: { ttlSeconds: 60 } });
	new Auth(scope, 'misplaced', { preferredChallenge: 'EMAIL_OTP', users: { authFlow: 'USER_AUTH' } });
}

// ─────────────────────────────────────────────────────────────────────────────
// (19) `SignInNextStep<O>` narrows to the steps the configuration can produce,
//      so a `switch` on `nextStep.name` is exhaustive over just those. The wide
//      type (and anything the compiler cannot see) keeps every step, and every
//      narrowed result stays assignable to the wide one.
// ─────────────────────────────────────────────────────────────────────────────
type StepNames<A> = A extends Auth<infer O> ? SignInNextStep<O>['name'] : never;
type AlwaysSteps = 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED' | 'RESET_PASSWORD' | 'CONFIRM_SIGN_UP';
type MfaSelectionSteps = 'CONTINUE_SIGN_IN_WITH_MFA_SELECTION' | 'CONTINUE_SIGN_IN_WITH_MFA_SETUP_SELECTION';
type FirstFactorSteps =
	| 'CONTINUE_SIGN_IN_WITH_FIRST_FACTOR_SELECTION'
	| 'CONFIRM_SIGN_IN_WITH_PASSWORD'
	| 'CONFIRM_SIGN_IN_WITH_FIRST_FACTOR_EMAIL_OTP'
	| 'CONFIRM_SIGN_IN_WITH_FIRST_FACTOR_SMS_OTP';

async function signInStepNarrowing() {
	// MFA off, no passkeys, the classic flow: three steps, and the switch is exhaustive.
	const plain = new Auth(scope, 'steps-plain', { mfa: 'off' });
	const result = await plain.signIn('alice', 'pw', context);
	if (result.status === 'continueSignIn') {
		const step = result.nextStep;
		switch (step.name) {
			case 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED':
				void step.requiredAttributes;
				break;
			case 'RESET_PASSWORD':
			case 'CONFIRM_SIGN_UP':
				break;
			// @ts-expect-error — MFA is off: no TOTP step to handle.
			case 'CONTINUE_SIGN_IN_WITH_TOTP_SETUP':
				break;
			// @ts-expect-error — passkeys are not enabled.
			case 'CONFIRM_SIGN_IN_WITH_WEB_AUTHN':
				break;
			default: {
				const exhaustive: never = step;
				void exhaustive;
			}
		}
	}
	type _plain = Expect<Equal<StepNames<typeof plain>, AlwaysSteps>>;
	type _omitted = Expect<Equal<StepNames<Auth<{ users: { groups: ['admins'] } }>>, AlwaysSteps>>;

	// MFA on: the selection steps, plus each listed factor's own steps.
	const totp = new Auth(scope, 'steps-totp', { mfa: { mode: 'optional', types: ['TOTP'] } });
	type _totp = Expect<
		Equal<
			StepNames<typeof totp>,
			AlwaysSteps | MfaSelectionSteps | 'CONFIRM_SIGN_IN_WITH_TOTP_CODE' | 'CONTINUE_SIGN_IN_WITH_TOTP_SETUP'
		>
	>;
	const smsEmail = new Auth(scope, 'steps-sms-email', { mfa: { mode: 'required', types: ['SMS', 'EMAIL'] } });
	type _smsEmail = Expect<
		Equal<
			StepNames<typeof smsEmail>,
			| AlwaysSteps
			| MfaSelectionSteps
			| 'CONFIRM_SIGN_IN_WITH_SMS_CODE'
			| 'CONFIRM_SIGN_IN_WITH_EMAIL_CODE'
			| 'CONTINUE_SIGN_IN_WITH_EMAIL_SETUP'
		>
	>;
	// `mfa.types` omitted (or not a literal): every factor's steps.
	const anyFactor = new Auth(scope, 'steps-any-factor', { mfa: 'optional' });
	type _anyFactor = Expect<
		Equal<
			StepNames<typeof anyFactor>,
			| AlwaysSteps
			| MfaSelectionSteps
			| 'CONFIRM_SIGN_IN_WITH_SMS_CODE'
			| 'CONFIRM_SIGN_IN_WITH_TOTP_CODE'
			| 'CONTINUE_SIGN_IN_WITH_TOTP_SETUP'
			| 'CONFIRM_SIGN_IN_WITH_EMAIL_CODE'
			| 'CONTINUE_SIGN_IN_WITH_EMAIL_SETUP'
		>
	>;
	// MFA applies to email + password only.
	type _noPasswordMfa = Expect<
		Equal<
			StepNames<Auth<{ emailPassword: false; oidcProviders: { okta: typeof okta }; mfa: 'optional' }>>,
			AlwaysSteps
		>
	>;

	// `users.authFlow: 'USER_AUTH'`: the first-factor steps; passkeys add WebAuthn.
	const userAuth = new Auth(scope, 'steps-user-auth', { users: { authFlow: 'USER_AUTH' } });
	type _userAuth = Expect<Equal<StepNames<typeof userAuth>, AlwaysSteps | FirstFactorSteps>>;
	const passkeys = new Auth(scope, 'steps-passkeys', {
		users: { authFlow: 'USER_AUTH' },
		passkeys: { relyingPartyId: 'example.com', origins: ['https://example.com'] },
	});
	type _passkeys = Expect<
		Equal<StepNames<typeof passkeys>, AlwaysSteps | FirstFactorSteps | 'CONFIRM_SIGN_IN_WITH_WEB_AUTHN'>
	>;
	type _flow = Expect<Equal<AuthFlowOf<OptionsOf<typeof userAuth>>, 'USER_AUTH'>>;
	type _flowDefault = Expect<Equal<AuthFlowOf<OptionsOf<typeof plain>>, 'USER_PASSWORD_AUTH'>>;
	type _flowWide = Expect<Equal<AuthFlowOf<AuthOptions>, 'USER_PASSWORD_AUTH' | 'USER_AUTH'>>;

	// confirmSignIn and autoSignIn return the same narrowed step.
	const confirmed = await totp.confirmSignIn('session', '123456', context);
	const auto = await plain.autoSignIn(context);
	type _confirm = Expect<Equal<typeof confirmed, SignInResult<OptionsOf<typeof totp>>>>;
	type _auto = Expect<Equal<typeof auto, SignInResult<OptionsOf<typeof plain>>>>;

	// The wide type, zero-config, a value the compiler cannot see, and a wrapped
	// pool (whose own settings decide the challenges) keep every step.
	type _wide = Expect<Equal<SignInNextStep, AnySignInNextStep>>;
	type _wideExplicit = Expect<Equal<SignInNextStep<AuthOptions>, AnySignInNextStep>>;
	const zero = new Auth(scope, 'steps-zero');
	type _zero = Expect<Equal<StepNames<typeof zero>, AnySignInNextStep['name']>>;
	const unknownMode = new Auth(scope, 'steps-unknown', { mfa: { mode: runtimeMfaMode, types: ['TOTP'] } });
	type _unknown = Expect<
		Equal<
			StepNames<typeof unknownMode>,
			AlwaysSteps | MfaSelectionSteps | 'CONFIRM_SIGN_IN_WITH_TOTP_CODE' | 'CONTINUE_SIGN_IN_WITH_TOTP_SETUP'
		>
	>;
	const wrapped = new Auth(scope, 'steps-wrapped', {
		userPool: Auth.fromExisting('us-east-1_AbCdEf123'),
		mfa: 'off',
	});
	type _wrapped = Expect<Equal<StepNames<typeof wrapped>, AnySignInNextStep['name']>>;

	// Narrowed results widen: to the wide result, and the instances to the wide `Auth`.
	const wideResult: SignInResult = result;
	void wideResult;
	takesWide(plain);
	takesWide(totp);
	takesWide(smsEmail);
	takesWide(userAuth);
	takesWide(passkeys);
	takesWide(wrapped);
}

/** A helper generic over the configuration widens a still-generic step to the wide one. */
function genericSignInStep<O extends AuthOptions>(result: SignInResult<O>): SignInNextStep | null {
	return result.status === 'continueSignIn' ? result.nextStep : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// (20) A factor `mfa.types` leaves out is typed by a branded error type, so the
//      diagnostic names the cause (asserted in gate-diagnostics.test.ts).
// ─────────────────────────────────────────────────────────────────────────────
type TotpOnly = { mfa: { mode: 'optional'; types: ['TOTP'] } };
type _smsBrand = Expect<Equal<MfaPreferenceInput<TotpOnly>['sms'], ERROR_SMS_is_not_in_mfa_types | undefined>>;
type _emailBrand = Expect<Equal<MfaPreferenceInput<TotpOnly>['email'], ERROR_EMAIL_is_not_in_mfa_types | undefined>>;
type _totpKept = Expect<
	Equal<MfaPreferenceInput<TotpOnly>['totp'], 'ENABLED' | 'DISABLED' | 'PREFERRED' | 'NOT_PREFERRED' | undefined>
>;
type _totpBrand = Expect<
	Equal<
		MfaPreferenceInput<{ mfa: { mode: 'optional'; types: ['SMS'] } }>['totp'],
		ERROR_TOTP_is_not_in_mfa_types | undefined
	>
>;

// ─────────────────────────────────────────────────────────────────────────────
// (21) `AdminDisabled` lists every admin method (each uncallable), so a call is
//      reported as a missing gate argument naming the fix, not as a missing
//      property (asserted in gate-diagnostics.test.ts).
// ─────────────────────────────────────────────────────────────────────────────
type _adminKeys = Expect<Equal<Exclude<keyof AdminDisabled, '__adminNotEnabled'>, keyof AdminSurface>>;

// ─────────────────────────────────────────────────────────────────────────────
// (22) `signInProvider` keeps `'password'` with `emailPassword: false`: the
//      guards still return it for a bearer token from another app client and
//      for a session issued before email + password was turned off
//      (bearer.mock.test.ts proves both at runtime).
// ─────────────────────────────────────────────────────────────────────────────
async function signInProviderWithoutPassword() {
	const auth = new Auth(scope, 'provider-no-pw', { emailPassword: false, oidcProviders: { okta } });
	const user = await auth.requireAuth(context);
	type _provider = Expect<Equal<typeof user.signInProvider, 'password' | 'okta'>>;
}

// ─────────────────────────────────────────────────────────────────────────────
// (23) Options in a variable (README, "Mode gates"). `as const satisfies
//      AuthOptions` keeps every narrowing. Plain `satisfies AuthOptions` keeps
//      the gates (`false` stays a literal) but widens arrays, so the declared
//      groups become `string[]` and `requireRole` accepts any string. A
//      variable annotated `: AuthOptions` loses both.
// ─────────────────────────────────────────────────────────────────────────────
async function satisfiesForms() {
	const constOpts = {
		emailPassword: false,
		oidcProviders: { okta },
		users: { groups: ['admins', 'readers'] },
	} as const satisfies AuthOptions;
	const narrowed = new Auth(scope, 'satisfies-const', constOpts);
	// @ts-expect-error — the gate holds: email + password is disabled.
	await narrowed.signIn('u', 'p', context);
	const narrowedUser = await narrowed.requireAuth(context);
	type _constGroups = Expect<Equal<typeof narrowedUser.groups, ('admins' | 'readers')[]>>;
	// @ts-expect-error — 'admin' (typo) is not a declared group.
	await narrowed.requireRole(context, 'admin');
	await narrowed.getSignInUrl(context, 'okta');

	const plainOpts = {
		emailPassword: false,
		oidcProviders: { okta },
		users: { groups: ['admins', 'readers'] },
	} satisfies AuthOptions;
	const widened = new Auth(scope, 'satisfies-plain', plainOpts);
	// @ts-expect-error — the gate still holds.
	await widened.signIn('u', 'p', context);
	const widenedUser = await widened.requireAuth(context);
	// …but the group narrowing is lost, with no error anywhere.
	type _plainGroups = Expect<Equal<typeof widenedUser.groups, string[]>>;
	await widened.requireRole(context, 'admin');

	const annotated: AuthOptions = { emailPassword: false, oidcProviders: { okta } };
	const wide = new Auth(scope, 'satisfies-annotated', annotated);
	await wide.signIn('u', 'p', context); // the wide type: callable, checked at runtime
}

void [
	satisfiesForms,
	unknownOptionsCompile,
	signInStepNarrowing,
	genericSignInStep,
	signInProviderWithoutPassword,
	mfaGate,
	passkeyGate,
	accountSurface,
	adminGate,
	genericToWide,
	passkeyUserVerification,
	passwordGateOn,
	passwordGateOff,
	federationGateOn,
	federationGateOff,
	providerIdNarrowing,
	emailPasswordTrue,
	emailPasswordOmitted,
	emailPasswordObject,
	varianceGuard,
	wideSurface,
	groupNarrowing,
	satisfiesBlocksAuth,
];
