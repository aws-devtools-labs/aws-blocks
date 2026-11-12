// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The local engine's cap on wrong verification-code guesses
 * (`MockStore.verifyCode`): after {@link MAX_CODE_ATTEMPTS} wrong guesses a
 * code is invalidated and answered `LimitExceededException`, the name the
 * Cognito engine passes through for the same situation; a code issued again
 * inherits the count, so requesting codes buys no extra guesses; the count
 * ends with its window, and survives a dev-server restart. Parity: the AWS
 * entry reports Cognito's `LimitExceededException` from `ConfirmForgotPassword`
 * on the wire exactly as the local engine reports its own.
 */

import assert from 'node:assert';
import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { ApiError } from '@aws-blocks/core';
import { CODE_ATTEMPT_WINDOW_MS, MAX_CODE_ATTEMPTS, type MockState } from './engines/native-mock-store.js';
import { AuthErrors } from './errors.js';
import { Auth } from './index.mock.js';
import { Browser } from './test-helpers.js';
import { cognitoError, makeAwsAuth, wireView } from './test-support/aws-harness.js';
import type { CodeDeliveryPurpose } from './types.js';

beforeEach(() => rmSync('.bb-data', { recursive: true, force: true }));
afterEach(() => rmSync('.bb-data', { recursive: true, force: true }));

const PASSWORD = 'Passw0rd!';
const NEW_PASSWORD = 'NewPassw0rd!';
let counter = 0;
const root = () => ({ id: `ca${process.pid}x${++counter}` });

function codeSink() {
	const sent: { username: string; code: string; purpose: CodeDeliveryPurpose }[] = [];
	return {
		deliver: async (username: string, code: string, purpose: CodeDeliveryPurpose) => {
			sent.push({ username, code, purpose });
		},
		last(purpose: CodeDeliveryPurpose): string {
			const match = [...sent].reverse().find((s) => s.purpose === purpose);
			assert.ok(match, `a ${purpose} code was delivered`);
			return match.code;
		},
	};
}

/** A six-digit code that is not `code`. */
function wrong(code: string): string {
	return code === '000000' ? '111111' : '000000';
}

async function observe(p: Promise<unknown>): Promise<{ name: string; status: number } | 'ok'> {
	try {
		await p;
		return 'ok';
	} catch (e) {
		assert.ok(e instanceof ApiError, `an ApiError, got ${String(e)}`);
		return { name: e.name, status: e.status };
	}
}

/** The local engine's in-memory state (test plumbing). */
function mockState(auth: object): MockState {
	const store: unknown = Reflect.get(Reflect.get(auth, 'native'), 'store');
	assert.ok(typeof store === 'object' && store !== null);
	const state: unknown = Reflect.get(store, 'state');
	assert.ok(typeof state === 'object' && state !== null);
	return state as MockState;
}

async function registered(id = root()) {
	const sink = codeSink();
	const auth = new Auth(id, 'auth', { codeDelivery: sink.deliver });
	await auth.signUp('ana', PASSWORD, { attributes: { email: 'ana@example.com' } });
	await auth.confirmSignUp('ana', sink.last('signUp'));
	return { auth, sink };
}

describe('mock engine — wrong verification-code guesses are capped', () => {
	test(`the ${MAX_CODE_ATTEMPTS}th wrong reset code invalidates the code: LimitExceededException (429), even for the right code`, async () => {
		const { auth, sink } = await registered();
		await auth.resetPassword('ana');
		const code = sink.last('resetPassword');
		for (let i = 1; i < MAX_CODE_ATTEMPTS; i++) {
			assert.deepStrictEqual(await observe(auth.confirmResetPassword('ana', wrong(code), NEW_PASSWORD)), {
				name: AuthErrors.CodeMismatch,
				status: 400,
			});
		}
		const capped = { name: AuthErrors.LimitExceeded, status: 429 };
		assert.deepStrictEqual(await observe(auth.confirmResetPassword('ana', wrong(code), NEW_PASSWORD)), capped);
		assert.deepStrictEqual(await observe(auth.confirmResetPassword('ana', code, NEW_PASSWORD)), capped);
		// The password did not change.
		assert.strictEqual(
			(await new Browser().request((ctx) => auth.signIn('ana', PASSWORD, ctx))).status,
			'signedIn',
		);
	});

	test('requesting a new code does not reset the count: a capped key stays capped', async () => {
		const { auth, sink } = await registered();
		await auth.resetPassword('ana');
		for (let i = 0; i < MAX_CODE_ATTEMPTS - 1; i++) {
			await observe(auth.confirmResetPassword('ana', wrong(sink.last('resetPassword')), NEW_PASSWORD));
		}
		// A fresh code inherits the four counted guesses: one more wrong one caps it.
		await auth.resetPassword('ana');
		assert.deepStrictEqual(
			await observe(auth.confirmResetPassword('ana', wrong(sink.last('resetPassword')), NEW_PASSWORD)),
			{ name: AuthErrors.LimitExceeded, status: 429 },
		);
		await auth.resetPassword('ana');
		assert.deepStrictEqual(
			await observe(auth.confirmResetPassword('ana', sink.last('resetPassword'), NEW_PASSWORD)),
			{ name: AuthErrors.LimitExceeded, status: 429 },
			'a code issued during the lockout is refused too',
		);
	});

	test('the lockout ends with its window; a new code then works, and a correct code clears the count', async () => {
		const { auth, sink } = await registered();
		await auth.resetPassword('ana');
		for (let i = 0; i < MAX_CODE_ATTEMPTS; i++) {
			await observe(auth.confirmResetPassword('ana', wrong(sink.last('resetPassword')), NEW_PASSWORD));
		}
		const entry = mockState(auth).codes['resetPassword:ana'];
		assert.ok(entry?.failuresSince !== undefined);
		assert.strictEqual(entry.failures, MAX_CODE_ATTEMPTS);
		assert.strictEqual(entry.code, '', 'the capped code is invalidated');
		entry.failuresSince -= CODE_ATTEMPT_WINDOW_MS;

		await auth.resetPassword('ana');
		assert.strictEqual(mockState(auth).codes['resetPassword:ana']?.failures, undefined, 'a stale count is dropped');
		assert.strictEqual(
			await observe(auth.confirmResetPassword('ana', sink.last('resetPassword'), NEW_PASSWORD)),
			'ok',
		);
		assert.strictEqual(mockState(auth).codes['resetPassword:ana'], undefined, 'consumed with its count');
	});

	test('the count survives a dev-server restart (it is persisted with the code)', async () => {
		const id = root();
		const { auth, sink } = await registered(id);
		await auth.resetPassword('ana');
		for (let i = 0; i < MAX_CODE_ATTEMPTS; i++) {
			await observe(auth.confirmResetPassword('ana', wrong(sink.last('resetPassword')), NEW_PASSWORD));
		}
		const restarted = new Auth(id, 'auth', { codeDelivery: sink.deliver });
		await restarted.resetPassword('ana');
		assert.deepStrictEqual(
			await observe(restarted.confirmResetPassword('ana', sink.last('resetPassword'), NEW_PASSWORD)),
			{ name: AuthErrors.LimitExceeded, status: 429 },
		);
	});

	test('the cap applies to sign-up confirmation codes too', async () => {
		const sink = codeSink();
		const auth = new Auth(root(), 'auth', { codeDelivery: sink.deliver });
		await auth.signUp('bo', PASSWORD, { attributes: { email: 'bo@example.com' } });
		const code = sink.last('signUp');
		for (let i = 1; i < MAX_CODE_ATTEMPTS; i++) {
			assert.deepStrictEqual(await observe(auth.confirmSignUp('bo', wrong(code))), {
				name: AuthErrors.CodeMismatch,
				status: 400,
			});
		}
		assert.deepStrictEqual(await observe(auth.confirmSignUp('bo', wrong(code))), {
			name: AuthErrors.LimitExceeded,
			status: 429,
		});
		assert.deepStrictEqual(await observe(auth.confirmSignUp('bo', code)), {
			name: AuthErrors.LimitExceeded,
			status: 429,
		});
	});

	test('wrong guesses for one user never cap another', async () => {
		const { auth, sink } = await registered();
		await auth.signUp('cy', PASSWORD, { attributes: { email: 'cy@example.com' } });
		await auth.confirmSignUp('cy', sink.last('signUp'));
		await auth.resetPassword('ana');
		const anaCode = sink.last('resetPassword');
		for (let i = 0; i < MAX_CODE_ATTEMPTS; i++) {
			await observe(auth.confirmResetPassword('ana', wrong(anaCode), NEW_PASSWORD));
		}
		await auth.resetPassword('cy');
		assert.strictEqual(
			await observe(auth.confirmResetPassword('cy', sink.last('resetPassword'), NEW_PASSWORD)),
			'ok',
		);
	});
});

describe('parity: a capped confirmation code', () => {
	test('the AWS entry reports Cognito’s LimitExceededException exactly as the local engine reports its own', async () => {
		const { auth, sink } = await registered();
		await auth.resetPassword('ana');
		const code = sink.last('resetPassword');
		let local: unknown;
		for (let i = 0; i < MAX_CODE_ATTEMPTS; i++) {
			local = await auth.confirmResetPassword('ana', wrong(code), NEW_PASSWORD).then(
				() => assert.fail('expected a rejection'),
				(e: unknown) => e,
			);
		}

		const h = makeAwsAuth();
		h.on('ConfirmForgotPasswordCommand', () => {
			throw cognitoError('LimitExceededException', 'Attempt limit exceeded, please try after some time.');
		});
		const aws = await h.auth.confirmResetPassword('ana', '000000', NEW_PASSWORD).then(
			() => assert.fail('expected a rejection'),
			(e: unknown) => e,
		);
		assert.deepStrictEqual(wireView(aws), wireView(local));
		assert.strictEqual(wireView(aws).name, AuthErrors.LimitExceeded);
		assert.strictEqual(wireView(aws).code, 429);
	});
});
