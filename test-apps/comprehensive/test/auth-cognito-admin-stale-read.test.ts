// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Runs the AuthCognito admin sandbox suite (./auth-cognito-admin-sandbox.test.ts)
 * offline, against an in-memory backend whose group-membership reads lag each
 * group change by one read.
 *
 * Real Cognito did exactly that in CI: `AdminAddUserToGroup` succeeded, and the
 * `AdminListGroupsForUser` read a moment later still returned the old
 * membership, failing `getUser().groups` with `expected admins in []` and
 * `requireRole` with `NotAuthorizedException: Not in group 'admins'`. The suite
 * otherwise only runs against a deployed stack, so this file is what shows,
 * without one, that it waits for a group change rather than reading it once.
 *
 * Run: npm run test:cognito-admin-stale-read (root), or from test-apps/comprehensive
 *   npx tsx --test test/auth-cognito-admin-stale-read.test.ts
 */

import assert from 'node:assert/strict';
import { after } from 'node:test';
import { ApiError } from '@aws-blocks/core';
import type { api as apiType } from 'aws-blocks';

interface FakeUser {
	password: string;
	enabled: boolean;
	department: string | null;
	groups: Set<string>;
}

/**
 * The `authC*` / `authCAdmin*` routes the suite calls, kept in memory. One
 * signed-in session at a time, like the suite's single cookie jar.
 *
 * Group changes model the lag: after `addToGroup` / `removeFromGroup`, the next
 * membership read of that user (`listGroupsForUser`, `getUser`, `requireRole`)
 * returns the groups from before the change, and every read after it returns
 * the current ones.
 */
function staleOnceBackend() {
	const users = new Map<string, FakeUser>();
	/** Groups the next membership read of a user returns instead of the current ones. */
	const lagging = new Map<string, string[]>();
	let staleReads = 0;
	let session: string | null = null;

	const notAuthorized = (message: string) => new ApiError(message, 403, { name: 'NotAuthorizedException' });

	function find(username: string): FakeUser {
		const user = users.get(username);
		if (!user) throw new ApiError('User does not exist.', 404, { name: 'UserNotFoundException' });
		return user;
	}

	function create(username: string, password: string, department: string | null) {
		if (users.has(username)) throw new ApiError('User account already exists', 409, { name: 'UsernameExistsException' });
		users.set(username, { password, enabled: true, department, groups: new Set() });
		return { username, enabled: true };
	}

	function changeGroups(username: string, change: (groups: Set<string>) => void) {
		const user = find(username);
		// Two changes before a read: the read still sees the state before the first.
		if (!lagging.has(username)) lagging.set(username, [...user.groups]);
		change(user.groups);
		return { success: true };
	}

	function readGroups(username: string): string[] {
		const old = lagging.get(username);
		if (old) {
			lagging.delete(username);
			staleReads++;
			return old;
		}
		return [...find(username).groups];
	}

	const api = {
		async authCAdminCreateUser(username: string, temporaryPassword: string) {
			return create(username, temporaryPassword, null);
		},
		async authCAdminCreateUserWithDept(username: string, temporaryPassword: string, department: string) {
			return create(username, temporaryPassword, department);
		},
		async authCAdminSetPassword(username: string, password: string) {
			find(username).password = password;
			return { success: true };
		},
		async authCSignIn(username: string, password: string) {
			const user = users.get(username);
			if (!user || user.password !== password) throw notAuthorized('Incorrect username or password.');
			if (!user.enabled) throw notAuthorized('User is disabled.');
			session = username;
			return { status: 'signedIn' };
		},
		async authCCheckAuth() {
			return session !== null;
		},
		async authCRequireRole(role: string) {
			if (session === null) throw new ApiError('Not authenticated', 401, { name: 'UnauthorizedException' });
			// A deleted user's live session fails closed with 403, as the real guard does.
			if (!users.has(session)) throw notAuthorized('Not authorized');
			const groups = readGroups(session);
			if (!groups.includes(role)) throw notAuthorized(`Not in group '${role}'`);
			return { username: session, groups };
		},
		async authCAdminAddToGroup(username: string, group: string) {
			return changeGroups(username, (groups) => groups.add(group));
		},
		async authCAdminRemoveFromGroup(username: string, group: string) {
			return changeGroups(username, (groups) => groups.delete(group));
		},
		async authCAdminListGroupsForUser(username: string) {
			return readGroups(username);
		},
		async authCAdminGetUser(username: string) {
			const user = users.get(username);
			if (!user) return null;
			return {
				username,
				userSub: `sub-${username}`,
				enabled: user.enabled,
				department: user.department,
				groups: readGroups(username),
			};
		},
		async authCAdminScan(filter?: { attribute: string; match: 'startsWith' | 'equals'; value: string }) {
			const names = [...users.keys()];
			if (!filter) return names;
			return names.filter((name) => (filter.match === 'startsWith' ? name.startsWith(filter.value) : name === filter.value));
		},
		async authCAdminDisableUser(username: string) {
			find(username).enabled = false;
			return { success: true };
		},
		async authCAdminEnableUser(username: string) {
			find(username).enabled = true;
			return { success: true };
		},
		async authCAdminRevokeSessions(username: string) {
			find(username);
			return { success: true };
		},
		async authCAdminDeleteUser(username: string) {
			find(username);
			users.delete(username);
			lagging.delete(username);
			return { success: true };
		},
	};

	// Plumbing: the suite takes the deployed API's type, and this covers only the routes it calls.
	return { api: api as unknown as typeof apiType, staleReads: () => staleReads };
}

// The suite skips itself unless it targets a deployed stack, and reads this when it loads.
// A static import is hoisted above this assignment, so the suite is imported after it.
process.env.BLOCKS_TEST_ENV = 'sandbox';
const { authCognitoAdminTests } = await import('./auth-cognito-admin-sandbox.test.js');

const backend = staleOnceBackend();
authCognitoAdminTests(() => backend.api);

after(() => {
	// Guards against a vacuous pass: the suite has to have read across a group change.
	assert.ok(backend.staleReads() > 0, 'no membership read followed a group change, so the lag was never exercised');
});
