// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared verification-code poller for the auth e2e suites.
 *
 * Every code-confirmed auth test needs the same thing: sign up, then wait for
 * the code that was delivered to that user. Two ways to get this wrong, both of
 * which have already cost us red builds (#172):
 *
 * 1. Read once instead of polling. Delivery is asynchronous and the read travels
 *    over a separate request, so a single read races the write and returns null.
 * 2. Wait for "any non-null code". A leftover record from another user satisfies
 *    that instantly, and the test then confirms the wrong user or rejects the
 *    code as invalid.
 *
 * Both are designed out here: `username` is required, and the returned record is
 * asserted to belong to that username before it is handed back. New suites
 * should use this rather than growing another local copy of the loop.
 */

/** Shape common to every delivered-code record the backend hands back. */
export interface DeliveredCodeRecord {
	username: string;
	code: string;
}

/** A backend `*GetLastCode` method, scoped to one auth channel. */
export type CodeReader<T extends DeliveredCodeRecord> = (username: string) => Promise<T | null>;

export interface PollForCodeOptions {
	/**
	 * Ignore this code and keep waiting for a different one. Resend and
	 * password-reset issue a second code for the same user, so without this a
	 * poll returns the already-consumed code that is still sitting in the store.
	 */
	not?: string;
	/** How long to wait before giving up. Defaults to 15s. */
	maxMs?: number;
	/** Gap between reads. Defaults to 200ms. */
	intervalMs?: number;
}

/**
 * Poll `read` until the code for `username` is available, then return it.
 *
 * @param label Method name used in the timeout message, e.g. `authGetLastCode`.
 * @throws If no matching code appears within `maxMs`, or if a record arrives
 *         for a different username (a backend keying bug, not a race).
 */
export async function pollForCode<T extends DeliveredCodeRecord>(
	label: string,
	read: CodeReader<T>,
	username: string,
	options: PollForCodeOptions = {},
): Promise<T> {
	const { not, maxMs = 15000, intervalMs = 200 } = options;
	const start = Date.now();
	let seen: T | null = null;

	while (Date.now() - start < maxMs) {
		seen = await read(username);
		if (seen) {
			if (seen.username !== username) {
				throw new Error(
					`${label}(${username}) returned a code for "${seen.username}" — codes are not keyed per user`,
				);
			}
			if (seen.code !== not) return seen;
		}
		await new Promise((resolve) => global.setTimeout(resolve, intervalMs));
	}

	throw new Error(
		`${label}(${username}) returned no ${not ? 'new ' : ''}code after ${maxMs}ms (last seen: ${JSON.stringify(seen)})`,
	);
}

/**
 * Bind {@link pollForCode} to one channel's reader so suites can call
 * `poll(username)` without repeating the label.
 *
 * @example
 * ```typescript
 * const pollAuthCode = codePoller('authGetLastCode', (u) => api.authGetLastCode(u));
 * const { code } = await pollAuthCode(username);
 * ```
 */
export function codePoller<T extends DeliveredCodeRecord>(label: string, read: CodeReader<T>) {
	return (username: string, options?: PollForCodeOptions) => pollForCode(label, read, username, options);
}
