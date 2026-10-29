// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * AWS runtime — authenticator-app (TOTP) enrolment through `createApi()`'s
 * `setAuthState`, against a spied Cognito client (no network): each action
 * sends the Cognito calls the matching method does (`AssociateSoftwareToken`,
 * `VerifySoftwareToken`, `SetUserMFAPreference`, `GetUser`), with the
 * session's access token, and answers an `AuthState`.
 * Harness: `test-support/aws-harness.ts`.
 */

import assert from 'node:assert';
import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, test } from 'node:test';
import type { AuthAction, AuthActionInput, AuthState, AuthStateApi } from '@aws-blocks/auth-common';
import crypto from 'node:crypto';
import { type BlocksContext, clearRouteRegistry } from '@aws-blocks/core';
import { federationConfigKeys } from './cdk/contract.js';
import { type Auth, AuthErrors } from './index.aws.js';
import {
	Browser,
	cognitoError,
	makeAwsAuth,
	signInAs,
	TEST_CLIENT_ID,
	TEST_POOL_ID,
	TEST_REGION,
} from './test-support/aws-harness.js';
import type { AuthOptions } from './types.js';

const TOTP = { mfa: { mode: 'optional', types: ['TOTP'], totpIssuer: 'Acme' } } as const;

beforeEach(() => {
	clearRouteRegistry();
	rmSync('.bb-data', { recursive: true, force: true });
});
afterEach(() => rmSync('.bb-data', { recursive: true, force: true }));

function apiFor<O extends AuthOptions>(auth: Auth<O>, ctx: BlocksContext): AuthStateApi {
	return (auth.createApi() as unknown as (c: BlocksContext) => AuthStateApi)(ctx);
}

function action(state: AuthState, name: string): AuthAction {
	const found = state.actions.find((a) => a.name === name);
	assert.ok(found, `${name} in ${JSON.stringify(state)}`);
	return found;
}

function field(a: AuthAction, name: string): string | undefined {
	return a.fields.find((f) => f.name === name)?.defaultValue;
}

describe('AWS createApi() — TOTP enrolment actions → Cognito', () => {
	test('setUpTotp → AssociateSoftwareToken; the state carries the secret and the otpauth URI', async () => {
		const h = makeAwsAuth(TOTP);
		const b = new Browser();
		const tokens = h.idp.authResult('alice');
		await signInAs(h, b, 'alice', tokens);
		h.on('GetUserCommand', () => ({ Username: 'alice', UserMFASettingList: [] }));
		h.on('AssociateSoftwareTokenCommand', () => ({ SecretCode: 'JBSWY3DPEHPK3PXP' }));
		const s = await b.request((ctx) => apiFor(h.auth, ctx).setAuthState({ action: 'setUpTotp' }));
		assert.deepStrictEqual(h.sent, [
			// Is an authenticator already enrolled (then the session must be fresh)?
			{ name: 'GetUserCommand', input: { AccessToken: tokens.AccessToken } },
			{ name: 'AssociateSoftwareTokenCommand', input: { AccessToken: tokens.AccessToken } },
		]);
		assert.strictEqual(s.state, 'signedIn');
		const verify = action(s, 'verifyTotpSetup');
		assert.strictEqual(field(verify, 'sharedSecret'), 'JBSWY3DPEHPK3PXP');
		assert.strictEqual(
			field(verify, 'otpauthUri'),
			'otpauth://totp/Acme:alice?secret=JBSWY3DPEHPK3PXP&issuer=Acme&algorithm=SHA1&digits=6&period=30',
		);
	});

	test('verifyTotpSetup → VerifySoftwareToken, GetUser, SetUserMFAPreference, then GetUser for the settings', async () => {
		const h = makeAwsAuth(TOTP);
		const b = new Browser();
		const tokens = h.idp.authResult('alice');
		await signInAs(h, b, 'alice', tokens);
		h.on('VerifySoftwareTokenCommand', () => ({ Status: 'SUCCESS' }));
		let enrolled = false;
		h.on('GetUserCommand', () =>
			enrolled
				? { Username: 'alice', UserMFASettingList: ['SOFTWARE_TOKEN_MFA'], PreferredMfaSetting: 'SOFTWARE_TOKEN_MFA' }
				: { Username: 'alice' },
		);
		h.on('SetUserMFAPreferenceCommand', () => {
			enrolled = true;
			return {};
		});
		const s = await b.request((ctx) =>
			apiFor(h.auth, ctx).setAuthState({ action: 'verifyTotpSetup', code: '123456' }),
		);
		assert.deepStrictEqual(h.sentNames(), [
			'VerifySoftwareTokenCommand',
			'GetUserCommand',
			'SetUserMFAPreferenceCommand',
			'GetUserCommand',
		]);
		assert.deepStrictEqual(h.sent[0].input, { AccessToken: tokens.AccessToken, UserCode: '123456' });
		assert.deepStrictEqual(h.sent[2].input, {
			AccessToken: tokens.AccessToken,
			SoftwareTokenMfaSettings: { Enabled: true, PreferredMfa: true },
		});
		assert.strictEqual(s.state, 'signedIn');
		assert.strictEqual(s.error, undefined);
		assert.strictEqual(action(s, 'setUpTotp').label, 'Replace authenticator app');
		assert.deepStrictEqual(
			s.actions.filter((a) => a.name === 'updateMfaPreference').map((a) => field(a, 'totp')),
			['DISABLED'],
		);
	});

	test('a wrong setup code is retriable (the form stays), and named', async () => {
		const h = makeAwsAuth(TOTP);
		const b = new Browser();
		await signInAs(h, b, 'alice');
		h.on('VerifySoftwareTokenCommand', () => {
			throw cognitoError('EnableSoftwareTokenMFAException', 'Code mismatch and fail enable Software Token MFA');
		});
		const s = await b.request((ctx) =>
			apiFor(h.auth, ctx).setAuthState({ action: 'verifyTotpSetup', code: '000000' }),
		);
		assert.strictEqual(s.retriable, true);
		assert.strictEqual(s.errorName, AuthErrors.EnableSoftwareTokenMFA);
		assert.deepStrictEqual(h.sentNames(), ['VerifySoftwareTokenCommand']);
	});

	test('updateMfaPreference → SetUserMFAPreference with only the given factor, then GetUser', async () => {
		const h = makeAwsAuth(TOTP);
		const b = new Browser();
		const tokens = h.idp.authResult('alice');
		await signInAs(h, b, 'alice', tokens);
		h.on('SetUserMFAPreferenceCommand', () => ({}));
		h.on('GetUserCommand', () => ({ Username: 'alice', UserMFASettingList: [] }));
		const s = await b.request((ctx) =>
			apiFor(h.auth, ctx).setAuthState({ action: 'updateMfaPreference', totp: 'DISABLED' }),
		);
		assert.deepStrictEqual(h.sent, [
			{
				name: 'SetUserMFAPreferenceCommand',
				input: { AccessToken: tokens.AccessToken, SoftwareTokenMfaSettings: { Enabled: false, PreferredMfa: false } },
			},
			{ name: 'GetUserCommand', input: { AccessToken: tokens.AccessToken } },
		]);
		assert.strictEqual(s.state, 'signedIn');
		assert.strictEqual(action(s, 'setUpTotp').label, 'Set up authenticator app');
	});

	test('getMfaPreference → GetUser only', async () => {
		const h = makeAwsAuth(TOTP);
		const b = new Browser();
		const tokens = h.idp.authResult('alice');
		await signInAs(h, b, 'alice', tokens);
		h.on('GetUserCommand', () => ({ Username: 'alice', UserMFASettingList: ['SOFTWARE_TOKEN_MFA'] }));
		const s = await b.request((ctx) => apiFor(h.auth, ctx).setAuthState({ action: 'getMfaPreference' }));
		assert.deepStrictEqual(h.sent, [{ name: 'GetUserCommand', input: { AccessToken: tokens.AccessToken } }]);
		// Enabled, not preferred: it can be made the default, or turned off.
		assert.deepStrictEqual(
			s.actions.filter((a) => a.name === 'updateMfaPreference').map((a) => field(a, 'totp')),
			['PREFERRED', 'DISABLED'],
		);
	});

	test('signed out: each action answers NotAuthenticatedException with no Cognito call', async () => {
		const h = makeAwsAuth(TOTP);
		const b = new Browser();
		const inputs: AuthActionInput[] = [
			{ action: 'setUpTotp' },
			{ action: 'verifyTotpSetup', code: '123456' },
			{ action: 'getMfaPreference' },
			{ action: 'updateMfaPreference', totp: 'ENABLED' },
		];
		for (const input of inputs) {
			const s = await b.request((ctx) => apiFor(h.auth, ctx).setAuthState(input));
			assert.strictEqual(s.state, 'signedOut', input.action);
			assert.strictEqual(s.errorName, AuthErrors.NotAuthenticated, input.action);
		}
		assert.deepStrictEqual(h.sent, []);
	});

	test('MFA off: each action answers MfaNotEnabledException with no Cognito call', async () => {
		const h = makeAwsAuth();
		const b = new Browser();
		await signInAs(h, b, 'alice');
		for (const input of [
			{ action: 'setUpTotp' },
			{ action: 'verifyTotpSetup', code: '123456' },
			{ action: 'getMfaPreference' },
			{ action: 'updateMfaPreference', totp: 'ENABLED' },
		] satisfies AuthActionInput[]) {
			const s = await b.request((ctx) => apiFor(h.auth, ctx).setAuthState(input));
			assert.strictEqual(s.errorName, AuthErrors.MfaNotEnabled, input.action);
		}
		assert.deepStrictEqual(h.sent, []);
	});
});

const HOSTED_UI_CLIENT_ID = 'totphosteduiclient000000';

/** A Cognito-shaped access token payload (as `index.aws.bearer.test.ts`). */
function accessClaims(username: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
	const now = Math.floor(Date.now() / 1000);
	return {
		sub: `sub-${username}`,
		username,
		client_id: TEST_CLIENT_ID,
		token_use: 'access',
		scope: 'aws.cognito.signin.user.admin',
		auth_time: now,
		iss: `https://cognito-idp.${TEST_REGION}.amazonaws.com/${TEST_POOL_ID}`,
		iat: now,
		exp: now + 3600,
		jti: crypto.randomUUID(),
		...extra,
	};
}

/** The TOTP harness with `allowBearerAuth` (and optionally a hosted-UI provider), its verifier on the fake JWKS. */
function makeBearerTotpAuth(hostedUi = false) {
	const h = makeAwsAuth({
		...TOTP,
		allowBearerAuth: true,
		...(hostedUi
			? { socialProviders: { google: { clientId: 'g', clientSecret: { fullId: 'totp-unused', get: async () => 'x' } } } }
			: {}),
	});
	if (hostedUi) process.env[federationConfigKeys(h.fullId).HOSTED_UI_CLIENT_ID] = HOSTED_UI_CLIENT_ID;
	Reflect.get(Reflect.get(h.auth, 'poolBearer'), 'verifier').cacheJwks(h.idp.jwks);
	return h;
}

function withBearer(ctx: BlocksContext, token: string): BlocksContext {
	ctx.request.headers.set('authorization', `Bearer ${token}`);
	return ctx;
}

const MFA_ACTIONS: AuthActionInput[] = [
	{ action: 'setUpTotp' },
	{ action: 'verifyTotpSetup', code: '123456' },
	{ action: 'getMfaPreference' },
	{ action: 'updateMfaPreference', totp: 'ENABLED' },
];

describe('AWS createApi() — MFA action failures are AuthStates, never a raw throw', () => {
	test('a bearer-token caller (no cookie session): each action answers an error state', async () => {
		const h = makeBearerTotpAuth();
		const token = h.idp.sign(accessClaims('alice'));
		for (const input of MFA_ACTIONS) {
			const ctx = withBearer(new Browser().context(), token);
			const s = await apiFor(h.auth, ctx).setAuthState(input);
			assert.strictEqual(s.state, 'signedOut', `${input.action}: ${JSON.stringify(s)}`);
			assert.ok(s.errorName, `${input.action} names its error`);
		}
	});

	test('a federated (hosted-UI) user: each action answers an error state', async () => {
		const h = makeBearerTotpAuth(true);
		const token = h.idp.sign(accessClaims('Google_1234567890', { client_id: HOSTED_UI_CLIENT_ID }));
		for (const input of MFA_ACTIONS) {
			const ctx = withBearer(new Browser().context(), token);
			const s = await apiFor(h.auth, ctx).setAuthState(input);
			assert.strictEqual(s.state, 'signedOut', `${input.action}: ${JSON.stringify(s)}`);
			assert.ok(s.errorName, `${input.action} names its error`);
		}
	});

	test('GetUser failing after verifyTotpSetup / updateMfaPreference, or on getMfaPreference: an error state', async () => {
		const h = makeAwsAuth(TOTP);
		const b = new Browser();
		await signInAs(h, b, 'alice');
		h.on('VerifySoftwareTokenCommand', () => ({ Status: 'SUCCESS' }));
		h.on('SetUserMFAPreferenceCommand', () => ({}));
		let getUserCalls = 0;
		h.on('GetUserCommand', () => {
			// verifyTotpSetup's own GetUser succeeds; the settings' GetUser fails.
			if (++getUserCalls === 1) return { Username: 'alice' };
			throw cognitoError('TooManyRequestsException', 'Rate exceeded');
		});
		const inputs: AuthActionInput[] = [
			{ action: 'verifyTotpSetup', code: '123456' },
			{ action: 'updateMfaPreference', totp: 'DISABLED' },
			{ action: 'getMfaPreference' },
		];
		for (const input of inputs) {
			const s = await b.request((ctx) => apiFor(h.auth, ctx).setAuthState(input));
			assert.ok(s.error, `${input.action}: ${JSON.stringify(s)}`);
			assert.notStrictEqual(s.state, 'signedIn', input.action);
		}
		assert.ok(getUserCalls >= 4, 'each settings state read GetUser');
	});
});

describe('AWS createApi() — replacing or turning off a factor needs a recent sign-in', () => {
	/** Signed in an hour ago: past the default 15-minute `session.freshAgeSeconds`. */
	const staleTokens = (h: ReturnType<typeof makeAwsAuth>) =>
		h.idp.authResult('alice', { claims: { auth_time: Math.floor(Date.now() / 1000) - 3600 } });

	test('stale session: replacing an enrolled authenticator answers ReauthenticationRequired, no AssociateSoftwareToken', async () => {
		const h = makeAwsAuth(TOTP);
		const b = new Browser();
		await signInAs(h, b, 'alice', staleTokens(h));
		h.on('GetUserCommand', () => ({ Username: 'alice', UserMFASettingList: ['SOFTWARE_TOKEN_MFA'] }));
		const s = await b.request((ctx) => apiFor(h.auth, ctx).setAuthState({ action: 'setUpTotp' }));
		assert.strictEqual(s.errorName, AuthErrors.ReauthenticationRequired, JSON.stringify(s));
		assert.deepStrictEqual(h.sentNames(), ['GetUserCommand']);
	});

	test('stale session: first-time setup still works', async () => {
		const h = makeAwsAuth(TOTP);
		const b = new Browser();
		await signInAs(h, b, 'alice', staleTokens(h));
		h.on('GetUserCommand', () => ({ Username: 'alice', UserMFASettingList: [] }));
		h.on('AssociateSoftwareTokenCommand', () => ({ SecretCode: 'JBSWY3DPEHPK3PXP' }));
		const s = await b.request((ctx) => apiFor(h.auth, ctx).setAuthState({ action: 'setUpTotp' }));
		assert.ok(s.actions.some((a) => a.name === 'verifyTotpSetup'), JSON.stringify(s));
	});

	test('stale session: DISABLED answers ReauthenticationRequired with no SetUserMFAPreference; ENABLED goes through', async () => {
		const h = makeAwsAuth(TOTP);
		const b = new Browser();
		await signInAs(h, b, 'alice', staleTokens(h));
		h.on('SetUserMFAPreferenceCommand', () => ({}));
		h.on('GetUserCommand', () => ({ Username: 'alice', UserMFASettingList: ['SOFTWARE_TOKEN_MFA'] }));
		const off = await b.request((ctx) =>
			apiFor(h.auth, ctx).setAuthState({ action: 'updateMfaPreference', totp: 'DISABLED' }),
		);
		assert.strictEqual(off.errorName, AuthErrors.ReauthenticationRequired, JSON.stringify(off));
		assert.deepStrictEqual(h.sent, []);
		const on = await b.request((ctx) =>
			apiFor(h.auth, ctx).setAuthState({ action: 'updateMfaPreference', totp: 'PREFERRED' }),
		);
		assert.strictEqual(on.state, 'signedIn', JSON.stringify(on));
		assert.deepStrictEqual(h.sentNames(), ['SetUserMFAPreferenceCommand', 'GetUserCommand']);
	});

	test('fresh session: replacing and turning off both go through', async () => {
		const h = makeAwsAuth(TOTP);
		const b = new Browser();
		await signInAs(h, b, 'alice');
		h.on('GetUserCommand', () => ({ Username: 'alice', UserMFASettingList: ['SOFTWARE_TOKEN_MFA'] }));
		h.on('AssociateSoftwareTokenCommand', () => ({ SecretCode: 'JBSWY3DPEHPK3PXP' }));
		h.on('SetUserMFAPreferenceCommand', () => ({}));
		const replaced = await b.request((ctx) => apiFor(h.auth, ctx).setAuthState({ action: 'setUpTotp' }));
		assert.ok(replaced.actions.some((a) => a.name === 'verifyTotpSetup'), JSON.stringify(replaced));
		const off = await b.request((ctx) =>
			apiFor(h.auth, ctx).setAuthState({ action: 'updateMfaPreference', totp: 'DISABLED' }),
		);
		assert.strictEqual(off.state, 'signedIn', JSON.stringify(off));
	});
});
