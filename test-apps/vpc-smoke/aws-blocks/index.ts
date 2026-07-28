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
  key: { pk: 'pk', sk: 'sk' },
});

// FileBucket → triggers S3 gateway endpoint
export const files = new FileBucket(scope, 'uploads');

// AsyncJob → triggers SQS interface endpoint
export const job = new AsyncJob(scope, 'processor', {
  handler: async (payload: { message: string }) => {
    console.log('Processing:', payload.message);
  },
});

// AppSetting → triggers SSM interface endpoint
export const setting = new AppSetting(scope, 'config-val', {
  value: 'test-value',
});
