// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { setTimeout } from 'node:timers/promises';
import type { api as apiType } from 'aws-blocks';

const ENV = process.env.BLOCKS_TEST_ENV || 'local';
const isDeployed = ENV === 'sandbox' || ENV === 'production';

const RESULT_POLL_INTERVAL_MS = 250;

/**
 * Wall-clock budget for a container-dispatched job to complete. Deployed runs
 * pay for the SQS receive long-poll, the container's own poll cadence, and — on
 * a cold service — Fargate task startup + image pull, so the budget is generous
 * when deployed. Local simulates the container in-process, so it settles fast.
 */
const RESULT_POLL_BUDGET_MS = isDeployed ? 120_000 : 15_000;

async function pollForResult<T>(
  fetch: () => Promise<T | null>,
  budgetMs: number = RESULT_POLL_BUDGET_MS,
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
 * Container-dispatched AsyncJob e2e. Exercises the multi-compute path end to end:
 * a `Compute` block whose capabilities select a container (Fargate) backs an
 * AsyncJob; submitting drains through an owner-matched SQS poller the container
 * self-starts, and the handler reaches Blocks resources (KVStore + FileBucket)
 * from the container. Also demonstrates the per-handler wall-clock limit.
 *
 * In local mode the container is simulated in-process (the handler runs exactly
 * as any other AsyncJob), so the same assertions hold across local, sandbox, and
 * production — full parity, no environment-specific branching in the assertions.
 */
export function containerJobTests(getApi: () => typeof apiType) {
  describe('AsyncJob on container compute', () => {
    test('container job — successful dispatch, invocation, and Blocks-resource access', async () => {
      const api = getApi();
      const testId = Date.now().toString(36);
      const key = `ctr-${testId}`;

      const { jobId } = await api.containerJobSubmit(key, 'hello-from-container');
      assert.ok(typeof jobId === 'string' && jobId.length > 0, 'submit returns a job id');

      // KVStore result proves the handler ran.
      const result = await pollForResult(() => api.containerJobGetResult(key));
      assert.ok(result, 'container handler should have written the KVStore result');
      assert.strictEqual(result.value, 'hello-from-container');
      assert.strictEqual(result.jobId, jobId);

      // When deployed, the handler must have run ON the container (not Lambda).
      // Locally it's simulated in-process, so only assert the runtime marker when deployed.
      if (isDeployed) {
        assert.strictEqual(result.runtime, 'container', 'handler ran on the container runtime');
      }

      // FileBucket artifact proves the container reached a SECOND Blocks resource.
      const artifact = await pollForResult(() => api.containerJobGetArtifact(key));
      assert.ok(artifact, 'container handler should have written the FileBucket artifact');
      assert.strictEqual(artifact.value, 'hello-from-container');
    });

    test('container job — non-cooperative handler is force-terminated at the wall-clock limit', async () => {
      const api = getApi();

      // Enforcement can only be shown against a real container: the local mock runs
      // handlers in-process, so a CPU busy-loop can't be worker-terminated there and
      // would just freeze the dev server. Skip submitting it locally; the deployed
      // run is the meaningful proof.
      if (!isDeployed) return;

      const testId = Date.now().toString(36);
      const key = `ctr-timeout-${testId}`;

      const { jobId } = await api.containerTimeoutJobSubmit(key);
      assert.ok(typeof jobId === 'string' && jobId.length > 0);

      // The handler busy-loops ~60s but the compute's limit is 3s. If the timeout
      // were merely cooperative, this non-cooperative loop would run to completion
      // and write the "completed" marker. Because the worker thread is hard-
      // terminated at 3s, the marker is never written. Wait comfortably past the
      // limit (and past a couple redrive cycles) and assert it never completed.
      await setTimeout(30_000);
      const result = await api.containerTimeoutJobGetResult(key);
      assert.strictEqual(
        result,
        null,
        'a non-cooperative handler exceeding the wall-clock limit must be terminated, not allowed to complete',
      );
    });
  });
}
