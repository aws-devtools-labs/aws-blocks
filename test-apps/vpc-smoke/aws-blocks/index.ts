// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * VPC Smoke Test — Building Block instantiation.
 * Instantiates one of each VPC-relevant BB to verify endpoint auto-detection
 * and Lambda placement work correctly inside a VPC.
 */

import { Scope } from '@aws-blocks/core';
import { KVStore } from '@aws-blocks/bb-kv-store';
import { DistributedTable } from '@aws-blocks/bb-distributed-table';
import { FileBucket } from '@aws-blocks/bb-file-bucket';
import { AsyncJob } from '@aws-blocks/bb-async-job';
import { AppSetting } from '@aws-blocks/bb-app-setting';
import { Realtime } from '@aws-blocks/bb-realtime';
import { AuthCognito } from '@aws-blocks/bb-auth-cognito';
import { Logger } from '@aws-blocks/bb-logger';
import { Metrics } from '@aws-blocks/bb-metrics';
import { Tracer } from '@aws-blocks/bb-tracer';
import { z } from 'zod';

const scope = new Scope('vpc-smoke');

// KVStore → triggers DynamoDB gateway endpoint
export const kv = new KVStore(scope, 'cache');

// DistributedTable → triggers DynamoDB gateway endpoint
export const table = new DistributedTable(scope, 'items', {
  schema: z.object({
    pk: z.string(),
    sk: z.string(),
    data: z.string(),
  }),
  key: { partitionKey: 'pk', sortKey: 'sk' },
});

// FileBucket → triggers S3 gateway endpoint
export const files = new FileBucket(scope, 'uploads');

// AsyncJob → triggers SQS interface endpoint
export const job = new AsyncJob(scope, 'processor', {
  schema: z.object({ message: z.string() }),
  handler: async (payload: { message: string }) => {
    console.log('Processing:', payload.message);
  },
});

// AppSetting → triggers SSM interface endpoint
export const setting = new AppSetting(scope, 'config-val', {
  value: 'test-value',
});

// Realtime → triggers API Gateway interface endpoint
export const rt = new Realtime(scope, 'events', {
  namespaces: {
    notifications: { schema: z.object({ text: z.string() }) },
  },
});

// AuthCognito → triggers SSM interface endpoint (session secret)
export const auth = new AuthCognito(scope, 'auth');

// Logger → no VPC endpoint needed (uses CloudWatch Logs, always provisioned)
export const logger = new Logger(scope, 'log', { level: 'info' });

// Metrics → no VPC endpoint needed (EMF writes to stdout)
export const metrics = new Metrics(scope, 'metrics', { namespace: 'vpc-smoke' });

// Tracer → no VPC endpoint needed (X-Ray agent handles egress)
export const tracer = new Tracer(scope, 'tracer');
