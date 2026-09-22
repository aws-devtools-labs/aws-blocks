// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Sandbox e2e for the opt-in `auth.admin` surface, driven through the deployed
 * Lambda backend over HTTP (the `authCAdmin*` routes in aws-blocks/index.ts).
 *
 * Runs only when BLOCKS_TEST_ENV=sandbox|production (the unified e2e harness
 * deploys + tears down the stack). Verifies the admin IAM grant is wired and
 * the surface behaves end-to-end against real Cognito.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert';
import { isBlocksError } from '@aws-blocks/core';
import type { api as apiType } from 'aws-blocks';

const ENV = process.env.BLOCKS_TEST_ENV || 'local';
const isSandbox = ENV === 'sandbox' || ENV === 'production';

const RUN_ID = Date.now().toString(36);
let counter = 0;
function uniqueUser() {
	return `adm-${RUN_ID}-${(counter++).toString(36)}`;
}

const PW = 'AdminE2e!1';

export function authCognitoAdminTests(getApi: () => typeof apiType) {
	describe('AuthCognito admin surface (sandbox)', { skip: !isSandbox && 'sandbox not deployed' }, () => {
		test('admin.createUser → setUserPassword → signIn works end-to-end', async () => {
			const api = getApi();
			const u = uniqueUser();
			const created = await api.authCAdminCreateUser(u, PW);
			assert.strictEqual(created.username, u);
			assert.strictEqual(created.enabled, true);

			await api.authCAdminSetPassword(u, PW);
			const r = await api.authCSignIn(u, PW);
			assert.strictEqual(r.status, 'signedIn');

			await api.authCAdminDeleteUser(u);
		});

		test('admin.addUserToGroup → requireRole(admins) succeeds on a fresh token', async () => {
			const api = getApi();
			const u = uniqueUser();
			await api.authCAdminCreateUser(u, PW);
			await api.authCAdminSetPassword(u, PW);

			await api.authCAdminAddToGroup(u, 'admins');
			const groups = await api.authCAdminListGroupsForUser(u);
			assert.ok(groups.includes('admins'), `expected admins in ${JSON.stringify(groups)}`);

			await api.authCSignIn(u, PW); // fresh sign-in → claim carries the group
			const user = await api.authCRequireRole('admins');
			assert.strictEqual(user.username, u);

			await api.authCAdminDeleteUser(u);
		});

		test('admin.revokeUserSessions revokes Cognito refresh tokens (succeeds end-to-end)', async () => {
			const api = getApi();
			const u = uniqueUser();
			await api.authCAdminCreateUser(u, PW);
			await api.authCAdminSetPassword(u, PW);
			await api.authCSignIn(u, PW);
			assert.strictEqual(await api.authCCheckAuth(), true);

			// AdminUserGlobalSignOut revokes the user's REFRESH tokens at Cognito.
			// The Blocks session's already-issued ACCESS token stays valid until
			// it expires, so `checkAuth` (which validates the access token) does
			// NOT flip to false immediately — this differs from the mock, which
			// deletes the server-side session record. The immediate-revocation
			// guarantee is "no new tokens can be minted", not "current request
			// 401s instantly". We assert the call succeeds end-to-end (the IAM
			// grant + AdminUserGlobalSignOut path work); the forced-refresh
			// failure is covered separately.
			await api.authCAdminRevokeSessions(u);

			await api.authCAdminDeleteUser(u);
		});

		test('admin.disableUser blocks signIn; enableUser restores it', async () => {
			const api = getApi();
			const u = uniqueUser();
			await api.authCAdminCreateUser(u, PW);
			await api.authCAdminSetPassword(u, PW);

			await api.authCAdminDisableUser(u);
			await assert.rejects(
				() => api.authCSignIn(u, PW),
				(e: unknown) => isBlocksError(e, 'NotAuthorizedException'),
			);

			await api.authCAdminEnableUser(u);
			const r = await api.authCSignIn(u, PW);
			assert.strictEqual(r.status, 'signedIn');

			await api.authCAdminDeleteUser(u);
		});

		test('admin.deleteUser removes the user and its group membership', async () => {
			const api = getApi();
			const u = uniqueUser();
			await api.authCAdminCreateUser(u, PW);
			await api.authCAdminSetPassword(u, PW);
			await api.authCAdminAddToGroup(u, 'readers');
			await api.authCAdminDeleteUser(u);

			await assert.rejects(() => api.authCSignIn(u, PW));
		});

		// ── Gap 1: typed reads round-trip real Cognito data ──────────────────
		test('admin.getUser round-trips custom attribute + group membership', async () => {
			const api = getApi();
			const u = uniqueUser();
			await api.authCAdminCreateUserWithDept(u, PW, 'engineering');
			await api.authCAdminAddToGroup(u, 'admins');

			const got = await api.authCAdminGetUser(u);
			assert.ok(got, 'expected a user');
			assert.strictEqual(got.username, u);
			assert.strictEqual(got.department, 'engineering');
			assert.ok(got.groups.includes('admins'), `expected admins in ${JSON.stringify(got.groups)}`);
			assert.strictEqual(await api.authCAdminGetUser(`${u}-missing`), null);

			await api.authCAdminDeleteUser(u);
		});

		// ── Gap 4: scan filter is executed by Cognito (ListUsers Filter) ─────
		test('admin.scan with a startsWith filter narrows to matching users', async () => {
			const api = getApi();
			const prefix = `scanflt-${uniqueUser()}`;
			const a = `${prefix}-alpha`;
			const b = `${prefix}-beta`;
			await api.authCAdminCreateUser(a, PW);
			await api.authCAdminCreateUser(b, PW);

			// Cognito validates this Filter expression server-side — the whole point
			// of exercising it live rather than in the in-memory mock.
			const matched = await api.authCAdminScan({ attribute: 'username', match: 'startsWith', value: prefix });
			assert.ok(matched.includes(a) && matched.includes(b), `expected both seeded users, got ${JSON.stringify(matched)}`);

			// A prefix that matches neither returns an empty (or non-matching) set.
			const none = await api.authCAdminScan({ attribute: 'username', match: 'startsWith', value: `${prefix}-zzz` });
			assert.ok(!none.includes(a) && !none.includes(b), 'non-matching filter should exclude seeded users');

			await api.authCAdminDeleteUser(a);
			await api.authCAdminDeleteUser(b);
		});
	});
}
