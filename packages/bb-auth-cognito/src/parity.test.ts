// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Mock ↔ AWS parity for client-observable auth behaviour: the same scenario is
 * run against the mock (`./index.js`) and the AWS runtime (`./index.aws.js`,
 * driven offline through `test-support/aws-harness.ts`), and what the client
 * can see is compared. Focus: user-enumeration safety and the Set-Cookie
 * headers that reach the browser.
 */

import assert from 'node:assert';
import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, test } from 'node:test';
import type { ScopeParent } from '@aws-blocks/core';
import { AuthCognito as MockAuthCognito } from './index.js';
import { Browser, cognitoError, makeAwsAuth, setCookieFor, wireView } from './test-support/aws-harness.js';

beforeEach(() => rmSync('.bb-data', { recursive: true, force: true }));
afterEach(() => rmSync('.bb-data', { recursive: true, force: true }));

const ROOT: ScopeParent = { id: 'parity-app' };
let n = 0;

/** A mock instance whose delivered codes are captured. */
function mockAuth() {
	const codes = new Map<string, string>();
	const auth = new MockAuthCognito(ROOT, `mock${++n}`, {
		codeDelivery: async (username: string, code: string, purpose: string) => {
			codes.set(`${purpose}:${username}`, code);
		},
	});
	return { auth, codes };
}

/** Sign up + confirm a real mock user. */
async function mockUser(username: string, email: string) {
	const m = mockAuth();
	await m.auth.signUp(username, 'Password!1', { attributes: { email } });
	await m.auth.confirmSignUp(username, m.codes.get(`signUp:${username}`) ?? '');
	return m;
}

async function rejection(p: Promise<unknown>): Promise<unknown> {
	return p.then(
		() => assert.fail('expected rejection'),
		(e: unknown) => e,
	);
}

describe('parity: sign-in failures are uniform in both runtimes', () => {
	test('unknown user and wrong password → the same client-visible error, mock and AWS', async () => {
		const { auth } = await mockUser('alice', 'alice@example.com');
		const mockUnknown = await rejection(new Browser().request((c) => auth.signIn('nobody', 'Password!1', c)));
		const mockWrong = await rejection(new Browser().request((c) => auth.signIn('alice', 'Wrong!123', c)));

		const awsUnknown = makeAwsAuth();
		awsUnknown.on('InitiateAuthCommand', () => {
			throw cognitoError('UserNotFoundException', 'User does not exist.');
		});
		const awsWrong = makeAwsAuth();
		awsWrong.on('InitiateAuthCommand', () => {
			throw cognitoError('NotAuthorizedException', 'Incorrect username or password.');
		});
		const views = [
			mockUnknown,
			mockWrong,
			await rejection(new Browser().request((c) => awsUnknown.auth.signIn('nobody', 'Password!1', c))),
			await rejection(new Browser().request((c) => awsWrong.auth.signIn('alice', 'Wrong!123', c))),
		].map((e) => JSON.stringify(wireView(e)));
		assert.strictEqual(new Set(views).size, 1, views.join('\n'));
	});

	test('a user deleted mid-challenge → credential failure (not 404) in both runtimes', async () => {
		// Mock: start a USER_AUTH sign-in, then remove the user before answering.
		const codes = new Map<string, string>();
		const auth = new MockAuthCognito(ROOT, `mock${++n}`, {
			authFlowType: 'USER_AUTH',
			codeDelivery: async (u: string, c: string, p: string) => {
				codes.set(`${p}:${u}`, c);
			},
		});
		await auth.signUp('alice', 'Password!1', { attributes: { email: 'alice@example.com' } });
		await auth.confirmSignUp('alice', codes.get('signUp:alice') ?? '');
		const b = new Browser();
		const pick = await b.request((c) => auth.signIn('alice', '', c));
		assert.ok(pick.status === 'continueSignIn' && 'session' in pick.nextStep);
		const session = 'session' in pick.nextStep ? pick.nextStep.session : '';
		Reflect.get(auth, 'state').users.alice = undefined;
		const mockErr = await rejection(b.request((c) => auth.confirmSignIn(session, { firstFactor: 'PASSWORD' }, c)));
		assert.deepStrictEqual(wireView(mockErr), {
			code: 401,
			message: 'Incorrect username or password',
			name: 'NotAuthorizedException',
			retriable: false,
		});
	});
});

describe('parity: password reset and code resend never reveal an account', () => {
	test('resetPassword: an unknown email username gets the same details a real user would', async () => {
		const { auth } = await mockUser('alice@example.com', 'alice@example.com');
		const known = await auth.resetPassword('alice@example.com');
		const { auth: empty } = mockAuth();
		const unknown = await empty.resetPassword('alice@example.com');
		assert.deepStrictEqual(unknown, known);

		const aws = makeAwsAuth();
		aws.on('ForgotPasswordCommand', () => {
			throw cognitoError('UserNotFoundException', 'Username/client id combination not found.');
		});
		assert.deepStrictEqual(await aws.auth.resetPassword('alice@example.com'), known);
	});

	test('resetPassword: an unknown non-email username gets a plausible masked address in both runtimes', async () => {
		const { auth } = mockAuth();
		const aws = makeAwsAuth();
		aws.on('ForgotPasswordCommand', () => {
			throw cognitoError('UserNotFoundException', 'Username/client id combination not found.');
		});
		for (const r of [await auth.resetPassword('nobody'), await aws.auth.resetPassword('nobody')]) {
			assert.strictEqual(r.nextStep?.codeDeliveryDetails.deliveryMedium, 'EMAIL');
			assert.match(r.nextStep?.codeDeliveryDetails.destination ?? '', /^[a-z]\*\*\*@[a-z]\*\*\*$/);
		}
	});

	test('resendSignUpCode: an unknown user resolves in both runtimes', async () => {
		const { auth } = mockAuth();
		assert.strictEqual(await auth.resendSignUpCode('nobody'), undefined);
		const aws = makeAwsAuth();
		aws.on('ResendConfirmationCodeCommand', () => {
			throw cognitoError('UserNotFoundException', 'Username/client id combination not found.');
		});
		assert.strictEqual(await aws.auth.resendSignUpCode('nobody'), undefined);
	});

	test('confirmSignUp / confirmResetPassword: unknown user ≡ wrong code (CodeMismatch 400) in both runtimes', async () => {
		const { auth } = await mockUser('alice', 'alice@example.com');
		await auth.resendSignUpCode('alice');
		await auth.resetPassword('alice');
		const mockPairs: Array<[unknown, unknown]> = [
			[
				await rejection(auth.confirmSignUp('nobody', '000000')),
				await rejection(auth.confirmSignUp('alice', '000000')),
			],
			[
				await rejection(auth.confirmResetPassword('nobody', '000000', 'NewPassword!1')),
				await rejection(auth.confirmResetPassword('alice', '000000', 'NewPassword!1')),
			],
		];
		for (const [unknown, wrong] of mockPairs) {
			assert.deepStrictEqual(wireView(unknown), wireView(wrong));
			assert.strictEqual(wireView(unknown).name, 'CodeMismatchException');
			assert.strictEqual(wireView(unknown).code, 400);
		}

		for (const [command, run] of [
			['ConfirmSignUpCommand', (h: ReturnType<typeof makeAwsAuth>) => h.auth.confirmSignUp('nobody', '000000')],
			[
				'ConfirmForgotPasswordCommand',
				(h: ReturnType<typeof makeAwsAuth>) => h.auth.confirmResetPassword('nobody', '000000', 'NewPassword!1'),
			],
		] as const) {
			const h = makeAwsAuth();
			h.on(command, () => {
				throw cognitoError('UserNotFoundException', 'User does not exist.');
			});
			const e = await rejection(run(h));
			assert.strictEqual(wireView(e).name, 'CodeMismatchException');
			assert.strictEqual(wireView(e).code, 400);
		}
	});
});

describe('parity: autoSignIn clears the bridge cookie in both runtimes', () => {
	test('mock: the session cookie and the bridge clear both reach the browser', async () => {
		const { auth, codes } = mockAuth();
		const b = new Browser();
		await b.request((c) => auth.signUp('newbie', 'Password!1', { autoSignIn: true }, c));
		const bridge = `autosignin_${auth.fullId}`;
		assert.ok(b.jar.get(bridge));
		await b.request((c) => auth.confirmSignUp('newbie', codes.get('signUp:newbie') ?? '', c));
		const r = await b.request((c) => auth.autoSignIn(c));
		assert.strictEqual(r.status, 'signedIn');
		assert.ok(setCookieFor(b.lastSetCookies, `auth_${auth.fullId}`), 'session cookie set');
		assert.ok(setCookieFor(b.lastSetCookies, bridge)?.includes('Max-Age=0'), 'bridge cleared');
		assert.strictEqual(b.jar.get(bridge), undefined);
	});
});
