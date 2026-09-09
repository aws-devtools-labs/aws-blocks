// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared sign-in-record poller for the AuthOIDC e2e suites.
 *
 * `onSignIn` fires while the OIDC callback is being served, and the test reads
 * the record back over a later, separate request. Two ways to get that wrong:
 *
 * 1. Read once. The write can still be in flight, so the read returns null.
 * 2. Ask for "the last sign-in" with no key. Another user, or another AuthOIDC
 *    instance's user, satisfies that instantly and the assertions run against
 *    the wrong record, which can pass by accident.
 *
 * Both are designed out here: `userId` is required, and the record is checked to
 * belong to that `userId` before it is returned.
 *
 * Sibling of `poll-for-code.ts`, which does the same job for verification codes.
 */

/** Shape of the sign-in record the backend hands back. */
export interface SignInRecord {
	userId: string;
	email: string | null;
	provider: string;
}

/** A backend `*GetLastSignInUser` method, scoped to one AuthOIDC instance. */
export type SignInReader = (userId: string) => Promise<SignInRecord | null>;

export interface PollForSignInOptions {
	/** How long to wait before giving up. Defaults to 15s. */
	maxMs?: number;
	/** Gap between reads. Defaults to 200ms. */
	intervalMs?: number;
}

/**
 * Poll `read` until the sign-in record for `userId` is available, then return it.
 *
 * @param label Method name used in the timeout message, e.g. `oidcGetLastSignInUser`.
 * @throws If no record appears within `maxMs`, or if a record arrives for a
 *         different `userId` (a backend keying bug, not a race).
 */
export async function pollForSignIn(
	label: string,
	read: SignInReader,
	userId: string,
	options: PollForSignInOptions = {},
): Promise<SignInRecord> {
	const { maxMs = 15000, intervalMs = 200 } = options;
	const start = Date.now();
	let seen: SignInRecord | null = null;

	while (Date.now() - start < maxMs) {
		seen = await read(userId);
		if (seen) {
			if (seen.userId !== userId) {
				throw new Error(
					`${label}(${userId}) returned a record for "${seen.userId}" — sign-ins are not keyed per user`,
				);
			}
			return seen;
		}
		await new Promise((resolve) => global.setTimeout(resolve, intervalMs));
	}

	throw new Error(`${label}(${userId}) returned no record after ${maxMs}ms`);
}

/**
 * Bind {@link pollForSignIn} to one instance's reader so suites can call
 * `poll(userId)` without repeating the label.
 *
 * @example
 * ```typescript
 * const pollSignIn = signInPoller('oidcGetLastSignInUser', (id) => api.oidcGetLastSignInUser(id));
 * const record = await pollSignIn(me.userId);
 * ```
 */
export function signInPoller(label: string, read: SignInReader) {
	return (userId: string, options?: PollForSignInOptions) => pollForSignIn(label, read, userId, options);
}
