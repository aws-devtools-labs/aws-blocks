// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ChildLogger } from '@aws-blocks/bb-logger';
import { ApiError, brandBlocksError, blocksError as coreBlocksError } from '@aws-blocks/core';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { createDefu } from 'defu';
import type { ReadValidationMode } from './types.js';

/**
 * Typed error constants for KVStore. Use with `isBlocksError()` in catch blocks.
 *
 * Error names match the underlying DynamoDB error names where one exists, so
 * customers familiar with AWS encounter familiar strings.
 *
 * @example
 * ```typescript
 * import { isBlocksError } from '@aws-blocks/core';
 * import { KVStoreErrors } from '@aws-blocks/bb-kv-store';
 *
 * try {
 *   await store.put('key', value, { ifNotExists: true });
 * } catch (e: unknown) {
 *   if (isBlocksError(e, KVStoreErrors.ConditionalCheckFailed)) {
 *     // key already exists
 *   }
 *   throw e;
 * }
 * ```
 */
export const KVStoreErrors = {
	/** A condition on `put` or `delete` failed. Serializes to HTTP 409 (Conflict). */
	ConditionalCheckFailed: 'ConditionalCheckFailedException',
	/**
	 * A value fails the schema, disagrees with its key, has a top-level field
	 * that starts with the reserved prefix `_bkv_`, or has an empty string in a
	 * key field or an indexed field. Also a bad expiry (`ttlSeconds` together
	 * with `expiresAt`, or a time that is not usable).
	 */
	ValidationFailed: 'ValidationFailedException',
	/**
	 * The call has the wrong shape and was rejected before reaching DynamoDB: a
	 * key of the wrong shape, a missing `where` clause, a partition key not
	 * given as `{ equals: value }`, an unknown index, a `limit` that is not a positive integer, more than one sort-key
	 * condition, an empty `ifFieldEquals`, `ifValueEquals` with an object value,
	 * or a cursor that does not decode or belongs to another store, index, or
	 * partition. These are all caller bugs — something the caller can fix by
	 * correcting the call. Catchable via `isBlocksError(e, KVStoreErrors.InvalidQuery)`.
	 *
	 * Kept distinct from {@link KVStoreErrors.ItemTooLarge} (a runtime data
	 * condition) so a customer can tell "my query is wrong" from "this item is
	 * too big" by name alone rather than string-matching the message.
	 */
	InvalidQuery: 'InvalidQueryException',
	/**
	 * The item exceeds DynamoDB's 400 KB per-item size limit. Catchable via
	 * `isBlocksError(e, KVStoreErrors.ItemTooLarge)`. Unlike an invalid query,
	 * this is not necessarily a caller bug — the size of a given item may be
	 * outside the caller's control — so callers may want to branch on it (skip,
	 * split, or store a reference instead).
	 *
	 * In the AWS layer, DynamoDB raises a generic `ValidationException` for
	 * many conditions. KVStore inspects the error message for size-specific
	 * text (e.g. "size has exceeded") before mapping it to this error. Other
	 * `ValidationException` causes (malformed expressions, type mismatches,
	 * reserved-word conflicts) propagate as-is.
	 *
	 * In the mock layer, a client-side byte-length check produces this error
	 * deterministically before any I/O.
	 */
	ItemTooLarge: 'ItemTooLargeException',
	/**
	 * A batch operation could not complete all entries within the retry budget.
	 * DynamoDB batch APIs return UnprocessedKeys/UnprocessedItems (HTTP 200) under
	 * sustained throttling; when retries are exhausted we surface this so callers
	 * can back off and resubmit rather than silently losing writes or mistaking a
	 * throttled read for a missing item.
	 *
	 * The in-memory mock never throttles, so it never produces this error — the
	 * constant is shared purely so catch-site handling is identical across both.
	 */
	BatchIncomplete: 'BatchIncompleteException',
} as const;

/**
 * The set of error names this Building Block can produce. Deriving it from the
 * `KVStoreErrors` constant lets `blocksError` reject a stray string name at
 * compile time, so every mint site passes a known code.
 */
export type KVStoreErrorName = (typeof KVStoreErrors)[keyof typeof KVStoreErrors];

/**
 * @internal Build an Error whose `name` carries the typed error code (so callers
 * can match it with `isBlocksError`). The `name` param is typed to
 * `KVStoreErrorName`, so a stray string is caught at compile time. Shared by the
 * mock and AWS runtime so both produce identically shaped errors. Delegates to
 * core's `blocksError` so the minting (prefixing, naming, wire-safe branding)
 * lives in one place.
 */
export function blocksError(name: KVStoreErrorName, message: string): Error {
	return coreBlocksError(name, message);
}

/**
 * @internal Build the 409 ApiError for a conditional-write conflict. Maps to
 * HTTP 409 (Conflict) so the JSON-RPC serializer emits code 409 instead of a
 * generic 500, preserves the `ConditionalCheckFailed` name so `isBlocksError()`
 * keeps matching on both server and client. Shared by the mock and AWS runtime
 * so both produce an identically shaped 409; on AWS the caught DynamoDB
 * `ConditionalCheckFailedException` is passed as `cause` (kept server-side by
 * ApiError).
 *
 * `retriable` is scoped to the assertion kind: `true` whenever a value check
 * (`ifFieldEquals` / `ifValueEquals`) took part in a failed `put` — under OR
 * composition the combined failure means the key exists but its value differs,
 * so a re-read and retry can succeed — and for a failed `delete` whose value
 * check ran without `ifExists`; `false` for existence/uniqueness assertions
 * (`ifNotExists` on put, `ifExists` on delete), where a blind identical retry
 * fails identically. DynamoDB collapses every conditional failure under one
 * `ConditionalCheckFailedException` with no sub-reason, so the AWS runtime
 * decides this from the conditions the caller set on that specific put/delete.
 */
export function conditionalCheckFailed(retriable: boolean, cause?: unknown): ApiError {
	return new ApiError('The conditional request failed', 409, {
		name: KVStoreErrors.ConditionalCheckFailed,
		cause,
		retriable,
	});
}

/**
 * @internal Validation messages shared by the mock and AWS runtime. Centralised
 * here so the two implementations stay byte-for-byte in lockstep — parity tests
 * assert the same wording against both.
 */
export const KVStoreMessages = {
	indexNotFound: (index: string | undefined) => `Index '${index}' not found`,
	whereRequired: (pkField: string) => `query() requires a 'where' clause with partition key field '${pkField}'`,
	partitionKeyEqualsRequired: (pkField: string) =>
		`query() requires '${pkField}: { equals: value }' in the where clause (partition key must be an exact match)`,
	multipleSortKeyConditions: (conditionKeys: string[]) =>
		`Only one sort key condition is allowed per query (DynamoDB limitation). ` +
		`Got: ${conditionKeys.join(', ')}. Use "between" for range queries.`,
	queryNeedsKeyOrIndex:
		'query() without `index` needs a store with a declared `key`; pass `index` or declare a `key`',
	emptyIfFieldEquals: 'ifFieldEquals must contain at least one field with a non-undefined value',
	ifFieldEqualsNotObject: 'ifFieldEquals takes an object of fields to compare',
	ifValueEqualsObject:
		'ifValueEquals takes a value that is not an object; compare an object value with ifFieldEquals',
	bothValueChecks: 'pass either ifFieldEquals or ifValueEquals, not both',
	keyMustBeString: (received: string) => `this store takes a string key (received ${received})`,
	keyMustBeObject: (fields: string[]) => `this store takes a key object with exactly the fields ${fields.join(', ')}`,
	keyFieldType: (field: string, type: 'S' | 'N', received: string) =>
		`key field '${field}' must be a ${type === 'N' ? 'number' : 'string'} (received ${received})`,
	emptyKeyField: (field: string) => `key field '${field}' cannot be an empty string`,
	emptyIndexField: (field: string, index: string) =>
		`indexed field '${field}' (index '${index}') cannot be an empty string`,
	reservedField: (field: string) => `value field '${field}' uses the reserved prefix '_bkv_'`,
	keyValueDisagree: (field: string) => `value field '${field}' does not equal the key`,
	valueMustBeObject: 'a store with a declared key takes an object value',
	limitInvalid: (received: string) => `limit must be a positive integer (received ${received})`,
	cursorInvalid: 'cursor is not a cursor of this store',
	cursorIndexMismatch: (expected: string | undefined, got: string | undefined) =>
		`cursor belongs to ${got ? `index '${got}'` : 'the table key'}, but the call reads ${expected ? `index '${expected}'` : 'the table key'}`,
	cursorKeyMismatch: (expected: string[]) => `cursor must hold exactly the key attributes ${expected.join(', ')}`,
	cursorPartitionMismatch: (field: string) => `cursor belongs to another '${field}' partition than the where clause`,
	itemTooLarge: (bytes: number) => `Item size has exceeded the maximum allowed size of 400 KB (got ${bytes} bytes)`,
	batchIncomplete: (operation: string, remaining: number, attempts: number) =>
		`${operation} did not complete: ${remaining} entr${remaining === 1 ? 'y' : 'ies'} still unprocessed ` +
		`after ${attempts} attempts (DynamoDB throttling or response-size limits). Retry with backoff.`,
} as const;

/**
 * @internal Normalize a sort-key condition before it drives a query. Shared by
 * the mock and AWS runtime so both treat the same inputs identically:
 *
 * - **Zero defined fields** (`undefined`, or a present-but-empty `{}` /
 *   `{ createdAt: undefined }`) → returns `undefined`, i.e. "no sort-key filter,
 *   query the whole partition". A present-but-empty object would otherwise
 *   diverge: the mock's per-item matcher accepts everything (returns the whole
 *   partition) while the AWS runtime registers `#sk` in `ExpressionAttributeNames`
 *   with no clause that uses it, which DynamoDB rejects with `ValidationException`.
 * - **Exactly one defined field** → returns the condition unchanged.
 * - **More than one defined field** → throws `InvalidQuery`, because DynamoDB allows
 *   only one sort-key condition per `KeyConditionExpression` (use `between` for ranges).
 *
 * @throws {KVStoreErrors.InvalidQuery} If more than one sort-key field is defined.
 */
export function normalizeSortKeyCondition<C extends Record<string, unknown>>(condition: C | undefined): C | undefined {
	if (!condition) return undefined;
	const definedKeys = Object.keys(condition).filter((k) => condition[k] !== undefined);
	if (definedKeys.length === 0) return undefined;
	if (definedKeys.length > 1) {
		throw blocksError(KVStoreErrors.InvalidQuery, KVStoreMessages.multipleSortKeyConditions(definedKeys));
	}
	return condition;
}

/**
 * @internal Re-map DynamoDB's generic `ValidationException` to the intent-revealing
 * `ItemTooLarge` name when (and only when) it was raised for an oversized item.
 *
 * DynamoDB raises a single `ValidationException` for many unrelated conditions, so
 * we narrow on the size-specific message ("size has exceeded") before re-mapping —
 * other `ValidationException` causes (malformed expressions, type mismatches) are
 * left untouched and propagate as-is. This mirrors the mock's client-side size
 * check so both layers are catchable with `isBlocksError(e, ItemTooLarge)`. The
 * re-mapped error carries a STABLE BB-authored message (not DynamoDB's raw text):
 * the branded name AND message now cross the wire (D-003), so the message must not
 * embed raw driver text. The original DynamoDB error is preserved as `cause` (kept
 * server-side per D-003) so its stack and requestId remain available for debugging.
 */
export function remapItemTooLarge(err: unknown): unknown {
	if (err instanceof Error && err.name === 'ValidationException' && /size has exceeded/i.test(err.message)) {
		const remapped = new Error(
			`${KVStoreErrors.ItemTooLarge}: Item size has exceeded the maximum allowed size of 400 KB`,
			{ cause: err },
		);
		remapped.name = KVStoreErrors.ItemTooLarge;
		return brandBlocksError(remapped);
	}
	return err;
}

/**
 * @internal Right-biased deep merge for the `'coerce'` read path: overlay the
 * schema-coerced item onto the raw stored item so schema output (filled defaults,
 * narrowed types) wins, while keys the schema stripped (e.g. attributes from an
 * older schema version or another writer) are preserved rather than silently
 * dropped on a read-modify-write.
 *
 * Arrays are treated as **opaque leaves** — the coerced array replaces the raw
 * array wholesale. defu concatenates arrays by default, which is wrong here: the
 * coerced array is derived from the same raw array, so concatenation would
 * duplicate every element. This customizer overrides that one behavior; plain
 * objects still deep-merge (so nested unknown keys survive), and defu's built-in
 * `__proto__`/`constructor` guard is retained.
 */
const mergeCoercedOverRaw = createDefu((obj, key, value) => {
	if (Array.isArray(obj[key]) || Array.isArray(value)) {
		obj[key] = obj[key] ?? value;
		return true;
	}
	return false;
});

/** True for a plain `{}` object (not null, array, Date, or class instance). */
export function isPlainObject(v: unknown): v is Record<string, unknown> {
	if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
	const proto = Object.getPrototypeOf(v);
	return proto === Object.prototype || proto === null;
}

/**
 * @internal Validate a value against the schema before a write. Throws
 * `ValidationFailed` with the first issue's message. Shared by both runtimes.
 */
export async function validateSchema<In, Out>(
	schema: StandardSchemaV1<In, Out> | undefined,
	value: unknown,
): Promise<void> {
	if (!schema) return;
	const result = schema['~standard'].validate(value);
	const resolved = result instanceof Promise ? await result : result;
	if (resolved.issues) {
		throw blocksError(
			KVStoreErrors.ValidationFailed,
			resolved.issues[0]?.message ?? 'value failed schema validation',
		);
	}
}

/**
 * @internal Reconcile a stored item with the schema on read, per the
 * `readValidation` mode. Shared by the mock and AWS runtime so all three modes
 * behave identically in both. `null` (a missing item) always passes through
 * untouched, preserving not-found semantics.
 *
 * - `'off'` — return the raw item, no validation.
 * - `'coerce'` — apply the schema (fill defaults / narrow types for
 *   transform-bearing schemas) **without dropping data**: the coerced output is
 *   deep-merged over the raw item, so schema output wins per key while attributes
 *   the schema doesn't declare (from an older schema version or another writer)
 *   are preserved. Without this merge, returning the bare validator output would
 *   strip unknown keys (Zod `.strip()` default), and a read-modify-write would
 *   then persist the stripped item — silently deleting stored data. On validation
 *   failure, return the **raw** item and `warn` — never throws — so drifted/legacy
 *   rows stay readable and the "reads return data or `null`" contract holds.
 * - `'strict'` — throw `ValidationFailed` on any item that doesn't satisfy the
 *   schema.
 *
 * Schemas may validate synchronously or asynchronously; this awaits either.
 */
export async function applyReadValidation<In, Out>(
	mode: ReadValidationMode,
	schema: StandardSchemaV1<In, Out> | undefined,
	item: unknown,
	log: Pick<ChildLogger, 'warn'>,
	context?: Record<string, unknown>,
): Promise<Out | null> {
	if (item == null) return null;
	if (!schema || mode === 'off') return item as Out;
	const result = schema['~standard'].validate(item);
	const resolved = result instanceof Promise ? await result : result;
	if (resolved.issues) {
		if (mode === 'strict') {
			throw blocksError(
				KVStoreErrors.ValidationFailed,
				resolved.issues[0]?.message ?? 'stored item failed schema validation on read',
			);
		}
		log.warn(
			`readValidation: stored item failed schema validation, returning the raw value. ${resolved.issues[0]?.message ?? ''}`.trim(),
			context,
		);
		return item as Out;
	}
	// Merge coerced output over the raw item: schema wins per key, but keys the
	// schema stripped are preserved (see mergeCoercedOverRaw). Only merge when both
	// sides are plain objects — a schema whose output is a primitive/array is
	// returned as-is.
	if (isPlainObject(item) && isPlainObject(resolved.value)) {
		return mergeCoercedOverRaw(resolved.value as Record<string, unknown>, item) as Out;
	}
	return resolved.value as Out;
}
