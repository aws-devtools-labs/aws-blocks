// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests against real Cognito.
 *
 * Gated on `BLOCKS_INTEGRATION=1`. Skipped by default so `node --test dist/*.test.js`
 * stays network-free. Each suite provisions its own pool via the fixture in
 * `test-support/byo-pool-fixture.ts`, exercises the flow end-to-end through
 * `auth.signIn` / `auth.confirmSignIn` (not the state machine — this is the
 * wire-level compliance test), and deletes the pool in `afterAll` — even on
 * failure — so test runs never leak pools.
 *
 * Preconditions:
 *   - `AWS_PROFILE` (or explicit credential chain) has `cognito-idp:*` on
 *     arbitrary pools. An Admin / PowerUser profile in a dev/sandbox
 *     account is the typical setup; never run against production
 *     credentials.
 *   - `BLOCKS_INTEGRATION=1` in the env.
 *   - `BLOCKS_INTEGRATION_REGION` (optional, default us-east-1).
 *   - Email MFA tests additionally require `BLOCKS_INTEGRATION_SES_FROM` pointing
 *     at a verified SES identity. Tests skip cleanly without it.
 *   - SMS MFA tests additionally require `BLOCKS_INTEGRATION_SNS_ROLE_ARN`.
 *
 * Run:
 *   BLOCKS_INTEGRATION=1 AWS_PROFILE=<your-profile> \
 *     node --test dist/user-auth-integration.test.js
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert';
import type { BlocksContext } from '@aws-blocks/core';
import { AuthCognito } from './index.aws.js';
import { envVarNames } from './types.js';
import {
	AssociateSoftwareTokenCommand,
	createConfirmedUser,
	deleteUser,
	setMfaPreference,
	setupTestPool,
	VerifySoftwareTokenCommand,
	type TestPool,
} from './test-support/test-pool-fixture.js';
import { totpNow } from './test-support/totp.js';
import { Scope } from '@aws-blocks/core';

const ENABLED = process.env.BLOCKS_INTEGRATION === '1';

/**
 * Build an `AuthCognito` AWS-runtime instance that talks to `pool`, with the
 * env vars required by the constructor set, and a preset session-secret so
 * the SSM round-trip stays out of the critical path.
 */
function authFor(pool: TestPool, id: string, options?: import('./types.js').AuthCognitoOptions) {
	const scope = new Scope('itest');
	const auth = new AuthCognito(scope, id, options);
	// `envVarNames` derives the variable name from `this.fullId`, which is
	// `parent/id` (e.g. `'itest/newpw-abc'`), not the raw id. Set env vars
	// via the live instance so the encoding always matches the reader side
	// inside `AuthCognito`'s constructor.
	const env = envVarNames(auth.fullId);
	process.env[env.USER_POOL_ID] = pool.userPoolId;
	process.env[env.CLIENT_ID] = pool.userPoolClientId;
	process.env[env.REGION] = pool.region;
	// The constructor read env vars *before* we set them here, so poke them
	// in by hand. Tests don't exercise the AppSetting round-trip —
	// session-secret is preset below and cookie persistence uses fresh
	// contexts.
	(auth as any).userPoolId = pool.userPoolId;
	(auth as any).clientId = pool.userPoolClientId;
	(auth as any).region = pool.region;
	(auth as any).sessionSecret = 'integration-test-secret-not-production';
	return auth;
}

function freshCtx(): BlocksContext {
	// Use the real `Headers` global so `ctx.response.headers.set()` works as
	// cookies.ts expects. A bare `Map`-backed stub gets silently wrong on
	// append/set semantics and surfaces only once a test exercises the
	// cookie write path (issueSession → setSessionCookie).
	return {
		request: { headers: new Headers() },
		response: { headers: new Headers() },
	} as unknown as BlocksContext;
}

/** Carry cookies written in `prev.response` into `next.request`. Mimics how a
 * browser reflects a Set-Cookie header back on the next request. Needed when a
 * test chains signIn → fetchAuthSession without an HTTP round-trip between.
 */
function rollForward(prev: BlocksContext): BlocksContext {
	const next = freshCtx();
	const raw = (prev as any).response.headers.get('set-cookie') as string | null;
	if (raw) {
		// Set-Cookie is "name=value; attrs; ..." — we only need the name=value
		// pair at the start for the next request's Cookie header.
		const pair = raw.split(';')[0]!;
		(next as any).request.headers.set('cookie', pair);
	}
	return next;
}

// ─── MFA_SETUP TOTP end-to-end ──────────────────────────────────────────────

describe('MFA_SETUP TOTP (real Cognito)', { skip: !ENABLED }, () => {
	let pool: TestPool;
	before(async () => {
		pool = await setupTestPool({ nameSuffix: 'totp-setup', totpMfa: true, mfaEnforcement: 'ON' });
	});
	after(async () => { await pool.cleanup(); });

	test('required MFA + no enrollment → AssociateSoftwareToken → TOTP setup completes', async () => {
		const username = `itest-${Math.random().toString(36).slice(2, 8)}@example.com`;
		const password = 'Password!1234';
		await createConfirmedUser(pool, username, password);
		try {
			const auth = authFor(pool, `mfa-totp-${Math.random().toString(36).slice(2, 6)}`);
			const ctx = freshCtx();

			const r1 = await auth.signIn(username, password, ctx);
			if (r1.status === 'signedIn') throw new Error('expected MFA_SETUP challenge on first login');
			assert.strictEqual(r1.nextStep.name, 'CONTINUE_SIGN_IN_WITH_TOTP_SETUP');
			if (r1.nextStep.name !== 'CONTINUE_SIGN_IN_WITH_TOTP_SETUP') return;
			assert.ok(r1.nextStep.sharedSecret.length > 0, 'secret from AssociateSoftwareToken');

			const code = totpNow(r1.nextStep.sharedSecret);
			const r2 = await auth.confirmSignIn(r1.nextStep.session, { code }, ctx);
			assert.strictEqual(r2.status, 'signedIn', 'VerifySoftwareToken + RespondToAuthChallenge succeed');
		} finally {
			await deleteUser(pool, username);
		}
	});
});

// ─── Enrolled MFA regression ────────────────────────────────────────────────

describe('enrolled TOTP MFA (real Cognito)', { skip: !ENABLED }, () => {
	let pool: TestPool;
	before(async () => {
		// `'ON'` (required) so the first sign-in is guaranteed to hit
		// MFA_SETUP for TOTP enrollment. With `'OPTIONAL'` a brand-new
		// user has nothing enrolled and Cognito just signs them in —
		// there's no way to exercise the enrolled-TOTP path without
		// first enrolling, and enrollment only auto-fires when MFA is
		// required.
		pool = await setupTestPool({ nameSuffix: 'enrolled-totp', totpMfa: true, mfaEnforcement: 'ON' });
	});
	after(async () => { await pool.cleanup(); });

	test('TOTP second factor after signIn', async () => {
		const username = `itest-${Math.random().toString(36).slice(2, 8)}@example.com`;
		const password = 'Password!1234';
		await createConfirmedUser(pool, username, password);
		try {
			const auth = authFor(pool, `enrolled-totp-${Math.random().toString(36).slice(2, 6)}`);
			const ctx = freshCtx();

			// Enroll TOTP — mimics a prior `setUpTOTP`/`verifyTOTPSetup` round.
			// We do it by signing in, hitting MFA_SETUP (since pool is OPTIONAL
			// with TOTP enabled), completing the ceremony, then signing back
			// out and signing in again to test the enrolled path.
			const r1 = await auth.signIn(username, password, ctx);
			if (r1.status === 'signedIn') throw new Error('expected MFA_SETUP on first login');
			if (r1.nextStep.name !== 'CONTINUE_SIGN_IN_WITH_TOTP_SETUP') {
				throw new Error(`unexpected step: ${r1.nextStep.name}`);
			}
			const sharedSecret = r1.nextStep.sharedSecret;
			await auth.confirmSignIn(r1.nextStep.session, { code: totpNow(sharedSecret) }, ctx);
			// Mark TOTP preferred so next signIn challenges it.
			await setMfaPreference(pool, username, { totp: { enabled: true, preferred: true } });

			// Wait for the NEXT 30-second TOTP time window before re-using
			// the authenticator. Cognito tracks "this code was already used
			// once" and rejects a replay with ExpiredCodeException even
			// though the TOTP algorithm would still verify it.
			const waitToNextWindow = 30 - (Math.floor(Date.now() / 1000) % 30) + 2;
			await new Promise((r) => setTimeout(r, waitToNextWindow * 1000));

			// Second sign-in: TOTP challenge this time (not setup).
			const ctx2 = freshCtx();
			const r2 = await auth.signIn(username, password, ctx2);
			if (r2.status === 'signedIn') throw new Error('expected TOTP challenge');
			assert.strictEqual(r2.nextStep.name, 'CONFIRM_SIGN_IN_WITH_TOTP_CODE');
			if (r2.nextStep.name !== 'CONFIRM_SIGN_IN_WITH_TOTP_CODE') return;
			const r3 = await auth.confirmSignIn(r2.nextStep.session, { code: totpNow(sharedSecret) }, ctx2);
			assert.strictEqual(r3.status, 'signedIn');
		} finally {
			await deleteUser(pool, username);
		}
	});
});

// ─── Enrolled SMS MFA (real Cognito, custom-sender capture) ────────────────
//
// Uses the custom-sender capture Lambda to read the real SMS code Cognito
// emitted and complete the challenge end-to-end. The fixture provisions a
// throwaway SNS IAM role purely to satisfy Cognito's pool validator — the
// sender Lambda replaces actual SNS delivery, so no SMS ever fires.

describe('enrolled SMS MFA (real Cognito, capture sender)', { skip: !ENABLED }, () => {
	let pool: TestPool;
	before(async () => {
		pool = await setupTestPool({
			nameSuffix: 'enrolled-sms',
			totpMfa: false,
			smsMfa: true,
			mfaEnforcement: 'OPTIONAL',
		});
	});
	after(async () => { await pool.cleanup(); });

	test('SMS_MFA challenge: code captured + round-trip signs in', async () => {
		const username = `itest-${Math.random().toString(36).slice(2, 8)}@example.com`;
		const password = 'Password!1234';
		await createConfirmedUser(pool, username, password, {
			phone_number: '+15005550006',
			phone_number_verified: 'true',
		});
		try {
			await setMfaPreference(pool, username, { sms: { enabled: true, preferred: true } });
			const auth = authFor(pool, `sms-mfa-${Math.random().toString(36).slice(2, 6)}`);
			const ctx = freshCtx();

			const r1 = await auth.signIn(username, password, ctx);
			if (r1.status === 'signedIn') throw new Error('expected SMS_MFA challenge');
			assert.strictEqual(r1.nextStep.name, 'CONFIRM_SIGN_IN_WITH_SMS_CODE');
			if (r1.nextStep.name !== 'CONFIRM_SIGN_IN_WITH_SMS_CODE') return;
			const smsStep = r1.nextStep;
			assert.strictEqual(smsStep.codeDeliveryDetails.deliveryMedium, 'SMS');

			const code = await pool.captureCode!(username, 'mfa');
			assert.match(code, /^\d{6}$/, 'Cognito delivered a 6-digit SMS code');

			const r2 = await auth.confirmSignIn(smsStep.session, { code }, ctx);
			assert.strictEqual(r2.status, 'signedIn');
		} finally {
			await deleteUser(pool, username);
		}
	});
});

// ─── Enrolled EMAIL MFA (real Cognito, custom-sender capture) ──────────────
//
// Uses the custom-sender capture Lambda to read the real EMAIL_OTP code
// Cognito emitted and complete the challenge end-to-end. The fixture
// auto-discovers a verified SES identity in the calling account to
// satisfy Cognito's EmailConfiguration.SourceArn validator — the sender
// Lambda replaces actual SES delivery, so no email ever fires.

describe('enrolled EMAIL MFA (real Cognito, capture sender)', { skip: !ENABLED }, () => {
	let pool: TestPool;
	before(async () => {
		pool = await setupTestPool({
			nameSuffix: 'enrolled-email',
			totpMfa: false,
			emailMfa: true,
			mfaEnforcement: 'OPTIONAL',
		});
	});
	after(async () => { await pool.cleanup(); });

	test('EMAIL_OTP challenge: code captured + round-trip signs in', async () => {
		const username = `itest-${Math.random().toString(36).slice(2, 8)}@example.com`;
		const password = 'Password!1234';
		await createConfirmedUser(pool, username, password);
		try {
			await setMfaPreference(pool, username, { email: { enabled: true, preferred: true } });
			const auth = authFor(pool, `email-mfa-${Math.random().toString(36).slice(2, 6)}`);
			const ctx = freshCtx();

			const r1 = await auth.signIn(username, password, ctx);
			if (r1.status === 'signedIn') throw new Error('expected EMAIL_OTP challenge');
			assert.strictEqual(r1.nextStep.name, 'CONFIRM_SIGN_IN_WITH_EMAIL_CODE');
			if (r1.nextStep.name !== 'CONFIRM_SIGN_IN_WITH_EMAIL_CODE') return;
			const emailStep = r1.nextStep;
			assert.strictEqual(emailStep.codeDeliveryDetails.deliveryMedium, 'EMAIL');

			const code = await pool.captureCode!(username, 'mfa');
			assert.match(code, /^\d{6}$/, 'Cognito delivered a 6-digit email code');

			const r2 = await auth.confirmSignIn(emailStep.session, { code }, ctx);
			assert.strictEqual(r2.status, 'signedIn');
		} finally {
			await deleteUser(pool, username);
		}
	});
});

// ─── SELECT_MFA_TYPE (TOTP + SMS enrolled; pool forces the user to pick) ──

describe('SELECT_MFA_TYPE (real Cognito)', { skip: !ENABLED }, () => {
	let pool: TestPool;
	before(async () => {
		pool = await setupTestPool({
			nameSuffix: 'select-mfa',
			totpMfa: true,
			smsMfa: true,
			// OPTIONAL lets us admin-enroll both factors and sign in
			// without going through MFA_SETUP. With a verified phone
			// already admin-set, SMS is auto-enrolled; we then go through
			// TOTP setup ourselves (admin-create with a verified phone
			// does NOT auto-enroll TOTP because TOTP requires
			// AssociateSoftwareToken).
			mfaEnforcement: 'OPTIONAL',
		});
	});
	after(async () => { await pool.cleanup(); });

	test('multi-factor user → SELECT_MFA_TYPE → pick TOTP → TOTP challenge', async () => {
		const username = `itest-${Math.random().toString(36).slice(2, 8)}@example.com`;
		const password = 'Password!1234';
		await createConfirmedUser(pool, username, password, {
			phone_number: '+15005550006',
			phone_number_verified: 'true',
		});
		try {
			// Sign in first (no challenge — OPTIONAL MFA + nothing enrolled
			// → direct sign-in). Then enroll TOTP via the SDK using the
			// access token — same code path as `setUpTOTP` on the BB but
			// called against Cognito directly for test speed.
			const auth = authFor(pool, `select-${Math.random().toString(36).slice(2, 6)}`);
			const ctxEnroll = freshCtx();
			const signIn = await auth.signIn(username, password, ctxEnroll);
			if (signIn.status === 'continueSignIn') {
				throw new Error(`expected signed-in; got ${signIn.nextStep.name}`);
			}

			// Get an access token from the BB's session store for the
			// AssociateSoftwareToken call. Need to bridge the Set-Cookie
			// from signIn's response into the fetchAuthSession request.
			const ctxFetch = rollForward(ctxEnroll);
			const tokens = await auth.fetchAuthSession(ctxFetch);
			const accessToken = tokens.tokens?.accessToken?.toString();
			if (!accessToken) throw new Error('no access token after signIn');

			const assoc = (await pool.client.send(
				new AssociateSoftwareTokenCommand({ AccessToken: accessToken }),
			)) as { SecretCode?: string };
			const sharedSecret = assoc.SecretCode!;
			await pool.client.send(
				new VerifySoftwareTokenCommand({
					AccessToken: accessToken,
					UserCode: totpNow(sharedSecret),
				}),
			);

			// Enable BOTH factors, neither preferred — triggers SELECT_MFA_TYPE.
			await setMfaPreference(pool, username, {
				totp: { enabled: true, preferred: false },
				sms: { enabled: true, preferred: false },
			});

			// Wait for the next TOTP window (the code we just used is
			// one-shot).
			const pad = 30 - (Math.floor(Date.now() / 1000) % 30) + 2;
			await new Promise((r) => setTimeout(r, pad * 1000));

			const ctx = freshCtx();
			const r1 = await auth.signIn(username, password, ctx);
			if (r1.status === 'signedIn') throw new Error('expected SELECT_MFA_TYPE');
			assert.strictEqual(r1.nextStep.name, 'CONTINUE_SIGN_IN_WITH_MFA_SELECTION');
			if (r1.nextStep.name !== 'CONTINUE_SIGN_IN_WITH_MFA_SELECTION') return;
			assert.ok(r1.nextStep.allowedMFATypes.includes('TOTP'));
			assert.ok(r1.nextStep.allowedMFATypes.includes('SMS'));

			const r2 = await auth.confirmSignIn(r1.nextStep.session, { mfaType: 'TOTP' as 'TOTP' }, ctx);
			if (r2.status === 'signedIn') throw new Error('expected TOTP challenge after pick');
			assert.strictEqual(r2.nextStep.name, 'CONFIRM_SIGN_IN_WITH_TOTP_CODE');
			if (r2.nextStep.name !== 'CONFIRM_SIGN_IN_WITH_TOTP_CODE') return;
			const r3 = await auth.confirmSignIn(r2.nextStep.session, { code: totpNow(sharedSecret) }, ctx);
			assert.strictEqual(r3.status, 'signedIn');
		} finally {
			await deleteUser(pool, username);
		}
	});
});

// ─── NEW_PASSWORD_REQUIRED regression ───────────────────────────────────────

describe('NEW_PASSWORD_REQUIRED (real Cognito)', { skip: !ENABLED }, () => {
	let pool: TestPool;
	before(async () => {
		pool = await setupTestPool({ nameSuffix: 'new-password', totpMfa: false, mfaEnforcement: 'OFF' });
	});
	after(async () => { await pool.cleanup(); });

	test('admin-created user with temporary password → challenge surfaces → new password completes', async () => {
		const username = `itest-${Math.random().toString(36).slice(2, 8)}@example.com`;
		const tempPassword = 'TempPass!1234';
		// Skip the helper — this test needs `Permanent: false`.
		const { AdminCreateUserCommand } = await import('@aws-sdk/client-cognito-identity-provider');
		await pool.client.send(new AdminCreateUserCommand({
			UserPoolId: pool.userPoolId,
			Username: username,
			TemporaryPassword: tempPassword,
			UserAttributes: [{ Name: 'email', Value: username }, { Name: 'email_verified', Value: 'true' }],
			MessageAction: 'SUPPRESS',
		}));
		try {
			const auth = authFor(pool, `newpw-${Math.random().toString(36).slice(2, 6)}`);
			const ctx = freshCtx();
			const r1 = await auth.signIn(username, tempPassword, ctx);
			if (r1.status === 'signedIn') throw new Error('expected NEW_PASSWORD_REQUIRED');
			assert.strictEqual(r1.nextStep.name, 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED');
			if (r1.nextStep.name !== 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED') return;
			const r2 = await auth.confirmSignIn(r1.nextStep.session, { newPassword: 'FinalPass!1234' }, ctx);
			assert.strictEqual(r2.status, 'signedIn');
		} finally {
			await deleteUser(pool, username);
		}
	});
});

// ─── USER_AUTH flow (password leg) ──────────────────────────────────────────

describe('USER_AUTH flow (real Cognito)', { skip: !ENABLED }, () => {
	let pool: TestPool;
	before(async () => {
		pool = await setupTestPool({ nameSuffix: 'user-auth', totpMfa: false, userAuth: true, mfaEnforcement: 'OFF' });
	});
	after(async () => { await pool.cleanup(); });

	test('PREFERRED_CHALLENGE=PASSWORD → signed in directly when password supplied', async () => {
		const username = `itest-${Math.random().toString(36).slice(2, 8)}@example.com`;
		const password = 'Password!1234';
		await createConfirmedUser(pool, username, password);
		try {
			const auth = authFor(pool, 'ua-pw', {
				authFlowType: 'USER_AUTH',
				preferredChallenge: 'PASSWORD',
			});
			const ctx = freshCtx();

			// With PREFERRED_CHALLENGE=PASSWORD and a password supplied to
			// signIn, Cognito authenticates in a single call — no
			// intermediate CONFIRM_SIGN_IN_WITH_PASSWORD step. This matches
			// Amplify-JS v6's bundled wire shape.
			const r1 = await auth.signIn(username, password, ctx);
			assert.strictEqual(r1.status, 'signedIn');
		} finally {
			await deleteUser(pool, username);
		}
	});

	test('no preferred challenge → SELECT_CHALLENGE → pick PASSWORD → signed in', async () => {
		const username = `itest-${Math.random().toString(36).slice(2, 8)}@example.com`;
		const password = 'Password!1234';
		await createConfirmedUser(pool, username, password);
		try {
			const auth = authFor(pool, 'ua-select', { authFlowType: 'USER_AUTH' });
			const ctx = freshCtx();

			const r1 = await auth.signIn(username, '', ctx);
			if (r1.status === 'signedIn') throw new Error('expected SELECT_CHALLENGE');
			assert.strictEqual(r1.nextStep.name, 'CONTINUE_SIGN_IN_WITH_FIRST_FACTOR_SELECTION');
			if (r1.nextStep.name !== 'CONTINUE_SIGN_IN_WITH_FIRST_FACTOR_SELECTION') return;
			const r2 = await auth.confirmSignIn(r1.nextStep.session, { firstFactor: 'PASSWORD' }, ctx);
			if (r2.status === 'signedIn') throw new Error('expected password challenge');
			assert.strictEqual(r2.nextStep.name, 'CONFIRM_SIGN_IN_WITH_PASSWORD');
			if (r2.nextStep.name !== 'CONFIRM_SIGN_IN_WITH_PASSWORD') return;
			const r3 = await auth.confirmSignIn(r2.nextStep.session, { password }, ctx);
			assert.strictEqual(r3.status, 'signedIn');
		} finally {
			await deleteUser(pool, username);
		}
	});
});

// ─── Customer-SES regression (shape-only) ──────────────────────────────────
//
// The default integration suites use the custom-sender capture harness —
// fast, and no SES/SNS setup required. But customers wire their pool
// against real SES/SNS identities in prod; this suite proves the BB
// doesn't fight that config. Only fires when the operator brings the
// customer-side env vars AND explicitly opts in via
// `BLOCKS_INTEGRATION_CUSTOMER_SES=1` — we don't want every CI run waiting
// on someone's SES quota.
//
// Assertion is deliberately shape-only (the harness can't read real
// mail), mirroring what a production customer could validate themselves.

const CUSTOMER_SES_ENABLED = ENABLED
	&& process.env.BLOCKS_INTEGRATION_CUSTOMER_SES === '1'
	&& !!process.env.BLOCKS_INTEGRATION_SES_FROM;

describe('customer-SES regression (shape-only)', { skip: !CUSTOMER_SES_ENABLED }, () => {
	let pool: TestPool;
	before(async () => {
		pool = await setupTestPool({
			nameSuffix: 'customer-ses',
			totpMfa: false,
			emailMfa: true,
			mfaEnforcement: 'OPTIONAL',
			delivery: 'customer-ses-sns',
		});
	});
	after(async () => { await pool.cleanup(); });

	test('EMAIL_OTP challenge fires with correct shape + rejects wrong code', async () => {
		const username = process.env.BLOCKS_INTEGRATION_SES_FROM!.includes('@')
			// Use the verified identity itself as the user's email — guarantees
			// SES accepts the delivery regardless of sandbox state.
			? process.env.BLOCKS_INTEGRATION_SES_FROM!.split('/').pop() ?? 'itest@example.com'
			: 'itest@example.com';
		const password = 'Password!1234';
		await createConfirmedUser(pool, username, password);
		try {
			await setMfaPreference(pool, username, { email: { enabled: true, preferred: true } });
			const auth = authFor(pool, `cust-ses-${Math.random().toString(36).slice(2, 6)}`);
			const ctx = freshCtx();

			const r1 = await auth.signIn(username, password, ctx);
			if (r1.status === 'signedIn') throw new Error('expected EMAIL_OTP challenge');
			assert.strictEqual(r1.nextStep.name, 'CONFIRM_SIGN_IN_WITH_EMAIL_CODE');
			if (r1.nextStep.name !== 'CONFIRM_SIGN_IN_WITH_EMAIL_CODE') return;
			const emailStep = r1.nextStep;
			assert.strictEqual(emailStep.codeDeliveryDetails.deliveryMedium, 'EMAIL');
			assert.ok(emailStep.codeDeliveryDetails.destination.length > 0);

			// Wrong-code negative assertion — proves `buildChallengeResponses`
			// sends the right parameter name (EMAIL_OTP_CODE not EMAIL_CODE).
			await assert.rejects(
				() => auth.confirmSignIn(emailStep.session, { code: '000000' }, ctx),
				(e: Error) => /CodeMismatch|NotAuthorized/.test(e.name) || /code/i.test(e.message),
			);
		} finally {
			await deleteUser(pool, username);
		}
	});
});
