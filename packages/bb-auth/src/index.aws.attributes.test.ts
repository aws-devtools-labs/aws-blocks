// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * AWS runtime — the user-attribute rules the Cognito engine checks **before**
 * the SDK call (FX43, R78), against a spied Cognito client (no network).
 *
 * An untyped client (JSON-RPC, a native app) can send any JSON as an attribute
 * value. The AWS JS SDK does not validate input: it serializes a number, an
 * object, an array or a boolean `Value` as-is (and drops a `null` one), so the
 * call reaches Cognito, whose JSON protocol answers a wrong-typed member with
 * `SerializationException` — outside the `AuthErrors` vocabulary, so a client
 * saw 500 `InternalErrorException` where the local engine answers 400
 * `InvalidParameterException` (FX39, R74). The engine now applies the rules
 * that need no pool schema itself (`engines/attribute-write-rules.ts`, shared
 * with the local engine): the value is a string of at most 2,048 characters,
 * `sub` is never written, and the `*_verified` flags are not client-writable.
 * Every such rejection is asserted to send **no** Cognito command.
 *
 * The rules that need the deployed schema (an unknown name, an undeclared
 * `custom:` attribute, an immutable attribute) stay Cognito's: those writes
 * still reach it, and its `InvalidParameterException` reaches the client as
 * the canonical 400.
 *
 * Harness: `test-support/aws-harness.ts`.
 */

import assert from 'node:assert';
import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { AuthErrors, type SignInNextStep, type SignInResult } from './index.aws.js';
import { Browser, cognitoError, makeAwsAuth, signInAs, wireView } from './test-support/aws-harness.js';

beforeEach(() => rmSync('.bb-data', { recursive: true, force: true }));
afterEach(() => rmSync('.bb-data', { recursive: true, force: true }));

const PASSWORD = 'Passw0rd!';
const OPTIONS = { users: { attributes: [{ name: 'team' }] }, admin: {} } as const;

const INVALID = { name: AuthErrors.InvalidParameter, code: 400, retriable: true } as const;
const UNAUTHORIZED = { name: AuthErrors.NotAuthorized, code: 401, retriable: false } as const;

/** The non-string values an untyped client can send. */
const NON_STRING_VALUES: readonly [label: string, value: unknown][] = [
	['a number', 42],
	['an object', { first: 'Ada' }],
	['null', null],
	['an array', ['Ada']],
	['a boolean', true],
];

/**
 * Call `target[method](...args)` without its static types — what an untyped
 * client can send: any attribute name, any JSON value.
 */
function untyped(target: object, method: string, ...args: unknown[]): Promise<unknown> {
	const fn: unknown = Reflect.get(target, method);
	assert.ok(typeof fn === 'function', method);
	return Promise.resolve(Reflect.apply(fn, target, args));
}

/** `ok`, or the rejection's wire fields (minus the message). */
async function outcome(p: Promise<unknown>): Promise<'ok' | { name: unknown; code: unknown; retriable: unknown }> {
	try {
		await p;
		return 'ok';
	} catch (e) {
		const { name, code, retriable } = wireView(e);
		return { name, code, retriable };
	}
}

function nextStepOf(r: SignInResult): SignInNextStep {
	assert.strictEqual(r.status, 'continueSignIn');
	if (r.status !== 'continueSignIn') throw new Error('unreachable');
	return r.nextStep;
}

/**
 * What Cognito's JSON protocol does with a wrong-typed `Value`: answer
 * `SerializationException` (the SDK sends it as-is). Without the engine's
 * check, this is what a non-string value met — and the client saw a 500.
 */
function serializationFailure(): never {
	throw cognitoError('SerializationException', 'class java.lang.Integer can not be converted to an String');
}

/** The four writes that carry user attributes, each run from a fresh harness. */
const WRITES = {
	async signUp(attributes: Record<string, unknown>) {
		const h = makeAwsAuth(OPTIONS);
		h.on('SignUpCommand', serializationFailure);
		const result = await outcome(untyped(h.auth, 'signUp', 'bob', PASSWORD, { attributes }));
		return { result, sent: h.sentNames() };
	},
	async updateUserAttributes(attributes: Record<string, unknown>) {
		const h = makeAwsAuth(OPTIONS);
		const browser = new Browser();
		await signInAs(h, browser, 'alice');
		h.on('UpdateUserAttributesCommand', serializationFailure);
		const result = await outcome(
			browser.request((ctx) => untyped(h.auth, 'updateUserAttributes', ctx, attributes)),
		);
		return { result, sent: h.sentNames() };
	},
	async adminCreateUser(attributes: Record<string, unknown>) {
		const h = makeAwsAuth(OPTIONS);
		h.on('AdminCreateUserCommand', serializationFailure);
		const result = await outcome(untyped(h.auth.admin, 'createUser', 'bob', { attributes }));
		return { result, sent: h.sentNames() };
	},
	async newPasswordChallenge(attributes: Record<string, unknown>) {
		const h = makeAwsAuth(OPTIONS);
		const browser = new Browser();
		h.on('InitiateAuthCommand', () => ({
			ChallengeName: 'NEW_PASSWORD_REQUIRED',
			Session: 'cog-npr',
			ChallengeParameters: { requiredAttributes: '[]' },
		}));
		const step = nextStepOf(await browser.request((ctx) => h.auth.signIn('carol', 'Temp!1234', ctx)));
		assert.ok(step.name === 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED');
		h.sent.length = 0;
		h.on('RespondToAuthChallengeCommand', serializationFailure);
		const result = await outcome(
			browser.request((ctx) =>
				untyped(h.auth, 'confirmSignIn', step.session, 'New!pass1', ctx, { userAttributes: attributes }),
			),
		);
		return { result, sent: h.sentNames() };
	},
} as const;

/** The Cognito command each write would send. */
const COMMAND: Record<keyof typeof WRITES, string> = {
	signUp: 'SignUpCommand',
	updateUserAttributes: 'UpdateUserAttributesCommand',
	adminCreateUser: 'AdminCreateUserCommand',
	newPasswordChallenge: 'RespondToAuthChallengeCommand',
};

const WRITE_NAMES = Object.keys(WRITES) as (keyof typeof WRITES)[];

describe('AWS: a non-string attribute value is 400 InvalidParameterException, and no SDK call is made', () => {
	for (const write of WRITE_NAMES) {
		for (const [label, value] of NON_STRING_VALUES) {
			test(`${write}: ${label}`, async () => {
				const { result, sent } = await WRITES[write]({ name: value });
				assert.deepStrictEqual(result, INVALID);
				assert.deepStrictEqual(sent, [], `no ${COMMAND[write]}`);
			});
		}
		test(`${write}: on a declared custom attribute too`, async () => {
			const { result, sent } = await WRITES[write]({ team: 7 });
			assert.deepStrictEqual(result, INVALID);
			assert.deepStrictEqual(sent, []);
		});
	}
});

describe('AWS: the other schema-independent rules are checked before the SDK call', () => {
	for (const write of WRITE_NAMES) {
		test(`${write}: a 2,049-character value is 400 InvalidParameterException`, async () => {
			const { result, sent } = await WRITES[write]({ name: 'x'.repeat(2049) });
			assert.deepStrictEqual(result, INVALID);
			assert.deepStrictEqual(sent, []);
		});
		test(`${write}: \`sub\` is 400 InvalidParameterException`, async () => {
			const { result, sent } = await WRITES[write]({ sub: 'mine' });
			assert.deepStrictEqual(result, INVALID);
			assert.deepStrictEqual(sent, []);
		});
	}
	for (const write of ['signUp', 'updateUserAttributes', 'newPasswordChallenge'] as const) {
		test(`${write}: \`email_verified\` / \`phone_number_verified\` are 401 NotAuthorizedException (not client-writable)`, async () => {
			for (const flag of ['email_verified', 'phone_number_verified']) {
				const { result, sent } = await WRITES[write]({ [flag]: 'true' });
				assert.deepStrictEqual(result, UNAUTHORIZED, flag);
				assert.deepStrictEqual(sent, [], flag);
			}
		});
	}

	test('signUp: a rejected value anywhere in the write sends nothing, valid attributes before it included', async () => {
		const { result, sent } = await WRITES.signUp({ email: 'bob@example.com', name: 'Bob', team: { x: 1 } });
		assert.deepStrictEqual(result, INVALID);
		assert.deepStrictEqual(sent, []);
	});
});

describe('AWS: what the engine leaves to Cognito', () => {
	test('a 2,048-character string value is sent', async () => {
		const h = makeAwsAuth(OPTIONS);
		h.on('SignUpCommand', () => ({ UserConfirmed: false, UserSub: 'sub-bob' }));
		await h.auth.signUp('bob', PASSWORD, { attributes: { name: 'x'.repeat(2048) } });
		assert.deepStrictEqual(h.sentNames(), ['SignUpCommand']);
	});

	test('admin.createUser may mark a contact verified (IAM-authorized): the flag is sent', async () => {
		const h = makeAwsAuth(OPTIONS);
		h.on('AdminCreateUserCommand', (input) => ({
			User: { Username: String(input.Username), Enabled: true, Attributes: [] },
		}));
		await h.auth.admin.createUser('bob', { attributes: { email: 'bob@example.com', email_verified: 'true' } });
		assert.deepStrictEqual(h.sent[0]?.input.UserAttributes, [
			{ Name: 'email', Value: 'bob@example.com' },
			{ Name: 'email_verified', Value: 'true' },
		]);
	});

	for (const [label, attributes] of [
		['an unknown name', { nickname_: 'b' }],
		['an undeclared `custom:` attribute', { 'custom:dept': 'x' }],
	] as const) {
		test(`${label} reaches Cognito, whose InvalidParameterException is the canonical 400`, async () => {
			const h = makeAwsAuth(OPTIONS);
			h.on('SignUpCommand', () => {
				throw cognitoError('InvalidParameterException', 'Attributes did not conform to the schema');
			});
			const result = await outcome(untyped(h.auth, 'signUp', 'bob', PASSWORD, { attributes }));
			assert.deepStrictEqual(result, INVALID);
			assert.deepStrictEqual(h.sentNames(), ['SignUpCommand']);
		});
	}

	test('an immutable attribute on update reaches Cognito, whose InvalidParameterException is the canonical 400', async () => {
		const h = makeAwsAuth({ users: { attributes: [{ name: 'tier', mutable: false }] } });
		const browser = new Browser();
		await signInAs(h, browser, 'alice');
		h.on('UpdateUserAttributesCommand', () => {
			throw cognitoError('InvalidParameterException', 'Attribute cannot be updated.');
		});
		const result = await outcome(browser.request((ctx) => h.auth.updateUserAttributes(ctx, { tier: 'gold' })));
		assert.deepStrictEqual(result, INVALID);
		assert.deepStrictEqual(h.sentNames(), ['UpdateUserAttributesCommand']);
	});
});
