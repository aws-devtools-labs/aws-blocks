// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The checks and the update of `appendToList`, shared by the mock and the AWS
 * runtime, so the two accept and reject the same calls with the same errors and
 * apply the same change to a stored item.
 *
 * `appendToList` changes one top-level list field of a stored object value in
 * one atomic step. On AWS it is one DynamoDB `UpdateItem` with
 * `SET #f = list_append(if_not_exists(#f, :empty), :items)`. The mock applies the
 * same change with no `await` between its read and its write.
 */
import { brandBlocksError } from '@aws-cdk-blocks/core';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { blocksError, KVStoreErrors, KVStoreMessages } from './errors.js';
import {
	hasUnstorableField,
	type Item,
	type KeyModel,
	type KeyValue,
	keyFields,
	MAX_NESTING_DEPTH,
	nestsTooDeep,
	normalizeKey,
} from './item.js';
import { RESERVED_PREFIX, VALUE_ATTRIBUTE } from './ttl.js';

/** @internal The messages of `appendToList`. The mock and the AWS runtime use the same text, byte for byte. */
export const AppendToListMessages = {
	fieldNotString: (received: string) => `appendToList() field must be a non-empty string (received ${received})`,
	fieldIsKey: (field: string) => `appendToList() cannot change '${field}': it is a key field of the store`,
	fieldIsIndexKey: (field: string, index: string) =>
		`appendToList() cannot change '${field}': it is a key field of index '${index}'`,
	fieldIsTtl: (field: string) => `appendToList() cannot change '${field}': it holds the expiry of the item`,
	itemsNotArray: (received: string) => `appendToList() items must be an array (received ${received})`,
	notAList: (field: string) => `appendToList() field '${field}' holds a value that is not a list`,
	valueNotObject: 'appendToList() needs a stored object value; this key holds a value that is not an object',
} as const;

/** @internal A checked `appendToList` call. */
export interface AppendToListPlan {
	keyAttrs: Record<string, KeyValue>;
	field: string;
	/** The items to append, with `undefined` elements left out, as the DynamoDB document client leaves them out. */
	items: unknown[];
}

function describe(value: unknown): string {
	if (value === null) return 'null';
	if (Array.isArray(value)) return 'an array';
	return typeof value === 'object' ? 'an object' : typeof value;
}

function pathKey(segment: unknown): unknown {
	return typeof segment === 'object' && segment !== null && 'key' in segment
		? (segment as { key: unknown }).key
		: segment;
}

/**
 * Validate the items against the schema of their field. The schema sees an
 * object with the key fields and the field set to the items, and only an issue
 * at the path of the field fails the call. The issues of the other fields of the
 * schema are those of a value with only these fields, so they do not count.
 *
 * The check is on the appended items as a list of their own. A rule on the
 * whole list (such as a maximum length) applies to the items, not to the list
 * that results, because the AWS runtime does not read the stored list.
 */
async function validateField(
	schema: StandardSchemaV1 | undefined,
	model: KeyModel,
	keyAttrs: Record<string, KeyValue>,
	field: string,
	items: unknown[],
): Promise<void> {
	if (!schema) return;
	const value = model.declared ? { ...keyAttrs, [field]: items } : { [field]: items };
	const result = await schema['~standard'].validate(value);
	const issues = (result.issues ?? []).filter(
		(i) => i.path !== undefined && i.path.length > 0 && pathKey(i.path[0]) === field,
	);
	if (issues.length > 0) throw blocksError(KVStoreErrors.ValidationFailed, issues[0].message);
}

/**
 * Check an `appendToList` call, the same way in both runtimes, before any read
 * or write: the key, the field, the items, and the schema of the field.
 *
 * @throws {KVStoreErrors.InvalidQuery} If the key has the wrong shape, the field
 *   is not a non-empty string, the field is a key field of the store or of an
 *   index, the field holds the expiry, or the items are not an array.
 * @throws {KVStoreErrors.ValidationFailed} If a key field is an empty string, the
 *   field starts with `_bkv_` or is `__proto__`, an item has a field named
 *   `__proto__` at any depth, the items would nest lists or maps more than 32
 *   levels deep, or the items fail the schema of the field.
 */
export async function planAppendToList(
	model: KeyModel,
	key: unknown,
	field: unknown,
	items: unknown,
): Promise<AppendToListPlan> {
	const keyAttrs = normalizeKey(model, key);
	if (typeof field !== 'string' || field === '') {
		throw blocksError(KVStoreErrors.InvalidQuery, AppendToListMessages.fieldNotString(describe(field)));
	}
	if (field.startsWith(RESERVED_PREFIX)) {
		throw blocksError(KVStoreErrors.ValidationFailed, KVStoreMessages.reservedField(field));
	}
	if (field === '__proto__') {
		throw blocksError(KVStoreErrors.ValidationFailed, KVStoreMessages.unstorableField(field));
	}
	if (keyFields(model.table).includes(field)) {
		throw blocksError(KVStoreErrors.InvalidQuery, AppendToListMessages.fieldIsKey(field));
	}
	for (const [name, index] of Object.entries(model.indexes)) {
		if (keyFields(index).includes(field)) {
			throw blocksError(KVStoreErrors.InvalidQuery, AppendToListMessages.fieldIsIndexKey(field, name));
		}
	}
	if (field === model.ttlAttribute) {
		throw blocksError(KVStoreErrors.InvalidQuery, AppendToListMessages.fieldIsTtl(field));
	}
	if (!Array.isArray(items)) {
		throw blocksError(KVStoreErrors.InvalidQuery, AppendToListMessages.itemsNotArray(describe(items)));
	}
	const present = items.filter((item) => item !== undefined);
	if (hasUnstorableField(present)) {
		throw blocksError(KVStoreErrors.ValidationFailed, KVStoreMessages.unstorableField('__proto__'));
	}
	// The field holds the list, a top-level attribute, so the list itself is depth 1.
	if (nestsTooDeep(present, 1)) {
		throw blocksError(KVStoreErrors.ValidationFailed, KVStoreMessages.nestedTooDeep(MAX_NESTING_DEPTH + 1));
	}
	await validateField(model.schema, model, keyAttrs, field, present);
	return { keyAttrs, field, items: present };
}

/**
 * The `UpdateItem` input of an `appendToList` call, without the table name.
 *
 * The condition requires an item that exists and holds an object value (no
 * `_bkv_value` attribute). With `ReturnValuesOnConditionCheckFailure: 'ALL_OLD'`
 * a failed condition tells the two cases apart: DynamoDB returns the item when it
 * exists. `UPDATED_NEW` returns the field after the append.
 */
export function appendToListInput(model: KeyModel, plan: AppendToListPlan) {
	return {
		Key: plan.keyAttrs,
		UpdateExpression: 'SET #f = list_append(if_not_exists(#f, :empty), :items)',
		ConditionExpression: 'attribute_exists(#pk) AND attribute_not_exists(#v)',
		ExpressionAttributeNames: { '#f': plan.field, '#pk': model.table.partitionKey, '#v': VALUE_ATTRIBUTE },
		ExpressionAttributeValues: { ':empty': [], ':items': plan.items },
		ReturnValues: 'UPDATED_NEW' as const,
		ReturnValuesOnConditionCheckFailure: 'ALL_OLD' as const,
	};
}

/**
 * Apply an `appendToList` call to the stored item, as DynamoDB does, for the
 * mock. Returns the new item and the new list. Throws what the AWS runtime maps
 * DynamoDB's answer to: `null` when the key does not exist (the caller throws
 * the 409), and `ValidationFailed` when the item does not hold an object value
 * or the field holds a value that is not a list.
 */
export function appendToStoredItem(
	existing: Item | undefined,
	plan: AppendToListPlan,
): { item: Item; list: unknown[] } | null {
	if (existing === undefined) return null;
	if (VALUE_ATTRIBUTE in existing) {
		throw blocksError(KVStoreErrors.ValidationFailed, AppendToListMessages.valueNotObject);
	}
	const current = existing[plan.field];
	if (current !== undefined && !Array.isArray(current)) {
		throw blocksError(KVStoreErrors.ValidationFailed, AppendToListMessages.notAList(plan.field));
	}
	const list = [...(current ?? []), ...plan.items];
	return { item: { ...existing, [plan.field]: list }, list };
}

/**
 * Map the error of a failed `appendToList` `UpdateItem` the way the mock fails
 * for the same stored item. Returns the error to throw, or `undefined` when the
 * error is not one of these cases.
 *
 * - A failed condition with the item returned: the value is not an object.
 * - A failed condition with no item: the key does not exist (the caller throws the 409).
 * - DynamoDB's `ValidationException` for an operand of the wrong type: the field is not a list.
 * - DynamoDB's `ValidationException` for an item that grows past 400 KB: `ItemTooLarge`.
 */
export function appendToListFailure(err: unknown, field: string): 'absent' | Error | undefined {
	if (!(err instanceof Error)) return undefined;
	if (err.name === KVStoreErrors.ConditionalCheckFailed) {
		const item = (err as { Item?: unknown }).Item;
		if (item !== undefined && item !== null) {
			return blocksError(KVStoreErrors.ValidationFailed, AppendToListMessages.valueNotObject);
		}
		return 'absent';
	}
	if (err.name === 'ValidationException' && /incorrect data type/i.test(err.message)) {
		return blocksError(KVStoreErrors.ValidationFailed, AppendToListMessages.notAList(field));
	}
	// The size message of `UpdateItem` reads "Item size to update has exceeded ...", which
	// the remap of `put` does not match. The error is the same `ItemTooLarge`, with the
	// DynamoDB error kept as a non-enumerable `cause`, server-side.
	if (err.name === 'ValidationException' && /size to update has exceeded/i.test(err.message)) {
		const remapped = new Error(
			`${KVStoreErrors.ItemTooLarge}: Item size has exceeded the maximum allowed size of 400 KB`,
			{ cause: err },
		);
		remapped.name = KVStoreErrors.ItemTooLarge;
		return brandBlocksError(remapped);
	}
	return undefined;
}
