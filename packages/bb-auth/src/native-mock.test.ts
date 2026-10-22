// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The local (mock) user-pool engine, through the real default entry's `Auth`:
 * sign-up / sign-in and challenges, enumeration safety on every public flow,
 * MFA / TOTP, devices, user attributes, `deleteUser`, passkeys, the admin
 * surface, refresh and revocation, `.bb-data` persistence, tolerant loading,
 * and `AuthCognito` state-file compatibility (both directions).
 */

import assert from 'node:assert';
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, type TestContext, test } from 'node:test';
import type { AuthActionInput, AuthStateApi } from '@aws-blocks/auth-common';
import type { BlocksContext } from '@aws-blocks/core';
import { ApiError, isBlocksError } from '@aws-blocks/core';
import { AuthErrors } from './errors.js';
import { Auth } from './index.mock.js';
import { Browser, captureLogger, makeContext } from './test-helpers.js';
import {
	authCognitoMockAcceptsPasswordSignIn,
	mockStateCapture,
	restoreMockFiles,
} from './test-support/legacy-fixtures.js';
import type { CodeDeliveryPurpose } from './types.js';

beforeEach(() => rmSync('.bb-data', { recursive: true, force: true }));
afterEach(() => rmSync('.bb-data', { recursive: true, force: true }));

const PASSWORD = 'Passw0rd!';
let counter = 0;
const root = () => ({ id: `nm${process.pid}x${++counter}` });

/** Captures every code the mock "sends" (the `codeDelivery` hook). */
function codeSink() {
	const sent: { username: string; code: string; purpose: CodeDeliveryPurpose }[] = [];
	return {
		sent,
		deliver: async (username: string, code: string, purpose: CodeDeliveryPurpose) => {
			sent.push({ username, code, purpose });
		},
		last(purpose?: CodeDeliveryPurpose): string {
			const match = [...sent].reverse().find((s) => purpose === undefined || s.purpose === purpose);
			assert.ok(match, `a ${purpose ?? ''} code was delivered`);
			return match.code;
		},
	};
}

/** Call a method by name, as an untyped JavaScript caller would (runtime backstops). */
function callUntyped(target: object, method: string, ...args: unknown[]): Promise<unknown> {
	const fn: unknown = Reflect.get(target, method);
	assert.ok(typeof fn === 'function', `${method} exists`);
	return Promise.resolve(Reflect.apply(fn, target, args));
}

/** Call the RPC namespace the way the RPC layer does. */
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

/** What a client can observe of a rejection. */
async function observe(p: Promise<unknown>): Promise<Record<string, unknown>> {
	try {
		await p;
	} catch (e) {
		assert.ok(e instanceof ApiError, `an ApiError, got ${String(e)}`);
		return { name: e.name, status: e.status, message: e.message, retriable: e.retriable };
	}
	assert.fail('expected a rejection');
}

/** Sign up + confirm `username` with the emailed code. */
async function register(
	auth: {
		signUp(username: string, password: string, options: { attributes: { email: string } }): Promise<unknown>;
		confirmSignUp(username: string, code: string): Promise<unknown>;
	},
	sink: ReturnType<typeof codeSink>,
	username: string,
	email = `${username}@example.com`,
) {
	await auth.signUp(username, PASSWORD, { attributes: { email } });
	await auth.confirmSignUp(username, sink.last('signUp'));
}

/**
 * Put an `AuthCognito` capture back (its `.bb-data` files and the browser's
 * cookies) and pin `Date` to the moment it was taken, so `Auth` meets the old
 * block's state exactly as a live upgrade would have — then return the app
 * scope, the browser and the user the old block had signed in.
 */
function restoreLegacy(t: TestContext, name: string) {
	const capture = mockStateCapture(name);
	restoreMockFiles(capture);
	t.mock.timers.enable({ apis: ['Date'], now: capture.capturedAt });
	const b = new Browser();
	for (const [cookie, value] of Object.entries(capture.cookies)) b.jar.set(cookie, value);
	const user = capture.results.user;
	assert.ok(user && typeof user === 'object' && 'userSub' in user && typeof user.userSub === 'string');
	return { r: { id: capture.rootId }, b, legacyUser: { userSub: user.userSub } };
}

function dataDir(auth: { fullId: string }): string {
	return join('.bb-data', auth.fullId);
}

// ─────────────────────────────────────────────────────────────────────────────

describe('mock engine — sign-up, sign-in, codes', () => {
	test('sign-up delivers a code (hook + last-code.json); confirm; sign in; requireAuth; sign out', async () => {
		const sink = codeSink();
		const auth = new Auth(root(), 'auth', { codeDelivery: sink.deliver });
		const r = await auth.signUp('alice', PASSWORD, { attributes: { email: 'alice@example.com' } });
		assert.strictEqual(r.isSignUpComplete, false);
		assert.deepStrictEqual(r.nextStep?.codeDeliveryDetails, {
			destination: 'a***@e***',
			deliveryMedium: 'EMAIL',
			attributeName: 'email',
		});
		const code = sink.last('signUp');
		assert.match(code, /^\d{6}$/);
		const lastCode = JSON.parse(readFileSync(join(dataDir(auth), 'last-code.json'), 'utf8'));
		assert.deepStrictEqual(lastCode, { username: 'alice', code, purpose: 'signUp' });

		// Not confirmed yet: the correct password says so (Cognito does too).
		const b = new Browser();
		assert.deepStrictEqual(
			(await observe(b.request((ctx) => auth.signIn('alice', PASSWORD, ctx)))).name,
			AuthErrors.UserNotConfirmed,
		);
		assert.deepStrictEqual(await auth.confirmSignUp('alice', code), {
			isSignUpComplete: true,
			nextStep: { signUpStep: 'DONE' },
		});
		const signedIn = await b.request((ctx) => auth.signIn('alice', PASSWORD, ctx));
		assert.strictEqual(signedIn.status, 'signedIn');
		const user = await b.request((ctx) => auth.requireAuth(ctx));
		assert.strictEqual(user.userId, 'alice');
		assert.strictEqual(user.userSub, r.userId);
		assert.strictEqual(user.signInProvider, 'password');
		assert.strictEqual(user.attributes.email, 'alice@example.com');
		// As on AWS, the verified flag is a boolean ID-token claim, not an attribute.
		assert.strictEqual(user.attributes.email_verified, undefined, 'no `*_verified` in requireAuth().attributes');
		const stored = await b.request((ctx) => auth.getUserAttributes(ctx));
		assert.strictEqual(stored.email_verified, 'true', 'the sign-up code verified the email');
		await b.request((ctx) => auth.signOut(ctx));
		assert.strictEqual(await b.request((ctx) => auth.getCurrentUser(ctx)), null);
	});

	test('without codeDelivery the code is logged at info level (and still in last-code.json)', async () => {
		const { logger, entries } = captureLogger();
		const auth = new Auth(root(), 'auth', { logger });
		await auth.signUp('bob', PASSWORD, { attributes: { email: 'bob@example.com' } });
		const lastCode = JSON.parse(readFileSync(join(dataDir(auth), 'last-code.json'), 'utf8'));
		assert.ok(entries.some((e) => e.level === 'info' && e.message.includes(lastCode.code)));
	});

	test('auto sign-in: confirm returns COMPLETE_AUTO_SIGN_IN and autoSignIn signs in without the password', async () => {
		const sink = codeSink();
		const auth = new Auth(root(), 'auth', { codeDelivery: sink.deliver });
		const b = new Browser();
		await b.request((ctx) => auth.signUp('carol', PASSWORD, { attributes: { email: 'c@example.com' } }, ctx));
		const confirmed = await b.request((ctx) => auth.confirmSignUp('carol', sink.last('signUp'), ctx));
		assert.strictEqual(confirmed.nextStep.signUpStep, 'COMPLETE_AUTO_SIGN_IN');
		const r = await b.request((ctx) => auth.autoSignIn(ctx));
		assert.strictEqual(r.status, 'signedIn');
	});

	test('USER_AUTH: the auto-sign-in bridge skips the one-time code, as Cognito does', async () => {
		const sink = codeSink();
		const auth = new Auth(root(), 'auth', { users: { authFlow: 'USER_AUTH' }, codeDelivery: sink.deliver });
		const b = new Browser();
		await b.request((ctx) => auth.signUp('dave', PASSWORD, { attributes: { email: 'd@example.com' } }, ctx));
		await b.request((ctx) => auth.confirmSignUp('dave', sink.last('signUp'), ctx));
		const before = sink.sent.length;
		const r = await b.request((ctx) => auth.autoSignIn(ctx));
		assert.strictEqual(r.status, 'signedIn');
		assert.strictEqual(sink.sent.length, before, 'no OTP was sent');
	});

	test('USER_AUTH: first-factor selection, then the password leg', async () => {
		const sink = codeSink();
		const auth = new Auth(root(), 'auth', { users: { authFlow: 'USER_AUTH' }, codeDelivery: sink.deliver });
		await register(auth, sink, 'erin');
		const b = new Browser();
		const first = await b.request((ctx) => auth.signIn('erin', '', ctx));
		assert.ok(first.status === 'continueSignIn');
		assert.strictEqual(first.nextStep.name, 'CONTINUE_SIGN_IN_WITH_FIRST_FACTOR_SELECTION');
		assert.ok('availableChallenges' in first.nextStep);
		assert.deepStrictEqual(first.nextStep.availableChallenges, ['PASSWORD', 'EMAIL_OTP']);
		const session = 'session' in first.nextStep ? first.nextStep.session : '';
		const pw = await b.request((ctx) => auth.confirmSignIn(session, 'PASSWORD', ctx));
		assert.ok(pw.status === 'continueSignIn' && pw.nextStep.name === 'CONFIRM_SIGN_IN_WITH_PASSWORD');
		const pwSession = 'session' in pw.nextStep ? pw.nextStep.session : '';
		const wrong = await observe(b.request((ctx) => auth.confirmSignIn(pwSession, 'nope', ctx)));
		assert.deepStrictEqual(wrong, {
			name: AuthErrors.NotAuthorized,
			status: 401,
			message: 'Incorrect username or password',
			retriable: false,
		});
		const done = await b.request((ctx) => auth.confirmSignIn(pwSession, PASSWORD, ctx));
		assert.strictEqual(done.status, 'signedIn');
	});

	test('USER_AUTH: email one-time code as the first factor', async () => {
		const sink = codeSink();
		const auth = new Auth(root(), 'auth', { users: { authFlow: 'USER_AUTH' }, codeDelivery: sink.deliver });
		await register(auth, sink, 'fay');
		const b = new Browser();
		const r = await b.request((ctx) => auth.signIn('fay', '', ctx, { preferredChallenge: 'EMAIL_OTP' }));
		assert.ok(r.status === 'continueSignIn' && r.nextStep.name === 'CONFIRM_SIGN_IN_WITH_FIRST_FACTOR_EMAIL_OTP');
		const session = 'session' in r.nextStep ? r.nextStep.session : '';
		const done = await b.request((ctx) => auth.confirmSignIn(session, sink.last('mfa'), ctx));
		assert.strictEqual(done.status, 'signedIn');
	});

	test('USER_AUTH: the pool-wide users.preferredChallenge requests that factor; the per-call hint wins (L22)', async () => {
		const sink = codeSink();
		const auth = new Auth(root(), 'auth', {
			users: { authFlow: 'USER_AUTH', preferredChallenge: 'EMAIL_OTP' },
			codeDelivery: sink.deliver,
		});
		await register(auth, sink, 'flo');
		const b = new Browser();
		const r = await b.request((ctx) => auth.signIn('flo', '', ctx));
		assert.ok(r.status === 'continueSignIn' && r.nextStep.name === 'CONFIRM_SIGN_IN_WITH_FIRST_FACTOR_EMAIL_OTP');
		const session = 'session' in r.nextStep ? r.nextStep.session : '';
		assert.strictEqual(
			(await b.request((ctx) => auth.confirmSignIn(session, sink.last('mfa'), ctx))).status,
			'signedIn',
		);
		const override = await new Browser().request((ctx) =>
			auth.signIn('flo', '', ctx, { preferredChallenge: 'PASSWORD' }),
		);
		assert.ok(override.status === 'continueSignIn' && override.nextStep.name === 'CONFIRM_SIGN_IN_WITH_PASSWORD');
	});

	test('USER_PASSWORD_AUTH ignores users.preferredChallenge (L22)', async () => {
		const sink = codeSink();
		const auth = new Auth(root(), 'auth', {
			users: { preferredChallenge: 'EMAIL_OTP' },
			codeDelivery: sink.deliver,
		});
		await register(auth, sink, 'gil');
		assert.strictEqual(
			(await new Browser().request((ctx) => auth.signIn('gil', PASSWORD, ctx))).status,
			'signedIn',
		);
	});

	test('password policy and self sign-up off are enforced like Cognito', async () => {
		const auth = new Auth(root(), 'auth', { emailPassword: { passwordPolicy: { minLength: 12 } } });
		const weak = await observe(auth.signUp('gus', 'Short1!'));
		assert.strictEqual(weak.name, AuthErrors.InvalidPassword);
		assert.strictEqual(weak.status, 400);
		assert.strictEqual(weak.retriable, true);
		const closed = new Auth(root(), 'auth', { emailPassword: { selfSignUp: false } });
		assert.strictEqual((await observe(closed.signUp('gus', PASSWORD))).name, AuthErrors.NotAuthorized);
	});

	test('password reset with the emailed code, then sign in with the new password', async () => {
		const sink = codeSink();
		const auth = new Auth(root(), 'auth', { codeDelivery: sink.deliver });
		await register(auth, sink, 'hal');
		const r = await auth.resetPassword('hal');
		assert.strictEqual(r.nextStep?.codeDeliveryDetails.destination, 'h***@e***');
		await auth.confirmResetPassword('hal', sink.last('resetPassword'), 'NewPassw0rd!');
		const b = new Browser();
		assert.strictEqual((await b.request((ctx) => auth.signIn('hal', 'NewPassw0rd!', ctx))).status, 'signedIn');
		await b.request((ctx) => auth.updatePassword(ctx, 'NewPassw0rd!', 'Newer-Passw0rd'));
		assert.strictEqual((await b.request((ctx) => auth.signIn('hal', 'Newer-Passw0rd', ctx))).status, 'signedIn');
	});
});

// ─────────────────────────────────────────────────────────────────────────────

describe('mock engine — enumeration safety on the public flows', () => {
	test('sign-in: unknown user, wrong password and disabled user are byte-identical', async () => {
		const sink = codeSink();
		const auth = new Auth(root(), 'auth', { admin: {}, codeDelivery: sink.deliver });
		await register(auth, sink, 'ivy');
		await register(auth, sink, 'jon');
		await auth.admin.disableUser('jon');
		const b = new Browser();
		const unknown = await observe(b.request((ctx) => auth.signIn('nobody', PASSWORD, ctx)));
		const wrong = await observe(b.request((ctx) => auth.signIn('ivy', 'wrong', ctx)));
		const disabled = await observe(b.request((ctx) => auth.signIn('jon', PASSWORD, ctx)));
		const expected = {
			name: AuthErrors.NotAuthorized,
			status: 401,
			message: 'Incorrect username or password',
			retriable: false,
		};
		assert.deepStrictEqual([unknown, wrong, disabled], [expected, expected, expected]);
	});

	test('confirm-code flows answer an unknown user exactly like a wrong code', async () => {
		const sink = codeSink();
		const auth = new Auth(root(), 'auth', { codeDelivery: sink.deliver });
		await auth.signUp('kim', PASSWORD, { attributes: { email: 'kim@example.com' } });
		const wrongSignUp = await observe(auth.confirmSignUp('kim', '000000'));
		const unknownSignUp = await observe(auth.confirmSignUp('nobody', '000000'));
		assert.deepStrictEqual(unknownSignUp, wrongSignUp);
		assert.strictEqual(wrongSignUp.name, AuthErrors.CodeMismatch);
		await auth.confirmSignUp('kim', sink.last('signUp'));
		await auth.resetPassword('kim');
		const wrongReset = await observe(auth.confirmResetPassword('kim', '000000', 'NewPassw0rd!'));
		const unknownReset = await observe(auth.confirmResetPassword('nobody', '000000', 'NewPassw0rd!'));
		assert.deepStrictEqual(unknownReset, wrongReset);
	});

	test('password reset and resend succeed for an unknown user, with plausible delivery details', async () => {
		const sink = codeSink();
		const auth = new Auth(root(), 'auth', { codeDelivery: sink.deliver });
		const r = await auth.resetPassword('ghost@example.com');
		assert.deepStrictEqual(r.nextStep?.codeDeliveryDetails, {
			destination: 'g***@e***',
			deliveryMedium: 'EMAIL',
			attributeName: 'email',
		});
		const opaque = await auth.resetPassword('ghost');
		assert.match(opaque.nextStep?.codeDeliveryDetails.destination ?? '', /^[a-z]\*\*\*@[a-z]\*\*\*$/);
		assert.deepStrictEqual(await auth.resetPassword('ghost'), opaque, 'stable across requests');
		await auth.resendSignUpCode('ghost');
		assert.deepStrictEqual(sink.sent, [], 'nothing was sent');
	});

	test('the public sign-up form answers an existing account like a new one', async () => {
		const sink = codeSink();
		const auth = new Auth(root(), 'auth', { codeDelivery: sink.deliver });
		await register(auth, sink, 'lee');
		const api = auth.createApi();
		const b = new Browser();
		const state = await b.request((ctx) =>
			bind(api, ctx).setAuthState({
				action: 'signUp',
				username: 'lee',
				password: PASSWORD,
				email: 'x@example.com',
			}),
		);
		assert.strictEqual(state.state, 'confirmingSignUp');
		assert.strictEqual(state.error, undefined);
		// Server-side code is inside the trust boundary and is told.
		assert.strictEqual((await observe(auth.signUp('lee', PASSWORD))).name, AuthErrors.UserAlreadyExists);
	});

	test('UserNotFoundException appears only inside auth.admin', async () => {
		const sink = codeSink();
		const auth = new Auth(root(), 'auth', { admin: {}, users: { groups: ['admins'] }, codeDelivery: sink.deliver });
		const b = new Browser();
		const publicNames = [
			await observe(b.request((ctx) => auth.signIn('nobody', PASSWORD, ctx))),
			await observe(auth.confirmSignUp('nobody', '123456')),
			await observe(auth.confirmResetPassword('nobody', '123456', 'NewPassw0rd!')),
		].map((o) => o.name);
		assert.ok(!publicNames.includes(AuthErrors.UserNotFound), publicNames.join(', '));

		assert.strictEqual(await auth.admin.getUser('nobody'), null, 'admin.getUser: null, not a throw');
		const adminMiss = await observe(auth.admin.deleteUser('nobody'));
		assert.deepStrictEqual([adminMiss.name, adminMiss.status], [AuthErrors.UserNotFound, 404]);
		const groupMiss = await observe(auth.admin.addUserToGroup('nobody', 'admins'));
		assert.strictEqual(groupMiss.name, AuthErrors.UserNotFound);
	});

	test('an account call for a user deleted out from under the session signs out (401), never 404', async () => {
		const sink = codeSink();
		const auth = new Auth(root(), 'auth', { admin: {}, codeDelivery: sink.deliver });
		await register(auth, sink, 'max');
		const b = new Browser();
		await b.request((ctx) => auth.signIn('max', PASSWORD, ctx));
		await auth.admin.deleteUser('max');
		const r = await observe(b.request((ctx) => auth.getUserAttributes(ctx)));
		assert.deepStrictEqual([r.name, r.status], [AuthErrors.NotAuthenticated, 401]);
		assert.ok(!b.jar.has(`auth_${auth.fullId}`), 'the cookie was cleared');
	});
});

// ─────────────────────────────────────────────────────────────────────────────

describe('mock engine — MFA', () => {
	test('TOTP: setUpTotp + verifyTotpSetup enrol it; the next sign-in is challenged', async () => {
		const sink = codeSink();
		const auth = new Auth(root(), 'auth', { mfa: 'optional', codeDelivery: sink.deliver });
		await register(auth, sink, 'nia');
		const b = new Browser();
		assert.strictEqual((await b.request((ctx) => auth.signIn('nia', PASSWORD, ctx))).status, 'signedIn');
		const { sharedSecret } = await b.request((ctx) => auth.setUpTotp(ctx));
		assert.match(sharedSecret, /^[A-Z2-7]{32}$/);
		const bad = await observe(b.request((ctx) => auth.verifyTotpSetup(ctx, 'abc')));
		assert.deepStrictEqual([bad.name, bad.retriable], [AuthErrors.EnableSoftwareTokenMFA, true]);
		await b.request((ctx) => auth.verifyTotpSetup(ctx, '123456'));
		assert.deepStrictEqual(await b.request((ctx) => auth.getMfaPreference(ctx)), {
			enabled: ['TOTP'],
			preferred: 'TOTP',
		});

		const b2 = new Browser();
		const r = await b2.request((ctx) => auth.signIn('nia', PASSWORD, ctx));
		assert.ok(r.status === 'continueSignIn' && r.nextStep.name === 'CONFIRM_SIGN_IN_WITH_TOTP_CODE');
		const session = 'session' in r.nextStep ? r.nextStep.session : '';
		const wrong = await observe(b2.request((ctx) => auth.confirmSignIn(session, 'x', ctx)));
		assert.deepStrictEqual([wrong.name, wrong.retriable], [AuthErrors.CodeMismatch, true]);
		assert.strictEqual((await b2.request((ctx) => auth.confirmSignIn(session, '654321', ctx))).status, 'signedIn');
	});

	test('required MFA with nothing enrolled routes into TOTP setup mid-sign-in', async () => {
		const sink = codeSink();
		const auth = new Auth(root(), 'auth', {
			mfa: { mode: 'required', types: ['TOTP'] },
			codeDelivery: sink.deliver,
		});
		await register(auth, sink, 'oli');
		const b = new Browser();
		const r = await b.request((ctx) => auth.signIn('oli', PASSWORD, ctx));
		assert.ok(r.status === 'continueSignIn' && r.nextStep.name === 'CONTINUE_SIGN_IN_WITH_TOTP_SETUP');
		assert.ok('sharedSecret' in r.nextStep && r.nextStep.sharedSecret.length > 0);
		const done = await b.request((ctx) =>
			auth.confirmSignIn(
				r.nextStep.name === 'CONTINUE_SIGN_IN_WITH_TOTP_SETUP' ? r.nextStep.session : '',
				'111111',
				ctx,
			),
		);
		assert.strictEqual(done.status, 'signedIn');
		assert.deepStrictEqual((await b.request((ctx) => auth.getMfaPreference(ctx))).preferred, 'TOTP');
	});

	test('EMAIL MFA: a verified email is an enrolled factor; the code arrives through codeDelivery', async () => {
		const sink = codeSink();
		const auth = new Auth(root(), 'auth', {
			mfa: { mode: 'optional', types: ['EMAIL'] },
			codeDelivery: sink.deliver,
		});
		await register(auth, sink, 'pam');
		const b = new Browser();
		const r = await b.request((ctx) => auth.signIn('pam', PASSWORD, ctx));
		assert.ok(r.status === 'continueSignIn' && r.nextStep.name === 'CONFIRM_SIGN_IN_WITH_EMAIL_CODE');
		const session = r.nextStep.session;
		assert.strictEqual(
			(await b.request((ctx) => auth.confirmSignIn(session, sink.last('mfa'), ctx))).status,
			'signedIn',
		);
	});

	test('updateMfaPreference validates like Cognito; the gate has a runtime backstop', async () => {
		const sink = codeSink();
		const auth = new Auth(root(), 'auth', { mfa: 'optional', codeDelivery: sink.deliver });
		await register(auth, sink, 'quin');
		const b = new Browser();
		await b.request((ctx) => auth.signIn('quin', PASSWORD, ctx));
		const twoPreferred = await observe(
			b.request((ctx) => auth.updateMfaPreference(ctx, { sms: 'PREFERRED', totp: 'PREFERRED' })),
		);
		assert.strictEqual(twoPreferred.name, AuthErrors.InvalidParameter);
		const unconfigured = await observe(b.request((ctx) => auth.updateMfaPreference(ctx, { email: 'ENABLED' })));
		assert.match(String(unconfigured.message), /not configured/);
		const noTotp = await observe(b.request((ctx) => auth.updateMfaPreference(ctx, { totp: 'ENABLED' })));
		assert.strictEqual(noTotp.name, AuthErrors.SoftwareTokenMFANotFound);
		await b.request((ctx) => auth.updateMfaPreference(ctx, { sms: 'DISABLED' }));
		assert.deepStrictEqual(await b.request((ctx) => auth.getMfaPreference(ctx)), {
			enabled: [],
			preferred: 'NOMFA',
		});

		const off = new Auth(root(), 'auth');
		const backstop = await observe(b.request((ctx) => callUntyped(off, 'setUpTotp', ctx)));
		assert.deepStrictEqual([backstop.name, backstop.status], [AuthErrors.InvalidParameter, 400]);
	});
});

// ─────────────────────────────────────────────────────────────────────────────

describe('mock engine — devices, attributes, deleteUser', () => {
	test('devices: remember, scan, forget', async () => {
		const sink = codeSink();
		const auth = new Auth(root(), 'auth', { codeDelivery: sink.deliver });
		await register(auth, sink, 'rae');
		const b = new Browser();
		await b.request((ctx) => auth.signIn('rae', PASSWORD, ctx));
		await b.request((ctx) => auth.rememberDevice(ctx));
		const devices = await b.request((ctx) => Array.fromAsync(auth.scanDevices(ctx)));
		assert.strictEqual(devices.length, 1);
		assert.ok(devices[0].deviceKey && devices[0].createDate);
		await b.request((ctx) => auth.forgetDevice(ctx, devices[0].deviceKey));
		assert.deepStrictEqual(await b.request((ctx) => Array.fromAsync(auth.scanDevices(ctx))), []);
	});

	test('attributes: live reads, custom prefixing, contact changes need a code', async () => {
		const sink = codeSink();
		const auth = new Auth(root(), 'auth', {
			users: { attributes: [{ name: 'department' }] },
			codeDelivery: sink.deliver,
		});
		await register(auth, sink, 'sam');
		const b = new Browser();
		await b.request((ctx) => auth.signIn('sam', PASSWORD, ctx));
		const out = await b.request((ctx) =>
			auth.updateUserAttributes(ctx, { department: 'eng', email: 'sam@new.example.com' }),
		);
		assert.deepStrictEqual(out['custom:department'], { isUpdated: true });
		assert.deepStrictEqual(out.email, {
			isUpdated: false,
			nextStep: {
				name: 'CONFIRM_ATTRIBUTE_WITH_CODE',
				codeDeliveryDetails: { destination: 's***@n***', deliveryMedium: 'EMAIL', attributeName: 'email' },
			},
		});
		const attrs = await b.request((ctx) => auth.getUserAttributes(ctx));
		assert.strictEqual(attrs['custom:department'], 'eng');
		assert.strictEqual(attrs.email_verified, 'false');
		assert.ok(attrs.sub);
		const wrong = await observe(b.request((ctx) => auth.confirmUserAttribute(ctx, 'email', '000000')));
		assert.deepStrictEqual([wrong.name, wrong.retriable], [AuthErrors.CodeMismatch, true]);
		await b.request((ctx) => auth.sendUserAttributeVerificationCode(ctx, 'email'));
		await b.request((ctx) => auth.confirmUserAttribute(ctx, 'email', sink.last('attribute')));
		assert.strictEqual((await b.request((ctx) => auth.getUserAttributes(ctx))).email_verified, 'true');
		// The session snapshot is only as fresh as the last token issue; the live read is current.
		assert.strictEqual((await b.request((ctx) => auth.requireAuth(ctx))).attributes.email, 'sam@example.com');
	});

	test('deleteUser removes the account, the session and the cookie', async () => {
		const sink = codeSink();
		const auth = new Auth(root(), 'auth', { codeDelivery: sink.deliver });
		await register(auth, sink, 'tia');
		const b = new Browser();
		await b.request((ctx) => auth.signIn('tia', PASSWORD, ctx));
		await b.request((ctx) => auth.deleteUser(ctx));
		assert.ok(!b.jar.has(`auth_${auth.fullId}`));
		assert.strictEqual((await observe(b.request((ctx) => auth.requireAuth(ctx)))).status, 401);
		assert.strictEqual(
			(await observe(b.request((ctx) => auth.signIn('tia', PASSWORD, ctx)))).name,
			AuthErrors.NotAuthorized,
		);
	});
});

// ─────────────────────────────────────────────────────────────────────────────

describe('mock engine — passkeys', () => {
	test('register, list, sign in with a passkey (loose mock), delete', async () => {
		const sink = codeSink();
		const auth = new Auth(root(), 'auth', {
			users: { authFlow: 'USER_AUTH', signInWith: ['email'] },
			passkeys: { relyingPartyId: 'localhost', origins: ['http://localhost:3000'] },
			codeDelivery: sink.deliver,
		});
		await auth.signUp('uma@example.com', PASSWORD);
		await auth.confirmSignUp('uma@example.com', sink.last('signUp'));
		const b = new Browser();
		const first = await b.request((ctx) =>
			auth.signIn('uma@example.com', '', ctx, { preferredChallenge: 'PASSWORD' }),
		);
		assert.ok(first.status === 'continueSignIn' && first.nextStep.name === 'CONFIRM_SIGN_IN_WITH_PASSWORD');
		const pwSession = first.nextStep.session;
		await b.request((ctx) => auth.confirmSignIn(pwSession, PASSWORD, ctx));

		const start = await b.request((ctx) => auth.startPasskeyRegistration(ctx));
		assert.strictEqual(JSON.parse(start.credentialCreationOptions).rp.id, 'localhost');
		const bad = await observe(b.request((ctx) => auth.completePasskeyRegistration(ctx, 'not json')));
		assert.strictEqual(bad.name, AuthErrors.InvalidParameter);
		const done = await b.request((ctx) =>
			auth.completePasskeyRegistration(ctx, '{"id":"cred-1","type":"public-key"}'),
		);
		assert.deepStrictEqual(done, { credentialId: 'cred-1' });
		const keys = await b.request((ctx) => auth.listPasskeys(ctx));
		assert.strictEqual(keys.length, 1);
		assert.strictEqual(keys[0].credentialId, 'cred-1');
		assert.ok(keys[0].createdAt && !Number.isNaN(Date.parse(keys[0].createdAt)));

		// Sign in with the passkey through the RPC surface.
		const api = auth.createApi();
		const b2 = new Browser();
		const challenge = await b2.request((ctx) =>
			bind(api, ctx).setAuthState({ action: 'signInWithPasskey', username: 'uma@example.com' }),
		);
		assert.strictEqual(challenge.state, 'confirmingSignIn');
		const session = challenge.actions[0]?.fields.find((f) => f.name === 'session')?.defaultValue ?? '';
		const signedIn = await b2.request((ctx) =>
			bind(api, ctx).setAuthState({
				action: 'confirmSignIn',
				challenge: 'webauthn',
				session,
				credential: '{"id":"cred-1"}',
			}),
		);
		assert.strictEqual(signedIn.state, 'signedIn');

		await b.request((ctx) => auth.deletePasskey(ctx, 'cred-1'));
		assert.deepStrictEqual(await b.request((ctx) => auth.listPasskeys(ctx)), []);
	});

	test('registration records transports and authenticatorAttachment, as Cognito does (L22)', async () => {
		const sink = codeSink();
		const auth = new Auth(root(), 'auth', {
			users: { authFlow: 'USER_AUTH' },
			passkeys: { relyingPartyId: 'localhost', origins: ['http://localhost:3000'] },
			codeDelivery: sink.deliver,
		});
		await register(auth, sink, 'vic');
		const b = new Browser();
		const first = await b.request((ctx) => auth.signIn('vic', '', ctx, { preferredChallenge: 'PASSWORD' }));
		assert.ok(first.status === 'continueSignIn' && first.nextStep.name === 'CONFIRM_SIGN_IN_WITH_PASSWORD');
		const pwSession = first.nextStep.session;
		await b.request((ctx) => auth.confirmSignIn(pwSession, PASSWORD, ctx));
		const credential = JSON.stringify({
			id: 'cred-p',
			rawId: 'cred-p',
			type: 'public-key',
			authenticatorAttachment: 'platform',
			response: { clientDataJSON: 'x', attestationObject: 'y', transports: ['internal', 'hybrid', 7] },
		});
		await b.request((ctx) => auth.completePasskeyRegistration(ctx, credential));
		await b.request((ctx) => auth.completePasskeyRegistration(ctx, '{"id":"cred-q"}'));
		const keys = await b.request((ctx) => auth.listPasskeys(ctx));
		assert.deepStrictEqual(
			keys.map(({ createdAt: _c, ...rest }) => rest),
			[
				{ credentialId: 'cred-p', transports: ['internal', 'hybrid'], authenticatorAttachment: 'platform' },
				{ credentialId: 'cred-q' },
			],
		);
		// Persisted: a fresh instance over the same `.bb-data` reads them back.
		const again = new Auth({ id: auth.fullId.slice(0, -'-auth'.length) }, 'auth', {
			users: { authFlow: 'USER_AUTH' },
			passkeys: { relyingPartyId: 'localhost', origins: ['http://localhost:3000'] },
		});
		const reread = await b.request((ctx) => again.listPasskeys(ctx));
		assert.deepStrictEqual(reread[0].transports, ['internal', 'hybrid']);
		assert.strictEqual(reread[0].authenticatorAttachment, 'platform');
	});

	test('passkeys off: the runtime backstop is WebAuthnNotEnabledException', async () => {
		const auth = new Auth(root(), 'auth');
		const r = await observe(callUntyped(auth, 'listPasskeys', makeContext()));
		assert.strictEqual(r.name, AuthErrors.WebAuthnNotEnabled);
	});
});

// ─────────────────────────────────────────────────────────────────────────────

describe('mock engine — admin', () => {
	test('groups: membership changes apply to requireRole on the next request (live reads)', async () => {
		const sink = codeSink();
		const auth = new Auth(root(), 'auth', {
			users: { groups: ['admins', 'readers'] },
			admin: {},
			codeDelivery: sink.deliver,
		});
		await register(auth, sink, 'vic');
		const b = new Browser();
		await b.request((ctx) => auth.signIn('vic', PASSWORD, ctx));
		assert.strictEqual((await observe(b.request((ctx) => auth.requireRole(ctx, 'admins')))).status, 403);
		await auth.admin.addUserToGroup('vic', 'admins');
		assert.deepStrictEqual((await b.request((ctx) => auth.requireRole(ctx, 'admins'))).groups, ['admins']);
		assert.deepStrictEqual(await auth.admin.listGroupsForUser('vic'), ['admins']);
		assert.deepStrictEqual(
			(await auth.admin.listUsersInGroup('admins')).map((u) => u.username),
			['vic'],
		);
		await auth.admin.removeUserFromGroup('vic', 'admins');
		assert.strictEqual((await observe(b.request((ctx) => auth.requireRole(ctx, 'admins')))).status, 403);
		assert.strictEqual(
			(await observe(callUntyped(auth.admin, 'addUserToGroup', 'vic', 'nope'))).name,
			AuthErrors.GroupNotFound,
		);
	});

	test('lifecycle: createUser → NEW_PASSWORD_REQUIRED; disable/enable; setUserPassword; reset; getUser; scan', async () => {
		const auth = new Auth(root(), 'auth', { admin: {}, users: { groups: ['admins'] } });
		const created = await auth.admin.createUser('wes', {
			temporaryPassword: 'Temp-Passw0rd',
			attributes: { email: 'wes@example.com' },
		});
		assert.strictEqual(created.enabled, true);
		assert.strictEqual(created.attributes.email, 'wes@example.com');
		assert.strictEqual((await observe(auth.admin.createUser('wes'))).name, AuthErrors.UserAlreadyExists);

		const b = new Browser();
		const r = await b.request((ctx) => auth.signIn('wes', 'Temp-Passw0rd', ctx));
		assert.ok(r.status === 'continueSignIn' && r.nextStep.name === 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED');
		const session = r.nextStep.session;
		assert.strictEqual(
			(await b.request((ctx) => auth.confirmSignIn(session, 'Chosen-Passw0rd', ctx))).status,
			'signedIn',
		);

		await auth.admin.disableUser('wes');
		assert.strictEqual((await auth.admin.getUser('wes'))?.enabled, false);
		assert.strictEqual(
			(await observe(b.request((ctx) => auth.signIn('wes', 'Chosen-Passw0rd', ctx)))).name,
			AuthErrors.NotAuthorized,
		);
		await auth.admin.enableUser('wes');

		await auth.admin.setUserPassword('wes', 'Admin-Set-Passw0rd', { permanent: true });
		assert.strictEqual(
			(await b.request((ctx) => auth.signIn('wes', 'Admin-Set-Passw0rd', ctx))).status,
			'signedIn',
		);

		await auth.admin.resetUserPassword('wes');
		assert.strictEqual(
			(await observe(b.request((ctx) => auth.signIn('wes', 'Admin-Set-Passw0rd', ctx)))).name,
			AuthErrors.PasswordResetRequired,
		);

		await auth.admin.createUser('wanda', { attributes: { email: 'wanda@example.com' }, suppressInvite: true });
		await auth.admin.createUser('zed', { attributes: { email: 'zed@example.com' } });
		const ws = await Array.fromAsync(auth.admin.scan({ attribute: 'username', match: 'startsWith', value: 'wa' }));
		assert.deepStrictEqual(
			ws.map((u) => u.username),
			['wanda'],
		);
		const byEmail = await Array.fromAsync(
			auth.admin.scan({ attribute: 'email', match: 'equals', value: 'zed@example.com' }),
		);
		assert.deepStrictEqual(
			byEmail.map((u) => u.username),
			['zed'],
		);
		assert.strictEqual((await Array.fromAsync(auth.admin.scan())).length, 3);
	});

	test('revokeUserSessions signs the user out immediately, on every browser', async () => {
		const sink = codeSink();
		const auth = new Auth(root(), 'auth', { admin: {}, codeDelivery: sink.deliver });
		await register(auth, sink, 'xan');
		const b1 = new Browser();
		const b2 = new Browser();
		await b1.request((ctx) => auth.signIn('xan', PASSWORD, ctx));
		await b2.request((ctx) => auth.signIn('xan', PASSWORD, ctx));
		await auth.admin.revokeUserSessions('xan');
		assert.strictEqual(await b1.request((ctx) => auth.getCurrentUser(ctx)), null);
		assert.strictEqual(await b2.request((ctx) => auth.getCurrentUser(ctx)), null);
		const b3 = new Browser();
		assert.strictEqual((await b3.request((ctx) => auth.signIn('xan', PASSWORD, ctx))).status, 'signedIn');
	});

	test('admin is gated: not enabled throws; an ungranted action is a 403 before any change', async () => {
		const off = new Auth(root(), 'auth');
		assert.throws(() => Reflect.get(off, 'admin'), /admin not enabled/);
		const groupsOnly = new Auth(root(), 'auth', { admin: { actions: ['groups'] } });
		const r = await observe(callUntyped(groupsOnly.admin, 'createUser', 'yan'));
		assert.deepStrictEqual([r.name, r.status], [AuthErrors.NotAuthorized, 403]);
		assert.throws(
			() => callUntyped(groupsOnly.admin, 'scan'),
			(e: unknown) => isBlocksError(e, AuthErrors.NotAuthorized),
		);
	});
});

// ─────────────────────────────────────────────────────────────────────────────

describe('mock engine — refresh and revocation', () => {
	test('forceRefresh re-mints the tokens and keeps auth_time; a disabled user is signed out at refresh', async () => {
		const sink = codeSink();
		const auth = new Auth(root(), 'auth', { admin: {}, codeDelivery: sink.deliver });
		await register(auth, sink, 'yara');
		const b = new Browser();
		await b.request((ctx) => auth.signIn('yara', PASSWORD, ctx));
		const before = await b.request((ctx) => auth.getAuthSession(ctx));
		const after = await b.request((ctx) => auth.getAuthSession(ctx, { forceRefresh: true }));
		assert.ok(before.tokens && after.tokens);
		assert.notStrictEqual(after.tokens.accessToken.toString(), before.tokens.accessToken.toString());
		assert.strictEqual(after.tokens.idToken.payload.auth_time, before.tokens.idToken.payload.auth_time);
		await auth.admin.disableUser('yara');
		assert.deepStrictEqual(await b.request((ctx) => auth.getAuthSession(ctx, { forceRefresh: true })), {
			tokens: undefined,
		});
		assert.strictEqual(await b.request((ctx) => auth.getCurrentUser(ctx)), null);
	});

	test('signOut({ global: true }) revokes the other devices at their next refresh', async () => {
		const sink = codeSink();
		const auth = new Auth(root(), 'auth', { codeDelivery: sink.deliver });
		await register(auth, sink, 'zoe');
		const laptop = new Browser();
		const phone = new Browser();
		await laptop.request((ctx) => auth.signIn('zoe', PASSWORD, ctx));
		await phone.request((ctx) => auth.signIn('zoe', PASSWORD, ctx));
		await laptop.request((ctx) => auth.signOut(ctx, { global: true }));
		assert.deepStrictEqual(await phone.request((ctx) => auth.getAuthSession(ctx, { forceRefresh: true })), {
			tokens: undefined,
		});
		assert.strictEqual((await observe(phone.request((ctx) => auth.getUserAttributes(ctx)))).status, 401);
	});
});

// ─────────────────────────────────────────────────────────────────────────────

describe('mock engine — persistence, tolerant loading, AuthCognito compatibility', () => {
	test('a restarted dev server keeps users, groups and an in-flight MFA challenge', async () => {
		const sink = codeSink();
		const r = root();
		const auth = new Auth(r, 'auth', { mfa: { mode: 'optional', types: ['EMAIL'] }, codeDelivery: sink.deliver });
		await register(auth, sink, 'amy');
		const b = new Browser();
		const challenge = await b.request((ctx) => auth.signIn('amy', PASSWORD, ctx));
		assert.ok(
			challenge.status === 'continueSignIn' && challenge.nextStep.name === 'CONFIRM_SIGN_IN_WITH_EMAIL_CODE',
		);
		const session = challenge.nextStep.session;
		const code = sink.last('mfa');
		const restarted = new Auth(r, 'auth', { mfa: { mode: 'optional', types: ['EMAIL'] } });
		assert.strictEqual((await b.request((ctx) => restarted.confirmSignIn(session, code, ctx))).status, 'signedIn');
	});

	test('an unparseable state file is set aside (never deleted) and the pool starts empty, with a log line', async () => {
		const r = root();
		const dir = join('.bb-data', `${r.id}-auth`);
		new Auth(r, 'auth');
		writeFileSync(join(dir, 'state.json'), '{ not json');
		const { logger, entries } = captureLogger();
		const auth = new Auth(r, 'auth', { logger });
		assert.strictEqual(
			(await observe(new Browser().request((ctx) => auth.signIn('x', PASSWORD, ctx)))).status,
			401,
		);
		assert.ok(
			readdirSync(dir).some((f) => f.startsWith('state.json.corrupt-')),
			'the bad file was preserved',
		);
		assert.ok(entries.some((e) => e.level === 'warn' && /does not parse/.test(e.message)));
		await auth.signUp('fresh', PASSWORD, { attributes: { email: 'f@example.com' } });
	});

	test('a foreign state file (not an object) is set aside; malformed records are dropped; unknown keys kept', async () => {
		const r = root();
		const dir = join('.bb-data', `${r.id}-auth`);
		new Auth(r, 'auth');
		writeFileSync(join(dir, 'state.json'), '[1, 2, 3]');
		const { logger, entries } = captureLogger();
		new Auth(r, 'auth', { logger });
		assert.ok(entries.some((e) => /is not a JSON object/.test(e.message)));

		const good = {
			userSub: 'sub-good',
			password: PASSWORD,
			confirmed: true,
			disabled: false,
			attributes: { email: 'good@example.com' },
			mfaPreference: { enabled: [] },
			totpVerified: false,
			devices: {},
		};
		writeFileSync(
			join(dir, 'state.json'),
			JSON.stringify({
				users: { good, bad: { password: 'no sub' }, worse: 'nope' },
				groups: { admins: ['good'], broken: 'x' },
				codes: {},
				challenges: { t: { garbage: true } },
				sessionSecret: 'kept-secret',
				someoneElsesKey: { keep: 'me' },
			}),
		);
		const second = captureLogger();
		const auth = new Auth(r, 'auth', { logger: second.logger, admin: {} });
		assert.ok(
			second.entries.some((e) => /4 malformed record/.test(e.message)),
			JSON.stringify(second.entries),
		);
		assert.strictEqual(
			(await new Browser().request((ctx) => auth.signIn('good', PASSWORD, ctx))).status,
			'signedIn',
		);
		assert.deepStrictEqual(await auth.admin.listGroupsForUser('good'), ['admins']);
		const onDisk = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
		assert.deepStrictEqual(onDisk.someoneElsesKey, { keep: 'me' });
		assert.strictEqual(onDisk.sessionSecret, 'kept-secret');
		assert.ok(!existsSync(join(dir, 'state.json.tmp')));
	});

	test('AuthCognito → Auth (same id): local users, groups, MFA and the session survive the switch', async (t) => {
		// The AuthCognito side, frozen at the cutover (`legacy-mock-state.json`): what
		// `new AuthCognito(r, 'auth', { groups: ['admins'], mfa: 'optional', mfaTypes: ['TOTP'], admin: {} })`
		// left on disk and in the browser after alice signed up, was confirmed, joined
		// `admins`, signed in, set up + verified TOTP and remembered the device.
		const { r, b, legacyUser } = restoreLegacy(t, 'cognito-mfa-session');

		// The upgrade: same app, same id, `Auth` instead of `AuthCognito`.
		const auth = new Auth(r, 'auth', {
			users: { groups: ['admins'] },
			mfa: { mode: 'optional', types: ['TOTP'] },
			admin: {},
		});
		assert.strictEqual((await b.request((ctx) => auth.requireRole(ctx, 'admins'))).userSub, legacyUser.userSub);
		assert.deepStrictEqual(await b.request((ctx) => auth.getMfaPreference(ctx)), {
			enabled: ['TOTP'],
			preferred: 'TOTP',
		});
		assert.strictEqual((await b.request((ctx) => Array.fromAsync(auth.scanDevices(ctx)))).length, 1);
		const fresh = new Browser();
		const r2 = await fresh.request((ctx) => auth.signIn('alice', PASSWORD, ctx));
		assert.ok(r2.status === 'continueSignIn' && r2.nextStep.name === 'CONFIRM_SIGN_IN_WITH_TOTP_CODE');
		assert.strictEqual((await auth.admin.getUser('alice'))?.userSub, legacyUser.userSub);
	});

	test('email-only pool: a user AuthCognito keyed by email is kept as-is, still signs in, and is reported', async (t) => {
		// Frozen at the cutover: `new AuthCognito(r, 'auth', { signInWith: 'email' })` after
		// nora@example.com signed up, was confirmed and signed in (`legacy-mock-state.json`).
		const { r, b, legacyUser } = restoreLegacy(t, 'cognito-email-only-session');

		const { logger, entries } = captureLogger();
		const sink = codeSink();
		const auth = new Auth(r, 'auth', {
			users: { signInWith: ['email'] },
			admin: {},
			logger,
			codeDelivery: sink.deliver,
		});
		assert.ok(
			entries.some(
				(e) => e.level === 'warn' && /1 local user\(s\) .* predate generated usernames/.test(e.message),
			),
			'the legacy user is reported once',
		);
		// The signed-in session survives, and the user keeps their old username.
		const kept = await b.request((ctx) => auth.requireAuth(ctx));
		assert.strictEqual(kept.userSub, legacyUser.userSub);
		assert.strictEqual(kept.username, 'nora@example.com');
		// A fresh sign-in, the admin view, and the email's uniqueness all still hold.
		const again = await new Browser().request((ctx) => auth.signIn('nora@example.com', PASSWORD, ctx));
		assert.ok(again.status === 'signedIn' && again.user.userSub === legacyUser.userSub);
		assert.strictEqual((await auth.admin.getUser('nora@example.com'))?.username, 'nora@example.com');
		assert.strictEqual(
			(await observe(auth.signUp('nora@example.com', PASSWORD))).name,
			AuthErrors.UserAlreadyExists,
		);
		// Not migrated: the file still keys the user by email (AuthCognito can read it back).
		const onDisk = JSON.parse(readFileSync(join(dataDir(auth), 'state.json'), 'utf8'));
		assert.ok(Object.hasOwn(onDisk.users, 'nora@example.com'));
		// A user created now gets a generated username, as on AWS — and the code
		// is still delivered for the email they sign in with.
		const created = await auth.signUp('olga@example.com', PASSWORD);
		assert.strictEqual(sink.sent.at(-1)?.username, 'olga@example.com');
		await auth.confirmSignUp('olga@example.com', sink.last('signUp'));
		const olga = await new Browser().request((ctx) => auth.signIn('olga@example.com', PASSWORD, ctx));
		assert.ok(olga.status === 'signedIn');
		assert.strictEqual(olga.user.username, created.userId);
		assert.strictEqual(olga.user.userId, olga.user.userSub);
		assert.strictEqual(
			JSON.parse(readFileSync(join(dataDir(auth), 'last-code.json'), 'utf8')).username,
			'olga@example.com',
		);
	});

	test('email-only pool: generated-username users persist and sign in by email or by username after a reload', async () => {
		const r = root();
		const sink = codeSink();
		const auth = new Auth(r, 'auth', { users: { signInWith: ['email'] }, codeDelivery: sink.deliver });
		const { userId } = await auth.signUp('pia@example.com', PASSWORD);
		assert.ok(userId);
		await auth.confirmSignUp('pia@example.com', sink.last('signUp'));
		const { logger, entries } = captureLogger();
		const reloaded = new Auth(r, 'auth', { users: { signInWith: ['email'] }, logger });
		assert.ok(!entries.some((e) => /predate generated usernames/.test(e.message)), 'nothing legacy to report');
		for (const login of ['pia@example.com', userId]) {
			const result = await new Browser().request((ctx) => reloaded.signIn(login, PASSWORD, ctx));
			assert.ok(result.status === 'signedIn' && result.user.userSub === userId, `signs in with ${login}`);
		}
	});

	test('a username like __proto__ is an ordinary user (no prototype rewrite), also after a reload', async () => {
		const sink = codeSink();
		const r = root();
		const auth = new Auth(r, 'auth', { codeDelivery: sink.deliver });
		await register(auth, sink, '__proto__');
		const b = new Browser();
		assert.strictEqual((await b.request((ctx) => auth.signIn('__proto__', PASSWORD, ctx))).status, 'signedIn');
		const reloaded = new Auth(r, 'auth');
		assert.strictEqual((await b.request((ctx) => reloaded.signIn('__proto__', PASSWORD, ctx))).status, 'signedIn');
		assert.strictEqual(Object.getPrototypeOf(JSON.parse('{}')), Object.prototype);
	});

	test('AuthBasic → Auth (same id): the old session cookie signs out and is cleared; its files are left alone', async (t) => {
		// Frozen at the cutover: what AuthBasic (bb-auth-basic@0.1.9) left after alice signed up and in —
		// its users table, its JWT secret, and its JWT under the very cookie name `Auth` uses.
		const legacy = mockStateCapture('basic-session');
		restoreMockFiles(legacy);
		t.mock.timers.enable({ apis: ['Date'], now: legacy.capturedAt });
		const auth = new Auth({ id: legacy.rootId }, 'auth');
		const cookie = `auth_${auth.fullId}`;
		const b = new Browser();
		for (const [name, value] of Object.entries(legacy.cookies)) b.jar.set(name, value);
		assert.ok(b.jar.has(cookie), 'AuthBasic set auth_<fullId>');
		assert.strictEqual(await b.request((ctx) => auth.getCurrentUser(ctx)), null);
		assert.ok(!b.jar.has(cookie), 'the AuthBasic cookie was cleared');
		const replayed = makeContext(`${cookie}=${legacy.cookies[cookie]}`);
		await assert.rejects(auth.requireAuth(replayed), { name: AuthErrors.NotAuthenticated, status: 401 });
		// AuthBasic's users are not users of `Auth` (no migration path), and its files are untouched.
		assert.strictEqual(
			(await observe(new Browser().request((ctx) => auth.signIn('alice', PASSWORD, ctx)))).status,
			401,
		);
		for (const [rel, text] of Object.entries(legacy.files)) {
			assert.strictEqual(readFileSync(join('.bb-data', rel), 'utf8'), text, rel);
		}
	});

	test('Auth → AuthCognito (rollback): a user Auth created signs in with AuthCognito', async () => {
		const r = root();
		const sink = codeSink();
		const auth = new Auth(r, 'auth', { codeDelivery: sink.deliver });
		await register(auth, sink, 'bob');
		// AuthCognito's mock sign-in, frozen at the cutover (test-support/legacy-fixtures.ts).
		const stateFile = readFileSync(join(dataDir(auth), 'state.json'), 'utf8');
		assert.strictEqual(authCognitoMockAcceptsPasswordSignIn(stateFile, 'bob', PASSWORD), true);
		assert.strictEqual(
			authCognitoMockAcceptsPasswordSignIn(stateFile, 'bob', 'wrong'),
			false,
			'the check can fail',
		);
	});
});

describe('mock engine — the sign-up code verifies only the contact it was sent to (R67, FX34)', () => {
	const EMAIL = 'una@example.com';
	const PHONE = '+15555550100';

	/** Sign `username` up with an email and a phone and confirm it with the sign-up code. */
	async function registerWithPhone(
		auth: {
			signUp(
				username: string,
				password: string,
				options: { attributes: { email: string; phone_number: string } },
			): Promise<unknown>;
			confirmSignUp(username: string, code: string): Promise<unknown>;
		},
		sink: ReturnType<typeof codeSink>,
		username: string,
	) {
		await auth.signUp(username, PASSWORD, { attributes: { email: EMAIL, phone_number: PHONE } });
		await auth.confirmSignUp(username, sink.last('signUp'));
	}

	test('USER_AUTH: an unverified phone is no SMS_OTP first factor until it is verified', async () => {
		const sink = codeSink();
		const auth = new Auth(root(), 'auth', { users: { authFlow: 'USER_AUTH' }, codeDelivery: sink.deliver });
		await registerWithPhone(auth, sink, 'una');
		const offered = async () => {
			const r = await new Browser().request((ctx) => auth.signIn('una', '', ctx));
			assert.ok(r.status === 'continueSignIn' && 'availableChallenges' in r.nextStep);
			return r.nextStep.availableChallenges;
		};
		// The default pool auto-verifies the email only: the code went there.
		assert.deepStrictEqual(await offered(), ['PASSWORD', 'EMAIL_OTP']);

		const b = new Browser();
		const pw = await b.request((ctx) => auth.signIn('una', '', ctx, { preferredChallenge: 'PASSWORD' }));
		assert.ok(pw.status === 'continueSignIn' && pw.nextStep.name === 'CONFIRM_SIGN_IN_WITH_PASSWORD');
		const session = pw.nextStep.session;
		assert.strictEqual((await b.request((ctx) => auth.confirmSignIn(session, PASSWORD, ctx))).status, 'signedIn');
		await b.request((ctx) => auth.sendUserAttributeVerificationCode(ctx, 'phone_number'));
		await b.request((ctx) => auth.confirmUserAttribute(ctx, 'phone_number', sink.last('attribute')));
		assert.deepStrictEqual(await offered(), ['PASSWORD', 'EMAIL_OTP', 'SMS_OTP']);
	});

	test('MFA: an unverified phone is no SMS factor; verifying it enables SMS (and its challenge)', async () => {
		const sink = codeSink();
		const auth = new Auth(root(), 'auth', {
			mfa: { mode: 'optional', types: ['SMS', 'TOTP'] },
			codeDelivery: sink.deliver,
		});
		await registerWithPhone(auth, sink, 'una');
		const b = new Browser();
		assert.strictEqual((await b.request((ctx) => auth.signIn('una', PASSWORD, ctx))).status, 'signedIn');
		assert.deepStrictEqual(await b.request((ctx) => auth.getMfaPreference(ctx)), { enabled: [] });
		await b.request((ctx) => auth.sendUserAttributeVerificationCode(ctx, 'phone_number'));
		await b.request((ctx) => auth.confirmUserAttribute(ctx, 'phone_number', sink.last('attribute')));
		assert.deepStrictEqual(await b.request((ctx) => auth.getMfaPreference(ctx)), { enabled: ['SMS'] });
		const next = await new Browser().request((ctx) => auth.signIn('una', PASSWORD, ctx));
		assert.ok(next.status === 'continueSignIn' && next.nextStep.name === 'CONFIRM_SIGN_IN_WITH_SMS_CODE');
	});

	test('no auto-verified contact: the local pool still issues a code, and confirming it verifies nothing', async () => {
		// The default pool auto-verifies the email; this user has only a phone.
		// Cognito would send no code (DESIGN.md, "Mock vs AWS").
		const sink = codeSink();
		const auth = new Auth(root(), 'auth', { codeDelivery: sink.deliver });
		const signedUp = await auth.signUp('vic', PASSWORD, { attributes: { phone_number: PHONE } });
		assert.deepStrictEqual(signedUp.nextStep?.codeDeliveryDetails, {
			destination: '+*******0100',
			deliveryMedium: 'SMS',
			attributeName: 'phone_number',
		});
		await auth.confirmSignUp('vic', sink.last('signUp'));
		const b = new Browser();
		assert.strictEqual((await b.request((ctx) => auth.signIn('vic', PASSWORD, ctx))).status, 'signedIn');
		const attributes = await b.request((ctx) => auth.getUserAttributes(ctx));
		assert.strictEqual(attributes.phone_number_verified, 'false');
	});

	test('the new user’s contacts start unverified (`*_verified: false`), as Cognito stores them', async () => {
		const sink = codeSink();
		const auth = new Auth(root(), 'auth', { admin: {}, codeDelivery: sink.deliver });
		await auth.signUp('una', PASSWORD, { attributes: { email: EMAIL, phone_number: PHONE } });
		const pending = await auth.admin.getUser('una');
		assert.strictEqual(pending?.attributes.email_verified, 'false');
		assert.strictEqual(pending?.attributes.phone_number_verified, 'false');
		await auth.confirmSignUp('una', sink.last('signUp'));
		const confirmed = await auth.admin.getUser('una');
		assert.strictEqual(confirmed?.attributes.email_verified, 'true');
		assert.strictEqual(confirmed?.attributes.phone_number_verified, 'false');
	});
});
