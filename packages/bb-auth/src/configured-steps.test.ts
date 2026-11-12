// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `signIn` returns only the steps its options can produce (`SignInNextStep<O>`),
 * and the block checks that at runtime too: a step the options do not enable
 * (the pool was configured outside the block, or a deploy is half-way) is a
 * clear `InternalErrorException`, never a step the caller's narrowed type says
 * cannot happen. A wrapped pool (`Auth.fromExisting`) is configured elsewhere,
 * so every step passes, as its type keeps every step.
 */

import assert from 'node:assert';
import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, test } from 'node:test';
import type { AuthState } from '@aws-blocks/auth-common';
import { ApiError } from '@aws-blocks/core';
import { AuthErrors } from './errors.js';
import { Auth } from './index.mock.js';
import { Browser, captureLogger, makeAuth } from './test-helpers.js';
import type { AuthOptions, SignInNextStep } from './types.js';

beforeEach(() => rmSync('.bb-data', { recursive: true, force: true }));
afterEach(() => rmSync('.bb-data', { recursive: true, force: true }));

const delivery = { destination: '+*******0100', deliveryMedium: 'SMS' as const, attributeName: 'phone_number' };
const STEPS = {
	sms: { name: 'CONFIRM_SIGN_IN_WITH_SMS_CODE', session: 's', codeDeliveryDetails: delivery },
	totp: { name: 'CONFIRM_SIGN_IN_WITH_TOTP_CODE', session: 's' },
	webauthn: { name: 'CONFIRM_SIGN_IN_WITH_WEB_AUTHN', session: 's', credentialRequestOptions: '{}' },
	firstFactor: {
		name: 'CONTINUE_SIGN_IN_WITH_FIRST_FACTOR_SELECTION',
		session: 's',
		availableChallenges: ['PASSWORD', 'EMAIL_OTP'],
	},
	newPassword: { name: 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED', session: 's' },
} satisfies Record<string, SignInNextStep>;

/** `setAuthState` on `auth`'s namespace, called the way the RPC layer does (untyped input, as from JavaScript). */
async function setAuthState(auth: { createApi(): unknown }, input: Record<string, string>): Promise<AuthState> {
	const api: unknown = auth.createApi();
	assert.ok(typeof api === 'function');
	return new Browser().request(async (ctx): Promise<AuthState> => {
		const handler: unknown = Reflect.apply(api, undefined, [ctx]);
		assert.ok(typeof handler === 'object' && handler !== null);
		const set: unknown = Reflect.get(handler, 'setAuthState');
		assert.ok(typeof set === 'function');
		return Reflect.apply(set, handler, [input]);
	});
}

/** Sign in against a scripted engine that answers with `step`; what the caller sees. */
async function signInWith(options: AuthOptions, step: SignInNextStep): Promise<string> {
	const h = makeAuth(options);
	h.native.addUser('alice');
	h.native.nextChallenge = step;
	try {
		const r = await new Browser().request((ctx) => h.auth.signIn('alice', 'Passw0rd!', ctx));
		return r.status === 'continueSignIn' ? r.nextStep.name : r.status;
	} catch (e) {
		assert.ok(e instanceof ApiError, `an ApiError, got ${String(e)}`);
		assert.strictEqual(e.status, 500);
		assert.match(e.message, new RegExp(`'${step.name}'`), 'the message names the step');
		return e.name;
	}
}

describe('sign-in steps are checked against the options at runtime', () => {
	test('the refusal is logged with the step and the configured steps, never the session', async () => {
		const { logger, entries } = captureLogger();
		const h = makeAuth({ logger });
		h.native.addUser('alice');
		h.native.nextChallenge = { ...STEPS.totp, session: 'secret-session-token' };
		await assert.rejects(new Browser().request((ctx) => h.auth.signIn('alice', 'Passw0rd!', ctx)));
		const line = entries.find((l) => l.message.includes('does not enable'));
		assert.ok(line, entries.map((l) => l.message).join('; '));
		assert.strictEqual(line.level, 'error');
		assert.strictEqual(line.context?.step, 'CONFIRM_SIGN_IN_WITH_TOTP_CODE');
		assert.deepStrictEqual(line.context?.configuredSteps, [
			'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED',
			'CONFIRM_SIGN_UP',
			'RESET_PASSWORD',
		]);
		assert.ok(!JSON.stringify(entries).includes('secret-session-token'), 'the session is not logged');
	});

	test('a step these options do not enable is an InternalErrorException naming it', async () => {
		assert.strictEqual(await signInWith({}, STEPS.totp), AuthErrors.InternalError, 'MFA off');
		assert.strictEqual(
			await signInWith({ mfa: { mode: 'optional', types: ['SMS'] } }, STEPS.totp),
			AuthErrors.InternalError,
			'TOTP not in mfa.types',
		);
		assert.strictEqual(await signInWith({}, STEPS.webauthn), AuthErrors.InternalError, 'passkeys off');
		assert.strictEqual(await signInWith({}, STEPS.firstFactor), AuthErrors.InternalError, 'USER_PASSWORD_AUTH');
	});

	test('the steps the options enable pass', async () => {
		assert.strictEqual(await signInWith({}, STEPS.newPassword), STEPS.newPassword.name);
		assert.strictEqual(await signInWith({ mfa: { mode: 'optional', types: ['SMS'] } }, STEPS.sms), STEPS.sms.name);
		assert.strictEqual(await signInWith({ mfa: 'required' }, STEPS.totp), STEPS.totp.name, 'default mfa.types');
		assert.strictEqual(
			await signInWith({ users: { authFlow: 'USER_AUTH' } }, STEPS.firstFactor),
			STEPS.firstFactor.name,
		);
		assert.strictEqual(
			await signInWith(
				{
					users: { authFlow: 'USER_AUTH' },
					passkeys: { relyingPartyId: 'example.com', origins: ['https://example.com'] },
					featurePlan: 'essentials',
				},
				STEPS.webauthn,
			),
			STEPS.webauthn.name,
		);
	});

	test('a wrapped pool (Auth.fromExisting) passes every step', async () => {
		const userPool = Auth.fromExisting('us-east-1_Imported', 'importedclient');
		for (const step of Object.values(STEPS)) {
			assert.strictEqual(await signInWith({ userPool }, step), step.name);
		}
	});

	test('through setAuthState, the refusal is an error state', async () => {
		const h = makeAuth({});
		h.native.addUser('alice');
		h.native.nextChallenge = STEPS.totp;
		const state = await setAuthState(h.auth, { action: 'signIn', username: 'alice', password: 'Passw0rd!' });
		assert.strictEqual(state.state, 'signedOut');
		assert.strictEqual(state.errorName, AuthErrors.InternalError);
	});

	test('signInWithPasskey from an untyped caller, with passkeys off: PasskeysNotEnabledException', async () => {
		const h = makeAuth({});
		h.native.addUser('alice');
		const state = await setAuthState(h.auth, { action: 'signInWithPasskey', username: 'alice' });
		assert.strictEqual(state.state, 'signedOut');
		assert.strictEqual(state.errorName, AuthErrors.PasskeysNotEnabled);
		assert.deepStrictEqual(h.native.calls, [], 'the engine is never asked');
	});
});
