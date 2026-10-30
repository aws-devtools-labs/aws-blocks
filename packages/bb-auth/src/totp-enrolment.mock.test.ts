// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Authenticator-app (TOTP) enrolment through `createApi()`'s `setAuthState`
 * (`setUpTotp`, `verifyTotpSetup`, `getMfaPreference`, `updateMfaPreference`)
 * on the local user pool, and the mock's opt-in RFC 6238 code check
 * (`totpVerification: 'rfc6238'`).
 */

import assert from 'node:assert';
import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, type TestContext, test } from 'node:test';
import type { AuthAction, AuthActionInput, AuthState, AuthStateApi } from '@aws-blocks/auth-common';
import type { BlocksContext, ScopeParent } from '@aws-blocks/core';
import { Scope } from '@aws-blocks/core';
import { totpCode, verifyTotpCode } from './engines/totp.js';
import { AuthErrors } from './errors.js';
import { Auth } from './index.mock.js';
import { Browser } from './test-helpers.js';
import type { AuthMockOptions, CodeDeliveryPurpose } from './types.js';

beforeEach(() => rmSync('.bb-data', { recursive: true, force: true }));
afterEach(() => rmSync('.bb-data', { recursive: true, force: true }));

const PASSWORD = 'Passw0rd!';
let counter = 0;
const root = () => ({ id: `totp${process.pid}x${++counter}` });

/** Call the RPC namespace the way the RPC layer does. */
function bind(api: AuthStateApi, ctx: BlocksContext): AuthStateApi {
	const target: unknown = api;
	assert.ok(typeof target === 'function');
	const handler: unknown = Reflect.apply(target, undefined, [ctx]);
	assert.ok(typeof handler === 'object' && handler !== null);
	const getAuthState: unknown = Reflect.get(handler, 'getAuthState');
	const setAuthState: unknown = Reflect.get(handler, 'setAuthState');
	assert.ok(typeof getAuthState === 'function' && typeof setAuthState === 'function');
	return {
		getAuthState: () => Reflect.apply(getAuthState, handler, []),
		setAuthState: (input: AuthActionInput) => Reflect.apply(setAuthState, handler, [input]),
	};
}

/** A signed-up, confirmed `username` on a fresh block, plus a browser and the state API. */
async function setup(options: AuthMockOptions, username = 'tess', parent: ScopeParent = root()) {
	const sent: { code: string; purpose: CodeDeliveryPurpose }[] = [];
	const auth = new Auth(parent, 'auth', {
		...options,
		codeDelivery: async (_u, code, purpose) => {
			sent.push({ code, purpose });
		},
	});
	const api = auth.createApi();
	const b = new Browser();
	const call = (input: AuthActionInput) => b.request((ctx) => bind(api, ctx).setAuthState(input));
	await call({ action: 'signUp', username, password: PASSWORD, email: `${username}@example.com` });
	const code = [...sent].reverse().find((s) => s.purpose === 'signUp')?.code ?? '';
	await call({ action: 'confirmSignUp', username, code });
	return { auth, api, b, call, username };
}

function actionNamed(state: AuthState, name: string): AuthAction {
	const action = state.actions.find((a) => a.name === name);
	assert.ok(action, `${name} in ${JSON.stringify(state.actions.map((a) => a.name))}`);
	return action;
}

function fieldValue(action: AuthAction, field: string): string {
	const value = action.fields.find((f) => f.name === field)?.defaultValue;
	assert.ok(value !== undefined, `${action.name} carries ${field}`);
	return value;
}

/** The `updateMfaPreference` actions of a state, as `factor=SETTING` strings. */
function preferenceActions(state: AuthState): string[] {
	return state.actions
		.filter((a) => a.name === 'updateMfaPreference')
		.flatMap((a) => a.fields.map((f) => `${f.name}=${f.defaultValue}`));
}

const TOTP_ONLY = { mfa: { mode: 'optional', types: ['TOTP'] } } as const;

describe('RFC 6238 verifier (mock)', () => {
	const seed = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'; // ASCII "12345678901234567890"
	test('computes the RFC 6238 Appendix B SHA-1 vectors (last six digits)', () => {
		for (const [seconds, eight] of [
			[59, '94287082'],
			[1111111109, '07081804'],
			[1111111111, '14050471'],
			[1234567890, '89005924'],
			[2000000000, '69279037'],
			[20000000000, '65353130'],
		] as const) {
			assert.strictEqual(totpCode(seed, seconds * 1000), eight.slice(-6), `T=${seconds}`);
		}
	});

	test('accepts the current step and one step either side, nothing further', () => {
		const now = 1_234_567_890_000;
		for (const d of [-1, 0, 1]) assert.ok(verifyTotpCode(seed, totpCode(seed, now + d * 30_000) ?? '', now), `${d}`);
		for (const d of [-2, 2]) assert.ok(!verifyTotpCode(seed, totpCode(seed, now + d * 30_000) ?? '', now), `${d}`);
		assert.ok(!verifyTotpCode(seed, '12345', now));
		assert.ok(!verifyTotpCode('not base32!', '123456', now));
	});

	test('the first 30 s after the epoch: no step -1, no RangeError', () => {
		for (const now of [0, 1, 29_999]) {
			assert.ok(verifyTotpCode(seed, totpCode(seed, 0) ?? '', now), `step 0 at ${now}`);
			assert.ok(verifyTotpCode(seed, totpCode(seed, 30_000) ?? '', now), `step 1 at ${now}`);
			assert.doesNotThrow(() => verifyTotpCode(seed, '000000', now));
		}
	});
});

describe("mock totpVerification: 'rfc6238' — codes are checked against the shared secret", () => {
	test('verifyTotpSetup and the sign-in challenge refuse a wrong code and accept the real one', async () => {
		const { auth, b, username } = await setup({ ...TOTP_ONLY, totpVerification: 'rfc6238' });
		await b.request((ctx) => auth.signIn(username, PASSWORD, ctx));
		const { sharedSecret } = await b.request((ctx) => auth.setUpTotp(ctx));
		const right = totpCode(sharedSecret, Date.now()) ?? '';
		const wrong = right === '000000' ? '111111' : '000000';
		await assert.rejects(
			b.request((ctx) => auth.verifyTotpSetup(ctx, wrong)),
			(e: Error & { retriable?: boolean }) =>
				e.name === AuthErrors.EnableSoftwareTokenMFA && e.retriable === true,
		);
		await b.request((ctx) => auth.verifyTotpSetup(ctx, right));

		const b2 = new Browser();
		const r = await b2.request((ctx) => auth.signIn(username, PASSWORD, ctx));
		assert.ok(r.status === 'continueSignIn' && r.nextStep.name === 'CONFIRM_SIGN_IN_WITH_TOTP_CODE');
		const session = r.nextStep.session;
		await assert.rejects(
			b2.request((ctx) => auth.confirmSignIn(session, wrong, ctx)),
			(e: Error) => e.name === AuthErrors.CodeMismatch,
		);
		const done = await b2.request((ctx) => auth.confirmSignIn(session, totpCode(sharedSecret, Date.now()) ?? '', ctx));
		assert.strictEqual(done.status, 'signedIn');
	});

	test('the mid-sign-in setup of required MFA checks the code against the offered secret', async () => {
		const { auth, username } = await setup({
			mfa: { mode: 'required', types: ['TOTP'] },
			totpVerification: 'rfc6238',
		});
		const b = new Browser();
		const r = await b.request((ctx) => auth.signIn(username, PASSWORD, ctx));
		assert.ok(r.status === 'continueSignIn' && r.nextStep.name === 'CONTINUE_SIGN_IN_WITH_TOTP_SETUP');
		const { session, sharedSecret } = r.nextStep;
		const right = totpCode(sharedSecret, Date.now()) ?? '';
		await assert.rejects(
			b.request((ctx) => auth.confirmSignIn(session, right === '000000' ? '111111' : '000000', ctx)),
			(e: Error) => e.name === AuthErrors.EnableSoftwareTokenMFA,
		);
		assert.strictEqual((await b.request((ctx) => auth.confirmSignIn(session, right, ctx))).status, 'signedIn');
	});

	test("the default ('any') still accepts any six digits, as before", async () => {
		const { auth, b, username } = await setup(TOTP_ONLY);
		await b.request((ctx) => auth.signIn(username, PASSWORD, ctx));
		await b.request((ctx) => auth.setUpTotp(ctx));
		await b.request((ctx) => auth.verifyTotpSetup(ctx, '000000'));
		const r = await new Browser().request((ctx) => auth.signIn(username, PASSWORD, ctx));
		assert.ok(r.status === 'continueSignIn' && r.nextStep.name === 'CONFIRM_SIGN_IN_WITH_TOTP_CODE');
	});

	test('an unknown totpVerification value is refused at construction', () => {
		assert.throws(
			() => new Auth(root(), 'auth', { ...TOTP_ONLY, totpVerification: JSON.parse('"strict"') }),
			/totpVerification/,
		);
	});
});

describe('createApi() — TOTP enrolment actions', () => {
	test('signed out: every MFA action answers the not-authenticated error state', async () => {
		const auth = new Auth(root(), 'auth', TOTP_ONLY);
		const api = auth.createApi();
		const b = new Browser();
		const inputs: AuthActionInput[] = [
			{ action: 'setUpTotp' },
			{ action: 'verifyTotpSetup', code: '123456' },
			{ action: 'getMfaPreference' },
			{ action: 'updateMfaPreference', totp: 'PREFERRED' },
		];
		for (const input of inputs) {
			const s = await b.request((ctx) => bind(api, ctx).setAuthState(input));
			assert.strictEqual(s.state, 'signedOut', input.action);
			assert.strictEqual(s.errorName, AuthErrors.NotAuthenticated, input.action);
			assert.ok(
				s.actions.some((a) => a.name === 'signIn'),
				'the signed-out form, so the user can sign in',
			);
		}
	});

	test('setUpTotp → verifyTotpSetup enrols the authenticator; the next sign-in is challenged', async () => {
		const { call, username } = await setup({
			mfa: { mode: 'optional', types: ['TOTP'], totpIssuer: 'Acme Notes' },
			totpVerification: 'rfc6238',
		});
		await call({ action: 'signIn', username, password: PASSWORD });

		const settings = await call({ action: 'getMfaPreference' });
		assert.strictEqual(settings.state, 'signedIn');
		assert.strictEqual(settings.user?.username, username);
		assert.strictEqual(actionNamed(settings, 'setUpTotp').label, 'Set up authenticator app');
		assert.deepStrictEqual(preferenceActions(settings), [], 'nothing enrolled yet');

		const started = await call({ action: 'setUpTotp' });
		assert.strictEqual(started.state, 'signedIn');
		const verify = actionNamed(started, 'verifyTotpSetup');
		const sharedSecret = fieldValue(verify, 'sharedSecret');
		assert.match(sharedSecret, /^[A-Z2-7]{32}$/);
		assert.strictEqual(
			fieldValue(verify, 'otpauthUri'),
			`otpauth://totp/Acme%20Notes:${username}?secret=${sharedSecret}&issuer=Acme%20Notes&algorithm=SHA1&digits=6&period=30`,
		);
		assert.deepStrictEqual(
			verify.fields.map((f) => [f.name, f.type]),
			[
				['sharedSecret', 'hidden'],
				['otpauthUri', 'hidden'],
				['code', 'text'],
			],
		);
		// "Cancel" goes back to the settings.
		assert.ok(started.actions.some((a) => a.name === 'getMfaPreference'));

		const right = totpCode(sharedSecret, Date.now()) ?? '';
		const bad = await call({ action: 'verifyTotpSetup', code: right === '000000' ? '111111' : '000000' });
		assert.strictEqual(bad.retriable, true, 'a wrong code keeps the setup form');
		assert.strictEqual(bad.errorName, AuthErrors.EnableSoftwareTokenMFA);

		const done = await call({ action: 'verifyTotpSetup', code: right });
		assert.strictEqual(done.state, 'signedIn');
		assert.strictEqual(done.error, undefined);
		assert.strictEqual(actionNamed(done, 'setUpTotp').label, 'Replace authenticator app');
		// Enrolled and preferred (the first factor): it can only be turned off.
		assert.deepStrictEqual(preferenceActions(done), ['totp=DISABLED']);
		assert.ok(done.actions.some((a) => a.name === 'signOut'));

		await call({ action: 'signOut' });
		const challenged = await call({ action: 'signIn', username, password: PASSWORD });
		assert.strictEqual(challenged.state, 'confirmingSignIn');
		const confirm = actionNamed(challenged, 'confirmSignIn');
		assert.strictEqual(fieldValue(confirm, 'challenge'), 'code');
		const signedIn = await call({
			action: 'confirmSignIn',
			challenge: 'code',
			session: fieldValue(confirm, 'session'),
			code: totpCode(sharedSecret, Date.now()) ?? '',
		});
		assert.strictEqual(signedIn.state, 'signedIn');
	});

	test('updateMfaPreference turns TOTP off and back on, and returns the updated settings', async () => {
		const { auth, b, call, username } = await setup(TOTP_ONLY);
		await call({ action: 'signIn', username, password: PASSWORD });
		await call({ action: 'setUpTotp' });
		await call({ action: 'verifyTotpSetup', code: '123456' });

		const off = await call({ action: 'updateMfaPreference', totp: 'DISABLED' });
		assert.strictEqual(off.state, 'signedIn');
		assert.deepStrictEqual(preferenceActions(off), []);
		assert.deepStrictEqual(await b.request((ctx) => auth.getMfaPreference(ctx)), {
			enabled: [],
			preferred: 'NOMFA',
		});
		assert.strictEqual((await new Browser().request((ctx) => auth.signIn(username, PASSWORD, ctx))).status, 'signedIn');

		const on = await call({ action: 'updateMfaPreference', totp: 'ENABLED' });
		assert.deepStrictEqual(preferenceActions(on), ['totp=PREFERRED', 'totp=DISABLED']);
		const preferred = await call({ action: 'updateMfaPreference', totp: 'PREFERRED' });
		assert.deepStrictEqual(preferenceActions(preferred), ['totp=DISABLED']);
	});

	test('updateMfaPreference: a setting outside the vocabulary, or no factor at all, is a 400', async () => {
		const { call, username } = await setup(TOTP_ONLY);
		await call({ action: 'signIn', username, password: PASSWORD });
		const untyped: unknown = { action: 'updateMfaPreference', totp: 'ON' };
		const bogus = await call(untyped as AuthActionInput);
		assert.strictEqual(bogus.errorName, AuthErrors.InvalidParameter);
		const empty = await call({ action: 'updateMfaPreference' });
		assert.strictEqual(empty.errorName, AuthErrors.InvalidParameter);
	});

	test('the default otpauth issuer is the app (root scope) id; the account is the signed-in display name', async () => {
		const app = new Scope(`acme-app-${++counter}`);
		const { call, username } = await setup(TOTP_ONLY, 'tess', new Scope('nested', { parent: app }));
		await call({ action: 'signIn', username, password: PASSWORD });
		const started = await call({ action: 'setUpTotp' });
		const uri = fieldValue(actionNamed(started, 'verifyTotpSetup'), 'otpauthUri');
		assert.ok(uri.startsWith(`otpauth://totp/${app.id}:${username}?secret=`), uri);
		assert.ok(uri.includes(`&issuer=${app.id}&`), uri);
	});

	test('MFA off: the four actions answer MfaNotEnabledException (untyped caller), with no session check first', async () => {
		const auth = new Auth(root(), 'auth');
		const api = auth.createApi();
		const b = new Browser();
		for (const input of [
			{ action: 'setUpTotp' },
			{ action: 'verifyTotpSetup', code: '123456' },
			{ action: 'getMfaPreference' },
			{ action: 'updateMfaPreference', totp: 'ENABLED' },
		] satisfies AuthActionInput[]) {
			const s = await b.request((ctx) => bind(api, ctx).setAuthState(input));
			assert.strictEqual(s.errorName, AuthErrors.MfaNotEnabled, input.action);
		}
	});

	test("TOTP not in mfa.types: the setup actions name the option; the preference actions don't offer TOTP", async () => {
		const { call, username } = await setup({ mfa: { mode: 'optional', types: ['SMS'] } });
		for (const input of [
			{ action: 'setUpTotp' },
			{ action: 'verifyTotpSetup', code: '123456' },
		] satisfies AuthActionInput[]) {
			const s = await call(input);
			assert.strictEqual(s.errorName, AuthErrors.InvalidParameter, input.action);
			assert.match(s.error ?? '', /mfa\.types/, input.action);
		}
		await call({ action: 'signIn', username, password: PASSWORD });
		const settings = await call({ action: 'getMfaPreference' });
		assert.strictEqual(settings.state, 'signedIn');
		assert.ok(!settings.actions.some((a) => a.name === 'setUpTotp'), 'no authenticator setup without TOTP');
	});

	test('the signed-in state the Authenticator renders is unchanged (no MFA actions)', async () => {
		const { call, username } = await setup(TOTP_ONLY);
		const s = await call({ action: 'signIn', username, password: PASSWORD });
		assert.deepStrictEqual(
			s.actions.map((a) => a.name),
			['signOut'],
		);
	});
});

describe('createApi() — replacing or turning off a factor needs a recent sign-in (mock)', () => {
	/** Enrol TOTP for a fresh user, then let the session go stale (past the default 15 minutes). */
	async function enrolledThenStale(t: TestContext) {
		t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
		const ctx = await setup({ ...TOTP_ONLY, totpVerification: 'rfc6238' });
		await ctx.call({ action: 'signIn', username: ctx.username, password: PASSWORD });
		const started = await ctx.call({ action: 'setUpTotp' });
		const sharedSecret = fieldValue(actionNamed(started, 'verifyTotpSetup'), 'sharedSecret');
		await ctx.call({ action: 'verifyTotpSetup', code: totpCode(sharedSecret, Date.now()) ?? '' });
		t.mock.timers.tick(16 * 60 * 1000);
		return { ...ctx, sharedSecret };
	}

	test('stale: "Replace authenticator app" and turning TOTP off answer ReauthenticationRequired; turning it on does not', async (t) => {
		const { auth, b, call } = await enrolledThenStale(t);
		const replace = await call({ action: 'setUpTotp' });
		assert.strictEqual(replace.errorName, AuthErrors.ReauthenticationRequired, JSON.stringify(replace));
		assert.strictEqual(replace.state, 'signedOut');
		assert.ok(replace.actions.some((a) => a.name === 'signIn'), 'the sign-in form, to re-authenticate');
		const off = await call({ action: 'updateMfaPreference', totp: 'DISABLED' });
		assert.strictEqual(off.errorName, AuthErrors.ReauthenticationRequired);
		assert.deepStrictEqual((await b.request((ctx) => auth.getMfaPreference(ctx))).enabled, ['TOTP'], 'unchanged');
		const on = await call({ action: 'updateMfaPreference', totp: 'PREFERRED' });
		assert.strictEqual(on.state, 'signedIn', JSON.stringify(on));
	});

	test('stale: first-time setup is not gated', async (t) => {
		t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
		const { call, username } = await setup(TOTP_ONLY);
		await call({ action: 'signIn', username, password: PASSWORD });
		t.mock.timers.tick(16 * 60 * 1000);
		const started = await call({ action: 'setUpTotp' });
		assert.ok(started.actions.some((a) => a.name === 'verifyTotpSetup'), JSON.stringify(started));
	});

	test('fresh again after signing in: replacing and turning off go through', async (t) => {
		const { call, username, sharedSecret } = await enrolledThenStale(t);
		await call({ action: 'signOut' });
		const challenged = await call({ action: 'signIn', username, password: PASSWORD });
		const confirm = actionNamed(challenged, 'confirmSignIn');
		await call({
			action: 'confirmSignIn',
			challenge: 'code',
			session: fieldValue(confirm, 'session'),
			code: totpCode(sharedSecret, Date.now()) ?? '',
		});
		const replace = await call({ action: 'setUpTotp' });
		assert.ok(replace.actions.some((a) => a.name === 'verifyTotpSetup'), JSON.stringify(replace));
		const off = await call({ action: 'updateMfaPreference', totp: 'DISABLED' });
		assert.strictEqual(off.state, 'signedIn', JSON.stringify(off));
	});
});

describe('mock: a replacement secret stays pending until verified (as Cognito)', () => {
	test('"Replace… → Cancel" keeps the working authenticator; verifying the new one retires the old', async () => {
		const { auth, call, username } = await setup({ ...TOTP_ONLY, totpVerification: 'rfc6238' });
		await call({ action: 'signIn', username, password: PASSWORD });
		const first = await call({ action: 'setUpTotp' });
		const oldSecret = fieldValue(actionNamed(first, 'verifyTotpSetup'), 'sharedSecret');
		await call({ action: 'verifyTotpSetup', code: totpCode(oldSecret, Date.now()) ?? '' });

		// Replace…, then Cancel: the new secret was never verified.
		const second = await call({ action: 'setUpTotp' });
		const newSecret = fieldValue(actionNamed(second, 'verifyTotpSetup'), 'sharedSecret');
		assert.notStrictEqual(newSecret, oldSecret);
		const cancelled = await call({ action: 'getMfaPreference' });
		assert.strictEqual(actionNamed(cancelled, 'setUpTotp').label, 'Replace authenticator app', 'still enrolled');

		const signInWith = async (secret: string) => {
			const b = new Browser();
			const r = await b.request((ctx) => auth.signIn(username, PASSWORD, ctx));
			assert.ok(r.status === 'continueSignIn' && r.nextStep.name === 'CONFIRM_SIGN_IN_WITH_TOTP_CODE');
			const session = r.nextStep.session;
			try {
				return (await b.request((ctx) => auth.confirmSignIn(session, totpCode(secret, Date.now()) ?? '', ctx)))
					.status;
			} catch (e) {
				return (e as Error).name;
			}
		};
		assert.strictEqual(await signInWith(oldSecret), 'signedIn', 'the old authenticator still works');
		assert.strictEqual(await signInWith(newSecret), AuthErrors.CodeMismatch, 'the pending one does not');

		// Verifying the new secret retires the old one.
		await call({ action: 'setUpTotp' }).then(async (third) => {
			const pending = fieldValue(actionNamed(third, 'verifyTotpSetup'), 'sharedSecret');
			await call({ action: 'verifyTotpSetup', code: totpCode(pending, Date.now()) ?? '' });
			assert.strictEqual(await signInWith(pending), 'signedIn');
			assert.strictEqual(await signInWith(oldSecret), AuthErrors.CodeMismatch);
		});
	});
});
