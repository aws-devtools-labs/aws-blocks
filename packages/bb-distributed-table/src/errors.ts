// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { createDefu } from 'defu';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { ChildLogger } from '@aws-blocks/bb-logger';
import type { ReadValidationMode } from './types.js';

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

/**
 * Typed error constants for DistributedTable. Use with `isBlocksError()` in catch blocks.
 *
 * @example
 * ```typescript
 * import { isBlocksError } from '@aws-blocks/core';
 * import { DistributedTableErrors } from '@aws-blocks/bb-distributed-table';
 *
 * try {
 *   await table.put(item, { ifNotExists: true });
 * } catch (e: unknown) {
 *   if (isBlocksError(e, DistributedTableErrors.ConditionalCheckFailed)) {
 *     // item already exists
 *   }
 *   throw e;
 * }
 * ```
 */
export const DistributedTableErrors = {
	ConditionalCheckFailed: 'ConditionalCheckFailedException',
	ValidationFailed: 'ValidationFailedException',
	/**
	 * The request or condition shape is invalid and was rejected before reaching
	 * DynamoDB: a missing `where` clause, a partition key not given as
	 * `{ equals: value }`, an unknown index, more than one sort-key condition, an
	 * empty `ifFieldEquals`, or a non-positive/non-integer `limit`. These are all
	 * caller bugs — something the caller
	 * can fix by correcting the call. Catchable via
	 * `isBlocksError(e, DistributedTableErrors.InvalidQuery)`.
	 *
	 * Kept distinct from {@link ItemTooLarge} (a runtime data condition) so a
	 * customer can tell "my query is wrong" from "this item is too big" by name
	 * alone rather than string-matching the message.
	 */
	InvalidQuery: 'InvalidQueryException',
	/**
	 * An item exceeds DynamoDB's 400 KB per-item size limit. Unlike an invalid
	 * query, this is not necessarily a caller bug — the size of a given item may
	 * be outside the caller's control — so callers may want to branch on it
	 * (skip, split, or store a reference instead). Catchable via
	 * `isBlocksError(e, DistributedTableErrors.ItemTooLarge)`.
	 *
	 * The mock checks serialized byte length client-side and throws this directly.
	 * On AWS, DynamoDB raises a generic `ValidationException` for oversized items;
	 * the runtime detects the size-specific message and re-maps it to this name so
	 * both layers are catchable with the same code. Other `ValidationException`
	 * causes (malformed expressions, type mismatches) propagate as-is.
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
 * @internal Build an Error whose `name` carries the typed error code (so callers
 * can match it with `isBlocksError`). Shared by the mock and AWS runtime so both
 * produce identically shaped errors.
 */
export function blocksError(name: string, message: string): Error {
	const err = new Error(`${name}: ${message}`);
	err.name = name;
	return err;
}

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
 * @throws {DistributedTableErrors.InvalidQuery} If more than one sort-key field is defined.
 */
export function normalizeSortKeyCondition<C extends Record<string, unknown>>(
	condition: C | undefined,
): C | undefined {
	if (!condition) return undefined;
	const definedKeys = Object.keys(condition).filter(k => condition[k] !== undefined);
	if (definedKeys.length === 0) return undefined;
	if (definedKeys.length > 1) {
		throw blocksError(DistributedTableErrors.InvalidQuery, DistributedTableMessages.multipleSortKeyConditions(definedKeys));
	}
	return condition;
}

/**
 * @internal Validation messages shared by the mock and AWS runtime. Centralised
 * here so the two implementations stay byte-for-byte in lockstep — parity tests
 * assert the same wording against both.
 */
export const DistributedTableMessages = {
	indexNotFound: (index: string | undefined) => `Index '${index}' not found`,
	whereRequired: (pkField: string) =>
		`query() requires a 'where' clause with partition key field '${pkField}'`,
	partitionKeyEqualsRequired: (pkField: string) =>
		`query() requires '${pkField}: { equals: value }' in the where clause (partition key must be an exact match)`,
	multipleSortKeyConditions: (conditionKeys: string[]) =>
		`Only one sort key condition is allowed per query (DynamoDB limitation). ` +
		`Got: ${conditionKeys.join(', ')}. Use "between" for range queries.`,
	invalidLimit: (limit: unknown) =>
		`limit must be a positive integer (>= 1); received ${String(limit)}`,
	emptyIfFieldEquals: 'ifFieldEquals must contain at least one field with a non-undefined value',
	itemTooLarge: (bytes: number) =>
		`Item size has exceeded the maximum allowed size of 400 KB (got ${bytes} bytes)`,
	batchIncomplete: (operation: string, remaining: number, attempts: number) =>
		`${operation} did not complete: ${remaining} entr${remaining === 1 ? 'y' : 'ies'} still unprocessed ` +
		`after ${attempts} attempts (DynamoDB throttling or response-size limits). Retry with backoff.`,
} as const;

/**
 * Validate a DynamoDB request limit before either runtime starts yielding
 * items. A truthiness guard in the local mock would otherwise treat zero or
 * NaN as an unlimited query, while DynamoDB rejects them.
 */
export function validateLimit(limit: number | undefined): number | undefined {
	if (limit === undefined) return undefined;
	if (!Number.isInteger(limit) || limit < 1) {
		throw blocksError(DistributedTableErrors.InvalidQuery, DistributedTableMessages.invalidLimit(limit));
	}
	return limit;
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
 * original DynamoDB error is preserved as `cause` (kept server-side per D-003) so
 * its stack and requestId remain available for debugging.
 */
export function remapItemTooLarge(err: unknown): unknown {
	if (err instanceof Error && err.name === 'ValidationException' && /size has exceeded/i.test(err.message)) {
		const remapped = new Error(err.message, { cause: err });
		remapped.name = DistributedTableErrors.ItemTooLarge;
		return remapped;
	}
	return err;
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
export async function applyReadValidation<T>(
	mode: ReadValidationMode,
	schema: StandardSchemaV1<T>,
	item: T | null,
	log: Pick<ChildLogger, 'warn'>,
	context?: Record<string, unknown>,
): Promise<T | null> {
	if (item == null || mode === 'off') return item;
	const result = schema['~standard'].validate(item);
	const resolved = result instanceof Promise ? await result : result;
	if (resolved.issues) {
		if (mode === 'strict') {
			throw blocksError(DistributedTableErrors.ValidationFailed, resolved.issues[0]?.message ?? 'stored item failed schema validation on read');
		}
		log.warn(
			`readValidation: stored item failed schema validation, returning the raw value. ${resolved.issues[0]?.message ?? ''}`.trim(),
			context,
		);
		return item;
	}
	// Merge coerced output over the raw item: schema wins per key, but keys the
	// schema stripped are preserved (see mergeCoercedOverRaw). Only merge when both
	// sides are plain objects — a schema whose output is a primitive/array (rare
	// for a table item) is returned as-is.
	if (isPlainObject(item) && isPlainObject(resolved.value)) {
		return mergeCoercedOverRaw(resolved.value as Record<string, unknown>, item as Record<string, unknown>) as T;
	}
	return resolved.value as T;
}

/** True for a plain `{}` object (not null, array, Date, or class instance). */
function isPlainObject(v: unknown): v is Record<string, unknown> {
	if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
	const proto = Object.getPrototypeOf(v);
	return proto === Object.prototype || proto === null;
}
