// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the shared PostgreSQL error translator (used by PgClientEngine
 * and PGliteEngine). Focus: an OCC / serialization-failure conflict (SQLSTATE
 * 40001) must surface as an ApiError with HTTP status 409 (Conflict), not a
 * generic 500, while preserving the SerializationFailure name and flagging the
 * conflict retriable.
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { ApiError } from '@aws-blocks/core';
import { translatePgError } from './pg-error-translator.js';
import { DatabaseErrors } from '../errors.js';

test('translatePgError: serialization failure (40001) → ApiError status 409, retriable', () => {
  const err = Object.assign(new Error('could not serialize access due to read/write dependencies'), { code: '40001' });
  assert.throws(
    () => translatePgError(err, 'PgClientEngine'),
    (e: unknown) => {
      assert.ok(e instanceof ApiError, 'expected an ApiError');
      assert.strictEqual(e.status, 409);
      assert.strictEqual(e.name, DatabaseErrors.SerializationFailure);
      assert.strictEqual(e.retriable, true);
      return true;
    },
  );
});

test('translatePgError: unique violation (23505) → UniqueConstraintViolation (unchanged, non-ApiError)', () => {
  const err = Object.assign(new Error('duplicate key'), { code: '23505' });
  assert.throws(
    () => translatePgError(err, 'PgClientEngine'),
    (e: unknown) => {
      assert.ok(e instanceof Error);
      assert.strictEqual((e as Error).name, DatabaseErrors.UniqueConstraintViolation);
      assert.ok(!(e instanceof ApiError), 'unique violation should not be remapped to an ApiError');
      return true;
    },
  );
});
