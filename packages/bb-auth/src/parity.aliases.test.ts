// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Mock ↔ AWS parity for **alias uniqueness** (FX49, L36(a)): two users with the
 * same email / phone, driven through the same `Auth` API on the local engine
 * (`./index.mock.js`) and on the AWS entry (`./index.aws.js`, offline through
 * `test-support/aws-harness.ts`). What a caller observes — success, or the
 * error `name` / HTTP status / `retriable` — and who signs in with the shared
 * value afterwards must agree.
 *
 * On the AWS side the harness answers as {@link cognitoPool}, a stateful
 * stand-in for one Cognito user pool that implements exactly the documented
 * rules (quotes and URLs on each). Before FX49 the local pool enforced none of
 * them: any number of local users could verify one email, and sign-in with it
 * picked the last.
 */

import assert from 'node:assert';
import crypto from 'node:crypto';
import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, test } from 'node:test';
import type { AuthActionInput, AuthStateApi } from '@aws-blocks/auth-common';
import type { BlocksContext, ScopeParent } from '@aws-blocks/core';
import { WRONG_CODE_MESSAGE } from './enumeration.js';
import { clientMessageFor } from './error-mapping.js';
import { AuthErrors } from './errors.js';
import { Auth as MockAuth } from './index.mock.js';
import { type AwsAuthHarness, Browser, cognitoError, makeAwsAuth, wireView } from './test-support/aws-harness.js';
import type { AuthOptions, CodeDeliveryPurpose } from './types.js';

beforeEach(() => rmSync('.bb-data', { recursive: true, force: true }));
afterEach(() => rmSync('.bb-data', { recursive: true, force: true }));

const PASSWORD = 'Passw0rd!';
let n = 0;
const root = (): ScopeParent => ({ id: `parityalias${process.pid}x${++n}` });

/** The code the stand-in accepts (Cognito's would be in the user's inbox). */
const CODE = '123456';

type SignInWith = readonly ('username' | 'email' | 'phone')[];
type Contact = 'email' | 'phone_number';
const CONTACTS: readonly Contact[] = ['email', 'phone_number'];
const EMAIL_FORMAT = /^[^\s@]+@[^\s@]+$/;
const PHONE_FORMAT = /^\+\d+$/;

// ─────────────────────────────────────────────────────────────────────────────
// Cognito, as documented
// ─────────────────────────────────────────────────────────────────────────────

interface PoolUser {
	sub: string;
	password: string;
	confirmed: boolean;
	attributes: Record<string, string>;
	/** The contact `SignUp` sent the confirmation code to. */
	delivered?: Contact;
}

/**
 * A stateful stand-in for one Cognito user pool, as `Auth` provisions it for
 * `signInWith` (`mapSignInWith`; `mapAutoVerify` auto-verifies the contact
 * members). "The guide" is the developer guide,
 * <https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-settings-attributes.html#user-pool-settings-aliases>;
 * "the API reference" is
 * <https://docs.aws.amazon.com/cognito-user-identity-pools/latest/APIReference/>.
 *
 * **Alias attributes** (`signInWith` with `'username'`):
 * - "Alias values must be unique in a user pool. If you configure an alias for
 *   an email address or phone number, the value that you provide can be in a
 *   verified state in only one account." (the guide)
 * - `SignUp`: "During sign-up, if your user provides an email address or phone
 *   number as an alias value and another user has already used that alias
 *   value, registration succeeds."
 * - `ConfirmSignUp`: "when a user tries to confirm the account with this email
 *   (or phone number) and enters the valid code, Amazon Cognito returns an
 *   `AliasExistsException` error" — so the code is checked first. The user
 *   stays unconfirmed. `Auth` never sends `ForceAliasCreation`, which would
 *   move the alias instead.
 * - `VerifyUserAttribute`: "If a user verifies an email address or phone number
 *   that is already a verified alias on another account, Amazon Cognito
 *   transfers the alias to their account and marks the attribute as unverified
 *   on the original account. This transfer doesn't raise an
 *   `AliasExistsException`."
 * - `UpdateUserAttributes`: a changed email / phone is unverified, and "Phone
 *   numbers and email addresses only become active aliases for a user after
 *   your user verifies" them, so the write itself is accepted.
 * - `AdminCreateUser` `ForceAliasCreation`: "This parameter is used only if the
 *   `phone_number_verified` or `email_verified` attribute is set to `True`.
 *   … If this parameter is set to `False`, the API throws an
 *   `AliasExistsException` error if the alias already exists." (the API
 *   reference). Checked after the username rules, as the local engine does
 *   (the order is not documented).
 *
 * **Username attributes** (`signInWith` without `'username'`): "The email
 * address or phone number must be unique, and it must not already be in use by
 * another user. It doesn't have to be verified." (the guide). `SignUp` /
 * `AdminCreateUser` with one in use: `UsernameExistsException` ("If the
 * `username` string contains an email address or phone number that is already
 * in use, the `SignUp` API returns an exception"). `UpdateUserAttributes` to
 * one in use: "the user can change the email address or phone number to a new
 * email address or phone number. If the email address or phone number isn't
 * already in use, it becomes the new username" — the exception for one in use
 * is not named; `UpdateUserAttributes` lists `AliasExistsException` ("an
 * account with this email address or phone already exists"), which the
 * stand-in takes (inferred: to confirm in a sandbox, L2).
 */
function cognitoPool(h: Pick<AwsAuthHarness<AuthOptions>, 'on' | 'idp'>, signInWith: SignInWith) {
	const contacts: Contact[] = [];
	if (signInWith.includes('email')) contacts.push('email');
	if (signInWith.includes('phone')) contacts.push('phone_number');
	const aliasPool = signInWith.includes('username');
	const users = new Map<string, PoolUser>();

	const inFormat = (c: Contact, v: string) => (c === 'email' ? EMAIL_FORMAT : PHONE_FORMAT).test(v);
	/** Whether `u` holds `value` as its sign-in `c`: any value on a username-attribute pool, a verified one on an alias pool. */
	const holds = (u: PoolUser, c: Contact, value: string) =>
		contacts.includes(c) && u.attributes[c] === value && (!aliasPool || u.attributes[`${c}_verified`] === 'true');
	const holderOf = (c: Contact, value: string, except?: string) =>
		[...users].find(([name, u]) => name !== except && holds(u, c, value))?.[0];
	const resolve = (login: string): string | undefined =>
		users.has(login) ? login : CONTACTS.map((c) => holderOf(c, login)).find((u) => u !== undefined);
	const requireUser = (login: unknown): [string, PoolUser] => {
		const name = resolve(String(login));
		const user = name === undefined ? undefined : users.get(name);
		if (name === undefined || !user) throw cognitoError('UserNotFoundException', 'User does not exist.');
		return [name, user];
	};
	const fromToken = (token: unknown): [string, PoolUser] => {
		const payload = JSON.parse(Buffer.from(String(token).split('.')[1] ?? '', 'base64url').toString('utf8'));
		return requireUser(payload.username);
	};
	const aliasExists = (c: Contact) =>
		cognitoError('AliasExistsException', `An account with the given ${c} already exists.`);
	const wrongCode = () =>
		cognitoError('CodeMismatchException', 'Invalid verification code provided, please try again.');
	const attrsOf = (list: unknown): Record<string, string> => {
		const out: Record<string, string> = {};
		for (const a of Array.isArray(list) ? list : []) out[String(a.Name)] = String(a.Value);
		return out;
	};
	const toList = (u: PoolUser) => [
		{ Name: 'sub', Value: u.sub },
		...Object.entries(u.attributes).map(([Name, Value]) => ({ Name, Value })),
	];
	const delivery = (c: Contact, value: string) => ({
		Destination: c === 'email' ? `${value.slice(0, 1)}***@e***` : `+*******${value.slice(-4)}`,
		DeliveryMedium: c === 'email' ? 'EMAIL' : 'SMS',
		AttributeName: c,
	});

	/** A new user's stored username, as `SignUp` / `AdminCreateUser` derive it (`parity.usernames.test.ts`). */
	const create = (login: string, attributes: Record<string, string>, admin: boolean): string => {
		if (!aliasPool) {
			const attr = contacts.find((c) => inFormat(c, login));
			if (!attr) throw cognitoError('InvalidParameterException', 'Username should be an email.');
			attributes[attr] ??= login;
			for (const c of contacts) {
				if (attributes[c] && holderOf(c, attributes[c])) {
					throw cognitoError('UsernameExistsException', `An account with the given ${c} already exists.`);
				}
			}
			return crypto.randomUUID();
		}
		for (const c of contacts) {
			if (inFormat(c, login)) {
				throw cognitoError(
					'InvalidParameterException',
					`Username cannot be of ${c === 'email' ? 'email' : 'phone number'} format, since user pool is configured for ${c} alias.`,
				);
			}
		}
		if (users.has(login)) throw cognitoError('UsernameExistsException', 'User already exists');
		if (admin) {
			for (const c of contacts) {
				if (attributes[`${c}_verified`] === 'true' && attributes[c] && holderOf(c, attributes[c])) {
					throw aliasExists(c);
				}
			}
		}
		return login;
	};

	h.on('SignUpCommand', (input) => {
		const attributes = attrsOf(input.UserAttributes);
		const name = create(String(input.Username), attributes, false);
		for (const c of CONTACTS) if (attributes[c]) attributes[`${c}_verified`] = 'false';
		const delivered = (['phone_number', 'email'] as const).find((c) => contacts.includes(c) && attributes[c]);
		const user: PoolUser = {
			sub: aliasPool ? crypto.randomUUID() : name,
			password: String(input.Password),
			confirmed: false,
			attributes,
			...(delivered ? { delivered } : {}),
		};
		users.set(name, user);
		return {
			UserConfirmed: false,
			UserSub: user.sub,
			...(delivered ? { CodeDeliveryDetails: delivery(delivered, attributes[delivered]) } : {}),
		};
	});
	h.on('ConfirmSignUpCommand', (input) => {
		const [name, user] = requireUser(input.Username);
		if (input.ConfirmationCode !== CODE) throw wrongCode();
		if (user.confirmed) {
			throw cognitoError('NotAuthorizedException', 'User cannot be confirmed. Current status is CONFIRMED');
		}
		const c = user.delivered;
		if (c && aliasPool && holderOf(c, user.attributes[c], name)) throw aliasExists(c);
		user.confirmed = true;
		if (c) user.attributes[`${c}_verified`] = 'true';
		return {};
	});
	h.on('InitiateAuthCommand', (input) => {
		const params: Record<string, unknown> = Object(input.AuthParameters);
		const name =
			input.AuthFlow === 'REFRESH_TOKEN_AUTH'
				? String(params.REFRESH_TOKEN).replace(/^refresh-/, '')
				: resolve(String(params.USERNAME));
		const user = name === undefined ? undefined : users.get(name);
		if (name === undefined || !user)
			throw cognitoError('NotAuthorizedException', 'Incorrect username or password.');
		if (input.AuthFlow !== 'REFRESH_TOKEN_AUTH') {
			if (user.password !== params.PASSWORD) {
				throw cognitoError('NotAuthorizedException', 'Incorrect username or password.');
			}
			if (!user.confirmed) throw cognitoError('UserNotConfirmedException', 'User is not confirmed.');
		}
		const claims: Record<string, unknown> = { sub: user.sub };
		for (const c of CONTACTS) {
			if (user.attributes[c] === undefined) continue;
			claims[c] = user.attributes[c];
			claims[`${c}_verified`] = user.attributes[`${c}_verified`] === 'true';
		}
		return { AuthenticationResult: h.idp.authResult(name, { claims }) };
	});
	h.on('GetUserCommand', (input) => {
		const [name, user] = fromToken(input.AccessToken);
		return { Username: name, UserAttributes: toList(user) };
	});
	h.on('UpdateUserAttributesCommand', (input) => {
		const [name, user] = fromToken(input.AccessToken);
		const written = attrsOf(input.UserAttributes);
		// Validated as a whole: a rejected write changes nothing.
		if (!aliasPool) {
			for (const c of contacts) {
				const value = written[c];
				if (value && value !== user.attributes[c] && holderOf(c, value, name)) throw aliasExists(c);
			}
		}
		const list = [];
		for (const [key, value] of Object.entries(written)) {
			const changedContact = (key === 'email' || key === 'phone_number') && user.attributes[key] !== value;
			user.attributes[key] = value;
			if (!changedContact) continue;
			user.attributes[`${key}_verified`] = 'false';
			list.push(delivery(key, value));
		}
		return { CodeDeliveryDetailsList: list };
	});
	h.on('GetUserAttributeVerificationCodeCommand', (input) => {
		const [, user] = fromToken(input.AccessToken);
		const c = input.AttributeName === 'phone_number' ? 'phone_number' : 'email';
		return { CodeDeliveryDetails: delivery(c, user.attributes[c] ?? '') };
	});
	h.on('VerifyUserAttributeCommand', (input) => {
		const [name, user] = fromToken(input.AccessToken);
		if (input.Code !== CODE) throw wrongCode();
		const c = input.AttributeName === 'phone_number' ? 'phone_number' : 'email';
		const value = user.attributes[c];
		if (aliasPool && value) {
			// The transfer: the previous holder's attribute becomes unverified.
			for (const [other, u] of users)
				if (other !== name && holds(u, c, value)) u.attributes[`${c}_verified`] = 'false';
		}
		user.attributes[`${c}_verified`] = 'true';
		return {};
	});
	h.on('AdminCreateUserCommand', (input) => {
		const attributes = attrsOf(input.UserAttributes);
		const name = create(String(input.Username), attributes, true);
		const user: PoolUser = {
			sub: aliasPool ? crypto.randomUUID() : name,
			password: String(input.TemporaryPassword),
			confirmed: true,
			attributes,
		};
		users.set(name, user);
		return { User: { Username: name, Enabled: true, Attributes: toList(user) } };
	});
	h.on('AdminSetUserPasswordCommand', (input) => {
		requireUser(input.Username)[1].password = String(input.Password);
		return {};
	});
	h.on('AdminGetUserCommand', (input) => {
		const [name, user] = requireUser(input.Username);
		return { Username: name, Enabled: true, UserAttributes: toList(user) };
	});
	h.on('AdminListGroupsForUserCommand', (input) => {
		requireUser(input.Username);
		return { Groups: [] };
	});
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Both runtimes for `options`: the local `Auth` (keeping every code it
 * delivers, by purpose and sign-in name) and the AWS one against
 * {@link cognitoPool}.
 */
function bothRuntimes<const O extends AuthOptions>(options: O) {
	const codes = new Map<string, string>();
	const mock = new MockAuth(root(), 'auth', {
		...options,
		codeDelivery: async (login: string, code: string, purpose: CodeDeliveryPurpose) => {
			codes.set(`${purpose}:${login}`, code);
		},
	});
	const h = makeAwsAuth(options);
	cognitoPool(h, options.users?.signInWith ?? ['username', 'email']);
	return [
		{
			label: 'mock',
			auth: mock,
			code: (purpose: CodeDeliveryPurpose, login: string) => codes.get(`${purpose}:${login}`) ?? '',
		},
		{ label: 'aws', auth: h.auth, code: () => CODE },
	] as const;
}

/** A code that is certainly not `code`. */
const not = (code: string) => (code === '000000' ? '000001' : '000000');

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

/** Who `login` signs in as (their username), or the rejection's name. */
async function signsInAs(auth: Pick<MockAuth, 'signIn'>, login: string): Promise<string> {
	try {
		const r = await new Browser().request((ctx) => auth.signIn(login, PASSWORD, ctx));
		return r.status === 'signedIn' ? r.user.username : r.status;
	} catch (e) {
		return String(wireView(e).name);
	}
}

/** Bind `auth.createApi()` to one request, the way the RPC layer does. */
function bindAuthApi(api: AuthStateApi, ctx: BlocksContext): AuthStateApi {
	const target: unknown = api;
	assert.ok(typeof target === 'function');
	const handler: unknown = Reflect.apply(target, undefined, [ctx]);
	assert.ok(typeof handler === 'object' && handler !== null);
	const getAuthState: unknown = Reflect.get(handler, 'getAuthState');
	const setAuthState: unknown = Reflect.get(handler, 'setAuthState');
	assert.ok(typeof getAuthState === 'function' && typeof setAuthState === 'function');
	return {
		getAuthState: () => Reflect.apply(getAuthState, handler, []),
		setAuthState: (input: AuthActionInput) => Reflect.apply(setAuthState, handler, [input]),
	};
}

const ALIAS_EXISTS = {
	name: 'AliasExistsException',
	code: 400,
	retriable: false,
	message: clientMessageFor(AuthErrors.AliasExists),
};
const EMAIL = 'shared@example.com';
const PHONE = '+15555550100';

// ─────────────────────────────────────────────────────────────────────────────
// Alias attributes — signInWith with 'username'
// ─────────────────────────────────────────────────────────────────────────────

describe("parity: alias uniqueness on a username + email-alias pool (signInWith: ['username', 'email'])", () => {
	const OPTIONS = { users: { signInWith: ['username', 'email'] }, admin: {} } as const;

	test('a duplicate signs up; confirming it is AliasExistsException (after the code check), and the email stays with its holder', async () => {
		const seen = [];
		for (const { label, auth, code } of bothRuntimes(OPTIONS)) {
			await auth.signUp('ann', PASSWORD, { attributes: { email: EMAIL } });
			await auth.confirmSignUp('ann', code('signUp', 'ann'));
			// "registration succeeds"
			const signUp = await outcome(auth.signUp('bob', PASSWORD, { attributes: { email: EMAIL } }));
			const wrong = await outcome(auth.confirmSignUp('bob', not(code('signUp', 'bob'))));
			const right = await outcome(auth.confirmSignUp('bob', code('signUp', 'bob')));
			const bob = await auth.admin.getUser('bob');
			seen.push({
				signUp,
				wrong,
				right,
				bobEmailVerified: bob?.attributes.email_verified,
				emailSignsInAs: await signsInAs(auth, EMAIL),
				bobSignsIn: await signsInAs(auth, 'bob'),
			});
			assert.ok(seen.length > 0, label);
		}
		assert.deepStrictEqual(seen[0], {
			signUp: 'ok',
			wrong: { name: 'CodeMismatchException', code: 400, retriable: true, message: WRONG_CODE_MESSAGE },
			right: ALIAS_EXISTS,
			bobEmailVerified: 'false',
			emailSignsInAs: 'ann',
			bobSignsIn: 'UserNotConfirmedException',
		});
		assert.deepStrictEqual(seen[1], seen[0]);
	});

	test('the conflict is not masked by the state machine (it needs the code sent to that email)', async () => {
		const seen = [];
		for (const { auth, code } of bothRuntimes(OPTIONS)) {
			await auth.signUp('ann', PASSWORD, { attributes: { email: EMAIL } });
			await auth.confirmSignUp('ann', code('signUp', 'ann'));
			const api = auth.createApi();
			const browser = new Browser();
			const set = (input: AuthActionInput) => browser.request((ctx) => bindAuthApi(api, ctx).setAuthState(input));
			const signedUp = await set({ action: 'signUp', username: 'bob', password: PASSWORD, email: EMAIL });
			const confirmed = await set({ action: 'confirmSignUp', username: 'bob', code: code('signUp', 'bob') });
			seen.push({
				signedUp: signedUp.state,
				confirmed: { state: confirmed.state, errorName: confirmed.errorName },
			});
		}
		assert.deepStrictEqual(seen[0], {
			signedUp: 'confirmingSignUp',
			confirmed: { state: 'signedOut', errorName: 'AliasExistsException' },
		});
		assert.deepStrictEqual(seen[1], seen[0]);
	});

	test('two users may hold the same unverified email', async () => {
		const seen = [];
		for (const { auth } of bothRuntimes(OPTIONS)) {
			const created = [];
			for (const name of ['cat', 'dov']) {
				created.push(
					await outcome(
						auth.admin.createUser(name, {
							temporaryPassword: 'Temp-Passw0rd!',
							attributes: { email: EMAIL },
						}),
					),
				);
				await auth.admin.setUserPassword(name, PASSWORD, { permanent: true });
			}
			seen.push({ created, emailSignsInAs: await signsInAs(auth, EMAIL) });
		}
		assert.deepStrictEqual(seen[0], { created: ['ok', 'ok'], emailSignsInAs: 'NotAuthorizedException' });
		assert.deepStrictEqual(seen[1], seen[0]);
	});

	test('confirmUserAttribute moves a verified alias: the previous holder’s email becomes unverified', async () => {
		const seen = [];
		for (const { auth, code } of bothRuntimes(OPTIONS)) {
			await auth.signUp('ann', PASSWORD, { attributes: { email: EMAIL } });
			await auth.confirmSignUp('ann', code('signUp', 'ann'));
			await auth.signUp('eve', PASSWORD, { attributes: { email: 'eve@example.com' } });
			await auth.confirmSignUp('eve', code('signUp', 'eve'));
			const browser = new Browser();
			await browser.request((ctx) => auth.signIn('eve', PASSWORD, ctx));
			// The new value is unverified, so it is no alias yet: the write is accepted.
			const updated = await browser.request((ctx) => auth.updateUserAttributes(ctx, { email: EMAIL }));
			const confirmed = await outcome(
				browser.request((ctx) => auth.confirmUserAttribute(ctx, 'email', code('attribute', 'eve'))),
			);
			const ann = await auth.admin.getUser('ann');
			const eve = await auth.admin.getUser('eve');
			seen.push({
				updated: updated.email?.isUpdated,
				confirmed,
				ann: { email: ann?.attributes.email, email_verified: ann?.attributes.email_verified },
				eve: { email: eve?.attributes.email, email_verified: eve?.attributes.email_verified },
				emailSignsInAs: await signsInAs(auth, EMAIL),
				annSignsIn: await signsInAs(auth, 'ann'),
			});
		}
		assert.deepStrictEqual(seen[0], {
			updated: false,
			confirmed: 'ok',
			ann: { email: EMAIL, email_verified: 'false' },
			eve: { email: EMAIL, email_verified: 'true' },
			emailSignsInAs: 'eve',
			annSignsIn: 'ann',
		});
		assert.deepStrictEqual(seen[1], seen[0]);
	});

	test('admin.createUser: a verified duplicate is AliasExistsException; an unverified one is created', async () => {
		const seen = [];
		for (const { auth, code } of bothRuntimes(OPTIONS)) {
			await auth.signUp('ann', PASSWORD, { attributes: { email: EMAIL } });
			await auth.confirmSignUp('ann', code('signUp', 'ann'));
			const verified = await outcome(
				auth.admin.createUser('fay', {
					temporaryPassword: 'Temp-Passw0rd!',
					attributes: { email: EMAIL, email_verified: 'true' },
				}),
			);
			const unverified = await outcome(
				auth.admin.createUser('gus', { temporaryPassword: 'Temp-Passw0rd!', attributes: { email: EMAIL } }),
			);
			seen.push({
				verified,
				fay: await auth.admin.getUser('fay'),
				unverified,
				emailSignsInAs: await signsInAs(auth, EMAIL),
			});
		}
		assert.deepStrictEqual(seen[0], { verified: ALIAS_EXISTS, fay: null, unverified: 'ok', emailSignsInAs: 'ann' });
		assert.deepStrictEqual(seen[1], seen[0]);
	});
});

describe("parity: alias uniqueness for a phone alias (signInWith: ['username', 'email', 'phone'])", () => {
	const OPTIONS = { users: { signInWith: ['username', 'email', 'phone'] }, admin: {} } as const;

	test('the sign-up code goes to the phone; confirming a duplicate verified phone is AliasExistsException', async () => {
		const seen = [];
		for (const { auth, code } of bothRuntimes(OPTIONS)) {
			await auth.signUp('ann', PASSWORD, { attributes: { phone_number: PHONE } });
			await auth.confirmSignUp('ann', code('signUp', 'ann'));
			// The email differs; the phone (the attribute the code goes to) is the conflict.
			await auth.signUp('bob', PASSWORD, { attributes: { email: 'bob@example.com', phone_number: PHONE } });
			const right = await outcome(auth.confirmSignUp('bob', code('signUp', 'bob')));
			seen.push({ right, phoneSignsInAs: await signsInAs(auth, PHONE) });
		}
		assert.deepStrictEqual(seen[0], { right: ALIAS_EXISTS, phoneSignsInAs: 'ann' });
		assert.deepStrictEqual(seen[1], seen[0]);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Username attributes — signInWith without 'username'
// ─────────────────────────────────────────────────────────────────────────────

describe("parity: email uniqueness on an email-only pool (signInWith: ['email'])", () => {
	const OPTIONS = { users: { signInWith: ['email'] }, admin: {} } as const;

	test('updateUserAttributes to an email another user has (verified or not) is AliasExistsException and writes nothing', async () => {
		const seen = [];
		for (const { auth, code } of bothRuntimes(OPTIONS)) {
			for (const login of ['ann@example.com', 'bob@example.com']) {
				await auth.signUp(login, PASSWORD);
				await auth.confirmSignUp(login, code('signUp', login));
			}
			// Unconfirmed, so its email is unverified — still in use.
			await auth.signUp('cy@example.com', PASSWORD);
			const browser = new Browser();
			await browser.request((ctx) => auth.signIn('bob@example.com', PASSWORD, ctx));
			const update = (email: string) =>
				outcome(browser.request((ctx) => auth.updateUserAttributes(ctx, { email, name: 'Bob' })));
			const toVerified = await update('ann@example.com');
			const toUnverified = await update('cy@example.com');
			const bob = await auth.admin.getUser('bob@example.com');
			const toFree = await update('bobby@example.com');
			seen.push({
				toVerified,
				toUnverified,
				bob: { email: bob?.attributes.email, name: bob?.attributes.name ?? null },
				toFree,
				annSignsIn:
					(await signsInAs(auth, 'ann@example.com')) ===
					(await auth.admin.getUser('ann@example.com'))?.username,
			});
		}
		assert.deepStrictEqual(seen[0], {
			toVerified: ALIAS_EXISTS,
			toUnverified: ALIAS_EXISTS,
			bob: { email: 'bob@example.com', name: null },
			toFree: 'ok',
			annSignsIn: true,
		});
		assert.deepStrictEqual(seen[1], seen[0]);
	});
});
