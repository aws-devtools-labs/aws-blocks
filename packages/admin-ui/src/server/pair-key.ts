// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The `.bb-data` pair-key format, in one place.
 *
 * A local store's `data.json` is `[[serializedKey, item], …]`, where the dev
 * server writes the key as `JSON.stringify([pkValue, skValue?])` in key order.
 * Three pieces of knowledge follow from that — the field ORDER, how to ENCODE a
 * key, and how to DECODE one — and they were each drifting into a different
 * module: the reader knew how to decode, the writer knew how to encode, and the
 * validator had its own copy of the ordering.
 *
 * Encode and decode are inverses, which is a stronger reason to keep them
 * adjacent than mere duplication would be. If they ever disagree, the failure is
 * silent and specific: the record the browser displayed and the record an edit
 * addresses stop being the same record, and the write lands somewhere the user
 * did not look at. `pair-key.test.ts` asserts the round trip in both directions,
 * so the invariant is checked rather than assumed.
 */

import type { BlockKeySchema } from '../contract/v1.js';

/**
 * The key fields in the order the serialized key stores them: partition key
 * first, sort key second when there is one. Every encode and decode derives its
 * ordering from here rather than re-reading the schema.
 */
export function keySchemaFields(keySchema?: BlockKeySchema): string[] {
	if (!keySchema) return [];
	return keySchema.sortKey ? [keySchema.partitionKey, keySchema.sortKey] : [keySchema.partitionKey];
}

/**
 * Named key values → the serialized on-disk key, or `undefined` when any field
 * is missing or empty.
 *
 * `undefined` rather than a `[null]`-shaped key: a partially addressed record is
 * the one thing a write must never guess at, because the guess would silently
 * name a different record than the user chose.
 */
export function serializePairKey(values: Record<string, string>, keyFields: string[]): string | undefined {
	if (keyFields.length === 0) return undefined;
	const parts: string[] = [];
	for (const field of keyFields) {
		const value = values[field];
		if (typeof value !== 'string' || value === '') return undefined;
		parts.push(value);
	}
	return JSON.stringify(parts);
}

/**
 * The serialized on-disk key → named key values, so `'["u1","t9"]'` with a
 * `userId`/`todoId` schema becomes `{ userId: 'u1', todoId: 't9' }`.
 *
 * Returns `undefined` — never a partial or invented mapping — when the key does
 * not parse as an array, the arity does not match the schema, or no schema was
 * supplied. A half-filled key is worse than none, because a later edit or delete
 * addresses a record by exactly these fields.
 *
 * Numbers are accepted and stringified: sort keys are often numeric timestamps,
 * and the encoder's canonical form is a string, so this is what makes the two
 * directions agree on `["u1",9]`.
 */
export function resolveSerializedKey(key: string, keyFields: string[]): Record<string, string> | undefined {
	if (keyFields.length === 0) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(key);
	} catch {
		return undefined;
	}
	if (!Array.isArray(parsed) || parsed.length !== keyFields.length) return undefined;
	const keyValues: Record<string, string> = {};
	for (const [index, field] of keyFields.entries()) {
		const value = parsed[index];
		if (typeof value !== 'string' && typeof value !== 'number') return undefined;
		keyValues[field] = String(value);
	}
	return keyValues;
}

/**
 * An on-disk key put through the decoder and back through the encoder, so two
 * keys are compared on one canonical form rather than on raw bytes.
 *
 * This is what makes `'["u1", "t1"]'` (a hand-edited store with a space) and
 * `'["u1","t1"]'` one key, and what makes a numeric `["u1",9]` on disk match a
 * `{ todoId: '9' }` the browser sent back. Returns `undefined` when the key does
 * not decode under this schema, which correctly means "never matches".
 */
export function canonicalizePairKey(key: string, keyFields: string[]): string | undefined {
	const decoded = resolveSerializedKey(key, keyFields);
	if (decoded === undefined) return undefined;
	return serializePairKey(decoded, keyFields);
}
