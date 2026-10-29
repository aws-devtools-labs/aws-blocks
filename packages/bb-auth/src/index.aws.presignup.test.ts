// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Decision Q10 on the AWS runtime, offline: the pool's PreSignUp trigger runs
 * `validateUser` for every pool user Cognito creates — through `auth.signUp`,
 * `auth.admin.createUser`, or a `SignUp` called straight against Cognito.
 *
 * Cognito is played by the harness responders: on `SignUp` / `AdminCreateUser`
 * they build the PreSignUp event Cognito would send and invoke **core's real
 * Lambda handler** (`createLambdaHandler`), which routes it by user pool id to
 * the `Auth` instance; a throw becomes Cognito's `UserLambdaValidationException`
 * (`PreSignUp failed with error <message>.`) and no user is created.
 * Federated first sign-ins are covered in `federation-hosted-ui.test.ts`.
 */

import assert from 'node:assert';
import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, test } from 'node:test';
import type { AuthStateApi } from '@aws-blocks/auth-common';
import { ApiError, type BlocksContext } from '@aws-blocks/core';
import { cognitoConfigKeys, ownsPreSignUpTrigger, preSignUpTriggerConfigKey } from './cdk/contract.js';
import { AuthErrors } from './errors.js';
import { Auth } from './index.aws.js';
import { signValidatedMarker, VALIDATED_MARKER_KEY } from './presignup-trigger.js';
import {
	Browser,
	cognitoError,
	freeTriggerSlot,
	makeAwsAuth,
	simulateTriggerConfig,
	TEST_REGION,
	wireView,
} from './test-support/aws-harness.js';
import { cognitoWithTrigger, invokeLambda, preSignUpEvent } from './test-support/cognito-trigger.js';
import { decodeTriggerRejection } from './trigger-rejection.js';
import type { AuthOptions, UserCandidate } from './types.js';

beforeEach(() => rmSync('.bb-data', { recursive: true, force: true }));
afterEach(() => rmSync('.bb-data', { recursive: true, force: true }));

/** `validateUser` allowing `@corp.example` only, recording every call. */
function corpOnly() {
	const calls: UserCandidate[] = [];
	return {
		calls,
		validateUser: async (c: UserCandidate) => {
			calls.push(c);
			if (!c.email?.endsWith('@corp.example')) {
				throw new ApiError('Corporate accounts only', 403, { name: AuthErrors.NotAuthorized });
			}
		},
	};
}

/** Run `fn` with `console.error` silenced (core logs an unrouted trigger event). */
async function quietly(fn: () => Promise<void>): Promise<void> {
	const original = console.error;
	console.error = () => {};
	try {
		await fn();
	} finally {
		console.error = original;
	}
}

async function rejection(p: Promise<unknown>): Promise<unknown> {
	return p.then(
		() => assert.fail('expected a rejection'),
		(e: unknown) => e,
	);
}

function apiFor<O extends AuthOptions>(auth: Auth<O>, ctx: BlocksContext): AuthStateApi {
	return (auth.createApi() as unknown as (c: BlocksContext) => AuthStateApi)(ctx);
}

describe('Q10 (aws-runtime): auth.signUp — validateUser runs once, in-process, before Cognito', () => {
	test('accepted: one validateUser call; the trigger ran and recognised the marker', async () => {
		const policy = corpOnly();
		const h = makeAwsAuth({ validateUser: policy.validateUser });
		const cognito = cognitoWithTrigger(h);
		const out = await h.auth.signUp('ada', 'Password!1', {
			attributes: { email: 'ada@corp.example' },
			clientMetadata: { campaign: 'spring' },
		});
		assert.strictEqual(out.isSignUpComplete, false);
		assert.deepStrictEqual(cognito.created, ['ada']);
		assert.strictEqual(cognito.invocations.length, 1, 'Cognito invoked the trigger');
		assert.strictEqual(policy.calls.length, 1, 'validateUser ran once for one sign-up');
		const meta = h.sent.find((c) => c.name === 'SignUpCommand')?.input.ClientMetadata as Record<string, string>;
		assert.strictEqual(meta.campaign, 'spring', "the caller's own ClientMetadata is kept");
		assert.match(meta[VALIDATED_MARKER_KEY] ?? '', /^v1\.\d+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
	});

	test('rejected in-process: the canonical error, and Cognito is never called', async () => {
		const policy = corpOnly();
		const h = makeAwsAuth({ validateUser: policy.validateUser });
		const cognito = cognitoWithTrigger(h);
		const e = await rejection(h.auth.signUp('mal', 'Password!1', { attributes: { email: 'mal@gmail.com' } }));
		assert.deepStrictEqual(wireView(e), {
			code: 403,
			message: 'Corporate accounts only',
			name: AuthErrors.NotAuthorized,
			retriable: false,
		});
		assert.deepStrictEqual(h.sentNames(), []);
		assert.deepStrictEqual(cognito.created, []);
	});

	test('without validateUser nothing changes: no ClientMetadata is added, and no trigger handler is registered', async () => {
		const h = makeAwsAuth();
		// No `validateUser`: the CDK layer wires no trigger, so Cognito invokes none.
		h.on('SignUpCommand', () => ({ UserConfirmed: false, UserSub: 'sub-ada' }));
		await h.auth.signUp('ada', 'Password!1', { attributes: { email: 'ada@gmail.com' } });
		assert.strictEqual(h.sent[0]?.input.ClientMetadata, undefined);
		// …and the block does not answer one either (R2-1: only the trigger's owner does).
		await quietly(() =>
			assert.rejects(invokeLambda(preSignUpEvent('PreSignUp_SignUp', { Username: 'eve' })), {
				message: 'This user pool trigger is not configured.',
			}),
		);
	});
});

describe('Q10 (aws-runtime): the trigger blocks pool users the app never saw', () => {
	test('a SignUp made straight against Cognito is rejected; no user is created', async () => {
		const policy = corpOnly();
		const h = makeAwsAuth({ validateUser: policy.validateUser });
		const cognito = cognitoWithTrigger(h);
		const e = await rejection(
			cognito.directSignUp({
				ClientId: 'client-id-from-an-authorize-url',
				Username: 'mal',
				Password: 'Password!1',
				UserAttributes: [{ Name: 'email', Value: 'mal@gmail.com' }],
			}),
		);
		assert.ok(e instanceof Error);
		assert.strictEqual(e.name, 'UserLambdaValidationException');
		assert.deepStrictEqual(cognito.created, []);
		assert.deepStrictEqual(policy.calls, [
			{
				provider: 'password',
				subject: '',
				email: 'mal@gmail.com',
				username: 'mal',
				phase: 'signUp',
				claims: { email: 'mal@gmail.com' },
			},
		]);
		// What the caller of Cognito sees decodes to the developer's error, masked like in-process.
		const decoded = decodeTriggerRejection(e.message);
		assert.strictEqual(decoded?.name, AuthErrors.NotAuthorized);
		assert.strictEqual(decoded?.message, 'Corporate accounts only');
	});

	test('a forged marker does not skip the check', async () => {
		const policy = corpOnly();
		const h = makeAwsAuth({ validateUser: policy.validateUser });
		const cognito = cognitoWithTrigger(h);
		await rejection(
			cognito.directSignUp({
				Username: 'mal',
				UserAttributes: [{ Name: 'email', Value: 'mal@gmail.com' }],
				ClientMetadata: { [VALIDATED_MARKER_KEY]: signValidatedMarker('guessed-secret', h.fullId, 'mal') },
			}),
		);
		assert.strictEqual(policy.calls.length, 1);
		assert.deepStrictEqual(cognito.created, []);
	});

	test('a rejection from the trigger reaches the client by its canonical name and message', async () => {
		// validateUser accepts in-process but the trigger rejects (it re-validates because
		// Cognito delivered no marker): the client still sees the developer's error.
		let n = 0;
		const h = makeAwsAuth({
			validateUser: async () => {
				if (++n > 1) throw new ApiError('Sign-ups are closed', 403, { name: AuthErrors.NotAuthorized });
			},
		});
		const cognito = cognitoWithTrigger(h, { dropClientMetadata: true });
		const e = await rejection(h.auth.signUp('ada', 'Password!1', { attributes: { email: 'ada@corp.example' } }));
		assert.deepStrictEqual(wireView(e), {
			code: 403,
			message: 'Sign-ups are closed',
			name: AuthErrors.NotAuthorized,
			retriable: false,
		});
		assert.ok(!JSON.stringify(e).includes('$metadata'));
		assert.deepStrictEqual(cognito.created, []);

		// …and through the createApi() state machine (what the <Authenticator> calls).
		n = 0;
		const state = await new Browser().request((ctx) =>
			apiFor(h.auth, ctx).setAuthState({ action: 'signUp', username: 'ada2', password: 'Password!1' }),
		);
		assert.strictEqual(Reflect.get(state, 'errorName'), AuthErrors.NotAuthorized);
		assert.strictEqual(Reflect.get(state, 'error'), 'Sign-ups are closed');
	});

	test('the trigger answers only its own pool: two blocks, two pools', async () => {
		const seen: string[] = [];
		const make = (id: string, pool: string) => {
			const fullId = `q10-app-${id}`;
			const keys = cognitoConfigKeys(fullId);
			process.env[keys.USER_POOL_ID] = pool;
			process.env[keys.CLIENT_ID] = `client-${id}`;
			process.env[keys.REGION] = TEST_REGION;
			const options: AuthOptions = {
				validateUser: async (c) => {
					seen.push(`${id}:${c.username}`);
				},
			};
			simulateTriggerConfig(fullId, options, pool);
			return new Auth({ id: 'q10-app' }, id, options);
		};
		make('a', 'us-east-1_PoolA');
		make('b', 'us-east-1_PoolB');
		await invokeLambda(preSignUpEvent('PreSignUp_SignUp', { Username: 'u1' }, 'us-east-1_PoolB'));
		await invokeLambda(preSignUpEvent('PreSignUp_SignUp', { Username: 'u2' }, 'us-east-1_PoolA'));
		assert.deepStrictEqual(seen, ['b:u1', 'a:u2']);
		// A pool no block answers for: the Lambda fails, so Cognito rejects (fail closed).
		await quietly(() =>
			assert.rejects(invokeLambda(preSignUpEvent('PreSignUp_SignUp', { Username: 'u3' }, 'us-east-1_Nope'))),
		);
	});
});

describe('R2-1 (aws-runtime): only the block that owns the trigger answers it', () => {
	const SHARED_POOL = 'us-east-1_R21SharedPool';
	let run = 0;

	/**
	 * Configure `<root>-<id>` on {@link SHARED_POOL} the way the CDK layer would:
	 * the pool's config keys, and the trigger flag only where it wires the trigger.
	 */
	function configure(root: string, id: string, options: AuthOptions): AuthOptions {
		const fullId = `${root}-${id}`;
		const keys = cognitoConfigKeys(fullId);
		process.env[keys.USER_POOL_ID] = SHARED_POOL;
		process.env[keys.CLIENT_ID] = 'r21-client';
		process.env[keys.REGION] = TEST_REGION;
		const flag = preSignUpTriggerConfigKey(fullId);
		if (ownsPreSignUpTrigger(options)) process.env[flag] = 'true';
		else delete process.env[flag];
		return options;
	}

	function rejectAll() {
		const calls: UserCandidate[] = [];
		return {
			calls,
			validateUser: async (c: UserCandidate) => {
				calls.push(c);
				throw new ApiError('Sign-ups are closed', 403, { name: AuthErrors.NotAuthorized });
			},
		};
	}

	const directSignUp = () =>
		invokeLambda(
			preSignUpEvent(
				'PreSignUp_SignUp',
				{ Username: 'mal', UserAttributes: [{ Name: 'email', Value: 'mal@gmail.com' }] },
				SHARED_POOL,
			),
		);

	beforeEach(() => freeTriggerSlot(SHARED_POOL));

	for (const order of ['owner first', 'wrapper first'] as const) {
		test(`a second Auth wrapping the same pool does not disable validateUser (${order})`, async () => {
			const root = `r21-app${++run}`;
			const policy = rejectAll();
			const owner = configure(root, 'auth', { validateUser: policy.validateUser });
			const wrapper = configure(root, 'adminauth', { userPool: Auth.fromExisting(SHARED_POOL), admin: {} });
			const build = {
				owner: () => new Auth({ id: root }, 'auth', owner),
				wrapper: () => new Auth({ id: root }, 'adminauth', wrapper),
			};
			if (order === 'owner first') {
				build.owner();
				build.wrapper();
			} else {
				build.wrapper();
				build.owner();
			}
			const e = await rejection(directSignUp());
			assert.ok(e instanceof Error);
			assert.strictEqual(decodeTriggerRejection(e.message)?.name, AuthErrors.NotAuthorized);
			assert.strictEqual(policy.calls.length, 1, "the owner's validateUser ran");
		});
	}

	test('the handler is registered from the CDK flag, not inferred: validateUser alone registers nothing', async () => {
		// E.g. `validateUser` on a wrapped pool, or a runtime whose config predates the
		// trigger: the CDK layer registered no flag, so no handler — and an event the
		// pool still sends is refused (fail closed), never accepted.
		const root = `r21-app${++run}`;
		const policy = rejectAll();
		const options = { validateUser: policy.validateUser };
		configure(root, 'auth', options);
		delete process.env[preSignUpTriggerConfigKey(`${root}-auth`)];
		new Auth({ id: root }, 'auth', options);
		await quietly(() => assert.rejects(directSignUp(), { message: 'This user pool trigger is not configured.' }));
		assert.strictEqual(policy.calls.length, 0);
	});

	test("a wrapped pool with validateUser: no handler (the pool and its triggers are its owner's)", async () => {
		const root = `r21-app${++run}`;
		const policy = rejectAll();
		new Auth(
			{ id: root },
			'auth',
			configure(root, 'auth', { userPool: Auth.fromExisting(SHARED_POOL), validateUser: policy.validateUser }),
		);
		await quietly(() => assert.rejects(directSignUp(), { message: 'This user pool trigger is not configured.' }));
		assert.strictEqual(policy.calls.length, 0);
	});

	test('the flag without validateUser (a rollout removing it, config not yet updated): the handler accepts', async () => {
		const root = `r21-app${++run}`;
		configure(root, 'auth', {});
		process.env[preSignUpTriggerConfigKey(`${root}-auth`)] = 'true';
		new Auth({ id: root }, 'auth', {});
		const out = await directSignUp();
		assert.strictEqual(
			Reflect.get(Object(out), 'triggerSource'),
			'PreSignUp_SignUp',
			'the event is returned: accepted',
		);
	});
});

describe('Q10 (aws-runtime): admin.createUser runs validateUser too', () => {
	test('accepted: in-process check, the marker rides on AdminCreateUser, the trigger skips', async () => {
		const policy = corpOnly();
		const h = makeAwsAuth({ admin: {}, validateUser: policy.validateUser });
		const cognito = cognitoWithTrigger(h);
		await h.auth.admin.createUser('cy', { attributes: { email: 'cy@corp.example' } });
		assert.deepStrictEqual(cognito.created, ['cy']);
		assert.strictEqual(policy.calls.length, 1);
		assert.deepStrictEqual(policy.calls[0], {
			provider: 'password',
			subject: '',
			email: 'cy@corp.example',
			username: 'cy',
			phase: 'signUp',
			claims: { email: 'cy@corp.example' },
		});
		const meta = h.sent.find((c) => c.name === 'AdminCreateUserCommand')?.input.ClientMetadata;
		assert.ok(meta && typeof meta === 'object' && VALIDATED_MARKER_KEY in meta);
	});

	test('rejected: the canonical error, AdminCreateUser is never sent', async () => {
		const policy = corpOnly();
		const h = makeAwsAuth({ admin: {}, validateUser: policy.validateUser });
		cognitoWithTrigger(h);
		const e = await rejection(h.auth.admin.createUser('mal', { attributes: { email: 'mal@gmail.com' } }));
		assert.strictEqual(wireView(e).name, AuthErrors.NotAuthorized);
		assert.deepStrictEqual(h.sentNames(), []);
	});

	test('an AdminCreateUser from outside the app (console, CLI) is checked by the trigger', async () => {
		const policy = corpOnly();
		makeAwsAuth({ admin: {}, validateUser: policy.validateUser });
		const e = await rejection(
			invokeLambda(
				preSignUpEvent('PreSignUp_AdminCreateUser', {
					Username: 'mal',
					UserAttributes: [{ Name: 'email', Value: 'mal@gmail.com' }],
				}),
			),
		);
		assert.ok(e instanceof Error);
		assert.strictEqual(decodeTriggerRejection(e.message)?.name, AuthErrors.NotAuthorized);
		assert.strictEqual(policy.calls[0]?.provider, 'password');
	});
});

describe('Q10 × FX3 (aws-runtime): a trigger rejection and the confirm-code masking on one instance', () => {
	test('default (revealExistingUsers off): sign-up rejection is canonical; a disabled-user confirm is a wrong code', async () => {
		let n = 0;
		const h = makeAwsAuth({
			validateUser: async () => {
				if (++n > 1) throw new ApiError('Sign-ups are closed', 403, { name: AuthErrors.NotAuthorized });
			},
		});
		cognitoWithTrigger(h, { dropClientMetadata: true });
		const rejected = wireView(
			await rejection(h.auth.signUp('ada', 'Password!1', { attributes: { email: 'ada@corp.example' } })),
		);
		assert.deepStrictEqual(rejected, {
			code: 403,
			message: 'Sign-ups are closed',
			name: AuthErrors.NotAuthorized,
			retriable: false,
		});
		h.on('ConfirmSignUpCommand', () => {
			throw cognitoError(AuthErrors.NotAuthorized, 'User cannot be confirmed. Current status is CONFIRMED');
		});
		const confirm = wireView(await rejection(h.auth.confirmSignUp('ada', '123456')));
		assert.strictEqual(confirm.name, AuthErrors.CodeMismatch);
	});
});
