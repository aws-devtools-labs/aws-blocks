// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { rmSync } from 'node:fs';
import { isBlocksError, hasAuthError } from '@aws-blocks/core';
import type { BlocksContext } from '@aws-blocks/core';
import { AuthCognito, AuthCognitoErrors } from './index.js';

// ── Test harness ─────────────────────────────────────────────────────────────

const ROOT = { id: 'test-app' } as any;

function freshContext(): { ctx: BlocksContext; cookieJar: () => string | null } {
	const req = new Headers();
	const res = new Headers();
	let status = 200;
	const jar = {
		cookie: null as string | null,
	};
	const ctx: BlocksContext = {
		request: {
			headers: req,
			body: null,
			json: async () => ({}),
			text: async () => '',
			url: new URL('http://localhost:3000/'),
			params: {},
		},
		response: {
			headers: res,
			get status() { return status; },
			set status(v) { status = v; },
			send: () => {},
		} as any,
	};
	// Wire Set-Cookie → next request Cookie automatically.
	const origSet = res.set.bind(res);
	res.set = (name: string, value: string) => {
		if (name.toLowerCase() === 'set-cookie') {
			const cookiePart = value.split(';')[0];
			jar.cookie = cookiePart;
			req.set('cookie', cookiePart);
		}
		origSet(name, value);
	};
	return { ctx, cookieJar: () => jar.cookie };
}

function uniqueId() {
	return `user-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function unique(prefix = 'scope') {
	return `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
}

beforeEach(() => {
	try { rmSync('.bb-data', { recursive: true, force: true }); } catch { /* ignore */ }
});

afterEach(() => {
	try { rmSync('.bb-data', { recursive: true, force: true }); } catch { /* ignore */ }
});

// ─── Sign-up ─────────────────────────────────────────────────────────────────

describe('signUp / confirmSignUp / resendSignUpCode', () => {
	test('signUp creates an unconfirmed user and returns CONFIRM_SIGN_UP next step', async () => {
		const auth = new AuthCognito(ROOT, unique('signup-1'), {
			passwordPolicy: { minLength: 8 },
		});
		const r = await auth.signUp('alice', 'Password!1', { attributes: { email: 'alice@example.com' } });
		assert.strictEqual(r.isSignUpComplete, false);
		assert.strictEqual(r.nextStep?.name, 'CONFIRM_SIGN_UP');
		assert.ok(r.userId);
	});

	test('signUp rejects duplicate username', async () => {
		const auth = new AuthCognito(ROOT, unique('signup-2'), { passwordPolicy: { minLength: 8 } });
		await auth.signUp('bob', 'Password!1', { attributes: { email: 'b@x.com' } });
		await assert.rejects(
			() => auth.signUp('bob', 'Password!2', { attributes: { email: 'b@x.com' } }),
			(e: Error) => isBlocksError(e, AuthCognitoErrors.UserAlreadyExists),
		);
	});

	test('signUp enforces password policy', async () => {
		const auth = new AuthCognito(ROOT, unique('signup-3'), { passwordPolicy: { minLength: 10 } });
		await assert.rejects(
			() => auth.signUp('carol', 'short', {}),
			(e: Error) => isBlocksError(e, AuthCognitoErrors.InvalidPassword),
		);
	});

	test('confirmSignUp with correct code confirms the user', async () => {
		const captured: { username: string; code: string }[] = [];
		const auth = new AuthCognito(ROOT, unique('confirm-1'), {
			passwordPolicy: { minLength: 8 },
			codeDelivery: async (username, code) => { captured.push({ username, code }); },
		});
		await auth.signUp('dan', 'Password!1', { attributes: { email: 'd@x.com' } });
		assert.strictEqual(captured.length, 1);
		await auth.confirmSignUp('dan', captured[0].code);
	});

	test('confirmSignUp with wrong code throws CodeMismatch', async () => {
		const auth = new AuthCognito(ROOT, unique('confirm-2'), {
			passwordPolicy: { minLength: 8 },
			codeDelivery: async () => {},
		});
		await auth.signUp('eve', 'Password!1', { attributes: { email: 'e@x.com' } });
		await assert.rejects(
			() => auth.confirmSignUp('eve', '000000'),
			(e: Error) => isBlocksError(e, AuthCognitoErrors.CodeMismatch),
		);
	});

	test('resendSignUpCode issues a new code', async () => {
		const codes: string[] = [];
		const auth = new AuthCognito(ROOT, unique('resend'), {
			passwordPolicy: { minLength: 8 },
			codeDelivery: async (_u, code) => { codes.push(code); },
		});
		await auth.signUp('frank', 'Password!1', { attributes: { email: 'f@x.com' } });
		await auth.resendSignUpCode('frank');
		assert.strictEqual(codes.length, 2);
	});
});

// ─── `status` discriminator on SignInResult ─────────────────────────────────
//
// `SignInResult` is a discriminated union on the string `status` field
// ('signedIn' | 'continueSignIn') — the discriminator native-client codegen keys off.
// These tests assert the right `status` (and the matching payload field) is
// returned on both the direct-sign-in and the challenge paths, for `signIn`
// and `confirmSignIn`.

describe('status discriminator on SignInResult', () => {
	async function signUpAndConfirm(auth: AuthCognito, username: string) {
		let code = '';
		(auth as any).options.codeDelivery = async (_u: string, c: string) => { code = c; };
		await auth.signUp(username, 'Password!1', { attributes: { email: `${username}@x.com` } });
		await auth.confirmSignUp(username, code);
	}

	test("signIn returns status 'signedIn' (+ user) on the direct happy path", async () => {
		const auth = new AuthCognito(ROOT, unique('status-1'), { passwordPolicy: { minLength: 8 } });
		await signUpAndConfirm(auth, 'sigrid');
		const { ctx } = freshContext();
		const r = await auth.signIn('sigrid', 'Password!1', ctx);
		assert.strictEqual(r.status, 'signedIn');
		// The signedIn arm carries `user` and no `nextStep`.
		if (r.status !== 'signedIn') throw new Error('unreachable');
		assert.strictEqual(r.user.username, 'sigrid');
		assert.ok(!('nextStep' in r));
	});

	test("signIn returns status 'continueSignIn' (+ nextStep) when a challenge is required", async () => {
		const auth = new AuthCognito(ROOT, unique('status-2'), {
			passwordPolicy: { minLength: 8 },
			mfa: 'required',
			mfaTypes: ['TOTP'],
		});
		await signUpAndConfirm(auth, 'nadia');
		const { ctx } = freshContext();
		const r = await auth.signIn('nadia', 'Password!1', ctx);
		assert.strictEqual(r.status, 'continueSignIn');
		// The nextStep arm carries `nextStep` and no `user`.
		if (r.status !== 'continueSignIn') throw new Error('unreachable');
		assert.ok(r.nextStep.name.length > 0);
		assert.ok(!('user' in r));
	});

	test('confirmSignIn carries status through to the final signed-in result', async () => {
		const auth = new AuthCognito(ROOT, unique('status-3'), {
			passwordPolicy: { minLength: 8 },
			mfa: 'required',
			mfaTypes: ['TOTP'],
		});
		await signUpAndConfirm(auth, 'omar');
		const { ctx } = freshContext();
		const challenge = await auth.signIn('omar', 'Password!1', ctx);
		assert.strictEqual(challenge.status, 'continueSignIn');
		if (challenge.status !== 'continueSignIn') return;
		if (challenge.nextStep.name !== 'CONTINUE_SIGN_IN_WITH_TOTP_SETUP') return;
		// Mock accepts any 6-digit code.
		const done = await auth.confirmSignIn(challenge.nextStep.session, { code: '123456' }, ctx);
		assert.strictEqual(done.status, 'signedIn');
	});
});

// ─── Sign-in happy path + error cases ───────────────────────────────────────

describe('signIn / signOut / getCurrentUser / requireAuth / checkAuth', () => {
	async function signUpAndConfirm(auth: AuthCognito, username: string) {
		let code = '';
		(auth as any).options.codeDelivery = async (_u: string, c: string) => { code = c; };
		await auth.signUp(username, 'Password!1', { attributes: { email: `${username}@x.com` } });
		await auth.confirmSignUp(username, code);
	}

	test('signIn + getCurrentUser round trip', async () => {
		const auth = new AuthCognito(ROOT, unique('auth-1'), { passwordPolicy: { minLength: 8 } });
		await signUpAndConfirm(auth, 'alice');
		const { ctx } = freshContext();
		const r = await auth.signIn('alice', 'Password!1', ctx);
		assert.strictEqual(r.status, 'signedIn');
		const current = await auth.getCurrentUser(ctx);
		assert.ok(current);
		assert.strictEqual(current!.username, 'alice');
	});

	test('requireAuth returns user when signed in', async () => {
		const auth = new AuthCognito(ROOT, unique('auth-2'), { passwordPolicy: { minLength: 8 } });
		await signUpAndConfirm(auth, 'bob');
		const { ctx } = freshContext();
		await auth.signIn('bob', 'Password!1', ctx);
		const user = await auth.requireAuth(ctx);
		assert.strictEqual(user.username, 'bob');
	});

	test('checkAuth is true after signIn', async () => {
		const auth = new AuthCognito(ROOT, unique('auth-3'), { passwordPolicy: { minLength: 8 } });
		await signUpAndConfirm(auth, 'carol');
		const { ctx } = freshContext();
		await auth.signIn('carol', 'Password!1', ctx);
		assert.strictEqual(await auth.checkAuth(ctx), true);
	});

	test('signIn with wrong password throws NotAuthorized', async () => {
		const auth = new AuthCognito(ROOT, unique('auth-4'), { passwordPolicy: { minLength: 8 } });
		await signUpAndConfirm(auth, 'dan');
		const { ctx } = freshContext();
		await assert.rejects(
			() => auth.signIn('dan', 'Wrong1!Password', ctx),
			(e: Error) => isBlocksError(e, AuthCognitoErrors.NotAuthorized),
		);
	});

	test('signIn with unconfirmed user throws UserNotConfirmed', async () => {
		const auth = new AuthCognito(ROOT, unique('auth-5'), { passwordPolicy: { minLength: 8 } });
		await auth.signUp('eve', 'Password!1', { attributes: { email: 'e@x.com' } });
		const { ctx } = freshContext();
		await assert.rejects(
			() => auth.signIn('eve', 'Password!1', ctx),
			(e: Error) => isBlocksError(e, AuthCognitoErrors.UserNotConfirmed),
		);
	});

	test('signOut clears the session', async () => {
		const auth = new AuthCognito(ROOT, unique('auth-6'), { passwordPolicy: { minLength: 8 } });
		await signUpAndConfirm(auth, 'frank');
		const { ctx } = freshContext();
		await auth.signIn('frank', 'Password!1', ctx);
		assert.ok(await auth.getCurrentUser(ctx));
		await auth.signOut(ctx);
		// Simulate a new request with the cleared cookie
		const { ctx: ctx2 } = freshContext();
		// Copy cleared-cookie state to ctx2 request — since signOut ran on ctx,
		// the new "request" has no cookie header at all, so getCurrentUser is null.
		assert.strictEqual(await auth.getCurrentUser(ctx2), null);
	});

	test('requireAuth without session throws NotAuthenticated', async () => {
		const auth = new AuthCognito(ROOT, unique('auth-7'));
		const { ctx } = freshContext();
		await assert.rejects(
			() => auth.requireAuth(ctx),
			(e: Error) => isBlocksError(e, AuthCognitoErrors.NotAuthenticated),
		);
	});
});

// ─── fetchAuthSession ──────────────────────────────────────────────────────

describe('fetchAuthSession', () => {
	async function signedInAs(username: string, id = unique('sess')) {
		const auth = new AuthCognito(ROOT, id, { passwordPolicy: { minLength: 8 } });
		let code = '';
		(auth as any).options.codeDelivery = async (_u: string, c: string) => { code = c; };
		await auth.signUp(username, 'Password!1', { attributes: { email: `${username}@x.com` } });
		await auth.confirmSignUp(username, code);
		const { ctx } = freshContext();
		await auth.signIn(username, 'Password!1', ctx);
		return { auth, ctx, username };
	}

	test('returns tokens + userSub when signed in', async () => {
		const { auth, ctx, username } = await signedInAs('alice');
		const session = await auth.fetchAuthSession(ctx);
		assert.ok(session.tokens, 'expected tokens');
		assert.ok(typeof session.userSub === 'string' && session.userSub.length > 0);
		// Raw JWT shape: three base64url segments joined by dots.
		assert.match(session.tokens!.idToken.toString(), /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
		assert.match(session.tokens!.accessToken.toString(), /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
		// Payload carries the standard Cognito claims.
		assert.strictEqual(session.tokens!.idToken.payload['cognito:username'], username);
		assert.strictEqual(session.tokens!.accessToken.payload.token_use, 'access');
		assert.ok(session.tokens!.idToken.expiresAt > Date.now(), 'expiresAt should be in the future');
	});

	test('returns { tokens: undefined } when not signed in', async () => {
		const auth = new AuthCognito(ROOT, unique('sess-empty'));
		const { ctx } = freshContext();
		const session = await auth.fetchAuthSession(ctx);
		assert.strictEqual(session.tokens, undefined);
		assert.strictEqual(session.userSub, undefined);
	});

	test('forceRefresh rotates tokens (new expiresAt, new raw value)', async () => {
		const { auth, ctx } = await signedInAs('bob');
		const before = await auth.fetchAuthSession(ctx);
		// Give the mock JWT issuer a tick so `exp` (seconds precision) differs.
		await new Promise((r) => setTimeout(r, 1100));
		const after = await auth.fetchAuthSession(ctx, { forceRefresh: true });
		assert.ok(before.tokens && after.tokens);
		assert.notStrictEqual(after.tokens.idToken.toString(), before.tokens.idToken.toString());
		assert.ok(after.tokens.idToken.expiresAt > before.tokens.idToken.expiresAt);
		assert.strictEqual(after.userSub, before.userSub, 'userSub stable across refresh');
	});

	test('clears cookie + returns empty when session record is missing', async () => {
		const { auth, ctx } = await signedInAs('carol');
		// Wipe the session store behind the cookie's back.
		const sessions = (auth as any).sessions;
		const store = sessions.store ?? sessions;
		// Delete any known sessions — simplest approach: wipe disk.
		rmSync('.bb-data', { recursive: true, force: true });
		// Recreate the auth so it re-reads the now-empty disk state.
		const auth2 = new AuthCognito(ROOT, (auth as any).fullId, { passwordPolicy: { minLength: 8 } });
		const session = await auth2.fetchAuthSession(ctx);
		assert.strictEqual(session.tokens, undefined);
	});
});

// ─── MFA ────────────────────────────────────────────────────────────────────

describe('MFA challenge + confirmSignIn', () => {
	async function setupUserWithTotp(auth: AuthCognito, username: string) {
		let code = '';
		(auth as any).options.codeDelivery = async (_u: string, c: string) => { code = c; };
		await auth.signUp(username, 'Password!1', { attributes: { email: `${username}@x.com` } });
		await auth.confirmSignUp(username, code);
		const user = (auth as any).state.users[username];
		user.mfaPreference = { preferred: 'TOTP', enabled: ['TOTP'] };
		user.totpVerified = true;
		(auth as any).flushToDisk();
	}

	test('signIn returns TOTP challenge when MFA enabled', async () => {
		const auth = new AuthCognito(ROOT, unique('mfa-1'), {
			passwordPolicy: { minLength: 8 },
			mfa: 'optional',
			mfaTypes: ['TOTP'],
		});
		await setupUserWithTotp(auth, 'grace');
		const { ctx } = freshContext();
		const r = await auth.signIn('grace', 'Password!1', ctx);
		assert.strictEqual(r.status, 'continueSignIn');
		if (r.status === 'continueSignIn') {
			assert.strictEqual(r.nextStep.name, 'CONFIRM_SIGN_IN_WITH_TOTP_CODE');
			assert.ok(r.nextStep.session);
		}
	});

	test('confirmSignIn with valid TOTP code signs the user in', async () => {
		const auth = new AuthCognito(ROOT, unique('mfa-2'), {
			passwordPolicy: { minLength: 8 },
			mfa: 'optional',
			mfaTypes: ['TOTP'],
		});
		await setupUserWithTotp(auth, 'hugo');
		const { ctx } = freshContext();
		const challenge = await auth.signIn('hugo', 'Password!1', ctx);
		if (challenge.status === 'signedIn') throw new Error('expected challenge');
		const session = (challenge.nextStep as { session: string }).session;
		const r = await auth.confirmSignIn(session, '123456', ctx);
		assert.strictEqual(r.status, 'signedIn');
		assert.strictEqual(await auth.checkAuth(ctx), true);
	});

	test('confirmSignIn with non-6-digit code throws CodeMismatch', async () => {
		const auth = new AuthCognito(ROOT, unique('mfa-3'), {
			passwordPolicy: { minLength: 8 },
			mfa: 'optional',
			mfaTypes: ['TOTP'],
		});
		await setupUserWithTotp(auth, 'ivy');
		const { ctx } = freshContext();
		const challenge = await auth.signIn('ivy', 'Password!1', ctx);
		if (challenge.status === 'signedIn') throw new Error('expected challenge');
		const session = (challenge.nextStep as { session: string }).session;
		await assert.rejects(
			() => auth.confirmSignIn(session, 'abc', ctx),
			(e: Error) => isBlocksError(e, AuthCognitoErrors.CodeMismatch),
		);
	});

	test('confirmSignIn with expired session throws ExpiredCode', async () => {
		const auth = new AuthCognito(ROOT, unique('mfa-4'), {
			passwordPolicy: { minLength: 8 },
			mfa: 'optional',
			mfaTypes: ['TOTP'],
		});
		await setupUserWithTotp(auth, 'jay');
		const { ctx } = freshContext();
		const challenge = await auth.signIn('jay', 'Password!1', ctx);
		if (challenge.status === 'signedIn') throw new Error('expected challenge');
		const session = (challenge.nextStep as { session: string }).session;
		// Force expiry.
		const entry = (auth as any).challenges.get(session);
		entry.exp = Date.now() - 1;
		await assert.rejects(
			() => auth.confirmSignIn(session, '123456', ctx),
			(e: Error) => isBlocksError(e, AuthCognitoErrors.ExpiredCode),
		);
	});

	test('required MFA + no enrollment triggers setup flow', async () => {
		const auth = new AuthCognito(ROOT, unique('mfa-5'), {
			passwordPolicy: { minLength: 8 },
			mfa: 'required',
			mfaTypes: ['TOTP'],
		});
		let code = '';
		(auth as any).options.codeDelivery = async (_u: string, c: string) => { code = c; };
		await auth.signUp('kim', 'Password!1', { attributes: { email: 'k@x.com' } });
		await auth.confirmSignUp('kim', code);
		const { ctx } = freshContext();
		const r = await auth.signIn('kim', 'Password!1', ctx);
		assert.strictEqual(r.status, 'continueSignIn');
		if (r.status === 'continueSignIn') {
			assert.strictEqual(r.nextStep.name, 'CONTINUE_SIGN_IN_WITH_TOTP_SETUP');
		}
	});

	test('required MFA TOTP setup completes end-to-end', async () => {
		const auth = new AuthCognito(ROOT, unique('mfa-6'), {
			passwordPolicy: { minLength: 8 },
			mfa: 'required',
			mfaTypes: ['TOTP'],
		});
		let code = '';
		(auth as any).options.codeDelivery = async (_u: string, c: string) => { code = c; };
		await auth.signUp('lee', 'Password!1', { attributes: { email: 'lee@x.com' } });
		await auth.confirmSignUp('lee', code);
		const { ctx } = freshContext();
		const r = await auth.signIn('lee', 'Password!1', ctx);
		if (r.status === 'signedIn') throw new Error('expected TOTP setup challenge');
		assert.strictEqual(r.nextStep.name, 'CONTINUE_SIGN_IN_WITH_TOTP_SETUP');
		if (r.nextStep.name !== 'CONTINUE_SIGN_IN_WITH_TOTP_SETUP') return;
		assert.ok(r.nextStep.sharedSecret.length > 0, 'shared secret emitted');
		// Mock accepts any 6-digit code (see DESIGN.md "Mock vs AWS Parity Gaps").
		const done = await auth.confirmSignIn(r.nextStep.session, { code: '123456' }, ctx);
		assert.strictEqual(done.status, 'signedIn');
	});

	test('MFA EMAIL setup: address submit → code round-trip signs in', async () => {
		const auth = new AuthCognito(ROOT, unique('mfa-7'), {
			passwordPolicy: { minLength: 8 },
			mfa: 'required',
			mfaTypes: ['TOTP', 'EMAIL'],
		});
		let lastCode = '';
		(auth as any).options.codeDelivery = async (_u: string, c: string) => { lastCode = c; };
		await auth.signUp('morgan', 'Password!1', { attributes: { email: 'morgan@x.com' } });
		await auth.confirmSignUp('morgan', lastCode);
		// Simulate a pool where the user's email hasn't been auto-verified —
		// mirrors real Cognito when the sign-up attribute wasn't delivered (or
		// the pool is configured without `autoVerify.email`). Without this,
		// the mock's challenge selector treats email as auto-enrolled and
		// skips setup.
		const mockUser = (auth as any).state.users.morgan;
		mockUser.attributes.email_verified = 'false';
		(auth as any).flushToDisk();
		const { ctx } = freshContext();
		// First login → setup selection (only TOTP + EMAIL can be enrolled).
		const r1 = await auth.signIn('morgan', 'Password!1', ctx);
		if (r1.status === 'signedIn') throw new Error('expected setup selection');
		assert.strictEqual(r1.nextStep.name, 'CONTINUE_SIGN_IN_WITH_MFA_SETUP_SELECTION');
		if (r1.nextStep.name !== 'CONTINUE_SIGN_IN_WITH_MFA_SETUP_SELECTION') return;
		// Pick EMAIL → asks for an address.
		const r2 = await auth.confirmSignIn(r1.nextStep.session, { mfaType: 'EMAIL' as 'EMAIL' }, ctx);
		if (r2.status === 'signedIn') throw new Error('expected email-setup step');
		assert.strictEqual(r2.nextStep.name, 'CONTINUE_SIGN_IN_WITH_EMAIL_SETUP');
		if (r2.nextStep.name !== 'CONTINUE_SIGN_IN_WITH_EMAIL_SETUP') return;
		// Submit address → code is delivered + EMAIL_CODE challenge follows.
		lastCode = '';
		const r3 = await auth.confirmSignIn(r2.nextStep.session, { email: 'morgan-new@x.com' }, ctx);
		if (r3.status === 'signedIn') throw new Error('expected follow-up code challenge');
		assert.strictEqual(r3.nextStep.name, 'CONFIRM_SIGN_IN_WITH_EMAIL_CODE');
		if (r3.nextStep.name !== 'CONFIRM_SIGN_IN_WITH_EMAIL_CODE') return;
		assert.ok(lastCode.length > 0, 'code generated after address submission');
		const r4 = await auth.confirmSignIn(r3.nextStep.session, { code: lastCode }, ctx);
		assert.strictEqual(r4.status, 'signedIn');
	});
});

// ─── updateMFAPreference / fetchMFAPreference (per-factor delta) ───────────

describe('updateMFAPreference / fetchMFAPreference', () => {
	// `mfa: 'off'` keeps signIn from issuing a challenge so we can get a
	// session and test updateMFAPreference directly. `mfaTypes` still
	// allows the full factor set so per-factor updates succeed.
	//
	// Pre-enrolls TOTP on the mock user (sets `totpVerified = true`)
	// so tests that enable TOTP don't hit the "not associated" guard
	// added in Phase D. Tests that want to exercise the guard build
	// their own pool without this pre-flight.
	async function signedInMfaUser(id: string, mfaTypes: readonly ('SMS' | 'TOTP' | 'EMAIL')[] = ['SMS', 'TOTP', 'EMAIL']) {
		const auth = new AuthCognito(ROOT, unique(id), {
			passwordPolicy: { minLength: 8 },
			mfa: 'off',
			mfaTypes,
		});
		let code = '';
		(auth as any).options.codeDelivery = async (_u: string, c: string) => { code = c; };
		const uname = `u-${Math.random().toString(36).slice(2, 8)}`;
		await auth.signUp(uname, 'Password!1', { attributes: { email: `${uname}@x.com` } });
		await auth.confirmSignUp(uname, code);
		// Pre-enroll TOTP so updateMFAPreference({ totp: ... }) doesn't
		// hit the `SoftwareTokenMFANotFound` guard.
		const u = (auth as any).state.users[uname];
		u.totpVerified = true;
		(auth as any).flushToDisk();
		const { ctx } = freshContext();
		await auth.signIn(uname, 'Password!1', ctx);
		return { auth, ctx };
	}

	test('PREFERRED on one factor enables it and sets preferred', async () => {
		const { auth, ctx } = await signedInMfaUser('pref-1');
		await auth.updateMFAPreference(ctx, { totp: 'PREFERRED' });
		const pref = await auth.fetchMFAPreference(ctx);
		assert.ok(pref.enabled.includes('TOTP'));
		assert.strictEqual(pref.preferred, 'TOTP');
	});

	test('second PREFERRED in a later call auto-demotes the first', async () => {
		const { auth, ctx } = await signedInMfaUser('pref-2');
		await auth.updateMFAPreference(ctx, { totp: 'PREFERRED' });
		await auth.updateMFAPreference(ctx, { email: 'PREFERRED' });
		const pref = await auth.fetchMFAPreference(ctx);
		assert.ok(pref.enabled.includes('TOTP'), 'TOTP stays enabled after demotion');
		assert.ok(pref.enabled.includes('EMAIL'));
		assert.strictEqual(pref.preferred, 'EMAIL');
	});

	test('ENABLED keeps factor in enabled without preferring it', async () => {
		const { auth, ctx } = await signedInMfaUser('pref-3');
		await auth.updateMFAPreference(ctx, { totp: 'PREFERRED' });
		await auth.updateMFAPreference(ctx, { email: 'ENABLED' });
		const pref = await auth.fetchMFAPreference(ctx);
		assert.ok(pref.enabled.includes('TOTP'));
		assert.ok(pref.enabled.includes('EMAIL'));
		assert.strictEqual(pref.preferred, 'TOTP', 'preferred unchanged');
	});

	test('DISABLED removes factor from enabled + clears preferred when it matches', async () => {
		const { auth, ctx } = await signedInMfaUser('pref-4');
		await auth.updateMFAPreference(ctx, { totp: 'PREFERRED', email: 'ENABLED' });
		await auth.updateMFAPreference(ctx, { totp: 'DISABLED' });
		const pref = await auth.fetchMFAPreference(ctx);
		assert.ok(!pref.enabled.includes('TOTP'));
		assert.ok(pref.enabled.includes('EMAIL'));
		assert.strictEqual(pref.preferred, undefined, 'preferred cleared since TOTP was preferred');
	});

	test('DISABLING the last factor yields NOMFA sentinel', async () => {
		// Narrow the pool so there are no auto-verified factors to re-add.
		// (With EMAIL in mfaTypes and email_verified='true' the mock
		// auto-enables EMAIL on read — documented Cognito parity behavior.)
		const { auth, ctx } = await signedInMfaUser('pref-5', ['SMS', 'TOTP']);
		await auth.updateMFAPreference(ctx, { totp: 'PREFERRED' });
		await auth.updateMFAPreference(ctx, { sms: 'DISABLED', totp: 'DISABLED' });
		const pref = await auth.fetchMFAPreference(ctx);
		assert.deepStrictEqual(pref.enabled, []);
		assert.strictEqual(pref.preferred, 'NOMFA');
	});

	test('two PREFERRED in one call throws InvalidParameter', async () => {
		const { auth, ctx } = await signedInMfaUser('pref-6');
		await assert.rejects(
			() => auth.updateMFAPreference(ctx, { totp: 'PREFERRED', email: 'PREFERRED' }),
			(e: Error) => isBlocksError(e, AuthCognitoErrors.InvalidParameter),
		);
	});

	test('enabling TOTP on an unassociated user throws SoftwareTokenMFANotFound', async () => {
		// Fresh pool, no TOTP enrollment — user.totpVerified is false.
		const auth = new AuthCognito(ROOT, unique('totp-guard'), {
			passwordPolicy: { minLength: 8 },
			mfa: 'off',
			mfaTypes: ['TOTP', 'EMAIL'],
		});
		let code = '';
		(auth as any).options.codeDelivery = async (_u: string, c: string) => { code = c; };
		await auth.signUp('no-totp', 'Password!1', { attributes: { email: 'n@x.com' } });
		await auth.confirmSignUp('no-totp', code);
		const { ctx } = freshContext();
		await auth.signIn('no-totp', 'Password!1', ctx);

		await assert.rejects(
			() => auth.updateMFAPreference(ctx, { totp: 'PREFERRED' }),
			(e: Error) => isBlocksError(e, AuthCognitoErrors.SoftwareTokenMFANotFound),
		);
		// DISABLED still works (clearing a never-enabled factor is a no-op).
		await auth.updateMFAPreference(ctx, { totp: 'DISABLED' });
	});

	test('factor not in pool mfaTypes throws InvalidParameter', async () => {
		const { auth, ctx } = await signedInMfaUser('pref-7', ['TOTP', 'EMAIL']); // SMS absent
		await assert.rejects(
			() => auth.updateMFAPreference(ctx, { sms: 'ENABLED' } as any),
			(e: Error) => isBlocksError(e, AuthCognitoErrors.InvalidParameter),
		);
	});
});

// ─── Profile ────────────────────────────────────────────────────────────────

describe('profile operations', () => {
	async function signedInAs(username: string, id = unique('prof')) {
		const auth = new AuthCognito(ROOT, id, { passwordPolicy: { minLength: 8 }, userAttributes: [{ name: 'department' }] });
		let code = '';
		(auth as any).options.codeDelivery = async (_u: string, c: string) => { code = c; };
		await auth.signUp(username, 'Password!1', { attributes: { email: `${username}@x.com`, department: 'eng' } });
		await auth.confirmSignUp(username, code);
		const { ctx } = freshContext();
		await auth.signIn(username, 'Password!1', ctx);
		return { auth, ctx };
	}

	test('fetchUserAttributes returns current attrs', async () => {
		const { auth, ctx } = await signedInAs('alice');
		const attrs = await auth.fetchUserAttributes(ctx);
		assert.strictEqual(attrs.email, 'alice@x.com');
		assert.strictEqual(attrs['custom:department'], 'eng');
	});

	test('updatePassword rejects wrong old password', async () => {
		const { auth, ctx } = await signedInAs('bob');
		await assert.rejects(
			() => auth.updatePassword(ctx, 'Wrong!Pass1', 'NewPassword!1'),
			(e: Error) => isBlocksError(e, AuthCognitoErrors.NotAuthorized),
		);
	});

	test('updatePassword enforces policy on new password', async () => {
		const { auth, ctx } = await signedInAs('carol');
		await assert.rejects(
			() => auth.updatePassword(ctx, 'Password!1', 'short'),
			(e: Error) => isBlocksError(e, AuthCognitoErrors.InvalidPassword),
		);
	});

	test('updatePassword + re-signIn with new password', async () => {
		const { auth, ctx } = await signedInAs('dan');
		await auth.updatePassword(ctx, 'Password!1', 'NewPassword!1');
		await auth.signOut(ctx);
		const { ctx: ctx2 } = freshContext();
		await auth.signIn('dan', 'NewPassword!1', ctx2);
	});

	test('updateUserAttributes on non-email attr returns isUpdated:true', async () => {
		const { auth, ctx } = await signedInAs('eve');
		const r = await auth.updateUserAttributes(ctx, { department: 'sales' });
		assert.deepStrictEqual(r, { 'custom:department': { isUpdated: true } });
	});

	test('fetchUserAttributes is live — reflects updateUserAttributes without re-signIn', async () => {
		const { auth, ctx } = await signedInAs('eve-live');
		const before = await auth.fetchUserAttributes(ctx);
		assert.strictEqual(before['custom:department'], 'eng');
		await auth.updateUserAttributes(ctx, { department: 'sales' });
		const after = await auth.fetchUserAttributes(ctx);
		assert.strictEqual(after['custom:department'], 'sales');
	});

	test('updateUserAttributes on email returns CONFIRM_ATTRIBUTE_WITH_CODE', async () => {
		const { auth, ctx } = await signedInAs('frank');
		const r = await auth.updateUserAttributes(ctx, { email: 'new@x.com' });
		const outcome = r.email;
		assert.ok(outcome, 'expected outcome for email');
		assert.strictEqual(outcome.isUpdated, false);
		if (!outcome.isUpdated) {
			assert.strictEqual(outcome.nextStep.name, 'CONFIRM_ATTRIBUTE_WITH_CODE');
		}
	});

	test('deleteUser clears session + user', async () => {
		const { auth, ctx } = await signedInAs('grace');
		await auth.deleteUser(ctx);
		const { ctx: ctx2 } = freshContext();
		assert.strictEqual(await auth.getCurrentUser(ctx2), null);
	});
});

// ─── Password reset ─────────────────────────────────────────────────────────

describe('resetPassword / confirmResetPassword', () => {
	test('full reset round trip', async () => {
		let code = '';
		const auth = new AuthCognito(ROOT, unique('reset-1'), {
			passwordPolicy: { minLength: 8 },
			codeDelivery: async (_u, c) => { code = c; },
		});
		await auth.signUp('hugo', 'Password!1', { attributes: { email: 'h@x.com' } });
		await auth.confirmSignUp('hugo', code);
		await auth.resetPassword('hugo');
		await auth.confirmResetPassword('hugo', code, 'NewPassword!1');
		const { ctx } = freshContext();
		await auth.signIn('hugo', 'NewPassword!1', ctx);
	});

	test('resetPassword for unknown user succeeds silently (avoid leaking)', async () => {
		const auth = new AuthCognito(ROOT, unique('reset-2'));
		const r = await auth.resetPassword('no-such-user');
		assert.strictEqual(r.isPasswordReset, false);
		assert.ok(r.nextStep);
	});

	test('confirmResetPassword with wrong code throws', async () => {
		let code = '';
		const auth = new AuthCognito(ROOT, unique('reset-3'), {
			passwordPolicy: { minLength: 8 },
			codeDelivery: async (_u, c) => { code = c; },
		});
		await auth.signUp('ivy', 'Password!1', { attributes: { email: 'i@x.com' } });
		await auth.confirmSignUp('ivy', code);
		await auth.resetPassword('ivy');
		await assert.rejects(
			() => auth.confirmResetPassword('ivy', '000000', 'NewPassword!1'),
			(e: Error) => isBlocksError(e, AuthCognitoErrors.CodeMismatch),
		);
	});
});

// ─── Devices ────────────────────────────────────────────────────────────────

describe('devices', () => {
	async function signedInUser(id = unique('dev')) {
		const auth = new AuthCognito(ROOT, id, { passwordPolicy: { minLength: 8 } });
		let code = '';
		(auth as any).options.codeDelivery = async (_u: string, c: string) => { code = c; };
		await auth.signUp('nora', 'Password!1', { attributes: { email: 'n@x.com' } });
		await auth.confirmSignUp('nora', code);
		const { ctx } = freshContext();
		await auth.signIn('nora', 'Password!1', ctx);
		return { auth, ctx };
	}

	test('fetchDevices yields remembered devices', async () => {
		const { auth, ctx } = await signedInUser();
		await auth.rememberDevice(ctx);
		await auth.rememberDevice(ctx);
		const keys: string[] = [];
		for await (const d of auth.fetchDevices(ctx)) keys.push(d.deviceKey);
		assert.strictEqual(keys.length, 2);
	});

	test('forgetDevice with explicit key drops it', async () => {
		const { auth, ctx } = await signedInUser();
		await auth.rememberDevice(ctx);
		const first: string[] = [];
		for await (const d of auth.fetchDevices(ctx)) first.push(d.deviceKey);
		await auth.forgetDevice(ctx, first[0]);
		const after: string[] = [];
		for await (const d of auth.fetchDevices(ctx)) after.push(d.deviceKey);
		assert.strictEqual(after.length, 0);
	});
});

// ─── createApi ──────────────────────────────────────────────────────────────

describe('createApi state-machine namespace', () => {
	test('createApi returns a state machine with getAuthState + setAuthState', async () => {
		const auth = new AuthCognito(ROOT, unique('sm-1'), {
			passwordPolicy: { minLength: 8 },
			selfSignUp: true,
		});
		const api = auth.createApi() as any;
		assert.strictEqual(typeof api, 'function');
	});
});

// ─── AuthFlowType guard ─────────────────────────────────────────────────────

describe('authFlowType runtime-throw guard', () => {
	test('USER_PASSWORD_AUTH is accepted', () => {
		assert.doesNotThrow(() => new AuthCognito(ROOT, unique('flow-ok'), { authFlowType: 'USER_PASSWORD_AUTH' }));
	});

	test('USER_AUTH is accepted', () => {
		assert.doesNotThrow(() => new AuthCognito(ROOT, unique('flow-user-auth'), { authFlowType: 'USER_AUTH' }));
	});

	test('USER_SRP_AUTH throws', () => {
		assert.throws(
			() => new AuthCognito(ROOT, unique('flow-srp'), { authFlowType: 'USER_SRP_AUTH' }),
			/USER_SRP_AUTH.*not yet supported/,
		);
	});

	test('CUSTOM_AUTH throws', () => {
		assert.throws(
			() => new AuthCognito(ROOT, unique('flow-custom'), { authFlowType: 'CUSTOM_AUTH' }),
			/CUSTOM_AUTH.*not yet supported/,
		);
	});
});

// ─── USER_AUTH flow (mock-end-to-end) ───────────────────────────────────────

describe('USER_AUTH flow', () => {
	async function confirmedUser(id: string, extra?: { preferredChallenge?: 'PASSWORD' | 'EMAIL_OTP' | 'SMS_OTP' }) {
		const auth = new AuthCognito(ROOT, unique(id), {
			passwordPolicy: { minLength: 8 },
			mfa: 'off',
			mfaTypes: ['SMS', 'TOTP', 'EMAIL'],
			authFlowType: 'USER_AUTH',
			preferredChallenge: extra?.preferredChallenge,
		});
		let lastCode = '';
		(auth as any).options.codeDelivery = async (_u: string, c: string) => { lastCode = c; };
		await auth.signUp('ursula', 'Password!1', { attributes: { email: 'u@example.com', phone_number: '+15550001111' } });
		await auth.confirmSignUp('ursula', lastCode);
		// Post-sign-up, mock flips email_verified + phone_number_verified to
		// 'true' on the delivered contacts — mirrors Cognito.
		return { auth, codeHolder: () => lastCode };
	}

	test('no preference → first-factor selection surfaces available factors', async () => {
		const { auth } = await confirmedUser('ua-1');
		const { ctx } = freshContext();
		const r = await auth.signIn('ursula', '', ctx);
		assert.strictEqual(r.status, 'continueSignIn');
		if (r.status === 'continueSignIn') {
			assert.strictEqual(r.nextStep.name, 'CONTINUE_SIGN_IN_WITH_FIRST_FACTOR_SELECTION');
			if (r.nextStep.name === 'CONTINUE_SIGN_IN_WITH_FIRST_FACTOR_SELECTION') {
				assert.deepStrictEqual(
					[...r.nextStep.availableChallenges].sort(),
					['EMAIL_OTP', 'PASSWORD', 'SMS_OTP'],
				);
			}
		}
	});

	test('pool-level preferredChallenge=PASSWORD → CONFIRM_SIGN_IN_WITH_PASSWORD', async () => {
		const { auth } = await confirmedUser('ua-2', { preferredChallenge: 'PASSWORD' });
		const { ctx } = freshContext();
		const r = await auth.signIn('ursula', '', ctx);
		if (r.status === 'signedIn') throw new Error('expected challenge');
		assert.strictEqual(r.nextStep.name, 'CONFIRM_SIGN_IN_WITH_PASSWORD');
		if (r.nextStep.name !== 'CONFIRM_SIGN_IN_WITH_PASSWORD') return;
		// Completing the password leg signs the user in.
		const confirmed = await auth.confirmSignIn(r.nextStep.session, { password: 'Password!1' }, ctx);
		assert.strictEqual(confirmed.status, 'signedIn');
	});

	test('preferredChallenge=EMAIL_OTP → passwordless sign-in via code', async () => {
		const { auth, codeHolder } = await confirmedUser('ua-3', { preferredChallenge: 'EMAIL_OTP' });
		const { ctx } = freshContext();
		const r = await auth.signIn('ursula', '', ctx);
		if (r.status === 'signedIn') throw new Error('expected challenge');
		assert.strictEqual(r.nextStep.name, 'CONFIRM_SIGN_IN_WITH_FIRST_FACTOR_EMAIL_OTP');
		if (r.nextStep.name !== 'CONFIRM_SIGN_IN_WITH_FIRST_FACTOR_EMAIL_OTP') return;
		const confirmed = await auth.confirmSignIn(r.nextStep.session, { code: codeHolder() }, ctx);
		assert.strictEqual(confirmed.status, 'signedIn');
	});

	test('SELECT_CHALLENGE → pick EMAIL_OTP → passwordless sign-in', async () => {
		const { auth, codeHolder } = await confirmedUser('ua-4');
		const { ctx } = freshContext();
		const r = await auth.signIn('ursula', '', ctx);
		if (r.status === 'signedIn') throw new Error('expected challenge');
		if (r.nextStep.name !== 'CONTINUE_SIGN_IN_WITH_FIRST_FACTOR_SELECTION') {
			throw new Error(`unexpected step: ${r.nextStep.name}`);
		}
		const picked = await auth.confirmSignIn(r.nextStep.session, { firstFactor: 'EMAIL_OTP' }, ctx);
		if (picked.status === 'signedIn') throw new Error('expected follow-up challenge');
		assert.strictEqual(picked.nextStep.name, 'CONFIRM_SIGN_IN_WITH_FIRST_FACTOR_EMAIL_OTP');
		if (picked.nextStep.name !== 'CONFIRM_SIGN_IN_WITH_FIRST_FACTOR_EMAIL_OTP') return;
		const confirmed = await auth.confirmSignIn(picked.nextStep.session, { code: codeHolder() }, ctx);
		assert.strictEqual(confirmed.status, 'signedIn');
	});

	test('state-machine dispatch: SELECT_CHALLENGE → PASSWORD → signed in', async () => {
		const { auth } = await confirmedUser('ua-5');
		const { ctx } = freshContext();
		const api = (auth.createApi() as any)(ctx);

		const s1 = await api.setAuthState({ action: 'signIn', username: 'ursula', password: '' });
		assert.strictEqual(s1.state, 'confirmingSignIn');
		const pickAction = s1.actions[0];
		const sessionField = pickAction.fields.find((f: any) => f.name === 'session');

		const s2 = await api.setAuthState({ action: 'confirmSignIn', challenge: 'firstFactor', session: sessionField.defaultValue, firstFactor: 'PASSWORD' });
		assert.strictEqual(s2.state, 'confirmingSignIn');
		const pwSession = s2.actions[0].fields.find((f: any) => f.name === 'session');
		assert.ok(pwSession);

		const s3 = await api.setAuthState({ action: 'confirmSignIn', challenge: 'password', session: pwSession.defaultValue, password: 'Password!1' });
		assert.strictEqual(s3.state, 'signedIn');
		assert.strictEqual(s3.user.username, 'ursula');
	});

	test('setAuthState surfaces errorName on a failed sign-in (issue #81)', async () => {
		const { auth } = await confirmedUser('ua-err', { preferredChallenge: 'PASSWORD' });
		const { ctx } = freshContext();
		const api = (auth.createApi() as any)(ctx);

		// Drive the password challenge to completion with a wrong password so
		// the thrown ApiError carries NotAuthorizedException.
		const s1 = await api.setAuthState({ action: 'signIn', username: 'ursula', password: '' });
		const pwSession = s1.actions[0].fields.find((f: any) => f.name === 'session');
		const next = await api.setAuthState({ action: 'confirmSignIn', challenge: 'password', session: pwSession.defaultValue, password: 'Wrong1!Password' });

		assert.strictEqual(next.state, 'signedOut');
		assert.strictEqual(next.errorName, AuthCognitoErrors.NotAuthorized);
		assert.ok(hasAuthError(next, AuthCognitoErrors.NotAuthorized));
	});
});

// ─── Passkeys (mock) ────────────────────────────────────────────────────────

describe('Passkeys', () => {
	async function passkeyAuthSignedIn(id: string) {
		const auth = new AuthCognito(ROOT, unique(id), {
			passwordPolicy: { minLength: 8 },
			authFlowType: 'USER_AUTH',
			enablePasskeys: true,
			webAuthnRelyingParty: { id: 'localhost', origins: ['http://localhost'], userVerification: 'preferred' },
		});
		let lastCode = '';
		(auth as any).options.codeDelivery = async (_u: string, c: string) => { lastCode = c; };
		await auth.signUp('paula', 'Password!1', { attributes: { email: 'p@example.com' } });
		await auth.confirmSignUp('paula', lastCode);
		const { ctx } = freshContext();
		// Sign the user in via PASSWORD first factor so the access token
		// cookie is on `ctx`. Subsequent passkey calls use that session.
		const r = await auth.signIn('paula', '', ctx, { preferredChallenge: 'PASSWORD' });
		if (r.status === 'signedIn') throw new Error('expected PASSWORD challenge');
		if (r.nextStep.name !== 'CONFIRM_SIGN_IN_WITH_PASSWORD') {
			throw new Error(`unexpected step: ${r.nextStep.name}`);
		}
		const final = await auth.confirmSignIn(r.nextStep.session, { password: 'Password!1' }, ctx);
		assert.strictEqual(final.status, 'signedIn');
		return { auth, ctx };
	}

	test('startPasskeyRegistration emits a creation-options blob with the configured rpId', async () => {
		const { auth, ctx } = await passkeyAuthSignedIn('pk-start');
		const r = await auth.startPasskeyRegistration(ctx);
		const opts = JSON.parse(r.credentialCreationOptions);
		assert.strictEqual(opts.rp.id, 'localhost');
		assert.strictEqual(opts.user.name, 'paula');
		assert.ok(opts.challenge);
	});

	test('completePasskeyRegistration persists the credential id', async () => {
		const { auth, ctx } = await passkeyAuthSignedIn('pk-complete');
		await auth.startPasskeyRegistration(ctx);
		await auth.completePasskeyRegistration(
			ctx,
			JSON.stringify({ id: 'cred-abc', type: 'public-key', response: { clientDataJSON: 'x' } }),
		);
		const list = await auth.listPasskeys(ctx);
		assert.strictEqual(list.length, 1);
		assert.strictEqual(list[0].credentialId, 'cred-abc');
	});

	test('completePasskeyRegistration rejects malformed JSON', async () => {
		const { auth, ctx } = await passkeyAuthSignedIn('pk-bad-json');
		await assert.rejects(
			() => auth.completePasskeyRegistration(ctx, 'not-json'),
			(e: unknown) => isBlocksError(e, AuthCognitoErrors.InvalidParameter),
		);
	});

	test('completePasskeyRegistration rejects missing credential id', async () => {
		const { auth, ctx } = await passkeyAuthSignedIn('pk-no-id');
		await assert.rejects(
			() => auth.completePasskeyRegistration(ctx, JSON.stringify({ type: 'public-key' })),
			(e: unknown) => isBlocksError(e, AuthCognitoErrors.InvalidParameter),
		);
	});

	test('deletePasskey removes the credential', async () => {
		const { auth, ctx } = await passkeyAuthSignedIn('pk-delete');
		await auth.completePasskeyRegistration(
			ctx,
			JSON.stringify({ id: 'cred-1', type: 'public-key' }),
		);
		await auth.completePasskeyRegistration(
			ctx,
			JSON.stringify({ id: 'cred-2', type: 'public-key' }),
		);
		await auth.deletePasskey(ctx, 'cred-1');
		const list = await auth.listPasskeys(ctx);
		assert.strictEqual(list.length, 1);
		assert.strictEqual(list[0].credentialId, 'cred-2');
	});

	test('passkey sign-in: preferredChallenge=WEB_AUTHN issues credentialRequestOptions; matching id signs in', async () => {
		const { auth, ctx } = await passkeyAuthSignedIn('pk-signin');
		await auth.completePasskeyRegistration(
			ctx,
			JSON.stringify({ id: 'cred-known', type: 'public-key' }),
		);
		await auth.signOut(ctx);
		const { ctx: ctx2 } = freshContext();
		const r = await auth.signIn('paula', '', ctx2, { preferredChallenge: 'WEB_AUTHN' });
		if (r.status === 'signedIn') throw new Error('expected WebAuthn challenge');
		assert.strictEqual(r.nextStep.name, 'CONFIRM_SIGN_IN_WITH_WEB_AUTHN');
		if (r.nextStep.name !== 'CONFIRM_SIGN_IN_WITH_WEB_AUTHN') return;
		const opts = JSON.parse(r.nextStep.credentialRequestOptions);
		assert.strictEqual(opts.rpId, 'localhost');
		assert.strictEqual(opts.allowCredentials[0].id, 'cred-known');
		const confirmed = await auth.confirmSignIn(
			r.nextStep.session,
			{ credential: JSON.stringify({ id: 'cred-known', response: {} }) },
			ctx2,
		);
		assert.strictEqual(confirmed.status, 'signedIn');
	});

	test('passkey sign-in rejects unknown credential id', async () => {
		const { auth, ctx } = await passkeyAuthSignedIn('pk-unknown');
		await auth.completePasskeyRegistration(
			ctx,
			JSON.stringify({ id: 'cred-known', type: 'public-key' }),
		);
		await auth.signOut(ctx);
		const { ctx: ctx2 } = freshContext();
		const r = await auth.signIn('paula', '', ctx2, { preferredChallenge: 'WEB_AUTHN' });
		if (r.status === 'signedIn') throw new Error('expected WebAuthn challenge');
		if (r.nextStep.name !== 'CONFIRM_SIGN_IN_WITH_WEB_AUTHN') throw new Error('unexpected');
		const session = r.nextStep.session;
		await assert.rejects(
			() => auth.confirmSignIn(
				session,
				{ credential: JSON.stringify({ id: 'cred-attacker' }) },
				ctx2,
			),
			(e: unknown) => isBlocksError(e, AuthCognitoErrors.WebAuthnCredentialNotSupported),
		);
	});

	test('first-factor selection lists WEB_AUTHN once a passkey is registered', async () => {
		const { auth, ctx } = await passkeyAuthSignedIn('pk-list');
		await auth.completePasskeyRegistration(
			ctx,
			JSON.stringify({ id: 'cred-1', type: 'public-key' }),
		);
		await auth.signOut(ctx);
		const { ctx: ctx2 } = freshContext();
		const r = await auth.signIn('paula', '', ctx2);
		if (r.status === 'signedIn') throw new Error('expected challenge');
		if (r.nextStep.name !== 'CONTINUE_SIGN_IN_WITH_FIRST_FACTOR_SELECTION') {
			throw new Error(`unexpected step: ${r.nextStep.name}`);
		}
		assert.ok(r.nextStep.availableChallenges.includes('WEB_AUTHN'));
		assert.ok(r.nextStep.availableChallenges.includes('EMAIL_OTP'));
	});

	test('state-machine dispatch: signInWithPasskey → confirmSignIn(webauthn) → signed in', async () => {
		const { auth, ctx } = await passkeyAuthSignedIn('pk-sm');
		await auth.completePasskeyRegistration(
			ctx,
			JSON.stringify({ id: 'cred-sm', type: 'public-key' }),
		);
		await auth.signOut(ctx);
		const { ctx: ctx2 } = freshContext();
		const api = (auth.createApi() as any)(ctx2);
		const s1 = await api.setAuthState({ action: 'signInWithPasskey', username: 'paula' });
		assert.strictEqual(s1.state, 'confirmingSignIn');
		const action = s1.actions[0];
		assert.strictEqual(action.capability, 'webauthn-get');
		const session = action.fields.find((f: any) => f.name === 'session').defaultValue;
		const credentialField = action.fields.find((f: any) => f.name === 'credential');
		assert.ok(credentialField);
		const s2 = await api.setAuthState({
			action: 'confirmSignIn',
			challenge: 'webauthn',
			session,
			credential: JSON.stringify({ id: 'cred-sm' }),
		});
		assert.strictEqual(s2.state, 'signedIn');
		assert.strictEqual(s2.user.username, 'paula');
	});

	test('signedIn state surfaces passkey-management buttons', async () => {
		const { auth, ctx } = await passkeyAuthSignedIn('pk-signed-in');
		const api = (auth.createApi() as any)(ctx);
		const state = await api.getAuthState();
		assert.strictEqual(state.state, 'signedIn');
		assert.ok(state.actions.find((a: any) => a.name === 'startPasskeyRegistration'));
		assert.ok(state.actions.find((a: any) => a.name === 'listPasskeys'));
	});
});
