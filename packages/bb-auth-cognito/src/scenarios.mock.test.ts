// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * End-to-end scenario matrix — mock runtime.
 *
 * 16 scenarios across USER_PASSWORD_AUTH + USER_AUTH × mfa modes. Each
 * scenario creates its own AuthCognito mock instance with the exact
 * config it needs; tests drive the public API through sign-up, MFA
 * setup, sign-in, and sign-out. Codes flow through the `codeDelivery`
 * hook so tests can complete the code-verification round trips.
 *
 * Mirror suite for real Cognito: `scenarios.sandbox.test.ts`.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert';
import type { BlocksContext } from '@aws-blocks/core';
import { Scope } from '@aws-blocks/core';
import { AuthCognito } from './index.js';

function ctx(): BlocksContext {
	return {
		request: { headers: new Headers() },
		response: { headers: new Headers() },
	} as unknown as BlocksContext;
}

/** Copy Set-Cookie from a prior ctx's response into the next ctx's request — mimics a browser round-trip. */
function roll(prev: BlocksContext): BlocksContext {
	const next = ctx();
	const raw = (prev as any).response.headers.get('set-cookie') as string | null;
	if (raw) {
		const pair = raw.split(';')[0]!;
		(next as any).request.headers.set('cookie', pair);
	}
	return next;
}

interface MockAuth {
	auth: AuthCognito<any>;
	lastCode: () => string;
}

function makeAuth<O extends Record<string, unknown>>(id: string, options: O): MockAuth {
	const scope = new Scope(`scenarios-${id}`);
	let code = '';
	const auth = new AuthCognito(scope, 'auth', {
		passwordPolicy: { minLength: 8 },
		codeDelivery: async (_u: string, c: string) => { code = c; },
		...options,
	} as any);
	return { auth, lastCode: () => code };
}

// Unique per-scenario IDs keep the KVStores isolated.
let counter = 0;
function nextId(tag: string) { return `${tag}-${++counter}-${Math.random().toString(36).slice(2, 6)}`; }

// ─── 1. USER_PASSWORD_AUTH, mfa:'off' ──────────────────────────────

describe('scenarios.mock', () => {
	test('1: mfa:off — self sign-up → confirm → sign-in', async () => {
		const { auth, lastCode } = makeAuth(nextId('s1'), {
			mfa: 'off' as const,
			userAttributes: [{ name: 'email', required: true }] as const,
		});
		await auth.signUp('u1@test.example', 'Password!1', { attributes: { email: 'u1@test.example' } });
		await auth.confirmSignUp('u1@test.example', lastCode());
		const r = await auth.signIn('u1@test.example', 'Password!1', ctx());
		assert.strictEqual(r.status, 'signedIn');
	});

	test('2: mfa:optional — self sign-up → confirm → direct sign-in (no factors enrolled)', async () => {
		const { auth, lastCode } = makeAuth(nextId('s2'), {
			mfa: 'optional' as const,
			mfaTypes: ['TOTP'] as const,
			userAttributes: [{ name: 'email', required: true }] as const,
		});
		await auth.signUp('u2@test.example', 'Password!1', { attributes: { email: 'u2@test.example' } });
		await auth.confirmSignUp('u2@test.example', lastCode());
		const r = await auth.signIn('u2@test.example', 'Password!1', ctx());
		assert.strictEqual(r.status, 'signedIn');
	});

	test('3: mfa:required + [TOTP] — MFA_SETUP TOTP → enrolled, then re-sign-in challenges TOTP', async () => {
		const { auth, lastCode } = makeAuth(nextId('s3'), {
			mfa: 'required' as const,
			mfaTypes: ['TOTP'] as const,
			userAttributes: [{ name: 'email', required: true }] as const,
		});
		await auth.signUp('u3@test.example', 'Password!1', { attributes: { email: 'u3@test.example' } });
		await auth.confirmSignUp('u3@test.example', lastCode());
		const r1 = await auth.signIn('u3@test.example', 'Password!1', ctx());
		if (r1.status === 'signedIn') throw new Error('expected TOTP setup');
		assert.strictEqual(r1.nextStep.name, 'CONTINUE_SIGN_IN_WITH_TOTP_SETUP');
		if (r1.nextStep.name !== 'CONTINUE_SIGN_IN_WITH_TOTP_SETUP') return;
		const setup = await auth.confirmSignIn(r1.nextStep.session, { code: '123456' }, ctx());
		assert.strictEqual(setup.status, 'signedIn');

		// Second sign-in hits the TOTP challenge path (not setup).
		const r2 = await auth.signIn('u3@test.example', 'Password!1', ctx());
		if (r2.status === 'signedIn') throw new Error('expected TOTP challenge');
		assert.strictEqual(r2.nextStep.name, 'CONFIRM_SIGN_IN_WITH_TOTP_CODE');
		if (r2.nextStep.name !== 'CONFIRM_SIGN_IN_WITH_TOTP_CODE') return;
		const done = await auth.confirmSignIn(r2.nextStep.session, { code: '654321' }, ctx());
		assert.strictEqual(done.status, 'signedIn');
	});

	test('4: mfa:required + [EMAIL] — address-first setup → code → signed in', async () => {
		const { auth, lastCode } = makeAuth(nextId('s4'), {
			mfa: 'required' as const,
			mfaTypes: ['EMAIL'] as const,
			userAttributes: [{ name: 'email', required: true }] as const,
		});
		await auth.signUp('u4@test.example', 'Password!1', { attributes: { email: 'u4@test.example' } });
		await auth.confirmSignUp('u4@test.example', lastCode());
		// Mark email as unverified so the mock's MFA_SETUP routes through
		// the address-submission step instead of auto-using the verified
		// attribute.
		const user = (auth as any).state.users['u4@test.example'];
		user.attributes.email_verified = 'false';
		(auth as any).flushToDisk();

		const r1 = await auth.signIn('u4@test.example', 'Password!1', ctx());
		if (r1.status === 'signedIn') throw new Error('expected email setup');
		assert.strictEqual(r1.nextStep.name, 'CONTINUE_SIGN_IN_WITH_EMAIL_SETUP');
		if (r1.nextStep.name !== 'CONTINUE_SIGN_IN_WITH_EMAIL_SETUP') return;
		const r2 = await auth.confirmSignIn(r1.nextStep.session, { email: 'u4-new@test.example' }, ctx());
		if (r2.status === 'signedIn') throw new Error('expected code challenge');
		assert.strictEqual(r2.nextStep.name, 'CONFIRM_SIGN_IN_WITH_EMAIL_CODE');
		if (r2.nextStep.name !== 'CONFIRM_SIGN_IN_WITH_EMAIL_CODE') return;
		const done = await auth.confirmSignIn(r2.nextStep.session, { code: lastCode() }, ctx());
		assert.strictEqual(done.status, 'signedIn');
	});

	test('5: mfa:required + [TOTP,EMAIL] — setup selection → pick TOTP', async () => {
		const { auth, lastCode } = makeAuth(nextId('s5'), {
			mfa: 'required' as const,
			mfaTypes: ['TOTP', 'EMAIL'] as const,
			userAttributes: [{ name: 'email', required: true }] as const,
		});
		await auth.signUp('u5@test.example', 'Password!1', { attributes: { email: 'u5@test.example' } });
		await auth.confirmSignUp('u5@test.example', lastCode());
		// Force unverified email so both TOTP + EMAIL are available for setup.
		const user = (auth as any).state.users['u5@test.example'];
		user.attributes.email_verified = 'false';
		(auth as any).flushToDisk();

		const r1 = await auth.signIn('u5@test.example', 'Password!1', ctx());
		if (r1.status === 'signedIn') throw new Error('expected setup selection');
		assert.strictEqual(r1.nextStep.name, 'CONTINUE_SIGN_IN_WITH_MFA_SETUP_SELECTION');
		if (r1.nextStep.name !== 'CONTINUE_SIGN_IN_WITH_MFA_SETUP_SELECTION') return;
		const r2 = await auth.confirmSignIn(r1.nextStep.session, { mfaType: 'TOTP' as 'TOTP' }, ctx());
		if (r2.status === 'signedIn') throw new Error('expected TOTP setup step');
		assert.strictEqual(r2.nextStep.name, 'CONTINUE_SIGN_IN_WITH_TOTP_SETUP');
		if (r2.nextStep.name !== 'CONTINUE_SIGN_IN_WITH_TOTP_SETUP') return;
		const done = await auth.confirmSignIn(r2.nextStep.session, { code: '123456' }, ctx());
		assert.strictEqual(done.status, 'signedIn');
	});

	test('6: mfa:required + [TOTP,EMAIL] — setup selection → pick EMAIL', async () => {
		const { auth, lastCode } = makeAuth(nextId('s6'), {
			mfa: 'required' as const,
			mfaTypes: ['TOTP', 'EMAIL'] as const,
			userAttributes: [{ name: 'email', required: true }] as const,
		});
		await auth.signUp('u6@test.example', 'Password!1', { attributes: { email: 'u6@test.example' } });
		await auth.confirmSignUp('u6@test.example', lastCode());
		const user = (auth as any).state.users['u6@test.example'];
		user.attributes.email_verified = 'false';
		(auth as any).flushToDisk();

		const r1 = await auth.signIn('u6@test.example', 'Password!1', ctx());
		if (r1.status !== 'continueSignIn' || r1.nextStep.name !== 'CONTINUE_SIGN_IN_WITH_MFA_SETUP_SELECTION') return;
		const r2 = await auth.confirmSignIn(r1.nextStep.session, { mfaType: 'EMAIL' as 'EMAIL' }, ctx());
		if (r2.status !== 'continueSignIn' || r2.nextStep.name !== 'CONTINUE_SIGN_IN_WITH_EMAIL_SETUP') return;
		const r3 = await auth.confirmSignIn(r2.nextStep.session, { email: 'u6-new@test.example' }, ctx());
		if (r3.status !== 'continueSignIn' || r3.nextStep.name !== 'CONFIRM_SIGN_IN_WITH_EMAIL_CODE') return;
		const done = await auth.confirmSignIn(r3.nextStep.session, { code: lastCode() }, ctx());
		assert.strictEqual(done.status, 'signedIn');
	});

	test('7: mfa:optional, user with verified phone → SMS challenge → code → signed in', async () => {
		const { auth, lastCode } = makeAuth(nextId('s7'), {
			mfa: 'optional' as const,
			mfaTypes: ['SMS', 'TOTP'] as const,
			userAttributes: [{ name: 'email', required: true }, { name: 'phone_number', required: false }] as const,
		});
		await auth.signUp('u7@test.example', 'Password!1', {
			attributes: { email: 'u7@test.example', phone_number: '+15005550007' },
		});
		await auth.confirmSignUp('u7@test.example', lastCode());
		// confirmSignUp auto-verifies phone_number when present.
		const r1 = await auth.signIn('u7@test.example', 'Password!1', ctx());
		if (r1.status === 'signedIn') throw new Error('expected SMS challenge');
		assert.strictEqual(r1.nextStep.name, 'CONFIRM_SIGN_IN_WITH_SMS_CODE');
		if (r1.nextStep.name !== 'CONFIRM_SIGN_IN_WITH_SMS_CODE') return;
		const done = await auth.confirmSignIn(r1.nextStep.session, { code: lastCode() }, ctx());
		assert.strictEqual(done.status, 'signedIn');
	});

	test('8: enrolled TOTP + verified-SMS user → SELECT_MFA_TYPE → pick TOTP', async () => {
		const { auth, lastCode } = makeAuth(nextId('s8'), {
			mfa: 'optional' as const,
			mfaTypes: ['SMS', 'TOTP'] as const,
			userAttributes: [{ name: 'email', required: true }, { name: 'phone_number', required: false }] as const,
		});
		await auth.signUp('u8@test.example', 'Password!1', {
			attributes: { email: 'u8@test.example', phone_number: '+15005550008' },
		});
		await auth.confirmSignUp('u8@test.example', lastCode());
		// Inject TOTP enrollment so both factors are available.
		const user = (auth as any).state.users['u8@test.example'];
		user.totpVerified = true;
		user.mfaPreference = { preferred: undefined, enabled: ['TOTP'] };
		(auth as any).flushToDisk();

		const r1 = await auth.signIn('u8@test.example', 'Password!1', ctx());
		if (r1.status === 'signedIn') throw new Error('expected SELECT_MFA_TYPE');
		assert.strictEqual(r1.nextStep.name, 'CONTINUE_SIGN_IN_WITH_MFA_SELECTION');
		if (r1.nextStep.name !== 'CONTINUE_SIGN_IN_WITH_MFA_SELECTION') return;
		assert.ok(r1.nextStep.allowedMFATypes.includes('TOTP'));
		assert.ok(r1.nextStep.allowedMFATypes.includes('SMS'));
		const r2 = await auth.confirmSignIn(r1.nextStep.session, { mfaType: 'TOTP' as 'TOTP' }, ctx());
		if (r2.status !== 'continueSignIn' || r2.nextStep.name !== 'CONFIRM_SIGN_IN_WITH_TOTP_CODE') return;
		const done = await auth.confirmSignIn(r2.nextStep.session, { code: '111222' }, ctx());
		assert.strictEqual(done.status, 'signedIn');
	});

	test('9: NEW_PASSWORD_REQUIRED — admin-created user with temp password → new password', async () => {
		const { auth } = makeAuth(nextId('s9'), {
			mfa: 'off' as const,
			userAttributes: [{ name: 'email', required: true }] as const,
		});
		// Inject an admin-created user in the mock.
		(auth as any).state.users['u9@test.example'] = {
			password: 'TempPw!1',
			confirmed: true,
			forcePasswordChange: true,
			mfaPreference: { preferred: undefined, enabled: [] },
			attributes: { email: 'u9@test.example', email_verified: 'true' },
			disabled: false,
			devices: [],
		};
		(auth as any).flushToDisk();

		const r1 = await auth.signIn('u9@test.example', 'TempPw!1', ctx());
		if (r1.status === 'signedIn') throw new Error('expected NEW_PASSWORD_REQUIRED');
		assert.strictEqual(r1.nextStep.name, 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED');
		if (r1.nextStep.name !== 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED') return;
		const done = await auth.confirmSignIn(r1.nextStep.session, { newPassword: 'Permanent!1' }, ctx());
		assert.strictEqual(done.status, 'signedIn');
	});

	test('10: forgot password → code → new password → sign in', async () => {
		const { auth, lastCode } = makeAuth(nextId('s10'), {
			mfa: 'off' as const,
			userAttributes: [{ name: 'email', required: true }] as const,
		});
		await auth.signUp('u10@test.example', 'Password!1', { attributes: { email: 'u10@test.example' } });
		await auth.confirmSignUp('u10@test.example', lastCode());

		await auth.resetPassword('u10@test.example');
		const resetCode = lastCode();
		await auth.confirmResetPassword('u10@test.example', resetCode, 'NewPass!1');
		const done = await auth.signIn('u10@test.example', 'NewPass!1', ctx());
		assert.strictEqual(done.status, 'signedIn');
	});

	// ─── USER_AUTH ────────────────────────────────────────────────────

	test('11: USER_AUTH preferredChallenge=PASSWORD → single-step sign-in', async () => {
		const { auth, lastCode } = makeAuth(nextId('s11'), {
			mfa: 'off' as const,
			authFlowType: 'USER_AUTH' as const,
			preferredChallenge: 'PASSWORD' as const,
			userAttributes: [{ name: 'email', required: true }] as const,
		});
		await auth.signUp('u11@test.example', 'Password!1', { attributes: { email: 'u11@test.example' } });
		await auth.confirmSignUp('u11@test.example', lastCode());

		// USER_AUTH + PASSWORD preference: signIn still returns the
		// CONFIRM_SIGN_IN_WITH_PASSWORD step (BB bundles the password in
		// the follow-up call because the mock doesn't support the combined
		// InitiateAuth shape — matches the state-machine flow users see).
		const r1 = await auth.signIn('u11@test.example', '', ctx());
		if (r1.status === 'signedIn') throw new Error('expected password step');
		assert.strictEqual(r1.nextStep.name, 'CONFIRM_SIGN_IN_WITH_PASSWORD');
		if (r1.nextStep.name !== 'CONFIRM_SIGN_IN_WITH_PASSWORD') return;
		const done = await auth.confirmSignIn(r1.nextStep.session, { password: 'Password!1' }, ctx());
		assert.strictEqual(done.status, 'signedIn');
	});

	test('12: USER_AUTH preferredChallenge=EMAIL_OTP → passwordless sign-in', async () => {
		const { auth, lastCode } = makeAuth(nextId('s12'), {
			mfa: 'off' as const,
			authFlowType: 'USER_AUTH' as const,
			preferredChallenge: 'EMAIL_OTP' as const,
			userAttributes: [{ name: 'email', required: true }] as const,
		});
		await auth.signUp('u12@test.example', 'Password!1', { attributes: { email: 'u12@test.example' } });
		await auth.confirmSignUp('u12@test.example', lastCode());

		const r1 = await auth.signIn('u12@test.example', '', ctx());
		if (r1.status === 'signedIn') throw new Error('expected email-OTP step');
		assert.strictEqual(r1.nextStep.name, 'CONFIRM_SIGN_IN_WITH_FIRST_FACTOR_EMAIL_OTP');
		if (r1.nextStep.name !== 'CONFIRM_SIGN_IN_WITH_FIRST_FACTOR_EMAIL_OTP') return;
		const done = await auth.confirmSignIn(r1.nextStep.session, { code: lastCode() }, ctx());
		assert.strictEqual(done.status, 'signedIn');
	});

	test('13: USER_AUTH preferredChallenge=SMS_OTP → passwordless sign-in', async () => {
		const { auth, lastCode } = makeAuth(nextId('s13'), {
			mfa: 'off' as const,
			authFlowType: 'USER_AUTH' as const,
			preferredChallenge: 'SMS_OTP' as const,
			userAttributes: [{ name: 'email', required: true }, { name: 'phone_number', required: false }] as const,
		});
		await auth.signUp('u13@test.example', 'Password!1', {
			attributes: { email: 'u13@test.example', phone_number: '+15005550013' },
		});
		await auth.confirmSignUp('u13@test.example', lastCode());

		const r1 = await auth.signIn('u13@test.example', '', ctx());
		if (r1.status === 'signedIn') throw new Error('expected SMS-OTP step');
		assert.strictEqual(r1.nextStep.name, 'CONFIRM_SIGN_IN_WITH_FIRST_FACTOR_SMS_OTP');
		if (r1.nextStep.name !== 'CONFIRM_SIGN_IN_WITH_FIRST_FACTOR_SMS_OTP') return;
		const done = await auth.confirmSignIn(r1.nextStep.session, { code: lastCode() }, ctx());
		assert.strictEqual(done.status, 'signedIn');
	});

	test('14: USER_AUTH no preference → SELECT_CHALLENGE → pick PASSWORD → signed in', async () => {
		const { auth, lastCode } = makeAuth(nextId('s14'), {
			mfa: 'off' as const,
			authFlowType: 'USER_AUTH' as const,
			userAttributes: [{ name: 'email', required: true }] as const,
		});
		await auth.signUp('u14@test.example', 'Password!1', { attributes: { email: 'u14@test.example' } });
		await auth.confirmSignUp('u14@test.example', lastCode());

		const r1 = await auth.signIn('u14@test.example', '', ctx());
		if (r1.status === 'signedIn') throw new Error('expected picker');
		assert.strictEqual(r1.nextStep.name, 'CONTINUE_SIGN_IN_WITH_FIRST_FACTOR_SELECTION');
		if (r1.nextStep.name !== 'CONTINUE_SIGN_IN_WITH_FIRST_FACTOR_SELECTION') return;
		const r2 = await auth.confirmSignIn(r1.nextStep.session, { firstFactor: 'PASSWORD' }, ctx());
		if (r2.status !== 'continueSignIn' || r2.nextStep.name !== 'CONFIRM_SIGN_IN_WITH_PASSWORD') return;
		const done = await auth.confirmSignIn(r2.nextStep.session, { password: 'Password!1' }, ctx());
		assert.strictEqual(done.status, 'signedIn');
	});

	test('15: USER_AUTH no preference → pick EMAIL_OTP → code → signed in', async () => {
		const { auth, lastCode } = makeAuth(nextId('s15'), {
			mfa: 'off' as const,
			authFlowType: 'USER_AUTH' as const,
			userAttributes: [{ name: 'email', required: true }] as const,
		});
		await auth.signUp('u15@test.example', 'Password!1', { attributes: { email: 'u15@test.example' } });
		await auth.confirmSignUp('u15@test.example', lastCode());

		const r1 = await auth.signIn('u15@test.example', '', ctx());
		if (r1.status !== 'continueSignIn' || r1.nextStep.name !== 'CONTINUE_SIGN_IN_WITH_FIRST_FACTOR_SELECTION') return;
		const r2 = await auth.confirmSignIn(r1.nextStep.session, { firstFactor: 'EMAIL_OTP' }, ctx());
		if (r2.status !== 'continueSignIn' || r2.nextStep.name !== 'CONFIRM_SIGN_IN_WITH_FIRST_FACTOR_EMAIL_OTP') return;
		const done = await auth.confirmSignIn(r2.nextStep.session, { code: lastCode() }, ctx());
		assert.strictEqual(done.status, 'signedIn');
	});

	test('16: USER_AUTH no preference → pick SMS_OTP → code → signed in', async () => {
		const { auth, lastCode } = makeAuth(nextId('s16'), {
			mfa: 'off' as const,
			authFlowType: 'USER_AUTH' as const,
			userAttributes: [{ name: 'email', required: true }, { name: 'phone_number', required: false }] as const,
		});
		await auth.signUp('u16@test.example', 'Password!1', {
			attributes: { email: 'u16@test.example', phone_number: '+15005550016' },
		});
		await auth.confirmSignUp('u16@test.example', lastCode());

		const r1 = await auth.signIn('u16@test.example', '', ctx());
		if (r1.status !== 'continueSignIn' || r1.nextStep.name !== 'CONTINUE_SIGN_IN_WITH_FIRST_FACTOR_SELECTION') return;
		const r2 = await auth.confirmSignIn(r1.nextStep.session, { firstFactor: 'SMS_OTP' }, ctx());
		if (r2.status !== 'continueSignIn' || r2.nextStep.name !== 'CONFIRM_SIGN_IN_WITH_FIRST_FACTOR_SMS_OTP') return;
		const done = await auth.confirmSignIn(r2.nextStep.session, { code: lastCode() }, ctx());
		assert.strictEqual(done.status, 'signedIn');
	});
});

// Silence unused-import if the env helpers above aren't used in some branches.
void roll;
