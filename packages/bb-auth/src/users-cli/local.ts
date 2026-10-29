// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `bb-auth users …` against the local (mock) pool: `.bb-data/<fullId>/state.json`.
 *
 * The file is edited the way the pool writes it (write-then-rename), keeping
 * every key this CLI does not touch. A running dev server holds the pool in
 * memory and writes all of it back on its next change, which would undo the
 * edit, so a write refuses while one runs.
 *
 * @internal
 */

import { readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import {
	dataDirOf,
	isLocalPoolState,
	isRecord,
	type LocalPoolDir,
	type LocalPoolState,
	listLocalPools,
	readJson,
	selectBlocks,
} from '../local-pool-files.js';
import {
	contactAttributeOf,
	type PoolTarget,
	type ResolvedUser,
	UsersCliError,
	type UserSelector,
	unverifiedMatch,
	usernameShadowsContact,
} from './target.js';

/** Where the dev server records its process (`@aws-blocks/core`'s singleton guard): `.blocks-sandbox/dev-server.<port>.pid`. */
const PIDFILE = /^dev-server\.\d+\.pid$/;

/** True when a signal can be delivered to `pid`. `EPERM` (exists, not ours) counts as alive. */
export function isPidAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 1) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return e instanceof Error && 'code' in e && e.code === 'EPERM';
	}
}

/** The pids of the dev servers running from `cwd`, per their pidfiles. */
export function runningDevServers(cwd: string, alive: (pid: number) => boolean = isPidAlive): number[] {
	const dir = join(resolve(cwd), '.blocks-sandbox');
	let names: string[];
	try {
		names = readdirSync(dir).filter((n) => PIDFILE.test(n));
	} catch {
		return [];
	}
	const pids: number[] = [];
	for (const name of names) {
		const record = readJson(join(dir, name));
		if (isRecord(record) && typeof record.pid === 'number' && alive(record.pid)) pids.push(record.pid);
	}
	return pids;
}

function attributesOf(user: unknown): Record<string, unknown> {
	return isRecord(user) && isRecord(user.attributes) ? user.attributes : {};
}

function str(v: unknown): string | undefined {
	return typeof v === 'string' ? v : undefined;
}

/** The pool behind `--block` (or the only one) under `cwd`. */
export function selectLocalPool(cwd: string, block: string | undefined): LocalPoolDir {
	const dataDir = dataDirOf(cwd);
	const all = listLocalPools(dataDir);
	if (all.length === 0) {
		throw new UsersCliError(
			`No local user pool under ${dataDir}. Run this from your project's root after \`npm run dev\` has started ` +
				'once (the local pool is created when the backend loads). For a deployed pool, pass --stage or --stack.',
		);
	}
	const matched = selectBlocks(all, block);
	if (matched.length === 1) return matched[0];
	const list = all.map((p) => p.fullId).join(', ');
	if (matched.length === 0)
		throw new UsersCliError(`No local Auth block matches --block '${block}'. Local Auth blocks: ${list}.`);
	throw new UsersCliError(
		block === undefined
			? `This app has ${all.length} local Auth blocks (${list}): pass --block <id> to pick one.`
			: `--block '${block}' matches ${matched.map((p) => p.fullId).join(', ')}: pass the full id.`,
	);
}

/** A {@link PoolTarget} over a local pool's `state.json`. */
export function localTarget(pool: LocalPoolDir, cwd: string): PoolTarget {
	const read = (): LocalPoolState => {
		let state: unknown;
		try {
			state = JSON.parse(readFileSync(pool.stateFile, 'utf8'));
		} catch (e) {
			throw new UsersCliError(
				`Could not read the local pool ${pool.stateFile}: ${e instanceof Error ? e.message : e}`,
			);
		}
		if (!isLocalPoolState(state)) throw new UsersCliError(`${pool.stateFile} is not a local user pool.`);
		return state;
	};
	const write = (state: LocalPoolState): void => {
		const tmp = `${pool.stateFile}.tmp`;
		writeFileSync(tmp, JSON.stringify(state, null, 2));
		renameSync(tmp, pool.stateFile);
	};
	const members = (state: LocalPoolState, group: string): string[] => {
		const list = Object.hasOwn(state.groups, group) ? state.groups[group] : undefined;
		if (!Array.isArray(list)) throw new UsersCliError(`The local pool has no group '${group}'.`);
		return list.filter((u): u is string => typeof u === 'string');
	};
	const initial = read();
	return {
		deployed: false,
		description: `local pool ${pool.fullId} (${relative(resolve(cwd), pool.stateFile) || pool.stateFile})`,
		// Every group `users.groups` declares: the pool creates them when the backend loads.
		groups: Object.keys(initial.groups),
		async resolveUser(selector) {
			return resolveLocalUser(read().users, selector);
		},
		async groupsOf(username) {
			const state = read();
			return Object.keys(state.groups).filter((g) => members(state, g).includes(username));
		},
		async addToGroup(username, group) {
			const state = read();
			const list = members(state, group);
			if (!list.includes(username)) list.push(username);
			state.groups[group] = list;
			write(state);
		},
		async removeFromGroup(username, group) {
			const state = read();
			state.groups[group] = members(state, group).filter((u) => u !== username);
			write(state);
		},
	};
}

/** Users whose `attribute` is `value` (email ignoring case), with whether the pool verified it. */
function holdersOf(
	users: Record<string, unknown>,
	attribute: 'email' | 'phone_number',
	value: string,
): { username: string; verified: boolean }[] {
	const out: { username: string; verified: boolean }[] = [];
	for (const [username, user] of Object.entries(users)) {
		const attributes = attributesOf(user);
		const held = str(attributes[attribute]);
		const same = attribute === 'email' ? held?.toLowerCase() === value.toLowerCase() : held === value;
		if (same) out.push({ username, verified: attributes[`${attribute}_verified`] === 'true' });
	}
	return out;
}

/**
 * The user `selector` names.
 *
 * - `any` (`<user>`): the username itself, else the user whose **verified**
 *   email / phone number it is. An unverified one is refused — a signed-in
 *   user can set their own email to anything — and so is a value two users
 *   hold. A username that has the form of an email / phone number is refused
 *   too when another user holds that value verified: on a pool that signs in
 *   with usernames, anyone can register the username `boss@example.com`.
 * - `username` (`--username`): that username only.
 * - `email` (`--email`): the one user whose verified email it is.
 */
export function resolveLocalUser(users: Record<string, unknown>, selector: UserSelector): ResolvedUser {
	const login = selector.value;
	const display = (username: string, matchedBy: ResolvedUser['matchedBy']): ResolvedUser => {
		const attributes = attributesOf(users[username]);
		return { username, email: str(attributes.email), phoneNumber: str(attributes.phone_number), matchedBy };
	};
	if (selector.by === 'username') {
		if (Object.hasOwn(users, login)) return display(login, 'username');
		throw new UsersCliError(`No user with the username '${login}' in the local pool.`);
	}
	if (selector.by === 'email') {
		const holders = holdersOf(users, 'email', login);
		const verified = holders.filter((h) => h.verified);
		if (verified.length === 1) return display(verified[0].username, 'email');
		if (verified.length > 1) {
			throw new UsersCliError(
				`'${login}' is the verified email of more than one user (${verified.map((h) => h.username).join(', ')}): pass --username.`,
			);
		}
		if (holders.length > 0) throw unverifiedMatch(login, 'email', holders[0].username);
		throw new UsersCliError(`No user has the email '${login}' in the local pool.`);
	}
	const contact = contactAttributeOf(login);
	if (Object.hasOwn(users, login)) {
		if (contact) {
			const other = holdersOf(users, contact, login).find((h) => h.verified && h.username !== login);
			if (other) throw usernameShadowsContact(login, contact, login, other.username);
		}
		return display(login, 'username');
	}
	const matches = [
		...holdersOf(users, 'email', login).map((h) => ({ ...h, attribute: 'email' as const })),
		...holdersOf(users, 'phone_number', login).map((h) => ({ ...h, attribute: 'phone_number' as const })),
	];
	if (matches.length === 0) throw new UsersCliError(`No user '${login}' in the local pool.`);
	const verified = matches.filter((m) => m.verified);
	if (verified.length === 1) return display(verified[0].username, verified[0].attribute);
	if (verified.length > 1 || matches.length > 1) {
		throw new UsersCliError(
			`'${login}' is the email / phone number of more than one user (${matches.map((m) => m.username).join(', ')}): pass --username.`,
		);
	}
	throw unverifiedMatch(login, matches[0].attribute, matches[0].username);
}
