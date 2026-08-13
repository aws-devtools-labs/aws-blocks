// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { setTimeout } from 'node:timers/promises';
import type { api as apiType } from 'aws-blocks';

/**
 * SQS event sources are created with maxBatchingWindowSeconds=5, so on real AWS a
 * message can sit in the queue for up to 5s before the handler is invoked. Poll
 * budgets must therefore exceed that window plus submit/DynamoDB overhead.
 */
const BATCHING_WINDOW_MS = 5_000;
const RESULT_POLL_INTERVAL_MS = 100;
const RESULT_POLL_BUDGET_MS = BATCHING_WINDOW_MS + 5_000;
const RESULT_POLL_ATTEMPTS = RESULT_POLL_BUDGET_MS / RESULT_POLL_INTERVAL_MS;

/**
 * Polls `fetch` until it resolves to a truthy value or the attempt budget is spent.
 * Any falsy value counts as "not ready", so callers whose ready state could legitimately
 * be falsy (`0`, `false`, `[]`) must wrap it in a truthy sentinel.
 */
async function pollForResult<T>(
  fetch: () => Promise<T | null>,
  attempts: number = RESULT_POLL_ATTEMPTS
): Promise<T | null> {
  let result: T | null = null;
  for (let i = 0; i < attempts; i++) {
    result = await fetch();
    if (result) break;
    await setTimeout(RESULT_POLL_INTERVAL_MS);
  }
  return result;
}

/**
 * Budget for a delayed job: the delay itself, then the same window + margin allowance as
 * RESULT_POLL_BUDGET_MS. Note the delaySeconds tests only assert non-execution at t~=0,
 * not continuously throughout the delay window.
 */
function delayedPollAttempts(delaySeconds: number): number {
  return (delaySeconds * 1000 + BATCHING_WINDOW_MS + 3_000) / RESULT_POLL_INTERVAL_MS;
}

export function asyncJobTests(getApi: () => typeof apiType) {
  describe('AsyncJob BB', () => {
    test('AsyncJob - submit and verify handler execution', async () => {
      const api = getApi();
      const testId = Date.now().toString(36);
      const { jobId } = await api.asyncJobSubmit(`single-${testId}`, 'hello');
      assert.ok(typeof jobId === 'string');

      const result = await pollForResult(() => api.asyncJobGetResult(`single-${testId}`));

      assert.ok(result, 'handler should have written result');
      assert.strictEqual(result.value, 'hello');
      assert.strictEqual(result.jobId, jobId);
      assert.strictEqual(result.receiveCount, 1);
      assert.ok(result.sentAt);
    });

    test('AsyncJob - submitBatch and verify all handlers execute', async () => {
      const api = getApi();
      const testId = Date.now().toString(36);
      const items = [
        { key: `batch-${testId}-0`, value: 'a' },
        { key: `batch-${testId}-1`, value: 'b' },
        { key: `batch-${testId}-2`, value: 'c' },
      ];

      const { jobIds } = await api.asyncJobSubmitBatch(items);
      assert.strictEqual(jobIds.length, 3);

      await pollForResult(async () => {
        const results = await Promise.all(
          items.map(item => api.asyncJobGetResult(item.key))
        );
        return results.every((r) => r !== null) ? results : null;
      });

      for (const item of items) {
        const result = await api.asyncJobGetResult(item.key);
        assert.ok(result, `handler should have written result for ${item.key}`);
        assert.strictEqual(result.value, item.value);
      }
    });

    test('AsyncJob - submit throws PayloadTooLarge', async () => {
      const api = getApi();
      await assert.rejects(
        () => api.asyncJobSubmitTooLarge(),
        /PayloadTooLargeException/
      );
    });

    test('AsyncJob - submitBatch throws BatchTooLarge', async () => {
      const api = getApi();
      await assert.rejects(
        () => api.asyncJobSubmitBatchTooMany(),
        /BatchTooLargeException/
      );
    });

    // Schema Validation Tests
    test('AsyncJob - submit valid payload with schema', async () => {
      const api = getApi();
      const { jobId } = await api.asyncJobSubmitValidated('alice@example.com', 'Welcome', 'Hello Alice');
      assert.ok(typeof jobId === 'string');

      const result = await pollForResult(() => api.asyncJobGetValidatedResult(jobId));

      assert.ok(result, 'handler should have written result');
      assert.strictEqual(result.to, 'alice@example.com');
      assert.strictEqual(result.subject, 'Welcome');
    });

    test('AsyncJob - submit invalid payload with schema throws ValidationFailed', async () => {
      const api = getApi();
      await assert.rejects(
        () => api.asyncJobSubmitValidated('not-an-email', 'Subject', 'Body'),
        /ValidationFailedException/
      );
    });

    test('AsyncJob - submitBatch with invalid payload in batch throws ValidationFailed', async () => {
      const api = getApi();
      await assert.rejects(
        () => api.asyncJobSubmitValidatedBatch([
          { to: 'alice@example.com', subject: 'Hi', body: 'Hello' },
          { to: 'bad-email', subject: 'Hi', body: 'Hello' },
        ]),
        /ValidationFailedException/
      );
    });

    // delaySeconds Tests
    test('AsyncJob - submit with delaySeconds defers execution', async () => {
      const api = getApi();
      const testId = Date.now().toString(36);
      const key = `delayed-${testId}`;

      await api.asyncJobSubmitDelayed(key, 'delayed-value', 2);

      // Should NOT be written yet
      const immediate = await api.asyncJobGetResult(key);
      assert.strictEqual(immediate, null, 'handler should not have run yet');

      const result = await pollForResult(
        () => api.asyncJobGetResult(key),
        delayedPollAttempts(2)
      );

      assert.ok(result, 'handler should have run after delay');
      assert.strictEqual(result.value, 'delayed-value');
    });

    test('AsyncJob - submitBatch with delaySeconds defers all executions', async () => {
      const api = getApi();
      const testId = Date.now().toString(36);
      const items = [
        { key: `batch-delayed-${testId}-0`, value: 'a' },
        { key: `batch-delayed-${testId}-1`, value: 'b' },
      ];

      await api.asyncJobSubmitBatchDelayed(items, 2);

      // Should NOT be written yet
      for (const item of items) {
        const immediate = await api.asyncJobGetResult(item.key);
        assert.strictEqual(immediate, null, `handler for ${item.key} should not have run yet`);
      }

      for (const item of items) {
        const result = await pollForResult(
          () => api.asyncJobGetResult(item.key),
          delayedPollAttempts(2)
        );
        assert.ok(result, `handler should have run for ${item.key}`);
        assert.strictEqual(result.value, item.value);
      }
    });
  });
}
