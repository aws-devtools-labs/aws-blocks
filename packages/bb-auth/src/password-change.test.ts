// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * A changed password ends the user's other sessions, in both runtimes:
 *
 * - `updatePassword` rejects every other session of the user from its next
 *   request on, and re-issues the caller's session (a new session row and
 *   cookie, signed in with the new password), so the caller stays signed in.
 *   On AWS it also revokes the user's refresh tokens (`AdminUserGlobalSignOut`).
 *   When signing in again needs a step only the user can answer (MFA), the
 *   caller's session ends too; when it would send an SMS or email MFA code,
 *   no sign-in is attempted (no code is sent) and the session ends. A failed
 *   re-issue (sign-in, session write, cookie) ends the session too, and the
 *   call still resolves.
 * - `auth.admin.setUserPassword` ends every session of the user.
 */

import assert from 'node:assert';
import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { ApiError } from '@aws-blocks/core';
import { AuthErrors } from './errors.js';
import { Auth } from './index.mock.js';
import { Browser } from './test-helpers.js';
import {
	Browser as AwsBrowser,
	captureLogger,
	cognitoError,
	makeAwsAuth,
	signInAs,
	TEST_CLIENT_ID,
	TEST_POOL_ID,
	wireView,
} from './test-support/aws-harness.js';
import type { CodeDeliveryPurpose } from './types.js';

beforeEach(() => rmSync('.bb-data', { recursive: true, force: true }));
afterEach(() => rmSync('.bb-data', { recursive: true, force: true }));

const PASSWORD = 'Passw0rd!';
const NEW_PASSWORD = 'NewPassw0rd!';
let counter = 0;
const root = () => ({ id: `pc${process.pid}x${++counter}` });

function codeSink() {
	const sent: { code: string; purpose: CodeDeliveryPurpose }[] = [];
	return {
		deliver: async (_username: string, code: string, purpose: CodeDeliveryPurpose) => {
			sent.push({ code, purpose });
		},
		count(purpose: CodeDeliveryPurpose): number {
			return sent.filter((s) => s.purpose === purpose).length;
		},
		last(purpose: CodeDeliveryPurpose): string {
			const match = [...sent].reverse().find((s) => s.purpose === purpose);
			assert.ok(match, `a ${purpose} code was delivered`);
			return match.code;
		},
	};
}

async function register(
	auth: {
		signUp(username: string, password: string, options: { attributes: { email: string } }): Promise<unknown>;
		confirmSignUp(username: string, code: string): Promise<unknown>;
	},
	sink: ReturnType<typeof codeSink>,
	username: string,
): Promise<void> {
	await auth.signUp(username, PASSWORD, { attributes: { email: `${username}@example.com` } });
	await auth.confirmSignUp(username, sink.last('signUp'));
}

function cookieOf(b: { jar: Map<string, string> }, fullId: string): string | undefined {
	return b.jar.get(`auth_${fullId}`);
}

describe('mock engine — updatePassword ends the user’s other sessions', () => {
	test('other sessions are rejected; the caller stays signed in on a re-issued session', async () => {
		const sink = codeSink();
		const auth = new Auth(root(), 'auth', { codeDelivery: sink.deliver });
		await register(auth, sink, 'hal');
		await register(auth, sink, 'ida');
		const laptop = new Browser();
		const phone = new Browser();
		const other = new Browser();
		await laptop.request((ctx) => auth.signIn('hal', PASSWORD, ctx));
		await phone.request((ctx) => auth.signIn('hal@example.com', PASSWORD, ctx));
		await other.request((ctx) => auth.signIn('ida', PASSWORD, ctx));
		const before = cookieOf(laptop, auth.fullId);
		assert.ok(before);

		await laptop.request((ctx) => auth.updatePassword(ctx, PASSWORD, NEW_PASSWORD));

		const after = cookieOf(laptop, auth.fullId);
		assert.ok(after, 'the caller has a session cookie');
		assert.notStrictEqual(after, before, 'the session was re-issued');
		assert.strictEqual((await laptop.request((ctx) => auth.requireAuth(ctx))).username, 'hal', 'caller signed in');
		assert.strictEqual(await phone.request((ctx) => auth.checkAuth(ctx)), false, 'the other session ended');
		assert.strictEqual(await other.request((ctx) => auth.checkAuth(ctx)), true, 'other users are unaffected');

		// A replayed copy of the caller's old cookie no longer authenticates.
		const replay = new Browser();
		replay.jar.set(`auth_${auth.fullId}`, before);
		assert.strictEqual(await replay.request((ctx) => auth.checkAuth(ctx)), false);

		// The new password works, the old one does not.
		const fresh = new Browser();
		assert.strictEqual((await fresh.request((ctx) => auth.signIn('hal', NEW_PASSWORD, ctx))).status, 'signedIn');
		const old = await fresh
			.request((ctx) => auth.signIn('hal', PASSWORD, ctx))
			.then(
				() => assert.fail('the old password was accepted'),
				(e: unknown) => e,
			);
		assert.ok(old instanceof ApiError);
		assert.strictEqual(old.name, AuthErrors.NotAuthorized);
	});

	test('the re-issued session keeps refreshing (its tokens are not revoked)', async () => {
		const sink = codeSink();
		const auth = new Auth(root(), 'auth', { codeDelivery: sink.deliver });
		await register(auth, sink, 'jo');
		const b = new Browser();
		await b.request((ctx) => auth.signIn('jo', PASSWORD, ctx));
		await b.request((ctx) => auth.updatePassword(ctx, PASSWORD, NEW_PASSWORD));
		const session = await b.request((ctx) => auth.getAuthSession(ctx, { forceRefresh: true }));
		assert.ok(session.tokens, 'a forced refresh succeeds');
		assert.strictEqual(await b.request((ctx) => auth.checkAuth(ctx)), true);
	});

	test('choice-based sign-in (USER_AUTH): the session is re-issued through the password step', async () => {
		const sink = codeSink();
		const auth = new Auth(root(), 'auth', { users: { authFlow: 'USER_AUTH' }, codeDelivery: sink.deliver });
		await register(auth, sink, 'kai');
		const b = new Browser();
		const r = await b.request((ctx) => auth.signIn('kai', '', ctx, { preferredChallenge: 'PASSWORD' }));
		assert.ok(r.status === 'continueSignIn');
		const session = 'session' in r.nextStep ? r.nextStep.session : '';
		await b.request((ctx) => auth.confirmSignIn(session, PASSWORD, ctx));
		const before = cookieOf(b, auth.fullId);
		await b.request((ctx) => auth.updatePassword(ctx, PASSWORD, NEW_PASSWORD));
		assert.notStrictEqual(cookieOf(b, auth.fullId), before);
		assert.strictEqual(await b.request((ctx) => auth.checkAuth(ctx)), true);
	});

	test('SMS MFA: no sign-in is attempted (no code is sent); the caller is signed out', async () => {
		const sink = codeSink();
		const auth = new Auth(root(), 'auth', {
			mfa: { mode: 'optional', types: ['SMS', 'TOTP'] },
			codeDelivery: sink.deliver,
		});
		await auth.signUp('nia', PASSWORD, { attributes: { email: 'nia@example.com', phone_number: '+15555550100' } });
		await auth.confirmSignUp('nia', sink.last('signUp'));
		const b = new Browser();
		assert.strictEqual((await b.request((ctx) => auth.signIn('nia', PASSWORD, ctx))).status, 'signedIn');
		await b.request((ctx) => auth.sendUserAttributeVerificationCode(ctx, 'phone_number'));
		await b.request((ctx) => auth.confirmUserAttribute(ctx, 'phone_number', sink.last('attribute')));
		assert.deepStrictEqual(await b.request((ctx) => auth.getMfaPreference(ctx)), { enabled: ['SMS'] });
		const before = cookieOf(b, auth.fullId);
		assert.ok(before);

		await b.request((ctx) => auth.updatePassword(ctx, PASSWORD, NEW_PASSWORD));

		assert.strictEqual(sink.count('mfa'), 0, 'no MFA code was delivered');
		assert.strictEqual(cookieOf(b, auth.fullId), undefined, 'the cookie is cleared');
		const replay = new Browser();
		replay.jar.set(`auth_${auth.fullId}`, before);
		assert.strictEqual(await replay.request((ctx) => auth.checkAuth(ctx)), false);
		const next = await new Browser().request((ctx) => auth.signIn('nia', NEW_PASSWORD, ctx));
		assert.ok(next.status === 'continueSignIn' && next.nextStep.name === 'CONFIRM_SIGN_IN_WITH_SMS_CODE');
	});

	test('email MFA: no sign-in is attempted (no code is sent); the caller is signed out', async () => {
		const sink = codeSink();
		const auth = new Auth(root(), 'auth', {
			mfa: { mode: 'optional', types: ['EMAIL'] },
			codeDelivery: sink.deliver,
		});
		await register(auth, sink, 'oli');
		const b = new Browser();
		const r = await b.request((ctx) => auth.signIn('oli', PASSWORD, ctx));
		assert.ok(r.status === 'continueSignIn' && r.nextStep.name === 'CONFIRM_SIGN_IN_WITH_EMAIL_CODE');
		const session = r.nextStep.session;
		const signedIn = await b.request((ctx) => auth.confirmSignIn(session, sink.last('mfa'), ctx));
		assert.strictEqual(signedIn.status, 'signedIn');
		const codes = sink.count('mfa');

		await b.request((ctx) => auth.updatePassword(ctx, PASSWORD, NEW_PASSWORD));

		assert.strictEqual(sink.count('mfa'), codes, 'no further MFA code was delivered');
		assert.strictEqual(cookieOf(b, auth.fullId), undefined, 'the cookie is cleared');
		assert.strictEqual(await b.request((ctx) => auth.checkAuth(ctx)), false);
	});

	test('a wrong old password changes nothing and ends no session', async () => {
		const sink = codeSink();
		const auth = new Auth(root(), 'auth', { codeDelivery: sink.deliver });
		await register(auth, sink, 'kim');
		const laptop = new Browser();
		const phone = new Browser();
		await laptop.request((ctx) => auth.signIn('kim', PASSWORD, ctx));
		await phone.request((ctx) => auth.signIn('kim', PASSWORD, ctx));
		const e = await laptop
			.request((ctx) => auth.updatePassword(ctx, 'Wrong-Passw0rd', NEW_PASSWORD))
			.then(
				() => assert.fail('expected a rejection'),
				(err: unknown) => err,
			);
		assert.ok(e instanceof ApiError);
		assert.strictEqual(e.name, AuthErrors.NotAuthorized);
		assert.strictEqual(await phone.request((ctx) => auth.checkAuth(ctx)), true);
		assert.strictEqual(await laptop.request((ctx) => auth.checkAuth(ctx)), true);
	});
});

describe('mock engine — admin.setUserPassword ends the user’s sessions', () => {
	test('every session of the user is rejected; other users are unaffected', async () => {
		const sink = codeSink();
		const auth = new Auth(root(), 'auth', { admin: {}, codeDelivery: sink.deliver });
		await register(auth, sink, 'lee');
		await register(auth, sink, 'max');
		const lee = new Browser();
		const max = new Browser();
		await lee.request((ctx) => auth.signIn('lee', PASSWORD, ctx));
		await max.request((ctx) => auth.signIn('max', PASSWORD, ctx));

		await auth.admin.setUserPassword('lee@example.com', NEW_PASSWORD, { permanent: true });

		assert.strictEqual(await lee.request((ctx) => auth.checkAuth(ctx)), false);
		assert.strictEqual(await max.request((ctx) => auth.checkAuth(ctx)), true);
		const again = new Browser();
		assert.strictEqual((await again.request((ctx) => auth.signIn('lee', NEW_PASSWORD, ctx))).status, 'signedIn');
		assert.strictEqual(await again.request((ctx) => auth.checkAuth(ctx)), true, 'a later sign-in is unaffected');
	});
});

describe('AWS engine — updatePassword ends the user’s other sessions', () => {
	test('ChangePassword, then AdminGetUser + AdminUserGlobalSignOut, then a sign-in with the new password', async () => {
		const h = makeAwsAuth();
		const laptop = new AwsBrowser();
		const phone = new AwsBrowser();
		const other = new AwsBrowser();
		await signInAs(h, phone, 'alice');
		await signInAs(h, other, 'bob');
		const tokens = h.idp.authResult('alice');
		await signInAs(h, laptop, 'alice', tokens);
		const before = cookieOf(laptop, h.fullId);
		h.on('ChangePasswordCommand', () => ({}));
		h.on('AdminGetUserCommand', () => ({ Username: 'alice', UserAttributes: [] }));
		h.on('AdminUserGlobalSignOutCommand', () => ({}));
		h.on('InitiateAuthCommand', () => ({ AuthenticationResult: h.idp.authResult('alice') }));

		await laptop.request((ctx) => h.auth.updatePassword(ctx, 'Old!pass1', 'New!pass1'));

		assert.deepStrictEqual(h.sent, [
			{
				name: 'ChangePasswordCommand',
				input: {
					AccessToken: tokens.AccessToken,
					PreviousPassword: 'Old!pass1',
					ProposedPassword: 'New!pass1',
				},
			},
			{ name: 'AdminGetUserCommand', input: { UserPoolId: TEST_POOL_ID, Username: 'alice' } },
			{ name: 'AdminUserGlobalSignOutCommand', input: { UserPoolId: TEST_POOL_ID, Username: 'alice' } },
			{
				name: 'InitiateAuthCommand',
				input: {
					AuthFlow: 'USER_PASSWORD_AUTH',
					ClientId: TEST_CLIENT_ID,
					AuthParameters: { USERNAME: 'alice', PASSWORD: 'New!pass1' },
				},
			},
		]);
		const after = cookieOf(laptop, h.fullId);
		assert.ok(after);
		assert.notStrictEqual(after, before, 'the session was re-issued');
		assert.strictEqual((await laptop.request((ctx) => h.auth.requireAuth(ctx))).username, 'alice');
		assert.strictEqual(await phone.request((ctx) => h.auth.checkAuth(ctx)), false, 'the other session ended');
		assert.strictEqual(await other.request((ctx) => h.auth.checkAuth(ctx)), true, 'other users are unaffected');
	});

	test('when signing in again needs MFA, the caller’s session ends too (the password still changed)', async () => {
		const { logger } = captureLogger();
		const h = makeAwsAuth({ logger });
		const b = new AwsBrowser();
		await signInAs(h, b, 'alice');
		h.on('ChangePasswordCommand', () => ({}));
		h.on('AdminGetUserCommand', () => ({ Username: 'alice', UserAttributes: [] }));
		h.on('AdminUserGlobalSignOutCommand', () => ({}));
		h.on('InitiateAuthCommand', () => ({ ChallengeName: 'SOFTWARE_TOKEN_MFA', Session: 'cognito-session' }));

		await b.request((ctx) => h.auth.updatePassword(ctx, 'Old!pass1', 'New!pass1'));

		assert.strictEqual(cookieOf(b, h.fullId), undefined, 'the cookie is cleared');
		assert.strictEqual(await b.request((ctx) => h.auth.checkAuth(ctx)), false);
	});

	for (const [label, factor] of [
		['SMS', 'SMS_MFA'],
		['email', 'EMAIL_OTP'],
	] as const) {
		test(`${label} MFA: GetUser, no InitiateAuth (no code is sent); the caller is signed out`, async () => {
			const h = makeAwsAuth({ mfa: { mode: 'optional', types: ['SMS', 'TOTP', 'EMAIL'] } });
			const b = new AwsBrowser();
			await signInAs(h, b, 'alice');
			const before = cookieOf(b, h.fullId);
			assert.ok(before);
			h.on('ChangePasswordCommand', () => ({}));
			h.on('GetUserCommand', () => ({
				Username: 'alice',
				UserAttributes: [],
				UserMFASettingList: [factor],
				PreferredMfaSetting: factor,
			}));
			h.on('AdminGetUserCommand', () => ({ Username: 'alice', UserAttributes: [] }));
			h.on('AdminUserGlobalSignOutCommand', () => ({}));

			await b.request((ctx) => h.auth.updatePassword(ctx, 'Old!pass1', 'New!pass1'));

			assert.deepStrictEqual(
				h.sent.map((c) => c.name),
				['ChangePasswordCommand', 'GetUserCommand', 'AdminGetUserCommand', 'AdminUserGlobalSignOutCommand'],
				'no sign-in was attempted, so no code was sent',
			);
			assert.strictEqual(cookieOf(b, h.fullId), undefined, 'the cookie is cleared');
			const replay = new AwsBrowser();
			replay.jar.set(`auth_${h.fullId}`, before);
			assert.strictEqual(await replay.request((ctx) => h.auth.checkAuth(ctx)), false);
		});
	}

	test('TOTP MFA preferred: the re-issue is attempted (an authenticator code sends nothing)', async () => {
		const h = makeAwsAuth({ mfa: { mode: 'optional', types: ['SMS', 'TOTP'] } });
		const b = new AwsBrowser();
		await signInAs(h, b, 'alice');
		h.on('ChangePasswordCommand', () => ({}));
		h.on('GetUserCommand', () => ({
			Username: 'alice',
			UserAttributes: [],
			UserMFASettingList: ['SMS_MFA', 'SOFTWARE_TOKEN_MFA'],
			PreferredMfaSetting: 'SOFTWARE_TOKEN_MFA',
		}));
		h.on('AdminGetUserCommand', () => ({ Username: 'alice', UserAttributes: [] }));
		h.on('AdminUserGlobalSignOutCommand', () => ({}));
		h.on('InitiateAuthCommand', () => ({ AuthenticationResult: h.idp.authResult('alice') }));

		await b.request((ctx) => h.auth.updatePassword(ctx, 'Old!pass1', 'New!pass1'));

		assert.ok(h.sent.some((c) => c.name === 'InitiateAuthCommand'));
		assert.strictEqual(await b.request((ctx) => h.auth.checkAuth(ctx)), true);
	});

	test('a failed sign-out step is reported (the password is already changed), not swallowed', async () => {
		const { logger, entries } = captureLogger();
		const h = makeAwsAuth({ logger });
		const b = new AwsBrowser();
		await signInAs(h, b, 'alice');
		h.on('ChangePasswordCommand', () => ({}));
		h.on('AdminGetUserCommand', () => {
			throw cognitoError('InternalErrorException', 'boom', 500);
		});
		const e = await b
			.request((ctx) => h.auth.updatePassword(ctx, 'Old!pass1', 'New!pass1'))
			.then(
				() => assert.fail('expected a rejection'),
				(err: unknown) => err,
			);
		assert.strictEqual(wireView(e).code, 500);
		assert.ok(entries.some((l) => l.level === 'error' && /password change/.test(l.message)));
	});
});

describe('AWS engine — updatePassword when the re-issue fails after the password changed', () => {
	/** A signed-in `alice` whose password change succeeds up to the re-issue. */
	async function changed() {
		const { logger, entries } = captureLogger();
		const changedFor: string[] = [];
		const h = makeAwsAuth({
			logger,
			onPasswordChanged: async (user) => {
				changedFor.push(user.username);
			},
		});
		const b = new AwsBrowser();
		await signInAs(h, b, 'alice');
		const before = cookieOf(b, h.fullId);
		assert.ok(before);
		h.on('ChangePasswordCommand', () => ({}));
		h.on('AdminGetUserCommand', () => ({ Username: 'alice', UserAttributes: [] }));
		h.on('AdminUserGlobalSignOutCommand', () => ({}));
		return { h, b, before, entries, changedFor };
	}

	/** The call resolved; the caller is signed out; the old session id is rejected; the hook ran; it was logged. */
	async function assertSignedOut(
		r: Awaited<ReturnType<typeof changed>>,
		level: 'warn' | 'error',
		message: RegExp,
	): Promise<void> {
		assert.strictEqual(cookieOf(r.b, r.h.fullId), undefined, 'the cookie is cleared');
		assert.strictEqual(await r.b.request((ctx) => r.h.auth.checkAuth(ctx)), false);
		const replay = new AwsBrowser();
		replay.jar.set(`auth_${r.h.fullId}`, r.before);
		assert.strictEqual(
			await replay.request((ctx) => r.h.auth.checkAuth(ctx)),
			false,
			'the old session id is rejected',
		);
		assert.deepStrictEqual(r.changedFor, ['alice'], 'onPasswordChanged ran');
		assert.ok(
			r.entries.some((l) => l.level === level && message.test(l.message)),
			`logged at ${level}: ${JSON.stringify(r.entries.map((l) => [l.level, l.message]))}`,
		);
	}

	test('the sign-in with the new password throws', async () => {
		const r = await changed();
		r.h.on('InitiateAuthCommand', () => {
			throw cognitoError('InternalErrorException', 'boom', 500);
		});
		await r.b.request((ctx) => r.h.auth.updatePassword(ctx, 'Old!pass1', 'New!pass1'));
		await assertSignedOut(r, 'warn', /re-issuing the current session failed/);
	});

	test('writing the re-issued session row throws', async () => {
		const r = await changed();
		r.h.on('InitiateAuthCommand', () => ({ AuthenticationResult: r.h.idp.authResult('alice') }));
		const sessions = Reflect.get(r.h.auth, 'sessions');
		const create = sessions.create;
		sessions.create = async () => {
			throw new Error('store down');
		};
		try {
			await r.b.request((ctx) => r.h.auth.updatePassword(ctx, 'Old!pass1', 'New!pass1'));
		} finally {
			sessions.create = create;
		}
		await assertSignedOut(r, 'error', /writing the re-issued session failed/);
	});

	test('setting the re-issued session cookie throws', async () => {
		const r = await changed();
		r.h.on('InitiateAuthCommand', () => ({ AuthenticationResult: r.h.idp.authResult('alice') }));
		await r.b.request((ctx) => {
			const headers = ctx.response.headers;
			const set = headers.set.bind(headers);
			// Refuse the session cookie itself; a clearing cookie (Max-Age=0) still goes through.
			headers.set = (name: string, value: string) => {
				if (name.toLowerCase() === 'set-cookie' && !/Max-Age=0(?:;|$)/.test(value)) {
					throw new Error('header write failed');
				}
				set(name, value);
			};
			return r.h.auth.updatePassword(ctx, 'Old!pass1', 'New!pass1');
		});
		await assertSignedOut(r, 'error', /writing the re-issued session failed/);
	});
});

describe('AWS engine — admin.setUserPassword ends the user’s sessions', () => {
	test('AdminSetUserPassword, then AdminGetUser + AdminUserGlobalSignOut; the user’s sessions are rejected', async () => {
		const h = makeAwsAuth({ admin: {} });
		const b = new AwsBrowser();
		await signInAs(h, b, 'bob');
		h.on('AdminSetUserPasswordCommand', () => ({}));
		h.on('AdminGetUserCommand', () => ({ Username: 'bob', UserAttributes: [] }));
		h.on('AdminUserGlobalSignOutCommand', () => ({}));

		await h.auth.admin.setUserPassword('bob@example.com', 'Final!1234', { permanent: true });

		assert.deepStrictEqual(h.sent, [
			{
				name: 'AdminSetUserPasswordCommand',
				input: {
					UserPoolId: TEST_POOL_ID,
					Username: 'bob@example.com',
					Password: 'Final!1234',
					Permanent: true,
				},
			},
			{ name: 'AdminGetUserCommand', input: { UserPoolId: TEST_POOL_ID, Username: 'bob@example.com' } },
			{ name: 'AdminUserGlobalSignOutCommand', input: { UserPoolId: TEST_POOL_ID, Username: 'bob' } },
		]);
		assert.strictEqual(await b.request((ctx) => h.auth.checkAuth(ctx)), false);
	});

	test('a failed sign-out step is logged at error and reported as a 5xx (the password is already set)', async () => {
		const { logger, entries } = captureLogger();
		const h = makeAwsAuth({ admin: {}, logger });
		h.on('AdminSetUserPasswordCommand', () => ({}));
		h.on('AdminGetUserCommand', () => ({ Username: 'bob', UserAttributes: [] }));
		h.on('AdminUserGlobalSignOutCommand', () => {
			throw cognitoError('InternalErrorException', 'boom', 500);
		});
		const e = await h.auth.admin.setUserPassword('bob', 'Final!1234', { permanent: true }).then(
			() => assert.fail('expected a rejection'),
			(err: unknown) => err,
		);
		assert.strictEqual(wireView(e).code, 500);
		assert.ok(entries.some((l) => l.level === 'error' && /admin\.setUserPassword/.test(l.message)));
	});
});
