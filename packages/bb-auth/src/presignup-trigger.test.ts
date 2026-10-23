// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Decision Q10, the trigger's own logic (`presignup-trigger.ts`,
 * `trigger-rejection.ts`), with stubbed Cognito events: how each trigger
 * source maps to the `UserCandidate` `validateUser` receives, the "validated
 * in-process" marker, and how a rejection is encoded so the client sees the
 * canonical error. The AWS runtime end to end (core's Lambda handler, the
 * Cognito engine) is `index.aws.presignup.test.ts`; mock parity is
 * `parity.presignup.test.ts`.
 */

import assert from 'node:assert';
import crypto from 'node:crypto';
import { describe, test } from 'node:test';
import { ApiError } from '@aws-blocks/core';
import { clientMessageFor, INTERNAL_ERROR_MESSAGE, toAuthApiError, WITHHELD_MESSAGE } from './error-mapping.js';
import { AuthErrors } from './errors.js';
import {
	candidateFromTrigger,
	handlePreSignUpTrigger,
	MARKER_KEY_INFO,
	type PreSignUpEvent,
	parsePreSignUpEvent,
	passwordSignUpCandidate,
	signValidatedMarker,
	VALIDATED_MARKER_KEY,
	verifyValidatedMarker,
} from './presignup-trigger.js';
import { resolveSignInMode } from './sign-in-mode.js';
import { captureLogger } from './test-helpers.js';
import { decodeTriggerRejection, encodeTriggerRejection } from './trigger-rejection.js';
import type { AppSettingRef, AuthOptions, UserCandidate } from './types.js';

const SECRET = 'presignup-test-secret-0123456789';
const FULL_ID = 'app-auth';
const POOL = 'us-east-1_TriggerPool';
const PROVIDER_SECRET: AppSettingRef = { fullId: 'provider-secret', get: async () => 's3cret' };

/** A Cognito PreSignUp event, as Cognito sends it. */
function cognitoEvent(
	triggerSource: string,
	userName: string,
	userAttributes: Record<string, string>,
	clientMetadata?: Record<string, string>,
) {
	return {
		version: '1',
		region: 'us-east-1',
		userPoolId: POOL,
		userName,
		callerContext: { awsSdkVersion: 'aws-sdk-js-3', clientId: 'client-1' },
		triggerSource,
		request: { userAttributes, validationData: null, ...(clientMetadata ? { clientMetadata } : {}) },
		response: { autoConfirmUser: false, autoVerifyEmail: false, autoVerifyPhone: false },
	};
}

function parsed(event: ReturnType<typeof cognitoEvent>): PreSignUpEvent {
	const p = parsePreSignUpEvent(event);
	assert.ok(p, 'expected a PreSignUp event');
	return p;
}

/** Run the trigger with a recording `validateUser`; return what it saw and the outcome. */
async function runTrigger(event: unknown, options: AuthOptions & { reject?: unknown } = {}) {
	const seen: UserCandidate[] = [];
	const { reject, ...rest } = options;
	const { logger, entries } = captureLogger();
	const opts: AuthOptions = {
		validateUser: async (c) => {
			seen.push(c);
			if (reject !== undefined) throw reject;
		},
		...rest,
	};
	let error: unknown;
	try {
		await handlePreSignUpTrigger(event, {
			options: opts,
			fullId: FULL_ID,
			sessionSecret: async () => SECRET,
			log: logger,
		});
	} catch (e) {
		error = e;
	}
	return { seen, error, entries };
}

describe('Q10 trigger: each trigger source maps to the UserCandidate validateUser gets', () => {
	test('PreSignUp_SignUp on the default (username + email alias) pool', () => {
		const c = candidateFromTrigger(
			{},
			parsed(cognitoEvent('PreSignUp_SignUp', 'alice', { email: 'alice@example.com' })),
		);
		assert.deepStrictEqual(c, {
			provider: 'password',
			subject: '',
			email: 'alice@example.com',
			username: 'alice',
			phase: 'signUp',
			claims: { email: 'alice@example.com' },
		});
	});

	test("PreSignUp_SignUp on an email-only pool: Cognito's userName is a UUID; the login is the email", () => {
		const opts: AuthOptions = { users: { signInWith: ['email'] } };
		const uuid = '0d6e9c36-7f9e-4e1c-9bd0-9a8f2b3c4d5e';
		const c = candidateFromTrigger(
			opts,
			parsed(cognitoEvent('PreSignUp_SignUp', uuid, { email: 'bob@example.com' })),
		);
		assert.strictEqual(c.username, 'bob@example.com');
		assert.strictEqual(c.email, 'bob@example.com');
		assert.strictEqual(c.provider, 'password');
	});

	test('PreSignUp_AdminCreateUser maps like a password sign-up', () => {
		const c = candidateFromTrigger(
			{},
			parsed(
				cognitoEvent('PreSignUp_AdminCreateUser', 'carol', {
					email: 'carol@example.com',
					'custom:tenant': 't1',
				}),
			),
		);
		assert.deepStrictEqual(c, {
			provider: 'password',
			subject: '',
			email: 'carol@example.com',
			username: 'carol',
			phase: 'signUp',
			claims: { email: 'carol@example.com', 'custom:tenant': 't1' },
		});
	});

	test('PreSignUp_ExternalProvider: provider is the configured id behind the userName prefix', () => {
		const options: AuthOptions = {
			socialProviders: {
				google: { clientId: 'g', clientSecret: PROVIDER_SECRET },
				apple: { clientId: 'a', teamId: 'TEAM123456', keyId: 'KEY1234567', privateKey: PROVIDER_SECRET },
			},
			samlProviders: { corp: { metadataUrl: 'https://idp.example.com/metadata' } },
			oidcProviders: {
				okta: {
					issuer: 'https://dev-1.okta.com',
					clientId: '0oa1',
					clientSecret: PROVIDER_SECRET,
					federateVia: 'cognito',
				},
			},
		};
		const cases: [string, string][] = [
			['Google_1234567890', 'google'],
			['google_1234567890', 'google'],
			['SignInWithApple_000.abc', 'apple'],
			['corp_alice@corp.example.com', 'corp'],
			['okta_00u1', 'okta'],
			['Unknown_42', 'Unknown'],
		];
		for (const [userName, provider] of cases) {
			const c = candidateFromTrigger(
				options,
				parsed(
					cognitoEvent('PreSignUp_ExternalProvider', userName, { email: 'dave@example.com', name: 'Dave' }),
				),
			);
			assert.deepStrictEqual(
				c,
				{
					provider,
					subject: '',
					email: 'dave@example.com',
					username: userName,
					phase: 'signUp',
					claims: { email: 'dave@example.com', name: 'Dave' },
				},
				userName,
			);
		}
	});

	test('the in-process password candidate is built by the same function', () => {
		const mode = resolveSignInMode(['email']);
		assert.deepStrictEqual(passwordSignUpCandidate(mode, 'erin@example.com', {}), {
			provider: 'password',
			subject: '',
			email: 'erin@example.com',
			username: 'erin@example.com',
			phase: 'signUp',
			claims: { email: 'erin@example.com' },
		});
		// An attribute the caller set wins over the login (as in Cognito and the local pool).
		assert.strictEqual(passwordSignUpCandidate(resolveSignInMode(undefined), 'erin', {}).email, null);
	});

	test('only PreSignUp events parse; anything else is not one', () => {
		assert.strictEqual(parsePreSignUpEvent(cognitoEvent('PostConfirmation_ConfirmSignUp', 'a', {})), null);
		assert.strictEqual(parsePreSignUpEvent(cognitoEvent('PreSignUp_SignUp', '', {})), null);
		assert.strictEqual(parsePreSignUpEvent({ triggerSource: 'PreSignUp_SignUp' }), null);
		assert.strictEqual(parsePreSignUpEvent(null), null);
	});
});

describe('Q10 trigger: accept / reject', () => {
	test('accepts by resolving, never touches the event (no auto-confirm, no auto-verify)', async () => {
		const event = cognitoEvent('PreSignUp_SignUp', 'alice', { email: 'alice@example.com' });
		const before = structuredClone(event);
		const { seen, error } = await runTrigger(event);
		assert.strictEqual(error, undefined);
		assert.strictEqual(seen.length, 1);
		assert.deepStrictEqual(event, before);
		assert.deepStrictEqual(event.response, {
			autoConfirmUser: false,
			autoVerifyEmail: false,
			autoVerifyPhone: false,
		});
	});

	test('a rejection throws an encoded, canonical ApiError: the client decodes the same name, status, message', async () => {
		const reject = new ApiError('Corporate accounts only', 403, { name: AuthErrors.NotAuthorized });
		const event = cognitoEvent('PreSignUp_SignUp', 'mallory', { email: 'mallory@gmail.com' });
		const before = structuredClone(event);
		const { error } = await runTrigger(event, { reject });
		assert.ok(error instanceof Error);
		assert.notStrictEqual(error.constructor, ApiError, 'a plain Error: Cognito reads only the message');
		assert.deepStrictEqual(Object.keys(error), [], 'nothing enumerable rides along');
		// Cognito wraps it: `PreSignUp failed with error <message>.`
		const decoded = decodeTriggerRejection(`PreSignUp failed with error ${error.message}.`);
		assert.ok(decoded);
		assert.strictEqual(decoded.name, AuthErrors.NotAuthorized);
		assert.strictEqual(decoded.status, 403);
		assert.strictEqual(decoded.message, 'Corporate accounts only');
		assert.deepStrictEqual(event, before, 'a rejection does not touch the event either');
	});

	test('a thrown non-ApiError is masked exactly as in-process: InternalError, generic message', async () => {
		const { error, entries } = await runTrigger(cognitoEvent('PreSignUp_SignUp', 'a', {}), {
			reject: new TypeError("Cannot read properties of undefined (reading 'endsWith')"),
		});
		assert.ok(error instanceof Error);
		const decoded = decodeTriggerRejection(error.message);
		assert.ok(decoded);
		assert.strictEqual(decoded.name, AuthErrors.InternalError);
		assert.strictEqual(decoded.message, INTERNAL_ERROR_MESSAGE);
		assert.ok(!error.message.includes('endsWith'));
		assert.ok(
			entries.some((e) => e.level === 'error' && JSON.stringify(e).includes('endsWith')),
			'logged server-side',
		);
	});

	test('a developer message naming an ARN or account id is withheld, as in-process', async () => {
		const reject = new ApiError('denied for arn:aws:iam::123456789012:role/x', 403, {
			name: AuthErrors.NotAuthorized,
		});
		const { error } = await runTrigger(cognitoEvent('PreSignUp_SignUp', 'a', {}), { reject });
		assert.ok(error instanceof Error);
		const decoded = decodeTriggerRejection(error.message);
		assert.strictEqual(decoded?.message, WITHHELD_MESSAGE);
		assert.strictEqual(decoded?.name, AuthErrors.NotAuthorized);
	});

	test('ExternalProvider: validateUser runs (phase signUp) and can reject a federated first sign-in', async () => {
		const reject = new ApiError('Corporate accounts only', 403, { name: AuthErrors.NotAuthorized });
		const { seen, error } = await runTrigger(
			cognitoEvent('PreSignUp_ExternalProvider', 'Google_1', { email: 'x@gmail.com' }),
			{ reject, socialProviders: { google: { clientId: 'g', clientSecret: PROVIDER_SECRET } } },
		);
		assert.strictEqual(seen[0]?.provider, 'google');
		assert.strictEqual(seen[0]?.phase, 'signUp');
		assert.strictEqual(
			decodeTriggerRejection(error instanceof Error ? error.message : '')?.name,
			AuthErrors.NotAuthorized,
		);
	});

	test('an event it does not handle is rejected (fail closed), with no validateUser call', async () => {
		const { seen, error } = await runTrigger(cognitoEvent('PostConfirmation_ConfirmSignUp', 'a', {}));
		assert.strictEqual(seen.length, 0);
		assert.ok(error instanceof Error);
		assert.strictEqual(decodeTriggerRejection(error.message)?.name, AuthErrors.InternalError);
	});

	test('without validateUser the trigger accepts', async () => {
		const { logger } = captureLogger();
		await handlePreSignUpTrigger(cognitoEvent('PreSignUp_SignUp', 'a', {}), {
			options: {},
			fullId: FULL_ID,
			sessionSecret: async () => SECRET,
			log: logger,
		});
	});
});

describe('Q10 trigger: the "validated in-process" marker makes the check run once', () => {
	const signUp = (meta?: Record<string, string>, userName = 'alice') =>
		cognitoEvent('PreSignUp_SignUp', userName, { email: 'alice@example.com' }, meta);

	test('a valid marker skips validateUser', async () => {
		const marker = signValidatedMarker(SECRET, FULL_ID, 'alice');
		const { seen, error } = await runTrigger(signUp({ [VALIDATED_MARKER_KEY]: marker }));
		assert.strictEqual(error, undefined);
		assert.strictEqual(seen.length, 0);
	});

	test('it also skips for an admin-created user and for an email-only pool (UUID userName)', async () => {
		const admin = cognitoEvent(
			'PreSignUp_AdminCreateUser',
			'bob',
			{},
			{
				[VALIDATED_MARKER_KEY]: signValidatedMarker(SECRET, FULL_ID, 'bob'),
			},
		);
		assert.strictEqual((await runTrigger(admin)).seen.length, 0);
		const emailOnly = cognitoEvent(
			'PreSignUp_SignUp',
			'7c1f0a7e-uuid',
			{ email: 'Bob@Example.com' },
			{
				[VALIDATED_MARKER_KEY]: signValidatedMarker(SECRET, FULL_ID, 'bob@example.com'),
			},
		);
		assert.strictEqual((await runTrigger(emailOnly, { users: { signInWith: ['email'] } })).seen.length, 0);
	});

	test('a marker that does not verify means the trigger validates (and can reject)', async () => {
		const reject = new ApiError('no', 403, { name: AuthErrors.NotAuthorized });
		const now = Date.now();
		const bad: Record<string, string> = {
			'signed with another secret': signValidatedMarker('another-secret', FULL_ID, 'alice'),
			'for another block': signValidatedMarker(SECRET, 'app-other', 'alice'),
			'for another user': signValidatedMarker(SECRET, FULL_ID, 'eve'),
			expired: signValidatedMarker(SECRET, FULL_ID, 'alice', now - 10 * 60 * 1000),
			'from the far future': signValidatedMarker(SECRET, FULL_ID, 'alice', now + 60 * 60 * 1000),
			tampered: `${signValidatedMarker(SECRET, FULL_ID, 'alice').slice(0, -2)}xx`,
			garbage: 'v1.not.a.marker',
		};
		for (const [why, marker] of Object.entries(bad)) {
			const { seen, error } = await runTrigger(signUp({ [VALIDATED_MARKER_KEY]: marker }), { reject });
			assert.strictEqual(seen.length, 1, why);
			assert.ok(error instanceof Error, why);
		}
	});

	test('the marker never applies to a federated first sign-in', () => {
		const event = parsed(
			cognitoEvent(
				'PreSignUp_ExternalProvider',
				'alice',
				{},
				{
					[VALIDATED_MARKER_KEY]: signValidatedMarker(SECRET, FULL_ID, 'alice'),
				},
			),
		);
		assert.strictEqual(
			verifyValidatedMarker(event.clientMetadata[VALIDATED_MARKER_KEY], SECRET, FULL_ID, event),
			false,
		);
	});

	test('an unreadable session secret means the trigger validates (never skips)', async () => {
		const seen: UserCandidate[] = [];
		const { logger } = captureLogger();
		await handlePreSignUpTrigger(
			signUp({ [VALIDATED_MARKER_KEY]: signValidatedMarker(SECRET, FULL_ID, 'alice') }),
			{
				options: { validateUser: async (c) => void seen.push(c) },
				fullId: FULL_ID,
				sessionSecret: async () => {
					throw new Error('ssm down');
				},
				log: logger,
			},
		);
		assert.strictEqual(seen.length, 1);
	});
});

describe('R2-5: the marker is keyed by an HKDF-derived key, never the raw session secret', () => {
	const event = () => parsed(cognitoEvent('PreSignUp_SignUp', 'alice', { email: 'alice@example.com' }));
	const exp = Date.now() + 60_000;
	const message = (login: string) => `bb-auth/pre-sign-up/v1\n${FULL_ID}\n${login}\n${exp}`;
	const marker = (signature: string) =>
		`v1.${exp}.${Buffer.from('alice', 'utf8').toString('base64url')}.${signature}`;

	test('the signature is HMAC-SHA256 under HKDF(secret, info = the marker label)', () => {
		const key = crypto.hkdfSync('sha256', Buffer.from(SECRET, 'utf8'), Buffer.alloc(0), MARKER_KEY_INFO, 32);
		const expected = crypto.createHmac('sha256', Buffer.from(key)).update(message('alice')).digest('base64url');
		assert.strictEqual(signValidatedMarker(SECRET, FULL_ID, 'alice', exp - 5 * 60 * 1000), marker(expected));
		assert.strictEqual(verifyValidatedMarker(marker(expected), SECRET, FULL_ID, event()), true);
	});

	test('a marker HMAC-ed with the raw session secret (the pre-R2-5 scheme) does not verify', () => {
		const raw = crypto.createHmac('sha256', SECRET).update(message('alice')).digest('base64url');
		assert.strictEqual(verifyValidatedMarker(marker(raw), SECRET, FULL_ID, event()), false);
	});

	test('the label is its own: no other bb-auth key derivation uses it', () => {
		assert.match(MARKER_KEY_INFO, /pre-sign-up/);
		assert.notStrictEqual(MARKER_KEY_INFO, 'aws-blocks/bb-auth pending-auth v1');
		assert.notStrictEqual(MARKER_KEY_INFO, 'aws-blocks/bb-auth relay-state v1');
		assert.ok(!MARKER_KEY_INFO.startsWith('auth-cognito.autoSignIn'));
	});
});

describe('Q10 trigger: rejection encoding', () => {
	test("round-trips name, status, message and retriable through Cognito's wrapping and URL encoding", () => {
		const original = new ApiError('Nope — not on the list. (Ask an admin.)', 429, {
			name: AuthErrors.TooManyRequests,
			retriable: true,
		});
		const message = encodeTriggerRejection(original);
		const viaQuery = new URLSearchParams(
			`error_description=${encodeURIComponent(`PreSignUp failed with error ${message}. `)}&error=invalid_request`,
		).get('error_description');
		for (const text of [`PreSignUp failed with error ${message}.`, viaQuery]) {
			const decoded = decodeTriggerRejection(text);
			assert.ok(decoded);
			assert.deepStrictEqual(
				{ name: decoded.name, status: decoded.status, message: decoded.message, retriable: decoded.retriable },
				{ name: original.name, status: 429, message: original.message, retriable: true },
			);
		}
	});

	test('anything malformed decodes to null (the ordinary mapping applies)', () => {
		const enc = (v: unknown) => `bb-auth-rejection:${Buffer.from(JSON.stringify(v)).toString('base64url')}`;
		for (const text of [
			undefined,
			'',
			'PreSignUp failed with error Email domain not allowed.',
			'bb-auth-rejection:!!!',
			enc({ n: 'Bad Name', s: 403, m: 'x' }),
			enc({ n: 'NotAuthorizedException', s: 200, m: 'x' }),
			enc({ n: 'NotAuthorizedException', s: 403 }),
			enc('a string'),
		]) {
			assert.strictEqual(decodeTriggerRejection(text), null, String(text));
		}
	});

	test('the error policy turns an encoded UserLambdaValidationException into the canonical error', () => {
		const { logger } = captureLogger();
		const fromCognito = new Error(
			`PreSignUp failed with error ${encodeTriggerRejection(new ApiError('Corporate accounts only', 403, { name: AuthErrors.NotAuthorized }))}.`,
		);
		fromCognito.name = AuthErrors.UserLambdaValidation;
		Object.assign(fromCognito, { $metadata: { requestId: 'r-1' } });
		const mapped = toAuthApiError(fromCognito, logger);
		assert.strictEqual(mapped.name, AuthErrors.NotAuthorized);
		assert.strictEqual(mapped.status, 403);
		assert.strictEqual(mapped.message, 'Corporate accounts only');
		assert.ok(!JSON.stringify(mapped).includes('$metadata'));
		// An ordinary (foreign) PreSignUp message gets the name's fixed message
		// (FX59, #678); before FX59 it passed through unchanged.
		const foreign = new Error('PreSignUp failed with error Email domain not allowed.');
		foreign.name = AuthErrors.UserLambdaValidation;
		assert.strictEqual(toAuthApiError(foreign, logger).message, clientMessageFor(AuthErrors.UserLambdaValidation));
	});
});

describe('Q10 × FX3: trigger decoding and account-state masking coexist in the error policy', () => {
	const encoded = () => {
		const e = new Error(
			`PreSignUp failed with error ${encodeTriggerRejection(new ApiError('Corporate accounts only', 403, { name: AuthErrors.NotAuthorized }))}.`,
		);
		e.name = AuthErrors.UserLambdaValidation;
		return e;
	};
	const sdk = (name: string, message: string) => Object.assign(new Error(message), { name });

	test('with hideAccountState on, a decoded validateUser rejection keeps its name and message', () => {
		const { logger } = captureLogger();
		const mapped = toAuthApiError(encoded(), logger, undefined, { hideAccountState: true });
		assert.deepStrictEqual(
			{ name: mapped.name, status: mapped.status, message: mapped.message },
			{ name: AuthErrors.NotAuthorized, status: 403, message: 'Corporate accounts only' },
		);
	});

	test('…and the confirm-code masking still turns an account-state answer into the wrong-code error', () => {
		const { logger } = captureLogger();
		for (const name of [AuthErrors.NotAuthorized, AuthErrors.ExpiredCode, AuthErrors.UserNotFound]) {
			const mapped = toAuthApiError(sdk(name, 'User is disabled.'), logger, 'confirmCode', {
				hideAccountState: true,
			});
			assert.strictEqual(mapped.name, AuthErrors.CodeMismatch, name);
		}
		// Off (revealExistingUsers): the account-state answer is reported as is.
		const revealed = toAuthApiError(
			sdk(AuthErrors.NotAuthorized, 'User cannot be confirmed.'),
			logger,
			'confirmCode',
			{
				hideAccountState: false,
			},
		);
		assert.strictEqual(revealed.name, AuthErrors.NotAuthorized);
	});
});
