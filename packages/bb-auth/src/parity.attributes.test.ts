// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Mock ↔ AWS parity for **which user attributes a write may carry** (FX39,
 * R74; from R65 (c)): the same writes go through the same `Auth` API on the
 * local engine (`./index.mock.js`) and on the AWS entry (`./index.aws.js`,
 * offline through `test-support/aws-harness.ts`), and what a caller observes —
 * success, or the error `name` / HTTP status / `retriable` — must agree.
 *
 * On the AWS side the harness answers as {@link cognitoSchema}, a stand-in for
 * the pool's attribute schema that implements exactly the documented rules
 * (quotes and URLs on each). Before FX39 the mock accepted every one of these
 * writes: it stored an attribute named `attributes` holding an object (what a
 * Kotlin client sent before FX32) and returned it from `getUserAttributes`.
 *
 * `AdminUpdateUserAttributes` is not covered: `auth.admin` has no attribute
 * update.
 */

import assert from 'node:assert';
import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, test } from 'node:test';
import type { AuthActionInput, AuthStateApi } from '@aws-blocks/auth-common';
import type { BlocksContext, ScopeParent } from '@aws-blocks/core';
import { clientMessageFor } from './error-mapping.js';
import { AuthErrors } from './errors.js';
import { Auth as MockAuth } from './index.mock.js';
import {
	type AwsAuthHarness,
	Browser,
	cognitoError,
	makeAwsAuth,
	signInAs,
	wireView,
} from './test-support/aws-harness.js';
import type { AuthOptions, CodeDeliveryPurpose } from './types.js';

beforeEach(() => rmSync('.bb-data', { recursive: true, force: true }));
afterEach(() => rmSync('.bb-data', { recursive: true, force: true }));

const PASSWORD = 'Passw0rd!';
let n = 0;
const root = (): ScopeParent => ({ id: `parityattr${process.pid}x${++n}` });

/** A pool with one mutable and one immutable custom attribute, and the admin surface. */
const OPTIONS = {
	users: { attributes: [{ name: 'team' }, { name: 'tier', mutable: false }] },
	admin: {},
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Cognito, as documented
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A stand-in for the attribute schema of the pool `Auth` provisions for
 * {@link OPTIONS}, answering `SignUp`, `UpdateUserAttributes` and
 * `AdminCreateUser`. Rules ("the guide" is the Cognito developer guide,
 * <https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-settings-attributes.html>):
 *
 * - Standard attributes (the guide, "Standard attributes"): `name`,
 *   `family_name`, … `email`, `phone_number`, `sub`. Custom attributes "require
 *   the `custom:` prefix"; the pool has exactly the declared ones
 *   (`mapCustomAttributes`). Anything else does not conform to the schema
 *   (`InvalidParameterException`).
 * - "you must pass the value as a string … A native number or boolean is
 *   rejected before the value is stored; depending on your SDK, this surfaces
 *   as a client-side type-validation error or a service
 *   `InvalidParameterException`." (the guide, "Custom attributes")
 * - `AttributeType.Value`: "Maximum length of 2048."
 *   (<https://docs.aws.amazon.com/cognito-user-identity-pools/latest/APIReference/API_AttributeType.html>)
 * - "If your app tries to set a value for an attribute that it isn't
 *   authorized to write, Amazon Cognito returns `NotAuthorizedException`."
 *   (the guide, "Attribute permissions and scopes"). The app client sets
 *   no `WriteAttributes`: "your app can write the values of the Standard
 *   attributes of your user pool", while reads by default cover "`email_verified`,
 *   `phone_number_verified`, and the standard attributes"
 *   (<https://docs.aws.amazon.com/cognito-user-identity-pools/latest/APIReference/API_CreateUserPoolClient.html>),
 *   so the verified flags are not client-writable. `AdminCreateUser` is
 *   IAM-authorized, and an administrator may mark a contact verified
 *   (the guide, "email").
 * - "You can only write a value to an immutable attribute when you create a
 *   user." (the guide, "Custom attributes"); `sub` "has a fixed value".
 *
 * **A wrong-typed value, on the wire** (FX43, R78). The AWS JS SDK validates
 * nothing: it serializes a number, boolean, object or array `Value` as-is and
 * drops a `null` one. Which answer Cognito then gives is not documented for
 * the JS SDK ("depending on your SDK … a client-side type-validation error or
 * a service `InvalidParameterException`", above), so the stand-in takes the
 * answers that differ from the local engine's: a wrong-typed `Value` is the
 * JSON protocol's `SerializationException` (outside the `AuthErrors`
 * vocabulary, so a client would see a 500), and an absent one is accepted.
 * Parity on those cases therefore holds only because the Cognito engine
 * checks them before the SDK call (`engines/attribute-write-rules.ts`), as
 * `index.aws.attributes.test.ts` asserts; the stand-in is the red.
 *
 * **Precedence** (FX44, R79). Cognito documents no order between these rules,
 * so the stand-in answers in the order both engines use
 * (`engines/attribute-write-rules.ts`): an admin-only pool refuses `SignUp`
 * before anything else ("If you do not enable self-registration, new users
 * must be created by administrative API actions"); then, over the whole
 * write, the wire shape (every `Value` a string), the `AttributeType` length
 * constraint, the app client's write permissions, and last the pool schema
 * (unknown name, `sub`, immutable). Pass `selfSignUp: false` for a pool that
 * `Auth` provisions with `emailPassword: { selfSignUp: false }`.
 */
function cognitoSchema(h: Pick<AwsAuthHarness<AuthOptions>, 'on' | 'idp'>, pool: { selfSignUp?: boolean } = {}) {
	const standard = new Set([
		...['name', 'family_name', 'given_name', 'middle_name', 'nickname', 'preferred_username', 'profile'],
		...['picture', 'website', 'gender', 'birthdate', 'zoneinfo', 'locale', 'updated_at', 'address'],
		...['email', 'phone_number', 'sub'],
	]);
	const verifiedFlags = new Set(['email_verified', 'phone_number_verified']);
	const custom = new Map([
		['custom:team', { mutable: true }],
		['custom:tier', { mutable: false }],
	]);
	const validate = (list: unknown, write: 'create' | 'adminCreate' | 'update') => {
		const entries = (Array.isArray(list) ? list : []).map((entry: unknown) => ({
			key: String(Reflect.get(Object(entry), 'Name')),
			value: Reflect.get(Object(entry), 'Value'),
		}));
		// 1. The wire shape: a wrong-typed `Value` fails deserialization (see above);
		// an absent one is not a value at all.
		for (const { value } of entries) {
			if (value !== null && value !== undefined && typeof value !== 'string') {
				throw cognitoError(
					'SerializationException',
					'class java.lang.Integer can not be converted to an String',
				);
			}
		}
		// 2. The `AttributeType.Value` length constraint.
		for (const { value } of entries) {
			if (typeof value === 'string' && value.length > 2048) {
				throw cognitoError('InvalidParameterException', 'Value is too long');
			}
		}
		// 3. The app client's write permissions.
		for (const { key } of entries) {
			if (write !== 'adminCreate' && verifiedFlags.has(key)) {
				throw cognitoError('NotAuthorizedException', 'A client attempted to write unauthorized attribute');
			}
		}
		// 4. The pool schema.
		for (const { key } of entries) {
			if (!standard.has(key) && !verifiedFlags.has(key) && !custom.has(key)) {
				throw cognitoError(
					'InvalidParameterException',
					`Attributes did not conform to the schema: Type for attribute {${key}} could not be determined`,
				);
			}
			if (key === 'sub' || (write === 'update' && custom.get(key)?.mutable === false)) {
				throw cognitoError('InvalidParameterException', 'Attribute cannot be updated.');
			}
		}
	};
	h.on('SignUpCommand', (input) => {
		// `AllowAdminCreateUserOnly`: the operation itself is refused.
		if (pool.selfSignUp === false) {
			throw cognitoError('NotAuthorizedException', 'SignUp is not permitted for this user pool');
		}
		validate(input.UserAttributes, 'create');
		return {
			UserConfirmed: false,
			UserSub: 'sub-bob',
			CodeDeliveryDetails: { Destination: 'b***@e***', DeliveryMedium: 'EMAIL', AttributeName: 'email' },
		};
	});
	h.on('UpdateUserAttributesCommand', (input) => {
		validate(input.UserAttributes, 'update');
		return {};
	});
	h.on('AdminCreateUserCommand', (input) => {
		validate(input.UserAttributes, 'adminCreate');
		return { User: { Username: String(input.Username), Enabled: true, Attributes: [] } };
	});
	// The new-password answer: `userAttributes.<name>` members of the string map
	// `ChallengeResponses`, written to the existing user like `UpdateUserAttributes`.
	h.on('RespondToAuthChallengeCommand', (input) => {
		const responses: unknown = input.ChallengeResponses;
		const list = Object.entries(typeof responses === 'object' && responses !== null ? responses : {})
			.filter(([k]) => k.startsWith('userAttributes.'))
			.map(([k, v]) => ({ Name: k.slice('userAttributes.'.length), Value: v }));
		validate(list, 'update');
		return { AuthenticationResult: h.idp.authResult('carol') };
	});
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** What a client can observe of an outcome: `ok`, or the rejection's wire fields. */
async function outcome(
	p: Promise<unknown>,
): Promise<'ok' | { name: unknown; code: unknown; retriable: unknown; message: unknown }> {
	try {
		await p;
		return 'ok';
	} catch (e) {
		const { name, code, retriable, message } = wireView(e);
		return { name, code, retriable, message };
	}
}

/**
 * Call `target[method](...args)` without its static types — what an untyped
 * client (JSON-RPC, a native app) can send: any attribute name, any JSON value.
 */
function untyped(target: object, method: string, ...args: unknown[]): Promise<unknown> {
	const fn: unknown = Reflect.get(target, method);
	assert.ok(typeof fn === 'function', method);
	return Promise.resolve(Reflect.apply(fn, target, args));
}

/** A local `Auth` for {@link OPTIONS} with `alice` (email verified) signed in on `browser`. */
async function mockSignedIn() {
	const codes: { purpose: CodeDeliveryPurpose; code: string }[] = [];
	const auth = new MockAuth(root(), 'auth', {
		...OPTIONS,
		codeDelivery: async (_u: string, code: string, purpose: CodeDeliveryPurpose) => {
			codes.push({ purpose, code });
		},
	});
	await auth.signUp('alice', PASSWORD, { attributes: { email: 'alice@example.com', tier: 'gold' } });
	await auth.confirmSignUp('alice', [...codes].reverse().find((c) => c.purpose === 'signUp')?.code ?? '');
	const browser = new Browser();
	await browser.request((ctx) => auth.signIn('alice', PASSWORD, ctx));
	return { auth, browser };
}

/** The AWS `Auth` for {@link OPTIONS}, answering as {@link cognitoSchema}, with `alice` signed in on `browser`. */
async function awsSignedIn() {
	const h = makeAwsAuth(OPTIONS);
	const browser = new Browser();
	await signInAs(h, browser, 'alice');
	cognitoSchema(h);
	return { h, auth: h.auth, browser };
}

/** Bind `auth.createApi()` to one request, the way the RPC layer does. */
function bindAuthApi(api: AuthStateApi, ctx: BlocksContext): AuthStateApi {
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

const INVALID = {
	name: 'InvalidParameterException',
	code: 400,
	retriable: true,
	message: clientMessageFor(AuthErrors.InvalidParameter),
} as const;
const UNAUTHORIZED = {
	name: 'NotAuthorizedException',
	code: 401,
	retriable: false,
	message: clientMessageFor(AuthErrors.NotAuthorized),
} as const;

/** Writes both runtimes must answer the same way, with the expected answer. */
const CREATE_CASES: readonly [label: string, attributes: Record<string, unknown>, expected: unknown][] = [
	[
		'standard, declared custom (bare and prefixed) and immutable custom attributes',
		{ email: 'bob@example.com', name: 'Bob', team: 'ops', 'custom:tier': 'gold' },
		'ok',
	],
	[
		'an attribute the pool does not have (`attributes`, holding an object — R65 (c))',
		{ email: 'bob@example.com', attributes: { name: 'Bob' } },
		INVALID,
	],
	['an unknown name with a string value', { email: 'bob@example.com', nickname_: 'b' }, INVALID],
	['an undeclared `custom:` attribute', { email: 'bob@example.com', 'custom:dept': 'x' }, INVALID],
	['a non-string value on a standard attribute', { email: 'bob@example.com', name: 42 }, INVALID],
	['a non-string value on a custom attribute', { email: 'bob@example.com', team: true }, INVALID],
	['an object value on a standard attribute', { email: 'bob@example.com', name: { first: 'Bob' } }, INVALID],
	['an array value', { email: 'bob@example.com', name: ['Bob'] }, INVALID],
	['a null value', { email: 'bob@example.com', name: null }, INVALID],
	['a 2,049-character value', { email: 'bob@example.com', name: 'x'.repeat(2049) }, INVALID],
	['`sub`', { email: 'bob@example.com', sub: 'mine' }, INVALID],
];

describe('parity: attributes on signUp (SignUp)', () => {
	for (const [label, attributes, expected] of [
		...CREATE_CASES,
		['a 2,048-character value', { email: 'bob@example.com', name: 'x'.repeat(2048) }, 'ok'],
		['`email_verified` (not client-writable)', { email: 'bob@example.com', email_verified: 'true' }, UNAUTHORIZED],
		['`phone_number_verified`', { phone_number: '+15555550100', phone_number_verified: 'true' }, UNAUTHORIZED],
	] as const) {
		test(label, async () => {
			const mock = new MockAuth(root(), 'auth', OPTIONS);
			const aws = makeAwsAuth(OPTIONS);
			cognitoSchema(aws);
			const views = [
				await outcome(untyped(mock, 'signUp', 'bob', PASSWORD, { attributes })),
				await outcome(untyped(aws.auth, 'signUp', 'bob', PASSWORD, { attributes })),
			];
			assert.deepStrictEqual(views[0], expected, 'mock');
			assert.deepStrictEqual(views[1], expected, 'aws');
		});
	}

	test('createApi signUp with the attributes nested under `attributes` (the pre-FX32 Kotlin body) is rejected in both runtimes', async () => {
		const input = {
			action: 'signUp',
			username: 'bob',
			password: PASSWORD,
			attributes: { email: 'bob@example.com', name: 'Ada Lovelace' },
		};
		const mock = new MockAuth(root(), 'auth', OPTIONS);
		const aws = makeAwsAuth(OPTIONS);
		cognitoSchema(aws);
		const states = [];
		for (const api of [mock.createApi(), aws.auth.createApi()]) {
			const browser = new Browser();
			const state = await browser.request((ctx) => untyped(bindAuthApi(api, ctx), 'setAuthState', input));
			assert.ok(typeof state === 'object' && state !== null);
			states.push({
				state: Reflect.get(state, 'state'),
				errorName: Reflect.get(state, 'errorName'),
				retriable: Reflect.get(state, 'retriable'),
				error: Reflect.get(state, 'error'),
			});
		}
		// A retriable failure: the sign-up form stays, with the error overlaid.
		const expected = {
			state: 'signedOut',
			errorName: 'InvalidParameterException',
			retriable: true,
			error: clientMessageFor(AuthErrors.InvalidParameter),
		};
		assert.deepStrictEqual(states[0], expected, 'mock');
		assert.deepStrictEqual(states[1], expected, 'aws');
	});

	test('the accepted attributes read back from getUserAttributes, custom ones prefixed (mock)', async () => {
		const codes: string[] = [];
		const auth = new MockAuth(root(), 'auth', {
			...OPTIONS,
			codeDelivery: async (_u: string, code: string) => {
				codes.push(code);
			},
		});
		await auth.signUp('bob', PASSWORD, { attributes: { email: 'bob@example.com', name: 'Bob', team: 'ops' } });
		await auth.confirmSignUp('bob', codes.at(-1) ?? '');
		const browser = new Browser();
		await browser.request((ctx) => auth.signIn('bob', PASSWORD, ctx));
		const read = await browser.request((ctx) => auth.getUserAttributes(ctx));
		assert.deepStrictEqual(
			{ ...read, sub: 'SUB' },
			{ sub: 'SUB', email: 'bob@example.com', email_verified: 'true', name: 'Bob', 'custom:team': 'ops' },
		);
	});
});

describe('parity: attributes on updateUserAttributes (UpdateUserAttributes)', () => {
	for (const [label, attributes, expected] of [
		['a standard and a mutable custom attribute', { name: 'Alice', team: 'ops' }, 'ok'],
		['an attribute the pool does not have', { attributes: { name: 'Alice' } }, INVALID],
		['an undeclared `custom:` attribute', { 'custom:dept': 'x' }, INVALID],
		['a non-string value', { name: 7 }, INVALID],
		['an object value', { name: { first: 'Alice' } }, INVALID],
		['an array value', { team: ['ops'] }, INVALID],
		['a boolean value', { name: false }, INVALID],
		['a null value', { name: null }, INVALID],
		['a 2,049-character value', { name: 'x'.repeat(2049) }, INVALID],
		['an immutable custom attribute (`tier`)', { tier: 'platinum' }, INVALID],
		['`sub`', { sub: 'mine' }, INVALID],
		['`email_verified` (not client-writable)', { email_verified: 'true' }, UNAUTHORIZED],
	] as const) {
		test(label, async () => {
			const mock = await mockSignedIn();
			const aws = await awsSignedIn();
			const views = [
				await outcome(
					mock.browser.request((ctx) => untyped(mock.auth, 'updateUserAttributes', ctx, attributes)),
				),
				await outcome(aws.browser.request((ctx) => untyped(aws.auth, 'updateUserAttributes', ctx, attributes))),
			];
			assert.deepStrictEqual(views[0], expected, 'mock');
			assert.deepStrictEqual(views[1], expected, 'aws');
		});
	}

	test('a rejected update changes nothing (mock)', async () => {
		const mock = await mockSignedIn();
		const before = await mock.browser.request((ctx) => mock.auth.getUserAttributes(ctx));
		await outcome(
			mock.browser.request((ctx) =>
				untyped(mock.auth, 'updateUserAttributes', ctx, { name: 'Alice', 'custom:dept': 'x' }),
			),
		);
		assert.deepStrictEqual(await mock.browser.request((ctx) => mock.auth.getUserAttributes(ctx)), before);
	});
});

describe('parity: attributes on admin.createUser (AdminCreateUser)', () => {
	for (const [label, attributes, expected] of [
		...CREATE_CASES,
		[
			'`email_verified` (an administrator may mark a contact verified)',
			{ email: 'bob@example.com', email_verified: 'true' },
			'ok',
		],
	] as const) {
		test(label, async () => {
			const mock = new MockAuth(root(), 'auth', OPTIONS);
			const aws = makeAwsAuth(OPTIONS);
			cognitoSchema(aws);
			const views = [
				await outcome(untyped(mock.admin, 'createUser', 'bob', { attributes })),
				await outcome(untyped(aws.auth.admin, 'createUser', 'bob', { attributes })),
			];
			assert.deepStrictEqual(views[0], expected, 'mock');
			assert.deepStrictEqual(views[1], expected, 'aws');
		});
	}
});

describe('parity: userAttributes on the new-password challenge (RespondToAuthChallenge NEW_PASSWORD_REQUIRED)', () => {
	/** `carol`, created by an administrator, signed in with her temporary password: the new-password step. */
	async function mockAtNewPassword() {
		const auth = new MockAuth(root(), 'auth', OPTIONS);
		await auth.admin.createUser('carol', {
			temporaryPassword: 'Temp-Passw0rd!',
			attributes: { email: 'carol@example.com' },
		});
		const browser = new Browser();
		const r = await browser.request((ctx) => auth.signIn('carol', 'Temp-Passw0rd!', ctx));
		assert.ok(r.status === 'continueSignIn' && r.nextStep.name === 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED');
		return { auth, browser, session: r.nextStep.session };
	}
	/** The same step on the AWS entry, Cognito answering as {@link cognitoSchema}. */
	async function awsAtNewPassword() {
		const h = makeAwsAuth(OPTIONS);
		cognitoSchema(h);
		h.on('InitiateAuthCommand', () => ({
			ChallengeName: 'NEW_PASSWORD_REQUIRED',
			Session: 'cog-npr',
			ChallengeParameters: { requiredAttributes: '[]' },
		}));
		const browser = new Browser();
		const r = await browser.request((ctx) => h.auth.signIn('carol', 'Temp-Passw0rd!', ctx));
		assert.ok(r.status === 'continueSignIn' && r.nextStep.name === 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED');
		return { auth: h.auth, browser, session: r.nextStep.session };
	}

	for (const [label, userAttributes, expected] of [
		['a standard and a mutable custom attribute', { name: 'Carol', team: 'ops' }, 'ok'],
		['a non-string value', { name: 42 }, INVALID],
		['an object value', { name: { first: 'Carol' } }, INVALID],
		['an array value', { team: ['ops'] }, INVALID],
		['a null value', { name: null }, INVALID],
		['a 2,049-character value', { name: 'x'.repeat(2049) }, INVALID],
		['`sub`', { sub: 'mine' }, INVALID],
		['an undeclared `custom:` attribute', { 'custom:dept': 'x' }, INVALID],
		['an immutable custom attribute (`tier`)', { tier: 'platinum' }, INVALID],
		['`email_verified` (not client-writable)', { email_verified: 'true' }, UNAUTHORIZED],
	] as const) {
		test(label, async () => {
			const views = [];
			for (const at of [await mockAtNewPassword(), await awsAtNewPassword()]) {
				views.push(
					await outcome(
						at.browser.request((ctx) =>
							untyped(at.auth, 'confirmSignIn', at.session, 'Chosen-Passw0rd!', ctx, { userAttributes }),
						),
					),
				);
			}
			assert.deepStrictEqual(views[0], expected, 'mock');
			assert.deepStrictEqual(views[1], expected, 'aws');
		});
	}
});

/**
 * Several rules broken in one write (FX44, R79): both engines must name the
 * same error. The order (`engines/attribute-write-rules.ts`), over the whole
 * write: every value a string, every value within 2,048 characters, the app
 * client's write permissions (the verified flags), then the pool schema
 * (unknown name, undeclared `custom:`, `sub`, immutable). Each case is chosen
 * so that a per-attribute order, or another phase order, gives another
 * answer; most also come in both attribute orders.
 */
describe('parity: precedence when one write breaks several rules', () => {
	const SIGN_UP: readonly [label: string, attributes: Record<string, unknown>, expected: unknown][] = [
		[
			"an undeclared `custom:` attribute, then `email_verified` (FX43's example)",
			{ 'custom:undeclared': 'x', email_verified: 'true' },
			UNAUTHORIZED,
		],
		[
			'`email_verified`, then an undeclared `custom:` attribute',
			{ email_verified: 'true', 'custom:undeclared': 'x' },
			UNAUTHORIZED,
		],
		[
			'an unknown name, then `phone_number_verified`',
			{ nickname_: 'b', phone_number_verified: 'true' },
			UNAUTHORIZED,
		],
		['`sub`, then `email_verified`', { sub: 'mine', email_verified: 'true' }, UNAUTHORIZED],
		['`email_verified`, then a non-string value', { email_verified: 'true', name: 42 }, INVALID],
		['`email_verified`, then a 2,049-character value', { email_verified: 'true', name: 'x'.repeat(2049) }, INVALID],
		[
			'`email_verified`, then an unknown name holding an object',
			{ email_verified: 'true', attributes: { name: 'Bob' } },
			INVALID,
		],
		['an undeclared `custom:` attribute, then a non-string value', { 'custom:dept': 'x', name: 7 }, INVALID],
	];
	for (const [label, attributes, expected] of SIGN_UP) {
		test(`signUp: ${label}`, async () => {
			const mock = new MockAuth(root(), 'auth', OPTIONS);
			const aws = makeAwsAuth(OPTIONS);
			cognitoSchema(aws);
			const views = [
				await outcome(untyped(mock, 'signUp', 'bob', PASSWORD, { attributes })),
				await outcome(untyped(aws.auth, 'signUp', 'bob', PASSWORD, { attributes })),
			];
			assert.deepStrictEqual(views[0], expected, 'mock');
			assert.deepStrictEqual(views[1], expected, 'aws');
		});
	}

	const UPDATE: readonly [label: string, attributes: Record<string, unknown>, expected: unknown][] = [
		['an immutable attribute, then `email_verified`', { tier: 'platinum', email_verified: 'true' }, UNAUTHORIZED],
		[
			'an undeclared `custom:` attribute, then `email_verified`',
			{ 'custom:dept': 'x', email_verified: 'true' },
			UNAUTHORIZED,
		],
		['`email_verified`, then a non-string value', { email_verified: 'true', name: 7 }, INVALID],
		['`sub`, then an array value', { sub: 'mine', team: ['ops'] }, INVALID],
	];
	for (const [label, attributes, expected] of UPDATE) {
		test(`updateUserAttributes: ${label}`, async () => {
			const mock = await mockSignedIn();
			const aws = await awsSignedIn();
			const views = [
				await outcome(
					mock.browser.request((ctx) => untyped(mock.auth, 'updateUserAttributes', ctx, attributes)),
				),
				await outcome(aws.browser.request((ctx) => untyped(aws.auth, 'updateUserAttributes', ctx, attributes))),
			];
			assert.deepStrictEqual(views[0], expected, 'mock');
			assert.deepStrictEqual(views[1], expected, 'aws');
		});
	}

	test('admin.createUser: an undeclared `custom:` attribute, a verified flag, then a non-string value', async () => {
		const attributes = { 'custom:dept': 'x', email_verified: 'true', name: false };
		const mock = new MockAuth(root(), 'auth', OPTIONS);
		const aws = makeAwsAuth(OPTIONS);
		cognitoSchema(aws);
		const views = [
			await outcome(untyped(mock.admin, 'createUser', 'bob', { attributes })),
			await outcome(untyped(aws.auth.admin, 'createUser', 'bob', { attributes })),
		];
		assert.deepStrictEqual(views[0], INVALID, 'mock');
		assert.deepStrictEqual(views[1], INVALID, 'aws');
	});

	test('signUp of an existing username with an invalid attribute: the attribute error, on both (no enumeration signal)', async () => {
		const mock = new MockAuth(root(), 'auth', OPTIONS);
		await mock.signUp('bob', PASSWORD, { attributes: { email: 'bob@example.com' } });
		const aws = makeAwsAuth(OPTIONS);
		cognitoSchema(aws);
		const attributes = { email: 'bob@example.com', name: 42 };
		const views = [
			await outcome(untyped(mock, 'signUp', 'bob', PASSWORD, { attributes })),
			await outcome(untyped(aws.auth, 'signUp', 'bob', PASSWORD, { attributes })),
		];
		assert.deepStrictEqual(views[0], INVALID, 'mock');
		assert.deepStrictEqual(views[1], INVALID, 'aws');
	});
});

/**
 * `emailPassword: { selfSignUp: false }` (FX44, R79): the pool is provisioned
 * with `AllowAdminCreateUserOnly`, and Cognito refuses the `SignUp` operation
 * itself with `NotAuthorizedException`, whatever the attributes. The local
 * engine checks `selfSignUp` first; the AWS engine must too, before its own
 * attribute rules, or an invalid attribute answers 400 there and 401 locally.
 */
describe('parity: signUp on a `selfSignUp: false` pool', () => {
	const CLOSED = { ...OPTIONS, emailPassword: { selfSignUp: false } } as const;
	for (const [label, attributes] of [
		['valid attributes', { email: 'bob@example.com', name: 'Bob' }],
		['a non-string value', { email: 'bob@example.com', name: 42 }],
		['an object value', { email: 'bob@example.com', name: { first: 'Bob' } }],
		['a 2,049-character value', { email: 'bob@example.com', name: 'x'.repeat(2049) }],
		['`sub`', { email: 'bob@example.com', sub: 'mine' }],
		['`email_verified`', { email: 'bob@example.com', email_verified: 'true' }],
		['an undeclared `custom:` attribute', { email: 'bob@example.com', 'custom:dept': 'x' }],
		['several invalid attributes', { 'custom:dept': 'x', email_verified: 'true', name: 42 }],
	] as const) {
		test(label, async () => {
			const mock = new MockAuth(root(), 'auth', CLOSED);
			const aws = makeAwsAuth(CLOSED);
			cognitoSchema(aws, { selfSignUp: false });
			const views = [
				await outcome(untyped(mock, 'signUp', 'bob', PASSWORD, { attributes })),
				await outcome(untyped(aws.auth, 'signUp', 'bob', PASSWORD, { attributes })),
			];
			assert.deepStrictEqual(views[0], UNAUTHORIZED, 'mock');
			assert.deepStrictEqual(views[1], UNAUTHORIZED, 'aws');
			assert.ok(!aws.sent.some((c) => c.name === 'SignUpCommand'), 'the AWS engine sends no SignUp');
		});
	}

	test('admin.createUser still validates the attributes (the admin API is not gated)', async () => {
		const mock = new MockAuth(root(), 'auth', CLOSED);
		const aws = makeAwsAuth(CLOSED);
		cognitoSchema(aws, { selfSignUp: false });
		for (const [attributes, expected] of [
			[{ email: 'bob@example.com', name: 42 }, INVALID],
			[{ email: 'bob@example.com', email_verified: 'true' }, 'ok'],
		] as const) {
			const views = [
				await outcome(untyped(mock.admin, 'createUser', 'bob', { attributes })),
				await outcome(untyped(aws.auth.admin, 'createUser', 'bob', { attributes })),
			];
			assert.deepStrictEqual(views[0], expected, 'mock');
			assert.deepStrictEqual(views[1], expected, 'aws');
		}
	});
});

describe('mock: an external pool (`Auth.fromExisting`) — its schema is not known locally', () => {
	test('any `custom:` attribute is accepted; every other rule still applies', async () => {
		const auth = new MockAuth(root(), 'auth', { userPool: MockAuth.fromExisting('us-east-1_Existing') });
		assert.strictEqual(
			await outcome(untyped(auth, 'signUp', 'bob', PASSWORD, { attributes: { 'custom:dept': 'x' } })),
			'ok',
		);
		assert.deepStrictEqual(
			await outcome(untyped(auth, 'signUp', 'carol', PASSWORD, { attributes: { dept: 'x' } })),
			INVALID,
		);
		assert.deepStrictEqual(
			await outcome(untyped(auth, 'signUp', 'dave', PASSWORD, { attributes: { 'custom:dept': 1 } })),
			INVALID,
		);
	});
});
