// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * AWS runtime — error mapping, against a spied Cognito client (no network).
 * Cognito SDK exception → the `ApiError` name + HTTP status the client sees;
 * no SDK metadata, ARNs or account ids on the wire. User-enumeration safety
 * lives in `index.aws.enumeration.test.ts`. Harness: `test-support/aws-harness.ts`.
 */

import assert from 'node:assert';
import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, test } from 'node:test';
import type { AuthStateApi } from '@aws-blocks/auth-common';
import type { BlocksContext } from '@aws-blocks/core';
import { ApiError, isBlocksError } from '@aws-blocks/core';
import { type AuthCognito, AuthCognitoErrors, toCognitoApiError } from './index.aws.js';
import {
	type AwsAuthHarness,
	Browser,
	captureLogger,
	cognitoError,
	makeAwsAuth,
	signInAs,
	wireView,
} from './test-support/aws-harness.js';

beforeEach(() => rmSync('.bb-data', { recursive: true, force: true }));
afterEach(() => rmSync('.bb-data', { recursive: true, force: true }));

/** `createApi()` returns a context-bound callable; narrow it to the public surface. */
function apiFor(auth: AuthCognito, ctx: BlocksContext): AuthStateApi {
	return (auth.createApi() as unknown as (c: BlocksContext) => AuthStateApi)(ctx);
}

/** Make `command` fail with a Cognito exception, call `run`, return what was thrown. */
const ADMIN = { admin: {} } as const;

async function thrownBy(command: string, error: unknown, run: (h: AwsAuthHarness<typeof ADMIN>) => Promise<unknown>) {
	const h = makeAwsAuth(ADMIN);
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
		// Unlisted names fall through to 400 with the Cognito name preserved.
		['SomeFutureCognitoException', 400, false],
	];

	// Driven through an admin call: admin.* has no enumeration masking, so every
	// Cognito name (including UserNotFoundException) maps straight through.
	for (const [name, status, retriable] of table) {
		test(`${name} → ${status}${retriable ? ' (retriable)' : ''}, name preserved`, async () => {
			const e = await thrownBy('AdminDeleteUserCommand', cognitoError(name, `msg for ${name}`), (h) =>
				h.auth.admin.deleteUser('bob'),
			);
			assert.ok(e instanceof ApiError);
			assert.ok(isBlocksError(e, name), 'matchable by name with isBlocksError');
			// The wire message is the block's own text for the name (#678), never Cognito's.
			const message = toCognitoApiError(cognitoError(name, `msg for ${name}`)).message;
			assert.notStrictEqual(message, `msg for ${name}`);
			assert.deepStrictEqual(wireView(e), { code: status, message, name, retriable });
		});
	}

	test('InternalErrorException (a Cognito service fault) → 500, retriable', async () => {
		const e = await thrownBy(
			'AdminDeleteUserCommand',
			cognitoError('InternalErrorException', 'Internal server error.', 500),
			(h) => h.auth.admin.deleteUser('bob'),
		);
		// Matches the block's other upstream-failure status ("Cognito returned no tokens" → 500).
		assert.deepStrictEqual(wireView(e), {
			code: 500,
			message: 'Authentication service error, try again later',
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
		const h = makeAwsAuth({ groups: ['admins'] });
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
			message: toCognitoApiError(cognitoError('TooManyRequestsException', 'Rate exceeded')).message,
			name: 'TooManyRequestsException',
			retriable: false,
		});
	});

	test('a non-Error rejection becomes a generic 500', async () => {
		const e = await thrownBy('AdminDeleteUserCommand', 'socket hang up', (h) => h.auth.admin.deleteUser('bob'));
		assert.ok(e instanceof ApiError);
		assert.strictEqual(e.status, 500);
		assert.strictEqual(e.message, 'Unknown error');
	});
});

describe('AWS error mapping: no SDK metadata reaches the client', () => {
	test('JSON.stringify of the thrown error carries no $metadata / request id / fault', async () => {
		const e = await thrownBy('AdminDeleteUserCommand', cognitoError('LimitExceededException', 'Slow down'), (h) =>
			h.auth.admin.deleteUser('bob'),
		);
		const json = JSON.stringify(e);
		for (const leak of ['$metadata', 'requestId', 'b5-req-0000', '$fault', '__type', 'cause']) {
			assert.ok(!json.includes(leak), `serialized error leaks ${leak}: ${json}`);
		}
		assert.ok(!JSON.stringify(wireView(e)).includes('$metadata'));
	});

	test('Error.cause holds the SDK error but is never enumerable', async () => {
		const sdkErr = cognitoError('CodeMismatchException', 'Invalid code');
		const e = await thrownBy('AdminDeleteUserCommand', sdkErr, (h) => h.auth.admin.deleteUser('bob'));
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
		const h = makeAwsAuth({ groups: ['admins'], logger });
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
		assert.strictEqual(view.name, 'AccessDeniedException');
		assert.strictEqual(view.retriable, false);
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

	const scanOptions = () => ({ groups: ['admins'], admin: {}, logger: captureLogger().logger }) as const;

	/** Each public path that maps an SDK error, with the command it sends. */
	const PATHS: Array<{
		label: string;
		command: string;
		run: (h: AwsAuthHarness<ReturnType<typeof scanOptions>>, b: Browser) => Promise<unknown>;
		signedIn?: boolean;
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
			label: 'fetchUserAttributes',
			command: 'GetUserCommand',
			run: (h, b) => b.request((c) => h.auth.fetchUserAttributes(c)),
			signedIn: true,
		},
		{
			label: 'requireRole',
			command: 'AdminListGroupsForUserCommand',
			run: (h, b) => b.request((c) => h.auth.requireRole(c, 'admins')),
			signedIn: true,
		},
		{ label: 'admin.getUser', command: 'AdminGetUserCommand', run: (h) => h.auth.admin.getUser('bob') },
		{
			label: 'admin.scan',
			command: 'ListUsersCommand',
			run: async (h) => {
				for await (const _u of h.auth.admin.scan()) void _u;
			},
		},
	];

	for (const path of PATHS) {
		test(`${path.label}: no SDK message with an ARN or account id reaches the client`, async () => {
			for (const name of NAMES) {
				for (const message of LEAKY) {
					const h = makeAwsAuth(scanOptions());
					const b = new Browser();
					if (path.signedIn) await signInAs(h, b, 'alice');
					h.on(path.command, () => {
						throw cognitoError(name, message);
					});
					const observed = await path.run(h, b).then(
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
			const h = makeAwsAuth({ logger: captureLogger().logger });
			h.on('SignUpCommand', () => {
				throw cognitoError(name, ARN_MESSAGE);
			});
			const s = await new Browser().request((ctx) =>
				apiFor(h.auth, ctx).setAuthState({ action: 'signUp', username: 'a', password: 'Password!1' }),
			);
			assertClean(`setAuthState ${name}`, s);
		}
	});

	test("Cognito's own message text never reaches the client (#678)", async () => {
		const e = await thrownBy(
			'AdminDeleteUserCommand',
			cognitoError('UserLambdaValidationException', 'PreSignUp failed with error Email domain not allowed.'),
			(h) => h.auth.admin.deleteUser('bob'),
		);
		assert.strictEqual(wireView(e).message, 'User pool Lambda trigger rejected the request');
	});
});

describe('AWS createApi error surface (Authenticator state machine)', () => {
	test('a non-retriable error returns a signed-out state carrying error + errorName (no throw)', async () => {
		const h = makeAwsAuth();
		h.on('SignUpCommand', () => {
			throw cognitoError('UsernameExistsException', 'User already exists');
		});
		const s = await new Browser().request((ctx) =>
			apiFor(h.auth, ctx).setAuthState({ action: 'signUp', username: 'alice', password: 'Password!1' }),
		);
		assert.strictEqual(s.state, 'signedOut');
		assert.strictEqual(s.error, 'User already exists');
		assert.strictEqual(s.errorName, 'UsernameExistsException');
		assert.ok(!JSON.stringify(s).includes('$metadata'));
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
			error: 'Invalid code',
			retriable: true,
			errorName: 'CodeMismatchException',
		});
	});

	test('requireRole without a session is a 401 before any admin call', async () => {
		const h = makeAwsAuth();
		await assert.rejects(
			() => new Browser().request((ctx) => h.auth.requireRole(ctx, 'admins')),
			(e: Error & { status?: number }) =>
				e.status === 401 && isBlocksError(e, AuthCognitoErrors.NotAuthenticated),
		);
		assert.deepStrictEqual(h.sent, []);
	});
});
