// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert';
import { ApiError, isExpectedBlocksError } from './errors.js';

test('isExpectedBlocksError: plain Error is unexpected (keep stack)', () => {
  assert.strictEqual(isExpectedBlocksError(new Error('boom')), false);
});

test('isExpectedBlocksError: native error subclasses are unexpected', () => {
  assert.strictEqual(isExpectedBlocksError(new TypeError('bad type')), false);
  assert.strictEqual(isExpectedBlocksError(new RangeError('out of range')), false);
  assert.strictEqual(isExpectedBlocksError(new ReferenceError('ref')), false);
  assert.strictEqual(isExpectedBlocksError(new SyntaxError('syntax')), false);
});

test('isExpectedBlocksError: *Exception typed errors are expected', () => {
  const e = new Error('not ready');
  e.name = 'KnowledgeBaseNotReadyException';
  assert.strictEqual(isExpectedBlocksError(e), true);
});

test('isExpectedBlocksError: Blocks *Error typed errors are expected', () => {
  const validation = new Error('invalid');
  validation.name = 'KnowledgeBaseValidationError';
  assert.strictEqual(isExpectedBlocksError(validation), true);

  const timeout = new Error('timed out');
  timeout.name = 'HandlerTimeoutError';
  assert.strictEqual(isExpectedBlocksError(timeout), true);
});

test('isExpectedBlocksError: ApiError (wire base class) is expected', () => {
  assert.strictEqual(isExpectedBlocksError(new ApiError('nope', 409)), true);
  assert.strictEqual(
    isExpectedBlocksError(new ApiError('taken', 409, { name: 'ConditionalCheckFailedException' })),
    true,
  );
});

test('isExpectedBlocksError: non-Error values are unexpected', () => {
  assert.strictEqual(isExpectedBlocksError(null), false);
  assert.strictEqual(isExpectedBlocksError(undefined), false);
  assert.strictEqual(isExpectedBlocksError('KnowledgeBaseValidationError'), false);
  assert.strictEqual(isExpectedBlocksError({ name: 'FooException', message: 'x' }), false);
});

test('isExpectedBlocksError: arbitrary non-convention names are unexpected', () => {
  const e = new Error('weird');
  e.name = 'SomethingWeird';
  assert.strictEqual(isExpectedBlocksError(e), false);
});

test('isExpectedBlocksError: empty name is unexpected', () => {
  const e = new Error('blank');
  e.name = '';
  assert.strictEqual(isExpectedBlocksError(e), false);
});
