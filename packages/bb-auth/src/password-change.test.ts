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
 *   caller's session ends too.
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
});
