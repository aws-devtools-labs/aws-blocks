// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Test helpers for apps that use `Auth` locally: `@aws-blocks/bb-auth/testing`
 * (also re-exported from `@aws-blocks/blocks/utils`).
 *
 * **Node only.** These read the local (mock) user pool's files under
 * `.bb-data/`. Import them from test code, never from a frontend or a backend
 * module.
 *
 * @module
 */

import { join } from 'node:path';
import {
	dataDirOf,
	isLocalPoolState,
	isRecord,
	type LocalPoolDir,
	listLocalPools,
	readJson,
	selectBlocks,
} from './local-pool-files.js';
import type { CodeDeliveryPurpose } from './types.js';

/** Options for {@link getLastAuthCode}. */
export interface GetLastAuthCodeOptions {
	/**
	 * The `Auth` block to read, when the app has more than one that sends codes:
	 * its id (`'auth'` for `new Auth(scope, 'auth')`) or its full id
	 * (`'my-app-auth'`). Default: every local `Auth` block.
	 */
	block?: string;
	/** Only a code sent for this flow. Default: the most recent code of any flow. */
	purpose?: CodeDeliveryPurpose;
	/**
	 * The directory the dev server (or the test that constructs the backend)
	 * runs in: the one holding `.bb-data/`. Default `process.cwd()`.
	 */
	cwd?: string;
}

interface CodeCandidate {
	fullId: string;
	purpose: string;
	code: string;
	/** Orders codes by when they were sent: the code's expiry. */
	at: number;
}

const PURPOSES: readonly CodeDeliveryPurpose[] = ['signUp', 'resetPassword', 'mfa', 'attribute'];

function sameName(a: string, b: string): boolean {
	return a === b || a.toLowerCase() === b.toLowerCase();
}

/**
 * The stored usernames `login` can name in a local pool: the username itself;
 * otherwise the user whose username matches ignoring case, or whose email /
 * phone number it is (the name a code is sent for on an email or phone
 * sign-in pool).
 */
function storedUsernames(users: Record<string, unknown>, login: string): string[] {
	if (Object.hasOwn(users, login)) return [login];
	const out: string[] = [];
	for (const [username, user] of Object.entries(users)) {
		const attributes = isRecord(user) && isRecord(user.attributes) ? user.attributes : {};
		if (
			sameName(username, login) ||
			(typeof attributes.email === 'string' && sameName(attributes.email, login)) ||
			attributes.phone_number === login
		) {
			out.push(username);
		}
	}
	return out;
}

/** The attributes the pool sends a verification code to (`attribute:<name>:<username>`). */
const VERIFIABLE_ATTRIBUTES = ['email', 'phone_number'];

/**
 * A pool code key, parsed from the left: `<purpose>:<username>`, or
 * `attribute:<name>:<username>`. The username is everything after, so one
 * containing `:` (`x:bob`) is never mistaken for another (`bob`).
 */
function parseCodeKey(key: string): { purpose: CodeDeliveryPurpose; username: string } | undefined {
	const colon = key.indexOf(':');
	if (colon === -1) return undefined;
	const purpose = PURPOSES.find((p) => p === key.slice(0, colon));
	if (purpose === undefined) return undefined;
	let rest = key.slice(colon + 1);
	if (purpose === 'attribute') {
		const next = rest.indexOf(':');
		if (next === -1 || !VERIFIABLE_ATTRIBUTES.includes(rest.slice(0, next))) return undefined;
		rest = rest.slice(next + 1);
	}
	return rest === '' ? undefined : { purpose, username: rest };
}

/**
 * The codes pending for `login` in the block's pool. The pool keeps every
 * code it sent until it is used or expires (`<purpose>:<username>`, attribute
 * codes `attribute:<name>:<username>`), whereas `last-code.json` holds only
 * the block's most recent one: reading the pool keeps a user's code readable
 * after another user's replaced `last-code.json`, and never returns a used one.
 */
function codesFor(block: LocalPoolDir, login: string, purpose: string | undefined): CodeCandidate[] {
	const state = readJson(block.stateFile);
	if (!isLocalPoolState(state) || !isRecord(state.codes)) return [];
	const out: CodeCandidate[] = [];
	const now = Date.now();
	for (const username of storedUsernames(state.users, login)) {
		for (const [key, entry] of Object.entries(state.codes)) {
			if (!isRecord(entry) || typeof entry.code !== 'string' || typeof entry.exp !== 'number') continue;
			if (entry.exp < now) continue;
			const parsed = parseCodeKey(key);
			if (!parsed || parsed.username !== username) continue;
			const keyPurpose = parsed.purpose;
			if (purpose !== undefined && keyPurpose !== purpose) continue;
			// Every code lives as long (`CODE_TTL_MS`), so expiry orders codes by when they were sent.
			out.push({ fullId: block.fullId, purpose: keyPurpose, code: entry.code, at: entry.exp });
		}
	}
	return out;
}

/** What each block's `last-code.json` holds, for an error message. */
function describeLastCodes(blocks: readonly LocalPoolDir[]): string {
	const lines = blocks.map((b) => {
		const last = readJson(join(b.dir, 'last-code.json'));
		return isRecord(last) && typeof last.username === 'string'
			? `  ${b.fullId}: last code: ${String(last.purpose)} for '${last.username}'`
			: `  ${b.fullId}: no code sent yet`;
	});
	return lines.join('\n');
}

/**
 * The verification code the local `Auth` pool last sent to `username`: a
 * sign-up, password-reset, MFA or attribute-verification code. Use it in e2e
 * tests of those flows, against `npm run dev` or a backend the test
 * constructs, in place of a mailbox.
 *
 * `username` is the name the code was sent for: what the user signs in with
 * (their email on a `users.signInWith: ['email']` pool), as the
 * `codeDelivery` hook receives it.
 *
 * It finds the block's data directory itself, so it does not depend on the
 * scope or block name: it looks at every local `Auth` block under
 * `.bb-data/`, and reads the codes the pool still holds (`state.json`) rather
 * than `last-code.json`, which keeps only the block's most recent code. So a
 * user's code stays readable after another user's code was sent, and a code
 * that was used or has expired is not returned.
 *
 * Local only: against a deployed backend, Cognito emails the code and there
 * is nothing on disk to read.
 *
 * @param username - The name the code was sent for.
 * @param options - `block` (when more than one `Auth` block sends codes), `purpose`, `cwd`.
 * @returns The 6-digit code.
 * @throws Error when there is no local `Auth` data under `cwd`, when no block
 * matches `block`, or when no code for `username` (and `purpose`) is pending;
 * the message lists what each local block last sent.
 *
 * @example
 * ```ts
 * import { createTestClient, getLastAuthCode } from '@aws-blocks/blocks/utils';
 *
 * const alice = createTestClient(await import('aws-blocks'));
 * await alice.authApi.setAuthState({ action: 'signUp', username: 'alice@example.com', password });
 * const code = await getLastAuthCode('alice@example.com');
 * await alice.authApi.setAuthState({ action: 'confirmSignUp', username: 'alice@example.com', code });
 * ```
 */
export async function getLastAuthCode(username: string, options: GetLastAuthCodeOptions = {}): Promise<string> {
	const dataDir = dataDirOf(options.cwd ?? process.cwd());
	const all = listLocalPools(dataDir);
	if (all.length === 0) {
		throw new Error(
			`getLastAuthCode: no local Auth data under ${dataDir}. It reads the codes the local (mock) user pool ` +
				'writes there: run the test from the directory the dev server runs in (or pass `cwd`), and sign up or ' +
				'request a code first. Against a deployed backend, Cognito emails the code and there is nothing local to read.',
		);
	}
	const blocks = selectBlocks(all, options.block);
	if (blocks.length === 0) {
		throw new Error(
			`getLastAuthCode: No local Auth block matches '${options.block}'. Local Auth blocks: ${all.map((b) => b.fullId).join(', ')}.`,
		);
	}
	const candidates = blocks.flatMap((b) => codesFor(b, username, options.purpose));
	if (candidates.length === 0) {
		const what = options.purpose ? `No ${options.purpose} code` : 'No code';
		throw new Error(
			`getLastAuthCode: ${what} for '${username}' is pending in the local Auth pool${blocks.length > 1 ? 's' : ''}:\n` +
				`${describeLastCodes(blocks)}\n` +
				'Pass the name the user signs in with (their email on an email sign-in pool), after the call that sends the code.',
		);
	}
	candidates.sort((a, b) => b.at - a.at);
	return candidates[0].code;
}
