// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { describe, it } from 'node:test';

import { canonicalizePairKey, keySchemaFields, resolveSerializedKey, serializePairKey } from './pair-key.js';

const SINGLE = { partitionKey: 'userId' };
const COMPOSITE = { partitionKey: 'userId', sortKey: 'todoId' };

describe('keySchemaFields', () => {
	it('orders partition key first, sort key second', () => {
		assert.deepStrictEqual(keySchemaFields(COMPOSITE), ['userId', 'todoId']);
	});

	it('returns one field for a single-key schema', () => {
		assert.deepStrictEqual(keySchemaFields(SINGLE), ['userId']);
	});

	it('returns nothing without a schema, so callers must handle "no key model"', () => {
		assert.deepStrictEqual(keySchemaFields(undefined), []);
	});
});

describe('serializePairKey', () => {
	it('encodes in key order, not object order', () => {
		// The object deliberately lists the sort key first.
		const key = serializePairKey({ todoId: 't9', userId: 'u1' }, keySchemaFields(COMPOSITE));
		assert.strictEqual(key, '["u1","t9"]');
	});

	it('encodes a single key as a one-element array', () => {
		assert.strictEqual(serializePairKey({ userId: 'u1' }, keySchemaFields(SINGLE)), '["u1"]');
	});

	it('refuses a partial key rather than inventing a null slot', () => {
		// A guessed key names a DIFFERENT record than the user chose, so the only
		// safe answer is no key at all.
		assert.strictEqual(serializePairKey({ userId: 'u1' }, keySchemaFields(COMPOSITE)), undefined);
	});

	it('refuses an empty-string field', () => {
		assert.strictEqual(serializePairKey({ userId: '', todoId: 't9' }, keySchemaFields(COMPOSITE)), undefined);
	});

	it('refuses when there is no key model at all', () => {
		assert.strictEqual(serializePairKey({ userId: 'u1' }, []), undefined);
	});

	it('escapes characters that would otherwise break the key', () => {
		const key = serializePairKey({ userId: 'a"b', todoId: 'c\\d' }, keySchemaFields(COMPOSITE));
		assert.strictEqual(key, '["a\\"b","c\\\\d"]');
		assert.deepStrictEqual(JSON.parse(key ?? ''), ['a"b', 'c\\d']);
	});
});

describe('resolveSerializedKey', () => {
	it('decodes onto named fields', () => {
		assert.deepStrictEqual(resolveSerializedKey('["u1","t9"]', keySchemaFields(COMPOSITE)), {
			userId: 'u1',
			todoId: 't9',
		});
	});

	it('stringifies a numeric sort key, since timestamps are stored as numbers', () => {
		assert.deepStrictEqual(resolveSerializedKey('["u1",1700000000]', keySchemaFields(COMPOSITE)), {
			userId: 'u1',
			todoId: '1700000000',
		});
	});

	it('refuses an arity mismatch rather than half-filling the key', () => {
		assert.strictEqual(resolveSerializedKey('["u1"]', keySchemaFields(COMPOSITE)), undefined);
		assert.strictEqual(resolveSerializedKey('["u1","t9","extra"]', keySchemaFields(COMPOSITE)), undefined);
	});

	it('refuses a non-array, a non-JSON key and a null member', () => {
		for (const key of ['{"userId":"u1"}', 'not json', '"u1"', '[null,"t9"]', '[{"a":1},"t9"]']) {
			assert.strictEqual(resolveSerializedKey(key, keySchemaFields(COMPOSITE)), undefined, key);
		}
	});

	it('refuses when there is no key model', () => {
		assert.strictEqual(resolveSerializedKey('["u1"]', []), undefined);
	});
});

describe('the round trip — the invariant that keeps reader and writer on one record', () => {
	it('encode(decode(key)) is the key, for every canonical key', () => {
		const fields = keySchemaFields(COMPOSITE);
		for (const key of ['["u1","t9"]', '["a\\"b","c\\\\d"]', '["u1","t 9"]', '["ünïcode","🎯"]', '["u1",""]']) {
			const decoded = resolveSerializedKey(key, fields);
			assert.notStrictEqual(decoded, undefined, `decode ${key}`);
			if (decoded === undefined) continue;
			// An empty sort key decodes but cannot re-encode, by design — assert
			// that specific asymmetry rather than pretending it round-trips.
			const expected = decoded.todoId === '' ? undefined : key;
			assert.strictEqual(serializePairKey(decoded, fields), expected, `round trip ${key}`);
		}
	});

	it('decode(encode(values)) is the values', () => {
		const fields = keySchemaFields(COMPOSITE);
		for (const values of [
			{ userId: 'u1', todoId: 't9' },
			{ userId: 'a"b', todoId: 'c\\d' },
			{ userId: 'ünïcode', todoId: '🎯' },
		]) {
			const key = serializePairKey(values, fields);
			assert.notStrictEqual(key, undefined);
			assert.deepStrictEqual(resolveSerializedKey(key ?? '', fields), values);
		}
	});
});

describe('canonicalizePairKey', () => {
	it('makes a hand-edited key with whitespace equal to the canonical one', () => {
		const fields = keySchemaFields(COMPOSITE);
		assert.strictEqual(canonicalizePairKey('["u1", "t9"]', fields), '["u1","t9"]');
	});

	it('makes a numeric on-disk key equal to the string form the browser sends back', () => {
		const fields = keySchemaFields(COMPOSITE);
		// A literal, not another call to the encoder. Comparing two expressions that
		// both run `serializePairKey` means an encoder returning `undefined` for
		// everything would satisfy both sides and the assertion would still pass.
		assert.strictEqual(canonicalizePairKey('["u1",9]', fields), '["u1","9"]');
	});

	it('returns undefined for a key that does not decode, which correctly never matches', () => {
		assert.strictEqual(canonicalizePairKey('["u1"]', keySchemaFields(COMPOSITE)), undefined);
	});
});
