// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Local runtime — account-state hiding (FX3 / finding A3) on every public
 * email + password step. With `emailPassword.revealExistingUsers` off (the
 * default), an unknown user, an unconfirmed user and an already-confirmed user
 * must be indistinguishable to a client on `confirmSignUp`, `resendSignUpCode`,
 * `resetPassword`, `confirmResetPassword`, `signIn` and the `USER_AUTH` start —
 * exactly as on AWS (`index.aws.enumeration.test.ts`). Users sign in with their
 * email, and the addresses share a first letter so masked destinations
 * (`n***@e***`) can be compared byte for byte.
 */

import assert from 'node:assert';
import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, mock, test } from 'node:test';
import type { AuthStateApi } from '@aws-blocks/auth-common';
import type { BlocksContext, ScopeParent } from '@aws-blocks/core';
import { clientMessageFor } from './error-mapping.js';
import { Auth, AuthErrors } from './index.mock.js';
import { Browser, wireView } from './test-support/aws-harness.js';
import type { AuthOptions, CodeDeliveryPurpose, SignInNextStep } from './types.js';

beforeEach(() => rmSync('.bb-data', { recursive: true, force: true }));
afterEach(() => {
	mock.restoreAll();
	rmSync('.bb-data', { recursive: true, force: true });
});

const PASSWORD = 'Passw0rd!';
const CONFIRMED = 'naomi@example.com';
const UNCONFIRMED = 'nadia@example.com';
const UNKNOWN = 'nobody@example.com';
const USERS = { unknown: UNKNOWN, unconfirmed: UNCONFIRMED, 'already-confirmed': CONFIRMED };

let n = 0;
const root = (): ScopeParent => ({ id: `enum${process.pid}x${++n}` });

interface Delivered {
	username: string;
	purpose: CodeDeliveryPurpose;
	code: string;
}

/**
 * A local `Auth` (email is the sign-in name) with one confirmed and one
 * unconfirmed user; every delivered code is captured.
 */
async function setup<const O extends AuthOptions>(options?: O) {
	const delivered: Delivered[] = [];
	const auth = new Auth(root(), 'auth', {
		...options,
		users: { ...options?.users, signInWith: ['email'] },
		codeDelivery: async (username: string, code: string, purpose: CodeDeliveryPurpose) => {
			delivered.push({ username, purpose, code });
		},
	});
	// The wide `Auth` view: these scenarios use password configurations only.
	const wide: Auth = auth;
	const last = (username: string, purpose: CodeDeliveryPurpose) =>
		[...delivered].reverse().find((d) => d.username === username && d.purpose === purpose)?.code ?? '';
	await wide.signUp(CONFIRMED, PASSWORD, { attributes: { email: CONFIRMED } });
	await wide.confirmSignUp(CONFIRMED, last(CONFIRMED, 'signUp'));
	await wide.signUp(UNCONFIRMED, PASSWORD, { attributes: { email: UNCONFIRMED } });
	delivered.length = 0;
	const api = (ctx: BlocksContext): AuthStateApi =>
		(wide.createApi() as unknown as (c: BlocksContext) => AuthStateApi)(ctx);
	return { auth: wide, api, delivered, last };
}

async function rejection(p: Promise<unknown>): Promise<unknown> {
	return p.then(
		() => assert.fail('expected rejection'),
		(e: unknown) => e,
	);
}

/** Everything a client can observe of a rejection: the wire fields plus the serialized body. */
function observedOf(e: unknown): string {
	return `${JSON.stringify(wireView(e))}|${JSON.stringify(e)}`;
}

const WRONG_CODE_WIRE = {
	code: 400,
	message: 'Invalid verification code provided, please try again.',
	name: AuthErrors.CodeMismatch,
	retriable: true,
};

/** Move the clock past every code's lifetime (24 h is longer than any mock code TTL). */
function expireCodes(): void {
	const now = Date.now();
	mock.method(Date, 'now', () => now + 25 * 60 * 60 * 1000);
}

describe('mock enumeration (FX3): confirmSignUp hides the account state', () => {
	test('unknown, unconfirmed (wrong or expired code) and already-confirmed are byte-identical', async () => {
		const h = await setup();
		const seen = new Set<string>();
		for (const [label, username] of Object.entries(USERS)) {
			const e = await rejection(h.auth.confirmSignUp(username, '000000'));
			assert.deepStrictEqual(wireView(e), WRONG_CODE_WIRE, label);
			seen.add(observedOf(e));
		}
		expireCodes();
		const expired = await rejection(h.auth.confirmSignUp(UNCONFIRMED, '000000'));
		assert.deepStrictEqual(wireView(expired), WRONG_CODE_WIRE, 'unconfirmed user, expired code');
		seen.add(observedOf(expired));
		assert.strictEqual(seen.size, 1);
	});

	test('setAuthState confirmSignUp: every account state yields the identical state', async () => {
		const h = await setup();
		const seen = new Set<string>();
		const confirm = (username: string) =>
			new Browser().request((ctx) =>
				h.api(ctx).setAuthState({ action: 'confirmSignUp', username, code: '000000' }),
			);
		for (const username of Object.values(USERS)) seen.add(JSON.stringify(await confirm(username)));
		expireCodes();
		seen.add(JSON.stringify(await confirm(UNCONFIRMED)));
		assert.strictEqual(seen.size, 1);
	});

	test('revealExistingUsers: true reports an already-confirmed user as Cognito does', async () => {
		const h = await setup({ emailPassword: { revealExistingUsers: true } });
		assert.deepStrictEqual(wireView(await rejection(h.auth.confirmSignUp(CONFIRMED, '000000'))), {
			code: 401,
			// FX59 (#678): the name's fixed message; Cognito's "User cannot be
			// confirmed. Current status is CONFIRMED" stays in the server log.
			message: clientMessageFor(AuthErrors.NotAuthorized),
			name: AuthErrors.NotAuthorized,
			retriable: false,
		});
	});
});

describe('mock enumeration (FX3): resendSignUpCode hides the account state', () => {
	test('every account state resolves identically, and only the unconfirmed user gets a code', async () => {
		const h = await setup();
		const seen = new Set<string>();
		for (const username of Object.values(USERS)) {
			assert.strictEqual(await h.auth.resendSignUpCode(username), undefined);
			const s = await new Browser().request((ctx) =>
				h.api(ctx).setAuthState({ action: 'resendSignUpCode', username }),
			);
			// The form echoes the username back (a hidden field); everything else must match.
			seen.add(JSON.stringify(s).replaceAll(username, '<username>'));
		}
		assert.strictEqual(seen.size, 1);
		assert.deepStrictEqual(
			h.delivered.map((d) => d.username),
			[UNCONFIRMED, UNCONFIRMED],
			'an already-confirmed user is not sent a sign-up code',
		);
	});

	test('revealExistingUsers: true reports an already-confirmed user (and sends nothing)', async () => {
		const h = await setup({ emailPassword: { revealExistingUsers: true } });
		assert.deepStrictEqual(wireView(await rejection(h.auth.resendSignUpCode(CONFIRMED))), {
			code: 400,
			// FX59 (#678): the fixed message; "User is already confirmed." is logged.
			message: clientMessageFor(AuthErrors.InvalidParameter),
			name: AuthErrors.InvalidParameter,
			retriable: true,
		});
		assert.deepStrictEqual(h.delivered, []);
	});
});

describe('mock enumeration (FX3): password reset hides the account state', () => {
	test('resetPassword: identical delivery details; an unconfirmed user is sent no code', async () => {
		const h = await setup();
		const seen = new Set<string>();
		for (const username of Object.values(USERS)) {
			seen.add(JSON.stringify(await h.auth.resetPassword(username)));
		}
		assert.strictEqual(seen.size, 1, [...seen].join('\n'));
		// As Cognito: no verified contact yet, so no code goes out (a simulated delivery).
		assert.deepStrictEqual(
			h.delivered.map((d) => d.username),
			[CONFIRMED],
		);
	});

	test('confirmResetPassword: unknown, unconfirmed, wrong and expired codes are byte-identical', async () => {
		const h = await setup();
		await h.auth.resetPassword(CONFIRMED);
		const seen = new Set<string>();
		for (const [label, username] of Object.entries(USERS)) {
			const e = await rejection(h.auth.confirmResetPassword(username, '000000', 'NewPassw0rd!'));
			assert.deepStrictEqual(wireView(e), WRONG_CODE_WIRE, label);
			seen.add(observedOf(e));
		}
		expireCodes();
		const expired = await rejection(
			h.auth.confirmResetPassword(CONFIRMED, h.last(CONFIRMED, 'resetPassword'), 'NewPassw0rd!'),
		);
		assert.deepStrictEqual(wireView(expired), WRONG_CODE_WIRE, 'expired code');
		seen.add(observedOf(expired));
		assert.strictEqual(seen.size, 1);
	});

	test('revealExistingUsers: true keeps ExpiredCodeException', async () => {
		const h = await setup({ emailPassword: { revealExistingUsers: true } });
		await h.auth.resetPassword(CONFIRMED);
		expireCodes();
		const e = await rejection(
			h.auth.confirmResetPassword(CONFIRMED, h.last(CONFIRMED, 'resetPassword'), 'NewPassw0rd!'),
		);
		assert.strictEqual(wireView(e).name, AuthErrors.ExpiredCode);
	});
});

describe('mock enumeration (FX3): sign-in', () => {
	test('a wrong password is byte-identical for unknown, unconfirmed and confirmed users', async () => {
		const h = await setup();
		const seen = new Set<string>();
		for (const username of Object.values(USERS)) {
			seen.add(
				observedOf(await rejection(new Browser().request((ctx) => h.auth.signIn(username, 'Wr0ng!pass', ctx)))),
			);
		}
		assert.strictEqual(seen.size, 1);
	});

	/** A next step without its (random, per-challenge) session token. */
	function shape(step: SignInNextStep): string {
		const { session: _session, ...rest } = { session: '', ...step };
		return JSON.stringify(rest);
	}

	test('USER_AUTH start: an unknown user gets the same first-factor steps as a real one', async () => {
		const h = await setup({ users: { authFlow: 'USER_AUTH' } });
		const run = async (username: string) => {
			const b = new Browser();
			const steps: string[] = [];
			const start = await b.request((ctx) => h.auth.signIn(username, '', ctx));
			assert.strictEqual(start.status, 'continueSignIn', username);
			if (start.status !== 'continueSignIn') return steps;
			steps.push(shape(start.nextStep));
			const select = 'session' in start.nextStep ? start.nextStep.session : '';
			// The password leg: a wrong password is the uniform credential failure.
			const pw = await b.request((ctx) => h.auth.confirmSignIn(select, 'PASSWORD', ctx));
			if (pw.status !== 'continueSignIn') return steps;
			steps.push(shape(pw.nextStep));
			const pwSession = 'session' in pw.nextStep ? pw.nextStep.session : '';
			steps.push(
				observedOf(await rejection(b.request((ctx) => h.auth.confirmSignIn(pwSession, 'Wr0ng!pass', ctx)))),
			);
			// The passwordless leg: a wrong one-time code is the uniform wrong-code failure.
			const again = await b.request((ctx) => h.auth.signIn(username, '', ctx));
			const select2 =
				again.status === 'continueSignIn' && 'session' in again.nextStep ? again.nextStep.session : '';
			const otp = await b.request((ctx) => h.auth.confirmSignIn(select2, 'EMAIL_OTP', ctx));
			if (otp.status !== 'continueSignIn') return steps;
			steps.push(shape(otp.nextStep));
			const otpSession = 'session' in otp.nextStep ? otp.nextStep.session : '';
			steps.push(
				observedOf(await rejection(b.request((ctx) => h.auth.confirmSignIn(otpSession, '000000', ctx)))),
			);
			return steps;
		};
		const real = await run(CONFIRMED);
		const unknown = await run(UNKNOWN);
		assert.strictEqual(real.length, 5);
		assert.deepStrictEqual(unknown, real);
		assert.deepStrictEqual(
			h.delivered.map((d) => d.username),
			[CONFIRMED],
			'no one-time code is sent for an unknown user',
		);
	});
});
