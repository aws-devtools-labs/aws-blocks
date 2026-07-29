// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * VPC Smoke Test — Building Block instantiation + API surface for testing.
 * Instantiates one of each VPC-relevant BB and exposes an API that exercises
 * each BB's basic operation (for the smoke test to call via RPC).
 */

import { ApiNamespace, Scope } from '@aws-blocks/core';
import { KVStore } from '@aws-blocks/bb-kv-store';
import { DistributedTable } from '@aws-blocks/bb-distributed-table';
import { FileBucket } from '@aws-blocks/bb-file-bucket';
import { AsyncJob } from '@aws-blocks/bb-async-job';
import { AppSetting } from '@aws-blocks/bb-app-setting';
import { Realtime } from '@aws-blocks/bb-realtime';
import { AuthCognito } from '@aws-blocks/bb-auth-cognito';
import { Database, sql } from '@aws-blocks/bb-data';
import { Logger } from '@aws-blocks/bb-logger';
import { Metrics } from '@aws-blocks/bb-metrics';
import { Tracer } from '@aws-blocks/bb-tracer';
import { z } from 'zod';

const scope = new Scope('vpc-smoke');

// ── Building Blocks ─────────────────────────────────────────────────────────

const kv = new KVStore(scope, 'cache');

const table = new DistributedTable(scope, 'items', {
  schema: z.object({
    pk: z.string(),
    sk: z.string(),
    data: z.string(),
  }),
  key: { partitionKey: 'pk', sortKey: 'sk' },
});

const files = new FileBucket(scope, 'uploads');

const job = new AsyncJob(scope, 'processor', {
  schema: z.object({ message: z.string() }),
  handler: async (payload: { message: string }) => {
    console.log('Processing:', payload.message);
  },
});

const setting = new AppSetting(scope, 'config-val', {
  value: 'test-value',
});

const rt = new Realtime(scope, 'events', {
  namespaces: {
    notifications: { schema: z.object({ text: z.string() }) },
  },
});

const auth = new AuthCognito(scope, 'auth');
export const authApi = auth.createApi();

const db = new Database(scope, 'db');

const logger = new Logger(scope, 'log', { level: 'info' });
const metrics = new Metrics(scope, 'metrics', { namespace: 'vpc-smoke' });
const tracer = new Tracer(scope, 'tracer');

// ── API (exposes operations for the smoke test to call via RPC) ─────────────

export const api = new ApiNamespace(scope, 'api', (context) => ({
  async kvPutGet(key: string, value: string) {
    await kv.put(key, value);
    const result = await kv.get(key);
    await kv.delete(key);
    return result;
  },

  async tablePutQuery(pk: string, sk: string, data: string) {
    await table.put({ pk, sk, data });
    const items: Array<{ pk: string; sk: string; data: string }> = [];
    for await (const item of table.query({ where: { pk: { equals: pk } } })) {
      items.push(item);
    }
    await table.delete({ pk, sk });
    return items;
  },

  async filePutGet(key: string, content: string) {
    await files.put(key, content);
    const result = await files.get(key);
    await files.delete(key);
    return result !== null ? 'ok' : 'fail';
  },

  async jobSubmit(message: string) {
    await job.submit({ message });
    return 'submitted';
  },

  async settingGet() {
    return await setting.get();
  },

  async realtimePublish(channel: string, text: string) {
    await rt.publish('notifications', channel, { text });
    return 'published';
  },

  async realtimeGetChannel(channel: string) {
    return rt.getChannel('notifications', channel);
  },

  async dbQuery() {
    const result = await db.query<{ ping: number }>(sql`SELECT 1 AS ping`);
    return result;
  },

  async logEmit(message: string) {
    logger.info(message);
    return 'logged';
  },

  async metricsEmit(name: string, value: number) {
    metrics.emit(name, value, { unit: 'Count' });
    return 'emitted';
  },

  async tracerRun(name: string) {
    return await tracer.startSegment(name, async (segment) => {
      segment.addAnnotation('test', 'vpc-smoke');
      return 'traced';
    });
  },
}));
