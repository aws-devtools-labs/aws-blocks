// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * AWS runtime — error mapping, against a spied Cognito client (no network).
 * Cognito SDK exception → the `ApiError` name + HTTP status the client sees;
 * no SDK metadata, ARNs or account ids on the wire. User-enumeration safety
 * lives in `index.aws.enumeration.test.ts`. Harness: `test-support/aws-harness.ts`.
 *
 * Ported from `bb-auth-cognito/src/index.aws.errors.test.ts` (B5/B6). Where an
 * expectation differs it says why, inline (`Auth:`). Two systematic changes:
 *
 * - **Vehicle.** B5 drove the mapping table through `admin.deleteUser` (no
 *   enumeration masking). `admin.*` is D5c2's, so these tests use
 *   `signUp()` — also unmasked: a server-side `signUp` is inside the trust
 *   boundary (R9) and maps every Cognito name straight through. The admin
 *   paths were kept as `todo` until D5c2; they now run too (the table is also
 *   driven through `admin.deleteUser`).
 * - **L10.** Every client-visible name is an `AuthErrors` member: a Cognito
 *   name outside the vocabulary, an AWS access error and a non-`Error` throw
 *   all become `InternalErrorException` (500, retriable, generic message),
 *   where `AuthCognito` passed the raw name through.
 * - **FX59** (ports `AuthCognito` #678). The message is never Cognito's: each
 *   name gets the fixed, BB-authored `clientMessageFor(name)`; Cognito's text
 *   goes to the server log only. Every path is scanned in
 *   `index.aws.wire-messages.test.ts`.
 */

import assert from 'node:assert';
import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, test } from 'node:test';
import type { AuthStateApi } from '@aws-blocks/auth-common';
import type { BlocksContext } from '@aws-blocks/core';
import { ApiError, isBlocksError, registerSdkIdentifiers } from '@aws-blocks/core';
import { WRONG_CODE_MESSAGE } from './enumeration.js';
import { ACCESS_DENIED_MESSAGE, clientMessageFor, INTERNAL_ERROR_MESSAGE } from './error-mapping.js';
import { type Auth, AuthErrors } from './index.aws.js';
import {
	type AwsAuthHarness,
	Browser,
	captureLogger,
	cognitoError,
	makeAwsAuth,
	signInAs,
	wireView,
} from './test-support/aws-harness.js';
import type { AuthOptions } from './types.js';

beforeEach(() => rmSync('.bb-data', { recursive: true, force: true }));
afterEach(() => rmSync('.bb-data', { recursive: true, force: true }));

/** `createApi()` returns a context-bound callable; narrow it to the public surface. */
function apiFor<O extends AuthOptions>(auth: Auth<O>, ctx: BlocksContext): AuthStateApi {
	return (auth.createApi() as unknown as (c: BlocksContext) => AuthStateApi)(ctx);
}

/** Make `command` fail with `error`, call `run`, return what was thrown. */
async function thrownBy<const O extends AuthOptions = AuthOptions>(
	command: string,
	error: unknown,
	run: (h: AwsAuthHarness<O>) => Promise<unknown>,
	options?: O,
) {
	const h = makeAwsAuth<O>(options);
	h.on(command, () => {
		throw error;
	});
	try {
		await run(h);
	} catch (e) {
		return e;
	}
	assert.fail('expected the call to reject');
}

/** The unmasked vehicle: a server-side `signUp` (`SignUpCommand`). */
function viaSignUp(error: unknown) {
	return thrownBy('SignUpCommand', error, (h) => h.auth.signUp('bob', 'Password!1'));
}

const ARN_MESSAGE =
	'User: arn:aws:sts::123456789012:assumed-role/app-Handler-ABC/app-Handler is not authorized to perform: ' +
	'cognito-idp:AdminListGroupsForUser on resource: arn:aws:cognito-idp:us-east-1:123456789012:userpool/us-east-1_X';

describe('AWS error mapping: Cognito exception → client-visible ApiError', () => {
	// [Cognito name, HTTP status, retriable]
	const table: Array<[string, number, boolean]> = [
		['NotAuthorizedException', 401, false],
		['UserNotFoundException', 404, false],
		['ResourceNotFoundException', 404, false],
		['UsernameExistsException', 409, false],
		['LimitExceededException', 429, false],
		['TooManyRequestsException', 429, false],
		['TooManyFailedAttemptsException', 429, false],
		['CodeMismatchException', 400, true],
		['InvalidPasswordException', 400, true],
		['InvalidParameterException', 400, true],
		['EnableSoftwareTokenMFAException', 400, true],
		['ExpiredCodeException', 400, false],
		['UserNotConfirmedException', 400, false],
		['PasswordResetRequiredException', 400, false],
		['AliasExistsException', 400, false],
		['UserLambdaValidationException', 400, false],
	];

	for (const [name, status, retriable] of table) {
		test(`${name} → ${status}${retriable ? ' (retriable)' : ''}, name preserved`, async () => {
			const e = await viaSignUp(cognitoError(name, `msg for ${name}`));
			assert.ok(e instanceof ApiError);
			assert.ok(isBlocksError(e, name), 'matchable by name with isBlocksError');
			// FX59 (#678): the name's fixed message, never Cognito's text.
			assert.deepStrictEqual(wireView(e), { code: status, message: clientMessageFor(name), name, retriable });
		});
	}

	test('a name outside the AuthErrors vocabulary → 500 InternalErrorException, retriable, generic message', async () => {
		// Auth (L10): AuthCognito passed unlisted names through as 400 with the
		// Cognito name and message; Auth never puts a name outside AuthErrors on
		// the wire. The original is logged server-side.
		const { logger, entries } = captureLogger();
		const e = await thrownBy(
			'SignUpCommand',
			cognitoError('SomeFutureCognitoException', 'msg for SomeFutureCognitoException'),
			(h) => h.auth.signUp('bob', 'Password!1'),
			{ logger },
		);
		assert.deepStrictEqual(wireView(e), {
			code: 500,
			message: INTERNAL_ERROR_MESSAGE,
			name: AuthErrors.InternalError,
			retriable: true,
		});
		assert.ok(entries.some((x) => x.level === 'error' && x.context?.error === 'SomeFutureCognitoException'));
	});

	test('a useful Cognito name outside the vocabulary (CodeDeliveryFailureException) is also InternalError (L10)', async () => {
		const e = await viaSignUp(cognitoError('CodeDeliveryFailureException', 'Unable to deliver the code'));
		assert.strictEqual(wireView(e).name, AuthErrors.InternalError);
		assert.strictEqual(wireView(e).code, 500);
	});

	test('InternalErrorException (a Cognito service fault) → 500, retriable', async () => {
		const e = await viaSignUp(cognitoError('InternalErrorException', 'Internal server error.', 500));
		// Matches the block's other upstream-failure status ("Cognito returned no tokens" → 500).
		assert.deepStrictEqual(wireView(e), {
			code: 500,
			// FX59 (#678): the fixed message, not Cognito's 'Internal server error.'.
			message: INTERNAL_ERROR_MESSAGE,
			name: 'InternalErrorException',
			retriable: true,
		});
	});

	test('InternalErrorException on a challenge keeps the Authenticator on the step', async () => {
		const h = makeAwsAuth();
		const b = new Browser();
		h.on('InitiateAuthCommand', () => ({ ChallengeName: 'SOFTWARE_TOKEN_MFA', Session: 'cog-1' }));
		const first = await b.request((ctx) => h.auth.signIn('alice', 'pw', ctx));
		const session = first.status === 'continueSignIn' && 'session' in first.nextStep ? first.nextStep.session : '';
		h.on('RespondToAuthChallengeCommand', () => {
			throw cognitoError('InternalErrorException', 'Internal server error.', 500);
		});
		const s = await b.request((ctx) =>
			apiFor(h.auth, ctx).setAuthState({ action: 'confirmSignIn', challenge: 'code', session, code: '123456' }),
		);
		assert.strictEqual(s.retriable, true);
		assert.strictEqual(s.errorName, 'InternalErrorException');
	});

	test('errors the block raises itself pass through untouched (status, name, retriable)', async () => {
		const h = makeAwsAuth({ users: { groups: ['admins'] } });
		const b = new Browser();
		await signInAs(h, b, 'alice');
		// Code-shape check before any Cognito call: a 6-digit rule on TOTP setup.
		h.on('InitiateAuthCommand', () => ({
			ChallengeName: 'MFA_SETUP',
			Session: 'cog-setup',
			ChallengeParameters: { MFAS_CAN_SETUP: '["SOFTWARE_TOKEN_MFA"]' },
		}));
		h.on('AssociateSoftwareTokenCommand', () => ({ SecretCode: 'SECRET', Session: 'cog-assoc' }));
		const first = await b.request((ctx) => h.auth.signIn('alice', 'pw', ctx));
		const session = first.status === 'continueSignIn' && 'session' in first.nextStep ? first.nextStep.session : '';
		const e = await b
			.request((ctx) => h.auth.confirmSignIn(session, '12', ctx))
			.then(
				() => assert.fail('expected rejection'),
				(err: unknown) => err,
			);
		assert.deepStrictEqual(wireView(e), {
			code: 400,
			message: 'Authenticator code must be 6 digits.',
			name: 'InvalidParameterException',
			retriable: true,
		});
	});

	test('the same mapping applies on the sign-in path', async () => {
		const e = await thrownBy(
			'InitiateAuthCommand',
			cognitoError('TooManyRequestsException', 'Rate exceeded'),
			(h) => new Browser().request((ctx) => h.auth.signIn('alice', 'pw', ctx)),
		);
		assert.deepStrictEqual(wireView(e), {
			code: 429,
			message: clientMessageFor(AuthErrors.TooManyRequests),
			name: 'TooManyRequestsException',
			retriable: false,
		});
	});

	test('a non-Error rejection becomes a generic 500', async () => {
		const e = await viaSignUp('socket hang up');
		assert.ok(e instanceof ApiError);
		assert.strictEqual(e.status, 500);
		// Auth (L10): the generic message and the InternalError name (was 'Unknown error' with the default name).
		assert.strictEqual(e.message, INTERNAL_ERROR_MESSAGE);
		assert.strictEqual(e.name, AuthErrors.InternalError);
	});

	test('a missing pool identifier is a 500 before any Cognito call (added for Auth)', async () => {
		const h = makeAwsAuth({ logger: captureLogger().logger });
		registerSdkIdentifiers(h.fullId, { clientId: '' });
		const e = await h.auth.signUp('bob', 'Password!1').then(
			() => assert.fail('expected rejection'),
			(err: unknown) => err,
		);
		assert.deepStrictEqual(wireView(e), {
			code: 500,
			message: INTERNAL_ERROR_MESSAGE,
			name: AuthErrors.InternalError,
			retriable: true,
		});
		assert.deepStrictEqual(h.sent, []);
	});

	test('[admin.deleteUser] the mapping table driven through admin.* (the B5 vehicle, restored by D5c2)', async () => {
		for (const [name, status, retriable] of table) {
			const e = await thrownBy(
				'AdminDeleteUserCommand',
				cognitoError(name, `msg for ${name}`),
				(h) => h.auth.admin.deleteUser('bob'),
				{ admin: {} },
			);
			assert.ok(e instanceof ApiError, name);
			assert.ok(isBlocksError(e, name), `${name}: matchable by name with isBlocksError`);
			// Inside the trust boundary: no enumeration masking, so UserNotFound stays a 404.
			assert.deepStrictEqual(
				wireView(e),
				{ code: status, message: clientMessageFor(name), name, retriable },
				name,
			);
			assert.ok(!Object.keys(e).includes('cause'), `${name}: cause is not enumerable`);
			assert.ok(!JSON.stringify(e).includes('$metadata'), `${name}: no SDK metadata`);
		}
	});
});

describe('AWS error mapping: no SDK metadata reaches the client', () => {
	test('JSON.stringify of the thrown error carries no $metadata / request id / fault', async () => {
		const e = await viaSignUp(cognitoError('LimitExceededException', 'Slow down'));
		const json = JSON.stringify(e);
		for (const leak of ['$metadata', 'requestId', 'b5-req-0000', '$fault', '__type', 'cause']) {
			assert.ok(!json.includes(leak), `serialized error leaks ${leak}: ${json}`);
		}
		assert.ok(!JSON.stringify(wireView(e)).includes('$metadata'));
	});

	test('Error.cause holds the SDK error but is never enumerable', async () => {
		const sdkErr = cognitoError('CodeMismatchException', 'Invalid code');
		const e = await viaSignUp(sdkErr);
		assert.ok(e instanceof Error);
		const desc = Object.getOwnPropertyDescriptor(e, 'cause');
		assert.ok(desc, 'cause is kept for server-side logging');
		assert.strictEqual(desc.enumerable, false);
		assert.strictEqual(desc.value, sdkErr);
		assert.ok(!Object.keys(e).includes('cause'));
		assert.ok(!JSON.stringify({ ...e }).includes('$metadata'));
	});

	test('AccessDenied: the client gets a generic 500; the ARN-bearing detail goes to the logger', async () => {
		const { logger, entries } = captureLogger();
		const h = makeAwsAuth({ users: { groups: ['admins'] }, logger });
		const b = new Browser();
		await signInAs(h, b, 'alice');
		h.on('AdminListGroupsForUserCommand', () => {
			throw cognitoError('AccessDeniedException', ARN_MESSAGE);
		});
		const e = await b
			.request((ctx) => h.auth.requireRole(ctx, 'admins'))
			.then(
				() => assert.fail('expected rejection'),
				(err: unknown) => err,
			);
		const view = wireView(e);
		assert.strictEqual(view.code, 500);
		// Auth (L10): the function role's IAM failure is reported as the retriable
		// InternalErrorException (AuthCognito: 'AccessDeniedException', not retriable).
		assert.strictEqual(view.name, AuthErrors.InternalError);
		assert.strictEqual(view.retriable, true);
		assert.strictEqual(view.message, ACCESS_DENIED_MESSAGE);
		assert.doesNotMatch(String(view.message), /arn:|\d{12}/);
		assert.ok(!JSON.stringify(e).includes('$metadata'));
		// Operators still get the detail, server-side.
		const logged = entries.find(
			(x) => x.level === 'error' && JSON.stringify(x).includes('arn:aws:sts::123456789012'),
		);
		assert.ok(logged, `expected the SDK detail in the block logger: ${JSON.stringify(entries)}`);
	});
});

describe('AWS error mapping: no ARN or account id can reach the client', () => {
	const ARN = /arn:aws[a-z-]*:/i;
	const ACCOUNT_ID = /(?<!\d)\d{12}(?!\d)/;
	const LEAKY = [
		ARN_MESSAGE,
		'Resource arn:aws:cognito-idp:us-east-1:123456789012:userpool/us-east-1_X not found',
		'Lambda arn:aws-cn:lambda:cn-north-1:210987654321:function:pre-signup failed',
		'Account 123456789012 is over its limit',
		'PreSignUp failed with error Rejected for 123456789012.',
	];
	const NAMES = [
		'AccessDeniedException',
		'UnrecognizedClientException',
		'NotAuthorizedException',
		'UserNotFoundException',
		'ResourceNotFoundException',
		'InvalidParameterException',
		'LimitExceededException',
		'InternalErrorException',
		'UserLambdaValidationException',
		'InvalidLambdaResponseException',
		'SomeFutureCognitoException',
	];

	/** Every client-observable projection of a failure: the thrown error and the Authenticator state. */
	function assertClean(label: string, observed: unknown) {
		const surfaces = [String(JSON.stringify(observed)), JSON.stringify(wireView(observed))];
		for (const text of surfaces) {
			assert.doesNotMatch(text, ARN, `${label}: ARN on the wire: ${text}`);
			assert.doesNotMatch(text, ACCOUNT_ID, `${label}: account id on the wire: ${text}`);
		}
	}

	const scanOptions = () =>
		({
			users: { groups: ['admins'], authFlow: 'USER_AUTH' },
			passkeys: { relyingPartyId: 'example.com', origins: ['https://example.com'] },
			admin: {},
			logger: captureLogger().logger,
		}) as const;
	type ScanHarness = AwsAuthHarness<ReturnType<typeof scanOptions>>;

	/** Sign in, then expire the stored access token (the next guarded call refreshes). */
	async function expiredSession(h: ScanHarness, b: Browser) {
		await signInAs(h, b, 'alice', h.idp.authResult('alice', { accessExpIn: -60 }));
	}

	/** Start a TOTP challenge; return its envelope. */
	async function challengeSession(h: ScanHarness, b: Browser): Promise<string> {
		h.on('InitiateAuthCommand', () => ({ ChallengeName: 'SOFTWARE_TOKEN_MFA', Session: 'cog-1' }));
		const r = await b.request((c) => h.auth.signIn('alice', '', c, { preferredChallenge: 'EMAIL_OTP' }));
		return r.status === 'continueSignIn' && 'session' in r.nextStep ? r.nextStep.session : '';
	}

	/** Each public path that maps an SDK error, with the command it sends. */
	const PATHS: Array<{
		label: string;
		command: string;
		run: (h: ScanHarness, b: Browser, extra: { session: string }) => Promise<unknown>;
		setup?: (h: ScanHarness, b: Browser) => Promise<{ session: string }>;
	}> = [
		{
			label: 'signIn',
			command: 'InitiateAuthCommand',
			run: (h, b) => b.request((c) => h.auth.signIn('a', 'p', c)),
		},
		{ label: 'signUp', command: 'SignUpCommand', run: (h) => h.auth.signUp('a', 'Password!1') },
		{ label: 'confirmSignUp', command: 'ConfirmSignUpCommand', run: (h) => h.auth.confirmSignUp('a', '1') },
		{
			label: 'resendSignUpCode',
			command: 'ResendConfirmationCodeCommand',
			run: (h) => h.auth.resendSignUpCode('a'),
		},
		{ label: 'resetPassword', command: 'ForgotPasswordCommand', run: (h) => h.auth.resetPassword('a') },
		{
			label: 'confirmResetPassword',
			command: 'ConfirmForgotPasswordCommand',
			run: (h) => h.auth.confirmResetPassword('a', '1', 'Password!1'),
		},
		{
			// Auth: replaces B5's fetchUserAttributes path (D5c2) — the same
			// access-token-bearing shape.
			label: 'updatePassword',
			command: 'ChangePasswordCommand',
			run: (h, b) => b.request((c) => h.auth.updatePassword(c, 'Old!pass1', 'New!pass1')),
			setup: async (h, b) => {
				await signInAs(h, b, 'alice');
				return { session: '' };
			},
		},
		{
			label: 'requireRole',
			command: 'AdminListGroupsForUserCommand',
			run: (h, b) => b.request((c) => h.auth.requireRole(c, 'admins')),
			setup: async (h, b) => {
				await signInAs(h, b, 'alice');
				return { session: '' };
			},
		},
		// Added for Auth: the remaining core paths that map an SDK error.
		{
			label: 'confirmSignIn',
			command: 'RespondToAuthChallengeCommand',
			run: (h, b, { session }) => b.request((c) => h.auth.confirmSignIn(session, '123456', c)),
			setup: async (h, b) => ({ session: await challengeSession(h, b) }),
		},
		{
			label: 'session refresh (transient)',
			command: 'InitiateAuthCommand',
			run: (h, b) => b.request((c) => h.auth.requireAuth(c)),
			setup: async (h, b) => {
				await expiredSession(h, b);
				return { session: '' };
			},
		},
		{
			label: 'setAuthState listPasskeys',
			command: 'ListWebAuthnCredentialsCommand',
			run: (h, b) => b.request((c) => apiFor(h.auth, c).setAuthState({ action: 'listPasskeys' })),
			setup: async (h, b) => {
				await signInAs(h, b, 'alice');
				return { session: '' };
			},
		},
		// D5c2: the account + admin paths B5 drove (were `todo` until the engine had them).
		{ label: 'admin.getUser', command: 'AdminGetUserCommand', run: (h) => h.auth.admin.getUser('bob') },
		{
			label: 'admin.scan',
			command: 'ListUsersCommand',
			run: async (h) => {
				for await (const _u of h.auth.admin.scan()) void _u;
			},
		},
		{
			// Auth: `fetchUserAttributes` is `getUserAttributes` (D3 rename).
			label: 'fetchUserAttributes',
			command: 'GetUserCommand',
			run: (h, b) => b.request((c) => h.auth.getUserAttributes(c)),
			setup: async (h, b) => {
				await signInAs(h, b, 'alice');
				return { session: '' };
			},
		},
		{
			label: 'setAuthState startPasskeyRegistration',
			command: 'StartWebAuthnRegistrationCommand',
			run: (h, b) => b.request((c) => apiFor(h.auth, c).setAuthState({ action: 'startPasskeyRegistration' })),
			setup: async (h, b) => {
				await signInAs(h, b, 'alice');
				return { session: '' };
			},
		},
	];

	for (const path of PATHS) {
		test(`${path.label}: no SDK message with an ARN or account id reaches the client`, async () => {
			for (const name of NAMES) {
				for (const message of LEAKY) {
					const h = makeAwsAuth(scanOptions());
					const b = new Browser();
					const extra = path.setup ? await path.setup(h, b) : { session: '' };
					h.on(path.command, () => {
						throw cognitoError(name, message);
					});
					const observed = await path.run(h, b, extra).then(
						(ok) => ok,
						(err: unknown) => err,
					);
					assertClean(`${path.label} ${name}`, observed);
				}
			}
		});
	}

	test('setAuthState: the Authenticator state never carries an ARN or account id', async () => {
		for (const name of NAMES) {
			// `revealExistingUsers` so a UsernameExists-style answer is surfaced, not masked.
			const h = makeAwsAuth({ emailPassword: { revealExistingUsers: true }, logger: captureLogger().logger });
			h.on('SignUpCommand', () => {
				throw cognitoError(name, ARN_MESSAGE);
			});
			const s = await new Browser().request((ctx) =>
				apiFor(h.auth, ctx).setAuthState({ action: 'signUp', username: 'a', password: 'Password!1' }),
			);
			assertClean(`setAuthState ${name}`, s);
		}
	});

	test('ordinary Cognito messages are replaced by the name’s fixed message too (FX59, #678)', async () => {
		// Before FX59 this pinned the opposite: only ARN / account-id text was
		// withheld and Cognito's own message reached the client. `AuthCognito`
		// 0.1.11 (#678) sends a BB-authored message per name; `Auth` matches it.
		const { logger, entries } = captureLogger();
		const e = await thrownBy(
			'SignUpCommand',
			cognitoError('UserLambdaValidationException', 'PreSignUp failed with error Email domain not allowed.'),
			(h) => h.auth.signUp('bob', 'Password!1'),
			{ logger },
		);
		assert.strictEqual(wireView(e).message, clientMessageFor(AuthErrors.UserLambdaValidation));
		assert.ok(
			entries.some((x) => x.context?.message === 'PreSignUp failed with error Email domain not allowed.'),
			'the Cognito text is in the server log',
		);
	});
});

describe('AWS createApi error surface (Authenticator state machine)', () => {
	test('a non-retriable error returns a signed-out state carrying error + errorName (no throw)', async () => {
		// Auth (R9): the public sign-up form masks an existing account by default,
		// so this pins the opted-in behaviour; the default is the next test.
		const h = makeAwsAuth({ emailPassword: { revealExistingUsers: true } });
		h.on('SignUpCommand', () => {
			throw cognitoError('UsernameExistsException', 'User already exists');
		});
		const s = await new Browser().request((ctx) =>
			apiFor(h.auth, ctx).setAuthState({ action: 'signUp', username: 'alice', password: 'Password!1' }),
		);
		assert.strictEqual(s.state, 'signedOut');
		assert.strictEqual(s.error, clientMessageFor(AuthErrors.UserAlreadyExists));
		assert.strictEqual(s.errorName, 'UsernameExistsException');
		assert.ok(!JSON.stringify(s).includes('$metadata'));
	});

	test('by default an existing account on the sign-up form answers like a new sign-up (added for Auth: R9)', async () => {
		const existing = makeAwsAuth();
		existing.on('SignUpCommand', () => {
			throw cognitoError('UsernameExistsException', 'User already exists');
		});
		const fresh = makeAwsAuth();
		fresh.on('SignUpCommand', () => ({ UserConfirmed: false, UserSub: 'sub-alice' }));
		const input = { action: 'signUp', username: 'alice', password: 'Password!1' } as const;
		const a = await new Browser().request((ctx) => apiFor(existing.auth, ctx).setAuthState(input));
		const b = await new Browser().request((ctx) => apiFor(fresh.auth, ctx).setAuthState(input));
		assert.strictEqual(a.state, 'confirmingSignUp');
		assert.deepStrictEqual(a, b);
	});

	test('a retriable error keeps the step: { retriable: true } with no actions', async () => {
		const h = makeAwsAuth();
		const b = new Browser();
		h.on('InitiateAuthCommand', () => ({ ChallengeName: 'SOFTWARE_TOKEN_MFA', Session: 'cog-1' }));
		const first = await b.request((ctx) => h.auth.signIn('alice', 'pw', ctx));
		assert.ok(first.status === 'continueSignIn' && 'session' in first.nextStep);
		const session = 'session' in first.nextStep ? first.nextStep.session : '';
		h.on('RespondToAuthChallengeCommand', () => {
			throw cognitoError('CodeMismatchException', 'Invalid code received for user');
		});
		const s = await b.request((ctx) =>
			apiFor(h.auth, ctx).setAuthState({ action: 'confirmSignIn', challenge: 'code', session, code: '000000' }),
		);
		assert.deepStrictEqual(s, {
			state: 'signedOut',
			actions: [],
			// FX59 (#678): the fixed wrong-code message, not Cognito's text.
			error: WRONG_CODE_MESSAGE,
			retriable: true,
			errorName: 'CodeMismatchException',
		});
	});

	test('requireRole without a session is a 401 before any admin call', async () => {
		const h = makeAwsAuth();
		await assert.rejects(
			() => new Browser().request((ctx) => h.auth.requireRole(ctx, 'admins')),
			(e: Error & { status?: number }) => e.status === 401 && isBlocksError(e, AuthErrors.NotAuthenticated),
		);
		assert.deepStrictEqual(h.sent, []);
	});
});
