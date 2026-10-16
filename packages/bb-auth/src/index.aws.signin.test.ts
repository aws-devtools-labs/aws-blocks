// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * AWS runtime — sign-in / sign-up / confirm-sign-up / sign-out, against a
 * spied Cognito client (no network). Pins the exact SDK command + input each
 * flow sends and the session record + cookie it produces.
 *
 * Ported from `bb-auth-cognito/src/index.aws.signin.test.ts` (B5/B6) so `Auth`
 * is held to `AuthCognito`'s behaviour. Where an expectation differs it says
 * why, inline (`Auth:`). Option renames (D3): `sessionTtlSeconds` →
 * `session.ttlSeconds`, `authFlowType` → `users.authFlow`, `userAttributes` →
 * `users.attributes`. Harness: `test-support/aws-harness.ts`.
 */

import assert from 'node:assert';
import crypto from 'node:crypto';
import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { isBlocksError } from '@aws-blocks/core';
import { AuthErrors, type SignInNextStep } from './index.aws.js';
import {
	Browser,
	cognitoError,
	makeAwsAuth,
	sessionIdOf,
	setCookieFor,
	signInAs,
	TEST_CLIENT_ID,
} from './test-support/aws-harness.js';

const DEFAULT_TTL = 400 * 86400;

/** The signed challenge envelope a next step carries (every challenge step has one). */
function stepSession(step: SignInNextStep): string {
	return 'session' in step ? step.session : '';
}

beforeEach(() => rmSync('.bb-data', { recursive: true, force: true }));
afterEach(() => rmSync('.bb-data', { recursive: true, force: true }));

describe('AWS signIn (USER_PASSWORD_AUTH)', () => {
	test('sends InitiateAuth with USER_PASSWORD_AUTH, the client id, and USERNAME/PASSWORD', async () => {
		const h = makeAwsAuth();
		const b = new Browser();
		h.on('InitiateAuthCommand', () => ({ AuthenticationResult: h.idp.authResult('alice') }));
		await b.request((ctx) => h.auth.signIn('alice', 'Password!1', ctx));
		assert.deepStrictEqual(h.sent, [
			{
				name: 'InitiateAuthCommand',
				input: {
					AuthFlow: 'USER_PASSWORD_AUTH',
					ClientId: TEST_CLIENT_ID,
					AuthParameters: { USERNAME: 'alice', PASSWORD: 'Password!1' },
				},
			},
		]);
	});

	test('forwards clientMetadata verbatim', async () => {
		const h = makeAwsAuth();
		const b = new Browser();
		h.on('InitiateAuthCommand', () => ({ AuthenticationResult: h.idp.authResult('alice') }));
		await b.request((ctx) => h.auth.signIn('alice', 'pw', ctx, { clientMetadata: { tenant: 't1' } }));
		assert.deepStrictEqual(h.sent[0].input.ClientMetadata, { tenant: 't1' });
	});

	test('writes exactly the three Cognito tokens as the session record, with the default 400-day TTL', async () => {
		const h = makeAwsAuth();
		const b = new Browser();
		const tokens = h.idp.authResult('alice');
		h.on('InitiateAuthCommand', () => ({ AuthenticationResult: tokens }));
		await b.request((ctx) => h.auth.signIn('alice', 'pw', ctx));

		assert.strictEqual(h.sessionWrites.length, 1);
		const [w] = h.sessionWrites;
		assert.deepStrictEqual(w.value, {
			idToken: tokens.IdToken,
			accessToken: tokens.AccessToken,
			refreshToken: tokens.RefreshToken,
		});
		assert.deepStrictEqual(w.options, { ttlSeconds: DEFAULT_TTL });
		// Opaque, server-generated id: 24 random bytes, base64url.
		assert.match(w.key, /^[A-Za-z0-9_-]{32}$/);
		assert.deepStrictEqual(await h.lookupSession(w.key), w.value);
	});

	test('sets an HttpOnly session cookie auth_<fullId>=<sessionId>.<hmac> with Max-Age = session TTL', async () => {
		const h = makeAwsAuth();
		const b = new Browser();
		h.on('InitiateAuthCommand', () => ({ AuthenticationResult: h.idp.authResult('alice') }));
		await b.request((ctx) => h.auth.signIn('alice', 'pw', ctx));

		const line = setCookieFor(b.lastSetCookies, h.cookieName);
		assert.ok(line, `expected a Set-Cookie for ${h.cookieName}`);
		const attrs = line.split(';').map((s) => s.trim());
		assert.ok(attrs.includes('HttpOnly'));
		assert.ok(attrs.includes('Path=/'));
		assert.ok(attrs.includes(`Max-Age=${DEFAULT_TTL}`));
		const value = b.jar.get(h.cookieName) ?? '';
		assert.strictEqual(sessionIdOf(value), h.sessionWrites[0].key, 'cookie carries the session id, not a token');
		assert.ok(!value.includes('eyJ'), 'no JWT in the cookie');
	});

	test('session.ttlSeconds drives both the record TTL and the cookie Max-Age', async () => {
		const h = makeAwsAuth({ session: { ttlSeconds: 3600 } });
		const b = new Browser();
		h.on('InitiateAuthCommand', () => ({ AuthenticationResult: h.idp.authResult('alice') }));
		await b.request((ctx) => h.auth.signIn('alice', 'pw', ctx));
		assert.deepStrictEqual(h.sessionWrites[0].options, { ttlSeconds: 3600 });
		assert.ok(setCookieFor(b.lastSetCookies, h.cookieName)?.includes('Max-Age=3600'));
	});

	test('a missing RefreshToken is stored as an empty string', async () => {
		const h = makeAwsAuth();
		const b = new Browser();
		h.on('InitiateAuthCommand', () => ({
			AuthenticationResult: h.idp.authResult('alice', { refreshToken: null }),
		}));
		await b.request((ctx) => h.auth.signIn('alice', 'pw', ctx));
		assert.strictEqual(h.sessionWrites[0].value.refreshToken, '');
	});

	test('returns the user projected from the verified ID token', async () => {
		const h = makeAwsAuth();
		const b = new Browser();
		h.on('InitiateAuthCommand', () => ({
			AuthenticationResult: h.idp.authResult('alice', {
				claims: { email: 'alice@example.com', 'cognito:groups': ['admins'] },
			}),
		}));
		const r = await b.request((ctx) => h.auth.signIn('alice', 'pw', ctx));
		assert.deepStrictEqual(r, {
			status: 'signedIn',
			user: {
				userId: 'alice',
				username: 'alice',
				userSub: 'sub-alice',
				groups: ['admins'],
				attributes: { email: 'alice@example.com' },
				// Auth: `AuthenticatedUser` adds `signInProvider` (design 04) — always
				// 'password' for a native sign-in.
				signInProvider: 'password',
			},
		});
	});

	test('an ID token not signed by the pool key is rejected: no session written, no cookie set', async () => {
		const h = makeAwsAuth();
		const b = new Browser();
		const { privateKey: foreign } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
		const genuine = h.idp.authResult('mallory');
		const forgedPayload = JSON.parse(Buffer.from(genuine.IdToken.split('.')[1], 'base64url').toString());
		h.on('InitiateAuthCommand', () => ({
			AuthenticationResult: { ...genuine, IdToken: h.idp.sign(forgedPayload, foreign) },
		}));
		await assert.rejects(() => b.request((ctx) => h.auth.signIn('mallory', 'pw', ctx)));
		assert.strictEqual(h.sessionWrites.length, 0);
		assert.strictEqual(b.jar.get(h.cookieName), undefined);
	});

	test('an ID token issued to a different app client is rejected', async () => {
		const h = makeAwsAuth();
		const b = new Browser();
		h.on('InitiateAuthCommand', () => ({
			AuthenticationResult: {
				...h.idp.authResult('alice'),
				IdToken: h.idp.idToken('alice', { aud: 'some-other-client' }),
			},
		}));
		await assert.rejects(() => b.request((ctx) => h.auth.signIn('alice', 'pw', ctx)));
		assert.strictEqual(h.sessionWrites.length, 0);
	});

	test('no AuthenticationResult and no challenge → rejects without writing a session', async () => {
		const h = makeAwsAuth();
		const b = new Browser();
		h.on('InitiateAuthCommand', () => ({}));
		await assert.rejects(
			() => b.request((ctx) => h.auth.signIn('alice', 'pw', ctx)),
			(e: Error & { status?: number }) => {
				assert.strictEqual(e.message, 'Cognito returned no tokens');
				assert.strictEqual(e.name, AuthErrors.NotAuthorized);
				// An error the block raised itself keeps its status: the SDK-error
				// mapper must not re-derive it from the name (was 401).
				assert.strictEqual(e.status, 500);
				return true;
			},
		);
		assert.strictEqual(h.sessionWrites.length, 0);
	});
});

describe('AWS signIn (USER_AUTH)', () => {
	test('no preferred challenge → only USERNAME (Cognito answers SELECT_CHALLENGE)', async () => {
		const h = makeAwsAuth({ users: { authFlow: 'USER_AUTH' } });
		const b = new Browser();
		h.on('InitiateAuthCommand', () => ({
			ChallengeName: 'SELECT_CHALLENGE',
			Session: 'cog-sel',
			ChallengeParameters: { AVAILABLE_CHALLENGES: '["PASSWORD","EMAIL_OTP","PASSWORD_SRP"]' },
		}));
		const r = await b.request((ctx) => h.auth.signIn('alice', 'ignored', ctx));
		assert.deepStrictEqual(h.sent[0].input, {
			AuthFlow: 'USER_AUTH',
			ClientId: TEST_CLIENT_ID,
			AuthParameters: { USERNAME: 'alice' },
		});
		assert.strictEqual(r.status, 'continueSignIn');
		assert.ok(r.status === 'continueSignIn' && r.nextStep.name === 'CONTINUE_SIGN_IN_WITH_FIRST_FACTOR_SELECTION');
		if (r.status === 'continueSignIn' && r.nextStep.name === 'CONTINUE_SIGN_IN_WITH_FIRST_FACTOR_SELECTION') {
			assert.deepStrictEqual(
				r.nextStep.availableChallenges,
				['PASSWORD', 'EMAIL_OTP'],
				'unsupported SRP is dropped',
			);
		}
	});

	test('preferredChallenge EMAIL_OTP → PREFERRED_CHALLENGE sent, PASSWORD withheld', async () => {
		const h = makeAwsAuth({ users: { authFlow: 'USER_AUTH' } });
		const b = new Browser();
		h.on('InitiateAuthCommand', () => ({
			ChallengeName: 'EMAIL_OTP',
			Session: 'cog-otp',
			ChallengeParameters: { CODE_DELIVERY_DESTINATION: 'a***@e***' },
		}));
		await b.request((ctx) => h.auth.signIn('alice', 'Password!1', ctx, { preferredChallenge: 'EMAIL_OTP' }));
		assert.deepStrictEqual(h.sent[0].input.AuthParameters, { USERNAME: 'alice', PREFERRED_CHALLENGE: 'EMAIL_OTP' });
	});

	test('preferredChallenge PASSWORD → PASSWORD bundled into InitiateAuth', async () => {
		// Auth: AuthCognito's pool-wide `preferredChallenge` is `users.preferredChallenge`
		// (D3 rename; restored by D5c2, L22).
		const h = makeAwsAuth({ users: { authFlow: 'USER_AUTH', preferredChallenge: 'PASSWORD' } });
		const b = new Browser();
		h.on('InitiateAuthCommand', () => ({ AuthenticationResult: h.idp.authResult('alice') }));
		await b.request((ctx) => h.auth.signIn('alice', 'Password!1', ctx));
		assert.deepStrictEqual(h.sent[0].input.AuthParameters, {
			USERNAME: 'alice',
			PREFERRED_CHALLENGE: 'PASSWORD',
			PASSWORD: 'Password!1',
		});
	});

	test('the per-call preferredChallenge overrides the pool default (added for Auth, L22)', async () => {
		const h = makeAwsAuth({ users: { authFlow: 'USER_AUTH', preferredChallenge: 'PASSWORD' } });
		const b = new Browser();
		h.on('InitiateAuthCommand', () => ({
			ChallengeName: 'EMAIL_OTP',
			Session: 'cog-otp',
			ChallengeParameters: { CODE_DELIVERY_DESTINATION: 'a***@e***' },
		}));
		const r = await b.request((ctx) => h.auth.signIn('alice', '', ctx, { preferredChallenge: 'EMAIL_OTP' }));
		assert.deepStrictEqual(h.sent[0].input.AuthParameters, { USERNAME: 'alice', PREFERRED_CHALLENGE: 'EMAIL_OTP' });
		assert.ok(r.status === 'continueSignIn');
		assert.strictEqual(r.nextStep.name, 'CONFIRM_SIGN_IN_WITH_FIRST_FACTOR_EMAIL_OTP');
	});

	test('the pool default is ignored by USER_PASSWORD_AUTH (added for Auth, L22)', async () => {
		const h = makeAwsAuth({ users: { preferredChallenge: 'EMAIL_OTP' } });
		const b = new Browser();
		h.on('InitiateAuthCommand', () => ({ AuthenticationResult: h.idp.authResult('alice') }));
		await b.request((ctx) => h.auth.signIn('alice', 'Password!1', ctx));
		assert.deepStrictEqual(h.sent[0].input, {
			AuthFlow: 'USER_PASSWORD_AUTH',
			ClientId: TEST_CLIENT_ID,
			AuthParameters: { USERNAME: 'alice', PASSWORD: 'Password!1' },
		});
	});
});

describe('AWS challenge round-trip (signIn → confirmSignIn)', () => {
	test('a challenge writes no session; confirmSignIn replays the Cognito session in RespondToAuthChallenge', async () => {
		const h = makeAwsAuth();
		const b = new Browser();
		h.on('InitiateAuthCommand', () => ({ ChallengeName: 'SOFTWARE_TOKEN_MFA', Session: 'cog-session-1' }));
		const first = await b.request((ctx) => h.auth.signIn('alice', 'pw', ctx));
		assert.strictEqual(first.status, 'continueSignIn');
		assert.strictEqual(h.sessionWrites.length, 0);
		assert.strictEqual(b.jar.get(h.cookieName), undefined);
		if (first.status !== 'continueSignIn') return;
		assert.strictEqual(first.nextStep.name, 'CONFIRM_SIGN_IN_WITH_TOTP_CODE');
		const envelope = stepSession(first.nextStep);
		assert.notStrictEqual(envelope, 'cog-session-1', 'client gets a signed envelope');

		h.on('RespondToAuthChallengeCommand', () => ({ AuthenticationResult: h.idp.authResult('alice') }));
		const second = await b.request((ctx) => h.auth.confirmSignIn(envelope, '123456', ctx));
		assert.strictEqual(second.status, 'signedIn');
		assert.deepStrictEqual(h.sent[1], {
			name: 'RespondToAuthChallengeCommand',
			input: {
				ClientId: TEST_CLIENT_ID,
				ChallengeName: 'SOFTWARE_TOKEN_MFA',
				Session: 'cog-session-1',
				ChallengeResponses: { USERNAME: 'alice', SOFTWARE_TOKEN_MFA_CODE: '123456' },
			},
		});
		assert.strictEqual(h.sessionWrites.length, 1);
		assert.ok(b.jar.get(h.cookieName));
	});

	test('a tampered challenge envelope → 400 ExpiredCodeException, Cognito never called', async () => {
		const h = makeAwsAuth();
		const b = new Browser();
		h.on('InitiateAuthCommand', () => ({ ChallengeName: 'SOFTWARE_TOKEN_MFA', Session: 'cog-session-1' }));
		const first = await b.request((ctx) => h.auth.signIn('alice', 'pw', ctx));
		assert.ok(first.status === 'continueSignIn');
		const [raw, sig] = stepSession(first.nextStep).split('.');
		const forged = JSON.parse(Buffer.from(raw, 'base64url').toString());
		forged.username = 'admin';
		const tampered = `${Buffer.from(JSON.stringify(forged)).toString('base64url')}.${sig}`;
		h.sent.length = 0;
		await assert.rejects(
			() => b.request((ctx) => h.auth.confirmSignIn(tampered, '123456', ctx)),
			(e: Error & { status?: number }) => e.status === 400 && isBlocksError(e, AuthErrors.ExpiredCode),
		);
		assert.deepStrictEqual(h.sent, []);
	});

	test('SRP challenges are refused before any RespondToAuthChallenge', async () => {
		const h = makeAwsAuth();
		const b = new Browser();
		h.on('InitiateAuthCommand', () => ({ ChallengeName: 'PASSWORD_VERIFIER', Session: 's' }));
		await assert.rejects(
			() => b.request((ctx) => h.auth.signIn('alice', 'pw', ctx)),
			(e: Error & { status?: number; retriable?: boolean }) => {
				assert.strictEqual(e.name, AuthErrors.InvalidParameter);
				assert.match(e.message, /requires the SRP flow/);
				// "Not implemented" stays a non-retriable 501 (was re-wrapped into a
				// retriable 400 that invited a retry that could never succeed).
				assert.strictEqual(e.status, 501);
				assert.strictEqual(e.retriable, false);
				return true;
			},
		);
		assert.deepStrictEqual(h.sentNames(), ['InitiateAuthCommand']);
	});
});

describe('AWS signUp / confirmSignUp', () => {
	test('SignUp input: client id, credentials, attributes (declared custom attrs prefixed)', async () => {
		const h = makeAwsAuth({ users: { attributes: [{ name: 'department', type: 'String' }] } });
		h.on('SignUpCommand', () => ({
			UserConfirmed: false,
			UserSub: 'sub-new',
			CodeDeliveryDetails: { Destination: 'n***@e***', DeliveryMedium: 'EMAIL', AttributeName: 'email' },
		}));
		const r = await h.auth.signUp('newbie', 'Password!1', {
			attributes: { email: 'newbie@example.com', department: 'eng' },
			clientMetadata: { src: 'web' },
		});
		assert.deepStrictEqual(h.sent, [
			{
				name: 'SignUpCommand',
				input: {
					ClientId: TEST_CLIENT_ID,
					Username: 'newbie',
					Password: 'Password!1',
					UserAttributes: [
						{ Name: 'email', Value: 'newbie@example.com' },
						{ Name: 'custom:department', Value: 'eng' },
					],
					ClientMetadata: { src: 'web' },
				},
			},
		]);
		assert.deepStrictEqual(r, {
			isSignUpComplete: false,
			userId: 'sub-new',
			nextStep: {
				name: 'CONFIRM_SIGN_UP',
				codeDeliveryDetails: { destination: 'n***@e***', deliveryMedium: 'EMAIL', attributeName: 'email' },
			},
		});
		assert.strictEqual(h.sessionWrites.length, 0, 'sign-up never mints a session');
	});

	test('an already-confirmed sign-up has no nextStep', async () => {
		const h = makeAwsAuth();
		h.on('SignUpCommand', () => ({ UserConfirmed: true, UserSub: 'sub-x' }));
		const r = await h.auth.signUp('x', 'Password!1');
		// Auth: `nextStep` is omitted rather than present-and-undefined (same
		// JSON on the wire; deepStrictEqual distinguishes the two).
		assert.deepStrictEqual(r, { isSignUpComplete: true, userId: 'sub-x' });
	});

	test('ConfirmSignUp input: client id, username, code — and DONE without an auto-sign-in bridge', async () => {
		const h = makeAwsAuth();
		h.on('ConfirmSignUpCommand', () => ({}));
		const r = await h.auth.confirmSignUp('newbie', '424242');
		assert.deepStrictEqual(h.sent, [
			{
				name: 'ConfirmSignUpCommand',
				input: { ClientId: TEST_CLIENT_ID, Username: 'newbie', ConfirmationCode: '424242' },
			},
		]);
		assert.deepStrictEqual(r, { isSignUpComplete: true, nextStep: { signUpStep: 'DONE' } });
	});

	test('ResendConfirmationCode input: client id + username', async () => {
		const h = makeAwsAuth();
		h.on('ResendConfirmationCodeCommand', () => ({}));
		await h.auth.resendSignUpCode('newbie');
		assert.deepStrictEqual(h.sent[0].input, { ClientId: TEST_CLIENT_ID, Username: 'newbie' });
	});
});

describe('AWS auto-sign-in bridge (signUp → confirmSignUp → autoSignIn)', () => {
	async function runBridge() {
		const h = makeAwsAuth();
		const b = new Browser();
		const bridge = `autosignin_${h.fullId}`;
		h.on('SignUpCommand', () => ({ UserConfirmed: false, UserSub: 'sub-n', Session: 'signup-session' }));
		// Auth (Q2): `emailPassword.autoSignIn` defaults on, so a sign-up with a
		// context sets the bridge — AuthCognito needed `{ autoSignIn: true }` per call.
		await b.request((ctx) => h.auth.signUp('newbie', 'Password!1', {}, ctx));
		return { h, b, bridge };
	}

	test('signUp stores an encrypted 15-minute bridge cookie that does not reveal the password', async () => {
		const { b, bridge } = await runBridge();
		const line = setCookieFor(b.lastSetCookies, bridge);
		assert.ok(line?.includes('Max-Age=900'));
		const value = b.jar.get(bridge) ?? '';
		assert.strictEqual(value.split('.').length, 4, 'iv.ciphertext.tag.hmac');
		const decoded = value
			.split('.')
			.map((p) => Buffer.from(p, 'base64url').toString('latin1'))
			.join('');
		assert.ok(!decoded.includes('Password!1'));
		assert.ok(!decoded.includes('signup-session'));
	});

	test('emailPassword.autoSignIn: false → no bridge cookie (added for Auth: the Q2 opt-out)', async () => {
		const h = makeAwsAuth({ emailPassword: { autoSignIn: false } });
		const b = new Browser();
		h.on('SignUpCommand', () => ({ UserConfirmed: false, UserSub: 'sub-n', Session: 'signup-session' }));
		await b.request((ctx) => h.auth.signUp('newbie', 'Password!1', {}, ctx));
		assert.strictEqual(setCookieFor(b.lastSetCookies, `autosignin_${h.fullId}`), undefined);
	});

	test('confirmSignUp threads the SignUp session and reports COMPLETE_AUTO_SIGN_IN', async () => {
		const { h, b } = await runBridge();
		h.on('ConfirmSignUpCommand', () => ({ Session: 'confirm-session' }));
		const r = await b.request((ctx) => h.auth.confirmSignUp('newbie', '424242', ctx));
		assert.deepStrictEqual(h.sent[1].input, {
			ClientId: TEST_CLIENT_ID,
			Username: 'newbie',
			ConfirmationCode: '424242',
			Session: 'signup-session',
		});
		assert.deepStrictEqual(r.nextStep, { signUpStep: 'COMPLETE_AUTO_SIGN_IN' });
	});

	test('confirmSignUp for a different username ignores the bridge', async () => {
		const { h, b } = await runBridge();
		h.on('ConfirmSignUpCommand', () => ({}));
		const r = await b.request((ctx) => h.auth.confirmSignUp('someone-else', '424242', ctx));
		assert.strictEqual(h.sent[1].input.Session, undefined);
		assert.deepStrictEqual(r.nextStep, { signUpStep: 'DONE' });
	});

	test('autoSignIn signs in with the cached password + ConfirmSignUp session and writes a session', async () => {
		const { h, b, bridge } = await runBridge();
		h.on('ConfirmSignUpCommand', () => ({ Session: 'confirm-session' }));
		await b.request((ctx) => h.auth.confirmSignUp('newbie', '424242', ctx));
		h.on('InitiateAuthCommand', () => ({ AuthenticationResult: h.idp.authResult('newbie') }));
		const r = await b.request((ctx) => h.auth.autoSignIn(ctx));
		assert.strictEqual(r.status, 'signedIn');
		assert.deepStrictEqual(h.sent[2].input, {
			AuthFlow: 'USER_PASSWORD_AUTH',
			ClientId: TEST_CLIENT_ID,
			AuthParameters: { USERNAME: 'newbie', PASSWORD: 'Password!1' },
			Session: 'confirm-session',
		});
		assert.strictEqual(h.sessionWrites.length, 1);
		assert.ok(b.jar.get(h.cookieName));
		// Both Set-Cookie values reach the browser: the new session cookie AND
		// the clear for the bridge cookie (which holds the encrypted password).
		// Writing the session cookie must not wipe the earlier clear.
		assert.ok(setCookieFor(b.lastSetCookies, h.cookieName));
		assert.ok(setCookieFor(b.lastSetCookies, bridge)?.includes('Max-Age=0'));
		assert.strictEqual(b.jar.get(bridge), undefined, 'bridge cookie is gone from the browser');
	});

	test('autoSignIn under USER_AUTH sends no password, only the bridge session (added for Auth)', async () => {
		const h = makeAwsAuth({ users: { authFlow: 'USER_AUTH' } });
		const b = new Browser();
		h.on('SignUpCommand', () => ({ UserConfirmed: false, UserSub: 'sub-n', Session: 'signup-session' }));
		await b.request((ctx) => h.auth.signUp('newbie', 'Password!1', {}, ctx));
		h.on('ConfirmSignUpCommand', () => ({ Session: 'confirm-session' }));
		await b.request((ctx) => h.auth.confirmSignUp('newbie', '424242', ctx));
		h.on('InitiateAuthCommand', () => ({ AuthenticationResult: h.idp.authResult('newbie') }));
		const r = await b.request((ctx) => h.auth.autoSignIn(ctx));
		assert.strictEqual(r.status, 'signedIn');
		assert.deepStrictEqual(h.sent[2].input, {
			AuthFlow: 'USER_AUTH',
			ClientId: TEST_CLIENT_ID,
			AuthParameters: { USERNAME: 'newbie' },
			Session: 'confirm-session',
		});
	});

	test('a failed autoSignIn still clears the bridge cookie', async () => {
		const { h, b, bridge } = await runBridge();
		h.on('ConfirmSignUpCommand', () => ({ Session: 'confirm-session' }));
		await b.request((ctx) => h.auth.confirmSignUp('newbie', '424242', ctx));
		h.on('InitiateAuthCommand', () => {
			throw cognitoError('NotAuthorizedException', 'Incorrect username or password.');
		});
		await assert.rejects(() => b.request((ctx) => h.auth.autoSignIn(ctx)));
		assert.strictEqual(b.jar.get(bridge), undefined);
	});

	test('autoSignIn without a bridge cookie → 401 NotAuthenticated, Cognito never called', async () => {
		const h = makeAwsAuth();
		const b = new Browser();
		await assert.rejects(
			() => b.request((ctx) => h.auth.autoSignIn(ctx)),
			(e: Error & { status?: number }) => e.status === 401 && isBlocksError(e, AuthErrors.NotAuthenticated),
		);
		assert.deepStrictEqual(h.sent, []);
	});

	test('autoSignIn with a corrupted bridge cookie → 401 and the bridge is cleared', async () => {
		const { h, b, bridge } = await runBridge();
		b.jar.set(bridge, 'a.b.c.d');
		await assert.rejects(
			() => b.request((ctx) => h.auth.autoSignIn(ctx)),
			(e: Error & { status?: number }) => e.status === 401,
		);
		assert.strictEqual(b.jar.get(bridge), undefined);
		assert.deepStrictEqual(h.sentNames(), ['SignUpCommand']);
	});
});

describe('AWS signOut', () => {
	test('local signOut deletes the record and clears the cookie without calling Cognito', async () => {
		const h = makeAwsAuth();
		const b = new Browser();
		const sid = await signInAs(h, b, 'alice');
		await b.request((ctx) => h.auth.signOut(ctx));
		assert.deepStrictEqual(h.sent, []);
		assert.strictEqual(await h.lookupSession(sid), null);
		assert.ok(setCookieFor(b.lastSetCookies, h.cookieName)?.includes('Max-Age=0'));
		assert.strictEqual(b.jar.get(h.cookieName), undefined);
	});

	test('global signOut sends GlobalSignOut with the stored access token, then deletes locally', async () => {
		const h = makeAwsAuth();
		const b = new Browser();
		const tokens = h.idp.authResult('alice');
		const sid = await signInAs(h, b, 'alice', tokens);
		h.on('GlobalSignOutCommand', () => ({}));
		await b.request((ctx) => h.auth.signOut(ctx, { global: true }));
		assert.deepStrictEqual(h.sent, [{ name: 'GlobalSignOutCommand', input: { AccessToken: tokens.AccessToken } }]);
		assert.strictEqual(await h.lookupSession(sid), null);
		assert.strictEqual(b.jar.get(h.cookieName), undefined);
	});

	test('a rejected GlobalSignOut still deletes the local session and clears the cookie', async () => {
		const h = makeAwsAuth();
		const b = new Browser();
		const sid = await signInAs(h, b, 'alice');
		h.on('GlobalSignOutCommand', () => {
			throw cognitoError('NotAuthorizedException', 'Access Token has expired');
		});
		await b.request((ctx) => h.auth.signOut(ctx, { global: true }));
		assert.strictEqual(await h.lookupSession(sid), null);
		assert.strictEqual(b.jar.get(h.cookieName), undefined);
	});

	test('signOut with no cookie just clears the cookie', async () => {
		const h = makeAwsAuth();
		const b = new Browser();
		await b.request((ctx) => h.auth.signOut(ctx, { global: true }));
		assert.deepStrictEqual(h.sent, []);
		assert.ok(setCookieFor(b.lastSetCookies, h.cookieName)?.includes('Max-Age=0'));
	});
});
