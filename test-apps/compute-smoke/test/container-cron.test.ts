// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Container `CronJob`: a `rate(1 minute)` CronJob on a `Compute({ type:
 * 'container' })`. EventBridge Scheduler sends each tick to the CronJob's
 * internal AsyncJob queue, the container's poller picks it up, and the handler
 * runs in a worker thread on the container.
 *
 * Applies to every front door: tick traffic doesn't go through it.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert';
import { setTimeout as sleep } from 'node:timers/promises';
import { apiRpc, type ComputeTestContext } from './context.js';

// The first tick lands up to a minute after the schedule is created, and the
// container may still be cold-starting then (see container-jobs.test.ts).
const TICK_BUDGET_MS = 300_000;
const POLL_INTERVAL_MS = 5_000;

interface CronTick {
  marker: string;
  jobName: string;
  scheduledTime: string;
  runtime: string;
}

export function containerCronTests(ctx: ComputeTestContext) {
  describe('Container CronJob', () => {
    test('a scheduled tick runs on the container with the CronJob event', async () => {
      const deadline = Date.now() + TICK_BUDGET_MS;
      let tick: CronTick | null = null;
      while (Date.now() < deadline) {
        tick = (await apiRpc(ctx, 'containerCronGetLast')) as CronTick | null;
        if (tick) break;
        await sleep(POLL_INTERVAL_MS);
      }
      assert.ok(tick, `no CronJob tick recorded within ${TICK_BUDGET_MS / 1000}s`);
      assert.strictEqual(tick.runtime, 'container', 'the tick ran on the container runtime');
      assert.strictEqual(tick.marker, 'from-container-cron', 'the static input reached the handler');
      assert.match(tick.jobName, /container-cron$/, 'jobName is the CronJob fullId');
      assert.ok(!Number.isNaN(Date.parse(tick.scheduledTime)), `scheduledTime is a timestamp: ${tick.scheduledTime}`);
    });
  });
}
