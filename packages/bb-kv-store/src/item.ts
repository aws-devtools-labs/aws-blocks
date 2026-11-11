// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The item layout and the key model, shared by the mock and the AWS runtime so
 * the two cannot drift on what a stored item looks like, on what a key may be,
 * on how conditions compose, or on what a cursor holds.
 *
 * Layout (see DESIGN.md):
 * - A store with no `key` option keys its table by the string attribute `_bkv_pk`.
 *   A store with `key` uses the named fields of the value as its key attributes.
 * - An object value is stored as one attribute for each top-level field; any
 *   other value goes in `_bkv_value`.
 * - An expiry goes in `_bkv_ttl`, unless the `ttl` option names a field of the value.
 */
import { blocksError, isPlainObject, KVStoreErrors, KVStoreMessages, normalizeSortKeyCondition } from './errors.js';
import { isExpired, PK_ATTRIBUTE, RESERVED_PREFIX, TTL_ATTRIBUTE, VALUE_ATTRIBUTE } from './ttl.js';
import type { SortCondition } from './types.js';

/** The conditions of a write, as seen by the shared helpers (every typed form of the options narrows to this). */
export interface WriteConditions {
	ifNotExists?: boolean;
	ifFieldEquals?: unknown;
	ifValueEquals?: unknown;
}

/** The conditions of a delete, as seen by the shared helpers. */
export interface DeleteConditions {
	ifExists?: boolean;
	ifFieldEquals?: unknown;
	ifValueEquals?: unknown;
}

/** A stored item: one DynamoDB attribute per top-level field, plus the block's `_bkv_` attributes. */
export type Item = Record<string, unknown>;

/** A key attribute value — DynamoDB string or number keys. */
export type KeyValue = string | number;

/** The resolved key attributes of a table or an index. */
export interface KeyAttributes {
	partitionKey: string;
	sortKey?: string;
}

/** The shape of the store, resolved once in a constructor. */
export interface KeyModel {
	/** The table key. `_bkv_pk` for a string store, the declared fields otherwise. */
	readonly table: KeyAttributes;
	/** Whether the store declares a key (an object key) or takes a string key. */
	readonly declared: boolean;
	/** Secondary indexes by name. */
	readonly indexes: Readonly<Record<string, KeyAttributes>>;
	/** The attribute that holds the expiry: a named field of the value, or `_bkv_ttl`. */
	readonly ttlAttribute: string;
	/** Whether the expiry lives in a field of the value (so a read keeps it in the value). */
	readonly ttlInValue: boolean;
	/**
	 * The DynamoDB attribute type of each table key field, `'S'` or `'N'`,
	 * probed from the schema the same way the CDK layer provisions it, so a key
	 * value of the other type is rejected before DynamoDB would. `undefined`
	 * when the schema does not tell the two apart (a pass-through validator);
	 * such a field accepts a string or a number.
	 */
	readonly keyTypes: Readonly<Record<string, 'S' | 'N' | undefined>>;
}

/** A schema's validate function, the only part of it the key model needs. */
type Validator = { '~standard': { validate: (value: unknown) => unknown } };

/** Whether `schema` accepts `probe` as the value of `field`. A schema that validates asynchronously cannot be probed. */
function accepts(schema: Validator, field: string, probe: unknown): boolean | undefined {
	const result = schema['~standard'].validate({ [field]: probe });
	if (result instanceof Promise) return undefined;
	const issues = (result as { issues?: { path?: unknown[] }[] }).issues;
	if (!issues) return true;
	return !issues.some((issue) => issue.path?.length === 1 && pathKey(issue.path[0]) === field);
}

/**
 * The attribute type of a key field, `'S'` or `'N'`, from the schema. Probes
 * `validate({ [field]: 0 })` and `validate({ [field]: 'x' })`: a schema that
 * accepts one and rejects the other names the type (the CDK layer provisions
 * the table from the same `0` probe). A schema that accepts both, such as a
 * pass-through validator, or that validates asynchronously, gives `undefined`.
 */
function keyType(schema: Validator | undefined, field: string): 'S' | 'N' | undefined {
	if (!schema) return 'S';
	const number = accepts(schema, field, 0);
	const string = accepts(schema, field, 'x');
	if (number === true && string === false) return 'N';
	if (string === true && number === false) return 'S';
	return undefined;
}

function pathKey(segment: unknown): unknown {
	return typeof segment === 'object' && segment !== null && 'key' in segment
		? (segment as { key: unknown }).key
		: segment;
}

/** Build the key model from the constructor options. */
export function resolveKeyModel(options?: {
	schema?: Validator;
	key?: { partitionKey: string; sortKey?: string };
	indexes?: Record<string, { partitionKey: string; sortKey?: string }>;
	ttl?: string;
}): KeyModel {
	const key = options?.key;
	const indexes: Record<string, KeyAttributes> = {};
	for (const [name, config] of Object.entries(options?.indexes ?? {})) {
		indexes[name] = { partitionKey: config.partitionKey, sortKey: config.sortKey };
	}
	const table: KeyAttributes = key
		? { partitionKey: key.partitionKey, sortKey: key.sortKey }
		: { partitionKey: PK_ATTRIBUTE };
	const keyTypes: Record<string, 'S' | 'N' | undefined> = {};
	for (const field of keyFields(table)) {
		keyTypes[field] = key ? keyType(options?.schema, field) : 'S';
	}
	return {
		table,
		declared: key !== undefined,
		indexes,
		ttlAttribute: options?.ttl ?? TTL_ATTRIBUTE,
		ttlInValue: options?.ttl !== undefined,
		keyTypes,
	};
}

/** The attribute names of a key, partition key first. */
export function keyFields(key: KeyAttributes): string[] {
	return key.sortKey ? [key.partitionKey, key.sortKey] : [key.partitionKey];
}

function describe(value: unknown): string {
	if (value === null) return 'null';
	if (Array.isArray(value)) return 'an array';
	return typeof value === 'object' ? 'an object' : typeof value;
}

/**
 * Check one key attribute value: a non-empty string or a finite number.
 *
 * @throws {KVStoreErrors.InvalidQuery} If the value is not a string or a number.
 * @throws {KVStoreErrors.ValidationFailed} If the value is an empty string.
 */
function checkKeyValue(field: string, value: unknown, type: 'S' | 'N' | undefined): KeyValue {
	if (type !== 'N' && typeof value === 'string') {
		if (value === '') throw blocksError(KVStoreErrors.ValidationFailed, KVStoreMessages.emptyKeyField(field));
		return value;
	}
	if (type !== 'S' && typeof value === 'number' && Number.isFinite(value)) return value;
	throw blocksError(KVStoreErrors.InvalidQuery, KVStoreMessages.keyFieldType(field, type, describe(value)));
}

/**
 * Turn the key a caller passed into the key attributes of the table, checking
 * its shape. A string store takes a string; a store with a declared key takes
 * an object with exactly the key fields. The compiler enforces this for
 * TypeScript callers; the check is for JavaScript callers and casts.
 *
 * @throws {KVStoreErrors.InvalidQuery} If the key has the wrong shape.
 * @throws {KVStoreErrors.ValidationFailed} If a key field is an empty string.
 */
export function normalizeKey(model: KeyModel, key: unknown): Record<string, KeyValue> {
	const fields = keyFields(model.table);
	if (!model.declared) {
		if (typeof key !== 'string') {
			throw blocksError(KVStoreErrors.InvalidQuery, KVStoreMessages.keyMustBeString(describe(key)));
		}
		return { [PK_ATTRIBUTE]: checkKeyValue(PK_ATTRIBUTE, key, 'S') };
	}
	if (!isPlainObject(key)) {
		throw blocksError(KVStoreErrors.InvalidQuery, KVStoreMessages.keyMustBeObject(fields));
	}
	const given = Object.keys(key).filter((k) => key[k] !== undefined);
	if (given.length !== fields.length || !fields.every((f) => given.includes(f))) {
		throw blocksError(KVStoreErrors.InvalidQuery, KVStoreMessages.keyMustBeObject(fields));
	}
	const result: Record<string, KeyValue> = {};
	for (const field of fields) result[field] = checkKeyValue(field, key[field], model.keyTypes[field]);
	return result;
}

/** Serialize the key attributes of an item as a stable string (the mock's map key, the batch join key). */
export function serializeKey(model: KeyModel, keyAttrs: Record<string, unknown>): string {
	return JSON.stringify(keyFields(model.table).map((f) => keyAttrs[f]));
}

/** Pick the table key attributes out of a stored item. */
export function keyOfItem(model: KeyModel, item: Item): Record<string, KeyValue> {
	const result: Record<string, KeyValue> = {};
	for (const field of keyFields(model.table)) result[field] = item[field] as KeyValue;
	return result;
}

/** Turn the key attributes of an item back into the key a caller sees: a string, or the key object. */
export function publicKey(model: KeyModel, item: Item): unknown {
	if (!model.declared) return item[PK_ATTRIBUTE];
	return keyOfItem(model, item);
}

/**
 * Merge the key into the value and check that the two agree. Returns the full
 * value as the schema sees it (key fields included) — the thing to validate.
 *
 * @throws {KVStoreErrors.ValidationFailed} If a key field of the value differs from the key, or if a
 *   store with a declared key is given a value that is not an object.
 */
export function mergeKeyIntoValue(model: KeyModel, keyAttrs: Record<string, KeyValue>, value: unknown): unknown {
	if (!model.declared) return value;
	if (!isPlainObject(value)) throw blocksError(KVStoreErrors.ValidationFailed, KVStoreMessages.valueMustBeObject);
	for (const field of keyFields(model.table)) {
		if (field in value && value[field] !== undefined && value[field] !== keyAttrs[field]) {
			throw blocksError(KVStoreErrors.ValidationFailed, KVStoreMessages.keyValueDisagree(field));
		}
	}
	return { ...value, ...keyAttrs };
}

/**
 * Build the stored item for a write: the key attributes, the value laid out
 * flat (an object) or in `_bkv_value` (anything else), and the expiry.
 *
 * `value` is the merged value from {@link mergeKeyIntoValue} for a declared-key
 * store, or the raw value for a string store.
 *
 * @throws {KVStoreErrors.ValidationFailed} If an object value has a top-level field that starts with
 *   `_bkv_`, or an empty string in an indexed field.
 */
export function buildItem(
	model: KeyModel,
	keyAttrs: Record<string, KeyValue>,
	value: unknown,
	expiresAt: number | undefined,
): Item {
	let item: Item;
	if (isPlainObject(value)) {
		for (const field of Object.keys(value)) {
			if (field.startsWith(RESERVED_PREFIX)) {
				throw blocksError(KVStoreErrors.ValidationFailed, KVStoreMessages.reservedField(field));
			}
		}
		item = { ...value, ...keyAttrs };
		for (const [name, index] of Object.entries(model.indexes)) {
			for (const field of keyFields(index)) {
				if (item[field] === '') {
					throw blocksError(KVStoreErrors.ValidationFailed, KVStoreMessages.emptyIndexField(field, name));
				}
			}
		}
	} else {
		item = { ...keyAttrs, [VALUE_ATTRIBUTE]: value };
	}
	// Drop undefined fields: JSON has no undefined, the DocumentClient rejects it,
	// and the mock would otherwise diverge from what DynamoDB stores.
	for (const field of Object.keys(item)) if (item[field] === undefined) delete item[field];
	if (expiresAt !== undefined) item[model.ttlAttribute] = expiresAt;
	return item;
}

/** What a read yields: the key, the value, and the expiry when the item has one. */
export interface ReadEntry {
	key: unknown;
	value: unknown;
	expiresAt?: number;
}

/**
 * Turn a stored item back into `{ key, value, expiresAt }`. The block's own
 * attributes (`_bkv_pk`, `_bkv_ttl`) leave the value; the declared key fields
 * and a `ttl` field stay in it, because they are fields of the value.
 */
export function readItem(model: KeyModel, item: Item): ReadEntry {
	const key = publicKey(model, item);
	const ttl = item[model.ttlAttribute];
	const expiresAt = typeof ttl === 'number' && Number.isFinite(ttl) ? ttl : undefined;
	if (VALUE_ATTRIBUTE in item) {
		return expiresAt === undefined
			? { key, value: item[VALUE_ATTRIBUTE] }
			: { key, value: item[VALUE_ATTRIBUTE], expiresAt };
	}
	// Build the value with data properties only (`Object.fromEntries` defines, it
	// never assigns), so a stored attribute whose name is special on a plain
	// object, such as `__proto__`, stays an ordinary own field of the value.
	const value: Item = Object.fromEntries(
		Object.entries(item).filter(([field]) => !field.startsWith(RESERVED_PREFIX)),
	);
	return expiresAt === undefined ? { key, value } : { key, value, expiresAt };
}

/** Whether the item's expiry has passed. */
export function itemExpired(model: KeyModel, item: Item, nowSeconds?: number): boolean {
	return isExpired(item[model.ttlAttribute], nowSeconds);
}

// ── Conditions ──────────────────────────────────────────────────────────────

/** A value check, normalized: the fields to compare, or the whole non-object value. */
export type ValueCheckPlan =
	| { kind: 'fields'; entries: [string, unknown][] }
	| { kind: 'value'; expected: unknown }
	| undefined;

/**
 * Normalize the value check of a condition. Shared by both runtimes so the same
 * input is accepted or rejected identically.
 *
 * - `ifFieldEquals` must be an object with at least one defined field (an
 *   undefined field is dropped, matching how the AWS SDK drops it).
 * - `ifValueEquals` must not be a plain object: the block spreads an object
 *   value over attributes, so DynamoDB cannot compare it in one expression.
 * - Both together are rejected.
 *
 * @throws {KVStoreErrors.InvalidQuery} For each rule above.
 */
export function planValueCheck(
	options: { ifFieldEquals?: unknown; ifValueEquals?: unknown } | undefined,
): ValueCheckPlan {
	const fields = options?.ifFieldEquals;
	const value = options?.ifValueEquals;
	if (fields !== undefined && value !== undefined) {
		throw blocksError(KVStoreErrors.InvalidQuery, KVStoreMessages.bothValueChecks);
	}
	if (fields !== undefined) {
		if (!isPlainObject(fields))
			throw blocksError(KVStoreErrors.InvalidQuery, KVStoreMessages.ifFieldEqualsNotObject);
		const entries = Object.entries(fields).filter(([, v]) => v !== undefined);
		if (entries.length === 0) throw blocksError(KVStoreErrors.InvalidQuery, KVStoreMessages.emptyIfFieldEquals);
		return { kind: 'fields', entries };
	}
	if (value !== undefined) {
		if (isPlainObject(value)) throw blocksError(KVStoreErrors.InvalidQuery, KVStoreMessages.ifValueEqualsObject);
		return { kind: 'value', expected: value };
	}
	return undefined;
}

/** A DynamoDB condition expression with its names and values. */
export interface ConditionExpression {
	ConditionExpression: string;
	ExpressionAttributeNames: Record<string, string>;
	ExpressionAttributeValues?: Record<string, unknown>;
}

function valueCheckExpression(
	check: Exclude<ValueCheckPlan, undefined>,
	names: Record<string, string>,
	values: Record<string, unknown>,
): string {
	if (check.kind === 'value') {
		names['#value'] = VALUE_ATTRIBUTE;
		values[':expected'] = check.expected;
		return '#value = :expected';
	}
	const parts = check.entries.map(([field, value], i) => {
		names[`#field${i}`] = field;
		values[`:val${i}`] = value;
		return `#field${i} = :val${i}`;
	});
	return parts.length === 1 ? parts[0] : `(${parts.join(' AND ')})`;
}

/**
 * The DynamoDB condition for a `put`. `ifNotExists` and a value check compose
 * with OR: `attribute_not_exists(#pk) OR <value check>` — the write succeeds when
 * the key is absent OR its current value matches, the optimistic "create it, or
 * update it only if unchanged" pattern. (AND would be unsatisfiable: a key can't
 * be both absent and have a matching value.)
 *
 * Returns the expression and whether a failure is retriable: `true` whenever a
 * value check took part (under OR composition the combined failure means the
 * key exists but its value differs, so a re-read and retry can succeed), `false`
 * for a pure `ifNotExists` existence assertion (a blind retry fails identically).
 */
export function putCondition(
	model: KeyModel,
	options: WriteConditions | undefined,
): { expression: ConditionExpression | undefined; retriable: boolean; check: ValueCheckPlan; wantAbsent: boolean } {
	const check = planValueCheck(options);
	const wantAbsent = options?.ifNotExists === true;
	const arms: string[] = [];
	const names: Record<string, string> = {};
	const values: Record<string, unknown> = {};
	if (wantAbsent) {
		arms.push('attribute_not_exists(#pk)');
		names['#pk'] = model.table.partitionKey;
	}
	if (check) arms.push(valueCheckExpression(check, names, values));
	const expression: ConditionExpression | undefined =
		arms.length === 0
			? undefined
			: {
					ConditionExpression: arms.join(' OR '),
					ExpressionAttributeNames: names,
					...(Object.keys(values).length > 0 ? { ExpressionAttributeValues: values } : {}),
				};
	return { expression, retriable: check !== undefined, check, wantAbsent };
}

/**
 * The DynamoDB condition for a `delete`. `ifExists` and a value check compose
 * with AND — both must hold. Retriable only for a value check without
 * `ifExists`: the existence assertion wins, so a combined conflict is not
 * retriable.
 */
export function deleteCondition(
	model: KeyModel,
	options: DeleteConditions | undefined,
): { expression: ConditionExpression | undefined; retriable: boolean; check: ValueCheckPlan; wantPresent: boolean } {
	const check = planValueCheck(options);
	const wantPresent = options?.ifExists === true;
	const arms: string[] = [];
	const names: Record<string, string> = {};
	const values: Record<string, unknown> = {};
	if (wantPresent) {
		arms.push('attribute_exists(#pk)');
		names['#pk'] = model.table.partitionKey;
	}
	if (check) arms.push(valueCheckExpression(check, names, values));
	const expression: ConditionExpression | undefined =
		arms.length === 0
			? undefined
			: {
					ConditionExpression: arms.join(' AND '),
					ExpressionAttributeNames: names,
					...(Object.keys(values).length > 0 ? { ExpressionAttributeValues: values } : {}),
				};
	return { expression, retriable: check !== undefined && !wantPresent, check, wantPresent };
}

/**
 * Order-independent structural equality, used by the mock to compare a value
 * check against stored attributes. DynamoDB Maps are an unordered collection of
 * name-value pairs, so `{ a, b }` and `{ b, a }` are the same value — a plain
 * `JSON.stringify` compare would wrongly treat them as different and fail the
 * condition. Arrays remain order-sensitive (DynamoDB Lists are ordered).
 */
export function deepEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (typeof a !== typeof b) return false;
	if (a === null || b === null) return a === b;

	if (Array.isArray(a) || Array.isArray(b)) {
		if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
		return a.every((v, i) => deepEqual(v, b[i]));
	}

	if (typeof a === 'object' && typeof b === 'object') {
		const aKeys = Object.keys(a as object);
		const bKeys = Object.keys(b as object);
		if (aKeys.length !== bKeys.length) return false;
		return aKeys.every(
			(k) =>
				Object.hasOwn(b, k) && deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
		);
	}

	return false;
}

/** Whether a stored item satisfies a value check (the mock's counterpart to the DynamoDB expression). */
export function valueCheckHolds(check: Exclude<ValueCheckPlan, undefined>, existing: Item | undefined): boolean {
	if (!existing) return false;
	if (check.kind === 'value')
		return VALUE_ATTRIBUTE in existing && deepEqual(existing[VALUE_ATTRIBUTE], check.expected);
	return check.entries.every(([field, value]) => deepEqual(existing[field], value));
}

// ── Query ───────────────────────────────────────────────────────────────────

/** A query, resolved and checked: which key to read, the partition value, and the sort condition. */
export interface QueryPlan {
	indexName: string | undefined;
	key: KeyAttributes;
	pkValue: KeyValue;
	skCondition: SortCondition<KeyValue> | undefined;
	limit: number | undefined;
	order: 'asc' | 'desc';
}

/**
 * Resolve a `query` call against the key model, checking it the same way in
 * both runtimes.
 *
 * @throws {KVStoreErrors.InvalidQuery} If `index` is unknown, if the store has no declared key and no
 *   `index` is given, if `where` is missing or lacks `{ equals }` on the partition field, or if more
 *   than one sort-key condition is given.
 */
export function planQuery(
	model: KeyModel,
	options: { index?: string; where?: Record<string, unknown>; limit?: number; order?: 'asc' | 'desc' },
): QueryPlan {
	let key: KeyAttributes | undefined;
	if (options.index !== undefined) {
		key = model.indexes[options.index];
		if (!key) throw blocksError(KVStoreErrors.InvalidQuery, KVStoreMessages.indexNotFound(options.index));
	} else {
		if (!model.declared) throw blocksError(KVStoreErrors.InvalidQuery, KVStoreMessages.queryNeedsKeyOrIndex);
		key = model.table;
	}
	if (!options.where || !isPlainObject(options.where)) {
		throw blocksError(KVStoreErrors.InvalidQuery, KVStoreMessages.whereRequired(key.partitionKey));
	}
	const pkCondition = options.where[key.partitionKey];
	const pkValue = isPlainObject(pkCondition) ? pkCondition.equals : undefined;
	if (pkValue === undefined || (typeof pkValue !== 'string' && typeof pkValue !== 'number')) {
		throw blocksError(KVStoreErrors.InvalidQuery, KVStoreMessages.partitionKeyEqualsRequired(key.partitionKey));
	}
	// Normalize the sort-key condition up front — before any data is read — so
	// a present-but-empty condition becomes "no filter" and multiple conditions
	// are rejected eagerly, even on an empty table.
	const skCondition = key.sortKey
		? normalizeSortKeyCondition(options.where[key.sortKey] as Record<string, unknown> | undefined)
		: undefined;
	return {
		indexName: options.index,
		key,
		pkValue,
		skCondition: skCondition as SortCondition<KeyValue> | undefined,
		limit: options.limit,
		order: options.order === 'desc' ? 'desc' : 'asc',
	};
}

/** The mock's per-item sort-key matcher. */
export function matchesSortKeyCondition(value: unknown, condition: SortCondition<KeyValue>): boolean {
	const c = condition as Record<string, unknown>;
	const v = value as KeyValue;
	if ('equals' in c && c.equals !== undefined && v !== c.equals) return false;
	if ('greaterThan' in c && c.greaterThan !== undefined && !(v > (c.greaterThan as KeyValue))) return false;
	if ('greaterThanOrEqual' in c && c.greaterThanOrEqual !== undefined && !(v >= (c.greaterThanOrEqual as KeyValue)))
		return false;
	if ('lessThan' in c && c.lessThan !== undefined && !(v < (c.lessThan as KeyValue))) return false;
	if ('lessThanOrEqual' in c && c.lessThanOrEqual !== undefined && !(v <= (c.lessThanOrEqual as KeyValue)))
		return false;
	if ('between' in c && Array.isArray(c.between)) {
		const [lo, hi] = c.between as [KeyValue, KeyValue];
		if (!(v >= lo && v <= hi)) return false;
	}
	if ('beginsWith' in c && c.beginsWith !== undefined) {
		if (typeof v !== 'string' || !v.startsWith(c.beginsWith as string)) return false;
	}
	return true;
}

/** Compare two key values the way DynamoDB orders a sort key of that type. */
export function compareKeyValues(a: unknown, b: unknown): number {
	const av = a as KeyValue;
	const bv = b as KeyValue;
	return av < bv ? -1 : av > bv ? 1 : 0;
}

// ── Cursors ─────────────────────────────────────────────────────────────────

/**
 * A cursor marks the position after the last entry an iterator returned. It
 * encodes the DynamoDB `LastEvaluatedKey` of that position — the key attributes
 * of the table, plus those of the index for an index query — in a readable
 * (base64url JSON) form. It is not a secret and not a permission.
 */
interface CursorPayload {
	v: 1;
	index: string | null;
	key: Record<string, KeyValue>;
}

/** The attributes a `LastEvaluatedKey` holds for a read of the table or of an index. */
export function cursorFields(model: KeyModel, indexName: string | undefined): string[] {
	const fields = keyFields(model.table);
	if (indexName === undefined) return fields;
	const index = model.indexes[indexName];
	for (const f of keyFields(index)) if (!fields.includes(f)) fields.push(f);
	return fields;
}

/** Encode the position after `item` as a cursor string. */
export function encodeCursor(model: KeyModel, indexName: string | undefined, item: Item): string {
	const key: Record<string, KeyValue> = {};
	for (const field of cursorFields(model, indexName)) key[field] = item[field] as KeyValue;
	const payload: CursorPayload = { v: 1, index: indexName ?? null, key };
	return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/**
 * Decode and check a cursor before it drives a read. The cursor must decode,
 * must name the same index as the call, must hold exactly the key attributes
 * of that table or index (each a non-empty string or a finite number), and —
 * for a query — its partition value must match `where`.
 *
 * @throws {KVStoreErrors.InvalidQuery} If any check fails.
 */
export function decodeCursor(
	model: KeyModel,
	cursor: string,
	indexName: string | undefined,
	partition?: { field: string; value: KeyValue },
): Record<string, KeyValue> {
	if (typeof cursor !== 'string' || cursor === '') {
		throw blocksError(KVStoreErrors.InvalidQuery, KVStoreMessages.cursorInvalid);
	}
	let payload: unknown;
	try {
		payload = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
	} catch {
		throw blocksError(KVStoreErrors.InvalidQuery, KVStoreMessages.cursorInvalid);
	}
	if (!isPlainObject(payload) || payload.v !== 1 || !isPlainObject(payload.key)) {
		throw blocksError(KVStoreErrors.InvalidQuery, KVStoreMessages.cursorInvalid);
	}
	const cursorIndex = typeof payload.index === 'string' ? payload.index : undefined;
	if (cursorIndex !== indexName) {
		throw blocksError(KVStoreErrors.InvalidQuery, KVStoreMessages.cursorIndexMismatch(indexName, cursorIndex));
	}
	const expected = cursorFields(model, indexName);
	const given = Object.keys(payload.key);
	if (given.length !== expected.length || !expected.every((f) => given.includes(f))) {
		throw blocksError(KVStoreErrors.InvalidQuery, KVStoreMessages.cursorKeyMismatch(expected));
	}
	const key: Record<string, KeyValue> = {};
	for (const field of expected) {
		const value = payload.key[field];
		if (!(typeof value === 'string' && value !== '') && !(typeof value === 'number' && Number.isFinite(value))) {
			throw blocksError(KVStoreErrors.InvalidQuery, KVStoreMessages.cursorKeyMismatch(expected));
		}
		key[field] = value;
	}
	if (partition && key[partition.field] !== partition.value) {
		throw blocksError(KVStoreErrors.InvalidQuery, KVStoreMessages.cursorPartitionMismatch(partition.field));
	}
	return key;
}

// ── Results ─────────────────────────────────────────────────────────────────

/** What a paged source yields: the entry, and the cursor for the position after it. */
export interface Positioned<E> {
	entry: E;
	position: string;
}

/**
 * The object `query` and `scan` return. Iterates the source once, and exposes
 * `cursor`: the position after the last entry yielded when the read stopped
 * before the end (a `limit`, or a consumer that stopped early), `undefined`
 * when the read reached the end, and `undefined` before iteration starts.
 *
 * The source generator returns `true` when more entries may follow the last one
 * it yielded (so the cursor is the last position) and `false` when it reached
 * the end.
 */
export class PagedResults<E> implements AsyncIterable<E> {
	private lastPosition: string | undefined;
	private finished = false;
	private more = false;

	constructor(private readonly source: () => AsyncGenerator<Positioned<E>, boolean>) {}

	get cursor(): string | undefined {
		if (!this.finished || !this.more) return undefined;
		return this.lastPosition;
	}

	async *[Symbol.asyncIterator](): AsyncIterator<E> {
		this.finished = false;
		this.more = false;
		this.lastPosition = undefined;
		const gen = this.source();
		let completed = false;
		try {
			for (;;) {
				const next = await gen.next();
				if (next.done) {
					this.more = next.value;
					completed = true;
					return;
				}
				this.lastPosition = next.value.position;
				yield next.value.entry;
			}
		} finally {
			if (!completed) {
				// The consumer stopped early: the position after the last entry it
				// saw is the cursor, and the source may still hold more.
				this.more = this.lastPosition !== undefined;
				await gen.return(false);
			}
			this.finished = true;
		}
	}
}
