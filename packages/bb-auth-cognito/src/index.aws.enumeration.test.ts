// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * AWS runtime — user-enumeration safety on every public, non-admin flow, against
 * a spied Cognito client (no network). The rules (design 04 §6.3): sign-in is
 * uniform for unknown / wrong-password / disabled; password reset and code
 * resend always succeed with plausible details; confirm-code flows answer an
 * unknown user exactly like a wrong code. Covers pools that DO surface
 * `UserNotFoundException` (e.g. adopted via `fromExisting` without
 * `PreventUserExistenceErrors`). `auth.admin.*` may still report UserNotFound.
 * Harness: `test-support/aws-harness.ts`.
 */

import assert from 'node:assert';
import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, test } from 'node:test';
import type { AuthStateApi } from '@aws-blocks/auth-common';
import type { BlocksContext } from '@aws-blocks/core';
import { type AuthCognito, AuthCognitoErrors } from './index.aws.js';
import { Browser, cognitoError, makeAwsAuth, wireView } from './test-support/aws-harness.js';

beforeEach(() => rmSync('.bb-data', { recursive: true, force: true }));
afterEach(() => rmSync('.bb-data', { recursive: true, force: true }));

function apiFor(auth: AuthCognito, ctx: BlocksContext): AuthStateApi {
	return (auth.createApi() as unknown as (c: BlocksContext) => AuthStateApi)(ctx);
}

/** What Cognito says for each sign-in failure, with and without PreventUserExistenceErrors. */
const SIGN_IN_FAILURES: Record<string, () => Error> = {
	'wrong password': () => cognitoError('NotAuthorizedException', 'Incorrect username or password.'),
	'unknown user (pool masks)': () => cognitoError('NotAuthorizedException', 'Incorrect username or password.'),
	'unknown user (pool does not mask)': () => cognitoError('UserNotFoundException', 'User does not exist.'),
	'disabled user': () => cognitoError('NotAuthorizedException', 'User is disabled.'),
};

const INCORRECT = {
	code: 401,
	message: 'Incorrect username or password',
	name: AuthCognitoErrors.NotAuthorized,
	retriable: false,
};

/** Cognito's own answer for a wrong confirmation code. */
const wrongCode = () => cognitoError('CodeMismatchException', 'Invalid verification code provided, please try again.');

async function rejection(p: Promise<unknown>): Promise<unknown> {
	return p.then(
		() => assert.fail('expected rejection'),
		(e: unknown) => e,
	);
}

describe('AWS enumeration: sign-in is uniform', () => {
	test('signIn: wrong password, unknown user and disabled user are byte-identical', async () => {
		const seen: string[] = [];
		for (const [label, err] of Object.entries(SIGN_IN_FAILURES)) {
			const h = makeAwsAuth();
			h.on('InitiateAuthCommand', () => {
				throw err();
			});
			const e = await rejection(new Browser().request((ctx) => h.auth.signIn('someone', 'pw', ctx)));
			assert.deepStrictEqual(wireView(e), INCORRECT, label);
			seen.push(`${JSON.stringify(wireView(e))}|${JSON.stringify(e)}`);
		}
		assert.strictEqual(new Set(seen).size, 1);
	});

	test('setAuthState signIn: every failure yields the identical signed-out state', async () => {
		const seen = new Set<string>();
		for (const err of Object.values(SIGN_IN_FAILURES)) {
			const h = makeAwsAuth();
			h.on('InitiateAuthCommand', () => {
				throw err();
			});
			const s = await new Browser().request((ctx) =>
				apiFor(h.auth, ctx).setAuthState({ action: 'signIn', username: 'someone', password: 'pw' }),
			);
			assert.strictEqual(s.errorName, AuthCognitoErrors.NotAuthorized);
			seen.add(JSON.stringify(s));
		}
		assert.strictEqual(seen.size, 1);
	});

	test('USER_AUTH password leg (confirmSignIn): wrong password and unknown user are identical', async () => {
		const seen = new Set<string>();
		for (const err of Object.values(SIGN_IN_FAILURES)) {
			const h = makeAwsAuth({ authFlowType: 'USER_AUTH' });
			const b = new Browser();
			h.on('InitiateAuthCommand', () => ({
				ChallengeName: 'SELECT_CHALLENGE',
				Session: 'cog-sel',
				ChallengeParameters: { AVAILABLE_CHALLENGES: '["PASSWORD"]' },
			}));
			const pick = await b.request((ctx) => h.auth.signIn('someone', '', ctx));
			const s1 = pick.status === 'continueSignIn' && 'session' in pick.nextStep ? pick.nextStep.session : '';
			const pw = await b.request((ctx) => h.auth.confirmSignIn(s1, { firstFactor: 'PASSWORD' }, ctx));
			const s2 = pw.status === 'continueSignIn' && 'session' in pw.nextStep ? pw.nextStep.session : '';
			h.on('RespondToAuthChallengeCommand', () => {
				throw err();
			});
			const e = await rejection(b.request((ctx) => h.auth.confirmSignIn(s2, { password: 'pw' }, ctx)));
			assert.deepStrictEqual(wireView(e), INCORRECT);
			seen.add(JSON.stringify(wireView(e)));
		}
		assert.strictEqual(seen.size, 1);
	});

	test('confirmSignIn: a user deleted mid-challenge looks like a credential failure, not a 404', async () => {
		const h = makeAwsAuth();
		const b = new Browser();
		h.on('InitiateAuthCommand', () => ({ ChallengeName: 'SOFTWARE_TOKEN_MFA', Session: 'cog-1' }));
		const first = await b.request((ctx) => h.auth.signIn('alice', 'pw', ctx));
		const session = first.status === 'continueSignIn' && 'session' in first.nextStep ? first.nextStep.session : '';
		h.on('RespondToAuthChallengeCommand', () => {
			throw cognitoError('UserNotFoundException', 'User does not exist.');
		});
		const e = await rejection(b.request((ctx) => h.auth.confirmSignIn(session, '123456', ctx)));
		assert.deepStrictEqual(wireView(e), INCORRECT);
	});

	test('confirmSignIn: non-credential challenge failures keep their own error name', async () => {
		const h = makeAwsAuth();
		const b = new Browser();
		h.on('InitiateAuthCommand', () => ({ ChallengeName: 'SOFTWARE_TOKEN_MFA', Session: 'cog-1' }));
		const first = await b.request((ctx) => h.auth.signIn('alice', 'pw', ctx));
		const session = first.status === 'continueSignIn' && 'session' in first.nextStep ? first.nextStep.session : '';
		h.on('RespondToAuthChallengeCommand', () => {
			throw cognitoError('NotAuthorizedException', 'Invalid session for the user, session is expired.');
		});
		const e = await rejection(b.request((ctx) => h.auth.confirmSignIn(session, '123456', ctx)));
		assert.deepStrictEqual(
			{ name: wireView(e).name, message: wireView(e).message },
			{ name: AuthCognitoErrors.NotAuthorized, message: 'Not authorized' },
		);
	});
});

describe('AWS enumeration: password reset and code resend always succeed', () => {
	test('resetPassword for an unknown email username looks exactly like a known one', async () => {
		const known = makeAwsAuth();
		known.on('ForgotPasswordCommand', () => ({
			CodeDeliveryDetails: { Destination: 'a***@e***', DeliveryMedium: 'EMAIL', AttributeName: 'email' },
		}));
		const unknown = makeAwsAuth();
		unknown.on('ForgotPasswordCommand', () => {
			throw cognitoError('UserNotFoundException', 'Username/client id combination not found.');
		});
		const a = await known.auth.resetPassword('alice@example.com');
		const b = await unknown.auth.resetPassword('alice@example.com');
		assert.deepStrictEqual(b, a);
	});

	test('resetPassword fabricates a plausible, stable destination for any unknown username', async () => {
		const h = makeAwsAuth();
		h.on('ForgotPasswordCommand', () => {
			throw cognitoError('UserNotFoundException', 'Username/client id combination not found.');
		});
		const first = await h.auth.resetPassword('nobody');
		const again = await h.auth.resetPassword('nobody');
		const details = first.nextStep?.codeDeliveryDetails;
		assert.strictEqual(first.isPasswordReset, false);
		assert.strictEqual(first.nextStep?.name, 'CONFIRM_RESET_PASSWORD_WITH_CODE');
		assert.strictEqual(details?.deliveryMedium, 'EMAIL');
		assert.strictEqual(details?.attributeName, 'email');
		assert.match(details?.destination ?? '', /^[a-z]\*\*\*@[a-z]\*\*\*$/, 'shaped like a real masked address');
		assert.deepStrictEqual(again, first, 'repeat requests answer the same way a real account would');
	});

	test('resetPassword for an unknown phone-number username fabricates an SMS destination', async () => {
		const h = makeAwsAuth();
		h.on('ForgotPasswordCommand', () => {
			throw cognitoError('UserNotFoundException', 'Username/client id combination not found.');
		});
		const r = await h.auth.resetPassword('+15555550100');
		assert.deepStrictEqual(r.nextStep?.codeDeliveryDetails, {
			destination: '+*******0100',
			deliveryMedium: 'SMS',
			attributeName: 'phone_number',
		});
	});

	test('resendSignUpCode for an unknown user resolves like a known one', async () => {
		const h = makeAwsAuth();
		h.on('ResendConfirmationCodeCommand', () => {
			throw cognitoError('UserNotFoundException', 'Username/client id combination not found.');
		});
		assert.strictEqual(await h.auth.resendSignUpCode('nobody'), undefined);
		const s = await new Browser().request((ctx) =>
			apiFor(h.auth, ctx).setAuthState({ action: 'resendSignUpCode', username: 'nobody' }),
		);
		assert.strictEqual(s.state, 'confirmingSignUp');
		assert.strictEqual(s.error, undefined);
	});

	test('resendSignUpCode still surfaces non-enumeration errors', async () => {
		const h = makeAwsAuth();
		h.on('ResendConfirmationCodeCommand', () => {
			throw cognitoError('LimitExceededException', 'Attempt limit exceeded');
		});
		const e = await rejection(h.auth.resendSignUpCode('alice'));
		assert.strictEqual(wireView(e).code, 429);
	});
});

describe('AWS enumeration: confirm-code flows answer an unknown user like a wrong code', () => {
	const flows: Array<{
		label: string;
		command: string;
		run: (h: ReturnType<typeof makeAwsAuth>) => Promise<unknown>;
	}> = [
		{ label: 'confirmSignUp', command: 'ConfirmSignUpCommand', run: (h) => h.auth.confirmSignUp('x', '000000') },
		{
			label: 'confirmResetPassword',
			command: 'ConfirmForgotPasswordCommand',
			run: (h) => h.auth.confirmResetPassword('x', '000000', 'NewPassword!1'),
		},
	];

	for (const flow of flows) {
		test(`${flow.label}: unknown user ≡ wrong code`, async () => {
			const views: string[] = [];
			for (const err of [wrongCode, () => cognitoError('UserNotFoundException', 'User does not exist.')]) {
				const h = makeAwsAuth();
				h.on(flow.command, () => {
					throw err();
				});
				const e = await rejection(flow.run(h));
				views.push(JSON.stringify(wireView(e)));
			}
			assert.strictEqual(views[0], views[1]);
			assert.deepStrictEqual(JSON.parse(views[1]), {
				code: 400,
				message: 'Invalid code',
				name: AuthCognitoErrors.CodeMismatch,
				retriable: true,
			});
		});
	}
});

describe('AWS enumeration: admin.* is inside the trust boundary', () => {
	test('admin calls still report UserNotFoundException', async () => {
		const h = makeAwsAuth({ admin: {} });
		h.on('AdminDeleteUserCommand', () => {
			throw cognitoError('UserNotFoundException', 'User does not exist.');
		});
		const e = await rejection(h.auth.admin.deleteUser('ghost'));
		assert.deepStrictEqual(wireView(e), {
			code: 404,
			message: 'User not found',
			name: AuthCognitoErrors.UserNotFound,
			retriable: false,
		});
	});
});
