// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { setTimeout } from 'node:timers/promises';
import type { api as apiType } from 'aws-blocks';

const ENV = process.env.BLOCKS_TEST_ENV || 'local';
const isDeployed = ENV === 'sandbox' || ENV === 'production';

const RESULT_POLL_INTERVAL_MS = 100;

/**
 * Wall-clock budget, deliberately not an attempt count: a fixed number of
 * fetch+sleep iterations spends less real time the faster the environment reads,
 * so the effective budget would shrink exactly where it is needed most. Deployed
 * runs pay for the SQS maxBatchingWindowSeconds=5 window, delivery, and a Lambda
 * cold start before the handler even begins.
 */
const RESULT_POLL_BUDGET_MS = isDeployed ? 60_000 : 15_000;

/**
 * Polls `fetch` until it resolves to a truthy value or the wall-clock budget expires.
 * Always fetches at least once. Any falsy value counts as "not ready", so callers whose
 * ready state could legitimately be falsy (`0`, `false`, `[]`) must wrap it in a truthy
 * sentinel.
 */
async function pollForResult<T>(
  fetch: () => Promise<T | null>,
  budgetMs: number = RESULT_POLL_BUDGET_MS
): Promise<T | null> {
  const deadline = Date.now() + budgetMs;
  let result: T | null = null;
  do {
    result = await fetch();
    if (result) break;
    await setTimeout(RESULT_POLL_INTERVAL_MS);
  } while (Date.now() < deadline);
  return result;
}

/**
 * Budget for a delayed job: the delay itself plus the full standard budget. Note the
 * delaySeconds tests only assert non-execution at t~=0, not continuously throughout the
 * delay window.
 */
function delayedPollBudgetMs(delaySeconds: number): number {
  return delaySeconds * 1000 + RESULT_POLL_BUDGET_MS;
}

/** Delay requested by the delaySeconds tests, and the basis for their poll budget. */
const DELAY_SECONDS = 2;

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

      await api.asyncJobSubmitDelayed(key, 'delayed-value', DELAY_SECONDS);

      // Should NOT be written yet
      const immediate = await api.asyncJobGetResult(key);
      assert.strictEqual(immediate, null, 'handler should not have run yet');

      const result = await pollForResult(
        () => api.asyncJobGetResult(key),
        delayedPollBudgetMs(DELAY_SECONDS)
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

      await api.asyncJobSubmitBatchDelayed(items, DELAY_SECONDS);

      // Should NOT be written yet
      for (const item of items) {
        const immediate = await api.asyncJobGetResult(item.key);
        assert.strictEqual(immediate, null, `handler for ${item.key} should not have run yet`);
      }

      for (const item of items) {
        const result = await pollForResult(
          () => api.asyncJobGetResult(item.key),
          delayedPollBudgetMs(DELAY_SECONDS)
        );
        assert.ok(result, `handler should have run for ${item.key}`);
        assert.strictEqual(result.value, item.value);
      }
    });
  });
}
