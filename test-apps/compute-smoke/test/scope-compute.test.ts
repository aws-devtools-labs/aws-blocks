// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Scope-level compute: `placed` is a scope with its own serverless `Compute`
 * (640 MB). Blocks created under it that pass no `compute` of their own — an API
 * namespace, an AsyncJob, a CronJob, and an API namespace in a child scope — run
 * on that compute's function. A namespace that passes its own `compute` runs on
 * that one instead.
 *
 * Applies to every front door.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert';
import { ApiNamespaceClient } from '@aws-blocks/blocks/client';
import { apiRpc, type ComputeTestContext, pollFor } from './context.js';

type WhereAmI = { functionName: string | null; memoryMb: string | null };

// The schedule fires every minute from deploy, so it has usually run by the time
// the tests start; this covers a first run that lands just after.
const CRON_BUDGET_MS = 180_000;
// A serverless AsyncJob is delivered within seconds; this covers a cold start.
const JOB_BUDGET_MS = 60_000;

export function scopeComputeTests(ctx: ComputeTestContext) {
  /** The real typed client, pointed at the front door. */
  const whereAmI = (namespace: string) =>
    ApiNamespaceClient<{ whereAmI(): Promise<WhereAmI> }>(namespace, { url: ctx.apiUrl() }).whereAmI();

  describe('Scope-level compute', () => {
    test("an API namespace in the scope runs on the scope's compute", async () => {
      const onDefault = await whereAmI('api');
      const onPlaced = await whereAmI('placedApi');
      assert.ok(onPlaced.functionName, 'the call ran on Lambda');
      assert.notStrictEqual(onPlaced.functionName, onDefault.functionName, 'not the default function');
      assert.strictEqual(onPlaced.memoryMb, '640', "the scope's compute options apply");
    });

    test("an API namespace in a child scope inherits the scope's compute", async () => {
      const onPlaced = await whereAmI('placedApi');
      const onChild = await whereAmI('placedChildApi');
      assert.strictEqual(onChild.functionName, onPlaced.functionName);
    });

    test("a block's own compute wins over its scope's", async () => {
      const onReports = await whereAmI('reports');
      const onOverride = await whereAmI('placedOverrideApi');
      assert.strictEqual(onOverride.functionName, onReports.functionName, 'its own compute');
      assert.strictEqual(onOverride.memoryMb, '512');
    });

    test("an AsyncJob in the scope runs on the scope's compute", async () => {
      const onPlaced = await whereAmI('placedApi');
      const key = `placed-${Date.now().toString(36)}`;
      await apiRpc(ctx, 'placedJobSubmit', key);
      const ran = await pollFor(() => apiRpc(ctx, 'placedJobRan', key) as Promise<WhereAmI | null>, {
        budgetMs: JOB_BUDGET_MS,
        intervalMs: 2_000,
      });
      assert.ok(ran, `the job ran within ${JOB_BUDGET_MS / 1000}s`);
      assert.strictEqual(ran.functionName, onPlaced.functionName);
    });

    test("a CronJob in the scope runs on the scope's compute", async () => {
      const onPlaced = await whereAmI('placedApi');
      const ran = await pollFor(() => apiRpc(ctx, 'placedCronRan') as Promise<WhereAmI | null>, {
        budgetMs: CRON_BUDGET_MS,
      });
      assert.ok(ran, `the CronJob ran within ${CRON_BUDGET_MS / 1000}s`);
      assert.strictEqual(ran.functionName, onPlaced.functionName, "it ran on the scope's compute");
    });
  });
}
