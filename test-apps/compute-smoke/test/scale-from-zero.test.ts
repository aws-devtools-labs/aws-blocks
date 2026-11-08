// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Scale from zero: an AsyncJob on a container compute with `minInstances: 0`.
 * The service deploys with no running task, so the submitted job completes only
 * if autoscaling starts a task when a message is waiting.
 *
 * Applies to every front door: job traffic doesn't go through it.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert';
import { setTimeout as sleep } from 'node:timers/promises';
import { apiRpc, type ComputeTestContext } from './context.js';

// Waking takes several steps, each on a one-minute cadence or slower: SQS
// publishes queue metrics to CloudWatch every minute, the scaling alarm
// evaluates them, Application Auto Scaling raises the service's desired count,
// and the new Fargate task pulls its image and starts polling.
const WAKE_BUDGET_MS = 900_000;
const POLL_INTERVAL_MS = 10_000;

export function scaleFromZeroTests(ctx: ComputeTestContext) {
  describe('Container compute at zero instances', () => {
    test('a submitted job starts a task and completes', async () => {
      const key = `zero-${Date.now().toString(36)}`;
      const submit = (await apiRpc(ctx, 'scaleFromZeroJobSubmit', key)) as { jobId: string };
      assert.ok(typeof submit.jobId === 'string' && submit.jobId.length > 0, 'submit returns a job id');

      const startedAt = Date.now();
      let result: { runtime: string } | null = null;
      while (Date.now() - startedAt < WAKE_BUDGET_MS) {
        result = (await apiRpc(ctx, 'scaleFromZeroJobGetResult', key)) as { runtime: string } | null;
        if (result) break;
        await sleep(POLL_INTERVAL_MS);
      }
      assert.ok(
        result,
        `the job did not run within ${WAKE_BUDGET_MS / 1000}s: no task was started for the waiting message`,
      );
      assert.strictEqual(result.runtime, 'container', 'the job ran on the container runtime');
      console.log(`  scale from zero: job completed ${Math.round((Date.now() - startedAt) / 1000)}s after submit`);
    });
  });
}
