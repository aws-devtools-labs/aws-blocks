// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

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
		this.name = options?.name ?? 'ApiError';
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
 * Native JS error constructor names. Excluded from
 * {@link isExpectedBlocksError} because a thrown `TypeError`/`RangeError`/etc.
 * almost always signals an unexpected bug whose stack trace is valuable.
 */
const NATIVE_ERROR_NAMES = new Set([
	'Error',
	'EvalError',
	'RangeError',
	'ReferenceError',
	'SyntaxError',
	'TypeError',
	'URIError',
	'AggregateError',
]);

/**
 * Best-effort predicate for "this is an expected, typed Blocks error".
 *
 * Used by the dev server and Lambda handler to decide whether dumping a full
 * multi-line stack trace adds signal: expected typed errors are already fully
 * described by their `name` + `message`, so the stack is noise; genuinely
 * unexpected errors (bugs) keep their stack.
 *
 * Conservative by design. Only errors whose `name` follows the Blocks
 * convention — a non-native name ending in `Exception` or `Error` (e.g.
 * `KnowledgeBaseNotReadyException`, `HandlerTimeoutError`, the `ApiError`
 * wire base class) — are treated as expected. Anything else (plain `Error`,
 * native subclasses like `TypeError`, or an unnamed throw) is treated as
 * unexpected so its stack is still surfaced. When in doubt, return `false`
 * (keep the stack).
 */
export function isExpectedBlocksError(e: unknown): boolean {
	if (!(e instanceof Error)) return false;
	const name = e.name;
	if (!name || NATIVE_ERROR_NAMES.has(name)) return false;
	return name.endsWith('Exception') || name.endsWith('Error');
}
