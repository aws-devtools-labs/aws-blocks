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
 *
 * Ported from `bb-auth-cognito/src/index.aws.enumeration.test.ts` (B6). Where
 * an expectation differs it says why, inline (`Auth:`). Harness:
 * `test-support/aws-harness.ts`.
 */

import assert from 'node:assert';
import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, test } from 'node:test';
import type { AuthStateApi } from '@aws-blocks/auth-common';
import type { BlocksContext } from '@aws-blocks/core';
import { clientMessageFor } from './error-mapping.js';
import { type Auth, AuthErrors } from './index.aws.js';
import {
	Browser,
	captureLogger,
	cognitoError,
	type LogEntry,
	makeAwsAuth,
	wireView,
} from './test-support/aws-harness.js';
import type { AuthOptions } from './types.js';

beforeEach(() => rmSync('.bb-data', { recursive: true, force: true }));
afterEach(() => rmSync('.bb-data', { recursive: true, force: true }));

function apiFor<O extends AuthOptions>(auth: Auth<O>, ctx: BlocksContext): AuthStateApi {
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
	name: AuthErrors.NotAuthorized,
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
			assert.strictEqual(s.errorName, AuthErrors.NotAuthorized);
			seen.add(JSON.stringify(s));
		}
		assert.strictEqual(seen.size, 1);
	});

	test('USER_AUTH password leg (confirmSignIn): wrong password and unknown user are identical', async () => {
		const seen = new Set<string>();
		for (const err of Object.values(SIGN_IN_FAILURES)) {
			const h = makeAwsAuth({ users: { authFlow: 'USER_AUTH' } });
			const b = new Browser();
			h.on('InitiateAuthCommand', () => ({
				ChallengeName: 'SELECT_CHALLENGE',
				Session: 'cog-sel',
				ChallengeParameters: { AVAILABLE_CHALLENGES: '["PASSWORD"]' },
			}));
			const pick = await b.request((ctx) => h.auth.signIn('someone', '', ctx));
			const s1 = pick.status === 'continueSignIn' && 'session' in pick.nextStep ? pick.nextStep.session : '';
			// Auth: `confirmSignIn` takes the answer as a string (D5a); AuthCognito
			// also took `{ firstFactor }` / `{ password }` objects.
			const pw = await b.request((ctx) => h.auth.confirmSignIn(s1, 'PASSWORD', ctx));
			const s2 = pw.status === 'continueSignIn' && 'session' in pw.nextStep ? pw.nextStep.session : '';
			h.on('RespondToAuthChallengeCommand', () => {
				throw err();
			});
			const e = await rejection(b.request((ctx) => h.auth.confirmSignIn(s2, 'pw', ctx)));
			assert.deepStrictEqual(wireView(e), INCORRECT);
			seen.add(JSON.stringify(wireView(e)));
		}
		assert.strictEqual(seen.size, 1);
	});

	test('a PASSWORD challenge answer is a credential check too (added for Auth)', async () => {
		const seen = new Set<string>();
		for (const err of Object.values(SIGN_IN_FAILURES)) {
			const h = makeAwsAuth({ users: { authFlow: 'USER_AUTH' } });
			const b = new Browser();
			h.on('InitiateAuthCommand', () => ({ ChallengeName: 'PASSWORD', Session: 'cog-pw' }));
			const first = await b.request((ctx) => h.auth.signIn('someone', '', ctx));
			const s = first.status === 'continueSignIn' && 'session' in first.nextStep ? first.nextStep.session : '';
			h.on('RespondToAuthChallengeCommand', () => {
				throw err();
			});
			const e = await rejection(b.request((ctx) => h.auth.confirmSignIn(s, 'pw', ctx)));
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

	test('confirmSignIn: non-credential challenge failures keep Cognito’s answer', async () => {
		const h = makeAwsAuth();
		const b = new Browser();
		h.on('InitiateAuthCommand', () => ({ ChallengeName: 'SOFTWARE_TOKEN_MFA', Session: 'cog-1' }));
		const first = await b.request((ctx) => h.auth.signIn('alice', 'pw', ctx));
		const session = first.status === 'continueSignIn' && 'session' in first.nextStep ? first.nextStep.session : '';
		h.on('RespondToAuthChallengeCommand', () => {
			throw cognitoError('NotAuthorizedException', 'Invalid session for the user, session is expired.');
		});
		const e = await rejection(b.request((ctx) => h.auth.confirmSignIn(session, '123456', ctx)));
		// The name is Cognito's (not masked); the message is the name's fixed one (FX59, #678).
		assert.strictEqual(wireView(e).name, AuthErrors.NotAuthorized);
		assert.strictEqual(wireView(e).message, clientMessageFor(AuthErrors.NotAuthorized));
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
				message: 'Invalid verification code provided, please try again.',
				name: AuthErrors.CodeMismatch,
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
			// FX59 (#678): the name's fixed message; Cognito's text is logged server-side.
			message: clientMessageFor(AuthErrors.UserNotFound),
			name: AuthErrors.UserNotFound,
			retriable: false,
		});
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// FX3 (A3): account *state* — unknown vs unconfirmed vs already-confirmed — on
// every public email + password step, not only `signUp`. Each table row is what
// Cognito answers for that kind of user (with and without
// PreventUserExistenceErrors; `bb-auth`'s own client enables it, an adopted pool
// may not). With `revealExistingUsers` off (the default) every row must reach
// the client byte-identically; with it on, today's informative answers stay.
// ─────────────────────────────────────────────────────────────────────────────

type Answer = () => unknown;
const fail =
	(name: string, message: string): Answer =>
	() => {
		throw cognitoError(name, message);
	};

/** Cognito's ExpiredCodeException wording for a confirmation code. */
const EXPIRED = 'Invalid code provided, please request a code again.';
const ALREADY_CONFIRMED_CONFIRM = 'User cannot be confirmed. Current status is CONFIRMED';
const ALREADY_CONFIRMED_RESEND = 'User is already confirmed.';

/** Everything a client can observe of a rejection: the wire fields plus the serialized body. */
function observedOf(e: unknown): string {
	return `${JSON.stringify(wireView(e))}|${JSON.stringify(e)}`;
}

async function observed(p: Promise<unknown>): Promise<string> {
	return observedOf(await rejection(p));
}

const WRONG_CODE_WIRE = {
	code: 400,
	message: 'Invalid verification code provided, please try again.',
	name: AuthErrors.CodeMismatch,
	retriable: true,
};

const CONFIRM_SIGN_UP_ANSWERS: Record<string, Answer> = {
	'unknown user (pool masks)': fail('CodeMismatchException', WRONG_CODE_WIRE.message),
	'unknown user (pool does not mask)': fail('UserNotFoundException', 'User does not exist.'),
	'unconfirmed user, wrong code': fail('CodeMismatchException', WRONG_CODE_WIRE.message),
	'unconfirmed user, expired code': fail('ExpiredCodeException', EXPIRED),
	'already-confirmed user': fail('NotAuthorizedException', ALREADY_CONFIRMED_CONFIRM),
};

const RESEND_ANSWERS: Record<string, Answer> = {
	'unknown user (pool masks)': () => ({
		CodeDeliveryDetails: { Destination: 'n***@e***', DeliveryMedium: 'EMAIL', AttributeName: 'email' },
	}),
	'unknown user (pool does not mask)': fail('UserNotFoundException', 'Username/client id combination not found.'),
	'unconfirmed user': () => ({
		CodeDeliveryDetails: { Destination: 'n***@e***', DeliveryMedium: 'EMAIL', AttributeName: 'email' },
	}),
	'already-confirmed user': fail('InvalidParameterException', ALREADY_CONFIRMED_RESEND),
};

const RESET_DELIVERY = {
	CodeDeliveryDetails: { Destination: 'n***@e***', DeliveryMedium: 'EMAIL', AttributeName: 'email' },
};
const RESET_ANSWERS: Record<string, Answer> = {
	'unknown user (pool masks)': () => RESET_DELIVERY,
	'unknown user (pool does not mask)': fail('UserNotFoundException', 'Username/client id combination not found.'),
	'unconfirmed user (pool masks)': () => RESET_DELIVERY,
	'unconfirmed user (pool does not mask)': fail(
		'InvalidParameterException',
		'Cannot reset password for the user as there is no registered/verified email or phone_number',
	),
	'admin-created user, never signed in': fail(
		'NotAuthorizedException',
		'User password cannot be reset in the current state.',
	),
	'confirmed user': () => RESET_DELIVERY,
};

const CONFIRM_RESET_ANSWERS: Record<string, Answer> = {
	'unknown user (pool masks)': fail('CodeMismatchException', WRONG_CODE_WIRE.message),
	'unknown user (pool does not mask)': fail('UserNotFoundException', 'User does not exist.'),
	'existing user, no code requested': fail('ExpiredCodeException', EXPIRED),
	'existing user, wrong code': fail('CodeMismatchException', WRONG_CODE_WIRE.message),
	'existing user, expired code': fail('ExpiredCodeException', EXPIRED),
	'disabled user (pool does not mask)': fail('NotAuthorizedException', 'User is disabled.'),
};

const EMAIL = 'nobody@example.com';

describe('AWS enumeration (FX3): confirmSignUp hides the account state', () => {
	test('unknown, unconfirmed and already-confirmed users get the identical wrong-code error', async () => {
		const seen = new Set<string>();
		for (const [label, answer] of Object.entries(CONFIRM_SIGN_UP_ANSWERS)) {
			const h = makeAwsAuth();
			h.on('ConfirmSignUpCommand', answer);
			const e = await rejection(h.auth.confirmSignUp(EMAIL, '000000'));
			assert.deepStrictEqual(wireView(e), WRONG_CODE_WIRE, label);
			seen.add(observedOf(e));
		}
		assert.strictEqual(seen.size, 1);
	});

	test('setAuthState confirmSignUp: every account state yields the identical state', async () => {
		const seen = new Set<string>();
		for (const answer of Object.values(CONFIRM_SIGN_UP_ANSWERS)) {
			const h = makeAwsAuth();
			h.on('ConfirmSignUpCommand', answer);
			const s = await new Browser().request((ctx) =>
				apiFor(h.auth, ctx).setAuthState({ action: 'confirmSignUp', username: EMAIL, code: '000000' }),
			);
			assert.strictEqual(s.errorName, AuthErrors.CodeMismatch);
			seen.add(JSON.stringify(s));
		}
		assert.strictEqual(seen.size, 1);
	});

	test('revealExistingUsers: true keeps the informative answers', async () => {
		const h = makeAwsAuth({ emailPassword: { revealExistingUsers: true } });
		h.on('ConfirmSignUpCommand', CONFIRM_SIGN_UP_ANSWERS['already-confirmed user']);
		assert.deepStrictEqual(wireView(await rejection(h.auth.confirmSignUp(EMAIL, '000000'))), {
			code: 401,
			// FX59 (#678): the name's fixed message; Cognito's text is logged server-side.
			message: clientMessageFor(AuthErrors.NotAuthorized),
			name: AuthErrors.NotAuthorized,
			retriable: false,
		});
		h.on('ConfirmSignUpCommand', CONFIRM_SIGN_UP_ANSWERS['unconfirmed user, expired code']);
		assert.strictEqual(
			wireView(await rejection(h.auth.confirmSignUp(EMAIL, '000000'))).name,
			AuthErrors.ExpiredCode,
		);
		// An unknown user is still answered like a wrong code (unchanged).
		h.on('ConfirmSignUpCommand', CONFIRM_SIGN_UP_ANSWERS['unknown user (pool does not mask)']);
		assert.deepStrictEqual(wireView(await rejection(h.auth.confirmSignUp(EMAIL, '000000'))), WRONG_CODE_WIRE);
	});
});

describe('AWS enumeration (FX3): resendSignUpCode hides the account state', () => {
	test('unknown, unconfirmed and already-confirmed users all get a silent success', async () => {
		const seen = new Set<string>();
		for (const [label, answer] of Object.entries(RESEND_ANSWERS)) {
			const h = makeAwsAuth();
			h.on('ResendConfirmationCodeCommand', answer);
			assert.strictEqual(await h.auth.resendSignUpCode(EMAIL), undefined, label);
			const s = await new Browser().request((ctx) =>
				apiFor(h.auth, ctx).setAuthState({ action: 'resendSignUpCode', username: EMAIL }),
			);
			seen.add(JSON.stringify(s));
		}
		assert.strictEqual(seen.size, 1);
	});

	test('revealExistingUsers: true reports an already-confirmed user', async () => {
		const h = makeAwsAuth({ emailPassword: { revealExistingUsers: true } });
		h.on('ResendConfirmationCodeCommand', RESEND_ANSWERS['already-confirmed user']);
		assert.deepStrictEqual(wireView(await rejection(h.auth.resendSignUpCode(EMAIL))), {
			code: 400,
			// FX59 (#678): the name's fixed message; Cognito's text is logged server-side.
			message: clientMessageFor(AuthErrors.InvalidParameter),
			name: AuthErrors.InvalidParameter,
			retriable: true,
		});
	});
});

describe('AWS enumeration (FX3): resetPassword hides the account state', () => {
	test('unknown, unconfirmed, never-signed-in and confirmed users get identical delivery details', async () => {
		const seen = new Set<string>();
		for (const [label, answer] of Object.entries(RESET_ANSWERS)) {
			const h = makeAwsAuth();
			h.on('ForgotPasswordCommand', answer);
			const r = await h.auth.resetPassword(EMAIL);
			assert.strictEqual(r.nextStep?.codeDeliveryDetails?.destination, 'n***@e***', label);
			seen.add(JSON.stringify(r));
			const s = await new Browser().request((ctx) =>
				apiFor(h.auth, ctx).setAuthState({ action: 'resetPassword', username: EMAIL }),
			);
			seen.add(`state|${JSON.stringify(s)}`);
		}
		assert.strictEqual(seen.size, 2, [...seen].join('\n'));
	});

	test('revealExistingUsers: true surfaces Cognito’s answer for an unconfirmed user', async () => {
		const h = makeAwsAuth({ emailPassword: { revealExistingUsers: true } });
		h.on('ForgotPasswordCommand', RESET_ANSWERS['unconfirmed user (pool does not mask)']);
		assert.strictEqual(wireView(await rejection(h.auth.resetPassword(EMAIL))).name, AuthErrors.InvalidParameter);
	});
});

describe('AWS enumeration (FX3): confirmResetPassword hides the account state', () => {
	test('every account state gets the identical wrong-code error', async () => {
		const seen = new Set<string>();
		for (const [label, answer] of Object.entries(CONFIRM_RESET_ANSWERS)) {
			const h = makeAwsAuth();
			h.on('ConfirmForgotPasswordCommand', answer);
			const e = await rejection(h.auth.confirmResetPassword(EMAIL, '000000', 'NewPassword!1'));
			assert.deepStrictEqual(wireView(e), WRONG_CODE_WIRE, label);
			seen.add(observedOf(e));
		}
		assert.strictEqual(seen.size, 1);
	});

	test('revealExistingUsers: true keeps ExpiredCodeException', async () => {
		const h = makeAwsAuth({ emailPassword: { revealExistingUsers: true } });
		h.on('ConfirmForgotPasswordCommand', CONFIRM_RESET_ANSWERS['existing user, expired code']);
		const e = await rejection(h.auth.confirmResetPassword(EMAIL, '000000', 'NewPassword!1'));
		assert.strictEqual(wireView(e).name, AuthErrors.ExpiredCode);
	});
});

describe('R2-4: a withheld answer is logged at warn, without the username', () => {
	// Cognito echoes some request values in a validation message; the username must not reach the log.
	const LOGIN = 'Nobody@Example.com';
	const echoing = (name: string) =>
		fail(name, `1 validation error detected: Value '${LOGIN}' at 'username' failed to satisfy constraint`);

	function check(entries: LogEntry[], method: RegExp, cognitoName: string) {
		const withheld = entries.filter((e) => method.test(e.message));
		assert.strictEqual(withheld.length, 1, JSON.stringify(entries));
		const [entry] = withheld;
		assert.strictEqual(entry?.level, 'warn', 'operators see it at the usual warn threshold');
		assert.strictEqual(entry?.context?.error, cognitoName);
		const logged = JSON.stringify(entry).toLowerCase();
		assert.ok(!logged.includes(LOGIN.toLowerCase()), `no username in ${logged}`);
		assert.match(String(entry?.context?.message), /Value '\[REDACTED\]' at 'username'/);
		assert.ok(!entries.some((e) => e.level === 'info'), 'nothing left at info');
	}

	test('resendSignUpCode: a malformed username "succeeds" for the client; the log says why', async () => {
		const { logger, entries } = captureLogger();
		const h = makeAwsAuth({ logger });
		h.on('ResendConfirmationCodeCommand', echoing('InvalidParameterException'));
		assert.strictEqual(await h.auth.resendSignUpCode(LOGIN), undefined);
		check(entries, /resendSignUpCode: answer withheld/, 'InvalidParameterException');
	});

	test('resetPassword: the same', async () => {
		const { logger, entries } = captureLogger();
		const h = makeAwsAuth({ logger });
		h.on('ForgotPasswordCommand', echoing('InvalidParameterException'));
		const r = await h.auth.resetPassword(LOGIN);
		assert.strictEqual(r.isPasswordReset, false);
		check(entries, /resetPassword: answer withheld/, 'InvalidParameterException');
	});

	test('confirmSignUp / confirmResetPassword: an expired code shown as a wrong code is logged at warn', async () => {
		for (const [command, call] of [
			['ConfirmSignUpCommand', (h: ReturnType<typeof makeAwsAuth>) => h.auth.confirmSignUp(LOGIN, '000000')],
			[
				'ConfirmForgotPasswordCommand',
				(h: ReturnType<typeof makeAwsAuth>) => h.auth.confirmResetPassword(LOGIN, '000000', 'NewPassword!1'),
			],
		] as const) {
			const { logger, entries } = captureLogger();
			const h = makeAwsAuth({ logger });
			h.on(command, echoing('ExpiredCodeException'));
			assert.deepStrictEqual(wireView(await rejection(call(h))), WRONG_CODE_WIRE, command);
			check(entries, /reported to the client as a wrong code/, 'ExpiredCodeException');
		}
	});
});

describe('AWS enumeration (FX3): sign-in needs no extra masking', () => {
	test('an unconfirmed user with a wrong password looks like any other credential failure', async () => {
		const seen = new Set<string>();
		const answers = [
			...Object.values(SIGN_IN_FAILURES),
			// Cognito checks the password before the confirmation status.
			() => cognitoError('NotAuthorizedException', 'Incorrect username or password.'),
		];
		for (const err of answers) {
			const h = makeAwsAuth();
			h.on('InitiateAuthCommand', () => {
				throw err();
			});
			seen.add(await observed(new Browser().request((ctx) => h.auth.signIn(EMAIL, 'wrong', ctx))));
		}
		assert.strictEqual(seen.size, 1);
	});
});
