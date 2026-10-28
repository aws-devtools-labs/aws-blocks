// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * A CronJob on its own compute: `tick-own` passes `compute` (the reports
 * compute, 512 MB), so the schedule invokes that compute's function, not the
 * default's.
 *
 * The scope-level CronJob (scope-compute.test.ts) targets a different function,
 * so the two together also prove the shared scheduler role may invoke every
 * job's target: before, it was granted only the first job's.
 *
 * Applies to every front door: schedules don't go through it.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert';
import { ApiNamespaceClient } from '@aws-blocks/blocks/client';
import { apiRpc, type ComputeTestContext, pollFor } from './context.js';

type WhereAmI = { functionName: string | null; memoryMb: string | null };

const CRON_BUDGET_MS = 180_000;

export function cronJobComputeTests(ctx: ComputeTestContext) {
  const whereAmI = (namespace: string) =>
    ApiNamespaceClient<{ whereAmI(): Promise<WhereAmI> }>(namespace, { url: ctx.apiUrl() }).whereAmI();

  describe('CronJob on its own compute', () => {
    test("a CronJob with its own compute runs on that compute's function", async () => {
      const onReports = await whereAmI('reports');
      const onDefault = await whereAmI('api');
      const ran = await pollFor(() => apiRpc(ctx, 'ownCronRan') as Promise<WhereAmI | null>, {
        budgetMs: CRON_BUDGET_MS,
      });
      assert.ok(ran, `the CronJob ran within ${CRON_BUDGET_MS / 1000}s`);
      assert.strictEqual(ran.functionName, onReports.functionName, 'its own compute');
      assert.notStrictEqual(ran.functionName, onDefault.functionName, 'not the default function');
      assert.strictEqual(ran.memoryMb, '512');
    });

    test('CronJobs on two different computes both run', async () => {
      // Each job writes where it ran; both present means the scheduler role could
      // invoke both targets.
      const [own, placed] = await Promise.all([
        pollFor(() => apiRpc(ctx, 'ownCronRan') as Promise<WhereAmI | null>, { budgetMs: CRON_BUDGET_MS }),
        pollFor(() => apiRpc(ctx, 'placedCronRan') as Promise<WhereAmI | null>, { budgetMs: CRON_BUDGET_MS }),
      ]);
      assert.ok(own && placed, `both ran (own: ${JSON.stringify(own)}, placed: ${JSON.stringify(placed)})`);
      assert.notStrictEqual(own.functionName, placed.functionName, 'on two different functions');
    });
  });
}
