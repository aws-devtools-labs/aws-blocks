// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared group-membership poller for the AuthCognito admin e2e suite.
 *
 * `AdminAddUserToGroup` and `AdminRemoveUserFromGroup` can return before every
 * `AdminListGroupsForUser` read reflects the change. Cognito doesn't document
 * read-after-write consistency for group membership, and CI has seen the read
 * one request after a successful `addUserToGroup` come back without the new
 * group (`expected admins in []` from `getUser`, `NotAuthorizedException: Not
 * in group 'admins'` from `requireRole`), then pass on the same commit's
 * re-run. That read is behind `listGroupsForUser`, `getUser().groups` and
 * `requireRole`, so a test that reads once right after a group change is
 * racing Cognito, not testing the code.
 *
 * Poll instead: re-read until the value reflects the change. When the budget
 * runs out, the last value is handed back anyway, so the caller's own
 * assertion reports what Cognito still said.
 *
 * Sibling of `poll-for-code.ts` and `poll-for-signin.ts`.
 */

export interface PollForMembershipOptions {
	/** How long to keep reading. Defaults to 10s; the lag CI has seen is under a second. */
	maxMs?: number;
	/** Gap between reads. Defaults to 250ms. */
	intervalMs?: number;
}

/**
 * Re-run `read` until `settled` accepts its value or `maxMs` runs out, then
 * return the last value read.
 *
 * A rejected `read` isn't retried; the rejection propagates. To wait on a guard
 * that answers stale membership with an error, wrap it so that answer becomes a
 * value (e.g. `null` for a 403).
 *
 * @example
 * ```typescript
 * await api.authCAdminAddToGroup(u, 'admins');
 * const groups = await pollForMembership(() => api.authCAdminListGroupsForUser(u), (g) => g.includes('admins'));
 * assert.ok(groups.includes('admins'), `expected admins in ${JSON.stringify(groups)}`);
 * ```
 */
export async function pollForMembership<T>(
	read: () => Promise<T>,
	settled: (value: T) => boolean,
	options: PollForMembershipOptions = {},
): Promise<T> {
	const { maxMs = 10000, intervalMs = 250 } = options;
	const start = Date.now();
	let value = await read();
	while (!settled(value) && Date.now() - start < maxMs) {
		await new Promise((resolve) => global.setTimeout(resolve, intervalMs));
		value = await read();
	}
	return value;
}
