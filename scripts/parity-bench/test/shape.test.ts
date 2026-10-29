// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Unit tests for the structural comparison (shape and element order).

import { test } from 'node:test';
import assert from 'node:assert';
import { sameIgnoringOrder, shapeDiff, shapeOf } from '../src/core/shape.js';

test('a Date locally and an ISO string deployed is a shape difference at that path', () => {
	const local = shapeOf({ items: [{ id: 'a', when: '<date>' }] });
	const deployed = shapeOf({ items: [{ id: 'b', when: '2026-10-29T10:00:00.000Z' }] });
	assert.deepStrictEqual(shapeDiff(local, deployed), [{ path: '$.items[].when', local: 'date', deployed: 'string' }]);
});

test('a field only one side returns is a shape difference; values alone are not', () => {
	assert.deepStrictEqual(shapeDiff(shapeOf({ a: 1 }), shapeOf({ a: 2, traceId: 'x' })), [
		{ path: '$.traceId', local: 'absent', deployed: 'string' },
	]);
	assert.deepStrictEqual(shapeDiff(shapeOf({ a: 1, b: 'x' }), shapeOf({ b: 'y', a: 9 })), []);
});

test('an empty array matches any element shape; null and object do not match', () => {
	assert.deepStrictEqual(shapeDiff(shapeOf([]), shapeOf([{ a: 1 }])), []);
	assert.deepStrictEqual(shapeDiff(shapeOf({ r: { a: 1 } }), shapeOf({ r: null })), [{ path: '$.r', local: 'object', deployed: 'null' }]);
});

test('recorder placeholders count as their own types', () => {
	assert.deepStrictEqual(shapeOf('<bytes:12>').types, ['bytes']);
	assert.deepStrictEqual(shapeOf('<Channel>').types, ['object:Channel']);
	assert.deepStrictEqual(shapeOf('<redacted:40>').types, ['string']);
	assert.deepStrictEqual(shapeOf('<not a placeholder>').types, ['string']);
});

test('same elements in another order, at any depth', () => {
	assert.ok(sameIgnoringOrder([{ k: [2, 1] }, { k: [3] }], [{ k: [3] }, { k: [1, 2] }]));
	assert.ok(!sameIgnoringOrder([1, 2], [1, 3]));
});
