// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * AWS runtime — live-group authorization (`requireRole`, #583) and attribute
 * filtering, against a spied Cognito client (no network).
 *
 * Ported from `bb-auth-cognito/src/index.aws.groups.test.ts` (B5). Where an
 * expectation differs it says why, inline (`Auth:`). Renames (D3): `groups` →
 * `users.groups`, `userAttributes` → `users.attributes`. The attribute
 * read/write and admin tests were `todo` until D5c2 implemented those engine
 * members. Harness: `test-support/aws-harness.ts`.
 */

import assert from 'node:assert';
import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { isBlocksError, registerSdkIdentifiers } from '@aws-blocks/core';
import { INTERNAL_ERROR_MESSAGE } from './error-mapping.js';
import { AuthErrors } from './index.aws.js';
import {
	Browser,
	captureLogger,
	cognitoError,
	makeAwsAuth,
	signInAs,
	TEST_POOL_ID,
} from './test-support/aws-harness.js';

beforeEach(() => rmSync('.bb-data', { recursive: true, force: true }));
afterEach(() => rmSync('.bb-data', { recursive: true, force: true }));

function groupsReply(...names: string[]) {
	return { Groups: names.map((GroupName) => ({ GroupName, UserPoolId: TEST_POOL_ID })) };
}

describe('AWS requireRole — live group reads', () => {
	test('sends AdminListGroupsForUser for the session user and allows a member', async () => {
		const h = makeAwsAuth({ users: { groups: ['admins', 'editors'] } });
		const b = new Browser();
		await signInAs(h, b, 'alice');
		h.on('AdminListGroupsForUserCommand', () => groupsReply('admins'));
		const user = await b.request((ctx) => h.auth.requireRole(ctx, 'admins'));
		assert.strictEqual(user.username, 'alice');
		assert.deepStrictEqual(user.groups, ['admins']);
		assert.deepStrictEqual(h.sent, [
			{ name: 'AdminListGroupsForUserCommand', input: { UserPoolId: TEST_POOL_ID, Username: 'alice' } },
		]);
	});

	test('one AdminListGroupsForUser per request, however many requireRole calls (sequential + concurrent)', async () => {
		const h = makeAwsAuth({ users: { groups: ['admins', 'editors'] } });
		const b = new Browser();
		await signInAs(h, b, 'alice');
		h.on('AdminListGroupsForUserCommand', () => groupsReply('admins', 'editors'));
		await b.request(async (ctx) => {
			await h.auth.requireRole(ctx, 'admins');
			await h.auth.requireRole(ctx, 'editors');
			await Promise.all([h.auth.requireRole(ctx, 'admins'), h.auth.requireRole(ctx, 'editors')]);
		});
		assert.deepStrictEqual(h.sentNames(), ['AdminListGroupsForUserCommand']);
	});

	test('a new request reads membership again (the memo is per request, not per instance)', async () => {
		const h = makeAwsAuth({ users: { groups: ['admins'] } });
		const b = new Browser();
		await signInAs(h, b, 'alice');
		h.on('AdminListGroupsForUserCommand', () => groupsReply('admins'));
		await b.request((ctx) => h.auth.requireRole(ctx, 'admins'));
		h.on('AdminListGroupsForUserCommand', () => groupsReply());
		await assert.rejects(() => b.request((ctx) => h.auth.requireRole(ctx, 'admins')));
		assert.deepStrictEqual(h.sentNames(), ['AdminListGroupsForUserCommand', 'AdminListGroupsForUserCommand']);
	});

	test('membership comes from Cognito, not the token claim: a revoked member is refused', async () => {
		const h = makeAwsAuth({ users: { groups: ['admins'] } });
		const b = new Browser();
		await signInAs(h, b, 'alice', h.idp.authResult('alice', { claims: { 'cognito:groups': ['admins'] } }));
		h.on('AdminListGroupsForUserCommand', () => groupsReply());
		await assert.rejects(
			() => b.request((ctx) => h.auth.requireRole(ctx, 'admins')),
			(e: Error & { status?: number }) => {
				assert.strictEqual(e.status, 403);
				assert.ok(isBlocksError(e, AuthErrors.NotAuthorized));
				assert.strictEqual(e.message, "Not in group 'admins'");
				return true;
			},
		);
	});

	test('membership comes from Cognito, not the token claim: a newly-added member is allowed', async () => {
		const h = makeAwsAuth({ users: { groups: ['admins'] } });
		const b = new Browser();
		await signInAs(h, b, 'alice');
		h.on('AdminListGroupsForUserCommand', () => groupsReply('admins'));
		const user = await b.request((ctx) => h.auth.requireRole(ctx, 'admins'));
		assert.deepStrictEqual(user.groups, ['admins'], 'returned groups reflect the live read');
	});

	test('returned groups are narrowed to the declared set', async () => {
		const h = makeAwsAuth({ users: { groups: ['admins', 'editors'] } });
		const b = new Browser();
		await signInAs(h, b, 'alice');
		h.on('AdminListGroupsForUserCommand', () => groupsReply('out-of-band', 'admins', 'legacy'));
		const user = await b.request((ctx) => h.auth.requireRole(ctx, 'admins'));
		assert.deepStrictEqual(user.groups, ['admins']);
	});

	test('declared groups given as objects narrow the same way', async () => {
		const h = makeAwsAuth({ users: { groups: [{ name: 'admins', description: 'Admins' }, 'editors'] } });
		const b = new Browser();
		await signInAs(h, b, 'alice');
		h.on('AdminListGroupsForUserCommand', () => groupsReply('editors', 'out-of-band'));
		const user = await b.request((ctx) => h.auth.requireRole(ctx, 'editors'));
		assert.deepStrictEqual(user.groups, ['editors']);
	});

	test('no declared groups → the raw live list is returned', async () => {
		const h = makeAwsAuth();
		const b = new Browser();
		await signInAs(h, b, 'alice');
		h.on('AdminListGroupsForUserCommand', () => groupsReply('a', 'b'));
		const user = await b.request((ctx) => h.auth.requireRole(ctx, 'b'));
		assert.deepStrictEqual(user.groups, ['a', 'b']);
	});

	test('paginates with NextToken and decides on the accumulated list', async () => {
		const h = makeAwsAuth({ users: { groups: ['g1', 'g2'] } });
		const b = new Browser();
		await signInAs(h, b, 'alice');
		h.on('AdminListGroupsForUserCommand', (input) =>
			input.NextToken === 'page2' ? groupsReply('g2') : { ...groupsReply('g1'), NextToken: 'page2' },
		);
		const user = await b.request((ctx) => h.auth.requireRole(ctx, 'g2'));
		assert.deepStrictEqual(user.groups, ['g1', 'g2']);
		assert.deepStrictEqual(
			h.sent.map((c) => c.input),
			[
				{ UserPoolId: TEST_POOL_ID, Username: 'alice' },
				{ UserPoolId: TEST_POOL_ID, Username: 'alice', NextToken: 'page2' },
			],
		);
	});

	test('UserNotFoundException (user deleted under a live session) → 403 NotAuthorized, fail-closed', async () => {
		const h = makeAwsAuth({ users: { groups: ['admins'] } });
		const b = new Browser();
		await signInAs(h, b, 'alice');
		h.on('AdminListGroupsForUserCommand', () => {
			throw cognitoError('UserNotFoundException', 'User does not exist.');
		});
		await assert.rejects(
			() => b.request((ctx) => h.auth.requireRole(ctx, 'admins')),
			(e: Error & { status?: number }) => {
				assert.strictEqual(e.status, 403);
				assert.strictEqual(e.name, AuthErrors.NotAuthorized);
				assert.strictEqual(e.message, 'Not authorized');
				assert.ok(!JSON.stringify(e).includes('$metadata'));
				return true;
			},
		);
	});

	test('a transient failure is not cached: a later requireRole in the same request retries', async () => {
		const h = makeAwsAuth({ users: { groups: ['admins'] } });
		const b = new Browser();
		await signInAs(h, b, 'alice');
		let calls = 0;
		h.on('AdminListGroupsForUserCommand', () => {
			if (++calls === 1) throw cognitoError('TooManyRequestsException', 'Rate exceeded');
			return groupsReply('admins');
		});
		await b.request(async (ctx) => {
			await assert.rejects(
				() => h.auth.requireRole(ctx, 'admins'),
				(e: Error & { status?: number }) => e.status === 429 && e.name === 'TooManyRequestsException',
			);
			const user = await h.auth.requireRole(ctx, 'admins');
			assert.deepStrictEqual(user.groups, ['admins']);
		});
		assert.strictEqual(calls, 2);
	});

	test('missing user-pool discovery → refused without a Cognito call', async () => {
		const h = makeAwsAuth({ users: { groups: ['admins'] }, logger: captureLogger().logger });
		const b = new Browser();
		await signInAs(h, b, 'alice');
		registerSdkIdentifiers(h.fullId, { userPoolId: '' });
		await assert.rejects(
			() => b.request((ctx) => h.auth.requireRole(ctx, 'admins')),
			(e: Error & { status?: number }) => {
				// Auth: the generic InternalError message (`userPoolNotProvisioned`,
				// detail in the log) — AuthCognito said 'Cognito user pool not configured'.
				assert.strictEqual(e.message, INTERNAL_ERROR_MESSAGE);
				assert.strictEqual(e.name, AuthErrors.InternalError);
				// A server misconfiguration stays a 500 (was re-wrapped into a 400).
				assert.strictEqual(e.status, 500);
				return true;
			},
		);
		assert.deepStrictEqual(h.sent, []);
	});
});

describe('AWS attribute filtering', () => {
	test('user.attributes keeps string claims only, dropping reserved JWT and cognito: claims', async () => {
		const h = makeAwsAuth();
		const b = new Browser();
		await signInAs(
			h,
			b,
			'alice',
			h.idp.authResult('alice', {
				claims: {
					email: 'alice@example.com',
					// Real Cognito ID tokens carry this as a boolean → dropped.
					email_verified: true,
					'custom:department': 'eng',
					'cognito:groups': ['admins'],
					'cognito:roles': ['arn:aws:iam::123456789012:role/x'],
					'cognito:preferred_role': 'arn:aws:iam::123456789012:role/x',
					identities: [{ providerName: 'Google' }],
					some_number: 7,
				},
			}),
		);
		const user = await b.request((ctx) => h.auth.getCurrentUser(ctx));
		assert.deepStrictEqual(user, {
			userId: 'alice',
			username: 'alice',
			userSub: 'sub-alice',
			groups: ['admins'],
			attributes: { email: 'alice@example.com', 'custom:department': 'eng' },
			// Auth: `AuthenticatedUser` adds `signInProvider` (design 04).
			signInProvider: 'password',
		});
	});

	// Auth: `fetchUserAttributes` is `getUserAttributes` (D3 rename).
	test('fetchUserAttributes sends GetUser with the access token and returns name/value pairs', async () => {
		const h = makeAwsAuth();
		const b = new Browser();
		const tokens = h.idp.authResult('alice');
		await signInAs(h, b, 'alice', tokens);
		h.on('GetUserCommand', () => ({
			Username: 'alice',
			UserAttributes: [
				{ Name: 'sub', Value: 'sub-alice' },
				{ Name: 'email', Value: 'alice@example.com' },
				{ Name: 'email_verified', Value: 'true' },
				{ Name: 'custom:department', Value: 'eng' },
				{ Name: 'no_value' },
			],
		}));
		const attrs = await b.request((ctx) => h.auth.getUserAttributes(ctx));
		assert.deepStrictEqual(h.sent, [{ name: 'GetUserCommand', input: { AccessToken: tokens.AccessToken } }]);
		// Live read: every attribute with a value, including `sub` and `custom:` names.
		assert.deepStrictEqual(attrs, {
			sub: 'sub-alice',
			email: 'alice@example.com',
			email_verified: 'true',
			'custom:department': 'eng',
		});
	});

	test('updateUserAttributes prefixes declared custom attrs and reports per-attribute outcomes', async () => {
		const h = makeAwsAuth({ users: { attributes: [{ name: 'department', type: 'String', mutable: true }] } });
		const b = new Browser();
		const tokens = h.idp.authResult('alice');
		await signInAs(h, b, 'alice', tokens);
		h.on('UpdateUserAttributesCommand', () => ({
			CodeDeliveryDetailsList: [{ Destination: 'n***@e***', DeliveryMedium: 'EMAIL', AttributeName: 'email' }],
		}));
		const out = await b.request((ctx) =>
			h.auth.updateUserAttributes(ctx, { email: 'new@example.com', department: 'ops', name: undefined }),
		);
		assert.deepStrictEqual(h.sent[0].input, {
			AccessToken: tokens.AccessToken,
			UserAttributes: [
				{ Name: 'email', Value: 'new@example.com' },
				{ Name: 'custom:department', Value: 'ops' },
			],
		});
		assert.deepStrictEqual(out, {
			email: {
				isUpdated: false,
				nextStep: {
					name: 'CONFIRM_ATTRIBUTE_WITH_CODE',
					codeDeliveryDetails: { destination: 'n***@e***', deliveryMedium: 'EMAIL', attributeName: 'email' },
				},
			},
			'custom:department': { isUpdated: true },
		});
	});

	// Auth: the single-attribute `updateUserAttribute` was dropped (R13); the
	// same call is `updateUserAttributes` with one key.
	test('updateUserAttribute (single) returns that attribute’s outcome', async () => {
		const h = makeAwsAuth({ users: { attributes: [{ name: 'department', type: 'String', mutable: true }] } });
		const b = new Browser();
		await signInAs(h, b, 'alice');
		h.on('UpdateUserAttributesCommand', () => ({}));
		const out = await b.request((ctx) => h.auth.updateUserAttributes(ctx, { department: 'ops' }));
		assert.deepStrictEqual(out, { 'custom:department': { isUpdated: true } });
		assert.deepStrictEqual(h.sent[0].input.UserAttributes, [{ Name: 'custom:department', Value: 'ops' }]);
	});
});

describe('AWS admin surface — command shapes', () => {
	test('admin actions not granted → 403 before any Cognito call', async () => {
		const h = makeAwsAuth({ users: { groups: ['admins'] }, admin: { actions: ['groups'] } });
		// An untyped caller reaching past the compile-time gate.
		const deleteUser: unknown = Reflect.get(h.auth.admin, 'deleteUser');
		assert.ok(typeof deleteUser === 'function');
		await assert.rejects(
			() => Promise.resolve(Reflect.apply(deleteUser, h.auth.admin, ['bob'])),
			(e: Error & { status?: number }) => e.status === 403 && e.name === AuthErrors.NotAuthorized,
		);
		assert.deepStrictEqual(h.sent, []);
	});

	test('addUserToGroup / removeUserFromGroup send the pool, user and group', async () => {
		const h = makeAwsAuth({ users: { groups: ['admins'] }, admin: {} });
		h.on('AdminAddUserToGroupCommand', () => ({}));
		h.on('AdminRemoveUserFromGroupCommand', () => ({}));
		await h.auth.admin.addUserToGroup('bob', 'admins');
		await h.auth.admin.removeUserFromGroup('bob', 'admins');
		const input = { UserPoolId: TEST_POOL_ID, Username: 'bob', GroupName: 'admins' };
		assert.deepStrictEqual(h.sent, [
			{ name: 'AdminAddUserToGroupCommand', input },
			{ name: 'AdminRemoveUserFromGroupCommand', input },
		]);
	});

	test('createUser prefixes custom attrs and maps suppressInvite → MessageAction SUPPRESS', async () => {
		const h = makeAwsAuth({ users: { attributes: [{ name: 'department', type: 'String' }] }, admin: {} });
		h.on('AdminCreateUserCommand', () => ({
			User: {
				Username: 'bob',
				Enabled: true,
				Attributes: [
					{ Name: 'sub', Value: 'sub-bob' },
					{ Name: 'custom:department', Value: 'eng' },
				],
			},
		}));
		const u = await h.auth.admin.createUser('bob', {
			temporaryPassword: 'Temp!1234',
			attributes: { department: 'eng' },
			suppressInvite: true,
		});
		assert.deepStrictEqual(h.sent[0].input, {
			UserPoolId: TEST_POOL_ID,
			Username: 'bob',
			TemporaryPassword: 'Temp!1234',
			UserAttributes: [{ Name: 'custom:department', Value: 'eng' }],
			MessageAction: 'SUPPRESS',
		});
		assert.deepStrictEqual(u, {
			username: 'bob',
			userSub: 'sub-bob',
			enabled: true,
			attributes: { sub: 'sub-bob', 'custom:department': 'eng' },
			// Auth: a just-created user is in no group, so `groups: []` (the mock's answer too).
			groups: [],
		});
	});

	test('getUser maps attributes + live groups; an unknown user is null', async () => {
		const h = makeAwsAuth({ users: { groups: ['admins'] }, admin: {} });
		h.on('AdminGetUserCommand', (input) => {
			if (input.Username === 'ghost') throw cognitoError('UserNotFoundException', 'User does not exist.');
			return { Username: 'bob', Enabled: false, UserAttributes: [{ Name: 'sub', Value: 'sub-bob' }] };
		});
		h.on('AdminListGroupsForUserCommand', () => groupsReply('admins'));
		assert.deepStrictEqual(await h.auth.admin.getUser('bob'), {
			username: 'bob',
			userSub: 'sub-bob',
			enabled: false,
			attributes: { sub: 'sub-bob' },
			groups: ['admins'],
		});
		assert.strictEqual(await h.auth.admin.getUser('ghost'), null);
		// Auth: the unknown user costs one call — no group read for a user that is not there.
		assert.deepStrictEqual(h.sentNames(), [
			'AdminGetUserCommand',
			'AdminListGroupsForUserCommand',
			'AdminGetUserCommand',
		]);
	});

	test('getUser degrades to groups: undefined when the group read is denied', async () => {
		const h = makeAwsAuth({ admin: {} });
		h.on('AdminGetUserCommand', () => ({ Username: 'bob', UserAttributes: [] }));
		h.on('AdminListGroupsForUserCommand', () => {
			throw cognitoError('AccessDeniedException', 'denied');
		});
		const u = await h.auth.admin.getUser('bob');
		assert.strictEqual(u?.groups, undefined);
		// Auth: absent, not present-and-undefined.
		assert.ok(u && !('groups' in u));
	});

	test('scan maps the filter to a Cognito expression and paginates', async () => {
		const h = makeAwsAuth({ admin: {} });
		h.on('ListUsersCommand', (input) =>
			input.PaginationToken
				? { Users: [{ Username: 'b2', Attributes: [] }] }
				: { Users: [{ Username: 'b1', Attributes: [] }], PaginationToken: 'p2' },
		);
		const usernames: string[] = [];
		for await (const u of h.auth.admin.scan({ attribute: 'email', match: 'startsWith', value: 'b"x' })) {
			usernames.push(u.username);
		}
		assert.deepStrictEqual(usernames, ['b1', 'b2']);
		assert.deepStrictEqual(h.sent[0].input, { UserPoolId: TEST_POOL_ID, Limit: 60, Filter: 'email ^= "b\\"x"' });
		assert.strictEqual(h.sent[1].input.PaginationToken, 'p2');
	});

	test('revokeUserSessions sends AdminUserGlobalSignOut', async () => {
		const h = makeAwsAuth({ admin: {} });
		h.on('AdminUserGlobalSignOutCommand', () => ({}));
		await h.auth.admin.revokeUserSessions('bob');
		assert.deepStrictEqual(h.sent, [
			{ name: 'AdminUserGlobalSignOutCommand', input: { UserPoolId: TEST_POOL_ID, Username: 'bob' } },
		]);
	});
});
