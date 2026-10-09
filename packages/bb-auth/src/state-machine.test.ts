// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The `AuthState` builders and `createApi()`: the D-005 form model, the
 * public action/field names (data-testid contract + log redaction), the
 * `revealExistingUsers` rule, and the exactly-two-method RPC surface.
 */

import assert from 'node:assert';
import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, test } from 'node:test';
import type { AuthActionInput, AuthState, AuthStateApi } from '@aws-blocks/auth-common';
import type { BlocksContext } from '@aws-blocks/core';
import { WRONG_CODE_MESSAGE } from './enumeration.js';
import { AuthErrors } from './errors.js';
import {
	autoSignInPending,
	confirmingPasswordReset,
	confirmingSignIn,
	confirmingSignUp,
	managingPasskeys,
	registeringPasskey,
	signedIn,
	signedOut,
} from './state-machine.js';
import { Browser, makeAuth, makeContext, sdkError } from './test-helpers.js';
import type { AppSettingRef, SignInNextStep } from './types.js';

beforeEach(() => rmSync('.bb-data', { recursive: true, force: true }));
afterEach(() => rmSync('.bb-data', { recursive: true, force: true }));

const secret: AppSettingRef = { fullId: 's', get: async () => 's' };
const delivery = { destination: 'a***@e***', deliveryMedium: 'EMAIL' as const, attributeName: 'email' };

/** Call the namespace the way the RPC layer does: build the per-request handler, then call a method. */
function bind(api: AuthStateApi, ctx: BlocksContext): AuthStateApi {
	const target: unknown = api;
	assert.ok(typeof target === 'function');
	const handler: unknown = Reflect.apply(target, undefined, [ctx]);
	assert.ok(typeof handler === 'object' && handler !== null);
	const getAuthState: unknown = Reflect.get(handler, 'getAuthState');
	const setAuthState: unknown = Reflect.get(handler, 'setAuthState');
	assert.ok(typeof getAuthState === 'function' && typeof setAuthState === 'function');
	return {
		getAuthState: () => Reflect.apply(getAuthState, handler, []),
		setAuthState: (input: AuthActionInput) => Reflect.apply(setAuthState, handler, [input]),
	};
}

async function rpc<T>(b: Browser, api: AuthStateApi, fn: (api: AuthStateApi) => Promise<T>): Promise<T> {
	return b.request((ctx) => fn(bind(api, ctx)));
}

const names = (s: AuthState) => s.actions.map((a) => a.name);

describe('createApi()', () => {
	test('exposes exactly getAuthState and setAuthState — no getClient()', () => {
		const { auth } = makeAuth({ oidcProviders: { okta: { issuer: 'https://okta.example.com', clientId: 'c' } } });
		const api = auth.createApi();
		assert.strictEqual(typeof api, 'function');
		assert.strictEqual(Reflect.get(api, Symbol.for('blocks:ApiNamespace')), 'auth');
		const target: unknown = api;
		assert.ok(typeof target === 'function');
		const handler: unknown = Reflect.apply(target, undefined, [makeContext()]);
		assert.ok(typeof handler === 'object' && handler !== null);
		assert.deepStrictEqual(Object.keys(handler).sort(), ['getAuthState', 'setAuthState']);
	});

	test('signed out → sign in through setAuthState → getAuthState is signedIn → signOut', async () => {
		const h = makeAuth();
		h.native.addUser('alice');
		const api = h.auth.createApi();
		const b = new Browser();
		assert.deepStrictEqual(names(await rpc(b, api, (a) => a.getAuthState())), [
			'signIn',
			'signUp',
			'resetPassword',
		]);
		const s = await rpc(b, api, (a) =>
			a.setAuthState({ action: 'signIn', username: 'alice', password: 'Passw0rd!' }),
		);
		assert.strictEqual(s.state, 'signedIn');
		assert.strictEqual(s.user?.username, 'alice');
		assert.ok(b.jar.has(h.cookieName));
		const again = await rpc(b, api, (a) => a.getAuthState());
		assert.deepStrictEqual(again.actions, [{ name: 'signOut', label: 'Sign Out', fields: [] }]);
		const out = await rpc(b, api, (a) => a.setAuthState({ action: 'signOut' }));
		assert.strictEqual(out.state, 'signedOut');
		assert.ok(!b.jar.has(h.cookieName));
	});

	test('a wrong password → signedOut with the uniform errorName; a wrong MFA code → retriable on the same step', async () => {
		const h = makeAuth();
		h.native.addUser('alice');
		const api = h.auth.createApi();
		const b = new Browser();
		const bad = await rpc(b, api, (a) => a.setAuthState({ action: 'signIn', username: 'alice', password: 'nope' }));
		assert.strictEqual(bad.state, 'signedOut');
		assert.strictEqual(bad.errorName, AuthErrors.NotAuthorized);
		assert.strictEqual(bad.error, 'Incorrect username or password');

		h.native.nextChallenge = { name: 'CONFIRM_SIGN_IN_WITH_TOTP_CODE', session: 'sess:alice' };
		const challenge = await rpc(b, api, (a) =>
			a.setAuthState({ action: 'signIn', username: 'alice', password: 'Passw0rd!' }),
		);
		assert.strictEqual(challenge.state, 'confirmingSignIn');
		const wrong = await rpc(b, api, (a) =>
			a.setAuthState({ action: 'confirmSignIn', challenge: 'code', session: 'sess:alice', code: '999999' }),
		);
		assert.deepStrictEqual(wrong, {
			state: 'signedOut',
			actions: [],
			// FX59 (#678): the fixed wrong-code message, not the engine's text.
			error: WRONG_CODE_MESSAGE,
			retriable: true,
			errorName: AuthErrors.CodeMismatch,
		});
		const ok = await rpc(b, api, (a) =>
			a.setAuthState({ action: 'confirmSignIn', challenge: 'code', session: 'sess:alice', code: '000000' }),
		);
		assert.strictEqual(ok.state, 'signedIn');
	});

	test('an engine error outside the vocabulary reaches the UI as InternalErrorException with a generic message', async () => {
		const h = makeAuth();
		h.native.resendSignUpCode = async () => {
			throw sdkError(
				'CodeDeliveryFailureException',
				'Could not deliver to +15555550100 via arn:aws:sns:us-east-1:123456789012:x',
			);
		};
		const s = await rpc(new Browser(), h.auth.createApi(), (a) =>
			a.setAuthState({ action: 'resendSignUpCode', username: 'x' }),
		);
		assert.strictEqual(s.errorName, AuthErrors.InternalError);
		assert.ok(!JSON.stringify(s).includes('arn:aws'));
		assert.ok(!JSON.stringify(s).includes('5555550100'));
	});

	test('an unknown action → signedOut with an error, never a throw', async () => {
		const h = makeAuth();
		// An untyped caller (plumbing: JSON.parse returns an unchecked value, as the wire does).
		const input: AuthActionInput = JSON.parse('{"action":"launchMissiles"}');
		const s = await rpc(new Browser(), h.auth.createApi(), (a) => a.setAuthState(input));
		assert.strictEqual(s.state, 'signedOut');
		assert.strictEqual(s.error, 'Unknown action: launchMissiles');
	});

	test('auto sign-in through the UI: signUp → confirmSignUp → autoSignIn action → signedIn', async () => {
		const h = makeAuth();
		const api = h.auth.createApi();
		const b = new Browser();
		const s1 = await rpc(b, api, (a) =>
			a.setAuthState({ action: 'signUp', username: 'newbie', password: 'Passw0rd!', email: 'n@example.com' }),
		);
		assert.deepStrictEqual(s1, confirmingSignUp('newbie'));
		const s2 = await rpc(b, api, (a) =>
			a.setAuthState({ action: 'confirmSignUp', username: 'newbie', code: '123456' }),
		);
		assert.deepStrictEqual(s2, autoSignInPending('newbie'));
		const s3 = await rpc(b, api, (a) => a.setAuthState({ action: 'autoSignIn', username: 'newbie' }));
		assert.strictEqual(s3.state, 'signedIn');
	});
});

describe('emailPassword.revealExistingUsers (R9)', () => {
	test('default false: signing up an existing account answers exactly like a new one', async () => {
		const h = makeAuth();
		h.native.addUser('alice');
		const api = h.auth.createApi();
		const existing = await rpc(new Browser(), api, (a) =>
			a.setAuthState({ action: 'signUp', username: 'alice', password: 'Passw0rd!', email: 'a@example.com' }),
		);
		const fresh = await rpc(new Browser(), api, (a) =>
			a.setAuthState({ action: 'signUp', username: 'alice2', password: 'Passw0rd!', email: 'a2@example.com' }),
		);
		assert.deepStrictEqual(existing, confirmingSignUp('alice'));
		assert.deepStrictEqual(fresh, confirmingSignUp('alice2'));
		assert.strictEqual(existing.errorName, undefined);
	});

	test('true: an existing account is reported as UsernameExistsException', async () => {
		const h = makeAuth({ emailPassword: { revealExistingUsers: true } });
		h.native.addUser('alice');
		const s = await rpc(new Browser(), h.auth.createApi(), (a) =>
			a.setAuthState({ action: 'signUp', username: 'alice', password: 'Passw0rd!', email: 'a@example.com' }),
		);
		assert.strictEqual(s.state, 'signedOut');
		assert.strictEqual(s.errorName, AuthErrors.UserAlreadyExists);
	});

	test('the imperative signUp() always throws UsernameExistsException (trust boundary)', async () => {
		const h = makeAuth();
		h.native.addUser('alice');
		await assert.rejects(h.auth.signUp('alice', 'Passw0rd!'), { name: AuthErrors.UserAlreadyExists, status: 409 });
	});

	test('other sign-up failures (a weak password) are still surfaced', async () => {
		const h = makeAuth();
		h.native.signUp = async () => {
			throw sdkError('InvalidPasswordException', 'Password did not conform with policy');
		};
		const s = await rpc(new Browser(), h.auth.createApi(), (a) =>
			a.setAuthState({ action: 'signUp', username: 'x', password: 'weak' }),
		);
		assert.strictEqual(s.errorName, AuthErrors.InvalidPassword);
		assert.strictEqual(s.retriable, true);
	});
});

describe('signedOut shapes', () => {
	test('zero-config: AuthCognito’s exact actions and fields', () => {
		assert.deepStrictEqual(signedOut({ passwordEnabled: true, selfSignUp: true }), {
			state: 'signedOut',
			actions: [
				{
					name: 'signIn',
					label: 'Sign In',
					fields: [
						{ name: 'username', label: 'Username', type: 'text', required: true },
						{ name: 'password', label: 'Password', type: 'password', required: true },
					],
				},
				{
					name: 'signUp',
					label: 'Create Account',
					fields: [
						{ name: 'username', label: 'Username', type: 'text', required: true },
						{ name: 'password', label: 'Password', type: 'password', required: true },
						{ name: 'email', label: 'Email', type: 'email', required: true },
					],
				},
				{
					name: 'resetPassword',
					label: 'Forgot Password',
					fields: [{ name: 'username', label: 'Username', type: 'text', required: true }],
				},
			],
		});
	});

	test('federated providers are url-bearing GET actions named signIn:<id>, after the password actions', async () => {
		const h = makeAuth({
			socialProviders: { google: { clientId: 'g', clientSecret: secret } },
			oidcProviders: { 'my okta': { issuer: 'https://okta.example.com', clientId: 'c', label: 'Okta SSO' } },
		});
		const s = await rpc(new Browser(), h.auth.createApi(), (a) => a.getAuthState());
		assert.deepStrictEqual(names(s), ['signIn', 'signUp', 'resetPassword', 'signIn:google', 'signIn:my okta']);
		assert.deepStrictEqual(s.actions.slice(3), [
			{
				name: 'signIn:google',
				label: 'Sign in with Google',
				fields: [],
				url: '/aws-blocks/auth/signin/google',
				method: 'GET',
			},
			{
				name: 'signIn:my okta',
				label: 'Okta SSO',
				fields: [],
				url: '/aws-blocks/auth/signin/my%20okta',
				method: 'GET',
			},
		]);
	});

	test('emailPassword: false → only the provider actions', async () => {
		const h = makeAuth({
			emailPassword: false,
			oidcProviders: { okta: { issuer: 'https://okta.example.com', clientId: 'c' } },
		});
		const s = await rpc(new Browser(), h.auth.createApi(), (a) => a.getAuthState());
		assert.deepStrictEqual(names(s), ['signIn:okta']);
	});

	test('selfSignUp: false drops signUp; passkeys add signInWithPasskey; signInWith email-only makes username an email', () => {
		const s = signedOut({ passwordEnabled: true, selfSignUp: false, passkeys: true, signInWith: ['email'] });
		assert.deepStrictEqual(names(s), ['signIn', 'signInWithPasskey', 'resetPassword']);
		assert.deepStrictEqual(s.actions[0]?.fields[0], {
			name: 'username',
			label: 'Email',
			type: 'email',
			required: true,
		});
	});

	test('required custom attributes are collected on sign-up', () => {
		const s = signedOut({
			passwordEnabled: true,
			selfSignUp: true,
			requiredAttributes: [{ name: 'department' }, { name: 'age', type: 'Number' }],
		});
		const signUp = s.actions.find((a) => a.name === 'signUp');
		assert.deepStrictEqual(
			signUp?.fields.slice(3).map((f) => [f.name, f.label, f.type]),
			[
				['department', 'Department', 'text'],
				['age', 'Age', 'number'],
			],
		);
	});

	test('a federated signed-in session gets a url-bearing POST signOut (design 04 §4.5)', () => {
		const user = { userId: 'u', username: 'u' };
		assert.deepStrictEqual(signedIn(user, { federatedSignOutUrl: '/aws-blocks/auth/signout' }).actions, [
			{ name: 'signOut', label: 'Sign Out', fields: [], url: '/aws-blocks/auth/signout', method: 'POST' },
		]);
		assert.deepStrictEqual(names(signedIn(user, { passkeys: true })), [
			'signOut',
			'startPasskeyRegistration',
			'listPasskeys',
		]);
	});
});

describe('public names: data-testid contract and log redaction', () => {
	const user = { userId: 'u', username: 'u' };
	const steps: SignInNextStep[] = [
		{ name: 'CONFIRM_SIGN_IN_WITH_SMS_CODE', session: 'S', codeDeliveryDetails: delivery },
		{ name: 'CONFIRM_SIGN_IN_WITH_TOTP_CODE', session: 'S' },
		{ name: 'CONFIRM_SIGN_IN_WITH_EMAIL_CODE', session: 'S', codeDeliveryDetails: delivery },
		{ name: 'CONTINUE_SIGN_IN_WITH_MFA_SELECTION', session: 'S', allowedMFATypes: ['SMS', 'TOTP'] },
		{ name: 'CONTINUE_SIGN_IN_WITH_MFA_SETUP_SELECTION', session: 'S', allowedMFATypes: ['TOTP'] },
		{ name: 'CONTINUE_SIGN_IN_WITH_TOTP_SETUP', session: 'S', sharedSecret: 'SECRETSECRET' },
		{ name: 'CONTINUE_SIGN_IN_WITH_EMAIL_SETUP', session: 'S' },
		{ name: 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED', session: 'S' },
		{
			name: 'CONTINUE_SIGN_IN_WITH_FIRST_FACTOR_SELECTION',
			session: 'S',
			availableChallenges: ['PASSWORD', 'EMAIL_OTP'],
		},
		{ name: 'CONFIRM_SIGN_IN_WITH_PASSWORD', session: 'S' },
		{ name: 'CONFIRM_SIGN_IN_WITH_FIRST_FACTOR_EMAIL_OTP', session: 'S', codeDeliveryDetails: delivery },
		{ name: 'CONFIRM_SIGN_IN_WITH_FIRST_FACTOR_SMS_OTP', session: 'S', codeDeliveryDetails: delivery },
		{ name: 'CONFIRM_SIGN_IN_WITH_WEB_AUTHN', session: 'S', credentialRequestOptions: '{"challenge":"c"}' },
		{ name: 'RESET_PASSWORD' },
		{ name: 'CONFIRM_SIGN_UP' },
	];
	const allStates: AuthState[] = [
		signedOut({
			passwordEnabled: true,
			selfSignUp: true,
			passkeys: true,
			signInWith: ['username', 'email', 'phone'],
		}),
		confirmingSignUp('u'),
		autoSignInPending('u'),
		...steps.map((s) => confirmingSignIn(s)),
		signedIn(user, { passkeys: true }),
		registeringPasskey(user, '{"challenge":"c"}'),
		managingPasskeys(user, [{ credentialId: 'cred-123456789', friendlyName: 'Laptop' }]),
		confirmingPasswordReset('u'),
	];

	test('action and field names are exactly AuthCognito’s (no rename)', () => {
		const actions = new Set(allStates.flatMap((s) => s.actions.map((a) => a.name)));
		const fields = new Set(allStates.flatMap((s) => s.actions.flatMap((a) => a.fields.map((f) => f.name))));
		assert.deepStrictEqual([...actions].sort(), [
			'autoSignIn',
			'completePasskeyRegistration',
			'confirmResetPassword',
			'confirmSignIn',
			'confirmSignUp',
			'deletePasskey',
			'listPasskeys',
			'resendSignUpCode',
			'resetPassword',
			'signIn',
			'signInWithPasskey',
			'signOut',
			'signUp',
			'startPasskeyRegistration',
		]);
		assert.deepStrictEqual([...fields].sort(), [
			'challenge',
			'code',
			'credential',
			'credentialCreationOptions',
			'credentialId',
			'credentialRequestOptions',
			'email',
			'firstFactor',
			'mfaType',
			'newPassword',
			'password',
			'phone_number',
			'session',
			'sharedSecret',
			'username',
		]);
	});

	test('core/src/redact.ts masks every secret-bearing field this state machine emits', async () => {
		const redactUrl = new URL('./redact.js', import.meta.resolve('@aws-blocks/core'));
		const { redactForLogging }: { redactForLogging: (v: unknown) => unknown } = await import(redactUrl.href);
		const secretFields = ['password', 'newPassword', 'session', 'sharedSecret', 'credential', 'code'];
		const states = allStates.map((s) => JSON.stringify(redactForLogging(s)));
		const joined = states.join('\n');
		assert.ok(!joined.includes('"defaultValue":"S"'), 'challenge session redacted');
		assert.ok(!joined.includes('SECRETSECRET'), 'TOTP shared secret redacted');
		for (const field of secretFields) {
			const payload = JSON.stringify(redactForLogging({ action: 'x', [field]: 'TOPSECRET' }));
			assert.ok(!payload.includes('TOPSECRET'), `setAuthState payload field '${field}' redacted`);
		}
	});
});
