// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert';
import type { CloudFormationCustomResourceDeleteEvent } from 'aws-lambda';
import { isRetryableMigrationError, withRetry } from './migration-lambda.js';
import { DataApiEngine } from './engines/data-api-engine.js';

// The handler's Delete branch is exercised directly; the retry helper and its
// error predicate are exported and tested below.

test('migration handler returns early on Delete event', async () => {
  const { handler } = await import('./migration-lambda.js');
  // Only the fields the Delete branch reads. A Partial<…> cast keeps these
  // fields type-checked while omitting the rest of the CFN event shape.
  const event: Partial<CloudFormationCustomResourceDeleteEvent> = {
    RequestType: 'Delete',
    PhysicalResourceId: 'migrations-abc',
  };
  const result = await handler(event as CloudFormationCustomResourceDeleteEvent);
  assert.strictEqual(result.PhysicalResourceId, 'migrations-abc');
});

// --- Retry classification (issue #450) ---
//
// A scale-to-zero cluster (`minCapacity: 0`) auto-pauses after ~5 minutes idle,
// and the first Data API call of a deploy fails while it resumes. These tests
// feed `isRetryableMigrationError` the error *as the engine actually throws it*
// — DataApiEngine rewrites `error.name` on the way out, so asserting against a
// raw SDK error would not reproduce what the Lambda sees.

/** Run a statement against a stub Data API client and return the thrown error. */
const errorFromEngine = async (name: string, message: string): Promise<unknown> => {
  const engine = new DataApiEngine({
    resourceArn: 'arn:cluster',
    secretArn: 'arn:secret',
    database: 'testdb',
    client: {
      send() {
        const err = new Error(message);
        err.name = name;
        return Promise.reject(err);
      },
    } as unknown as ConstructorParameters<typeof DataApiEngine>[0]['client'],
  });
  return engine.execute('CREATE TABLE IF NOT EXISTS _migrations (id SERIAL PRIMARY KEY)')
    .then(() => { throw new Error('expected the statement to fail'); }, (e: unknown) => e);
};

const RESUMING_MESSAGE =
  'The Aurora DB instance db-XXXXXXXXXXXXXXXXXXXXXXXXXX is resuming after being auto-paused. Please wait a few seconds and try again.';

test('auto-pause resume error is retryable', async () => {
  const e = await errorFromEngine('DatabaseResumingException', RESUMING_MESSAGE);
  assert.strictEqual(isRetryableMigrationError(e), true);
});

test('writer-not-ready error is retryable', async () => {
  const e = await errorFromEngine('BadRequestException', 'Communications link failure');
  assert.strictEqual(isRetryableMigrationError(e), true);
});

test('a genuine SQL error is not retryable', async () => {
  const e = await errorFromEngine('DatabaseErrorException', 'ERROR: syntax error at or near "CREAT"; SQLState: 42601');
  assert.strictEqual(isRetryableMigrationError(e), false);
});

test('a transient connection failure is retryable', async () => {
  // SQLState 08xxx -> ConnectionFailed. Deliberately in scope: a connection
  // failure mid-deploy is what the backoff exists for. The trade is that a
  // genuinely unreachable database takes ~2 minutes to fail the deploy instead
  // of failing immediately.
  const e = await errorFromEngine('DatabaseErrorException', 'ERROR: connection failure; SQLState: 08006');
  assert.strictEqual(isRetryableMigrationError(e), true);
});

test('raw SDK error names are retryable without the engine', async () => {
  // Defense for a caller that does not route through DataApiEngine, which
  // rewrites error.name. Nothing does today; this documents the intent.
  // The transient names come from the same set the engine classifies with, so
  // the two sites cannot drift apart.
  const resuming = Object.assign(new Error(RESUMING_MESSAGE), { name: 'DatabaseResumingException' });
  const unavailable = Object.assign(new Error('Service unavailable'), { name: 'ServiceUnavailableException' });
  const internal = Object.assign(new Error('Internal error'), { name: 'InternalServerErrorException' });
  const badRequest = Object.assign(new Error('Bad request'), { name: 'BadRequestException' });
  assert.strictEqual(isRetryableMigrationError(resuming), true);
  assert.strictEqual(isRetryableMigrationError(unavailable), true);
  assert.strictEqual(isRetryableMigrationError(internal), true);
  assert.strictEqual(isRetryableMigrationError(badRequest), true);
});

test('a non-retryable error fails immediately without retrying', async () => {
  const e = await errorFromEngine('DatabaseErrorException', 'ERROR: syntax error at or near "CREAT"; SQLState: 42601');
  let attempts = 0;
  await assert.rejects(
    () => withRetry(async () => {
      attempts++;
      throw e;
    }),
    // Identity, not just the name: the original error has to reach the caller
    // unwrapped so CloudFormation surfaces the real SQL error.
    (err: unknown) => err === e,
  );
  assert.strictEqual(attempts, 1);
});

test('withRetry retries an auto-pause resume error until the cluster is awake', async () => {
  const e = await errorFromEngine('DatabaseResumingException', RESUMING_MESSAGE);
  let attempts = 0;
  const result = await withRetry(async () => {
    attempts++;
    if (attempts === 1) throw e;
    return 'migrated';
  });
  assert.strictEqual(result, 'migrated');
  assert.strictEqual(attempts, 2);
});
