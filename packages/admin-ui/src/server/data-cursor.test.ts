// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { describe, it } from 'node:test';

import {
	DEFAULT_PAGE_LIMIT,
	type DataCursor,
	InvalidCursorError,
	MAX_PAGE_LIMIT,
	decodeCursor,
	encodeCursor,
	resolvePageLimit,
} from './data-cursor.js';

describe('cursor round-trip', () => {
	it('round-trips an offset cursor', () => {
		const cursor: DataCursor = { kind: 'offset', store: 'my-app-todos', offset: 100 };
		assert.deepStrictEqual(decodeCursor(encodeCursor(cursor), 'my-app-todos'), cursor);
	});

	it('round-trips a DynamoDB cursor, preserving the key item', () => {
		const cursor: DataCursor = {
			kind: 'dynamodb',
			store: 'stack-todos',
			lastKey: { userId: 'u1', todoId: 't9' },
		};
		assert.deepStrictEqual(decodeCursor(encodeCursor(cursor), 'stack-todos'), cursor);
	});

	it('round-trips a Cognito cursor', () => {
		const cursor: DataCursor = { kind: 'cognito', store: 'us-east-1_AbCd', token: 'opaque-aws-token' };
		assert.deepStrictEqual(decodeCursor(encodeCursor(cursor), 'us-east-1_AbCd'), cursor);
	});

	it('encodes to a URL-safe token', () => {
		const token = encodeCursor({ kind: 'offset', store: 'a/b+c', offset: 1 });
		assert.match(token, /^[A-Za-z0-9_-]+$/, token);
		assert.ok(!token.includes('='), 'base64url is unpadded');
	});
});

describe('cursor store binding', () => {
	it('rejects a cursor minted for a different store', () => {
		const token = encodeCursor({ kind: 'offset', store: 'store-a', offset: 10 });
		assert.throws(
			() => decodeCursor(token, 'store-b'),
			(error: unknown) => {
				assert.ok(error instanceof InvalidCursorError);
				// The message has to name both stores, or the user cannot tell what happened.
				assert.match(error.message, /store-a/);
				assert.match(error.message, /store-b/);
				return true;
			},
		);
	});

	it('accepts a cursor for its own store', () => {
		const token = encodeCursor({ kind: 'cognito', store: 'pool-1', token: 't' });
		assert.doesNotThrow(() => decodeCursor(token, 'pool-1'));
	});
});

describe('cursor rejection', () => {
	const store = 'my-store';

	it('rejects a non-base64 token', () => {
		assert.throws(() => decodeCursor('!!!not base64!!!', store), InvalidCursorError);
	});

	it('rejects a token that is not JSON', () => {
		assert.throws(
			() => decodeCursor(Buffer.from('nope', 'utf-8').toString('base64url'), store),
			InvalidCursorError,
		);
	});

	it('rejects JSON that is not an object', () => {
		assert.throws(() => decodeCursor(Buffer.from('42', 'utf-8').toString('base64url'), store), InvalidCursorError);
		assert.throws(
			() => decodeCursor(Buffer.from('null', 'utf-8').toString('base64url'), store),
			InvalidCursorError,
		);
	});

	it('rejects a missing or empty store', () => {
		const noStore = Buffer.from(JSON.stringify({ kind: 'offset', offset: 0 }), 'utf-8').toString('base64url');
		assert.throws(() => decodeCursor(noStore, store), /missing its store/);
	});

	it('rejects an unknown cursor kind', () => {
		const bad = Buffer.from(JSON.stringify({ kind: 'telepathy', store }), 'utf-8').toString('base64url');
		assert.throws(() => decodeCursor(bad, store), /Unknown cursor kind: telepathy/);
	});

	it('rejects a negative, fractional or non-numeric offset', () => {
		for (const offset of [-1, 1.5, '10', null]) {
			const bad = Buffer.from(JSON.stringify({ kind: 'offset', store, offset }), 'utf-8').toString('base64url');
			assert.throws(() => decodeCursor(bad, store), /offset/, `offset ${String(offset)} should be rejected`);
		}
	});

	it('rejects a DynamoDB cursor whose key is absent or not an object', () => {
		for (const lastKey of [undefined, null, 'k', ['k']]) {
			const bad = Buffer.from(JSON.stringify({ kind: 'dynamodb', store, lastKey }), 'utf-8').toString(
				'base64url',
			);
			assert.throws(() => decodeCursor(bad, store), /DynamoDB key/);
		}
	});

	it('rejects a Cognito cursor with an absent or empty token', () => {
		for (const token of [undefined, '', 42]) {
			const bad = Buffer.from(JSON.stringify({ kind: 'cognito', store, token }), 'utf-8').toString('base64url');
			assert.throws(() => decodeCursor(bad, store), /pagination token/);
		}
	});
});

describe('resolvePageLimit', () => {
	it('defaults when the limit is absent or unusable', () => {
		assert.strictEqual(resolvePageLimit(undefined), DEFAULT_PAGE_LIMIT);
		assert.strictEqual(resolvePageLimit(Number.NaN), DEFAULT_PAGE_LIMIT);
		assert.strictEqual(resolvePageLimit(0), DEFAULT_PAGE_LIMIT);
		assert.strictEqual(resolvePageLimit(-5), DEFAULT_PAGE_LIMIT);
	});

	it('honours a usable limit and floors a fractional one', () => {
		assert.strictEqual(resolvePageLimit(10), 10);
		assert.strictEqual(resolvePageLimit(10.9), 10);
	});

	it('clamps to the maximum, so a caller cannot ask for an unbounded scan', () => {
		assert.strictEqual(resolvePageLimit(MAX_PAGE_LIMIT + 1), MAX_PAGE_LIMIT);
		assert.strictEqual(resolvePageLimit(1_000_000), MAX_PAGE_LIMIT);
	});
});
