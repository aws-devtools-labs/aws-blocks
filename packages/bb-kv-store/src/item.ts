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
import type { ChildLogger } from '@aws-blocks/bb-logger';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import {
	applyReadValidation,
	blocksError,
	isPlainObject,
	KVStoreErrors,
	KVStoreMessages,
	normalizeSortKeyCondition,
	validateSchema,
} from './errors.js';
import {
	isExpired,
	nowEpochSeconds,
	PK_ATTRIBUTE,
	RESERVED_PREFIX,
	resolveTtlEpochSeconds,
	TTL_ATTRIBUTE,
	VALUE_ATTRIBUTE,
} from './ttl.js';
import type { Expiry, ReadValidationMode, TableOptions } from './types.js';

/** A stored item: one DynamoDB attribute per top-level field, plus the block's `_bkv_` attributes. */
export type Item = Record<string, unknown>;

/** A key attribute value — DynamoDB string or number keys. */
export type KeyValue = string | number;

/** The resolved key attributes of a table or an index. */
export interface KeyAttributes {
	partitionKey: string;
	sortKey?: string;
}

/**
 * The constructor options as the shared code reads them: field names and a
 * validator, not the value types the public signature infers. The one cast
 * from the typed options is in {@link looseOptions}.
 */
export interface LooseOptions extends TableOptions {
	schema?: StandardSchemaV1;
	key?: KeyAttributes;
	indexes?: Record<string, KeyAttributes>;
	ttl?: string;
	readValidation?: ReadValidationMode;
}

/** Read the typed constructor options of a store as {@link LooseOptions}. */
export function looseOptions(options: unknown): LooseOptions {
	return (options ?? {}) as LooseOptions;
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
	/** The schema of the store, if it has one. */
	readonly schema: StandardSchemaV1 | undefined;
	/**
	 * The DynamoDB attribute type of each key field, `'S'` or `'N'`, probed from
	 * the schema on first use (see {@link probeKeyType}) and then kept, so a
	 * store that is never read by key does not probe its schema.
	 */
	readonly keyTypes: Map<string, 'S' | 'N'>;
}

/** Whether `schema` accepts `probe` as the value of `field`. A schema that validates asynchronously cannot be probed. */
function schemaAccepts(schema: StandardSchemaV1, field: string, probe: unknown): boolean | undefined {
	const result = schema['~standard'].validate({ [field]: probe });
	if (result instanceof Promise) return undefined;
	if (!result.issues) return true;
	return !result.issues.some((issue) => issue.path?.length === 1 && pathKey(issue.path[0]) === field);
}

function pathKey(segment: unknown): unknown {
	return typeof segment === 'object' && segment !== null && 'key' in segment
		? (segment as { key: unknown }).key
		: segment;
}

/** The number samples that {@link probeKeyType} puts in a field. */
const NUMBER_SAMPLES = [0, 1, -1];

/**
 * The DynamoDB attribute type of a key field or an index field, `'S'` or
 * `'N'`, from the schema. This is the one rule of the block: the CDK layer
 * provisions the attribute with this type, and the runtimes accept only this
 * type for the field.
 *
 * The field is a number if the schema accepts one of the samples `0`, `1`,
 * `-1` as its value, which means `validate({ [field]: sample })` reports no
 * issue at the path of the field. In all other cases the field is a string.
 * Three samples, so a refined number such as `z.number().positive()` is a
 * number. A store with no schema has string fields. A schema that validates
 * asynchronously cannot be probed, and its field counts as a number.
 *
 * A schema that accepts every value, such as a pass-through validator, makes
 * each field a number. A schema must state the type of a key field.
 */
export function probeKeyType(schema: StandardSchemaV1 | undefined, field: string): 'S' | 'N' {
	if (!schema) return 'S';
	return NUMBER_SAMPLES.some((sample) => schemaAccepts(schema, field, sample) !== false) ? 'N' : 'S';
}

/** The type of a key field of the model: {@link probeKeyType}, probed on first use and then kept in the model. */
function keyType(model: KeyModel, field: string): 'S' | 'N' {
	let type = model.keyTypes.get(field);
	if (type === undefined) {
		type = probeKeyType(model.schema, field);
		model.keyTypes.set(field, type);
	}
	return type;
}

/** Build the key model from the constructor options. */
export function resolveKeyModel(options: unknown): KeyModel {
	const { schema, key, indexes, ttl } = looseOptions(options);
	return {
		table: key ? { partitionKey: key.partitionKey, sortKey: key.sortKey } : { partitionKey: PK_ATTRIBUTE },
		declared: key !== undefined,
		indexes: indexes ?? {},
		ttlAttribute: ttl ?? TTL_ATTRIBUTE,
		ttlInValue: ttl !== undefined,
		schema,
		keyTypes: new Map(key ? [] : [[PK_ATTRIBUTE, 'S']]),
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
 * Check one key attribute value: a non-empty string for a string field, a
 * finite number for a number field.
 *
 * @throws {KVStoreErrors.InvalidQuery} If the value does not have the type of the field.
 * @throws {KVStoreErrors.ValidationFailed} If the value is an empty string.
 */
function checkKeyValue(field: string, value: unknown, type: 'S' | 'N'): KeyValue {
	if (type === 'S' && typeof value === 'string') {
		if (value === '') throw blocksError(KVStoreErrors.ValidationFailed, KVStoreMessages.emptyKeyField(field));
		return value;
	}
	if (type === 'N' && typeof value === 'number' && Number.isFinite(value)) return value;
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
	for (const field of fields) result[field] = checkKeyValue(field, key[field], keyType(model, field));
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

/**
 * Merge the key into the value and check that the two agree. Returns the full
 * value as the schema sees it (key fields included) — the thing to validate.
 *
 * @throws {KVStoreErrors.ValidationFailed} If a key field of the value differs from the key, or if a
 *   store with a declared key is given a value that is not an object.
 */
function mergeKeyIntoValue(model: KeyModel, keyAttrs: Record<string, KeyValue>, value: unknown): unknown {
	if (!model.declared) return value;
	if (!isPlainObject(value)) throw blocksError(KVStoreErrors.ValidationFailed, KVStoreMessages.valueMustBeObject);
	for (const field of keyFields(model.table)) {
		if (field in value && value[field] !== undefined && value[field] !== keyAttrs[field]) {
			throw blocksError(KVStoreErrors.ValidationFailed, KVStoreMessages.keyValueDisagree(field));
		}
	}
	return { ...value, ...keyAttrs };
}

/** The field name that DynamoDB cannot store. */
const UNSTORABLE_FIELD = '__proto__';

/**
 * Whether a value has, at any depth, a field with a name that DynamoDB cannot
 * store. The one such name is `__proto__`: the DynamoDB document client drops
 * the field without an error, so an item would lose it on AWS and keep it in
 * the mock. An object that `JSON.parse` built can have a field of that name;
 * an object literal `{ __proto__: x }` sets the prototype and has no such field.
 */
function hasUnstorableField(value: unknown): boolean {
	if (Array.isArray(value)) return value.some(hasUnstorableField);
	if (!isPlainObject(value)) return false;
	return Object.keys(value).some((field) => field === UNSTORABLE_FIELD || hasUnstorableField(value[field]));
}

/**
 * Build the stored item for a write: the key attributes, the value laid out
 * flat (an object) or in `_bkv_value` (anything else), and the expiry.
 *
 * `value` is the merged value from {@link mergeKeyIntoValue} for a declared-key
 * store, or the raw value for a string store.
 *
 * @throws {KVStoreErrors.ValidationFailed} If the value has a field named `__proto__` at any depth
 *   (a field name that DynamoDB cannot store), or if an object value has a top-level field that
 *   starts with `_bkv_`, or an empty string in an indexed field.
 */
function buildItem(
	model: KeyModel,
	keyAttrs: Record<string, KeyValue>,
	value: unknown,
	expiresAt: number | undefined,
): Item {
	if (hasUnstorableField(value)) {
		throw blocksError(KVStoreErrors.ValidationFailed, KVStoreMessages.unstorableField(UNSTORABLE_FIELD));
	}
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

/**
 * Validate a write and build its stored item, the same way in both runtimes:
 * the key checks, the merge of the key into the value, schema validation, and
 * then the layout checks of {@link buildItem}.
 *
 * @throws {KVStoreErrors.InvalidQuery} If the key has the wrong shape.
 * @throws {KVStoreErrors.ValidationFailed} If the value fails the schema, disagrees with its key, has a
 *   reserved field, has a field name that DynamoDB cannot store, or has an empty string in a key field
 *   or an indexed field; or if the expiry is not usable.
 */
export async function prepareItem(
	model: KeyModel,
	key: unknown,
	value: unknown,
	expiry: Expiry | undefined,
): Promise<{ keyAttrs: Record<string, KeyValue>; item: Item }> {
	const keyAttrs = normalizeKey(model, key);
	const full = mergeKeyIntoValue(model, keyAttrs, value);
	await validateSchema(model.schema, full);
	return { keyAttrs, item: buildItem(model, keyAttrs, full, resolveTtlEpochSeconds(expiry)) };
}

// ── Reads ───────────────────────────────────────────────────────────────────

/** What a read yields: the key, the value, and the expiry when the item has one. */
export interface ReadEntry {
	key: unknown;
	value: unknown;
	expiresAt?: number;
}

/**
 * The value of a stored item. The block's own attributes (`_bkv_pk`,
 * `_bkv_ttl`) leave the value; the declared key fields and a `ttl` field stay
 * in it, because they are fields of the value.
 */
function readValue(item: Item): unknown {
	if (VALUE_ATTRIBUTE in item) return item[VALUE_ATTRIBUTE];
	const value: Item = {};
	// No field here is named `__proto__`: a write rejects that name, and the
	// mock does not load an item that has it.
	for (const field of Object.keys(item)) {
		if (!field.startsWith(RESERVED_PREFIX)) value[field] = item[field];
	}
	return value;
}

/** Turn a stored item back into `{ key, value, expiresAt }`. */
function readItem(model: KeyModel, item: Item): ReadEntry {
	const entry: ReadEntry = {
		key: model.declared ? keyOfItem(model, item) : item[PK_ATTRIBUTE],
		value: readValue(item),
	};
	const ttl = item[model.ttlAttribute];
	if (typeof ttl === 'number' && Number.isFinite(ttl)) entry.expiresAt = ttl;
	return entry;
}

/** Whether the item's expiry has passed. */
export function itemExpired(model: KeyModel, item: Item, nowSeconds?: number): boolean {
	return isExpired(item[model.ttlAttribute], nowSeconds);
}

/** The items of a page whose expiry has not passed, with the clock read once for the page. */
export function liveItems(model: KeyModel, items: Item[]): Item[] {
	const now = nowEpochSeconds();
	return items.filter((item) => !itemExpired(model, item, now));
}

/**
 * The read side of one store: turns a stored item into the value or the entry
 * a caller sees. Whether a read reconciles with the schema is decided once,
 * here, so a store with no schema (or `readValidation: 'off'`) does no
 * per-item validation work.
 */
export interface Reader<V, E> {
	/** The value of a live item; `null` for a missing or expired item. */
	value(item: Item | undefined, nowSeconds?: number): Promise<V | null>;
	/** The `{ key, value, expiresAt }` entry of an item. A promise only when the store reconciles reads. */
	entry(item: Item): E | Promise<E>;
}

/** Build the {@link Reader} of a store. See `applyReadValidation` for the three `readValidation` modes. */
export function createReader<V, E>(
	model: KeyModel,
	readValidation: ReadValidationMode,
	log: Pick<ChildLogger, 'warn'>,
	context: Record<string, unknown>,
): Reader<V, E> {
	const schema = model.schema;
	const reconcile =
		schema && readValidation !== 'off'
			? (value: unknown) => applyReadValidation(readValidation, schema, value, log, context)
			: undefined;
	return {
		async value(item, nowSeconds) {
			if (!item || itemExpired(model, item, nowSeconds)) return null;
			const value = readValue(item);
			return (reconcile ? reconcile(value) : value) as V | null;
		},
		entry(item) {
			const entry = readItem(model, item);
			if (!reconcile) return entry as E;
			return reconcile(entry.value).then((value) => ({ ...entry, value }) as E);
		},
	};
}

// ── Conditions ──────────────────────────────────────────────────────────────

/** The conditions of a write or a delete, as the shared helpers read them (every typed form of the options narrows to this). */
interface Conditions {
	ifNotExists?: boolean;
	ifExists?: boolean;
	ifFieldEquals?: unknown;
	ifValueEquals?: unknown;
}

/** A value check, normalized: the fields to compare, or the whole non-object value. */
type ValueCheckPlan =
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
function planValueCheck(options: Conditions | undefined): ValueCheckPlan {
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
interface ConditionExpression {
	ConditionExpression: string;
	ExpressionAttributeNames: Record<string, string>;
	ExpressionAttributeValues?: Record<string, unknown>;
}

/** A condition, resolved: the DynamoDB expression for AWS, and the parts the mock evaluates itself. */
export interface ConditionPlan {
	/** The expression to send, or `undefined` when the call set no condition. */
	expression: ConditionExpression | undefined;
	/** Whether a failed condition is worth a re-read and a retry (see `conditionalCheckFailed`). */
	retriable: boolean;
	/** The value check, if the call set one. */
	check: ValueCheckPlan;
	/** Whether the call asserts existence: `ifNotExists` on a put, `ifExists` on a delete. */
	existence: boolean;
}

/**
 * Build a condition from an existence assertion and a value check, joined by
 * `joiner`. A value check is one clause for `ifValueEquals`, or one clause per
 * field of `ifFieldEquals` joined with AND.
 */
function buildCondition(
	model: KeyModel,
	existence: 'attribute_not_exists' | 'attribute_exists' | undefined,
	check: ValueCheckPlan,
	joiner: ' OR ' | ' AND ',
): ConditionExpression | undefined {
	const arms: string[] = [];
	const names: Record<string, string> = {};
	const values: Record<string, unknown> = {};
	if (existence) {
		arms.push(`${existence}(#pk)`);
		names['#pk'] = model.table.partitionKey;
	}
	if (check?.kind === 'value') {
		names['#value'] = VALUE_ATTRIBUTE;
		values[':expected'] = check.expected;
		arms.push('#value = :expected');
	} else if (check) {
		const parts = check.entries.map(([field, value], i) => {
			names[`#field${i}`] = field;
			values[`:val${i}`] = value;
			return `#field${i} = :val${i}`;
		});
		arms.push(parts.length === 1 ? parts[0] : `(${parts.join(' AND ')})`);
	}
	if (arms.length === 0) return undefined;
	return {
		ConditionExpression: arms.join(joiner),
		ExpressionAttributeNames: names,
		...(Object.keys(values).length > 0 ? { ExpressionAttributeValues: values } : {}),
	};
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
export function putCondition(model: KeyModel, options: Conditions | undefined): ConditionPlan {
	const check = planValueCheck(options);
	const existence = options?.ifNotExists === true;
	return {
		expression: buildCondition(model, existence ? 'attribute_not_exists' : undefined, check, ' OR '),
		retriable: check !== undefined,
		check,
		existence,
	};
}

/**
 * The DynamoDB condition for a `delete`. `ifExists` and a value check compose
 * with AND — both must hold. Retriable only for a value check without
 * `ifExists`: the existence assertion wins, so a combined conflict is not
 * retriable.
 */
export function deleteCondition(model: KeyModel, options: Conditions | undefined): ConditionPlan {
	const check = planValueCheck(options);
	const existence = options?.ifExists === true;
	return {
		expression: buildCondition(model, existence ? 'attribute_exists' : undefined, check, ' AND '),
		retriable: check !== undefined && !existence,
		check,
		existence,
	};
}

/**
 * Order-independent structural equality, used by the mock to compare a value
 * check against stored attributes. DynamoDB Maps are an unordered collection of
 * name-value pairs, so `{ a, b }` and `{ b, a }` are the same value — a plain
 * `JSON.stringify` compare would wrongly treat them as different and fail the
 * condition. Arrays remain order-sensitive (DynamoDB Lists are ordered).
 */
function deepEqual(a: unknown, b: unknown): boolean {
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

/**
 * The sort conditions of a query. Each one has the DynamoDB key-condition
 * clause that AWS sends and the predicate that the mock applies, side by side,
 * so the two cannot drift.
 */
const SORT_CONDITIONS = {
	equals: { clause: '#sk = :skval', matches: (v: KeyValue, [a]: KeyValue[]) => v === a },
	greaterThan: { clause: '#sk > :skval', matches: (v: KeyValue, [a]: KeyValue[]) => v > a },
	greaterThanOrEqual: { clause: '#sk >= :skval', matches: (v: KeyValue, [a]: KeyValue[]) => v >= a },
	lessThan: { clause: '#sk < :skval', matches: (v: KeyValue, [a]: KeyValue[]) => v < a },
	lessThanOrEqual: { clause: '#sk <= :skval', matches: (v: KeyValue, [a]: KeyValue[]) => v <= a },
	between: {
		clause: '#sk BETWEEN :skval1 AND :skval2',
		matches: (v: KeyValue, [lo, hi]: KeyValue[]) => v >= lo && v <= hi,
	},
	beginsWith: {
		clause: 'begins_with(#sk, :skval)',
		matches: (v: KeyValue, [prefix]: KeyValue[]) => typeof v === 'string' && v.startsWith(prefix as string),
	},
} as const;

type SortOp = keyof typeof SORT_CONDITIONS;

/** A query, resolved and checked: which key to read, the partition value, the sort condition, and the page. */
export interface QueryPlan {
	indexName: string | undefined;
	key: KeyAttributes;
	pkValue: KeyValue;
	/** The one sort condition of the query and its operands (two for `between`, one otherwise). */
	sort: { op: SortOp; operands: KeyValue[] } | undefined;
	limit: number | undefined;
	order: 'asc' | 'desc';
	/** The key to start after, decoded from the `cursor` option. */
	startKey: Record<string, KeyValue> | undefined;
}

/** The query options as the shared code reads them. */
interface LooseQueryOptions {
	index?: string | null;
	where?: Record<string, unknown>;
	limit?: unknown;
	order?: unknown;
	cursor?: unknown;
}

/**
 * Resolve a `query` call against the key model, checking it the same way in
 * both runtimes.
 *
 * @throws {KVStoreErrors.InvalidQuery} If `index` is unknown, if the store has no declared key and no
 *   `index` is given, if `where` is missing or lacks `{ equals }` on the partition field, if more
 *   than one sort-key condition is given, if `limit` is not a positive integer, or if the cursor
 *   does not belong to this store, index, and partition.
 */
export function planQuery(model: KeyModel, queryOptions: unknown): QueryPlan {
	const options = (queryOptions ?? {}) as LooseQueryOptions;
	const indexName = options.index ?? undefined;
	let key: KeyAttributes | undefined;
	if (indexName !== undefined) {
		key = model.indexes[indexName];
		if (!key) throw blocksError(KVStoreErrors.InvalidQuery, KVStoreMessages.indexNotFound(indexName));
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
	return {
		indexName,
		key,
		pkValue,
		sort: key.sortKey ? planSort(options.where[key.sortKey]) : undefined,
		limit: normalizeLimit(options.limit),
		order: options.order === 'desc' ? 'desc' : 'asc',
		startKey: decodeCursor(model, options.cursor, indexName, { field: key.partitionKey, value: pkValue }),
	};
}

/**
 * Normalize the sort-key condition up front — before any data is read — so a
 * present-but-empty condition becomes "no filter" and multiple conditions are
 * rejected eagerly, even on an empty table.
 */
function planSort(condition: unknown): QueryPlan['sort'] {
	const normalized = normalizeSortKeyCondition(condition as Record<string, unknown> | undefined);
	if (!normalized) return undefined;
	const op = Object.keys(normalized).find((k) => normalized[k] !== undefined);
	if (op === undefined || !Object.hasOwn(SORT_CONDITIONS, op)) return undefined;
	const operand = normalized[op];
	if (op !== 'between') return { op: op as SortOp, operands: [operand as KeyValue] };
	return Array.isArray(operand) ? { op, operands: operand as KeyValue[] } : undefined;
}

/** Whether a sort-key value satisfies the sort condition of a query (the mock's counterpart to {@link keyCondition}). */
export function matchesSort(value: unknown, sort: QueryPlan['sort']): boolean {
	return sort === undefined || SORT_CONDITIONS[sort.op].matches(value as KeyValue, sort.operands);
}

/** The DynamoDB key condition of a query: the partition key, and the sort condition when the query has one. */
export function keyCondition(plan: QueryPlan): {
	KeyConditionExpression: string;
	ExpressionAttributeNames: Record<string, string>;
	ExpressionAttributeValues: Record<string, unknown>;
} {
	const names: Record<string, string> = { '#pk': plan.key.partitionKey };
	const values: Record<string, unknown> = { ':pkval': plan.pkValue };
	let expression = '#pk = :pkval';
	if (plan.key.sortKey && plan.sort) {
		names['#sk'] = plan.key.sortKey;
		expression += ` AND ${SORT_CONDITIONS[plan.sort.op].clause}`;
		if (plan.sort.op === 'between') {
			[values[':skval1'], values[':skval2']] = plan.sort.operands;
		} else {
			values[':skval'] = plan.sort.operands[0];
		}
	}
	return {
		KeyConditionExpression: expression,
		ExpressionAttributeNames: names,
		ExpressionAttributeValues: values,
	};
}

/** Compare two key values the way DynamoDB orders a sort key of that type. */
export function compareKeyValues(a: unknown, b: unknown): number {
	const av = a as KeyValue;
	const bv = b as KeyValue;
	return av < bv ? -1 : av > bv ? 1 : 0;
}

/**
 * Check a `limit` option. `undefined` and `null` both mean "no limit": a JSON
 * transport turns an optional positional argument that the caller left out
 * into `null`, so an API method that forwards its arguments passes `null` here.
 *
 * @throws {KVStoreErrors.InvalidQuery} If the limit is not a positive integer.
 */
export function normalizeLimit(limit: unknown): number | undefined {
	if (limit === undefined || limit === null) return undefined;
	if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1) {
		throw blocksError(KVStoreErrors.InvalidQuery, KVStoreMessages.limitInvalid(String(limit)));
	}
	return limit;
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
function cursorFields(model: KeyModel, indexName: string | undefined): string[] {
	const fields = keyFields(model.table);
	if (indexName === undefined) return fields;
	for (const f of keyFields(model.indexes[indexName])) if (!fields.includes(f)) fields.push(f);
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
 * Decode and check a `cursor` option before it drives a read, or return
 * `undefined` when there is none. `undefined` and `null` both mean "start at
 * the first entry" (see {@link normalizeLimit} for why `null` counts as
 * absent), which any caller can already ask for by leaving the cursor out.
 *
 * The cursor must decode, must name the same index as the call, must hold
 * exactly the key attributes of that table or index (each a non-empty string
 * or a finite number), and — for a query — its partition value must match
 * `where`.
 *
 * @throws {KVStoreErrors.InvalidQuery} If any check fails.
 */
export function decodeCursor(
	model: KeyModel,
	cursor: unknown,
	indexName: string | undefined,
	partition?: { field: string; value: KeyValue },
): Record<string, KeyValue> | undefined {
	if (cursor === undefined || cursor === null) return undefined;
	let payload: unknown;
	try {
		payload =
			typeof cursor === 'string' &&
			cursor !== '' &&
			JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
	} catch {
		payload = undefined;
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

/**
 * The object `query` and `scan` return. Iterates the pages of the source once
 * per `for await`, and exposes `cursor`: the position after the last entry the
 * iterator returned. It is `undefined` before the first entry and when the read
 * reached the end, so it is set exactly when a `limit` or the consumer stopped
 * the read early.
 *
 * The source yields pages of live items in read order. The results object
 * applies the `limit`, builds each entry, and keeps only the last item: the
 * cursor is encoded when it is asked for, not for every entry.
 */
export class PagedResults<E> implements AsyncIterable<E> {
	private last: Item | undefined;

	constructor(
		private readonly pages: () => AsyncIterable<Item[]> | Iterable<Item[]>,
		private readonly toEntry: (item: Item) => E | Promise<E>,
		private readonly limit: number | undefined,
		private readonly position: (item: Item) => string,
	) {}

	get cursor(): string | undefined {
		return this.last === undefined ? undefined : this.position(this.last);
	}

	async *[Symbol.asyncIterator](): AsyncIterator<E> {
		this.last = undefined;
		let count = 0;
		for await (const page of this.pages()) {
			for (const item of page) {
				const entry = this.toEntry(item);
				const resolved = entry instanceof Promise ? await entry : entry;
				// Set after the entry is built, so an entry that fails to build is
				// not skipped by a later read that starts at the cursor.
				this.last = item;
				yield resolved;
				if (this.limit !== undefined && ++count >= this.limit) return;
			}
		}
		this.last = undefined;
	}
}
