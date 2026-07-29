// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * VPC Smoke Tests — validates each BB can reach its backing service from
 * within a VPC by calling API methods through RPC (same as comprehensive suite).
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { api as apiType } from 'aws-blocks';

const ENV = process.env.BLOCKS_TEST_ENV || 'local';
const __dirname = dirname(fileURLToPath(import.meta.url));
const backendPath = join(__dirname, '..', 'aws-blocks', 'index.cdk.ts');

let api: typeof apiType;

test('VPC Smoke Tests', async (t) => {
  // ── Deploy ────────────────────────────────────────────────────────────────
  t.before(async () => {
    if (ENV === 'local') {
      console.log('⏭️  VPC smoke tests require deployment — skipping in local mode.');
      process.exit(0);
    }

    console.log(`🚀 Deploying ${ENV}...\n`);
    execFileSync('npx', ['tsx', 'test/sandbox-deploy.ts', backendPath], {
      cwd: join(__dirname, '..'), stdio: 'inherit', env: { ...process.env, NODE_OPTIONS: '' },
    });
    console.log('\n✅ Deployed\n');

    // Import the generated client (reads sandbox outputs for API URL)
    const module = await import('aws-blocks');
    api = module.api;
  });

  // ── Teardown ──────────────────────────────────────────────────────────────
  t.after(async () => {
    if ((ENV === 'sandbox' || ENV === 'production') && !process.env.BLOCKS_SANDBOX_KEEP) {
      console.log(`\n🗑️  Destroying ${ENV} stack...`);
      execFileSync('npx', ['tsx', 'test/sandbox-destroy.ts', backendPath], {
        cwd: join(__dirname, '..'), stdio: 'inherit', env: { ...process.env, NODE_OPTIONS: '' },
      });
      console.log(`✅ Stack destroyed`);
    }
  });

  // ── Tests ─────────────────────────────────────────────────────────────────

  await t.test('KVStore: put + get via DynamoDB gateway endpoint', async () => {
    const key = `vpc-smoke-${Date.now()}`;
    const result = await api.kvPutGet(key, 'hello-vpc');
    assert.strictEqual(result, 'hello-vpc');
  });

  await t.test('DistributedTable: put + query via DynamoDB gateway endpoint', async () => {
    const pk = `vpc-smoke-${Date.now()}`;
    const items = await api.tablePutQuery(pk, 'item-1', 'vpc-test-data');
    assert.ok(items.length >= 1);
    assert.strictEqual(items[0].data, 'vpc-test-data');
  });

  await t.test('FileBucket: put + get via S3 gateway endpoint', async () => {
    const key = `vpc-smoke-${Date.now()}.txt`;
    const result = await api.filePutGet(key, 'vpc file content');
    assert.strictEqual(result, 'ok');
  });

  await t.test('AsyncJob: submit via SQS interface endpoint', async () => {
    const result = await api.jobSubmit('vpc-smoke-test');
    assert.strictEqual(result, 'submitted');
  });

  await t.test('AppSetting: get via SSM interface endpoint', async () => {
    const value = await api.settingGet();
    assert.strictEqual(value, 'test-value');
  });

  await t.test('Realtime: publish via API Gateway interface endpoint', async () => {
    const result = await api.realtimePublish('vpc-test-channel', 'connectivity check');
    assert.strictEqual(result, 'published');
  });

  await t.test('Database (Aurora): query via Secrets Manager + RDS Data API endpoints', async () => {
    const result = await api.dbQuery();
    assert.ok(result.length >= 1);
    assert.strictEqual(result[0].ping, 1);
  });

  await t.test('Logger: emit via CloudWatch Logs endpoint', async () => {
    const result = await api.logEmit('vpc-smoke-test');
    assert.strictEqual(result, 'logged');
  });

  await t.test('Metrics: emit (EMF/stdout, no endpoint needed)', async () => {
    const result = await api.metricsEmit('VpcSmokeTest', 1);
    assert.strictEqual(result, 'emitted');
  });

  await t.test('Tracer: startSegment (X-Ray agent, no endpoint needed)', async () => {
    const result = await api.tracerRun('vpc-smoke-test');
    assert.strictEqual(result, 'traced');
  });
});
