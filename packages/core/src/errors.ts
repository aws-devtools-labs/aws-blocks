// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The `name` an `ApiError` falls back to when no structured error name is
 * given. A name equal to this carries no BB-level meaning, so consumers
 * branching on the structured identity should treat it as "no name".
 */
export const DEFAULT_API_ERROR_NAME = 'ApiError';

/**
 * Error subclass for errors that cross the wire between server and client.
 *
 * Carries a `status` (HTTP status code) and sets `name` to the BB-level
 * error name (e.g., `'ConditionalCheckFailedException'`). Both are
 * serialized to the client. `cause` stays server-side.
 *
 * @example
 * ```typescript
 * // Backend: catch a BB error and re-throw with status
 * try {
 *   await store.put(key, value, { ifNotExists: true });
 * } catch (e: unknown) {
 *   if (isBlocksError(e, KVStoreErrors.ConditionalCheckFailed)) {
 *     throw new ApiError('Username already taken', 409, { name: e.name, cause: e });
 *   }
 *   throw e;
 * }
 *
 * // Frontend: same isBlocksError works
 * try {
 *   await api.createUser('alice', 'pass');
 * } catch (e: unknown) {
 *   if (isBlocksError(e, KVStoreErrors.ConditionalCheckFailed)) {
 *     showMessage('Username already taken');
 *   }
 * }
 * ```
 */
export class ApiError extends Error {
	/** HTTP status code. */
	readonly status: number;
	/**
	 * Whether the caller can retry the same action without restarting the
	 * broader flow. Semantically meaningful for multi-step state machines
	 * like auth challenges: the same session token / envelope can be reused
	 * with a corrected input (wrong MFA code, wrong password on re-prompt)
	 * when `retriable === true`; non-retriable errors (expired session,
	 * tampered envelope, too-many-attempts lockouts) require restarting the
	 * flow. Defaults to `false` when unspecified.
	 */
	readonly retriable: boolean;

	constructor(message: string, status: number, options?: { name?: string; cause?: unknown; retriable?: boolean }) {
		super(message, options?.cause ? { cause: options.cause } : undefined);
		this.name = options?.name ?? DEFAULT_API_ERROR_NAME;
		this.status = status;
		this.retriable = options?.retriable ?? false;
	}
}

/**
 * Type guard for narrowing `unknown` catch variables against BB error constants.
 *
 * Checks `error.name` — works identically on both server and client because
 * `ApiError` reconstructed from the wire preserves the error name.
 *
 * @example
 * ```typescript
 * catch (e: unknown) {
 *   if (isBlocksError(e, KVStoreErrors.ConditionalCheckFailed)) {
 *     // e is narrowed to Error & { name: 'ConditionalCheckFailedException' }
 *   }
 * }
 * ```
 */
export function isBlocksError<N extends string>(e: unknown, name: N): e is Error & { name: N } {
	return e instanceof Error && e.name === name;
}

/**
 * Type guard for branching on a failed `AuthState` (the recommended
 * `setAuthState` client path) by its structured `errorName`.
 *
 * The returned state is a plain object, not a thrown `Error`, so
 * `isBlocksError` does not apply — use this on the value returned by
 * `setAuthState`/`getAuthState`. Match on the BB error constant, never on
 * the human-facing `error` string.
 *
 * @example
 * ```typescript
 * const next = await authApi.setAuthState({ action: 'signIn', username, password });
 * if (hasAuthError(next, AuthBasicErrors.InvalidCredentials)) {
 *   // unknown user → fall back to sign-up
 * }
 * ```
 */
export function hasAuthError<T extends { errorName?: string }, N extends string>(
	state: T | null | undefined,
	name: N,
): state is T & { errorName: N } {
	return state?.errorName === name;
}
