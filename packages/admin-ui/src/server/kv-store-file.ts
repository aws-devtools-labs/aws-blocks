// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The `KVStore` local data file, in one place.
 *
 * The local mock of `KVStore` keeps a store in `.bb-data/<fullId>/store.json`:
 *
 * ```json
 * { "version": 2, "items": [{ "_bkv_pk": "a", "_bkv_value": "hello" }] }
 * ```
 *
 * Each entry of `items` is the exact DynamoDB item that the deployed block
 * writes. `packages/bb-kv-store/src/item.ts` owns the layout:
 *
 * - A store with no `key` option keys an item by the string attribute
 *   `_bkv_pk`. A store with a `key` option uses the named fields of the value
 *   as its key attributes.
 * - An object value is stored flat, one attribute for each top-level field.
 *   Any other value (a string, a number, an array, `null`) is in `_bkv_value`.
 * - An expiry is in `_bkv_ttl`, in epoch seconds, unless the `ttl` option of
 *   the store names a field of the value.
 *
 * The block owns every top-level attribute name that starts with `_bkv_`.
 *
 * The reader and the writer both go through this module, for the reason
 * `pair-key.ts` gives for the pair format: if the two disagree on the key or
 * the value of an item, the record the browser displayed and the record an
 * edit addresses stop being the same record.
 */

/** The version of the data file that this module reads and writes. */
export const KV_STORE_FILE_VERSION = 2;

/** The prefix of the attributes the block owns. A value has no top-level field with it. */
export const KV_RESERVED_PREFIX = '_bkv_';

/** The key attribute of a store with no `key` option. */
export const KV_PK_ATTRIBUTE = '_bkv_pk';

/** The attribute that holds a value that is not an object. */
export const KV_VALUE_ATTRIBUTE = '_bkv_value';

/** The attribute that holds the expiry, in epoch seconds, when no field of the value does. */
export const KV_TTL_ATTRIBUTE = '_bkv_ttl';

/**
 * The key-field name reported for a store with no `key` option.
 *
 * Such a store has exactly one key, a string, which is what `get(key)` takes.
 * `'key'` names it without claiming a field of a schema, as the object-map
 * format does for its property name.
 */
export const KV_STRING_KEY_FIELD = 'key';

/** A parsed `KVStore` data file. */
export interface KvStoreFile {
	version: typeof KV_STORE_FILE_VERSION;
	items: unknown[];
}

/** How the items of one store are keyed. */
export interface KvStoreKeys {
	/** True for a store with no `key` option: each item has its key in `_bkv_pk`. */
	stringKeyed: boolean;
	/** The key field names in key order: `['key']`, the declared fields, or `[]` when they are not known. */
	keyFields: string[];
}

/** One item, read back into what a `KVStore` read returns. */
export interface KvRecord {
	/** Key values by field name, as strings. Absent when the item has no key that this module can name. */
	keyValues?: Record<string, string>;
	/** The value: `_bkv_value`, or the fields of the item without the block's own attributes. */
	value: unknown;
	/** The expiry in epoch seconds, when the item keeps it in `_bkv_ttl`. */
	expiresAt?: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Whether a parsed file is a `KVStore` data file.
 *
 * The version is what tells it from the object map that an earlier release
 * wrote under the same filename, where `version` and `items` would be two
 * ordinary keys of the store.
 */
export function isKvStoreFile(parsed: unknown): parsed is KvStoreFile {
	return isPlainObject(parsed) && parsed.version === KV_STORE_FILE_VERSION && Array.isArray(parsed.items);
}

/** The file to write for a list of items. */
export function kvStoreFileOf(items: unknown[]): KvStoreFile {
	return { version: KV_STORE_FILE_VERSION, items };
}

/** Whether the items are keyed by one string (`_bkv_pk`), as in a store with no `key` option. */
export function isStringKeyed(items: readonly unknown[]): boolean {
	return items.some((item) => isPlainObject(item) && typeof item[KV_PK_ATTRIBUTE] === 'string');
}

/**
 * How the items of a store are keyed.
 *
 * `_bkv_pk` in an item decides it: a store with declared key fields never has
 * that attribute, because the block rejects a value field with its prefix.
 * Without it, the key fields are the declared ones (`declaredFields`, from the
 * block's source). When those are not known either, the result has no key
 * fields: a guess would name a schema that this module cannot see.
 */
export function describeKvStoreKeys(items: readonly unknown[], declaredFields: readonly string[]): KvStoreKeys {
	if (isStringKeyed(items)) return { stringKeyed: true, keyFields: [KV_STRING_KEY_FIELD] };
	return { stringKeyed: false, keyFields: [...declaredFields] };
}

/**
 * The key values of an item by field name, or `undefined`.
 *
 * `undefined`, never a partial mapping, when a key attribute is missing or is
 * not a string or a number: an edit or a delete addresses a record by exactly
 * these values.
 */
function kvKeyValuesOf(item: Record<string, unknown>, keys: KvStoreKeys): Record<string, string> | undefined {
	if (keys.stringKeyed) {
		const key = item[KV_PK_ATTRIBUTE];
		return typeof key === 'string' ? { [KV_STRING_KEY_FIELD]: key } : undefined;
	}
	if (keys.keyFields.length === 0) return undefined;
	const keyValues: Record<string, string> = {};
	for (const field of keys.keyFields) {
		const value = item[field];
		if (typeof value !== 'string' && typeof value !== 'number') return undefined;
		keyValues[field] = String(value);
	}
	return keyValues;
}

/**
 * The value of an item, as a `KVStore` read returns it: `_bkv_value` when the
 * item has it, else the fields of the item without the block's own attributes.
 * The declared key fields stay in the value, because they are fields of it.
 */
function kvValueOf(item: Record<string, unknown>): unknown {
	if (KV_VALUE_ATTRIBUTE in item) return item[KV_VALUE_ATTRIBUTE];
	const value: Record<string, unknown> = {};
	for (const field of Object.keys(item)) {
		if (!field.startsWith(KV_RESERVED_PREFIX)) value[field] = item[field];
	}
	return value;
}

/**
 * Reads one entry of `items`.
 *
 * An entry that is not an object is not an item of the store. It comes back as
 * its own value with no key, so the browser can still show it.
 */
export function readKvItem(item: unknown, keys: KvStoreKeys): KvRecord {
	if (!isPlainObject(item)) return { value: item };
	const record: KvRecord = { value: kvValueOf(item) };
	const keyValues = kvKeyValuesOf(item, keys);
	if (keyValues !== undefined) record.keyValues = keyValues;
	const expiry = item[KV_TTL_ATTRIBUTE];
	if (typeof expiry === 'number' && Number.isFinite(expiry)) record.expiresAt = expiry;
	return record;
}

/**
 * Index of the item of a declared-key store that `keyValues` addresses, or `-1`.
 *
 * A stored key value is compared as a string, so a numeric sort key `9` on
 * disk matches the `'9'` that the browser sends back.
 */
export function indexOfKvItem(
	items: readonly unknown[],
	keyValues: Record<string, string>,
	keyFields: readonly string[],
): number {
	if (keyFields.length === 0) return -1;
	return items.findIndex(
		(item) =>
			isPlainObject(item) &&
			keyFields.every((field) => {
				const stored = item[field];
				return (
					(typeof stored === 'string' || typeof stored === 'number') && String(stored) === keyValues[field]
				);
			}),
	);
}

/** The first top-level field of a record that has the block's prefix, if there is one. */
export function reservedFieldOf(record: Record<string, unknown>): string | undefined {
	return Object.keys(record).find((field) => field.startsWith(KV_RESERVED_PREFIX));
}

/**
 * The item to store when `record` replaces `existing`.
 *
 * The key attributes stay exactly as they were stored, so a numeric key does
 * not become a string. The expiry in `_bkv_ttl` stays too: it is not part of
 * the value that an editor showed, so an edit of the value must not remove it.
 */
export function replaceKvItem(
	existing: unknown,
	record: Record<string, unknown>,
	keyFields: readonly string[],
): Record<string, unknown> {
	const item: Record<string, unknown> = { ...record };
	if (!isPlainObject(existing)) return item;
	for (const field of keyFields) item[field] = existing[field];
	if (KV_TTL_ATTRIBUTE in existing) item[KV_TTL_ATTRIBUTE] = existing[KV_TTL_ATTRIBUTE];
	return item;
}
