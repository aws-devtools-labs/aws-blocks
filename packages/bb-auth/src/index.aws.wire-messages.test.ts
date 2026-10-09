// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * AWS runtime — Cognito's error text never reaches a client (FX59), against a
 * spied Cognito client (no network). Harness: `test-support/aws-harness.ts`.
 *
 * Ports `AuthCognito` #678 (`bb-auth-cognito` 0.1.11, "stop leaking raw
 * Cognito SDK text in ApiError"): every Cognito failure reaches the client
 * with a BB-authored message chosen by its `AuthErrors` name
 * (`clientMessageFor`), or with the enumeration-masked answer; Cognito's own
 * message goes to the server log only, the login redacted. Before FX59 `Auth`
 * withheld only messages naming an ARN or an account id
 * (`index.aws.errors.test.ts`), so an app moving from `AuthCognito` 0.1.11 to
 * `Auth` would have undone #678.
 *
 * Every public path that sends a Cognito call is driven with every name in the
 * vocabulary (and two outside it); each client-observable projection — the
 * thrown error, its JSON, and the Authenticator state — must be free of the
 * Cognito text.
 */

import assert from 'node:assert';
import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, test } from 'node:test';
import type { AuthStateApi } from '@aws-blocks/auth-common';
import type { BlocksContext } from '@aws-blocks/core';
import { ApiError } from '@aws-blocks/core';
import { INCORRECT_CREDENTIALS_MESSAGE, WRONG_CODE_MESSAGE } from './enumeration.js';
import { ACCESS_DENIED_MESSAGE, clientMessageFor, INTERNAL_ERROR_MESSAGE } from './error-mapping.js';
import { type Auth, AuthErrors } from './index.aws.js';
import {
	type AwsAuthHarness,
	Browser,
	captureLogger,
	cognitoError,
	makeAwsAuth,
	signInAs,
	wireView,
} from './test-support/aws-harness.js';
import type { AuthOptions } from './types.js';

beforeEach(() => rmSync('.bb-data', { recursive: true, force: true }));
afterEach(() => rmSync('.bb-data', { recursive: true, force: true }));

/** `createApi()` returns a context-bound callable; narrow it to the public surface. */
function apiFor<O extends AuthOptions>(auth: Auth<O>, ctx: BlocksContext): AuthStateApi {
	return (auth.createApi() as unknown as (c: BlocksContext) => AuthStateApi)(ctx);
}

/** A marker no BB-authored message contains: wherever it shows up, Cognito's text leaked. */
const MARKER = 'RAW-COGNITO-TEXT';
/** Cognito-shaped text: a validation detail, an endpoint and an echoed request value. */
const RAW = `${MARKER}: 1 validation error detected at https://cognito-idp.us-east-1.amazonaws.com: value 'x' rejected`;

/** The login the public paths use (long enough that redacting it from the log leaves the marker intact). */
const LOGIN_SCAN = 'zed-user';

const AUTH_NAMES: ReadonlySet<string> = new Set<string>(Object.values(AuthErrors));
/** Every vocabulary name, plus an AWS access error and a future Cognito name. */
const NAMES = [...AUTH_NAMES, 'AccessDeniedException', 'SomeFutureCognitoException'];

/** The messages a client may see for an error named `name`. */
function allowedMessages(name: string): string[] {
	const allowed = AUTH_NAMES.has(name) ? [clientMessageFor(name)] : [];
	if (name === AuthErrors.NotAuthorized) allowed.push(INCORRECT_CREDENTIALS_MESSAGE);
	if (name === AuthErrors.CodeMismatch) allowed.push(WRONG_CODE_MESSAGE);
	if (name === AuthErrors.InternalError) allowed.push(INTERNAL_ERROR_MESSAGE, ACCESS_DENIED_MESSAGE);
	return allowed;
}

const options = () =>
	({
		users: { groups: ['admins'], authFlow: 'USER_AUTH' },
		passkeys: { relyingPartyId: 'example.com', origins: ['https://example.com'] },
		mfa: { mode: 'optional', types: ['SMS', 'TOTP'] },
		admin: {},
		emailPassword: { revealExistingUsers: true },
	}) as const;
type H = AwsAuthHarness<ReturnType<typeof options> & { logger: ReturnType<typeof captureLogger>['logger'] }>;

async function signedIn(h: H, b: Browser): Promise<{ session: string }> {
	await signInAs(h, b, 'alice');
	return { session: '' };
}

/** Start a TOTP challenge; return its envelope. */
async function challengeSession(h: H, b: Browser): Promise<{ session: string }> {
	h.on('InitiateAuthCommand', () => ({ ChallengeName: 'SOFTWARE_TOKEN_MFA', Session: 'cog-1' }));
	const r = await b.request((c) => h.auth.signIn('alice', '', c, { preferredChallenge: 'EMAIL_OTP' }));
	return { session: r.status === 'continueSignIn' && 'session' in r.nextStep ? r.nextStep.session : '' };
}

interface Path {
	label: string;
	command: string;
	run: (h: H, b: Browser, extra: { session: string }) => Promise<unknown>;
	setup?: (h: H, b: Browser) => Promise<{ session: string }>;
}

/** Each public path that sends a Cognito call, grouped by area. */
const PATHS: Path[] = [
	// sign-in
	{
		label: 'signIn',
		command: 'InitiateAuthCommand',
		run: (h, b) => b.request((c) => h.auth.signIn(LOGIN_SCAN, 'p', c)),
	},
	{
		label: 'confirmSignIn (MFA code)',
		command: 'RespondToAuthChallengeCommand',
		run: (h, b, { session }) => b.request((c) => h.auth.confirmSignIn(session, '123456', c)),
		setup: challengeSession,
	},
	{
		label: 'session refresh',
		command: 'InitiateAuthCommand',
		run: (h, b) => b.request((c) => h.auth.requireAuth(c)),
		setup: async (h, b) => {
			await signInAs(h, b, 'alice', h.idp.authResult('alice', { accessExpIn: -60 }));
			return { session: '' };
		},
	},
	{
		label: 'signOut({ global })',
		command: 'GlobalSignOutCommand',
		run: (h, b) => b.request((c) => h.auth.signOut(c, { global: true })),
		setup: signedIn,
	},
	// sign-up + confirm
	{ label: 'signUp', command: 'SignUpCommand', run: (h) => h.auth.signUp(LOGIN_SCAN, 'Password!1') },
	{
		label: 'setAuthState signUp',
		command: 'SignUpCommand',
		run: (h, b) =>
			b.request((c) =>
				apiFor(h.auth, c).setAuthState({ action: 'signUp', username: LOGIN_SCAN, password: 'Password!1' }),
			),
	},
	{ label: 'confirmSignUp', command: 'ConfirmSignUpCommand', run: (h) => h.auth.confirmSignUp(LOGIN_SCAN, '1') },
	{
		label: 'resendSignUpCode',
		command: 'ResendConfirmationCodeCommand',
		run: (h) => h.auth.resendSignUpCode(LOGIN_SCAN),
	},
	// password reset + change
	{ label: 'resetPassword', command: 'ForgotPasswordCommand', run: (h) => h.auth.resetPassword(LOGIN_SCAN) },
	{
		label: 'confirmResetPassword',
		command: 'ConfirmForgotPasswordCommand',
		run: (h) => h.auth.confirmResetPassword(LOGIN_SCAN, '1', 'Password!1'),
	},
	{
		label: 'updatePassword',
		command: 'ChangePasswordCommand',
		run: (h, b) => b.request((c) => h.auth.updatePassword(c, 'Old!pass1', 'New!pass1')),
		setup: signedIn,
	},
	// MFA
	{
		label: 'setUpTotp',
		command: 'AssociateSoftwareTokenCommand',
		run: (h, b) => b.request((c) => h.auth.setUpTotp(c)),
		setup: signedIn,
	},
	{
		label: 'verifyTotpSetup',
		command: 'VerifySoftwareTokenCommand',
		run: (h, b) => b.request((c) => h.auth.verifyTotpSetup(c, '123456')),
		setup: signedIn,
	},
	{
		label: 'updateMfaPreference',
		command: 'SetUserMFAPreferenceCommand',
		run: (h, b) => b.request((c) => h.auth.updateMfaPreference(c, { totp: 'PREFERRED' })),
		setup: signedIn,
	},
	{
		label: 'getMfaPreference',
		command: 'GetUserCommand',
		run: (h, b) => b.request((c) => h.auth.getMfaPreference(c)),
		setup: signedIn,
	},
	// attributes + account
	{
		label: 'getUserAttributes',
		command: 'GetUserCommand',
		run: (h, b) => b.request((c) => h.auth.getUserAttributes(c)),
		setup: signedIn,
	},
	{
		label: 'updateUserAttributes',
		command: 'UpdateUserAttributesCommand',
		run: (h, b) => b.request((c) => h.auth.updateUserAttributes(c, { name: 'Alice' })),
		setup: signedIn,
	},
	{
		label: 'confirmUserAttribute',
		command: 'VerifyUserAttributeCommand',
		run: (h, b) => b.request((c) => h.auth.confirmUserAttribute(c, 'email', '123456')),
		setup: signedIn,
	},
	{
		label: 'sendUserAttributeVerificationCode',
		command: 'GetUserAttributeVerificationCodeCommand',
		run: (h, b) => b.request((c) => h.auth.sendUserAttributeVerificationCode(c, 'email')),
		setup: signedIn,
	},
	{
		label: 'deleteUser',
		command: 'DeleteUserCommand',
		run: (h, b) => b.request((c) => h.auth.deleteUser(c)),
		setup: signedIn,
	},
	{
		label: 'requireRole',
		command: 'AdminListGroupsForUserCommand',
		run: (h, b) => b.request((c) => h.auth.requireRole(c, 'admins')),
		setup: signedIn,
	},
	// passkeys
	{
		label: 'startPasskeyRegistration',
		command: 'StartWebAuthnRegistrationCommand',
		run: (h, b) => b.request((c) => h.auth.startPasskeyRegistration(c)),
		setup: signedIn,
	},
	{
		label: 'setAuthState completePasskeyRegistration',
		command: 'CompleteWebAuthnRegistrationCommand',
		run: (h, b) =>
			b.request((c) =>
				apiFor(h.auth, c).setAuthState({
					action: 'completePasskeyRegistration',
					credential: '{"id":"cred-1","type":"public-key"}',
				}),
			),
		setup: signedIn,
	},
	{
		label: 'listPasskeys',
		command: 'ListWebAuthnCredentialsCommand',
		run: (h, b) => b.request((c) => h.auth.listPasskeys(c)),
		setup: signedIn,
	},
	{
		label: 'deletePasskey',
		command: 'DeleteWebAuthnCredentialCommand',
		run: (h, b) => b.request((c) => h.auth.deletePasskey(c, 'cred-1')),
		setup: signedIn,
	},
	// admin
	{ label: 'admin.createUser', command: 'AdminCreateUserCommand', run: (h) => h.auth.admin.createUser('bob') },
	{ label: 'admin.getUser', command: 'AdminGetUserCommand', run: (h) => h.auth.admin.getUser('bob') },
	{ label: 'admin.deleteUser', command: 'AdminDeleteUserCommand', run: (h) => h.auth.admin.deleteUser('bob') },
	{ label: 'admin.disableUser', command: 'AdminDisableUserCommand', run: (h) => h.auth.admin.disableUser('bob') },
	{
		label: 'admin.setUserPassword',
		command: 'AdminSetUserPasswordCommand',
		run: (h) => h.auth.admin.setUserPassword('bob', 'Password!1'),
	},
	{
		label: 'admin.addUserToGroup',
		command: 'AdminAddUserToGroupCommand',
		run: (h) => h.auth.admin.addUserToGroup('bob', 'admins'),
	},
	{
		label: 'admin.scan',
		command: 'ListUsersCommand',
		run: (h) => Array.fromAsync(h.auth.admin.scan()),
	},
];

/** Every client-observable projection of an outcome must be free of Cognito's text. */
function assertNoCognitoText(label: string, observed: unknown): void {
	for (const text of [String(JSON.stringify(observed)), JSON.stringify(wireView(observed))]) {
		assert.ok(!text.includes(MARKER), `${label}: Cognito's text reached the client: ${text}`);
	}
	if (observed instanceof Error) assert.ok(!observed.message.includes(MARKER), `${label}: message`);
}

/** A thrown error's message, or an Authenticator state's `error`, is one the client may see for its name. */
function assertAllowedMessage(label: string, observed: unknown): void {
	if (observed instanceof ApiError) {
		assert.ok(
			allowedMessages(observed.name).includes(observed.message),
			`${label}: '${observed.message}' is not the fixed message for ${observed.name}`,
		);
		return;
	}
	if (typeof observed !== 'object' || observed === null) return;
	const error: unknown = Reflect.get(observed, 'error');
	const errorName: unknown = Reflect.get(observed, 'errorName');
	if (typeof error === 'string' && typeof errorName === 'string') {
		assert.ok(
			allowedMessages(errorName).includes(error),
			`${label}: state error '${error}' is not the fixed message for ${errorName}`,
		);
	}
}

describe('AWS: no Cognito error text reaches the client, on any path (FX59, #678)', () => {
	for (const path of PATHS) {
		test(`${path.label}: every Cognito name → the fixed message; the text is logged`, async () => {
			for (const name of NAMES) {
				const { logger, entries } = captureLogger();
				const h: H = makeAwsAuth({ ...options(), logger });
				const b = new Browser();
				const extra = path.setup ? await path.setup(h, b) : { session: '' };
				h.on(path.command, () => {
					throw cognitoError(name, RAW);
				});
				const observed = await path.run(h, b, extra).then(
					(ok) => ok,
					(err: unknown) => err,
				);
				const label = `${path.label} ${name}`;
				assertNoCognitoText(label, observed);
				assertAllowedMessage(label, observed);
				// When the client sees the name Cognito sent, the mapping withheld
				// Cognito's message — the operator gets it in the log.
				if (observed instanceof ApiError && observed.name === name && AUTH_NAMES.has(name)) {
					assert.ok(
						entries.some((x) => JSON.stringify(x.context ?? {}).includes(MARKER)),
						`${label}: Cognito's text is not in the server log: ${JSON.stringify(entries)}`,
					);
				}
			}
		});
	}
});

describe('AWS: the logged Cognito text has the login redacted (B6)', () => {
	const LOGIN = 'Alice@Example.com';
	const echo = `${MARKER}: 1 validation error detected: Value '${LOGIN}' at 'username' failed to satisfy constraint`;

	const cases: Array<{ label: string; command: string; run: (h: H, b: Browser) => Promise<unknown> }> = [
		{ label: 'signUp', command: 'SignUpCommand', run: (h) => h.auth.signUp(LOGIN, 'Password!1') },
		{
			label: 'signIn',
			command: 'InitiateAuthCommand',
			run: (h, b) => b.request((c) => h.auth.signIn(LOGIN, 'p', c)),
		},
		{ label: 'confirmSignUp', command: 'ConfirmSignUpCommand', run: (h) => h.auth.confirmSignUp(LOGIN, '1') },
		{ label: 'resetPassword', command: 'ForgotPasswordCommand', run: (h) => h.auth.resetPassword(LOGIN) },
		{
			label: 'confirmResetPassword',
			command: 'ConfirmForgotPasswordCommand',
			run: (h) => h.auth.confirmResetPassword(LOGIN, '1', 'Password!1'),
		},
		{
			label: 'resendSignUpCode',
			command: 'ResendConfirmationCodeCommand',
			run: (h) => h.auth.resendSignUpCode(LOGIN),
		},
	];

	for (const c of cases) {
		test(`${c.label}: the client gets the fixed message; the log has Cognito's text without the login`, async () => {
			const { logger, entries } = captureLogger();
			const h: H = makeAwsAuth({ ...options(), logger });
			h.on(c.command, () => {
				throw cognitoError(AuthErrors.InvalidParameter, echo);
			});
			const observed = await c.run(h, new Browser()).then(
				(ok) => ok,
				(err: unknown) => err,
			);
			assert.ok(observed instanceof ApiError, `${c.label}: rejects`);
			assert.strictEqual(observed.message, clientMessageFor(AuthErrors.InvalidParameter));
			const logged = entries.filter((x) => JSON.stringify(x.context ?? {}).includes(MARKER));
			assert.ok(logged.length > 0, `${c.label}: Cognito's text is logged: ${JSON.stringify(entries)}`);
			for (const x of logged) {
				const text = JSON.stringify(x.context);
				assert.ok(
					!text.toLowerCase().includes(LOGIN.toLowerCase()),
					`${c.label}: the login is logged: ${text}`,
				);
				assert.ok(text.includes('[REDACTED]'), `${c.label}: the login is redacted: ${text}`);
			}
		});
	}
});
