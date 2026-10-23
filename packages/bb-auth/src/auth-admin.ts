// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The `auth.admin` surface — group membership and user lifecycle — built over
 * a {@link NativeAdminEngine}. Ported from `AuthCognito`'s `buildAdminSurface`
 * (both runtimes), with the engine-specific half moved behind the engine.
 *
 * Owns: the runtime half of the `admin.actions` gate (403 before any engine
 * call), `custom:` prefixing of attributes, narrowing groups to the declared
 * `users.groups`, paging, and `revokeUserSessions`' deletion of this block's
 * session rows.
 *
 * Inside the trust boundary: errors are mapped **without** enumeration masking,
 * so an unknown user is `UserNotFoundException` (404) and an unknown group
 * `ResourceNotFoundException` (404) — the only surface where those names
 * appear. `getUser` returns `null` instead (G3).
 *
 * Internal — not exported from any package entry.
 *
 * @internal
 */

import { ApiError } from '@aws-blocks/core';
import type { NativeAdminUser, NativeAdminUserPage, NativeEngine } from './engines/types.js';
import { AuthErrors } from './errors.js';
import type {
	AdminAction,
	AdminActionGate,
	AdminCreateInit,
	AdminSurface,
	AdminUser,
	AdminUserFilter,
	AuthOptions,
	GroupOf,
	ReadAttrOf,
	SetPasswordOptions,
} from './types.js';

/** What the admin surface needs from `AuthBase`. */
export interface AdminDeps<O extends AuthOptions> {
	/** `options.admin.actions` (`undefined` grants everything). */
	actions: readonly AdminAction[] | undefined;
	/** The native engine, or the "no pool provisioned" error. */
	native(): NativeEngine;
	mapError(e: unknown): ApiError;
	prefixAttributes(attrs: Partial<Record<string, string>>): Record<string, string>;
	narrowGroups(groups: readonly string[]): GroupOf<O>[];
	readAttributes(attrs: Record<string, string>): Partial<Record<ReadAttrOf<O>, string>>;
	/** Delete every session row of `username` (`SessionStore.deleteByUsername`). */
	deleteSessionsOf(username: string): Promise<number>;
	/**
	 * Run `validateUser` for a user about to be created (`phase: 'signUp'`,
	 * `provider: 'password'`) — the in-process half of the PreSignUp check.
	 * Throws the mapped rejection; resolves to the `ClientMetadata` that tells
	 * the pool's trigger the check already ran (`undefined` without `validateUser`).
	 */
	validateNewUser(login: string, attributes: Record<string, string>): Promise<Record<string, string> | undefined>;
}

/**
 * Build the admin surface. Every method exists at runtime; `actions` scoping is
 * enforced by {@link AdminActionGate} at compile time and by a 403 here.
 *
 * @internal
 */
export function buildAdminSurface<O extends AuthOptions>(deps: AdminDeps<O>): AdminSurface<O> {
	const assertAction = (action: AdminAction): void => {
		if (deps.actions && !deps.actions.includes(action)) {
			throw new ApiError(
				`admin.${action} actions not granted: construct Auth with admin: { actions: [..., '${action}'] }`,
				403,
				{ name: AuthErrors.NotAuthorized },
			);
		}
	};
	/** Gate, then call the engine, mapping its errors (no enumeration masking). */
	const run = async <T>(action: AdminAction, op: (native: NativeEngine) => Promise<T>): Promise<T> => {
		assertAction(action);
		try {
			return await op(deps.native());
		} catch (e) {
			throw deps.mapError(e);
		}
	};
	const toAdminUser = (u: NativeAdminUser): AdminUser<O> => ({
		username: u.username,
		userSub: u.userSub,
		enabled: u.enabled,
		attributes: deps.readAttributes(u.attributes),
		...(u.groups ? { groups: deps.narrowGroups(u.groups) } : {}),
	});
	/** Every page of a paginated engine call. */
	const allPages = async (page: (nextToken: string | undefined) => Promise<NativeAdminUserPage>) => {
		const out: AdminUser<O>[] = [];
		let nextToken: string | undefined;
		do {
			const result = await page(nextToken);
			out.push(...result.users.map(toAdminUser));
			nextToken = result.nextToken;
		} while (nextToken);
		return out;
	};
	const pageOptions = (nextToken: string | undefined) => (nextToken === undefined ? {} : { nextToken });

	return {
		// ── GroupAdmin ───────────────────────────────────────────────────────
		addUserToGroup: (username: string, group: GroupOf<O>, ...gate: AdminActionGate<O, 'groups'>) => {
			void gate;
			return run('groups', (n) => n.admin.addUserToGroup(username, group));
		},
		removeUserFromGroup: (username: string, group: GroupOf<O>, ...gate: AdminActionGate<O, 'groups'>) => {
			void gate;
			return run('groups', (n) => n.admin.removeUserFromGroup(username, group));
		},
		listGroupsForUser: (username: string, ...gate: AdminActionGate<O, 'groups'>) => {
			void gate;
			return run('groups', async (n) => deps.narrowGroups(await n.listGroups(username)));
		},
		listUsersInGroup: (group: GroupOf<O>, ...gate: AdminActionGate<O, 'groups'>) => {
			void gate;
			return run('groups', (n) => allPages((token) => n.admin.listUsersInGroup(group, pageOptions(token))));
		},

		// ── LifecycleAdmin ───────────────────────────────────────────────────
		createUser: (
			username: string,
			...rest: AdminActionGate<O, 'lifecycle', [init?: AdminCreateInit<O>]>
		): Promise<AdminUser<O>> => {
			const [init]: [AdminCreateInit<O>?] = rest;
			return run('lifecycle', async (n) => {
				const attributes = deps.prefixAttributes(init?.attributes ?? {});
				// `validateUser` covers admin-created users too, as the pool's
				// PreSignUp trigger does (`PreSignUp_AdminCreateUser`).
				const clientMetadata = await deps.validateNewUser(username, attributes);
				return toAdminUser(
					await n.admin.createUser(username, {
						attributes,
						...(init?.temporaryPassword !== undefined ? { temporaryPassword: init.temporaryPassword } : {}),
						...(init?.suppressInvite ? { suppressInvite: true } : {}),
						...(clientMetadata ? { clientMetadata } : {}),
					}),
				);
			});
		},
		deleteUser: (username: string, ...gate: AdminActionGate<O, 'lifecycle'>) => {
			void gate;
			return run('lifecycle', (n) => n.admin.deleteUser(username));
		},
		disableUser: (username: string, ...gate: AdminActionGate<O, 'lifecycle'>) => {
			void gate;
			return run('lifecycle', (n) => n.admin.disableUser(username));
		},
		enableUser: (username: string, ...gate: AdminActionGate<O, 'lifecycle'>) => {
			void gate;
			return run('lifecycle', (n) => n.admin.enableUser(username));
		},
		resetUserPassword: (username: string, ...gate: AdminActionGate<O, 'lifecycle'>) => {
			void gate;
			return run('lifecycle', (n) => n.admin.resetUserPassword(username));
		},
		setUserPassword: (
			username: string,
			password: string,
			...rest: AdminActionGate<O, 'lifecycle', [options?: SetPasswordOptions]>
		): Promise<void> => {
			const [options]: [SetPasswordOptions?] = rest;
			return run('lifecycle', (n) =>
				n.admin.setUserPassword(username, password, { permanent: options?.permanent ?? false }),
			);
		},
		getUser: (username: string, ...gate: AdminActionGate<O, 'lifecycle'>) => {
			void gate;
			return run('lifecycle', async (n) => {
				const user = await n.admin.getUser(username);
				return user ? toAdminUser(user) : null;
			});
		},
		scan: (...rest: AdminActionGate<O, 'lifecycle', [filter?: AdminUserFilter]>): AsyncIterable<AdminUser<O>> => {
			const [filter]: [AdminUserFilter?] = rest;
			// Gate eagerly, so an ungranted call fails at the call site, not on first `next()`.
			assertAction('lifecycle');
			return (async function* () {
				let nextToken: string | undefined;
				do {
					const token = nextToken;
					const page = await run('lifecycle', (n) =>
						n.admin.listUsers({ ...(filter ? { filter } : {}), ...pageOptions(token) }),
					);
					yield* page.users.map(toAdminUser);
					nextToken = page.nextToken;
				} while (nextToken);
			})();
		},
		revokeUserSessions: (username: string, ...gate: AdminActionGate<O, 'lifecycle'>) => {
			void gate;
			return run('lifecycle', async (n) => {
				await n.admin.globalSignOut(username);
				// Make the revocation immediate: the session rows would otherwise stay
				// valid until their access token next needs refreshing.
				await deps.deleteSessionsOf(username);
			});
		},
	};
}
