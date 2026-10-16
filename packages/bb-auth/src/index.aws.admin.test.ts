// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * AWS runtime — the `auth.admin` engine (D5c2) beyond the command shapes B5
 * pinned (`index.aws.groups.test.ts`): every lifecycle command's exact input,
 * pagination of `listUsersInGroup` / `scan`, `getUser` → `null` (never
 * `UserNotFoundException`), group narrowing, `revokeUserSessions`' session-row
 * deletion, and the unmasked error contract inside the trust boundary.
 * Harness: `test-support/aws-harness.ts`.
 */

import assert from 'node:assert';
import { rmSync } from 'node:fs';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { ApiError } from '@aws-blocks/core';
import { clientMessageFor } from './error-mapping.js';
import { AuthErrors } from './index.aws.js';
import { Browser, cognitoError, makeAwsAuth, signInAs, TEST_POOL_ID, wireView } from './test-support/aws-harness.js';

beforeEach(() => rmSync('.bb-data', { recursive: true, force: true }));
afterEach(() => rmSync('.bb-data', { recursive: true, force: true }));

async function rejection(p: Promise<unknown>): Promise<unknown> {
	return p.then(
		() => assert.fail('expected rejection'),
		(e: unknown) => e,
	);
}

const user = (Username: string, extra: Record<string, unknown> = {}) => ({
	Username,
	Enabled: true,
	Attributes: [{ Name: 'sub', Value: `sub-${Username}` }],
	...extra,
});

describe('AWS admin — lifecycle command shapes', () => {
	test('deleteUser / disableUser / enableUser / resetUserPassword send the pool and the user', async () => {
		const h = makeAwsAuth({ admin: { actions: ['lifecycle'] } });
		for (const c of ['AdminDeleteUser', 'AdminDisableUser', 'AdminEnableUser', 'AdminResetUserPassword']) {
			h.on(`${c}Command`, () => ({}));
		}
		await h.auth.admin.deleteUser('bob');
		await h.auth.admin.disableUser('bob');
		await h.auth.admin.enableUser('bob');
		await h.auth.admin.resetUserPassword('bob');
		const input = { UserPoolId: TEST_POOL_ID, Username: 'bob' };
		assert.deepStrictEqual(h.sent, [
			{ name: 'AdminDeleteUserCommand', input },
			{ name: 'AdminDisableUserCommand', input },
			{ name: 'AdminEnableUserCommand', input },
			{ name: 'AdminResetUserPasswordCommand', input },
		]);
	});

	test('setUserPassword sends Permanent (default false)', async () => {
		const h = makeAwsAuth({ admin: {} });
		h.on('AdminSetUserPasswordCommand', () => ({}));
		await h.auth.admin.setUserPassword('bob', 'Temp!1234');
		await h.auth.admin.setUserPassword('bob', 'Final!1234', { permanent: true });
		assert.deepStrictEqual(
			h.sent.map((c) => c.input),
			[
				{ UserPoolId: TEST_POOL_ID, Username: 'bob', Password: 'Temp!1234', Permanent: false },
				{ UserPoolId: TEST_POOL_ID, Username: 'bob', Password: 'Final!1234', Permanent: true },
			],
		);
	});

	test('createUser with no init sends only the pool and the user (Cognito generates the temporary password)', async () => {
		const h = makeAwsAuth({ admin: {} });
		h.on('AdminCreateUserCommand', () => ({ User: user('bob') }));
		const u = await h.auth.admin.createUser('bob');
		assert.deepStrictEqual(h.sent, [
			{ name: 'AdminCreateUserCommand', input: { UserPoolId: TEST_POOL_ID, Username: 'bob' } },
		]);
		assert.deepStrictEqual(u, {
			username: 'bob',
			userSub: 'sub-bob',
			enabled: true,
			attributes: { sub: 'sub-bob' },
			groups: [],
		});
	});

	test('createUser for an existing user → 409 UsernameExists, unmasked', async () => {
		const h = makeAwsAuth({ admin: {} });
		h.on('AdminCreateUserCommand', () => {
			throw cognitoError('UsernameExistsException', 'User account already exists');
		});
		const e = await rejection(h.auth.admin.createUser('bob'));
		assert.deepStrictEqual(wireView(e), {
			code: 409,
			// FX59 (#678): the name's fixed message; Cognito's text is logged server-side.
			message: clientMessageFor(AuthErrors.UserAlreadyExists),
			name: AuthErrors.UserAlreadyExists,
			retriable: false,
		});
	});
});

describe('AWS admin — getUser', () => {
	test('narrows live groups to the declared set and reads every group page', async () => {
		const h = makeAwsAuth({ users: { groups: ['admins', 'editors'] }, admin: {} });
		h.on('AdminGetUserCommand', () => ({
			Username: 'bob',
			Enabled: true,
			UserAttributes: [{ Name: 'sub', Value: 'sub-bob' }],
		}));
		h.on('AdminListGroupsForUserCommand', (input) =>
			input.NextToken
				? { Groups: [{ GroupName: 'editors' }] }
				: { Groups: [{ GroupName: 'admins' }, { GroupName: 'undeclared' }], NextToken: 'g2' },
		);
		const u = await h.auth.admin.getUser('bob');
		assert.deepStrictEqual(u?.groups, ['admins', 'editors']);
		assert.deepStrictEqual(h.sent.slice(1), [
			{ name: 'AdminListGroupsForUserCommand', input: { UserPoolId: TEST_POOL_ID, Username: 'bob' } },
			{
				name: 'AdminListGroupsForUserCommand',
				input: { UserPoolId: TEST_POOL_ID, Username: 'bob', NextToken: 'g2' },
			},
		]);
	});

	test('a user deleted between the two reads is null too', async () => {
		const h = makeAwsAuth({ admin: {} });
		h.on('AdminGetUserCommand', () => ({ Username: 'bob', UserAttributes: [] }));
		h.on('AdminListGroupsForUserCommand', () => {
			throw cognitoError('UserNotFoundException', 'User does not exist.');
		});
		assert.strictEqual(await h.auth.admin.getUser('bob'), null);
	});

	test('any other failure is mapped, not swallowed (no $metadata, cause not enumerable)', async () => {
		const h = makeAwsAuth({ admin: {} });
		h.on('AdminGetUserCommand', () => {
			throw cognitoError('TooManyRequestsException', 'Rate exceeded');
		});
		const e = await rejection(h.auth.admin.getUser('bob'));
		assert.ok(e instanceof ApiError);
		assert.deepStrictEqual(wireView(e), {
			code: 429,
			// FX59 (#678): the name's fixed message; Cognito's text is logged server-side.
			message: clientMessageFor(AuthErrors.TooManyRequests),
			name: AuthErrors.TooManyRequests,
			retriable: false,
		});
		assert.ok(!Object.keys(e).includes('cause'));
		assert.ok(!JSON.stringify(e).includes('$metadata'));
	});
});

describe('AWS admin — pagination', () => {
	test('listUsersInGroup follows NextToken and returns every member', async () => {
		const h = makeAwsAuth({ users: { groups: ['admins'] }, admin: {} });
		h.on('ListUsersInGroupCommand', (input) =>
			input.NextToken ? { Users: [user('b2')] } : { Users: [user('b1')], NextToken: 'n2' },
		);
		const members = await h.auth.admin.listUsersInGroup('admins');
		assert.deepStrictEqual(
			members.map((m) => m.username),
			['b1', 'b2'],
		);
		assert.deepStrictEqual(
			h.sent.map((c) => c.input),
			[
				{ UserPoolId: TEST_POOL_ID, GroupName: 'admins' },
				{ UserPoolId: TEST_POOL_ID, GroupName: 'admins', NextToken: 'n2' },
			],
		);
	});

	test('listUsersInGroup for an unknown group → 404 ResourceNotFound (GroupNotFound)', async () => {
		const h = makeAwsAuth({ users: { groups: ['admins'] }, admin: {} });
		h.on('ListUsersInGroupCommand', () => {
			throw cognitoError('ResourceNotFoundException', 'Group not found.');
		});
		const e = await rejection(h.auth.admin.listUsersInGroup('admins'));
		assert.strictEqual(wireView(e).name, AuthErrors.GroupNotFound);
		assert.strictEqual(wireView(e).code, 404);
	});

	test('listGroupsForUser pages AdminListGroupsForUser and narrows to the declared groups', async () => {
		const h = makeAwsAuth({ users: { groups: ['admins', 'editors'] }, admin: { actions: ['groups'] } });
		h.on('AdminListGroupsForUserCommand', (input) =>
			input.NextToken
				? { Groups: [{ GroupName: 'editors' }] }
				: { Groups: [{ GroupName: 'admins' }, { GroupName: 'other' }], NextToken: 't2' },
		);
		assert.deepStrictEqual(await h.auth.admin.listGroupsForUser('bob'), ['admins', 'editors']);
		assert.deepStrictEqual(h.sentNames(), ['AdminListGroupsForUserCommand', 'AdminListGroupsForUserCommand']);
	});

	test('scan with no filter sends no Filter; an exact match uses =', async () => {
		const h = makeAwsAuth({ admin: {} });
		h.on('ListUsersCommand', () => ({ Users: [user('b1', { Enabled: false })] }));
		const all = await Array.fromAsync(h.auth.admin.scan());
		const exact = await Array.fromAsync(h.auth.admin.scan({ attribute: 'username', match: 'equals', value: 'b1' }));
		assert.deepStrictEqual(all, [
			{ username: 'b1', userSub: 'sub-b1', enabled: false, attributes: { sub: 'sub-b1' } },
		]);
		assert.strictEqual(exact.length, 1);
		assert.deepStrictEqual(
			h.sent.map((c) => c.input),
			[
				{ UserPoolId: TEST_POOL_ID, Limit: 60 },
				{ UserPoolId: TEST_POOL_ID, Limit: 60, Filter: 'username = "b1"' },
			],
		);
	});
});

describe('AWS admin — revokeUserSessions', () => {
	test('revokes upstream, then deletes only that user’s session rows (immediate, L24)', async () => {
		const h = makeAwsAuth({ admin: {} });
		const alice = new Browser();
		const carol = new Browser();
		const aliceSid = await signInAs(h, alice, 'alice');
		const carolSid = await signInAs(h, carol, 'carol');
		h.on('AdminUserGlobalSignOutCommand', () => ({}));
		await h.auth.admin.revokeUserSessions('alice');
		assert.deepStrictEqual(h.sent, [
			{ name: 'AdminUserGlobalSignOutCommand', input: { UserPoolId: TEST_POOL_ID, Username: 'alice' } },
		]);
		assert.strictEqual(await h.lookupSession(aliceSid), null);
		assert.ok(await h.lookupSession(carolSid));
		assert.strictEqual(await alice.request((ctx) => h.auth.getCurrentUser(ctx)), null);
	});

	test('a failed AdminUserGlobalSignOut deletes no session row', async () => {
		const h = makeAwsAuth({ admin: {} });
		const alice = new Browser();
		const sid = await signInAs(h, alice, 'alice');
		h.on('AdminUserGlobalSignOutCommand', () => {
			throw cognitoError('UserNotFoundException', 'User does not exist.');
		});
		const e = await rejection(h.auth.admin.revokeUserSessions('alice'));
		assert.strictEqual(wireView(e).code, 404);
		assert.ok(await h.lookupSession(sid));
	});
});
