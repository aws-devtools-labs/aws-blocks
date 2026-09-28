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
	 *
	 * This marks whether the *kind* of failure is retriable in principle, not a
	 * guarantee that a given retry will succeed — e.g. an optimistic-lock
	 * conflict against a missing row is flagged retriable, yet a blind retry
	 * fails identically.
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
 * Marker set on errors produced by {@link blocksError}. It is the RPC
 * serializer's *unambiguous intentional signal* that an error's `name` is a
 * Building Block error constant safe to send over the wire — as opposed to a
 * raw driver/SDK exception (`PostgresError`, `DynamoDBServiceException`) whose
 * class name happens to be non-generic but must never leak. Inferring intent
 * from `.name !== 'Error'` alone cannot tell the two apart; this brand can.
 *
 * Non-enumerable so it never appears in `JSON.stringify(error)` or log dumps.
 */
export const BLOCKS_ERROR_BRAND = Symbol.for('aws-blocks.wireSafeError');

/**
 * True when `e` is a Building Block error thrown via {@link blocksError} (or an
 * {@link ApiError}, which is wire-safe by construction). The RPC serializer uses
 * this to decide whether an error's `name` may cross the wire.
 */
export function isWireSafeError(e: unknown): e is Error {
	return e instanceof ApiError || (e instanceof Error && (e as { [BLOCKS_ERROR_BRAND]?: true })[BLOCKS_ERROR_BRAND] === true);
}

/**
 * Stamp the non-enumerable {@link BLOCKS_ERROR_BRAND} onto an already-built named
 * `Error` and return it, so its `name` crosses the RPC wire (D-003) instead of
 * being collapsed to a nameless 500.
 *
 * This is the single source of truth for the brand. Every Building Block that
 * throws a named error — whether through its own local `blocksError()` helper
 * (whose message format differs per package) or by building an `Error` inline —
 * routes it through this one helper so the "intentional BB error" signal never
 * diverges per package. It has no runtime dependencies, so it is safe in every
 * bundle (mock, aws-runtime, CDK synth), and `Symbol.for()` keeps the brand
 * valid across separately-bundled packages.
 *
 * Only stamp an error whose `name` is a BB error constant. Do NOT brand a raw
 * driver/SDK exception (`PostgresError`, `DynamoDBServiceException`) — the brand
 * is exactly the signal that keeps those class names from leaking.
 *
 * @example
 * ```typescript
 * const err = new Error(`${EmailErrors.InvalidInput}: bad address`);
 * err.name = EmailErrors.InvalidInput;
 * throw brandBlocksError(err);
 * ```
 */
export function brandBlocksError<T extends Error>(err: T): T {
	Object.defineProperty(err, BLOCKS_ERROR_BRAND, { value: true, enumerable: false });
	return err;
}

/**
 * Build a named `Error` whose `name` is a BB error constant, so it is matchable
 * with {@link isBlocksError} on both server and client. The name is also
 * prefixed into the message for readable logs.
 *
 * This is the producer half of the {@link isBlocksError} contract: throw via
 * this helper so the `name` a consumer matches on is set consistently. It has
 * no runtime dependencies, so it is safe to use in every bundle — mock,
 * aws-runtime, and CDK synth.
 *
 * The error also carries the non-enumerable {@link BLOCKS_ERROR_BRAND} (via
 * {@link brandBlocksError}), the signal the RPC serializer reads to forward this
 * `name` over the wire while still collapsing raw driver/SDK exceptions to a
 * nameless 500.
 *
 * @example
 * ```typescript
 * throw blocksError(KVStoreErrors.ConditionalCheckFailed, 'Key already exists');
 * ```
 */
export function blocksError(name: string, message: string): Error {
	const err = new Error(`${name}: ${message}`);
	err.name = name;
	return brandBlocksError(err);
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
