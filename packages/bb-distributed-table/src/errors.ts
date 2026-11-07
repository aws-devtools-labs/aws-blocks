// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { createDefu } from 'defu';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { ApiError, blocksError as coreBlocksError, brandBlocksError } from '@aws-blocks/core';
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
 * import { ApiError, DistributedTableErrors, isBlocksError } from '@aws-blocks/blocks';
 *
 * try {
 *   await orders.put(order, { ifNotExists: true });
 * } catch (e: unknown) {
 *   if (isBlocksError(e, DistributedTableErrors.ConditionalCheckFailed)) {
 *     // an order with this userId + orderId already exists: report it under the API's own error name
 *     throw new ApiError('Order already exists', 409, { name: 'OrderExists', cause: e });
 *   }
 *   throw e;
 * }
 * ```
 */
export const DistributedTableErrors = {
	ConditionalCheckFailed: 'ConditionalCheckFailedException',
	ValidationFailed: 'ValidationFailedException',
	/**
	 * The call's input shape is invalid and was rejected before reaching
	 * DynamoDB: a key that is not an object with every primary-key field (e.g.
	 * `get('alice')` instead of `get({ userId: 'alice' })`, or a composite key
	 * missing its sort key), an item without its key fields on `put()` /
	 * `putBatch()`, `indexes` declared as something other than an object keyed by
	 * index name, a missing `where` clause, a partition key not given as
	 * `{ equals: value }`, an unknown index, an `order` other than `'asc'` /
	 * `'desc'`, more than one sort-key condition, or an empty `ifFieldEquals`.
	 * These are all caller bugs — something the caller can fix by correcting the
	 * call. Thrown identically by the local mock and the AWS runtime. Catchable via
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
 * The set of error names this Building Block can produce. Deriving it from the
 * `DistributedTableErrors` constant lets `blocksError` reject a stray string
 * name at compile time, so every mint site passes a known code.
 */
export type DistributedTableErrorName = (typeof DistributedTableErrors)[keyof typeof DistributedTableErrors];

/**
 * @internal Build an Error whose `name` carries the typed error code (so callers
 * can match it with `isBlocksError`). The `name` param is typed to
 * `DistributedTableErrorName`, so a stray string is caught at compile time.
 * Shared by the mock and AWS runtime so both produce identically shaped errors.
 * Delegates to core's `blocksError` so the minting (prefixing, naming, wire-safe
 * branding) lives in one place.
 */
export function blocksError(name: DistributedTableErrorName, message: string): Error {
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
 * `retriable` is scoped to the assertion kind: `true` only for optimistic-lock
 * conflicts (`ifFieldEquals`), where a re-read and retry can succeed; `false`
 * for existence/uniqueness assertions (`ifNotExists` on put, `ifExists` on
 * delete), where a blind identical retry fails identically. DynamoDB collapses
 * every conditional failure under one `ConditionalCheckFailedException` with no
 * sub-reason, so the AWS runtime decides this from the condition the caller set
 * on that specific put/delete call.
 */
export function conditionalCheckFailed(retriable: boolean, cause?: unknown): ApiError {
	return new ApiError(`${DistributedTableErrors.ConditionalCheckFailed}: The conditional request failed`, 409, {
		name: DistributedTableErrors.ConditionalCheckFailed,
		cause,
		retriable,
	});
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

/** @internal A data method that takes a key (or an item carrying its key), named in the error message. */
export type KeyedMethod = 'get' | 'delete' | 'getBatch' | 'deleteBatch' | 'put' | 'putBatch';

/** @internal The primary-key fields a key or item must carry. */
export interface KeyFields {
	readonly partitionKey: string;
	readonly sortKey?: string;
}

/** Quote and join up to two field names: `'userId' and 'createdAt'`. */
function quoteFields(fields: readonly string[]): string {
	return fields.map(f => `'${f}'`).join(' and ');
}

/**
 * Describe a value's shape for an error message without echoing its contents:
 * keys and items carry application data, and the message crosses the wire.
 */
function describeShape(value: unknown): string {
	if (value === null) return 'null';
	if (value === undefined) return 'undefined';
	if (Array.isArray(value)) return 'an array';
	return typeof value === 'object' ? 'an object' : `a ${typeof value}`;
}

/**
 * @internal Validation messages shared by the mock and AWS runtime. Centralised
 * here so the two implementations stay byte-for-byte in lockstep — parity tests
 * assert the same wording against both.
 */
export const DistributedTableMessages = {
	indexNotFound: (index: string | undefined, declared: readonly string[]) =>
		`Index '${index}' not found; declared indexes: ${declared.length > 0 ? declared.map(i => `'${i}'`).join(', ') : 'none'}`,
	invalidKey: (method: KeyedMethod, fields: readonly string[], got: string, position?: number) => {
		const at = position === undefined ? '' : ` at index ${position}`;
		const shape = `{ ${fields.map(f => `${f}: ...`).join(', ')} }`;
		switch (method) {
			case 'put':
			case 'putBatch':
				return `${method}() needs ${method === 'put' ? 'the item' : 'every item'} to include its key field${fields.length > 1 ? 's' : ''} ` +
					`${quoteFields(fields)}; got ${got}${at}`;
			case 'getBatch':
			case 'deleteBatch':
				return `${method}() takes an array of key objects with ${quoteFields(fields)}, e.g. ${method}([${shape}]); got ${got}${at}`;
			default:
				return `${method}() takes the key as an object with ${quoteFields(fields)}, e.g. ${method}(${shape}); got ${got}${at}`;
		}
	},
	indexesMustBeObject: (got: string) =>
		`indexes must be an object keyed by index name, e.g. indexes: { byStatus: { partitionKey: 'status', sortKey: 'createdAt' } }; got ${got}`,
	invalidOrder: (got: string) => `query() order must be 'asc' or 'desc'; got ${got}`,
	whereRequired: (pkField: string) =>
		`query() requires a 'where' clause with partition key field '${pkField}'`,
	partitionKeyEqualsRequired: (pkField: string) =>
		`query() requires '${pkField}: { equals: value }' in the where clause (partition key must be an exact match)`,
	multipleSortKeyConditions: (conditionKeys: string[]) =>
		`Only one sort key condition is allowed per query (DynamoDB limitation). ` +
		`Got: ${conditionKeys.join(', ')}. Use "between" for range queries.`,
	emptyIfFieldEquals: 'ifFieldEquals must contain at least one field with a non-undefined value',
	itemTooLarge: (bytes: number) =>
		`Item size has exceeded the maximum allowed size of 400 KB (got ${bytes} bytes)`,
	batchIncomplete: (operation: string, remaining: number, attempts: number) =>
		`${operation} did not complete: ${remaining} entr${remaining === 1 ? 'y' : 'ies'} still unprocessed ` +
		`after ${attempts} attempts (DynamoDB throttling or response-size limits). Retry with backoff.`,
} as const;

/**
 * @internal Reject a key (or an item, for `put`/`putBatch`) that is not an object
 * carrying every primary-key field with a value. Shared by the mock and AWS
 * runtime so both fail the same way before any lookup or DynamoDB call: without
 * it the mock serializes the missing fields and silently returns `null` (or
 * stores a keyless item), while DynamoDB rejects the request with a generic
 * `ValidationException`. Extra non-key fields are allowed (a whole item is a
 * valid key).
 *
 * @param position Index of the value within a batch call, for the message.
 * @throws {DistributedTableErrors.InvalidQuery} If the value is not an object or
 *   a key field is `undefined` or `null`.
 */
export function assertKeyShape(method: KeyedMethod, keyConfig: KeyFields, value: unknown, position?: number): void {
	const fields = keyConfig.sortKey ? [keyConfig.partitionKey, keyConfig.sortKey] : [keyConfig.partitionKey];
	let got: string | undefined;
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		got = describeShape(value);
	} else {
		const missing = fields.filter(f => {
			const v: unknown = Reflect.get(value, f);
			return v === undefined || v === null;
		});
		if (missing.length > 0) got = `an object without a value for ${quoteFields(missing)}`;
	}
	if (got !== undefined) {
		throw blocksError(DistributedTableErrors.InvalidQuery, DistributedTableMessages.invalidKey(method, fields, got, position));
	}
}

/**
 * @internal {@link assertKeyShape} for every entry of a batch call, checked
 * before any entry is processed so a bad key never leaves a batch half applied.
 *
 * @throws {DistributedTableErrors.InvalidQuery} If any entry is malformed.
 */
export function assertKeyShapes(method: KeyedMethod, keyConfig: KeyFields, values: readonly unknown[]): void {
	for (const [i, value] of values.entries()) assertKeyShape(method, keyConfig, value, i);
}

/**
 * @internal Reject an `indexes` option that is not an object keyed by index name
 * (most often an array of index configs, which would otherwise declare GSIs
 * named `'0'`, `'1'`, …). `undefined` and `null` mean "no indexes". Shared by the
 * mock, AWS runtime and CDK constructors.
 *
 * @throws {DistributedTableErrors.InvalidQuery} If `indexes` is an array or a primitive.
 */
export function assertIndexesShape(indexes: unknown): void {
	if (indexes === undefined || indexes === null) return;
	if (typeof indexes !== 'object' || Array.isArray(indexes)) {
		throw blocksError(DistributedTableErrors.InvalidQuery, DistributedTableMessages.indexesMustBeObject(describeShape(indexes)));
	}
}

/**
 * @internal Reject a query `order` other than `'asc'` / `'desc'` (e.g. `'DESC'` or
 * `'newest'`), which would otherwise silently sort ascending. `undefined` and
 * `null` keep the default ascending order. Shared by the mock and AWS runtime.
 *
 * @throws {DistributedTableErrors.InvalidQuery} If `order` is set to anything else.
 */
export function assertQueryOrder(order: unknown): void {
	if (order === undefined || order === null || order === 'asc' || order === 'desc') return;
	const got = typeof order === 'string' ? `'${order}'` : describeShape(order);
	throw blocksError(DistributedTableErrors.InvalidQuery, DistributedTableMessages.invalidOrder(got));
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
		const remapped = new Error(`${DistributedTableErrors.ItemTooLarge}: Item size has exceeded the maximum allowed size of 400 KB`, { cause: err });
		remapped.name = DistributedTableErrors.ItemTooLarge;
		return brandBlocksError(remapped);
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
