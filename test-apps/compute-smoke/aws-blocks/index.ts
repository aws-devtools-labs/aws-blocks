// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Compute Smoke Test — container-backed compute in a VPC.
 *
 * Exercises the multi-compute path end to end: a `Compute` block of
 * `type: 'container'` (AWS Fargate) backs an `AsyncJob`, and the container
 * reaches Blocks resources (KVStore + FileBucket) exactly as a Lambda handler
 * would. A second job proves the per-handler wall-clock limit is enforced by
 * hard-terminating the worker thread.
 *
 * This app runs against the persistent test VPC (injected via
 * `defaults.vpc.network`), so it adds zero new VPCs per run — the reason
 * container compute lives here rather than in the VPC-free `comprehensive`
 * suite (where forcing a VPC would double the per-run VPC count).
 */

import { ApiNamespace, Scope } from '@aws-blocks/core';
import { Compute } from '@aws-blocks/blocks';
import { AsyncJob } from '@aws-blocks/bb-async-job';
import { KVStore } from '@aws-blocks/bb-kv-store';
import { FileBucket } from '@aws-blocks/bb-file-bucket';

const scope = new Scope('compute-smoke');

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

// ── API (operations the smoke test calls via RPC) ───────────────────────────

export const api = new ApiNamespace(scope, 'api', (_context) => ({
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
}));
