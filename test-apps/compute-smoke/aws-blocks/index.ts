// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Compute Test — every compute kind and workload behind one deployment.
 *
 * Scenarios (one test module each under `test/`):
 * - Container `AsyncJob`s: a `Compute` of `type: 'container'` (AWS Fargate) backs
 *   an `AsyncJob`, and the container reaches Blocks resources (KVStore +
 *   FileBucket) exactly as a Lambda handler would. A second job proves the
 *   per-handler wall-clock limit is enforced by hard-terminating the worker
 *   thread.
 * - API namespace on its own compute: `reports` runs on a serverless `Compute`
 *   (512 MB), so a call through the front door must be served by that function,
 *   while `api` stays on the default compute.
 * - Scope-level compute: everything created under the `placed` scope, with no
 *   `compute` of its own — an API namespace, an AsyncJob, a CronJob, and an API
 *   namespace in a child scope — runs on the scope's serverless `Compute`
 *   (640 MB); a namespace that passes its own `compute` runs on that one instead.
 * - CronJob on its own compute: `tick-own` passes `compute` (the reports
 *   compute). With the scope's CronJob on a third function, the two jobs also
 *   show that the shared scheduler role may invoke every job's target.
 *
 * The front door is the suite's variant axis: each CI leg deploys this same app
 * with one `COMPUTE_API_FRONT_DOOR` value (see `index.cdk.ts`).
 *
 * This app runs against the persistent test VPC (injected via
 * `defaults.vpc.network`), so it adds zero new VPCs per run — the reason
 * container compute lives here rather than in the VPC-free `comprehensive`
 * suite (where forcing a VPC would double the per-run VPC count). With the VPC
 * set, the Lambda computes run in it too.
 */

import { ApiNamespace, Scope } from '@aws-blocks/core';
import { Compute, CronJob } from '@aws-blocks/blocks';
import { AsyncJob } from '@aws-blocks/bb-async-job';
import { KVStore } from '@aws-blocks/bb-kv-store';
import { FileBucket } from '@aws-blocks/bb-file-bucket';

// A short scope id: every resource name derives from it (see the stack name in index.cdk.ts).
const scope = new Scope('compute');

// Shared resources the container handlers write to — the "did the handler run"
// signals the smoke test reads back.
const jobResults = new KVStore(scope, 'job-results');
const bucket = new FileBucket(scope, 'artifacts');

// ── Container compute — long-running AsyncJobs on Fargate ───────────────────

const worker = new Compute(scope, 'worker', {
  type: 'container',
  size: { vcpu: 0.5, memory: 1024 },
  scaling: { minInstances: 1, maxInstances: 3 },
});

// A job dispatched to the container. Its handler writes to BOTH a KVStore and a
// FileBucket — proving the container reaches Blocks resources exactly as the
// Lambda handler does (shared execution role, same config, same SDK-identifier
// resolution). `timeoutSeconds` and `maxConcurrencyPerCPU` are properties of the
// work and live on the job.
const containerJob = new AsyncJob(scope, 'container-job', {
  compute: worker,
  timeoutSeconds: 1800,
  maxConcurrencyPerCPU: 4,
  handler: async (payload: { key: string; value: string }, ctx) => {
    await jobResults.put(
      `container:${payload.key}`,
      JSON.stringify({
        value: payload.value,
        jobId: ctx.jobId,
        receiveCount: ctx.receiveCount,
        sentAt: ctx.sentAt,
        // Distinguish the container runtime from Lambda so the test can assert
        // where the handler actually ran when deployed.
        runtime: process.env.BLOCKS_SERVICE_MODE === 'worker' ? 'container' : 'local-or-lambda',
      }),
    );
    await bucket.put(`container-artifacts/${payload.key}.txt`, payload.value);
  },
});

// A container job whose handler deliberately runs longer than the job's
// per-handler wall-clock limit, so the poller aborts it. `maxRetries: 1` makes
// the first (timed-out) delivery terminal so it lands in the DLQ without a long
// redrive wait. The 3s limit lives on the JOB (`timeoutSeconds`) and is enforced
// by the container runtime terminating the job's worker thread.
const timeoutWorker = new Compute(scope, 'slow-worker', {
  type: 'container',
  size: { vcpu: 0.25, memory: 512 },
});

const containerTimeoutJob = new AsyncJob(scope, 'container-timeout-job', {
  compute: timeoutWorker,
  timeoutSeconds: 3,
  maxRetries: 1,
  handler: async (payload: { key: string }) => {
    // Deliberately NON-cooperative: a tight CPU busy-loop that never yields and
    // never checks an abort signal. The only way to stop this is to terminate
    // the worker thread it runs in — which is exactly what the container poller
    // does at the 3s wall-clock limit. If the worker weren't terminated this
    // would burn ~60s and then write the marker below; because it IS terminated,
    // the marker is never written and the delivery redrives to the DLQ. This
    // proves the timeout is ENFORCED, not merely cooperative.
    const end = Date.now() + 60_000;
    while (Date.now() < end) {
      // burn CPU — no await, no signal check
    }
    await jobResults.put(`container-timeout:${payload.key}`, 'completed-should-not-happen');
  },
});

// ── Serverless compute — an API namespace on its own function ─────────────

/** Which function served the call — what the API-namespace scenario asserts on. */
function whereAmI() {
  return {
    functionName: process.env.AWS_LAMBDA_FUNCTION_NAME ?? null,
    memoryMb: process.env.AWS_LAMBDA_FUNCTION_MEMORY_SIZE ?? null,
  };
}

const reportsCompute = new Compute(scope, 'reports', { type: 'serverless', memory: 512 });

// Constructed as 'reportsApi' but exported as `reports`: the gateway routes the
// export name, which is what the client calls.
export const reports = new ApiNamespace(
  scope,
  'reportsApi',
  () => ({
    async whereAmI() {
      return whereAmI();
    },
  }),
  { compute: reportsCompute },
);

// ── Scope-level compute — everything under `placed` runs on its compute ────

// A different id from the scope below: both are children of `scope`.
const placedCompute = new Compute(scope, 'placed-compute', { type: 'serverless', memory: 640 });
const placed = new Scope('placed', { parent: scope, compute: placedCompute });

// Placed by its scope: neither block passes `compute` itself.
export const placedApi = new ApiNamespace(placed, 'placed', () => ({
  async whereAmI() {
    return whereAmI();
  },
}));

new CronJob(placed, 'tick', {
  schedule: 'rate(1 minute)',
  handler: async () => {
    await jobResults.put('cron:placed', JSON.stringify(whereAmI()));
  },
});

const placedJob = new AsyncJob(placed, 'placed-job', {
  handler: async (payload: { key: string }) => {
    await jobResults.put(`placed-job:${payload.key}`, JSON.stringify(whereAmI()));
  },
});

// A child scope inherits its parent scope's compute.
const placedChild = new Scope('child', { parent: placed });
export const placedChildApi = new ApiNamespace(placedChild, 'placed-child', () => ({
  async whereAmI() {
    return whereAmI();
  },
}));

// A block's own `compute` wins over its scope's.
export const placedOverrideApi = new ApiNamespace(
  placed,
  'placed-override',
  () => ({
    async whereAmI() {
      return whereAmI();
    },
  }),
  { compute: reportsCompute },
);

// ── CronJob on its own compute ──────────────────────────────────────────────

new CronJob(scope, 'tick-own', {
  schedule: 'rate(1 minute)',
  compute: reportsCompute,
  handler: async () => {
    await jobResults.put('cron:own', JSON.stringify(whereAmI()));
  },
});

// ── API (operations the tests call via RPC) — on the default compute ───────

export const api = new ApiNamespace(scope, 'api', (_context) => ({
  async whereAmI() {
    return whereAmI();
  },

  async containerJobSubmit(key: string, value: string) {
    const { jobId } = await containerJob.submit({ key, value });
    return { jobId };
  },

  async containerJobGetResult(key: string) {
    const raw = await jobResults.get(`container:${key}`);
    return raw ? JSON.parse(raw) : null;
  },

  async containerJobGetArtifact(key: string) {
    // Reads the FileBucket object the container handler wrote — proves the
    // container reached a second Blocks resource.
    const content = await bucket.get(`container-artifacts/${key}.txt`);
    return content ? { value: content.body.toString('utf8') } : null;
  },

  async containerTimeoutJobSubmit(key: string) {
    const { jobId } = await containerTimeoutJob.submit({ key });
    return { jobId };
  },

  async containerTimeoutJobGetResult(key: string) {
    const raw = await jobResults.get(`container-timeout:${key}`);
    return raw ? { value: raw } : null;
  },

  /** Where the `placed` scope's CronJob last ran, or null before its first run. */
  async placedCronRan() {
    const raw = await jobResults.get('cron:placed');
    return raw ? JSON.parse(raw) : null;
  },

  /** Where the CronJob on its own compute last ran, or null before its first run. */
  async ownCronRan() {
    const raw = await jobResults.get('cron:own');
    return raw ? JSON.parse(raw) : null;
  },

  async placedJobSubmit(key: string) {
    const { jobId } = await placedJob.submit({ key });
    return { jobId };
  },

  /** Where the `placed` scope's AsyncJob ran for `key`, or null until it has. */
  async placedJobRan(key: string) {
    const raw = await jobResults.get(`placed-job:${key}`);
    return raw ? JSON.parse(raw) : null;
  },
}));
