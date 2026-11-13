// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CloudFormationCustomResourceDeleteEvent } from 'aws-lambda';
import { isTransientConnectionError, withRetry } from './migration-lambda.js';
import { translateDsqlError } from './errors.js';

// --- Retry classification (blocker: DSQL migration back-off) ---
//
// `withRetry` backs off on a transient connection failure so a freshly created
// DSQL cluster that isn't accepting connections yet is retried instead of
// failing the migration custom resource on attempt 1.
//
// `translateDsqlError` re-tags a caught pg driver error into a FRESH branded
// error with a stable BB message and NO `code`, moving the raw driver error to
// `cause`. So `isTransientConnectionError` must read the `code`/`message` it
// classifies on from `cause`, not the surface error. These tests therefore feed
// it errors AS `translateDsqlError` actually throws them (the exact shapes a
// DsqlEngine surfaces), not raw pg errors — the same discipline as bb-data's
// `errorFromEngine` helper.

/**
 * Build a pg-driver-shaped error (optionally carrying a SQLSTATE `code`), run it
 * through the REAL `translateDsqlError`, and return the branded error it throws.
 * This is exactly what a `DsqlEngine` query/execute surfaces to the migration
 * handler, so the predicate is exercised against the real re-tag output.
 */
const errorFromEngine = (message: string, code?: string): unknown => {
  const driverError = code === undefined ? new Error(message) : Object.assign(new Error(message), { code });
  try {
    translateDsqlError(driverError);
  } catch (e) {
    return e;
  }
  throw new Error('expected translateDsqlError to throw');
};

test('migration handler returns early on Delete event', async () => {
  const { handler } = await import('./migration-lambda.js');
  // Only the fields the Delete branch reads. A Partial<…> keeps those fields
  // type-checked while omitting the rest of the CFN event shape.
  const event: Partial<CloudFormationCustomResourceDeleteEvent> = {
    RequestType: 'Delete',
    PhysicalResourceId: 'dsql-migrations-abc',
  };
  const result = await handler(event as CloudFormationCustomResourceDeleteEvent);
  assert.equal(result.PhysicalResourceId, 'dsql-migrations-abc');
});

test('ECONNREFUSED (socket, no SQLSTATE) re-tags to QueryFailed but stays transient via cause', () => {
  // A not-yet-ready DSQL endpoint refuses the TCP connection. pg surfaces a bare
  // socket error with no SQLSTATE, so translateDsqlError re-tags it to QueryFailed
  // with the raw ECONNREFUSED text on `cause`.
  const e = errorFromEngine('connect ECONNREFUSED 127.0.0.1:5432');
  assert.equal((e as Error).name, 'QueryFailedException', 'sanity: re-tagged, raw name gone from the surface');
  assert.equal(isTransientConnectionError(e), true);
});

test('"Connection terminated unexpectedly" (no SQLSTATE) stays transient via cause', () => {
  const e = errorFromEngine('Connection terminated unexpectedly');
  assert.equal((e as Error).name, 'QueryFailedException');
  assert.equal(isTransientConnectionError(e), true);
});

test('SQLSTATE 08006 (connection exception class) stays transient via cause', () => {
  // A class-08 connection exception re-tags to ConnectionFailed; the 08006 code
  // itself lives on `cause` after the re-tag, which is what the predicate reads.
  const e = errorFromEngine('terminating connection due to administrator command', '08006');
  assert.equal((e as Error).name, 'ConnectionFailedException');
  assert.equal(isTransientConnectionError(e), true);
});

test('a genuine SQL error (42601 syntax) is NOT transient', () => {
  // The negative control: a syntax error re-tags to QueryFailed, and neither the
  // surface nor the cause looks like a connection failure, so it must not retry.
  const e = errorFromEngine('syntax error at or near "CREAT"', '42601');
  assert.equal(isTransientConnectionError(e), false);
});

test('a non-Error / nullish value is not transient', () => {
  assert.equal(isTransientConnectionError(undefined), false);
  assert.equal(isTransientConnectionError(null), false);
  assert.equal(isTransientConnectionError('ECONNREFUSED'), false, 'a bare string is not an Error with a cause');
});

test('withRetry rethrows a non-transient error immediately (one call, no backoff)', async () => {
  const e = errorFromEngine('syntax error at or near "CREAT"', '42601');
  let attempts = 0;
  await assert.rejects(
    () => withRetry(async () => {
      attempts++;
      throw e;
    }),
    // Identity, not just the name: the original branded error must reach the
    // caller unwrapped so CloudFormation surfaces the real failure.
    (err: unknown) => err === e,
  );
  assert.equal(attempts, 1);
});

test('withRetry retries a transient connection failure until the cluster accepts connections', async () => {
  const e = errorFromEngine('connect ECONNREFUSED 127.0.0.1:5432');
  let attempts = 0;
  const result = await withRetry(async () => {
    attempts++;
    if (attempts === 1) throw e;
    return 'migrated';
  });
  assert.equal(result, 'migrated');
  assert.equal(attempts, 2);
});
