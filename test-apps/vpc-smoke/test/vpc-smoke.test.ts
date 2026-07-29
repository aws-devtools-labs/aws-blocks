// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * VPC Smoke Tests — validates each BB can reach its backing service from
 * within a VPC. Each test performs a minimal round-trip operation to verify
 * VPC endpoint connectivity.
 *
 * Structured the same as the comprehensive e2e suite: BLOCKS_TEST_ENV controls
 * whether to deploy a sandbox or run against an existing deployment.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ENV = process.env.BLOCKS_TEST_ENV || 'local';
const __dirname = dirname(fileURLToPath(import.meta.url));
const backendPath = join(__dirname, '..', 'aws-blocks', 'index.cdk.ts');

test('VPC Smoke Tests', async (t) => {
  // ── Deploy ────────────────────────────────────────────────────────────────
  t.before(async () => {
    if (ENV === 'local') {
      console.log('⏭️  VPC smoke tests require deployment — skipping in local mode.');
      process.exit(0);
    }

    console.log(`🚀 Deploying ${ENV} sandbox...`);
    execFileSync('npx', ['tsx', 'test/sandbox-deploy.ts', backendPath], {
      cwd: join(__dirname, '..'), stdio: 'inherit', env: { ...process.env, NODE_OPTIONS: '' },
    });
    console.log('\n✅ Sandbox deployed\n');
  });

  // ── Teardown ──────────────────────────────────────────────────────────────
  t.after(async () => {
    if ((ENV === 'sandbox' || ENV === 'production') && !process.env.BLOCKS_SANDBOX_KEEP) {
      console.log(`\n🗑️  Destroying ${ENV} stack...`);
      execFileSync('npx', ['tsx', 'test/sandbox-destroy.ts', backendPath], {
        cwd: join(__dirname, '..'), stdio: 'inherit', env: { ...process.env, NODE_OPTIONS: '' },
      });
      console.log(`✅ ${ENV} stack destroyed`);
    }
  });

  // ── Import the API after deployment (reads outputs) ───────────────────────
  const { kv, table, files, job, setting, rt, auth, db, logger, metrics, tracer } =
    await import('../aws-blocks/index.js');
  const { sql } = await import('@aws-blocks/bb-data');

  // ── Tests ─────────────────────────────────────────────────────────────────

  await t.test('KVStore: put + get', async () => {
    const key = `vpc-smoke-${Date.now()}`;
    await kv.put(key, 'hello-vpc');
    const value = await kv.get(key);
    assert.strictEqual(value, 'hello-vpc');
    await kv.delete(key);
  });

  await t.test('DistributedTable: put + query', async () => {
    const pk = `vpc-smoke-${Date.now()}`;
    const sk = 'item-1';
    await table.put({ pk, sk, data: 'vpc-test-data' });
    const items: Array<{ pk: string; sk: string; data: string }> = [];
    for await (const item of table.query({ where: { pk: { equals: pk } } })) {
      items.push(item);
    }
    assert.ok(items.length >= 1);
    assert.strictEqual(items[0].data, 'vpc-test-data');
    await table.delete({ pk, sk });
  });

  await t.test('FileBucket: put + get', async () => {
    const key = `vpc-smoke-${Date.now()}.txt`;
    await files.put(key, 'vpc file content');
    const content = await files.get(key);
    assert.ok(content !== null);
    await files.delete(key);
  });

  await t.test('AsyncJob: submit', async () => {
    await assert.doesNotReject(async () => {
      await job.submit({ message: 'vpc-smoke-test' });
    });
  });

  await t.test('AppSetting: get', async () => {
    const value = await setting.get();
    assert.ok(value !== null && value !== undefined);
  });

  await t.test('Realtime: server-side publish', async () => {
    await assert.doesNotReject(async () => {
      await rt.publish('notifications', 'vpc-smoke-test', { text: 'connectivity check' });
    });
  });

  await t.test('Realtime: client-side subscribe + receive', async () => {
    const channelName = `subscribe-test-${Date.now()}`;
    const channel = await rt.getChannel('notifications', channelName);
    const received: Array<{ text: string }> = [];

    const sub = channel.subscribe((msg: { text: string }) => {
      received.push(msg);
    });
    await sub.established;

    const testPayload = { text: `vpc-ws-${Date.now()}` };
    await rt.publish('notifications', channelName, testPayload);

    await new Promise(resolve => setTimeout(resolve, 2000));
    assert.ok(received.length >= 1, `Expected at least 1 message, got ${received.length}`);
    assert.strictEqual(received[0].text, testPayload.text);
    sub.unsubscribe();
  });

  await t.test('Database (Aurora): SELECT 1', async () => {
    const result = await db.query<{ ping: number }>(sql`SELECT 1 AS ping`);
    assert.ok(result.length >= 1);
    assert.strictEqual(result[0].ping, 1);
  });

  await t.test('AuthCognito: signUp reaches service', async () => {
    const email = `vpc-smoke-${Date.now()}@example.com`;
    try {
      await auth.signUp(email, 'VpcTest1!', { attributes: { email } });
    } catch (e: any) {
      // Cognito policy errors prove connectivity
      assert.ok(
        e.name === 'InvalidPasswordException' ||
        e.name === 'UsernameExistsException' ||
        e.name === 'InvalidParameterException' ||
        e.message?.includes('password') ||
        e.message?.includes('Username'),
        `Unexpected error: ${e.name}: ${e.message}`,
      );
    }
  });

  await t.test('Logger: emit', () => {
    assert.doesNotThrow(() => { logger.info('vpc-smoke-test'); });
  });

  await t.test('Metrics: emit', () => {
    assert.doesNotThrow(() => { metrics.emit('VpcSmokeTest', 1, { unit: 'Count' }); });
  });

  await t.test('Tracer: startSegment', async () => {
    await assert.doesNotReject(async () => {
      await tracer.startSegment('vpc-smoke-test', async (segment) => {
        segment.addAnnotation('test', 'vpc-smoke');
        return 'ok';
      });
    });
  });
});
