// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The Cognito admin engine behind `auth.admin` (task D5c2): Cognito's `Admin*`
 * / `List*` APIs on the pool, ported from `AuthCognito`'s AWS
 * `buildAdminSurface` (with B6's fixes). `AuthBase` (`auth-admin.ts`) owns
 * everything engine-agnostic — the `admin` / `admin.actions` gates, `custom:`
 * prefixing, group narrowing, paging and `revokeUserSessions`' session-row
 * deletion — so this module only talks to Cognito and returns data.
 *
 * Inside the trust boundary: errors are thrown raw, with **no** enumeration
 * masking (`UserNotFoundException` / `ResourceNotFoundException` reach the
 * caller as 404s), except `getUser`, which answers an unknown user with
 * `null` (G3).
 *
 * IAM: every command here is in `adminIamActions()` (`cdk/mappers.ts`), under
 * the slice (`groups` / `lifecycle`) whose methods send it;
 * `iam-coverage.cdk.test.ts` proves it against a real synth.
 *
 * Internal — not exported from any package entry.
 *
 * @internal
 */

import {
	AdminAddUserToGroupCommand,
	AdminCreateUserCommand,
	AdminDeleteUserCommand,
	AdminDisableUserCommand,
	AdminEnableUserCommand,
	AdminGetUserCommand,
	type AdminGetUserCommandOutput,
	AdminRemoveUserFromGroupCommand,
	AdminResetUserPasswordCommand,
	AdminSetUserPasswordCommand,
	AdminUserGlobalSignOutCommand,
	type CognitoIdentityProviderClient,
	ListUsersCommand,
	ListUsersInGroupCommand,
	type UserType,
} from '@aws-sdk/client-cognito-identity-provider';
import { AuthErrors } from '../errors.js';
import type { AdminUserFilter } from '../types.js';
import { checkAttributeValues } from './attribute-write-rules.js';
import type { NativeAdminEngine, NativeAdminUser } from './types.js';

/** What the admin engine needs from the Cognito engine. Every member is resolved at call time. */
export interface CognitoAdminDeps {
	/** The lazily created SDK client. */
	client(): CognitoIdentityProviderClient;
	/** The pool id, resolved now (throws `userPoolNotProvisioned` when absent). */
	userPoolId(): string;
	/** Every group of `username` (`AdminListGroupsForUser`, paginated). */
	listGroups(username: string): Promise<string[]>;
}

/** Cognito's maximum `ListUsers` page size. */
const LIST_USERS_LIMIT = 60;

/** `[{ Name, Value }]` → `{ Name: Value }`; a missing value is `''` (as `AuthCognito`). */
function attributeRecord(list: readonly { Name?: string; Value?: string }[] | undefined): Record<string, string> {
	const out: Record<string, string> = {};
	for (const a of list ?? []) if (a.Name) out[a.Name] = a.Value ?? '';
	return out;
}

/** A Cognito `UserType` (`ListUsers`, `ListUsersInGroup`, `AdminCreateUser`) as the admin engine reports it. */
function fromUserType(u: UserType): NativeAdminUser {
	const attributes = attributeRecord(u.Attributes);
	return { username: u.Username ?? '', userSub: attributes.sub ?? '', enabled: u.Enabled ?? true, attributes };
}

/**
 * An {@link AdminUserFilter} as a Cognito `ListUsers` `Filter` expression:
 * `^=` for a prefix match, `=` for an exact one, the value quoted with `"`
 * escaped.
 *
 * @internal
 */
export function toCognitoFilter(filter: AdminUserFilter): string {
	const op = filter.match === 'startsWith' ? '^=' : '=';
	return `${filter.attribute} ${op} "${filter.value.replace(/"/g, '\\"')}"`;
}

/** Whether `e` is the function role lacking a grant (a hand-narrowed IAM policy). */
function isAccessDenied(e: unknown): boolean {
	return e instanceof Error && /AccessDenied|NotAuthorized/.test(e.name);
}

/**
 * Build the Cognito admin engine. Creates nothing: the SDK client and the pool
 * id are resolved on each call.
 *
 * @internal
 */
export function cognitoAdminEngine(deps: CognitoAdminDeps): NativeAdminEngine {
	const pool = (username: string) => ({ UserPoolId: deps.userPoolId(), Username: username });

	return {
		// ── groups ───────────────────────────────────────────────────────────
		async addUserToGroup(username, group) {
			await deps.client().send(new AdminAddUserToGroupCommand({ ...pool(username), GroupName: group }));
		},
		async removeUserFromGroup(username, group) {
			await deps.client().send(new AdminRemoveUserFromGroupCommand({ ...pool(username), GroupName: group }));
		},
		async listUsersInGroup(group, options) {
			const resp = await deps.client().send(
				new ListUsersInGroupCommand({
					UserPoolId: deps.userPoolId(),
					GroupName: group,
					...(options.nextToken ? { NextToken: options.nextToken } : {}),
				}),
			);
			return {
				users: (resp.Users ?? []).map(fromUserType),
				...(resp.NextToken ? { nextToken: resp.NextToken } : {}),
			};
		},

		// ── lifecycle ────────────────────────────────────────────────────────
		async createUser(username, init) {
			// The schema-independent rules, before the SDK call (FX43); an
			// administrator may write the verified flags.
			checkAttributeValues(init.attributes, 'adminCreateUser');
			const attributes = Object.entries(init.attributes).map(([Name, Value]) => ({ Name, Value }));
			const resp = await deps.client().send(
				new AdminCreateUserCommand({
					...pool(username),
					// Omitted: Cognito generates a temporary password that meets the pool policy.
					...(init.temporaryPassword !== undefined ? { TemporaryPassword: init.temporaryPassword } : {}),
					...(attributes.length > 0 ? { UserAttributes: attributes } : {}),
					...(init.suppressInvite ? { MessageAction: 'SUPPRESS' } : {}),
					...(init.clientMetadata ? { ClientMetadata: init.clientMetadata } : {}),
				}),
			);
			// A user Cognito has just created is in no group, so `groups: []` is known
			// without a read — and matches what the local engine reports.
			const created = resp.User
				? fromUserType(resp.User)
				: { username, userSub: '', enabled: true, attributes: {} };
			return { ...created, groups: [] };
		},
		async deleteUser(username) {
			await deps.client().send(new AdminDeleteUserCommand(pool(username)));
		},
		async disableUser(username) {
			await deps.client().send(new AdminDisableUserCommand(pool(username)));
		},
		async enableUser(username) {
			await deps.client().send(new AdminEnableUserCommand(pool(username)));
		},
		async resetUserPassword(username) {
			await deps.client().send(new AdminResetUserPasswordCommand(pool(username)));
		},
		async setUserPassword(username, password, options) {
			await deps.client().send(
				new AdminSetUserPasswordCommand({
					...pool(username),
					Password: password,
					Permanent: options.permanent,
				}),
			);
		},
		async getUser(username) {
			let resp: AdminGetUserCommandOutput;
			try {
				resp = await deps.client().send(new AdminGetUserCommand(pool(username)));
			} catch (e) {
				// G3: a read of a missing user is `null`, never `UserNotFoundException`.
				if (e instanceof Error && e.name === AuthErrors.UserNotFound) return null;
				throw e;
			}
			const attributes = attributeRecord(resp.UserAttributes);
			// AdminGetUser does not report group memberships, so read them too (the
			// mock reports them from its state). The lifecycle IAM slice grants
			// AdminListGroupsForUser for exactly this; if a hand-narrowed policy
			// omits it, degrade to `groups` absent rather than failing the read.
			let groups: string[] | undefined;
			try {
				groups = await deps.listGroups(username);
			} catch (e) {
				if (e instanceof Error && e.name === AuthErrors.UserNotFound) return null;
				if (!isAccessDenied(e)) throw e;
			}
			return {
				username: resp.Username ?? username,
				userSub: attributes.sub ?? '',
				enabled: resp.Enabled ?? true,
				attributes,
				...(groups ? { groups } : {}),
			};
		},
		async listUsers(options) {
			const resp = await deps.client().send(
				new ListUsersCommand({
					UserPoolId: deps.userPoolId(),
					Limit: LIST_USERS_LIMIT,
					...(options.filter ? { Filter: toCognitoFilter(options.filter) } : {}),
					...(options.nextToken ? { PaginationToken: options.nextToken } : {}),
				}),
			);
			return {
				users: (resp.Users ?? []).map(fromUserType),
				...(resp.PaginationToken ? { nextToken: resp.PaginationToken } : {}),
			};
		},
		async globalSignOut(username) {
			await deps.client().send(new AdminUserGlobalSignOutCommand(pool(username)));
		},
	};
}
