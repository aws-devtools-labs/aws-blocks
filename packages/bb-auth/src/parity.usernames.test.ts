// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Mock ↔ AWS parity for **usernames** (D5d, L28): what `username` / `userId` /
 * `userSub` and the email attribute are, for the two ways Cognito models
 * `users.signInWith` — driven through the same `Auth` API on the local engine
 * (`./index.mock.js`) and on the AWS entry (`./index.aws.js`, offline through
 * `test-support/aws-harness.ts`).
 *
 * On the AWS side the harness answers as a small stateful Cognito user
 * directory, {@link cognitoDirectory}, which implements exactly the documented
 * behaviour (quotes and URLs on each rule):
 *
 * - `signInWith: ['email']` → `UsernameAttributes: ['email']`: the stored
 *   username is generated and equal to `sub`; the email given as the username
 *   fills the `email` attribute; the email works in place of the username.
 * - `signInWith: ['username', 'email']` (the default) → `AliasAttributes:
 *   ['email']`: the username is the chosen one; nothing is filled from it; an
 *   email-format username is refused; a **verified** email signs in in its place.
 *
 * Random `sub`s differ between the runtimes, so users are compared after
 * {@link shape}, which keeps the relations (`username === userSub`, `userId ===
 * username`) and the literal values that are not generated.
 */

import assert from 'node:assert';
import crypto from 'node:crypto';
import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, test } from 'node:test';
import type { ScopeParent } from '@aws-blocks/core';
import { Auth as MockAuth } from './index.mock.js';
import { type AwsAuthHarness, Browser, cognitoError, makeAwsAuth, wireView } from './test-support/aws-harness.js';
import type { AuthOptions, CodeDeliveryPurpose } from './types.js';

beforeEach(() => rmSync('.bb-data', { recursive: true, force: true }));
afterEach(() => rmSync('.bb-data', { recursive: true, force: true }));

const PASSWORD = 'Passw0rd!';
let n = 0;
const root = (): ScopeParent => ({ id: `parityusr${process.pid}x${++n}` });

const EMAIL_ONLY = { users: { signInWith: ['email'] }, admin: {} } as const;
const USERNAME_AND_EMAIL = { users: { signInWith: ['username', 'email'] }, admin: {} } as const;

// ─────────────────────────────────────────────────────────────────────────────
// Cognito, as documented
// ─────────────────────────────────────────────────────────────────────────────

interface DirectoryUser {
	sub: string;
	password: string;
	attributes: Record<string, string>;
}

const EMAIL_FORMAT = /^[^\s@]+@[^\s@]+$/;

/**
 * A stateful stand-in for a Cognito user pool's directory, for a pool whose
 * only sign-in attribute besides (optionally) the username is `email`.
 * `mode: 'username-attributes'` is `UsernameAttributes: ['email']`;
 * `'alias-attributes'` is `AliasAttributes: ['email']`.
 *
 * Rules, from <https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-settings-attributes.html#user-pool-settings-aliases>:
 * - username attributes, `SignUp`: "If the `username` string is in valid email
 *   address format … the user pool automatically populates the `email`
 *   attribute of the user with the `username` value." / "If the `username`
 *   string format isn't in email address or phone number format, the `SignUp`
 *   API returns an exception." / "The `SignUp` API populates the `username`
 *   attribute with a UUID for your user. This UUID has the same value as the
 *   `sub` claim in the user identity token." / "You can use an email address
 *   or phone number in place of the username in all APIs except the
 *   `ListUsers` operation."
 * - username attributes, `AdminCreateUser` (`Username`): "If your user pool
 *   only supports phone numbers or email addresses as sign-in attributes,
 *   Amazon Cognito automatically generates a username value."
 *   (<https://docs.aws.amazon.com/cognito-user-identity-pools/latest/APIReference/API_AdminCreateUser.html>)
 *   The fill of `email` from `Username` is applied as for `SignUp` (inferred:
 *   the docs state it for `SignUp` only — to confirm in a sandbox, L2).
 * - alias attributes: "If you select email address as an alias, Amazon Cognito
 *   doesn't accept a username that matches a valid email address format." /
 *   "Phone numbers and email addresses only become active aliases for a user
 *   after your user verifies the phone numbers and email addresses."
 * - ID token `cognito:username`: "The username of your user in your user pool."
 *   (<https://docs.aws.amazon.com/cognito/latest/developerguide/amazon-cognito-user-pools-using-the-id-token.html>)
 */
function cognitoDirectory(
	h: Pick<AwsAuthHarness<AuthOptions>, 'on' | 'idp'>,
	mode: 'username-attributes' | 'alias-attributes',
) {
	const users = new Map<string, DirectoryUser>();
	const attrsOf = (list: unknown): Record<string, string> => {
		const out: Record<string, string> = {};
		for (const a of Array.isArray(list) ? list : []) out[String(a.Name)] = String(a.Value);
		return out;
	};
	const toList = (u: DirectoryUser) => [
		{ Name: 'sub', Value: u.sub },
		...Object.entries(u.attributes).map(([Name, Value]) => ({ Name, Value })),
	];
	/** `Username` → the stored username: itself, else the email (any, or verified on an alias pool). */
	const resolve = (login: string): string | undefined => {
		if (users.has(login)) return login;
		for (const [username, u] of users) {
			if (u.attributes.email !== login) continue;
			if (mode === 'username-attributes' || u.attributes.email_verified === 'true') return username;
		}
		return undefined;
	};
	const create = (login: string, attributes: Record<string, string>, password: string) => {
		if (mode === 'username-attributes') {
			if (!EMAIL_FORMAT.test(login))
				throw cognitoError('InvalidParameterException', 'Username should be an email.');
			if (resolve(login))
				throw cognitoError('UsernameExistsException', 'An account with the given email already exists.');
			const sub = crypto.randomUUID();
			users.set(sub, { sub, password, attributes: { email: login, ...attributes } });
			return sub;
		}
		if (EMAIL_FORMAT.test(login)) {
			throw cognitoError(
				'InvalidParameterException',
				'Username cannot be of email format, since user pool is configured for email alias.',
			);
		}
		if (users.has(login)) throw cognitoError('UsernameExistsException', 'User already exists');
		users.set(login, { sub: crypto.randomUUID(), password, attributes: { ...attributes } });
		return login;
	};
	const requireUser = (login: unknown): [string, DirectoryUser] => {
		const username = resolve(String(login));
		const user = username === undefined ? undefined : users.get(username);
		if (username === undefined || !user) throw cognitoError('UserNotFoundException', 'User does not exist.');
		return [username, user];
	};

	h.on('SignUpCommand', (input) => {
		const username = create(String(input.Username), attrsOf(input.UserAttributes), String(input.Password));
		const user = users.get(username);
		return {
			UserConfirmed: false,
			UserSub: user?.sub,
			CodeDeliveryDetails: { Destination: 'e***@e***', DeliveryMedium: 'EMAIL', AttributeName: 'email' },
		};
	});
	h.on('ConfirmSignUpCommand', (input) => {
		const [, user] = requireUser(input.Username);
		user.attributes.email_verified = 'true';
		return {};
	});
	h.on('AdminCreateUserCommand', (input) => {
		const username = create(String(input.Username), attrsOf(input.UserAttributes), String(input.TemporaryPassword));
		const user = users.get(username);
		if (!user) throw new Error('unreachable');
		return { User: { Username: username, Enabled: true, Attributes: toList(user) } };
	});
	h.on('AdminSetUserPasswordCommand', (input) => {
		requireUser(input.Username)[1].password = String(input.Password);
		return {};
	});
	h.on('AdminGetUserCommand', (input) => {
		const [username, user] = requireUser(input.Username);
		return { Username: username, Enabled: true, UserAttributes: toList(user) };
	});
	h.on('AdminListGroupsForUserCommand', (input) => {
		requireUser(input.Username);
		return { Groups: [] };
	});
	h.on('ListUsersCommand', () => ({
		Users: [...users].map(([username, u]) => ({ Username: username, Enabled: true, Attributes: toList(u) })),
	}));
	h.on('InitiateAuthCommand', (input) => {
		const params: Record<string, unknown> = Object(input.AuthParameters);
		const username = resolve(String(params.USERNAME));
		const user = username === undefined ? undefined : users.get(username);
		if (username === undefined || !user || user.password !== params.PASSWORD) {
			throw cognitoError('NotAuthorizedException', 'Incorrect username or password.');
		}
		return {
			AuthenticationResult: h.idp.authResult(username, {
				// Cognito ID tokens carry `email_verified` as a boolean.
				claims: {
					sub: user.sub,
					email: user.attributes.email,
					email_verified: user.attributes.email_verified === 'true',
				},
			}),
		};
	});
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** A local `Auth` that keeps the last code of each purpose. */
function mockAuth<const O extends AuthOptions>(options: O) {
	const codes = new Map<CodeDeliveryPurpose, string>();
	const auth = new MockAuth(root(), 'auth', {
		...options,
		codeDelivery: async (_username: string, code: string, purpose: CodeDeliveryPurpose) => {
			codes.set(purpose, code);
		},
	});
	return { auth, code: (purpose: CodeDeliveryPurpose) => codes.get(purpose) ?? '' };
}

/** A user, with generated values replaced by what they are equal to. */
function shape(u: { username: string; userId?: string; userSub: string; attributes: Partial<Record<string, string>> }) {
	const generated = (v: string | undefined) => (v === u.userSub ? '<userSub>' : v);
	return {
		username: generated(u.username),
		...(u.userId !== undefined ? { userId: generated(u.userId) } : {}),
		userSubIsSet: u.userSub.length > 0,
		email: u.attributes.email ?? null,
	};
}

/** What a client can observe of a rejection. */
async function failure(
	p: Promise<unknown>,
): Promise<{ name: unknown; code: unknown; retriable: unknown; message: unknown }> {
	const e = await p.then(
		() => assert.fail('expected a rejection'),
		(err: unknown) => err,
	);
	const { name, code, retriable, message } = wireView(e);
	return { name, code, retriable, message };
}

// ─────────────────────────────────────────────────────────────────────────────
// signInWith: ['email'] — UsernameAttributes
// ─────────────────────────────────────────────────────────────────────────────

describe("parity: usernames on an email-only pool (signInWith: ['email'])", () => {
	test('sign-up: the username / userId is generated and equal to userSub; the email fills the attribute', async () => {
		const mock = mockAuth(EMAIL_ONLY);
		const aws = makeAwsAuth(EMAIL_ONLY);
		cognitoDirectory(aws, 'username-attributes');

		const results = [];
		for (const [auth, code] of [
			[mock.auth, () => mock.code('signUp')],
			[aws.auth, () => '123456'],
		] as const) {
			const signedUp = await auth.signUp('erin@example.com', PASSWORD);
			await auth.confirmSignUp('erin@example.com', code());
			const b = new Browser();
			const r = await b.request((ctx) => auth.signIn('erin@example.com', PASSWORD, ctx));
			assert.ok(r.status === 'signedIn');
			const current = await b.request((ctx) => auth.requireAuth(ctx));
			const admin = await auth.admin.getUser('erin@example.com');
			assert.ok(admin);
			const listed = await Array.fromAsync(auth.admin.scan());
			// signUp's userId, the signed-in user and the admin view are one identity.
			assert.strictEqual(signedUp.userId, current.userSub);
			assert.strictEqual(r.user.userSub, current.userSub);
			assert.strictEqual(admin.userSub, current.userSub);
			assert.strictEqual(current.username, current.userSub, 'cognito:username is the generated username');
			// …and the generated username works in place of the email.
			assert.strictEqual((await auth.admin.getUser(current.username))?.userSub, current.userSub);
			results.push({
				signedIn: shape(r.user),
				current: shape(current),
				admin: shape(admin),
				listed: listed.map(shape),
			});
		}
		assert.deepStrictEqual(results[0], {
			signedIn: { username: '<userSub>', userId: '<userSub>', userSubIsSet: true, email: 'erin@example.com' },
			current: { username: '<userSub>', userId: '<userSub>', userSubIsSet: true, email: 'erin@example.com' },
			admin: { username: '<userSub>', userSubIsSet: true, email: 'erin@example.com' },
			listed: [{ username: '<userSub>', userSubIsSet: true, email: 'erin@example.com' }],
		});
		assert.deepStrictEqual(results[0], results[1]);
	});

	test('admin.createUser: generated username, email filled from Username (L28), sign-in with the email', async () => {
		const mock = mockAuth(EMAIL_ONLY);
		const aws = makeAwsAuth(EMAIL_ONLY);
		cognitoDirectory(aws, 'username-attributes');

		const results = [];
		for (const auth of [mock.auth, aws.auth]) {
			// No `email` attribute given: Cognito fills it from the Username.
			const created = await auth.admin.createUser('fay@example.com', {
				temporaryPassword: 'Temp-Passw0rd!',
				suppressInvite: true,
			});
			assert.strictEqual(created.username, created.userSub);
			await auth.admin.setUserPassword('fay@example.com', PASSWORD, { permanent: true });
			const b = new Browser();
			const r = await b.request((ctx) => auth.signIn('fay@example.com', PASSWORD, ctx));
			assert.ok(r.status === 'signedIn');
			assert.strictEqual(r.user.userSub, created.userSub);
			const read = await auth.admin.getUser('fay@example.com');
			assert.ok(read);
			results.push({ created: shape(created), signedIn: shape(r.user), read: shape(read) });
		}
		assert.deepStrictEqual(results[0], {
			created: { username: '<userSub>', userSubIsSet: true, email: 'fay@example.com' },
			signedIn: { username: '<userSub>', userId: '<userSub>', userSubIsSet: true, email: 'fay@example.com' },
			read: { username: '<userSub>', userSubIsSet: true, email: 'fay@example.com' },
		});
		assert.deepStrictEqual(results[0], results[1]);
	});

	test('a Username that is not an email, and a taken email, fail the same way in both runtimes', async () => {
		const mock = mockAuth(EMAIL_ONLY);
		const aws = makeAwsAuth(EMAIL_ONLY);
		cognitoDirectory(aws, 'username-attributes');
		for (const auth of [mock.auth, aws.auth]) await auth.signUp('gil@example.com', PASSWORD);
		const pairs = [
			[() => mock.auth.signUp('gil', PASSWORD), () => aws.auth.signUp('gil', PASSWORD)],
			[() => mock.auth.admin.createUser('gil'), () => aws.auth.admin.createUser('gil')],
			[() => mock.auth.signUp('gil@example.com', PASSWORD), () => aws.auth.signUp('gil@example.com', PASSWORD)],
			[() => mock.auth.admin.createUser('gil@example.com'), () => aws.auth.admin.createUser('gil@example.com')],
		] as const;
		const views = [];
		for (const [m, a] of pairs) {
			const pair = [await failure(m()), await failure(a())];
			assert.deepStrictEqual(pair[0], pair[1]);
			views.push(pair[0]);
		}
		assert.deepStrictEqual(
			views.map((v) => v.name),
			[
				'InvalidParameterException',
				'InvalidParameterException',
				'UsernameExistsException',
				'UsernameExistsException',
			],
		);
	});

	test('revokeUserSessions by email signs the user out in both runtimes', async () => {
		const mock = mockAuth(EMAIL_ONLY);
		const aws = makeAwsAuth(EMAIL_ONLY);
		cognitoDirectory(aws, 'username-attributes');
		aws.on('AdminUserGlobalSignOutCommand', () => ({}));
		for (const auth of [mock.auth, aws.auth]) {
			await auth.admin.createUser('hana@example.com', { temporaryPassword: 'Temp-Passw0rd!' });
			await auth.admin.setUserPassword('hana@example.com', PASSWORD, { permanent: true });
			const b = new Browser();
			await b.request((ctx) => auth.signIn('hana@example.com', PASSWORD, ctx));
			assert.ok(await b.request((ctx) => auth.getCurrentUser(ctx)));
			await auth.admin.revokeUserSessions('hana@example.com');
			assert.strictEqual(await b.request((ctx) => auth.getCurrentUser(ctx)), null);
		}
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// signInWith: ['username', 'email'] — AliasAttributes
// ─────────────────────────────────────────────────────────────────────────────

describe("parity: usernames on a username + email-alias pool (signInWith: ['username', 'email'])", () => {
	test('sign-up: the username is the chosen one; a verified email signs in as the same user', async () => {
		const mock = mockAuth(USERNAME_AND_EMAIL);
		const aws = makeAwsAuth(USERNAME_AND_EMAIL);
		cognitoDirectory(aws, 'alias-attributes');

		const results = [];
		for (const [auth, code] of [
			[mock.auth, () => mock.code('signUp')],
			[aws.auth, () => '123456'],
		] as const) {
			const signedUp = await auth.signUp('ivan', PASSWORD, { attributes: { email: 'ivan@example.com' } });
			await auth.confirmSignUp('ivan', code());
			const byName = await new Browser().request((ctx) => auth.signIn('ivan', PASSWORD, ctx));
			const byEmail = await new Browser().request((ctx) => auth.signIn('ivan@example.com', PASSWORD, ctx));
			assert.ok(byName.status === 'signedIn' && byEmail.status === 'signedIn');
			assert.strictEqual(byName.user.userSub, signedUp.userId);
			assert.strictEqual(byEmail.user.userSub, signedUp.userId);
			assert.notStrictEqual(byName.user.userSub, 'ivan');
			const admin = await auth.admin.getUser('ivan@example.com');
			assert.ok(admin);
			results.push({ byName: shape(byName.user), byEmail: shape(byEmail.user), admin: shape(admin) });
		}
		assert.deepStrictEqual(results[0], {
			byName: { username: 'ivan', userId: 'ivan', userSubIsSet: true, email: 'ivan@example.com' },
			byEmail: { username: 'ivan', userId: 'ivan', userSubIsSet: true, email: 'ivan@example.com' },
			admin: { username: 'ivan', userSubIsSet: true, email: 'ivan@example.com' },
		});
		assert.deepStrictEqual(results[0], results[1]);
	});

	test('admin.createUser: the username is kept and nothing is copied into email (L28)', async () => {
		const mock = mockAuth(USERNAME_AND_EMAIL);
		const aws = makeAwsAuth(USERNAME_AND_EMAIL);
		cognitoDirectory(aws, 'alias-attributes');
		const results = [];
		for (const auth of [mock.auth, aws.auth]) {
			const created = await auth.admin.createUser('jill', { temporaryPassword: 'Temp-Passw0rd!' });
			const withEmail = await auth.admin.createUser('kurt', {
				temporaryPassword: 'Temp-Passw0rd!',
				attributes: { email: 'kurt@example.com' },
			});
			results.push([shape(created), shape(withEmail)]);
		}
		assert.deepStrictEqual(results[0], [
			{ username: 'jill', userSubIsSet: true, email: null },
			{ username: 'kurt', userSubIsSet: true, email: 'kurt@example.com' },
		]);
		assert.deepStrictEqual(results[0], results[1]);
	});

	test('an unverified email does not sign in, and an email-format username is refused, in both runtimes', async () => {
		const mock = mockAuth(USERNAME_AND_EMAIL);
		const aws = makeAwsAuth(USERNAME_AND_EMAIL);
		cognitoDirectory(aws, 'alias-attributes');
		for (const auth of [mock.auth, aws.auth]) {
			await auth.admin.createUser('lena', {
				temporaryPassword: 'Temp-Passw0rd!',
				attributes: { email: 'lena@example.com' },
			});
			await auth.admin.setUserPassword('lena', PASSWORD, { permanent: true });
		}
		const pairs = [
			[
				() => new Browser().request((ctx) => mock.auth.signIn('lena@example.com', PASSWORD, ctx)),
				() => new Browser().request((ctx) => aws.auth.signIn('lena@example.com', PASSWORD, ctx)),
			],
			[() => mock.auth.signUp('mo@example.com', PASSWORD), () => aws.auth.signUp('mo@example.com', PASSWORD)],
			[() => mock.auth.admin.createUser('mo@example.com'), () => aws.auth.admin.createUser('mo@example.com')],
		] as const;
		const names = [];
		for (const [m, a] of pairs) {
			const pair = [await failure(m()), await failure(a())];
			assert.deepStrictEqual(pair[0], pair[1]);
			names.push(pair[0].name);
		}
		assert.deepStrictEqual(names, [
			'NotAuthorizedException',
			'InvalidParameterException',
			'InvalidParameterException',
		]);
	});
});
