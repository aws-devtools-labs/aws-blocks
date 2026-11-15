// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The pool a `bb-auth users` command acts on: the local (mock) pool in
 * `.bb-data/`, or the Cognito pool a deployed stack's `Auth` block owns.
 *
 * @internal
 */

/**
 * A refusal or failure the CLI reports as a message (exit code 1), not a stack
 * trace. Matched with `instanceof`; it never crosses the RPC wire.
 */
export class UsersCliError extends Error {}

/** The user a `<user>` argument names. */
export interface ResolvedUser {
	/** The pool's username (on an email sign-in pool, the generated id). */
	username: string;
	/** For display: `email` / `phone_number` when the pool has them. */
	email?: string;
	phoneNumber?: string;
	/** How `<user>` matched: as the username, or as the user's verified email / phone number. */
	matchedBy: 'username' | 'email' | 'phone_number';
}

export interface PoolTarget {
	/** `true` for a deployed pool: writes need `--yes`. */
	readonly deployed: boolean;
	/** A one-line description of the pool, e.g. `local pool my-app-auth (.bb-data/my-app-auth)`. */
	readonly description: string;
	/** The groups the block declares (`users.groups`). */
	readonly groups: readonly string[];
	/** Resolve the user `selector` names; throws {@link UsersCliError} for an unknown or ambiguous user. */
	resolveUser(selector: UserSelector): Promise<ResolvedUser>;
	groupsOf(username: string): Promise<string[]>;
	addToGroup(username: string, group: string): Promise<void>;
	removeFromGroup(username: string, group: string): Promise<void>;
}

/**
 * Who a command names: `<user>` (`any`: the username, else a verified email /
 * phone number), `--username` (that username only) or `--email` (the user
 * whose verified email it is).
 */
export interface UserSelector {
	by: 'any' | 'username' | 'email';
	value: string;
}

/** Whether `login` has the form of an email address or an E.164 phone number. */
export function contactAttributeOf(login: string): 'email' | 'phone_number' | undefined {
	if (/^\+\d{4,}$/.test(login)) return 'phone_number';
	return login.includes('@') ? 'email' : undefined;
}

/**
 * The message for a `<user>` that is one user's username and another user's
 * verified email / phone number: a username may look like an email (on a pool
 * that signs in with usernames), so neither reading is safe to pick.
 */
export function usernameShadowsContact(
	login: string,
	attribute: string,
	username: string,
	holder: string,
): UsersCliError {
	const flag = attribute === 'email' ? `--email ${login}` : `the username '${holder}' (--username ${holder})`;
	return new UsersCliError(
		`'${login}' is ambiguous: it is the username of user '${username}' and the verified ${attribute} of user ` +
			`'${holder}'. Say which one you mean: --username ${login}, or ${flag}.`,
	);
}

/** The message for a `<user>` that matched an unverified email / phone number. */
export function unverifiedMatch(login: string, attribute: string, username: string): UsersCliError {
	return new UsersCliError(
		`'${login}' is the ${attribute} of user '${username}', but the pool has not verified it: a user can set their ` +
			`own ${attribute} without proving they own it. Pass the username (--username ${username}) if this is the right user.`,
	);
}
