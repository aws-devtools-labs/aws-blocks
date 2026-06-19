/**
 * Real-Cognito mirror of `scenarios.passwordless-demo.test.ts`.
 *
 * Mirrors the auth-cognito template's exact options and drives the public
 * `signUp` → `confirmSignUp` → `autoSignIn` path, then the returning-user
 * `signIn` (`USER_AUTH` + `EMAIL_OTP`) → `confirmSignIn` path. Captures
 * codes via the custom-sender harness (no real email sent — Cognito
 * emits the OTP through `LambdaConfig.CustomEmailSender`, harness reads
 * the decrypted plaintext from a DDB table).
 *
 * Goal: pin down whether real Cognito sets `email_verified=true` after a
 * public `SignUp` + `ConfirmSignUp` round-trip when the email is provided
 * either (a) only as the username (signInWith: 'email', no separate
 * userAttribute) or (b) as both username and an explicit `email`
 * attribute. Mock currently only sets `email_verified` when (b) — we need
 * the real-Cognito ground truth before mirroring it in the mock.
 *
 * Gated on `BLOCKS_INTEGRATION=1` like the rest of the sandbox suite. Costs
 * ~30s per pool spin-up + ~15s per test.
 */

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert';
import { AdminGetUserCommand } from '@aws-sdk/client-cognito-identity-provider';
import type { BlocksContext } from '@aws-blocks/core';
import { Scope } from '@aws-blocks/core';
import { AuthCognito } from './index.aws.js';
import { envVarNames } from './types.js';
import {
	deleteUser,
	setupTestPool,
	type TestPool,
} from './test-support/test-pool-fixture.js';
import type { AuthCognitoOptions } from './types.js';

const ENABLED = process.env.BLOCKS_INTEGRATION === '1';

function ctx(): BlocksContext {
	return {
		request: { headers: new Headers() },
		response: { headers: new Headers() },
	} as unknown as BlocksContext;
}

/** Mirror the test-suite's browser-jar cookie roller from the mock e2e. */
function roll(prev: BlocksContext): BlocksContext {
	const next = ctx();
	const jar = new Map<string, string>();
	const prior = (prev as any).request.headers.get('cookie') as string | null;
	if (prior) {
		for (const part of prior.split(/;\s*/)) {
			const eq = part.indexOf('=');
			if (eq > 0) jar.set(part.slice(0, eq), part.slice(eq + 1));
		}
	}
	const setCookies: string[] = (prev as any).response.headers.getSetCookie?.() ?? [];
	for (const raw of setCookies) {
		const [pair, ...attrs] = raw.split(';').map((s) => s.trim());
		if (!pair) continue;
		const eq = pair.indexOf('=');
		if (eq < 0) continue;
		const name = pair.slice(0, eq);
		const value = pair.slice(eq + 1);
		const cleared = attrs.some((a) => /^max-age\s*=\s*0$/i.test(a));
		if (cleared) jar.delete(name);
		else jar.set(name, value);
	}
	if (jar.size > 0) {
		(next as any).request.headers.set(
			'cookie',
			[...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; '),
		);
	}
	return next;
}

function authFor(pool: TestPool, id: string, options: AuthCognitoOptions): AuthCognito {
	const scope = new Scope('passwordless-demo-sbx');
	const auth = new AuthCognito(scope, id, options);
	const env = envVarNames(auth.fullId);
	process.env[env.USER_POOL_ID] = pool.userPoolId;
	process.env[env.CLIENT_ID] = pool.userPoolClientId;
	process.env[env.REGION] = pool.region;
	(auth as any).userPoolId = pool.userPoolId;
	(auth as any).clientId = pool.userPoolClientId;
	(auth as any).region = pool.region;
	(auth as any).sessionSecret = 'integration-test-secret-not-production';
	return auth;
}

function uniqueUser(prefix = 'demo'): string {
	return `${prefix}-${Math.random().toString(36).slice(2, 8)}@example.com`;
}

/** Read the user's attributes via AdminGetUser — the only way to assert `email_verified` server-side. */
async function readUserAttrs(pool: TestPool, username: string): Promise<Record<string, string>> {
	const r = await pool.client.send(new AdminGetUserCommand({
		UserPoolId: pool.userPoolId,
		Username: username,
	}));
	const attrs: Record<string, string> = {};
	for (const a of r.UserAttributes ?? []) {
		if (a.Name && a.Value !== undefined) attrs[a.Name] = a.Value;
	}
	return attrs;
}

/** Demo template's exact options. Kept inline so this file is the source of truth — if the demo template drifts, this test will surface that against real Cognito. */
const DEMO_OPTIONS: AuthCognitoOptions = {
	passwordPolicy: { minLength: 8, requireDigits: true },
	signInWith: 'email',
	authFlowType: 'USER_AUTH',
	preferredChallenge: 'EMAIL_OTP',
	userAttributes: [
		{ name: 'email', required: true },
		{ name: 'department', required: false },
	],
	groups: ['editors', 'readers'],
	mfa: 'off',
	selfSignUp: true,
};

describe('passwordless-demo.sandbox · matches the template config', { skip: !ENABLED }, () => {
	let pool: TestPool;

	before(async () => {
		pool = await setupTestPool({
			nameSuffix: 'demo',
			signInWith: 'email',
			selfSignUp: true,
			totpMfa: false,
			emailMfa: true, // Required for USER_AUTH+EMAIL_OTP — populates EnabledMfas
			mfaEnforcement: 'OPTIONAL',
			userAuth: true,
		} as any);
	});

	after(async () => { await pool.cleanup(); });

	test('signUp → confirmSignUp marks email_verified=true (the load-bearing invariant)', async () => {
		const username = uniqueUser('verify');
		const auth = authFor(pool, `verify-${Math.random().toString(36).slice(2, 6)}`, DEMO_OPTIONS);
		try {
			await auth.signUp(username, 'Passw0rd!1', { attributes: { email: username } });
			const code = await pool.captureCode!(username, 'signup');
			await auth.confirmSignUp(username, code);

			const attrs = await readUserAttrs(pool, username);
			// The whole demo's returning-user passwordless sign-in hangs on
			// this. If real Cognito doesn't auto-flip `email_verified` on
			// public confirmSignUp the demo is broken on AWS too — and we'd
			// know to fix it at the BB layer rather than the mock layer.
			assert.strictEqual(attrs['email_verified'], 'true', 'email_verified must be true after public confirmSignUp');
			assert.strictEqual(attrs['email'], username);
		} finally {
			await deleteUser(pool, username);
		}
	});

	test('full demo flow: signUp({autoSignIn:true}) → confirmSignUp → autoSignIn → signedIn', async () => {
		const username = uniqueUser('full');
		const auth = authFor(pool, `full-${Math.random().toString(36).slice(2, 6)}`, DEMO_OPTIONS);
		try {
			const signUpCtx = ctx();
			// `autoSignIn: true` is what the state-machine `<Authenticator>`
			// path passes by default — direct API callers must opt in.
			await auth.signUp(
				username,
				'Passw0rd!1',
				{ attributes: { email: username }, autoSignIn: true },
				signUpCtx,
			);

			const code = await pool.captureCode!(username, 'signup');
			const confirmCtx = roll(signUpCtx);
			const r = await auth.confirmSignUp(username, code, confirmCtx);
			assert.strictEqual(r.nextStep.signUpStep, 'COMPLETE_AUTO_SIGN_IN');

			const autoCtx = roll(confirmCtx);
			const done = await auth.autoSignIn(autoCtx);
			assert.strictEqual(done.status, 'signedIn');
		} finally {
			await deleteUser(pool, username);
		}
	});

	test('returning user: signIn → EMAIL_OTP → signedIn (no password)', async () => {
		const username = uniqueUser('return');
		const auth = authFor(pool, `return-${Math.random().toString(36).slice(2, 6)}`, DEMO_OPTIONS);
		try {
			// Provision via the public signUp/confirmSignUp path the demo
			// itself uses — admin-confirm would set email_verified out of
			// band and miss the actual question.
			await auth.signUp(username, 'Passw0rd!1', { attributes: { email: username } });
			const signUpCode = await pool.captureCode!(username, 'signup');
			await auth.confirmSignUp(username, signUpCode);

			const r1 = await auth.signIn(username, '', ctx());
			if (r1.status === 'signedIn') throw new Error('expected EMAIL_OTP challenge');
			assert.strictEqual(r1.nextStep.name, 'CONFIRM_SIGN_IN_WITH_FIRST_FACTOR_EMAIL_OTP');
			if (r1.nextStep.name !== 'CONFIRM_SIGN_IN_WITH_FIRST_FACTOR_EMAIL_OTP') return;

			const otp = await pool.captureCode!(username, 'mfa');
			const done = await auth.confirmSignIn(r1.nextStep.session, { code: otp }, ctx());
			assert.strictEqual(done.status, 'signedIn');
		} finally {
			await deleteUser(pool, username);
		}
	});

	test('control: omitting the explicit email attribute on a signInWith=email pool', async () => {
		// The control-group case for the mock parity question. With
		// `signInWith: 'email'` and `UsernameAttributes: ['email']`,
		// Cognito's documented behavior is that the *username field* is
		// the email and Cognito syncs it into a managed `email` attribute
		// on `SignUp` (regardless of whether `email` is explicitly listed
		// in the schema). After confirmSignUp it should also flip
		// `email_verified=true`. If this assertion holds, the mock is the
		// runtime that's lying — and we should mirror Cognito by treating
		// the username as a synthetic `email` attribute when
		// `signInWith === 'email'`.
		const username = uniqueUser('noattr');
		// Skip the explicit `email` attribute on signUp — match what an
		// Authenticator form would send if `userAttributes` doesn't list
		// `{ name: 'email', required: true }`.
		const auth = authFor(pool, `noattr-${Math.random().toString(36).slice(2, 6)}`, {
			...DEMO_OPTIONS,
			userAttributes: [{ name: 'department', required: false }],
		});
		try {
			await auth.signUp(username, 'Passw0rd!1', { attributes: {} });
			const code = await pool.captureCode!(username, 'signup');
			await auth.confirmSignUp(username, code);

			const attrs = await readUserAttrs(pool, username);
			console.log('control-group attributes:', attrs);
			// Two outcomes worth recording — the test passes either way and
			// the assertions just document what we observe. A future PR
			// teaches the mock to do the same thing.
			assert.ok('email' in attrs, 'email attribute should exist (server-managed when UsernameAttributes=[email])');
			// `email_verified` may or may not be set — that's the question.
			// Don't assert; print so the integration log captures the truth.
			console.log(`control-group email_verified=${attrs['email_verified']}`);
		} finally {
			await deleteUser(pool, username);
		}
	});
});
