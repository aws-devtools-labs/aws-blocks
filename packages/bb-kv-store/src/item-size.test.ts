// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Pins the mock's item sizing to DynamoDB's documented rules. Each item has one
 * attribute named `n` (1 byte), so the expected size is 1 plus the value's size.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { dynamoItemSize } from './item-size.js';

const sizeOf = (value: unknown) => dynamoItemSize({ n: value }) - 1;

describe('dynamoItemSize: numbers (1 byte per two significant digits, plus 1)', () => {
	const cases: [string, number, number][] = [
		['zero', 0, 2],
		['negative zero', -0, 2],
		['one digit', 7, 2],
		['two digits', 12, 2],
		['three digits', 123, 3],
		['trailing zeros are not significant', 1_000_000, 2],
		['leading zeros of a fraction are not significant', 0.001, 2],
		['a negative number costs one more byte', -7, 3],
		['a fraction counts every significant digit', 123.456, 4],
		['a large magnitude counts its digits, not its exponent', 1e21, 2],
		['the largest safe integer (16 digits)', Number.MAX_SAFE_INTEGER, 9],
		['a full-precision double (17 digits)', 0.1 + 0.2, 10],
	];
	for (const [name, value, bytes] of cases) {
		test(`${name}: ${value} is ${bytes} bytes`, () => {
			assert.equal(sizeOf(value), bytes);
		});
	}
});

describe('dynamoItemSize: other types', () => {
	test('a string counts its UTF-8 bytes', () => {
		assert.equal(sizeOf('abc'), 3);
		assert.equal(sizeOf('é'), 2);
		assert.equal(sizeOf('\u{1F600}'), 4);
	});

	test('a boolean and null are 1 byte', () => {
		assert.equal(sizeOf(true), 1);
		assert.equal(sizeOf(null), 1);
	});

	test('a list costs 3 bytes plus 1 per element, on top of the elements', () => {
		assert.equal(sizeOf([]), 3);
		assert.equal(sizeOf([1, 2]), 3 + (2 + 1) + (2 + 1));
	});

	test('a map costs 3 bytes plus each name and 1 per member, on top of the members', () => {
		assert.equal(sizeOf({}), 3);
		assert.equal(sizeOf({ a: 1 }), 3 + 1 + 2 + 1);
	});

	test('a set counts its members only', () => {
		assert.equal(sizeOf(new Set(['ab', 'c'])), 3);
	});

	test('attribute names count their UTF-8 bytes', () => {
		assert.equal(dynamoItemSize({ id: 'x', blob: 'yy' }), 2 + 1 + 4 + 2);
	});
});
