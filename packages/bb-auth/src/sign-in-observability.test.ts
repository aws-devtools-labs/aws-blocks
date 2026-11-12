// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Observing sign-in and password events without changing them:
 *
 * - the opt-in `metrics` option: `SignInSuccess` / `SignInFailure` /
 *   `SignInLocked` counts with an `AuthBlock` dimension, nothing for a
 *   server-side fault, and an emitter that throws never changes a result;
 * - the audit hooks `onSignInFailed`, `onPasswordResetRequested`,
 *   `onPasswordReset` and `onPasswordChanged`: awaited, a throw is logged and
 *   never changes the result, and no payload carries a password or a code.
 *   `onSignInFailed` reports an unknown user and a wrong password identically.
 */

import assert from 'node:assert';
import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, test } from 'node:test';
import type { AuthActionInput, AuthStateApi } from '@aws-blocks/auth-common';
import type { BlocksContext } from '@aws-blocks/core';
import { ApiError } from '@aws-blocks/core';
import { isSignInLockout, signInFailureReason } from './auth-base.js';
import { AuthErrors } from './errors.js';
import { Auth } from './index.mock.js';
import { Browser, captureLogger } from './test-helpers.js';
import { Browser as AwsBrowser, cognitoError, makeAwsAuth, wireView } from './test-support/aws-harness.js';
import type { AuthenticatedUser, CodeDeliveryPurpose, PasswordResetEvent, SignInFailure } from './types.js';

beforeEach(() => rmSync('.bb-data', { recursive: true, force: true }));
afterEach(() => rmSync('.bb-data', { recursive: true, force: true }));

const PASSWORD = 'Passw0rd!';
const NEW_PASSWORD = 'NewPassw0rd!';
let counter = 0;
const root = () => ({ id: `so${process.pid}x${++counter}` });

function codeSink() {
	const sent: { code: string; purpose: CodeDeliveryPurpose }[] = [];
	return {
		deliver: async (_username: string, code: string, purpose: CodeDeliveryPurpose) => {
			sent.push({ code, purpose });
		},
		last(purpose: CodeDeliveryPurpose): string {
			const match = [...sent].reverse().find((s) => s.purpose === purpose);
			assert.ok(match, `a ${purpose} code was delivered`);
			return match.code;
		},
	};
}

/** A stand-in `Metrics`: records every `emit`. */
function metricsSpy(options: { throws?: boolean } = {}) {
	const emitted: { name: string; value: number; options: unknown }[] = [];
	return {
		emitted,
		names: () => emitted.map((m) => m.name),
		emit(name: string, value: number, emitOptions?: unknown): void {
			if (options.throws) throw new Error('emitter down');
			emitted.push({ name, value, options: emitOptions });
		},
	};
}

async function register(
	auth: {
		signUp(username: string, password: string, options: { attributes: { email: string } }): Promise<unknown>;
		confirmSignUp(username: string, code: string): Promise<unknown>;
	},
	sink: ReturnType<typeof codeSink>,
	username: string,
): Promise<void> {
	await auth.signUp(username, PASSWORD, { attributes: { email: `${username}@example.com` } });
	await auth.confirmSignUp(username, sink.last('signUp'));
}

async function rejection(p: Promise<unknown>): Promise<ApiError> {
	const e = await p.then(
		() => assert.fail('expected a rejection'),
		(err: unknown) => err,
	);
	assert.ok(e instanceof ApiError, `an ApiError, got ${String(e)}`);
	return e;
}

/** Call the RPC namespace the way the RPC layer does. */
function bind(api: AuthStateApi, ctx: BlocksContext): AuthStateApi {
	const target: unknown = api;
	assert.ok(typeof target === 'function');
	const handler: unknown = Reflect.apply(target, undefined, [ctx]);
	assert.ok(typeof handler === 'object' && handler !== null);
	const setAuthState: unknown = Reflect.get(handler, 'setAuthState');
	const getAuthState: unknown = Reflect.get(handler, 'getAuthState');
	assert.ok(typeof setAuthState === 'function' && typeof getAuthState === 'function');
	return {
		getAuthState: () => Reflect.apply(getAuthState, handler, []),
		setAuthState: (input: AuthActionInput) => Reflect.apply(setAuthState, handler, [input]),
	};
}

describe('sign-in failure classification', () => {
	test('the reason comes from the client-facing error name only', () => {
		assert.strictEqual(signInFailureReason(AuthErrors.NotAuthorized), 'invalidCredentials');
		assert.strictEqual(signInFailureReason(AuthErrors.CodeMismatch), 'invalidCode');
		assert.strictEqual(signInFailureReason(AuthErrors.ExpiredCode), 'invalidCode');
		assert.strictEqual(signInFailureReason(AuthErrors.UserNotConfirmed), 'userNotConfirmed');
		assert.strictEqual(signInFailureReason(AuthErrors.PasswordResetRequired), 'passwordResetRequired');
		assert.strictEqual(signInFailureReason(AuthErrors.TooManyFailedAttempts), 'throttled');
		assert.strictEqual(signInFailureReason(AuthErrors.InternalError), 'error');
	});

	test('a lockout is the throttling names or Cognito’s “Password attempts exceeded”', () => {
		assert.strictEqual(isSignInLockout(cognitoError('NotAuthorizedException', 'Password attempts exceeded')), true);
		assert.strictEqual(isSignInLockout(cognitoError('LimitExceededException', 'Attempt limit exceeded')), true);
		assert.strictEqual(
			isSignInLockout(cognitoError('NotAuthorizedException', 'Incorrect username or password.')),
			false,
		);
		assert.strictEqual(isSignInLockout('not an error'), false);
	});
});

describe('mock engine — sign-in metrics (opt-in)', () => {
	test('SignInSuccess / SignInFailure counts with the AuthBlock dimension; unknown user and wrong password alike', async () => {
		const sink = codeSink();
		const metrics = metricsSpy();
		const auth = new Auth(root(), 'auth', { metrics, codeDelivery: sink.deliver });
		await register(auth, sink, 'ann');

		await new Browser().request((ctx) => auth.signIn('ann', PASSWORD, ctx));
		await rejection(new Browser().request((ctx) => auth.signIn('ann', 'Wrong-Passw0rd', ctx)));
		await rejection(new Browser().request((ctx) => auth.signIn('nobody', PASSWORD, ctx)));

		assert.deepStrictEqual(metrics.names(), ['SignInSuccess', 'SignInFailure', 'SignInFailure']);
		for (const m of metrics.emitted) {
			assert.strictEqual(m.value, 1);
			assert.deepStrictEqual(m.options, { unit: 'Count', dimensions: { AuthBlock: auth.fullId } });
		}
	});

	test('a validateUser rejection counts as SignInFailure; a challenge step emits nothing until it completes', async () => {
		const sink = codeSink();
		const metrics = metricsSpy();
		const auth = new Auth(root(), 'auth', {
			metrics,
			users: { authFlow: 'USER_AUTH', preferredChallenge: 'EMAIL_OTP' },
			codeDelivery: sink.deliver,
			validateUser: async ({ phase, username }) => {
				if (phase === 'signIn' && username === 'blocked') throw new ApiError('No', 403, { name: 'Blocked' });
			},
		});
		await register(auth, sink, 'bea');
		await register(auth, sink, 'blocked');
		const b = new Browser();
		const r = await b.request((ctx) => auth.signIn('bea', '', ctx));
		assert.ok(r.status === 'continueSignIn');
		assert.deepStrictEqual(metrics.names(), []);
		const session = 'session' in r.nextStep ? r.nextStep.session : '';
		await b.request((ctx) => auth.confirmSignIn(session, sink.last('mfa'), ctx));
		assert.deepStrictEqual(metrics.names(), ['SignInSuccess']);

		const c = new Browser();
		const blocked = await c.request((ctx) => auth.signIn('blocked', '', ctx));
		assert.ok(blocked.status === 'continueSignIn');
		const blockedSession = 'session' in blocked.nextStep ? blocked.nextStep.session : '';
		await rejection(c.request((ctx) => auth.confirmSignIn(blockedSession, sink.last('mfa'), ctx)));
		assert.deepStrictEqual(metrics.names(), ['SignInSuccess', 'SignInFailure']);
	});

	test('an emitter that throws is logged and never changes the sign-in result', async () => {
		const sink = codeSink();
		const { logger, entries } = captureLogger();
		const auth = new Auth(root(), 'auth', {
			metrics: metricsSpy({ throws: true }),
			logger,
			codeDelivery: sink.deliver,
		});
		await register(auth, sink, 'cat');
		const b = new Browser();
		assert.strictEqual((await b.request((ctx) => auth.signIn('cat', PASSWORD, ctx))).status, 'signedIn');
		assert.strictEqual(await b.request((ctx) => auth.checkAuth(ctx)), true);
		const wrong = await rejection(new Browser().request((ctx) => auth.signIn('cat', 'nope', ctx)));
		assert.strictEqual(wrong.name, AuthErrors.NotAuthorized);
		assert.ok(entries.some((l) => l.level === 'error' && /sign-in metric/.test(l.message)));
	});
});

describe('AWS engine — sign-in metrics', () => {
	test('Cognito’s lockout is SignInLocked; the client still sees a plain wrong password', async () => {
		const metrics = metricsSpy();
		const failures: SignInFailure[] = [];
		const h = makeAwsAuth({ metrics, onSignInFailed: async (f) => void failures.push(f) });
		h.on('InitiateAuthCommand', () => {
			throw cognitoError('NotAuthorizedException', 'Password attempts exceeded');
		});
		const e = await new AwsBrowser()
			.request((ctx) => h.auth.signIn('alice', 'x', ctx))
			.then(
				() => assert.fail('expected a rejection'),
				(err: unknown) => err,
			);
		assert.strictEqual(wireView(e).name, AuthErrors.NotAuthorized);
		assert.deepStrictEqual(metrics.names(), ['SignInLocked']);
		assert.deepStrictEqual(failures, [
			{ step: 'signIn', username: 'alice', reason: 'invalidCredentials', errorName: AuthErrors.NotAuthorized },
		]);
	});

	test('a server-side fault emits no metric; a success emits SignInSuccess', async () => {
		const metrics = metricsSpy();
		const h = makeAwsAuth({ metrics, logger: captureLogger().logger });
		h.on('InitiateAuthCommand', () => {
			throw cognitoError('InternalErrorException', 'boom', 500);
		});
		await new AwsBrowser().request((ctx) => h.auth.signIn('alice', 'x', ctx)).catch(() => undefined);
		assert.deepStrictEqual(metrics.names(), []);
		h.on('InitiateAuthCommand', () => ({ AuthenticationResult: h.idp.authResult('alice') }));
		await new AwsBrowser().request((ctx) => h.auth.signIn('alice', 'Password!1', ctx));
		assert.deepStrictEqual(metrics.names(), ['SignInSuccess']);
	});
});

describe('mock engine — onSignInFailed', () => {
	test('an unknown user and a wrong password are reported identically, with no password', async () => {
		const sink = codeSink();
		const failures: SignInFailure[] = [];
		const auth = new Auth(root(), 'auth', {
			codeDelivery: sink.deliver,
			onSignInFailed: async (f) => void failures.push(f),
		});
		await register(auth, sink, 'dee');
		await rejection(new Browser().request((ctx) => auth.signIn('dee', 'Wrong-Passw0rd', ctx)));
		await rejection(new Browser().request((ctx) => auth.signIn('nobody', 'Wrong-Passw0rd', ctx)));
		const expected = (username: string): SignInFailure => ({
			step: 'signIn',
			username,
			reason: 'invalidCredentials',
			errorName: AuthErrors.NotAuthorized,
		});
		assert.deepStrictEqual(failures, [expected('dee'), expected('nobody')]);
		assert.ok(!JSON.stringify(failures).includes('Wrong-Passw0rd'), 'no password in the payload');
	});

	test('a wrong challenge code is reported without a username, session or code', async () => {
		const sink = codeSink();
		const failures: SignInFailure[] = [];
		const auth = new Auth(root(), 'auth', {
			users: { authFlow: 'USER_AUTH', preferredChallenge: 'EMAIL_OTP' },
			codeDelivery: sink.deliver,
			onSignInFailed: async (f) => void failures.push(f),
		});
		await register(auth, sink, 'eve');
		const b = new Browser();
		const r = await b.request((ctx) => auth.signIn('eve', '', ctx));
		assert.ok(r.status === 'continueSignIn');
		const session = 'session' in r.nextStep ? r.nextStep.session : '';
		const code = sink.last('mfa');
		const wrongCode = code === '000000' ? '111111' : '000000';
		await rejection(b.request((ctx) => auth.confirmSignIn(session, wrongCode, ctx)));
		assert.deepStrictEqual(failures, [
			{ step: 'confirmSignIn', reason: 'invalidCode', errorName: AuthErrors.CodeMismatch },
		]);
		assert.ok(!JSON.stringify(failures).includes(wrongCode));
		assert.ok(!JSON.stringify(failures).includes(session));
	});

	test('a rejection by onSignIn is reason "rejected"; a hook that throws never changes the error', async () => {
		const sink = codeSink();
		const { logger, entries } = captureLogger();
		const failures: SignInFailure[] = [];
		const auth = new Auth(root(), 'auth', {
			logger,
			codeDelivery: sink.deliver,
			onSignIn: async () => {
				throw new ApiError('Not today', 403, { name: 'NotToday' });
			},
			onSignInFailed: async (f) => {
				failures.push(f);
				throw new Error('audit sink down');
			},
		});
		await register(auth, sink, 'fay');
		const e = await rejection(new Browser().request((ctx) => auth.signIn('fay', PASSWORD, ctx)));
		assert.strictEqual(e.name, 'NotToday');
		assert.deepStrictEqual(failures, [
			{ step: 'signIn', username: 'fay', reason: 'rejected', errorName: 'NotToday' },
		]);
		assert.ok(entries.some((l) => l.level === 'error' && /onSignInFailed threw/.test(l.message)));
	});

	test('AWS: a fault after the engine signed the user in: errorName is the name the client receives', async () => {
		const failures: SignInFailure[] = [];
		const h = makeAwsAuth({ logger: captureLogger().logger, onSignInFailed: async (f) => void failures.push(f) });
		h.on('InitiateAuthCommand', () => ({ AuthenticationResult: h.idp.authResult('alice') }));
		const sessions = Reflect.get(h.auth, 'sessions');
		sessions.create = async () => {
			throw new Error('store down');
		};
		const e = await new AwsBrowser()
			.request((ctx) => h.auth.signIn('alice', 'Password!1', ctx))
			.then(
				() => assert.fail('expected a rejection'),
				(err: unknown) => err,
			);
		assert.ok(e instanceof ApiError, 'the client receives the mapped error');
		assert.strictEqual(failures.length, 1);
		assert.strictEqual(failures[0].errorName, e.name);
	});

	test('runs for a failed setAuthState signIn too', async () => {
		const failures: SignInFailure[] = [];
		const auth = new Auth(root(), 'auth', { onSignInFailed: async (f) => void failures.push(f) });
		const api = auth.createApi();
		const state = await new Browser().request((ctx) =>
			bind(api, ctx).setAuthState({ action: 'signIn', username: 'ghost', password: 'whatever' }),
		);
		assert.strictEqual(state.errorName, AuthErrors.NotAuthorized);
		assert.deepStrictEqual(failures, [
			{ step: 'signIn', username: 'ghost', reason: 'invalidCredentials', errorName: AuthErrors.NotAuthorized },
		]);
	});
});

describe('mock engine — password audit hooks', () => {
	test('onPasswordResetRequested runs for a known and an unknown user alike, with the username only', async () => {
		const sink = codeSink();
		const requested: PasswordResetEvent[] = [];
		const auth = new Auth(root(), 'auth', {
			codeDelivery: sink.deliver,
			onPasswordResetRequested: async (r) => void requested.push(r),
		});
		await register(auth, sink, 'gus');
		const known = await auth.resetPassword('gus');
		const unknown = await auth.resetPassword('nobody');
		assert.deepStrictEqual(requested, [{ username: 'gus' }, { username: 'nobody' }]);
		assert.strictEqual(known.nextStep?.name, unknown.nextStep?.name);
	});

	test('onPasswordReset runs after a completed reset only; a throw is logged and the reset stands', async () => {
		const sink = codeSink();
		const { logger, entries } = captureLogger();
		const resets: PasswordResetEvent[] = [];
		const auth = new Auth(root(), 'auth', {
			logger,
			codeDelivery: sink.deliver,
			onPasswordReset: async (r) => {
				resets.push(r);
				throw new Error('audit sink down');
			},
		});
		await register(auth, sink, 'hap');
		await auth.resetPassword('hap');
		const code = sink.last('resetPassword');
		await rejection(auth.confirmResetPassword('hap', code === '000000' ? '111111' : '000000', NEW_PASSWORD));
		assert.deepStrictEqual(resets, [], 'not for a wrong code');
		await auth.confirmResetPassword('hap', code, NEW_PASSWORD);
		assert.deepStrictEqual(resets, [{ username: 'hap' }]);
		assert.ok(entries.some((l) => l.level === 'error' && /onPasswordReset threw/.test(l.message)));
		assert.strictEqual(
			(await new Browser().request((ctx) => auth.signIn('hap', NEW_PASSWORD, ctx))).status,
			'signedIn',
		);
	});

	test('onPasswordChanged runs with the signed-in user after updatePassword; a throw never fails it', async () => {
		const sink = codeSink();
		const changed: AuthenticatedUser[] = [];
		const auth = new Auth(root(), 'auth', {
			logger: captureLogger().logger,
			codeDelivery: sink.deliver,
			onPasswordChanged: async (user) => {
				changed.push(user);
				throw new Error('audit sink down');
			},
		});
		await register(auth, sink, 'ivo');
		const b = new Browser();
		await b.request((ctx) => auth.signIn('ivo', PASSWORD, ctx));
		await b.request((ctx) => auth.updatePassword(ctx, PASSWORD, NEW_PASSWORD));
		assert.deepStrictEqual(
			changed.map((u) => u.username),
			['ivo'],
		);
		assert.ok(!JSON.stringify(changed).includes(NEW_PASSWORD));
		assert.strictEqual(await b.request((ctx) => auth.checkAuth(ctx)), true);
	});
});
