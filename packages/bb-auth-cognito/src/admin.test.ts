// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { rmSync } from 'node:fs';
import { isBlocksError } from '@aws-blocks/core';
import type { BlocksContext } from '@aws-blocks/core';
import { AuthCognito, AuthCognitoErrors } from './index.js';

// ── Harness (mirrors index.test.ts) ──────────────────────────────────────────

const ROOT = { id: 'test-app' } as any;

function freshContext(): BlocksContext {
	const req = new Headers();
	const res = new Headers();
	let status = 200;
	const ctx: BlocksContext = {
		request: {
			headers: req, body: null,
			json: async () => ({}), text: async () => '',
			url: new URL('http://localhost:3000/'), params: {},
		},
		response: {
			headers: res,
			get status() { return status; },
			set status(v) { status = v; },
			send: () => {},
		} as any,
	};
	const origSet = res.set.bind(res);
	res.set = (name: string, value: string) => {
		if (name.toLowerCase() === 'set-cookie') {
			req.set('cookie', value.split(';')[0]);
		}
		origSet(name, value);
	};
	return ctx;
}

function unique(prefix = 'admin') {
	return `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Sign a user up + confirm so they exist and can sign in. */
async function signUpAndConfirm(auth: AuthCognito<any>, username: string) {
	let code = '';
	(auth as any).options.codeDelivery = async (_u: string, c: string) => { code = c; };
	await auth.signUp(username, 'Password!1', { attributes: { email: `${username}@x.com` } });
	await auth.confirmSignUp(username, code);
}

beforeEach(() => {
	try { rmSync('.bb-data', { recursive: true, force: true }); } catch { /* ignore */ }
});
afterEach(() => {
	try { rmSync('.bb-data', { recursive: true, force: true }); } catch { /* ignore */ }
});

// ── Gate (runtime) ───────────────────────────────────────────────────────────

describe('auth.admin runtime gate', () => {
	test('throws a named error when admin is not enabled', () => {
		const auth = new AuthCognito(ROOT, unique(), { groups: ['admins'] });
		// Untyped JS caller reaching past the compile-time gate.
		assert.throws(() => (auth as any).admin, /admin not enabled/);
	});

	test('returns the surface when admin is enabled', () => {
		const auth = new AuthCognito(ROOT, unique(), { groups: ['admins'], admin: {} });
		assert.strictEqual(typeof auth.admin.addUserToGroup, 'function');
		assert.strictEqual(typeof auth.admin.createUser, 'function');
	});
});

// ── Group membership ─────────────────────────────────────────────────────────

describe('auth.admin group membership', () => {
	test('addUserToGroup is visible to the same instance requireRole', async () => {
		const auth = new AuthCognito(ROOT, unique(), { groups: ['admins'], admin: {} });
		await signUpAndConfirm(auth, 'alice');

		await auth.admin.addUserToGroup('alice', 'admins');
		assert.deepStrictEqual(await auth.admin.listGroupsForUser('alice'), ['admins']);

		const ctx = freshContext();
		await auth.signIn('alice', 'Password!1', ctx);
		const user = await auth.requireRole(ctx, 'admins'); // would 403 without the membership
		assert.strictEqual(user.username, 'alice');
	});

	test('addUserToGroup to an unseeded group throws GroupNotFound', async () => {
		const auth = new AuthCognito(ROOT, unique(), { groups: ['admins'], admin: {} });
		await signUpAndConfirm(auth, 'bob');
		await assert.rejects(
			// Cast past the narrowed group union to exercise the runtime guard
			// (a real unseeded group; `const O` would reject this at compile time).
			() => auth.admin.addUserToGroup('bob', 'ghosts' as 'admins'),
			(e: unknown) => isBlocksError(e, AuthCognitoErrors.GroupNotFound),
		);
	});

	test('addUserToGroup for a missing user throws UserNotFound', async () => {
		const auth = new AuthCognito(ROOT, unique(), { groups: ['admins'], admin: {} });
		await assert.rejects(
			() => auth.admin.addUserToGroup('nobody', 'admins'),
			(e: unknown) => isBlocksError(e, AuthCognitoErrors.UserNotFound),
		);
	});

	test('removeUserFromGroup filters membership', async () => {
		const auth = new AuthCognito(ROOT, unique(), { groups: ['admins'], admin: {} });
		await signUpAndConfirm(auth, 'carol');
		await auth.admin.addUserToGroup('carol', 'admins');
		await auth.admin.removeUserFromGroup('carol', 'admins');
		assert.deepStrictEqual(await auth.admin.listGroupsForUser('carol'), []);
	});

	test('listUsersInGroup returns members', async () => {
		const auth = new AuthCognito(ROOT, unique(), { groups: ['admins'], admin: {} });
		await signUpAndConfirm(auth, 'dave');
		await auth.admin.addUserToGroup('dave', 'admins');
		const members = await auth.admin.listUsersInGroup('admins');
		assert.deepStrictEqual(members.map((m) => m.username), ['dave']);
	});
});

// ── User lifecycle ───────────────────────────────────────────────────────────

describe('auth.admin user lifecycle', () => {
	test('createUser then getUser round-trips; createUser twice conflicts', async () => {
		const auth = new AuthCognito(ROOT, unique(), { admin: {} });
		const created = await auth.admin.createUser('erin', { attributes: { email: 'erin@x.com' } });
		assert.strictEqual(created.username, 'erin');
		assert.strictEqual(created.enabled, true);

		const fetched = await auth.admin.getUser('erin');
		assert.strictEqual(fetched?.username, 'erin');
		assert.strictEqual(await auth.admin.getUser('ghost'), null);

		await assert.rejects(
			() => auth.admin.createUser('erin'),
			(e: unknown) => isBlocksError(e, AuthCognitoErrors.UserAlreadyExists),
		);
	});

	test('deleteUser removes the record and strips group membership', async () => {
		const auth = new AuthCognito(ROOT, unique(), { groups: ['admins'], admin: {} });
		await signUpAndConfirm(auth, 'frank');
		await auth.admin.addUserToGroup('frank', 'admins');
		await auth.admin.deleteUser('frank');
		assert.strictEqual(await auth.admin.getUser('frank'), null);
		assert.deepStrictEqual(await auth.admin.listUsersInGroup('admins'), []);
	});

	test('disableUser blocks sign-in; enableUser restores it (existing signIn guard)', async () => {
		const auth = new AuthCognito(ROOT, unique(), { admin: {} });
		await signUpAndConfirm(auth, 'gina');

		await auth.admin.disableUser('gina');
		await assert.rejects(
			() => auth.signIn('gina', 'Password!1', freshContext()),
			(e: unknown) => isBlocksError(e, AuthCognitoErrors.NotAuthorized),
		);

		await auth.admin.enableUser('gina');
		const r = await auth.signIn('gina', 'Password!1', freshContext());
		assert.strictEqual(r.status, 'signedIn');
	});

	test('setUserPassword(permanent) lets the user sign in with the new password', async () => {
		const auth = new AuthCognito(ROOT, unique(), { admin: {} });
		await signUpAndConfirm(auth, 'hank');
		await auth.admin.setUserPassword('hank', 'NewPass!2', true);
		const r = await auth.signIn('hank', 'NewPass!2', freshContext());
		assert.strictEqual(r.status, 'signedIn');
	});

	test('scan yields all users', async () => {
		const auth = new AuthCognito(ROOT, unique(), { admin: {} });
		await auth.admin.createUser('ida');
		await auth.admin.createUser('jack');
		const seen: string[] = [];
		for await (const u of auth.admin.scan()) seen.push(u.username);
		assert.deepStrictEqual(seen.sort(), ['ida', 'jack']);
	});

	test('revokeUserSessions deletes the user session (forces re-auth)', async () => {
		const auth = new AuthCognito(ROOT, unique(), { admin: {} });
		await signUpAndConfirm(auth, 'kara');
		const ctx = freshContext();
		await auth.signIn('kara', 'Password!1', ctx);
		assert.strictEqual(await auth.checkAuth(ctx), true);

		await auth.admin.revokeUserSessions('kara');
		assert.strictEqual(await auth.checkAuth(ctx), false);
	});
});
