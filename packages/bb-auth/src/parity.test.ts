// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Mock ↔ AWS parity for the native surface D5c2 completed: the same scenario
 * is driven through the same `Auth` API on the local engine (`./index.mock.js`,
 * a real local user) and on the AWS entry (`./index.aws.js`, offline through
 * `test-support/aws-harness.ts`, with Cognito answering as it does), and what a
 * caller can observe — return shapes, error `name` / HTTP status / `retriable`
 * — must agree.
 *
 * Where the runtimes genuinely differ (real TOTP vs "any 6 digits", `'NOMFA'`,
 * `rememberDevice`, `groups` on listed users) nothing is asserted here: the
 * divergence is documented in `DESIGN.md` ("Mock vs AWS behaviour
 * differences").
 */

import assert from 'node:assert';
import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, test } from 'node:test';
import type { AuthActionInput, AuthStateApi } from '@aws-blocks/auth-common';
import type { BlocksContext, ScopeParent } from '@aws-blocks/core';
import { INCORRECT_CREDENTIALS_MESSAGE } from './enumeration.js';
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
const root = (): ScopeParent => ({ id: `parity${process.pid}x${++n}` });

/** A local `Auth` with captured codes, plus `alice` (email verified) signed in on `browser`. */
async function mockSignedIn<const O extends AuthOptions>(options: O) {
	const codes: { purpose: CodeDeliveryPurpose; code: string }[] = [];
	const auth = new MockAuth(root(), 'auth', {
		...options,
		codeDelivery: async (_u: string, code: string, purpose: CodeDeliveryPurpose) => {
			codes.push({ purpose, code });
		},
	});
	const last = (purpose: CodeDeliveryPurpose) => [...codes].reverse().find((c) => c.purpose === purpose)?.code ?? '';
	// The wide `Auth` view: these scenarios use password configurations only.
	const wide: MockAuth = auth;
	await wide.signUp('alice', PASSWORD, { attributes: { email: 'alice@example.com' } });
	await wide.confirmSignUp('alice', last('signUp'));
	const browser = new Browser();
	const r = await browser.request((ctx) => wide.signIn('alice', PASSWORD, ctx));
	assert.strictEqual(r.status, 'signedIn');
	return { auth, browser, last };
}

/** The AWS `Auth` with `alice` signed in on `browser`. */
async function awsSignedIn<const O extends AuthOptions>(options: O) {
	const h = makeAwsAuth(options);
	const browser = new Browser();
	await signInAs(h, browser, 'alice');
	return { h, auth: h.auth, browser };
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

/**
 * A stateful stand-in for Cognito's MFA settings (`SetUserMFAPreference` /
 * `GetUser`), with Cognito's semantics: `Enabled` adds or removes a factor,
 * `PreferredMfa: true` makes it the preferred one, and Cognito keeps no
 * "chose no MFA" marker.
 */
function cognitoMfaState(h: Pick<AwsAuthHarness<AuthOptions>, 'on'>) {
	const names = {
		SMSMfaSettings: 'SMS_MFA',
		SoftwareTokenMfaSettings: 'SOFTWARE_TOKEN_MFA',
		EmailMfaSettings: 'EMAIL_OTP',
	};
	const enabled = new Set<string>();
	let preferred: string | undefined;
	h.on('SetUserMFAPreferenceCommand', (input) => {
		for (const [key, name] of Object.entries(names)) {
			const s: unknown = input[key];
			if (typeof s !== 'object' || s === null) continue;
			if (Reflect.get(s, 'Enabled') === true) enabled.add(name);
			else {
				enabled.delete(name);
				if (preferred === name) preferred = undefined;
			}
			if (Reflect.get(s, 'PreferredMfa') === true) preferred = name;
			else if (preferred === name) preferred = undefined;
		}
		return {};
	});
	h.on('GetUserCommand', () => ({
		Username: 'alice',
		UserAttributes: [],
		...(enabled.size > 0 ? { UserMFASettingList: [...enabled] } : {}),
		...(preferred ? { PreferredMfaSetting: preferred } : {}),
	}));
}

describe('parity: user attributes', () => {
	test('getUserAttributes returns the stored attributes, `sub` included, in both runtimes', async () => {
		const mock = await mockSignedIn({});
		const aws = await awsSignedIn({});
		aws.h.on('GetUserCommand', () => ({
			Username: 'alice',
			UserAttributes: [
				{ Name: 'sub', Value: 'sub-alice' },
				{ Name: 'email', Value: 'alice@example.com' },
				{ Name: 'email_verified', Value: 'true' },
			],
		}));
		const fromMock = await mock.browser.request((ctx) => mock.auth.getUserAttributes(ctx));
		const fromAws = await aws.browser.request((ctx) => aws.auth.getUserAttributes(ctx));
		assert.ok(typeof fromMock.sub === 'string' && fromMock.sub.length > 0);
		assert.deepStrictEqual({ ...fromMock, sub: 'SUB' }, { ...fromAws, sub: 'SUB' });
	});

	test('requireAuth / getCurrentUser `attributes` and the ID token carry the same claims in both runtimes (no `*_verified` attributes)', async () => {
		// Cognito's ID token carries `email_verified` / `phone_number_verified`
		// as booleans, which are not string attributes (L36(c)).
		const contact = { email: 'alice@example.com', phone_number: '+15555550100' };
		const codes: string[] = [];
		const mockAuth: MockAuth = new MockAuth(root(), 'auth', {
			codeDelivery: async (_u: string, code: string) => {
				codes.push(code);
			},
		});
		await mockAuth.signUp('alice', PASSWORD, { attributes: contact });
		await mockAuth.confirmSignUp('alice', codes.at(-1) ?? '');
		const mockBrowser = new Browser();
		await mockBrowser.request((ctx) => mockAuth.signIn('alice', PASSWORD, ctx));

		const h = makeAwsAuth({});
		const awsBrowser = new Browser();
		// The default pool auto-verifies the email only, so the sign-up code
		// verifies the email and the phone stays unverified (R67, FX34).
		const claims = { ...contact, email_verified: true, phone_number_verified: false };
		await signInAs(h, awsBrowser, 'alice', h.idp.authResult('alice', { claims }));
		h.on('InitiateAuthCommand', () => ({ AuthenticationResult: h.idp.authResult('alice', { claims }) }));

		for (const [label, browser, auth] of [
			['mock', mockBrowser, mockAuth],
			['aws', awsBrowser, h.auth],
		] as const) {
			const required = await browser.request((ctx) => auth.requireAuth(ctx));
			assert.deepStrictEqual(required.attributes, contact, `${label}: requireAuth().attributes`);
			const current = await browser.request((ctx) => auth.getCurrentUser(ctx));
			assert.deepStrictEqual(current?.attributes, contact, `${label}: getCurrentUser().attributes`);
			// After a refresh too: the mock re-mints its ID token.
			const session = await browser.request((ctx) => auth.getAuthSession(ctx, { forceRefresh: true }));
			const payload = session.tokens?.idToken.payload ?? {};
			assert.strictEqual(payload.email_verified, true, `${label}: ID token email_verified is a boolean`);
			assert.strictEqual(payload.phone_number_verified, false, `${label}: ID token phone_number_verified`);
			const refreshed = await browser.request((ctx) => auth.requireAuth(ctx));
			assert.deepStrictEqual(refreshed.attributes, contact, `${label}: attributes after a refresh`);
		}
	});

	test('updateUserAttributes: a changed email awaits its code, anything else is updated — same outcome map', async () => {
		const options = { users: { attributes: [{ name: 'team' }] } } as const;
		const mock = await mockSignedIn(options);
		const aws = await awsSignedIn(options);
		aws.h.on('UpdateUserAttributesCommand', () => ({
			CodeDeliveryDetailsList: [{ Destination: 'n***@e***', DeliveryMedium: 'EMAIL', AttributeName: 'email' }],
		}));
		const input = { email: 'new@example.com', team: 'ops' };
		assert.deepStrictEqual(
			await mock.browser.request((ctx) => mock.auth.updateUserAttributes(ctx, input)),
			await aws.browser.request((ctx) => aws.auth.updateUserAttributes(ctx, input)),
		);
	});

	test('confirmUserAttribute with a wrong code: CodeMismatch 400, retriable, in both runtimes', async () => {
		const mock = await mockSignedIn({});
		await mock.browser.request((ctx) => mock.auth.updateUserAttributes(ctx, { email: 'new@example.com' }));
		const aws = await awsSignedIn({});
		aws.h.on('VerifyUserAttributeCommand', () => {
			throw cognitoError('CodeMismatchException', 'Invalid verification code provided, please try again.');
		});
		assert.deepStrictEqual(
			await failure(mock.browser.request((ctx) => mock.auth.confirmUserAttribute(ctx, 'email', '000000'))),
			await failure(aws.browser.request((ctx) => aws.auth.confirmUserAttribute(ctx, 'email', '000000'))),
		);
	});

	test('deleteUser ends the session in both runtimes; a stale token then signs out with 401', async () => {
		const mock = await mockSignedIn({});
		const aws = await awsSignedIn({});
		aws.h.on('DeleteUserCommand', () => ({}));
		await mock.browser.request((ctx) => mock.auth.deleteUser(ctx));
		await aws.browser.request((ctx) => aws.auth.deleteUser(ctx));
		for (const [b, a] of [
			[mock.browser, mock.auth],
			[aws.browser, aws.auth],
		] as const) {
			assert.strictEqual(await b.request((ctx) => a.getCurrentUser(ctx)), null);
		}
	});
});

describe('parity: TOTP and MFA preferences', () => {
	const MFA = { mfa: { mode: 'optional', types: ['SMS', 'TOTP'] } } as const;

	test('setUpTotp → verifyTotpSetup → getMfaPreference: TOTP enabled and preferred in both runtimes', async () => {
		const mock = await mockSignedIn(MFA);
		const aws = await awsSignedIn(MFA);
		aws.h.on('AssociateSoftwareTokenCommand', () => ({ SecretCode: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP' }));
		aws.h.on('VerifySoftwareTokenCommand', () => ({ Status: 'SUCCESS' }));
		cognitoMfaState(aws.h);

		const results = [];
		for (const { browser, auth } of [mock, aws]) {
			const { sharedSecret } = await browser.request((ctx) => auth.setUpTotp(ctx));
			assert.match(sharedSecret, /^[A-Z2-7]{16,}$/, 'a base32 secret');
			await browser.request((ctx) => auth.verifyTotpSetup(ctx, '123456'));
			results.push(await browser.request((ctx) => auth.getMfaPreference(ctx)));
		}
		assert.deepStrictEqual(results[0], { enabled: ['TOTP'], preferred: 'TOTP' });
		assert.deepStrictEqual(results[0], results[1]);
	});

	test('updateMfaPreference deltas read back the same (PREFERRED moves, NOT_PREFERRED demotes)', async () => {
		const mock = await mockSignedIn(MFA);
		const aws = await awsSignedIn(MFA);
		aws.h.on('AssociateSoftwareTokenCommand', () => ({ SecretCode: 'JBSWY3DPEHPK3PXP' }));
		aws.h.on('VerifySoftwareTokenCommand', () => ({ Status: 'SUCCESS' }));
		cognitoMfaState(aws.h);
		const steps = [
			{ sms: 'PREFERRED' },
			{ totp: 'PREFERRED' },
			{ totp: 'NOT_PREFERRED' },
			{ sms: 'DISABLED' },
		] as const;
		const seen: unknown[][] = [[], []];
		for (const [i, { browser, auth }] of [mock, aws].entries()) {
			await browser.request((ctx) => auth.setUpTotp(ctx));
			await browser.request((ctx) => auth.verifyTotpSetup(ctx, '123456'));
			for (const step of steps) {
				await browser.request((ctx) => auth.updateMfaPreference(ctx, step));
				const pref = await browser.request((ctx) => auth.getMfaPreference(ctx));
				seen[i].push({ ...pref, enabled: [...pref.enabled].sort() });
			}
		}
		assert.deepStrictEqual(seen[0], seen[1]);
		assert.deepStrictEqual(seen[0].at(-1), { enabled: ['TOTP'] });
	});

	test('a rejected TOTP code: EnableSoftwareTokenMFA 400, retriable, in both runtimes', async () => {
		const mock = await mockSignedIn(MFA);
		const aws = await awsSignedIn(MFA);
		aws.h.on('AssociateSoftwareTokenCommand', () => ({ SecretCode: 'JBSWY3DPEHPK3PXP' }));
		aws.h.on('VerifySoftwareTokenCommand', () => {
			throw cognitoError('EnableSoftwareTokenMFAException', 'Code mismatch');
		});
		const views = [];
		for (const { browser, auth } of [mock, aws]) {
			await browser.request((ctx) => auth.setUpTotp(ctx));
			// The mock accepts any 6 digits (DESIGN.md), so drive it with a malformed code.
			views.push(await failure(browser.request((ctx) => auth.verifyTotpSetup(ctx, 'abc'))));
		}
		assert.deepStrictEqual(views[0], {
			name: 'EnableSoftwareTokenMFAException',
			code: 400,
			retriable: true,
			message: clientMessageFor(AuthErrors.EnableSoftwareTokenMFA),
		});
		assert.deepStrictEqual(views[0], views[1]);
	});
});

describe('parity: devices', () => {
	test('scanDevices yields DeviceRecord-shaped entries in both runtimes', async () => {
		const mock = await mockSignedIn({});
		await mock.browser.request((ctx) => mock.auth.rememberDevice(ctx));
		const aws = await awsSignedIn({});
		const now = new Date();
		aws.h.on('ListDevicesCommand', () => ({
			Devices: [
				{
					DeviceKey: 'us-east-1_dev',
					DeviceAttributes: [],
					DeviceCreateDate: now,
					DeviceLastModifiedDate: now,
					DeviceLastAuthenticatedDate: now,
				},
			],
		}));
		const shape = (d: Record<string, unknown>) => Object.keys(d).sort();
		const [fromMock] = await mock.browser.request((ctx) => Array.fromAsync(mock.auth.scanDevices(ctx)));
		const [fromAws] = await aws.browser.request((ctx) => Array.fromAsync(aws.auth.scanDevices(ctx)));
		assert.deepStrictEqual(shape({ ...fromMock }), shape({ ...fromAws }));
		for (const d of [fromMock, fromAws]) {
			assert.ok(d.createDate && !Number.isNaN(Date.parse(d.createDate)), 'ISO-8601 dates');
		}
	});
});

describe('parity: auth.admin', () => {
	const ADMIN = { users: { groups: ['admins'] }, admin: {} } as const;

	test('createUser and getUser report the same AdminUser shape (groups narrowed)', async () => {
		const mock = new MockAuth(root(), 'auth', ADMIN);
		const aws = makeAwsAuth(ADMIN);
		aws.on('AdminCreateUserCommand', () => ({
			User: { Username: 'bob', Enabled: true, Attributes: [{ Name: 'sub', Value: 'sub-bob' }] },
		}));
		aws.on('AdminAddUserToGroupCommand', () => ({}));
		aws.on('AdminGetUserCommand', () => ({
			Username: 'bob',
			Enabled: true,
			UserAttributes: [{ Name: 'sub', Value: 'sub-bob' }],
		}));
		aws.on('AdminListGroupsForUserCommand', () => ({ Groups: [{ GroupName: 'admins' }] }));
		const norm = <T extends { userSub: string; attributes: Partial<Record<string, string>> }>(u: T) => ({
			...u,
			userSub: 'SUB',
			attributes: { ...u.attributes, sub: 'SUB' },
		});
		const created = [
			await mock.admin.createUser('bob', { temporaryPassword: 'Temp-Passw0rd!' }),
			await aws.auth.admin.createUser('bob', { temporaryPassword: 'Temp-Passw0rd!' }),
		];
		assert.deepStrictEqual(norm(created[0]), norm(created[1]));
		await mock.admin.addUserToGroup('bob', 'admins');
		await aws.auth.admin.addUserToGroup('bob', 'admins');
		const read = [await mock.admin.getUser('bob'), await aws.auth.admin.getUser('bob')];
		assert.ok(read[0] && read[1]);
		assert.deepStrictEqual(norm(read[0]), norm(read[1]));
		assert.deepStrictEqual(read[0].groups, ['admins']);
	});

	test('getUser of an unknown user is null in both runtimes (never UserNotFoundException)', async () => {
		const mock = new MockAuth(root(), 'auth', ADMIN);
		const aws = makeAwsAuth(ADMIN);
		aws.on('AdminGetUserCommand', () => {
			throw cognitoError('UserNotFoundException', 'User does not exist.');
		});
		assert.strictEqual(await mock.admin.getUser('ghost'), null);
		assert.strictEqual(await aws.auth.admin.getUser('ghost'), null);
	});

	test('unknown user / unknown group / existing user: the same unmasked errors in both runtimes', async () => {
		const mock = new MockAuth(root(), 'auth', ADMIN);
		await mock.admin.createUser('bob');
		const aws = makeAwsAuth(ADMIN);
		aws.on('AdminDeleteUserCommand', () => {
			throw cognitoError('UserNotFoundException', 'User does not exist.');
		});
		aws.on('ListUsersInGroupCommand', () => {
			throw cognitoError('ResourceNotFoundException', 'Group not found.');
		});
		aws.on('AdminCreateUserCommand', () => {
			throw cognitoError('UsernameExistsException', 'User account already exists');
		});
		// `listUsersInGroup` is typed to the declared groups; an untyped caller can name any.
		const untypedListUsersInGroup = (admin: object, group: string) => {
			const fn: unknown = Reflect.get(admin, 'listUsersInGroup');
			assert.ok(typeof fn === 'function');
			return Promise.resolve(Reflect.apply(fn, admin, [group]));
		};
		const pairs = [
			[
				() => mock.admin.deleteUser('ghost'),
				() => aws.auth.admin.deleteUser('ghost'),
				'UserNotFoundException',
				404,
			],
			[
				() => untypedListUsersInGroup(mock.admin, 'nope'),
				() => untypedListUsersInGroup(aws.auth.admin, 'nope'),
				'ResourceNotFoundException',
				404,
			],
			[
				() => mock.admin.createUser('bob'),
				() => aws.auth.admin.createUser('bob'),
				'UsernameExistsException',
				409,
			],
		] as const;
		for (const [m, a, name, code] of pairs) {
			const views = [await failure(m()), await failure(a())];
			assert.deepStrictEqual(views[0], { name, code, retriable: false, message: clientMessageFor(name) });
			assert.deepStrictEqual(views[0], views[1]);
		}
	});

	test('scan with a filter finds the same users (usernames)', async () => {
		const mock = new MockAuth(root(), 'auth', ADMIN);
		await mock.admin.createUser('bob', { attributes: { email: 'bob@example.com' } });
		await mock.admin.createUser('carol', { attributes: { email: 'carol@example.com' } });
		const aws = makeAwsAuth(ADMIN);
		aws.on('ListUsersCommand', (input) => {
			assert.strictEqual(input.Filter, 'email ^= "bob"');
			return {
				Users: [{ Username: 'bob', Enabled: true, Attributes: [{ Name: 'email', Value: 'bob@example.com' }] }],
			};
		});
		const filter = { attribute: 'email', match: 'startsWith', value: 'bob' } as const;
		const names = async (it: AsyncIterable<{ username: string }>) =>
			(await Array.fromAsync(it)).map((u) => u.username);
		assert.deepStrictEqual(await names(mock.admin.scan(filter)), ['bob']);
		assert.deepStrictEqual(await names(aws.auth.admin.scan(filter)), ['bob']);
	});

	test('revokeUserSessions signs the user out immediately in both runtimes', async () => {
		const mock = await mockSignedIn(ADMIN);
		const aws = await awsSignedIn(ADMIN);
		aws.h.on('AdminUserGlobalSignOutCommand', () => ({}));
		await mock.auth.admin.revokeUserSessions('alice');
		await aws.auth.admin.revokeUserSessions('alice');
		assert.strictEqual(await mock.browser.request((ctx) => mock.auth.getCurrentUser(ctx)), null);
		assert.strictEqual(await aws.browser.request((ctx) => aws.auth.getCurrentUser(ctx)), null);
	});

	test('a disabled user fails sign-in with the same uniform credential error in both runtimes', async () => {
		const mock = new MockAuth(root(), 'auth', ADMIN);
		await mock.signUp('dan', PASSWORD);
		await mock.admin.disableUser('dan');
		const aws = makeAwsAuth(ADMIN);
		aws.on('AdminDisableUserCommand', () => ({}));
		await aws.auth.admin.disableUser('dan');
		aws.on('InitiateAuthCommand', () => {
			throw cognitoError('NotAuthorizedException', 'User is disabled.');
		});
		const views = [
			await new Browser().request((ctx) => failure(mock.signIn('dan', PASSWORD, ctx))),
			await new Browser().request((ctx) => failure(aws.auth.signIn('dan', PASSWORD, ctx))),
		];
		assert.deepStrictEqual(views[0], {
			name: 'NotAuthorizedException',
			code: 401,
			retriable: false,
			message: INCORRECT_CREDENTIALS_MESSAGE,
		});
		assert.deepStrictEqual(views[0], views[1]);
	});
});

describe('parity: restored options (L22)', () => {
	test('users.preferredChallenge: EMAIL_OTP opens with the same passwordless step in both runtimes', async () => {
		const options = { users: { authFlow: 'USER_AUTH', preferredChallenge: 'EMAIL_OTP' } } as const;
		const codes: string[] = [];
		const mock = new MockAuth(root(), 'auth', {
			...options,
			codeDelivery: async (_u: string, code: string) => {
				codes.push(code);
			},
		});
		await mock.signUp('alice', PASSWORD, { attributes: { email: 'alice@example.com' } });
		await mock.confirmSignUp('alice', codes.at(-1) ?? '');
		const aws = makeAwsAuth(options);
		aws.on('InitiateAuthCommand', () => ({
			ChallengeName: 'EMAIL_OTP',
			Session: 'cog-otp',
			ChallengeParameters: {
				CODE_DELIVERY_DESTINATION: 'a***@e***',
				CODE_DELIVERY_DELIVERY_MEDIUM: 'EMAIL',
			},
		}));
		const steps = [
			await new Browser().request((ctx) => mock.signIn('alice', '', ctx)),
			await new Browser().request((ctx) => aws.auth.signIn('alice', '', ctx)),
		].map((r) => {
			assert.ok(r.status === 'continueSignIn');
			const { session: _s, ...rest } = { session: '', ...r.nextStep };
			return rest;
		});
		assert.strictEqual(steps[0].name, 'CONFIRM_SIGN_IN_WITH_FIRST_FACTOR_EMAIL_OTP');
		assert.deepStrictEqual(steps[0], steps[1]);
	});

	test('passkey transports and authenticatorAttachment are reported the same way in both runtimes', async () => {
		const options = {
			users: { authFlow: 'USER_AUTH' },
			passkeys: { relyingPartyId: 'localhost', origins: ['http://localhost:3000'] },
		} as const;
		const codes: string[] = [];
		const mock = new MockAuth(root(), 'auth', {
			...options,
			codeDelivery: async (_u: string, code: string) => {
				codes.push(code);
			},
		});
		await mock.signUp('alice', PASSWORD, { attributes: { email: 'alice@example.com' } });
		await mock.confirmSignUp('alice', codes.at(-1) ?? '');
		const mb = new Browser();
		const first = await mb.request((ctx) => mock.signIn('alice', '', ctx, { preferredChallenge: 'PASSWORD' }));
		assert.ok(first.status === 'continueSignIn' && first.nextStep.name === 'CONFIRM_SIGN_IN_WITH_PASSWORD');
		const pwSession = first.nextStep.session;
		await mb.request((ctx) => mock.confirmSignIn(pwSession, PASSWORD, ctx));
		await mb.request((ctx) =>
			mock.completePasskeyRegistration(
				ctx,
				JSON.stringify({
					id: 'cred-1',
					type: 'public-key',
					authenticatorAttachment: 'cross-platform',
					response: { transports: ['usb', 'nfc'] },
				}),
			),
		);

		const aws = await awsSignedIn(options);
		aws.h.on('ListWebAuthnCredentialsCommand', () => ({
			Credentials: [
				{
					CredentialId: 'cred-1',
					RelyingPartyId: 'localhost',
					AuthenticatorTransports: ['usb', 'nfc'],
					AuthenticatorAttachment: 'cross-platform',
					CreatedAt: new Date(),
				},
			],
		}));
		const strip = (list: { createdAt?: string }[]) => list.map(({ createdAt: _c, ...rest }) => rest);
		const fromMock = await mb.request((ctx) => mock.listPasskeys(ctx));
		const fromAws = await aws.browser.request((ctx) => aws.auth.listPasskeys(ctx));
		assert.deepStrictEqual(strip(fromMock), [
			{ credentialId: 'cred-1', transports: ['usb', 'nfc'], authenticatorAttachment: 'cross-platform' },
		]);
		assert.deepStrictEqual(strip(fromMock), strip(fromAws));
	});
});

describe('parity: account-state hiding on the confirm / resend steps (FX3)', () => {
	/** The full client view of a rejection (message included — these are user-facing). */
	async function wire(p: Promise<unknown>): Promise<ReturnType<typeof wireView>> {
		return wireView(
			await p.then(
				() => assert.fail('expected a rejection'),
				(err: unknown) => err,
			),
		);
	}

	for (const revealExistingUsers of [false, true]) {
		test(`revealExistingUsers: ${revealExistingUsers} — an already-confirmed user`, async () => {
			const options = { emailPassword: { revealExistingUsers } };
			const { auth: mock } = await mockSignedIn(options);
			const h = makeAwsAuth(options);
			// What Cognito answers for a CONFIRMED user.
			h.on('ConfirmSignUpCommand', () => {
				throw cognitoError('NotAuthorizedException', 'User cannot be confirmed. Current status is CONFIRMED');
			});
			h.on('ResendConfirmationCodeCommand', () => {
				throw cognitoError('InvalidParameterException', 'User is already confirmed.');
			});
			// The wide views: password configurations only.
			const m: MockAuth = mock;
			const a: typeof m = h.auth;
			assert.deepStrictEqual(
				await wire(m.confirmSignUp('alice', '000000')),
				await wire(a.confirmSignUp('alice', '000000')),
			);
			if (revealExistingUsers) {
				assert.deepStrictEqual(
					await wire(m.resendSignUpCode('alice')),
					await wire(a.resendSignUpCode('alice')),
				);
			} else {
				assert.strictEqual(await m.resendSignUpCode('alice'), undefined);
				assert.strictEqual(await a.resendSignUpCode('alice'), undefined);
			}
		});
	}
});

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

describe('parity: displayName honours the ID token’s `*_verified` flags (R64, FX31)', () => {
	// An email-only pool: the username is generated (= `sub`), so the display
	// name is the email when it is verified, else `preferred_username`.
	const EMAIL_ONLY = { users: { signInWith: ['email'] } } as const;
	const PROFILE = { preferred_username: 'ali' };

	/** A local user signed up with a verified email, signed in on a browser, and its `getAuthState`. */
	async function mockUser() {
		const codes: string[] = [];
		const auth = new MockAuth(root(), 'auth', {
			...EMAIL_ONLY,
			codeDelivery: async (_u: string, code: string) => {
				codes.push(code);
			},
		});
		await auth.signUp('alice@example.com', PASSWORD, { attributes: PROFILE });
		await auth.confirmSignUp('alice@example.com', codes.at(-1) ?? '');
		const browser = new Browser();
		await browser.request((ctx) => auth.signIn('alice@example.com', PASSWORD, ctx));
		const api = auth.createApi();
		const state = () => browser.request((ctx) => bindAuthApi(api, ctx).getAuthState());
		return { auth, browser, state };
	}

	/** The AWS `Auth` with a generated-username user whose ID token carries `claims`, and its `getAuthState`. */
	async function awsUser(claims: Record<string, unknown>) {
		const h = makeAwsAuth(EMAIL_ONLY);
		const browser = new Browser();
		const generated = 'c8f4e2a0-0000-4000-8000-00000000a11c';
		const result = (c: Record<string, unknown>) =>
			h.idp.authResult(generated, { claims: { sub: generated, ...c } });
		await signInAs(h, browser, generated, result(claims));
		const api = h.auth.createApi();
		const state = () => browser.request((ctx) => bindAuthApi(api, ctx).getAuthState());
		/** What the next refresh (`InitiateAuth` REFRESH_TOKEN_AUTH) answers. */
		const refreshesTo = (c: Record<string, unknown>) =>
			h.on('InitiateAuthCommand', () => ({ AuthenticationResult: result(c) }));
		return { h, auth: h.auth, browser, state, refreshesTo };
	}

	test('a verified email is the display name in both runtimes', async () => {
		const mock = await mockUser();
		const aws = await awsUser({ email: 'alice@example.com', email_verified: true, ...PROFILE });
		for (const [label, { state }] of [
			['mock', mock],
			['aws', aws],
		] as const) {
			const s = await state();
			assert.strictEqual(s.state, 'signedIn', label);
			assert.strictEqual(s.user?.displayName, 'alice@example.com', `${label}: the verified email`);
		}
	});

	test('an email changed with updateUserAttributes and not yet confirmed is skipped in both runtimes', async () => {
		const mock = await mockUser();
		const aws = await awsUser({ email: 'alice@example.com', email_verified: true, ...PROFILE });
		aws.h.on('UpdateUserAttributesCommand', () => ({
			CodeDeliveryDetailsList: [{ Destination: 'n***@e***', DeliveryMedium: 'EMAIL', AttributeName: 'email' }],
		}));
		// Cognito (no `keepOriginal`): the email changes at once and is unverified until its code is confirmed.
		aws.refreshesTo({ email: 'new@example.com', email_verified: false, ...PROFILE });

		for (const [label, { auth, browser, state }] of [
			['mock', mock],
			['aws', aws],
		] as const) {
			await browser.request((ctx) => auth.updateUserAttributes(ctx, { email: 'new@example.com' }));
			await browser.request((ctx) => auth.getAuthSession(ctx, { forceRefresh: true }));
			const user = await browser.request((ctx) => auth.requireAuth(ctx));
			assert.strictEqual(user.attributes.email, 'new@example.com', `${label}: the session carries the new email`);
			assert.strictEqual(
				user.attributes.email_verified,
				undefined,
				`${label}: no \`*_verified\` attribute (FX26)`,
			);
			const s = await state();
			assert.strictEqual(s.user?.displayName, 'ali', `${label}: the unverified email is skipped`);
		}
	});
});

describe('parity: ID-token claims Cognito types as non-strings — `updated_at`, `address` (FX31)', () => {
	test('requireAuth().attributes leave them out and the ID token carries a number and an object, in both runtimes', async () => {
		const profile = { address: '1 Main St, Springfield', updated_at: '1700000000' };
		const codes: string[] = [];
		const mockAuth = new MockAuth(root(), 'auth', {
			codeDelivery: async (_u: string, code: string) => {
				codes.push(code);
			},
		});
		await mockAuth.signUp('alice', PASSWORD, { attributes: { email: 'alice@example.com', ...profile } });
		await mockAuth.confirmSignUp('alice', codes.at(-1) ?? '');
		const mockBrowser = new Browser();
		await mockBrowser.request((ctx) => mockAuth.signIn('alice', PASSWORD, ctx));

		const h = makeAwsAuth({});
		const awsBrowser = new Browser();
		const claims = {
			email: 'alice@example.com',
			email_verified: true,
			address: { formatted: profile.address },
			updated_at: Number(profile.updated_at),
		};
		await signInAs(h, awsBrowser, 'alice', h.idp.authResult('alice', { claims }));
		h.on('InitiateAuthCommand', () => ({ AuthenticationResult: h.idp.authResult('alice', { claims }) }));

		for (const [label, browser, auth] of [
			['mock', mockBrowser, mockAuth],
			['aws', awsBrowser, h.auth],
		] as const) {
			const user = await browser.request((ctx) => auth.requireAuth(ctx));
			assert.deepStrictEqual(
				user.attributes,
				{ email: 'alice@example.com' },
				`${label}: requireAuth().attributes`,
			);
			const session = await browser.request((ctx) => auth.getAuthSession(ctx, { forceRefresh: true }));
			const payload = session.tokens?.idToken.payload ?? {};
			assert.deepStrictEqual(payload.address, { formatted: profile.address }, `${label}: ID token address`);
			assert.strictEqual(payload.updated_at, 1700000000, `${label}: ID token updated_at`);
			const refreshed = await browser.request((ctx) => auth.requireAuth(ctx));
			assert.deepStrictEqual(refreshed.attributes, { email: 'alice@example.com' }, `${label}: after a refresh`);
		}
	});
});

describe('parity: confirmSignUp verifies only the contact the code was sent to (R67, FX34)', () => {
	type Contact = 'email' | 'phone_number';
	const CONTACTS: readonly Contact[] = ['email', 'phone_number'];
	const EMAIL = 'alice@example.com';
	const PHONE = '+15555550100';
	const MFA = { mode: 'optional', types: ['SMS', 'TOTP'] } as const;

	/** `{ Name, Value }[]` (a Cognito attribute list) → a record. */
	function attributesOf(list: unknown): Record<string, string> {
		const out: Record<string, string> = {};
		for (const entry of Array.isArray(list) ? list : []) {
			const name: unknown = Reflect.get(entry, 'Name');
			const value: unknown = Reflect.get(entry, 'Value');
			if (typeof name === 'string' && typeof value === 'string') out[name] = value;
		}
		return out;
	}

	/**
	 * A stateful stand-in for one Cognito user pool's sign-up verification,
	 * answering as the developer guide ("Signing up and confirming user
	 * accounts") says Cognito does, for a pool whose `AutoVerifiedAttributes`
	 * are `autoVerified` (the CDK layer sets them to the contact members of
	 * `signInWith` — `mapAutoVerify`):
	 *
	 * - `SignUp` sends **one** code. "In cases where Amazon Cognito must choose
	 *   between verifying an email address or phone number, it chooses to verify
	 *   the phone number": by SMS when the phone is auto-verified and present,
	 *   else by email when the email is. The new user's contact attributes are
	 *   unverified ("the user's email address and phone number are unverified").
	 * - `ConfirmSignUp` "marks the attribute that was used to confirm (email
	 *   address or phone number) as verified" — that one only.
	 * - `GetUserAttributeVerificationCode` + `VerifyUserAttribute` verify the
	 *   named attribute.
	 * - The ID token carries the `*_verified` flags as booleans.
	 *
	 * `generated`: a username-attribute pool (`signInWith` without
	 * `'username'`), whose stored username is the `sub`.
	 */
	function cognitoPool(h: Pick<AwsAuthHarness<AuthOptions>, 'on' | 'idp'>, autoVerified: readonly Contact[]) {
		const sub = 'c8f4e2a0-0000-4000-8000-00000000a11c';
		let username = '';
		let attributes: Record<string, string> = {};
		let delivered: Contact | undefined;
		const delivery = (name: Contact) => ({
			Destination: name === 'email' ? 'a***@e***' : '+*******0100',
			DeliveryMedium: name === 'email' ? 'EMAIL' : 'SMS',
			AttributeName: name,
		});
		const claims = () => {
			const out: Record<string, unknown> = { sub, ...attributes };
			for (const c of CONTACTS) {
				const flag = attributes[`${c}_verified`];
				if (flag !== undefined) out[`${c}_verified`] = flag === 'true';
			}
			return out;
		};
		h.on('SignUpCommand', (input) => {
			username = input.Username === EMAIL || input.Username === PHONE ? sub : String(input.Username);
			attributes = attributesOf(input.UserAttributes);
			for (const c of CONTACTS) if (attributes[c]) attributes[`${c}_verified`] = 'false';
			delivered = (['phone_number', 'email'] as const).find((c) => autoVerified.includes(c) && attributes[c]);
			return {
				UserConfirmed: false,
				UserSub: sub,
				...(delivered ? { CodeDeliveryDetails: delivery(delivered) } : {}),
			};
		});
		h.on('ConfirmSignUpCommand', () => {
			if (delivered) attributes[`${delivered}_verified`] = 'true';
			return {};
		});
		h.on('InitiateAuthCommand', () => ({ AuthenticationResult: h.idp.authResult(username, { claims: claims() }) }));
		h.on('GetUserCommand', () => ({
			Username: username,
			UserAttributes: Object.entries({ sub, ...attributes }).map(([Name, Value]) => ({ Name, Value })),
		}));
		h.on('GetUserAttributeVerificationCodeCommand', (input) => {
			const name = input.AttributeName === 'email' ? 'email' : 'phone_number';
			return { CodeDeliveryDetails: delivery(name) };
		});
		h.on('VerifyUserAttributeCommand', (input) => {
			attributes[`${String(input.AttributeName)}_verified`] = 'true';
			return {};
		});
	}

	/**
	 * Sign `login` up with `contact`, confirm with the code, and sign in — on the
	 * local pool and on the AWS entry against {@link cognitoPool}. Returns both,
	 * each with what `signUp` said about the code.
	 */
	async function bothRuntimes<const O extends AuthOptions>(
		options: O,
		login: string,
		contact: Partial<Record<Contact, string>>,
	) {
		const codes: { purpose: CodeDeliveryPurpose; code: string }[] = [];
		const mockAuth = new MockAuth(root(), 'auth', {
			...options,
			codeDelivery: async (_u: string, code: string, purpose: CodeDeliveryPurpose) => {
				codes.push({ purpose, code });
			},
		});
		const lastCode = (purpose: CodeDeliveryPurpose) =>
			[...codes].reverse().find((c) => c.purpose === purpose)?.code ?? '';
		const h = makeAwsAuth(options);
		const autoVerified: Contact[] = [];
		const signInWith = options.users?.signInWith ?? ['username', 'email'];
		if (signInWith.includes('email')) autoVerified.push('email');
		if (signInWith.includes('phone')) autoVerified.push('phone_number');
		cognitoPool(h, autoVerified);

		const out = [];
		for (const [label, auth, code] of [
			['mock', mockAuth, lastCode],
			['aws', h.auth, () => '123456'],
		] as const) {
			// The wide `Auth` view: password configurations only.
			const wide: MockAuth = auth;
			const signedUp = await wide.signUp(login, PASSWORD, { attributes: contact });
			await wide.confirmSignUp(login, code('signUp'));
			const browser = new Browser();
			const r = await browser.request((ctx) => wide.signIn(login, PASSWORD, ctx));
			assert.strictEqual(r.status, 'signedIn', label);
			const delivery = signedUp.nextStep?.codeDeliveryDetails;
			out.push({
				label,
				auth,
				browser,
				code,
				sentTo: { deliveryMedium: delivery?.deliveryMedium, attributeName: delivery?.attributeName },
			});
		}
		return out;
	}

	/** What a caller can read of the verified flags: `getUserAttributes` and the ID token. */
	async function verifiedFlags(run: Awaited<ReturnType<typeof bothRuntimes>>[number]) {
		const { auth, browser } = run;
		const attrs = await browser.request((ctx) => auth.getUserAttributes(ctx));
		const session = await browser.request((ctx) => auth.getAuthSession(ctx, { forceRefresh: true }));
		const payload = session.tokens?.idToken.payload ?? {};
		return {
			attributes: { email_verified: attrs.email_verified, phone_number_verified: attrs.phone_number_verified },
			idToken: { email_verified: payload.email_verified, phone_number_verified: payload.phone_number_verified },
		};
	}

	test('email auto-verified (the default pool), email + phone: the code goes to the email; the phone stays unverified', async () => {
		const runs = await bothRuntimes({ mfa: MFA }, 'alice', { email: EMAIL, phone_number: PHONE });
		for (const run of runs) {
			assert.deepStrictEqual(run.sentTo, { deliveryMedium: 'EMAIL', attributeName: 'email' }, run.label);
			assert.deepStrictEqual(
				await verifiedFlags(run),
				{
					attributes: { email_verified: 'true', phone_number_verified: 'false' },
					idToken: { email_verified: true, phone_number_verified: false },
				},
				`${run.label}: only the email is verified`,
			);
			// An unverified phone is no SMS factor.
			assert.deepStrictEqual(
				await run.browser.request((ctx) => run.auth.getMfaPreference(ctx)),
				{ enabled: [] },
				`${run.label}: getMfaPreference`,
			);
		}
	});

	test('the phone verified explicitly afterwards (sendUserAttributeVerificationCode → confirmUserAttribute)', async () => {
		const runs = await bothRuntimes({ mfa: MFA }, 'alice', { email: EMAIL, phone_number: PHONE });
		for (const run of runs) {
			const { auth, browser, code } = run;
			await browser.request((ctx) => auth.sendUserAttributeVerificationCode(ctx, 'phone_number'));
			await browser.request((ctx) => auth.confirmUserAttribute(ctx, 'phone_number', code('attribute')));
			assert.deepStrictEqual(
				await verifiedFlags(run),
				{
					attributes: { email_verified: 'true', phone_number_verified: 'true' },
					idToken: { email_verified: true, phone_number_verified: true },
				},
				`${run.label}: both verified`,
			);
		}
	});

	test('email and phone both auto-verified, both given: Cognito picks the phone (SMS); the email stays unverified', async () => {
		const options = { users: { signInWith: ['email', 'phone'] } } as const;
		const runs = await bothRuntimes(options, EMAIL, { email: EMAIL, phone_number: PHONE });
		for (const run of runs) {
			assert.deepStrictEqual(run.sentTo, { deliveryMedium: 'SMS', attributeName: 'phone_number' }, run.label);
			assert.deepStrictEqual(
				await verifiedFlags(run),
				{
					attributes: { email_verified: 'false', phone_number_verified: 'true' },
					idToken: { email_verified: false, phone_number_verified: true },
				},
				`${run.label}: only the phone is verified`,
			);
			// The unverified email is skipped for the display name (R34): the phone.
			const api = run.auth.createApi();
			const state = await run.browser.request((ctx) => bindAuthApi(api, ctx).getAuthState());
			assert.strictEqual(state.user?.displayName, PHONE, `${run.label}: displayName`);
		}
	});

	test('email and phone both auto-verified, email only: the code goes to the email', async () => {
		const options = { users: { signInWith: ['email', 'phone'] } } as const;
		const runs = await bothRuntimes(options, EMAIL, { email: EMAIL });
		for (const run of runs) {
			assert.deepStrictEqual(run.sentTo, { deliveryMedium: 'EMAIL', attributeName: 'email' }, run.label);
			assert.deepStrictEqual(
				await verifiedFlags(run),
				{
					attributes: { email_verified: 'true', phone_number_verified: undefined },
					idToken: { email_verified: true, phone_number_verified: undefined },
				},
				run.label,
			);
		}
	});

	test('phone auto-verified only, phone + email: the code goes to the phone; the email stays unverified', async () => {
		const options = { users: { signInWith: ['phone'] } } as const;
		const runs = await bothRuntimes(options, PHONE, { email: EMAIL, phone_number: PHONE });
		for (const run of runs) {
			assert.deepStrictEqual(run.sentTo, { deliveryMedium: 'SMS', attributeName: 'phone_number' }, run.label);
			assert.deepStrictEqual(
				await verifiedFlags(run),
				{
					attributes: { email_verified: 'false', phone_number_verified: 'true' },
					idToken: { email_verified: false, phone_number_verified: true },
				},
				run.label,
			);
		}
	});

	test('admin.createUser verifies nothing by itself: only the `*_verified` flags the admin sets', async () => {
		const ADMIN = { admin: {} } as const;
		const mock = new MockAuth(root(), 'auth', ADMIN);
		const aws = makeAwsAuth(ADMIN);
		// Cognito's AdminCreateUser stores the attributes as given.
		let stored: Record<string, string> = {};
		aws.on('AdminCreateUserCommand', (input) => {
			stored = { sub: 'sub-bob', ...attributesOf(input.UserAttributes) };
			return {
				User: {
					Username: 'bob',
					Enabled: true,
					Attributes: Object.entries(stored).map(([Name, Value]) => ({ Name, Value })),
				},
			};
		});
		aws.on('AdminGetUserCommand', () => ({
			Username: 'bob',
			Enabled: true,
			UserAttributes: Object.entries(stored).map(([Name, Value]) => ({ Name, Value })),
		}));
		aws.on('AdminListGroupsForUserCommand', () => ({ Groups: [] }));
		aws.on('AdminDeleteUserCommand', () => ({}));
		for (const attributes of [
			{ email: EMAIL, phone_number: PHONE },
			{ email: EMAIL, email_verified: 'true', phone_number: PHONE },
		]) {
			const seen = [];
			for (const auth of [mock, aws.auth]) {
				await auth.admin.deleteUser('bob').catch(() => {});
				await auth.admin.createUser('bob', { temporaryPassword: 'Temp-Passw0rd!', attributes });
				const user = await auth.admin.getUser('bob');
				seen.push({
					email_verified: user?.attributes.email_verified,
					phone_number_verified: user?.attributes.phone_number_verified,
				});
			}
			assert.deepStrictEqual(seen[0], {
				email_verified: attributes.email_verified,
				phone_number_verified: undefined,
			});
			assert.deepStrictEqual(seen[0], seen[1]);
		}
	});
});
