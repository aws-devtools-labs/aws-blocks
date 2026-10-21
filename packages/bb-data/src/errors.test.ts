// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert';
import { ApiError, isWireSafeError, isBlocksError } from '@aws-blocks/core';
import { DatabaseErrors, wrapError, serializationConflict } from './errors.js';

test('serializationConflict builds a 409 ApiError preserving name + retriable', () => {
  const cause = Object.assign(new Error('could not serialize access due to read/write dependencies'), { code: '40001' });
  const e = serializationConflict(cause);
  assert.ok(e instanceof ApiError, 'expected an ApiError');
  assert.strictEqual(e.status, 409);
  assert.strictEqual(e.name, DatabaseErrors.SerializationFailure);
  assert.strictEqual(e.retriable, true);
  assert.strictEqual(e.message, 'The transaction failed due to a serialization conflict');
  assert.strictEqual((e.cause as Error).message, 'could not serialize access due to read/write dependencies');
});

test('DatabaseErrors has all expected keys', () => {
  assert.strictEqual(DatabaseErrors.QueryFailed, 'QueryFailedException');
  assert.strictEqual(DatabaseErrors.ConnectionFailed, 'ConnectionFailedException');
  assert.strictEqual(DatabaseErrors.TransactionFailed, 'TransactionFailedException');
  assert.strictEqual(DatabaseErrors.UniqueConstraintViolation, 'UniqueConstraintViolationException');
});

test('wrapError preserves a known DatabaseErrors name, brands it, and keeps the raw error as cause', () => {
  const original = new Error('duplicate key value violates unique constraint "users_pkey"');
  original.name = DatabaseErrors.UniqueConstraintViolation;

  assert.throws(
    () => wrapError(original),
    (err: Error) => {
      // Name is preserved and matchable on the client via isBlocksError.
      assert.strictEqual(err.name, DatabaseErrors.UniqueConstraintViolation);
      assert.ok(isBlocksError(err, DatabaseErrors.UniqueConstraintViolation));
      // Branded so the name crosses the RPC wire (D-003).
      assert.ok(isWireSafeError(err), 'expected the re-tagged error to be branded');
      // The client-facing message is the stable BB string, NOT the raw driver text.
      assert.strictEqual(err.message, `${DatabaseErrors.UniqueConstraintViolation}: The item violates a unique constraint`);
      assert.ok(!err.message.includes('users_pkey'), 'raw driver text must not leak into the message');
      // The original driver error is retained server-side as cause.
      assert.strictEqual((err.cause as Error).message, 'duplicate key value violates unique constraint "users_pkey"');
      return true;
    }
  );
});

test('wrapError sets unknown error names to QueryFailed with a stable branded message', () => {
  const original = new Error('ERROR: relation "todos" does not exist at character 15');
  original.name = 'SomeRandomError';

  assert.throws(
    () => wrapError(original),
    (err: Error) => {
      assert.strictEqual(err.name, DatabaseErrors.QueryFailed);
      assert.ok(isWireSafeError(err));
      assert.strictEqual(err.message, `${DatabaseErrors.QueryFailed}: The database query failed`);
      assert.ok(!err.message.includes('relation'), 'raw driver text must not leak into the message');
      assert.strictEqual((err.cause as Error).message, 'ERROR: relation "todos" does not exist at character 15');
      return true;
    }
  );
});

test('wrapError converts non-Error values to a branded QueryFailed error', () => {
  assert.throws(
    () => wrapError('a string error'),
    (err: Error) => {
      assert.strictEqual(err.name, DatabaseErrors.QueryFailed);
      assert.ok(isWireSafeError(err));
      assert.strictEqual(err.message, `${DatabaseErrors.QueryFailed}: The database query failed`);
      // The stringified original is retained as cause.
      assert.strictEqual((err.cause as Error).message, 'a string error');
      return true;
    }
  );
});

test('wrapError always throws', () => {
  assert.throws(() => wrapError(new Error('test')));
});
