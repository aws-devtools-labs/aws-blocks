// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The local (mock) admin surface behind `auth.admin` — a port of
 * `AuthCognito`'s mock admin, over the same persisted store as the rest of the
 * mock engine, so an admin change is visible to the very next `signIn` /
 * `requireRole` on this instance.
 *
 * Inside the trust boundary: an unknown user is `UserNotFoundException`, an
 * unknown group `ResourceNotFoundException` (`GroupNotFound`); no enumeration
 * masking applies. `AuthBase` applies the `admin` / `admin.actions` gates.
 *
 * Mock-only.
 *
 * @internal
 */

import type { AdminUserFilter } from '../types.js';
import type { MockStore, MockUserRecord } from './native-mock-store.js';
import type { NativeAdminEngine, NativeAdminUser } from './types.js';

/** Apply a `scan` filter in memory, mirroring Cognito's `ListUsers` `Filter`. */
function matchesFilter(user: NativeAdminUser, filter: AdminUserFilter | undefined): boolean {
	if (!filter) return true;
	const candidate =
		filter.attribute === 'username'
			? user.username
			: filter.attribute === 'status'
				? user.enabled
					? 'Enabled'
					: 'Disabled'
				: filter.attribute === 'sub'
					? user.userSub
					: user.attributes[filter.attribute];
	if (candidate === undefined) return false;
	return filter.match === 'startsWith' ? candidate.startsWith(filter.value) : candidate === filter.value;
}

/**
 * Build the mock admin engine over `store`. `newUser` derives a new user's
 * Cognito username, `sub` and attributes from the `Username` the caller passed
 * (`signInWith` decides: a generated username on email / phone-only pools —
 * see `MockNativeEngine.newUser`). Every other `username` argument is resolved
 * the way Cognito resolves `Username` ({@link MockStore.resolve}): the
 * username, or a sign-in email / phone.
 *
 * @internal
 */
export function mockAdminEngine(
	store: MockStore,
	newUser: (
		login: string,
		attributes: Record<string, string>,
		existsMessage: string,
	) => { username: string; userSub: string; attributes: Record<string, string> },
): NativeAdminEngine {
	/** The stored username a caller's `Username` names, or `UserNotFoundException`. */
	const usernameOf = (login: string): string => store.requireResolved(login).username;

	const toAdminUser = (username: string, user: MockUserRecord): NativeAdminUser => ({
		username,
		userSub: user.userSub,
		enabled: !user.disabled,
		attributes: { sub: user.userSub, ...user.attributes },
		groups: store.groupsOf(username),
	});

	return {
		async addUserToGroup(login, group) {
			const username = usernameOf(login);
			const members = store.requireGroup(group);
			if (!members.includes(username)) members.push(username);
			store.flush();
		},
		async removeUserFromGroup(login, group) {
			const username = usernameOf(login);
			const members = store.requireGroup(group);
			store.state.groups[group] = members.filter((u) => u !== username);
			store.flush();
		},
		async listUsersInGroup(group) {
			const members = store.requireGroup(group);
			const users: NativeAdminUser[] = [];
			for (const username of members) {
				const user = store.user(username);
				if (user) users.push(toAdminUser(username, user));
			}
			return { users };
		},
		async createUser(login, init) {
			const { username, userSub, attributes } = newUser(
				login,
				{ ...init.attributes },
				'User account already exists',
			);
			const password = init.temporaryPassword ?? store.generateTemporaryPassword();
			store.enforcePasswordPolicy(password);
			const record: MockUserRecord = {
				userSub,
				password,
				confirmed: true,
				disabled: false,
				attributes,
				mfaPreference: { enabled: [] },
				totpVerified: false,
				devices: {},
				// Cognito's FORCE_CHANGE_PASSWORD: the first sign-in must set a new password.
				forcePasswordChange: true,
			};
			store.addUser(username, record);
			return toAdminUser(username, record);
		},
		async deleteUser(login) {
			store.deleteUser(usernameOf(login));
		},
		async disableUser(login) {
			store.requireResolved(login).user.disabled = true;
			store.flush();
		},
		async enableUser(login) {
			store.requireResolved(login).user.disabled = false;
			store.flush();
		},
		async resetUserPassword(login) {
			// Cognito's RESET_REQUIRED: sign-in fails with PasswordResetRequired
			// until the user completes the forgot-password flow.
			store.requireResolved(login).user.passwordResetRequired = true;
			store.flush();
		},
		async setUserPassword(login, password, options) {
			const { user } = store.requireResolved(login);
			store.enforcePasswordPolicy(password);
			user.password = password;
			delete user.passwordResetRequired;
			if (options.permanent) delete user.forcePasswordChange;
			else user.forcePasswordChange = true;
			store.flush();
		},
		async getUser(login) {
			const found = store.resolve(login);
			return found ? toAdminUser(found.username, found.user) : null;
		},
		async listUsers(options) {
			const users: NativeAdminUser[] = [];
			for (const [username, user] of Object.entries(store.state.users)) {
				const adminUser = toAdminUser(username, user);
				if (matchesFilter(adminUser, options.filter)) users.push(adminUser);
			}
			return { users };
		},
		async globalSignOut(login) {
			const { user } = store.requireResolved(login);
			user.tokenRevision = (user.tokenRevision ?? 0) + 1;
			store.flush();
		},
	};
}
