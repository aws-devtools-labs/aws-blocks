// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Mock ↔ AWS parity for **where a password-reset code goes** (FX39, R75; from
 * R67's "Open"): `resetPassword` on the local engine (`./index.mock.js`) and on
 * the AWS entry (`./index.aws.js`, offline through
 * `test-support/aws-harness.ts`) must report the same delivery, or the same
 * masked answer, for a user in the same state.
 *
 * The local user is put into each state through the public API (sign-up,
 * attribute verification, MFA preference); the AWS side's `ForgotPassword` is
 * answered by {@link cognitoForgotPassword}, a stand-in that applies the
 * documented rule to that same state. Before FX39 the mock sent the code to
 * the email if there was one, else the phone, verified or not, and sent a
 * local code to a user with no verified contact at all.
 */

import assert from 'node:assert';
import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, test } from 'node:test';
import type { ScopeParent } from '@aws-blocks/core';
import { clientMessageFor } from './error-mapping.js';
import { AuthErrors } from './errors.js';
import { Auth as MockAuth } from './index.mock.js';
import { type AwsAuthHarness, Browser, cognitoError, makeAwsAuth, wireView } from './test-support/aws-harness.js';
import type { AuthOptions, CodeDeliveryPurpose, ResetPasswordResult } from './types.js';

beforeEach(() => rmSync('.bb-data', { recursive: true, force: true }));
afterEach(() => rmSync('.bb-data', { recursive: true, force: true }));

const PASSWORD = 'Passw0rd!';
const EMAIL = 'alice@example.com';
const PHONE = '+15555550100';
let n = 0;
const root = (): ScopeParent => ({ id: `parityreset${process.pid}x${++n}` });

/**
 * A stand-in for Cognito's `ForgotPassword` for one user, from the docs:
 *
 * - "`ForgotPassword` sends a recovery code to a verified email or a verified
 *   phone number … Amazon Cognito chooses the code delivery destination based
 *   on the priority that you set." / "Amazon Cognito sends a verification to
 *   only one of the specified methods." The pool `Auth` provisions has
 *   `RecoveryMechanisms: [verified_phone_number (1), verified_email (2)]` (CDK's
 *   default `AccountRecovery.PHONE_WITHOUT_MFA_AND_EMAIL`; every template in
 *   `__fixtures__/authcognito-templates.json`), which is also Cognito's order
 *   without a setting: "sends the recovery code to a verified phone number
 *   first, and to a verified email address if users don't have a phone number
 *   attribute."
 *   (<https://docs.aws.amazon.com/cognito/latest/developerguide/how-to-recover-a-user-account.html>)
 * - "Users whose preferred MFA is by email message can't receive a
 *   password-reset code by email. Users whose preferred MFA is by SMS message
 *   can't receive a password-reset code by SMS." (same page)
 * - "If neither a verified phone number nor a verified email exists, Amazon
 *   Cognito responds with an `InvalidParameterException` error." / "Amazon
 *   Cognito replies to password-reset requests from users who don't have a
 *   valid recovery method with an `InvalidParameterException` error response."
 *   (<https://docs.aws.amazon.com/cognito-user-identity-pools/latest/APIReference/API_ForgotPassword.html>)
 */
function cognitoForgotPassword(
	h: Pick<AwsAuthHarness<AuthOptions>, 'on'>,
	user: { attributes: Partial<Record<string, string>>; preferredMfa?: string },
) {
	const calls: string[] = [];
	h.on('ForgotPasswordCommand', () => {
		for (const [name, factor, medium, destination] of [
			['phone_number', 'SMS', 'SMS', '+*******0100'],
			['email', 'EMAIL', 'EMAIL', 'a***@e***'],
		] as const) {
			if (!user.attributes[name] || user.attributes[`${name}_verified`] !== 'true') continue;
			if (user.preferredMfa === factor) continue;
			calls.push(name);
			return { CodeDeliveryDetails: { Destination: destination, DeliveryMedium: medium, AttributeName: name } };
		}
		calls.push('rejected');
		throw cognitoError(
			'InvalidParameterException',
			'Cannot reset password for the user as there is no registered/verified email or phone_number',
		);
	});
	return calls;
}

interface Setup {
	/** Verify the phone after sign-up (`sendUserAttributeVerificationCode` → `confirmUserAttribute`). */
	verifyPhone?: boolean;
	/** Make SMS the preferred MFA factor. */
	preferSms?: boolean;
}

/**
 * Sign `alice` up locally with `contact`, confirm her, apply `setup`, and
 * return the local `Auth`, the reset codes it delivered, and her state (as
 * {@link cognitoForgotPassword} takes it).
 */
async function localUser<const O extends AuthOptions>(options: O, contact: Record<string, string>, setup: Setup = {}) {
	const codes: { purpose: CodeDeliveryPurpose; code: string }[] = [];
	const auth: MockAuth = new MockAuth(root(), 'auth', {
		...options,
		codeDelivery: async (_u: string, code: string, purpose: CodeDeliveryPurpose) => {
			codes.push({ purpose, code });
		},
	});
	const last = (purpose: CodeDeliveryPurpose) => [...codes].reverse().find((c) => c.purpose === purpose)?.code ?? '';
	await auth.signUp('alice', PASSWORD, { attributes: contact });
	await auth.confirmSignUp('alice', last('signUp'));
	const browser = new Browser();
	const r = await browser.request((ctx) => auth.signIn('alice', PASSWORD, ctx));
	assert.strictEqual(r.status, 'signedIn');
	if (setup.verifyPhone) {
		await browser.request((ctx) => auth.sendUserAttributeVerificationCode(ctx, 'phone_number'));
		await browser.request((ctx) => auth.confirmUserAttribute(ctx, 'phone_number', last('attribute')));
	}
	if (setup.preferSms) await browser.request((ctx) => auth.updateMfaPreference(ctx, { sms: 'PREFERRED' }));
	const attributes = await browser.request((ctx) => auth.getUserAttributes(ctx));
	// `getMfaPreference` needs MFA on; with it off there is no preferred factor.
	const preferred = setup.preferSms
		? (await browser.request((ctx) => auth.getMfaPreference(ctx))).preferred
		: undefined;
	const resetCodes = () => codes.filter((c) => c.purpose === 'resetPassword').length;
	return { auth, attributes, preferredMfa: preferred, resetCodes };
}

/** `resetPassword('alice')` on both runtimes for the same user state. */
async function bothRuntimes<const O extends AuthOptions>(options: O, contact: Record<string, string>, setup?: Setup) {
	const local = await localUser(options, contact, setup);
	const h = makeAwsAuth(options);
	const forgot = cognitoForgotPassword(h, {
		attributes: local.attributes,
		...(local.preferredMfa ? { preferredMfa: local.preferredMfa } : {}),
	});
	const settle = (p: Promise<ResetPasswordResult>) =>
		p.then(
			(r) => {
				const delivery = r.nextStep?.codeDeliveryDetails;
				return { deliveryMedium: delivery?.deliveryMedium, attributeName: delivery?.attributeName };
			},
			(e: unknown) => {
				const { name, code, retriable, message } = wireView(e);
				return { error: { name, code, retriable, message } };
			},
		);
	const mock = await settle(local.auth.resetPassword('alice'));
	const wide: MockAuth = h.auth;
	const aws = await settle(wide.resetPassword('alice'));
	return { mock, aws, mockResetCodes: local.resetCodes(), forgot };
}

const SMS = { deliveryMedium: 'SMS', attributeName: 'phone_number' } as const;
const EMAIL_DELIVERY = { deliveryMedium: 'EMAIL', attributeName: 'email' } as const;

describe('parity: resetPassword sends the code to a verified contact, by the pool’s recovery priority (R75)', () => {
	test('the default pool, a verified email only: by email', async () => {
		const r = await bothRuntimes({}, { email: EMAIL });
		assert.deepStrictEqual(r.mock, EMAIL_DELIVERY, 'mock');
		assert.deepStrictEqual(r.aws, EMAIL_DELIVERY, 'aws');
		assert.strictEqual(r.mockResetCodes, 1);
	});

	test('the default pool, a verified email and an unverified phone: by email, not to the phone', async () => {
		// The sign-up code verifies the email only (R67); the phone stays unverified.
		const r = await bothRuntimes({}, { email: EMAIL, phone_number: PHONE });
		assert.deepStrictEqual(r.mock, EMAIL_DELIVERY, 'mock');
		assert.deepStrictEqual(r.aws, EMAIL_DELIVERY, 'aws');
	});

	test('email and phone both auto-verified: the sign-up verified the phone, so by SMS, never to the unverified email', async () => {
		const r = await bothRuntimes(
			{ users: { signInWith: ['username', 'email', 'phone'] } },
			{
				email: EMAIL,
				phone_number: PHONE,
			},
		);
		assert.deepStrictEqual(r.mock, SMS, 'mock');
		assert.deepStrictEqual(r.aws, SMS, 'aws');
	});

	test('both contacts verified: the phone first (priority 1)', async () => {
		const r = await bothRuntimes({}, { email: EMAIL, phone_number: PHONE }, { verifyPhone: true });
		assert.deepStrictEqual(r.mock, SMS, 'mock');
		assert.deepStrictEqual(r.aws, SMS, 'aws');
	});

	test('both verified and SMS is the preferred MFA factor: by email, not the MFA factor', async () => {
		const options = { mfa: { mode: 'optional', types: ['SMS', 'TOTP'] } } as const;
		const r = await bothRuntimes(
			options,
			{ email: EMAIL, phone_number: PHONE },
			{ verifyPhone: true, preferSms: true },
		);
		assert.deepStrictEqual(r.mock, EMAIL_DELIVERY, 'mock');
		assert.deepStrictEqual(r.aws, EMAIL_DELIVERY, 'aws');
	});

	describe("no verified contact (`signInWith: ['username']` auto-verifies nothing)", () => {
		const NONE = { users: { signInWith: ['username'] } } as const;

		test('masked (the default): the same plausible delivery as an unknown user, and no code is sent', async () => {
			const r = await bothRuntimes(NONE, { email: EMAIL });
			assert.deepStrictEqual(r.forgot, ['rejected'], 'Cognito refused it');
			for (const [label, view] of [
				['mock', r.mock],
				['aws', r.aws],
			] as const) {
				assert.ok(!('error' in view), `${label}: answered as a success`);
			}
			assert.strictEqual(r.mockResetCodes, 0, 'mock: no code delivered');
		});

		test('`revealExistingUsers`: InvalidParameterException 400, retriable, in both runtimes', async () => {
			const r = await bothRuntimes({ ...NONE, emailPassword: { revealExistingUsers: true } }, { email: EMAIL });
			const expected = {
				error: {
					name: 'InvalidParameterException',
					code: 400,
					retriable: true,
					message: clientMessageFor(AuthErrors.InvalidParameter),
				},
			};
			assert.deepStrictEqual(r.mock, expected, 'mock');
			assert.deepStrictEqual(r.aws, expected, 'aws');
			assert.strictEqual(r.mockResetCodes, 0, 'mock: no code delivered');
		});
	});
});
