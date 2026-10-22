// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Sandbox e2e for the opt-in `auth.admin` surface, driven through the deployed
 * Lambda backend over HTTP (the secret-gated `testSupport.authCAdmin*` routes
 * in aws-blocks/index.ts; `getTestSupport` supplies the deploy's secret).
 *
 * Runs only when BLOCKS_TEST_ENV=sandbox|production (the unified e2e harness
 * deploys + tears down the stack). Verifies the admin IAM grant is wired and
 * the surface behaves end-to-end against real Cognito.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert';
import { isBlocksError } from '@aws-blocks/core';
import type { api as apiType } from 'aws-blocks';
import { getTestSupport } from './test-support.js';

const ENV = process.env.BLOCKS_TEST_ENV || 'local';
const isSandbox = ENV === 'sandbox' || ENV === 'production';

const RUN_ID = Date.now().toString(36);
let counter = 0;
function uniqueUser() {
	return `adm-${RUN_ID}-${(counter++).toString(36)}`;
}

const PW = 'AdminE2e!1';

export function authCognitoAdminTests(getApi: () => typeof apiType) {
	describe('Auth admin surface — authC (sandbox)', { skip: !isSandbox && 'sandbox not deployed' }, () => {
		test('admin.createUser → setUserPassword → signIn works end-to-end', async () => {
			const api = getApi();
			const { testSupport: admin, secret } = await getTestSupport();
			const u = uniqueUser();
			const created = await admin.authCAdminCreateUser(secret, u, PW);
			assert.strictEqual(created.username, u);
			assert.strictEqual(created.enabled, true);

			await admin.authCAdminSetPassword(secret, u, PW);
			const r = await api.authCSignIn(u, PW);
			assert.strictEqual(r.status, 'signedIn');

			await admin.authCAdminDeleteUser(secret, u);
		});

		test('admin.addUserToGroup → requireRole(admins) succeeds on a fresh token', async () => {
			const api = getApi();
			const { testSupport: admin, secret } = await getTestSupport();
			const u = uniqueUser();
			await admin.authCAdminCreateUser(secret, u, PW);
			await admin.authCAdminSetPassword(secret, u, PW);

			await admin.authCAdminAddToGroup(secret, u, 'admins');
			const groups = await admin.authCAdminListGroupsForUser(secret, u);
			assert.ok(groups.includes('admins'), `expected admins in ${JSON.stringify(groups)}`);

			await api.authCSignIn(u, PW); // fresh sign-in → claim carries the group
			const user = await api.authCRequireRole('admins');
			assert.strictEqual(user.username, u);

			await admin.authCAdminDeleteUser(secret, u);
		});

		test('requireRole reads live membership — group change hits an existing session without re-login', async () => {
			const api = getApi();
			const { testSupport: admin, secret } = await getTestSupport();
			const u = uniqueUser();
			await admin.authCAdminCreateUser(secret, u, PW);
			await admin.authCAdminSetPassword(secret, u, PW);

			// Sign in BEFORE any group grant — the session token carries no groups.
			await api.authCSignIn(u, PW);
			await assert.rejects(
				() => api.authCRequireRole('admins'),
				(e: unknown) => isBlocksError(e, 'NotAuthorizedException'),
				'a non-member must be 403 before the grant',
			);

			// Grant membership on the already-signed-in session. requireRole reads
			// AdminListGroupsForUser live, so it must pass with NO re-login — this is
			// the fix (previously the stale cognito:groups claim kept returning 403).
			await admin.authCAdminAddToGroup(secret, u, 'admins');
			const granted = await api.authCRequireRole('admins');
			assert.strictEqual(granted.username, u);
			assert.ok(granted.groups.includes('admins'), `returned groups reflect the live read: ${JSON.stringify(granted.groups)}`);

			// Revoke on the same live session — access must drop immediately, again
			// with no re-login (the stale claim would still say 'admins').
			await admin.authCAdminRemoveFromGroup(secret, u, 'admins');
			await assert.rejects(
				() => api.authCRequireRole('admins'),
				(e: unknown) => isBlocksError(e, 'NotAuthorizedException'),
				'removal must lock the live session out immediately',
			);

			await admin.authCAdminDeleteUser(secret, u);
		});

		test('requireRole fails closed with 403 (not 404) when the user is deleted mid-session', async () => {
			const api = getApi();
			const { testSupport: admin, secret } = await getTestSupport();
			const u = uniqueUser();
			await admin.authCAdminCreateUser(secret, u, PW);
			await admin.authCAdminSetPassword(secret, u, PW);
			await admin.authCAdminAddToGroup(secret, u, 'admins');
			await api.authCSignIn(u, PW);
			assert.strictEqual((await api.authCRequireRole('admins')).username, u);

			// Delete the user out from under the live session. deleteUser does NOT
			// revoke the Blocks session, so requireAuth still succeeds off the record,
			// but the live AdminListGroupsForUser now throws UserNotFoundException.
			// The guard must fail closed with its own 403 NotAuthorizedException —
			// not leak Cognito's 404 (which breaks the documented 401/403 contract
			// a client bounces to sign-in on).
			await admin.authCAdminDeleteUser(secret, u);
			await assert.rejects(
				() => api.authCRequireRole('admins'),
				(e: unknown) => isBlocksError(e, 'NotAuthorizedException'),
			);
		});

		test('admin.revokeUserSessions revokes Cognito refresh tokens (succeeds end-to-end)', async () => {
			const api = getApi();
			const { testSupport: admin, secret } = await getTestSupport();
			const u = uniqueUser();
			await admin.authCAdminCreateUser(secret, u, PW);
			await admin.authCAdminSetPassword(secret, u, PW);
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
			await admin.authCAdminRevokeSessions(secret, u);

			await admin.authCAdminDeleteUser(secret, u);
		});

		test('admin.disableUser blocks signIn; enableUser restores it', async () => {
			const api = getApi();
			const { testSupport: admin, secret } = await getTestSupport();
			const u = uniqueUser();
			await admin.authCAdminCreateUser(secret, u, PW);
			await admin.authCAdminSetPassword(secret, u, PW);

			await admin.authCAdminDisableUser(secret, u);
			await assert.rejects(
				() => api.authCSignIn(u, PW),
				(e: unknown) => isBlocksError(e, 'NotAuthorizedException'),
			);

			await admin.authCAdminEnableUser(secret, u);
			const r = await api.authCSignIn(u, PW);
			assert.strictEqual(r.status, 'signedIn');

			await admin.authCAdminDeleteUser(secret, u);
		});

		test('admin.deleteUser removes the user and its group membership', async () => {
			const api = getApi();
			const { testSupport: admin, secret } = await getTestSupport();
			const u = uniqueUser();
			await admin.authCAdminCreateUser(secret, u, PW);
			await admin.authCAdminSetPassword(secret, u, PW);
			await admin.authCAdminAddToGroup(secret, u, 'readers');
			await admin.authCAdminDeleteUser(secret, u);

			await assert.rejects(() => api.authCSignIn(u, PW));
		});

		// ── Gap 1: typed reads round-trip real Cognito data ──────────────────
		test('admin.getUser round-trips custom attribute + group membership', async () => {
			const api = getApi();
			const { testSupport: admin, secret } = await getTestSupport();
			const u = uniqueUser();
			await admin.authCAdminCreateUserWithDept(secret, u, PW, 'engineering');
			await admin.authCAdminAddToGroup(secret, u, 'admins');

			const got = await admin.authCAdminGetUser(secret, u);
			assert.ok(got, 'expected a user');
			assert.strictEqual(got.username, u);
			assert.strictEqual(got.department, 'engineering');
			assert.ok(got.groups.includes('admins'), `expected admins in ${JSON.stringify(got.groups)}`);
			assert.strictEqual(await admin.authCAdminGetUser(secret, `${u}-missing`), null);

			await admin.authCAdminDeleteUser(secret, u);
		});

		// ── Gap 4: scan filter is executed by Cognito (ListUsers Filter) ─────
		test('admin.scan with a startsWith filter narrows to matching users', async () => {
			const api = getApi();
			const { testSupport: admin, secret } = await getTestSupport();
			const prefix = `scanflt-${uniqueUser()}`;
			const a = `${prefix}-alpha`;
			const b = `${prefix}-beta`;
			await admin.authCAdminCreateUser(secret, a, PW);
			await admin.authCAdminCreateUser(secret, b, PW);

			// Cognito validates this Filter expression server-side — the whole point
			// of exercising it live rather than in the in-memory mock.
			const matched = await admin.authCAdminScan(secret, { attribute: 'username', match: 'startsWith', value: prefix });
			assert.ok(matched.includes(a) && matched.includes(b), `expected both seeded users, got ${JSON.stringify(matched)}`);

			// A prefix that matches neither returns an empty (or non-matching) set.
			const none = await admin.authCAdminScan(secret, { attribute: 'username', match: 'startsWith', value: `${prefix}-zzz` });
			assert.ok(!none.includes(a) && !none.includes(b), 'non-matching filter should exclude seeded users');

			await admin.authCAdminDeleteUser(secret, a);
			await admin.authCAdminDeleteUser(secret, b);
		});
	});
}
