// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for DSQL error translation.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, isWireSafeError } from '@aws-blocks/core';
import {
  translateDsqlError,
  DistributedDatabaseErrors,
  PG_SERIALIZATION_FAILURE,
  PG_UNIQUE_VIOLATION,
  PG_CONNECTION_EXCEPTION_CLASS,
} from './errors.js';

test('translateDsqlError: serialization failure (40001) → ApiError status 409, retriable', () => {
  const err = Object.assign(new Error('conflict'), { code: PG_SERIALIZATION_FAILURE });
  assert.throws(
    () => translateDsqlError(err),
    (e: unknown) => {
      assert.ok(e instanceof ApiError, 'expected an ApiError');
      assert.equal(e.status, 409);
      assert.equal(e.name, DistributedDatabaseErrors.SerializationFailure);
      assert.equal(e.retriable, true);
      assert.equal(e.message, 'The transaction failed due to a serialization conflict');
      assert.equal((e.cause as Error).message, 'conflict');
      return true;
    }
  );
});

test('translateDsqlError: serialization failure (40001) → SerializationFailure', () => {
  const err = Object.assign(new Error('conflict'), { code: PG_SERIALIZATION_FAILURE });
  assert.throws(
    () => translateDsqlError(err),
    (e: Error) => {
      assert.equal(e.name, DistributedDatabaseErrors.SerializationFailure);
      assert.equal(e.message, 'The transaction failed due to a serialization conflict');
      return true;
    }
  );
});

test('translateDsqlError: unique violation (23505) → ApiError status 409, name preserved, not retriable', () => {
  const err = Object.assign(new Error('duplicate key value violates unique constraint "dsql_items_pkey"'), { code: PG_UNIQUE_VIOLATION });
  assert.throws(
    () => translateDsqlError(err),
    (e: unknown) => {
      assert.ok(e instanceof ApiError, 'expected an ApiError');
      assert.equal(e.status, 409);
      assert.equal(e.name, DistributedDatabaseErrors.UniqueConstraintViolation);
      assert.strictEqual(e.retriable, false, 'a duplicate-key retry fails identically → not retriable');
      assert.equal(e.message, 'The item violates a unique constraint');
      // Raw driver error retained server-side as `cause`, not leaked into the message.
      assert.equal(e.cause, err);
      return true;
    }
  );
});

test('translateDsqlError: connection error (08006) → ConnectionFailed', () => {
  const err = Object.assign(new Error('connection refused'), { code: '08006' });
  assert.throws(
    () => translateDsqlError(err),
    (e: Error) => {
      assert.equal(e.name, DistributedDatabaseErrors.ConnectionFailed);
      return true;
    }
  );
});

test('translateDsqlError: connection error (08001) → ConnectionFailed', () => {
  const err = Object.assign(new Error('unable to connect'), { code: '08001' });
  assert.throws(
    () => translateDsqlError(err),
    (e: Error) => {
      assert.equal(e.name, DistributedDatabaseErrors.ConnectionFailed);
      return true;
    }
  );
});

test('translateDsqlError: insufficient privilege (42501) → QueryFailed (not Permission)', () => {
  // On DSQL, SQLSTATE 42501 covers both a genuine grant denial AND the
  // rejection of an unsupported statement (e.g. a FOREIGN KEY / DDL), which
  // cannot be told apart by code alone. It must NOT be re-tagged to Permission
  // — an unsupported FOREIGN KEY is a failed query, not a permission error.
  const err = Object.assign(new Error('permission denied to create foreign key'), { code: '42501' });
  assert.throws(
    () => translateDsqlError(err),
    (e: Error) => {
      assert.equal(e.name, DistributedDatabaseErrors.QueryFailed);
      assert.notEqual(e.name, DistributedDatabaseErrors.Permission);
      assert.ok(isWireSafeError(e), 'expected the re-tagged error to be branded');
      assert.equal(e.message, `${DistributedDatabaseErrors.QueryFailed}: The database query failed`);
      assert.ok(!e.message.includes('foreign key'), 'raw driver text must not leak into the message');
      assert.equal((e.cause as Error).message, 'permission denied to create foreign key');
      return true;
    }
  );
});

test('translateDsqlError: unknown pg error code → QueryFailed', () => {
  const err = Object.assign(new Error('syntax error at or near "SELCT"'), { code: '42601' });
  assert.throws(
    () => translateDsqlError(err),
    (e: Error) => {
      assert.equal(e.name, DistributedDatabaseErrors.QueryFailed);
      assert.ok(isWireSafeError(e), 'expected the re-tagged error to be branded');
      assert.equal(e.message, `${DistributedDatabaseErrors.QueryFailed}: The database query failed`);
      assert.ok(!e.message.includes('SELCT'), 'raw driver text must not leak into the message');
      assert.equal((e.cause as Error).message, 'syntax error at or near "SELCT"');
      return true;
    }
  );
});

test('translateDsqlError: Error without code → QueryFailed', () => {
  const err = new Error('something broke');
  assert.throws(
    () => translateDsqlError(err),
    (e: Error) => {
      assert.equal(e.name, DistributedDatabaseErrors.QueryFailed);
      assert.ok(isWireSafeError(e));
      assert.equal(e.message, `${DistributedDatabaseErrors.QueryFailed}: The database query failed`);
      assert.equal((e.cause as Error).message, 'something broke');
      return true;
    }
  );
});

test('translateDsqlError: always throws (never returns)', () => {
  assert.throws(() => translateDsqlError(new Error('test')));
});
