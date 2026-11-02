// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the shared PostgreSQL error translator (used by PgClientEngine
 * and PGliteEngine). Focus: conflict codes must surface as an ApiError with an
 * HTTP status (409 Conflict), not a generic 500 — an OCC / serialization-failure
 * conflict (SQLSTATE 40001, retriable) and a duplicate-key / unique-constraint
 * violation (SQLSTATE 23505, not retriable) — while preserving the standardized
 * error name so `isBlocksError` keeps matching.
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

test('translatePgError: unique violation (23505) → ApiError status 409, name preserved, not retriable', () => {
  const err = Object.assign(new Error('duplicate key value violates unique constraint "t_pkey"'), { code: '23505' });
  assert.throws(
    () => translatePgError(err, 'PgClientEngine'),
    (e: unknown) => {
      assert.ok(e instanceof ApiError, 'expected an ApiError');
      assert.strictEqual(e.status, 409);
      assert.strictEqual(e.name, DatabaseErrors.UniqueConstraintViolation);
      assert.strictEqual(e.retriable, false, 'a duplicate-key retry fails identically → not retriable');
      // Raw driver error is retained server-side as `cause`, not leaked into the message.
      assert.strictEqual(e.cause, err);
      assert.notStrictEqual(e.message, err.message);
      return true;
    },
  );
});

const REQUEST_ERROR_CASES = [
  { code: '42501', driver: 'new row violates row-level security policy for table "notes"', status: 403, name: DatabaseErrors.PermissionDenied },
  { code: '42501', driver: 'permission denied for table projects', status: 403, name: DatabaseErrors.PermissionDenied },
  { code: '23514', driver: 'new row for relation "projects" violates check constraint "projects_name_check"', status: 400, name: DatabaseErrors.CheckViolation },
  { code: '23502', driver: 'null value in column "name" of relation "projects" violates not-null constraint', status: 400, name: DatabaseErrors.NotNullViolation },
  { code: '23503', driver: 'insert or update on table "notes" violates foreign key constraint "notes_project_id_fkey"', status: 409, name: DatabaseErrors.ForeignKeyViolation },
];

for (const { code, driver, status, name } of REQUEST_ERROR_CASES) {
  test(`translatePgError: request error ${code} (${driver.slice(0, 40)}…) → ${name}, ApiError status ${status}`, () => {
    const err = Object.assign(new Error(driver), { code });
    assert.throws(
      () => translatePgError(err, 'PgClientEngine'),
      (e: unknown) => {
        assert.ok(e instanceof ApiError, 'expected an ApiError');
        assert.strictEqual(e.status, status);
        assert.strictEqual(e.name, name);
        assert.strictEqual(e.retriable, false);
        assert.strictEqual(e.cause, err);
        assert.ok(!e.message.includes(driver), 'driver text must not reach the message');
        return true;
      },
    );
  });
}
