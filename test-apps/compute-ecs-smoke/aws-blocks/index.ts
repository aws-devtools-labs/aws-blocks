// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Container compute smoke backend: exercises the HTTP path (RPC + RawRoute)
// served by containers, and the hybrid event path (AsyncJob consumed by the
// companion Lambda) — the seam's core contract.

import { ApiNamespace, Scope, KVStore, RawRoute } from '@aws-blocks/blocks';
import { AsyncJob } from '@aws-blocks/bb-async-job';
import type { BlocksContext } from '@aws-blocks/blocks';

const scope = new Scope('ecs-smoke');

const store = new KVStore(scope, 'store', {});

// Submitted over HTTP (served by containers on AWS); the handler runs on the
// companion Lambda via the SQS event source — proving the hybrid model.
const echoJob = new AsyncJob(scope, 'echo-job', {
  handler: async (payload: { key: string; value: string }, ctx) => {
    await store.put(`job:${payload.key}`, JSON.stringify({ value: payload.value, jobId: ctx.jobId }));
  },
});

export const api = new ApiNamespace(scope, 'api', (context: BlocksContext) => ({
  async kvPut(key: string, value: string) {
    await store.put(key, value);
    return { success: true };
  },

  async kvGet(key: string) {
    return await store.get(key);
  },

  async submitJob(key: string, value: string) {
    const { jobId } = await echoJob.submit({ key, value });
    return { jobId };
  },

  async getJobResult(key: string) {
    const raw = await store.get(`job:${key}`);
    return raw ? JSON.parse(raw) : null;
  },

  async whereAmI() {
    return {
      url: context.request.url.href,
      compute: process.env.BLOCKS_COMPUTE ?? 'lambda-or-local',
    };
  },
}));

new RawRoute(scope, 'ping', {
  method: 'GET',
  path: '/ping/{name}',
  handler: async (ctx: BlocksContext) => {
    ctx.response.send({ pong: ctx.request.params.name });
  },
});
