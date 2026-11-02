// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Container `AsyncJob`s: a `Compute({ type: 'container' })` (Fargate) backs an
 * AsyncJob; submitting drains through an owner-matched SQS poller the container
 * self-starts, and the handler reaches Blocks resources (KVStore + FileBucket)
 * from the container. A second job proves the per-handler wall-clock limit is
 * ENFORCED by hard-terminating the worker thread.
 *
 * Applies to every front door: job traffic doesn't go through it.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert';
import { setTimeout as sleep } from 'node:timers/promises';
import { apiRpc, type ComputeTestContext } from './context.js';

const RESULT_POLL_INTERVAL_MS = 250;
// Deployed runs pay for SQS long-poll, the container's poll cadence, and — most
// significantly — a COLD Fargate start: Express Mode reports the stack "deployed"
// before the ECS task is actually RUNNING, so the task still has to be scheduled,
// pull the ARM64 image, boot, and start its SQS poller before the first job is
// picked up. That can take a few minutes on a cold service, so the budget is
// deliberately generous (the CI job's own 60-min timeout is the real backstop).
const RESULT_POLL_BUDGET_MS = 300_000;

async function pollForResult<T>(fetchOne: () => Promise<T | null>): Promise<T | null> {
  const deadline = Date.now() + RESULT_POLL_BUDGET_MS;
  let result: T | null = null;
  do {
    result = await fetchOne();
    if (result) break;
    await sleep(RESULT_POLL_INTERVAL_MS);
  } while (Date.now() < deadline);
  return result;
}

export function containerJobTests(ctx: ComputeTestContext) {
  describe('Container AsyncJobs', () => {
    test('container job — successful dispatch, invocation, and Blocks-resource access', async () => {
      const testId = Date.now().toString(36);
      const key = `ctr-${testId}`;

      const submit = (await apiRpc(ctx, 'containerJobSubmit', key, 'hello-from-container')) as { jobId: string };
      assert.ok(typeof submit.jobId === 'string' && submit.jobId.length > 0, 'submit returns a job id');

      // KVStore result proves the handler ran.
      const result = (await pollForResult(
        () =>
          apiRpc(ctx, 'containerJobGetResult', key) as Promise<{ value: string; jobId: string; runtime: string } | null>,
      )) as { value: string; jobId: string; runtime: string } | null;
      assert.ok(result, 'container handler should have written the KVStore result');
      assert.strictEqual(result.value, 'hello-from-container');
      assert.strictEqual(result.jobId, submit.jobId);
      // The handler must have run ON the container (not Lambda).
      assert.strictEqual(result.runtime, 'container', 'handler ran on the container runtime');

      // FileBucket artifact proves the container reached a SECOND Blocks resource.
      const artifact = (await pollForResult(
        () => apiRpc(ctx, 'containerJobGetArtifact', key) as Promise<{ value: string } | null>,
      )) as { value: string } | null;
      assert.ok(artifact, 'container handler should have written the FileBucket artifact');
      assert.strictEqual(artifact.value, 'hello-from-container');
    });

    test('container job — non-cooperative handler is force-terminated at the wall-clock limit', async () => {
      const testId = Date.now().toString(36);
      const key = `ctr-timeout-${testId}`;

      const submit = (await apiRpc(ctx, 'containerTimeoutJobSubmit', key)) as { jobId: string };
      assert.ok(typeof submit.jobId === 'string' && submit.jobId.length > 0);

      // The handler busy-loops ~60s but the job's limit is 3s. If the timeout were
      // merely cooperative, this non-cooperative loop would run to completion and
      // write the "completed" marker. Because the worker thread is hard-terminated
      // at 3s, the marker is never written.
      //
      // Wait long enough that the slow-worker container has cold-started and had a
      // chance to pick up and (fail to) process the job — otherwise "no marker"
      // could reflect a not-yet-started worker rather than an enforced termination.
      // The success test above already warmed the shared ECS cluster + image cache,
      // so the slow-worker starts faster than a truly cold pull.
      await sleep(90_000);
      const result = await apiRpc(ctx, 'containerTimeoutJobGetResult', key);
      // The API returns `null` when the "completed" marker was never written; over
      // raw JSON-RPC a null result field surfaces as `undefined` (JSON has no
      // `undefined`). Either means the same thing here: the handler did NOT
      // complete, so the worker was terminated at the wall-clock limit as required.
      assert.ok(
        result == null,
        `a non-cooperative handler exceeding the wall-clock limit must be terminated, not allowed to complete (got ${JSON.stringify(result)})`,
      );
    });
  });
}
