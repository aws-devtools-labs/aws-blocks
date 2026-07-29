// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * VPC Smoke Tests — validates each BB can reach its backing service from
 * within a VPC by calling API methods through direct HTTP/RPC.
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ENV = process.env.BLOCKS_TEST_ENV || 'local';
const __dirname = dirname(fileURLToPath(import.meta.url));
const backendPath = join(__dirname, '..', 'aws-blocks', 'index.cdk.ts');
const outputsPath = join(__dirname, '..', '.blocks-sandbox', 'outputs.json');

let apiUrl: string;

/** Call an API method via the Blocks JSON-RPC protocol */
async function rpc(method: string, ...args: unknown[]): Promise<unknown> {
  const res = await fetch(apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method: `api.${method}`, args }),
  });
  if (!res.ok) throw new Error(`RPC ${method} failed: ${res.status} ${await res.text()}`);
  const json = await res.json() as any;
  if (json.error) throw new Error(`RPC ${method} error: ${json.error.message || JSON.stringify(json.error)}`);
  return json.result;
}

test('VPC Smoke Tests', async (t) => {
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

    // Read API URL from sandbox outputs
    const outputs = JSON.parse(readFileSync(outputsPath, 'utf-8'));
    apiUrl = outputs.ApiUrl || outputs.apiUrl;
    if (!apiUrl) {
      // Try nested format
      const stackKey = Object.keys(outputs)[0];
      apiUrl = outputs[stackKey]?.ApiUrl || outputs[stackKey]?.apiUrl;
    }
    if (!apiUrl) throw new Error(`No ApiUrl found in ${outputsPath}: ${JSON.stringify(outputs)}`);
    console.log(`📡 API URL: ${apiUrl}\n`);
  });

  t.after(async () => {
    if ((ENV === 'sandbox' || ENV === 'production') && !process.env.BLOCKS_SANDBOX_KEEP) {
      console.log(`\n🗑️  Destroying ${ENV} stack...`);
      execFileSync('npx', ['tsx', 'test/sandbox-destroy.ts', backendPath], {
        cwd: join(__dirname, '..'), stdio: 'inherit', env: { ...process.env, NODE_OPTIONS: '' },
      });
      console.log(`✅ Stack destroyed`);
    }
  });

  await t.test('KVStore: put + get via DynamoDB gateway endpoint', async () => {
    const key = `vpc-smoke-${Date.now()}`;
    const result = await rpc('kvPutGet', key, 'hello-vpc');
    assert.strictEqual(result, 'hello-vpc');
  });

  await t.test('DistributedTable: put + query via DynamoDB gateway endpoint', async () => {
    const pk = `vpc-smoke-${Date.now()}`;
    const items = await rpc('tablePutQuery', pk, 'item-1', 'vpc-test-data') as any[];
    assert.ok(items.length >= 1);
    assert.strictEqual(items[0].data, 'vpc-test-data');
  });

  await t.test('FileBucket: put + get via S3 gateway endpoint', async () => {
    const key = `vpc-smoke-${Date.now()}.txt`;
    const result = await rpc('filePutGet', key, 'vpc file content');
    assert.strictEqual(result, 'ok');
  });

  await t.test('AsyncJob: submit via SQS interface endpoint', async () => {
    const result = await rpc('jobSubmit', 'vpc-smoke-test');
    assert.strictEqual(result, 'submitted');
  });

  await t.test('AppSetting: get via SSM interface endpoint', async () => {
    const value = await rpc('settingGet');
    assert.ok(value !== null && value !== undefined);
  });

  await t.test('Realtime: publish via API Gateway interface endpoint', async () => {
    const result = await rpc('realtimePublish', 'vpc-test-channel', 'connectivity check');
    assert.strictEqual(result, 'published');
  });

  await t.test('Database (Aurora): query via Secrets Manager + RDS Data API endpoints', async () => {
    const result = await rpc('dbQuery') as any[];
    assert.ok(result.length >= 1);
    assert.strictEqual(result[0].ping, 1);
  });

  await t.test('Logger: emit via CloudWatch Logs endpoint', async () => {
    const result = await rpc('logEmit', 'vpc-smoke-test');
    assert.strictEqual(result, 'logged');
  });

  await t.test('Metrics: emit (EMF/stdout, no endpoint needed)', async () => {
    const result = await rpc('metricsEmit', 'VpcSmokeTest', 1);
    assert.strictEqual(result, 'emitted');
  });

  await t.test('Tracer: startSegment (X-Ray agent, no endpoint needed)', async () => {
    const result = await rpc('tracerRun', 'vpc-smoke-test');
    assert.strictEqual(result, 'traced');
  });
});
