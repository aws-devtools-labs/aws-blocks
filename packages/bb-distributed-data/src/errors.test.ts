// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for DSQL error translation.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError } from '@aws-blocks/core';
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
      assert.equal(e.message, 'conflict');
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
      assert.equal(e.message, 'conflict');
      return true;
    }
  );
});

test('translateDsqlError: unique violation (23505) → UniqueConstraintViolation', () => {
  const err = Object.assign(new Error('duplicate key'), { code: PG_UNIQUE_VIOLATION });
  assert.throws(
    () => translateDsqlError(err),
    (e: Error) => {
      assert.equal(e.name, DistributedDatabaseErrors.UniqueConstraintViolation);
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

test('translateDsqlError: unknown pg error code → QueryFailed', () => {
  const err = Object.assign(new Error('syntax error'), { code: '42601' });
  assert.throws(
    () => translateDsqlError(err),
    (e: Error) => {
      assert.equal(e.name, DistributedDatabaseErrors.QueryFailed);
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
      assert.equal(e.message, 'something broke');
      return true;
    }
  );
});

test('translateDsqlError: always throws (never returns)', () => {
  assert.throws(() => translateDsqlError(new Error('test')));
});
