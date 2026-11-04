// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { describe, it } from 'node:test';

import type { BlockKeySchema } from '../contract/v1.js';
import {
	MAX_DEPTH,
	MAX_KEY_CHARS,
	MAX_RECORD_BYTES,
	RecordValidationError,
	keyFieldsOf,
	keyOf,
	validateRecord,
} from './record-validate.js';

const SIMPLE: BlockKeySchema = { partitionKey: 'id' };
const COMPOSITE: BlockKeySchema = { partitionKey: 'userId', sortKey: 'todoId' };

/** Asserts a rejection and returns it, so a test can check message and path. */
function rejection(item: unknown, keySchema: BlockKeySchema = SIMPLE): RecordValidationError {
	try {
		validateRecord(item, keySchema);
	} catch (error) {
		assert.ok(error instanceof RecordValidationError, `expected RecordValidationError, got ${String(error)}`);
		return error;
	}
	throw new assert.AssertionError({ message: 'expected validateRecord to throw, but it accepted the record' });
}

describe('a valid record', () => {
	it('accepts a record and narrows it to a string-keyed object', () => {
		const item: unknown = { id: 'a1', title: 'Buy milk', done: false, qty: 3, note: null };
		validateRecord(item, SIMPLE);
		// Narrowed by the assertion signature: indexing would not compile on `unknown`.
		assert.strictEqual(item.title, 'Buy milk');
		assert.strictEqual(item.done, false);
	});

	it('accepts nested arrays and objects', () => {
		const item: unknown = {
			id: 'a1',
			items: [{ qty: 1 }, { qty: 2 }],
			tags: ['a', 'b'],
			meta: { nested: { ok: true } },
		};
		validateRecord(item, SIMPLE);
		assert.ok(Array.isArray(item.items));
	});

	it('accepts a composite-key record', () => {
		const item: unknown = { userId: 'u1', todoId: 't9', title: 'x' };
		validateRecord(item, COMPOSITE);
		assert.strictEqual(item.todoId, 't9');
	});

	it('accepts an empty array and an empty object as values', () => {
		validateRecord({ id: 'a1', list: [], obj: {} }, SIMPLE);
	});

	it('accepts nesting exactly at the depth limit', () => {
		// Root is depth 0 and `record.deep` is depth 1, so MAX_DEPTH - 1 arrays below it
		// puts the leaf at exactly MAX_DEPTH — the deepest legal record.
		let value: unknown = 'leaf';
		for (let i = 0; i < MAX_DEPTH - 1; i += 1) {
			value = [value];
		}
		validateRecord({ id: 'a1', deep: value }, SIMPLE);
	});

	it('does not mutate the record it validates', () => {
		const item = { id: 'a1', n: 1 };
		validateRecord(item, SIMPLE);
		assert.deepStrictEqual(item, { id: 'a1', n: 1 });
	});
});

describe('shape rejection', () => {
	it('rejects null', () => {
		const error = rejection(null);
		assert.match(error.message, /record is null/i);
		assert.strictEqual(error.path, 'record');
	});

	it('rejects an array', () => {
		const error = rejection([{ id: 'a1' }]);
		assert.match(error.message, /is an array/i);
		assert.strictEqual(error.path, 'record');
	});

	it('rejects a primitive', () => {
		assert.match(rejection('a string').message, /is a string/i);
		assert.match(rejection(42).message, /is a number/i);
		assert.match(rejection(undefined).message, /is a undefined/i);
	});

	it('rejects a class instance', () => {
		class Todo {
			id = 'a1';
		}
		const error = rejection(new Todo());
		assert.match(error.message, /Todo/);
		assert.match(error.message, /not a plain JSON object/i);
		assert.strictEqual(error.path, 'record');
	});

	it('rejects a Date as the record itself', () => {
		assert.match(rejection(new Date()).message, /Date/);
	});
});

describe('key-field rejection', () => {
	it('rejects a missing key field', () => {
		const error = rejection({ title: 'no id here' });
		assert.match(error.message, /Key field 'id' is missing/);
		assert.strictEqual(error.path, 'record.id');
	});

	it('rejects an empty key field', () => {
		const error = rejection({ id: '' });
		assert.match(error.message, /Key field 'id' is empty/);
		assert.strictEqual(error.path, 'record.id');
	});

	it('rejects a non-string key field', () => {
		const error = rejection({ id: 7 });
		assert.match(error.message, /Key field 'id' is a number/);
		assert.strictEqual(error.path, 'record.id');
	});

	it('rejects a null key field', () => {
		assert.match(rejection({ id: null }).message, /Key field 'id' is a null/);
	});

	it('rejects an over-long key field', () => {
		const error = rejection({ id: 'x'.repeat(MAX_KEY_CHARS + 1) });
		assert.match(error.message, new RegExp(`${MAX_KEY_CHARS}-character limit`));
		assert.strictEqual(error.path, 'record.id');
	});

	it('accepts a key field exactly at the limit', () => {
		validateRecord({ id: 'x'.repeat(MAX_KEY_CHARS) }, SIMPLE);
	});

	it('rejects a missing sort key on a composite schema', () => {
		const error = rejection({ userId: 'u1' }, COMPOSITE);
		assert.match(error.message, /Key field 'todoId' is missing/);
		assert.strictEqual(error.path, 'record.todoId');
	});

	it('reports the key field before the size problem', () => {
		// Both wrong: the key check runs first, so that is the message the user sees.
		const error = rejection({ blob: 'x'.repeat(MAX_RECORD_BYTES + 10) });
		assert.match(error.message, /Key field 'id' is missing/);
	});
});

describe('size rejection', () => {
	it('rejects a record over the byte cap', () => {
		const error = rejection({ id: 'a1', blob: 'x'.repeat(MAX_RECORD_BYTES) });
		assert.match(error.message, /bytes serialized/);
		assert.match(error.message, new RegExp(`${MAX_RECORD_BYTES}-byte limit`));
		assert.match(error.message, /400 KB item limit/);
		assert.strictEqual(error.path, 'record');
	});

	it('measures BYTES, not characters, so a multi-byte record is measured honestly', () => {
		// Each '\u00e9' is 1 JS character but 2 UTF-8 bytes: just over half the cap in
		// characters, and just over the cap in bytes. A `.length` check would accept it.
		const chars = Math.floor(MAX_RECORD_BYTES * 0.7);
		const item = { id: 'a1', text: 'é'.repeat(chars) };
		assert.ok(JSON.stringify(item).length < MAX_RECORD_BYTES, 'under the cap counted as characters');
		assert.ok(Buffer.byteLength(JSON.stringify(item), 'utf-8') > MAX_RECORD_BYTES, 'over the cap counted as bytes');
		const error = rejection(item);
		assert.match(error.message, new RegExp(`${MAX_RECORD_BYTES}-byte limit`));
	});

	it('accepts a record just under the cap', () => {
		const overhead = Buffer.byteLength(JSON.stringify({ id: 'a1', blob: '' }), 'utf-8');
		validateRecord({ id: 'a1', blob: 'x'.repeat(MAX_RECORD_BYTES - overhead) }, SIMPLE);
	});
});

describe('depth rejection', () => {
	it('rejects nesting one level past the limit', () => {
		// One array more than the accepted case above puts the leaf at MAX_DEPTH + 1.
		let value: unknown = 'leaf';
		for (let i = 0; i < MAX_DEPTH; i += 1) {
			value = [value];
		}
		const error = rejection({ id: 'a1', deep: value });
		assert.match(error.message, new RegExp(`more than ${MAX_DEPTH} levels deep`));
		assert.ok(error.path?.startsWith('record.deep'), `path names the offending branch: ${error.path}`);
	});

	it('rejects 100KB of nested arrays as a validation error, not a RangeError', () => {
		// `[[[[…]]]]` around 50k deep: passes the byte cap, and blows the call stack
		// in an unguarded recursive walk. Built programmatically.
		const depth = 50_000;
		let value: unknown = 0;
		for (let i = 0; i < depth; i += 1) {
			value = [value];
		}
		const item = { id: 'a1', deep: value };
		const error = rejection(item);
		assert.ok(error instanceof RecordValidationError, 'an ordinary validation error');
		assert.ok(!(error instanceof RangeError), 'not a RangeError escaping as a 500');
		assert.match(error.message, new RegExp(`more than ${MAX_DEPTH} levels deep`));
	});

	it('rejects deeply nested objects too', () => {
		let value: Record<string, unknown> = { leaf: true };
		for (let i = 0; i < MAX_DEPTH + 5; i += 1) {
			value = { child: value };
		}
		assert.match(rejection({ id: 'a1', deep: value }).message, /levels deep/);
	});

	it('rejects a circular record as a depth problem rather than crashing', () => {
		const item: Record<string, unknown> = { id: 'a1' };
		item.self = item;
		const error = rejection(item);
		assert.match(error.message, new RegExp(`more than ${MAX_DEPTH} levels deep`));
	});
});

describe('JSON-safety rejection', () => {
	it('rejects a non-finite number, naming the path', () => {
		const error = rejection({ id: 'a1', qty: Number.NaN });
		assert.match(error.message, /NaN/);
		assert.strictEqual(error.path, 'record.qty');
	});

	it('rejects Infinity', () => {
		assert.match(rejection({ id: 'a1', ratio: Number.POSITIVE_INFINITY }).message, /Infinity/);
	});

	it('rejects undefined, naming the path', () => {
		const error = rejection({ id: 'a1', title: undefined });
		assert.match(error.message, /is undefined/);
		assert.strictEqual(error.path, 'record.title');
	});

	it('rejects a bigint, naming the path', () => {
		const error = rejection({ id: 'a1', count: 10n });
		assert.match(error.message, /bigint/);
		assert.strictEqual(error.path, 'record.count');
	});

	it('rejects a function, naming the path', () => {
		const error = rejection({ id: 'a1', run: () => 1 });
		assert.match(error.message, /function/);
		assert.strictEqual(error.path, 'record.run');
	});

	it('rejects a symbol, naming the path', () => {
		const error = rejection({ id: 'a1', tag: Symbol('x') });
		assert.match(error.message, /symbol/);
		assert.strictEqual(error.path, 'record.tag');
	});

	it('names the precise path inside nested arrays and objects', () => {
		const error = rejection({ id: 'a1', items: [{ qty: 1 }, { qty: 2 }, { qty: 3 }, { qty: Number.NaN }] });
		assert.strictEqual(error.path, 'record.items[3].qty');
		assert.match(error.message, /^record\.items\[3\]\.qty /);
	});

	it('names the path of a bad value inside a nested object', () => {
		const error = rejection({ id: 'a1', meta: { audit: { at: undefined } } });
		assert.strictEqual(error.path, 'record.meta.audit.at');
	});
});

describe('unsupported DynamoDB attribute types', () => {
	it('rejects a Set, naming the type', () => {
		const error = rejection({ id: 'a1', tags: new Set(['a', 'b']) });
		assert.match(error.message, /is a Set/);
		assert.match(error.message, /DynamoDB attribute/);
		assert.strictEqual(error.path, 'record.tags');
	});

	it('rejects a Map, naming the type', () => {
		const error = rejection({ id: 'a1', index: new Map([['a', 1]]) });
		assert.match(error.message, /is a Map/);
		assert.strictEqual(error.path, 'record.index');
	});

	it('rejects a Buffer, naming Buffer rather than Uint8Array', () => {
		const error = rejection({ id: 'a1', blob: Buffer.from('hi') });
		assert.match(error.message, /is a Buffer/);
		assert.strictEqual(error.path, 'record.blob');
	});

	it('rejects a Uint8Array, naming the type', () => {
		const error = rejection({ id: 'a1', bytes: new Uint8Array([1, 2, 3]) });
		assert.match(error.message, /is a Uint8Array/);
		assert.strictEqual(error.path, 'record.bytes');
	});

	it('rejects a Date, naming the type', () => {
		const error = rejection({ id: 'a1', createdAt: new Date('2024-01-01T00:00:00Z') });
		assert.match(error.message, /is a Date/);
		assert.strictEqual(error.path, 'record.createdAt');
	});

	it('rejects an unsupported type nested inside an array', () => {
		const error = rejection({ id: 'a1', rows: [{ ok: true }, { tags: new Set(['x']) }] });
		assert.strictEqual(error.path, 'record.rows[1].tags');
		assert.match(error.message, /is a Set/);
	});

	it('rejects an arbitrary class instance as a value', () => {
		class Point {
			x = 1;
		}
		const error = rejection({ id: 'a1', at: new Point() });
		assert.match(error.message, /Point/);
		assert.strictEqual(error.path, 'record.at');
	});
});

describe('reserved property names', () => {
	it("rejects an own '__proto__' property", () => {
		// An object literal would set the prototype; JSON.parse creates an own property,
		// which is exactly how such a record reaches us.
		const item = JSON.parse('{"id":"a1","__proto__":{"admin":true}}');
		const error = rejection(item);
		assert.match(error.message, /__proto__/);
		assert.strictEqual(error.path, 'record.__proto__');
	});

	it("rejects an own 'constructor' property", () => {
		const error = rejection({ id: 'a1', constructor: 'nope' });
		assert.match(error.message, /constructor/);
		assert.strictEqual(error.path, 'record.constructor');
	});

	it('rejects a reserved name nested deep in the record', () => {
		const item = JSON.parse('{"id":"a1","meta":{"inner":{"__proto__":1}}}');
		const error = rejection(item);
		assert.strictEqual(error.path, 'record.meta.inner.__proto__');
	});

	it('explains why, since the record is re-parsed from a local JSON file', () => {
		assert.match(rejection({ id: 'a1', constructor: 1 }).message, /local JSON file/);
	});
});

describe('keyFieldsOf', () => {
	it('returns one field for a simple schema', () => {
		assert.deepStrictEqual(keyFieldsOf(SIMPLE), ['id']);
	});

	it('returns partition key first for a composite schema', () => {
		assert.deepStrictEqual(keyFieldsOf(COMPOSITE), ['userId', 'todoId']);
	});

	it('returns a fresh array each call', () => {
		const first = keyFieldsOf(COMPOSITE);
		first.push('mutated');
		assert.deepStrictEqual(keyFieldsOf(COMPOSITE), ['userId', 'todoId']);
	});
});

describe('keyOf', () => {
	it('extracts a simple key', () => {
		assert.deepStrictEqual(keyOf({ id: 'a1', title: 'x' }, SIMPLE), { id: 'a1' });
	});

	it('extracts a composite key and nothing else', () => {
		const key = keyOf({ userId: 'u1', todoId: 't9', title: 'x', done: false }, COMPOSITE);
		assert.deepStrictEqual(key, { userId: 'u1', todoId: 't9' });
	});

	it('rejects a record whose key field is missing', () => {
		assert.throws(
			() => keyOf({ title: 'x' }, SIMPLE),
			(error: unknown) => {
				assert.ok(error instanceof RecordValidationError);
				assert.strictEqual(error.path, 'record.id');
				return true;
			},
		);
	});

	it('rejects a record whose key field is empty or not a string', () => {
		assert.throws(() => keyOf({ id: '' }, SIMPLE), RecordValidationError);
		assert.throws(() => keyOf({ id: 7 }, SIMPLE), RecordValidationError);
	});
});
