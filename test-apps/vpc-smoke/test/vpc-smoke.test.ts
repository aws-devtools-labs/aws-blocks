// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * VPC Smoke Tests — validates each BB can reach its backing service from
 * within a VPC. These tests run inside the deployed Lambda (via the Blocks
 * RPC layer), NOT locally. Each test performs a minimal round-trip operation
 * to verify VPC endpoint connectivity.
 *
 * To run: deploy the vpc-smoke app, then invoke via the Blocks API.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert';
import { kv, table, files, job, setting, rt, auth, db, logger, metrics, tracer } from '../aws-blocks/index.js';
import { sql } from '@aws-blocks/bb-data';

describe('VPC Smoke Tests', () => {

  describe('KVStore', () => {
    test('put + get round-trip', async () => {
      const key = `vpc-smoke-${Date.now()}`;
      await kv.put(key, 'hello-vpc');
      const value = await kv.get(key);
      assert.strictEqual(value, 'hello-vpc');
      await kv.delete(key);
    });
  });

  describe('DistributedTable', () => {
    test('put + query round-trip', async () => {
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
  });

  describe('FileBucket', () => {
    test('put + get round-trip', async () => {
      const key = `vpc-smoke-${Date.now()}.txt`;
      await files.put(key, 'vpc file content');
      const content = await files.get(key);
      assert.ok(content !== null);
      await files.delete(key);
    });
  });

  describe('AsyncJob', () => {
    test('submit does not throw', async () => {
      // Submit returns successfully if SQS endpoint is reachable
      await assert.doesNotReject(async () => {
        await job.submit({ message: 'vpc-smoke-test' });
      });
    });
  });

  describe('AppSetting', () => {
    test('get returns value', async () => {
      const value = await setting.get();
      assert.strictEqual(value, 'test-value');
    });
  });

  describe('Realtime', () => {
    test('publish does not throw', async () => {
      // Server-side publish verifies API Gateway management endpoint is reachable
      await assert.doesNotReject(async () => {
        await rt.publish('notifications', 'vpc-smoke-test', { text: 'vpc connectivity check' });
      });
    });

    test('client-side subscribe receives published message', async () => {
      // Validates execute-api/WebSocket endpoint is reachable from within the VPC.
      // getChannel() returns a Transferable with WebSocket URL + tokens.
      // subscribe() opens a WebSocket to the API Gateway WebSocket endpoint.
      const channelName = `subscribe-test-${Date.now()}`;
      const channel = await rt.getChannel('notifications', channelName);
      const received: Array<{ text: string }> = [];

      const sub = channel.subscribe((msg: { text: string }) => {
        received.push(msg);
      });

      // Wait for the WebSocket subscription to be established
      await sub.established;

      // Publish a message to the same channel — it should be delivered via WebSocket
      const testPayload = { text: `vpc-ws-${Date.now()}` };
      await rt.publish('notifications', channelName, testPayload);

      // Give the message time to arrive (WebSocket delivery)
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Verify the message was received via WebSocket subscription
      assert.ok(received.length >= 1, `Expected at least 1 message, got ${received.length}`);
      assert.strictEqual(received[0].text, testPayload.text);

      sub.unsubscribe();
    });
  });

  describe('Database (Aurora)', () => {
    test('simple SQL query via Data API', async () => {
      // Verifies RDS Data API + Secrets Manager endpoints are reachable from VPC.
      // Executes a simple query that doesn't require any table setup.
      const result = await db.query<{ ping: number }>(sql`SELECT 1 AS ping`);
      assert.ok(result.length >= 1, 'Expected at least one row from SELECT 1');
      assert.strictEqual(result[0].ping, 1);
    });

    test('create table, insert, and read back', async () => {
      // Create a temporary table, insert, and read back via Data API
      await db.execute(sql`CREATE TABLE IF NOT EXISTS vpc_smoke_test (id SERIAL PRIMARY KEY, value TEXT NOT NULL)`);
      await db.execute(sql`INSERT INTO vpc_smoke_test (value) VALUES (${'vpc-aurora-test'})`);
      const result = await db.query<{ value: string }>(sql`SELECT value FROM vpc_smoke_test WHERE value = ${'vpc-aurora-test'}`);
      assert.ok(result.length >= 1);
      assert.strictEqual(result[0].value, 'vpc-aurora-test');
      // Clean up
      await db.execute(sql`DROP TABLE IF EXISTS vpc_smoke_test`);
    });
  });

  describe('AuthCognito', () => {
    test('signUp reaches Cognito without network errors', async () => {
      // AuthCognito uses Cognito (internet) + SSM (VPC endpoint) + DynamoDB (VPC endpoint)
      // We test that the sign-up flow reaches Cognito without network errors.
      // A UserPool validation error (e.g., password policy) is acceptable — it
      // proves the service is reachable.
      const email = `vpc-smoke-${Date.now()}@example.com`;
      try {
        await auth.signUp(email, 'VpcTest1!', { attributes: { email } });
      } catch (e: any) {
        // Cognito policy errors are fine — they prove connectivity
        assert.ok(
          e.name === 'InvalidPasswordException' ||
          e.name === 'UsernameExistsException' ||
          e.name === 'InvalidParameterException' ||
          e.name === 'UserLambdaValidationException' ||
          e.message?.includes('password') ||
          e.message?.includes('Username'),
          `Unexpected error: ${e.name}: ${e.message}`,
        );
      }
    });
  });

  describe('Logger', () => {
    test('emit does not throw', () => {
      // Logger writes to stdout (CloudWatch Logs endpoint provisioned by framework)
      assert.doesNotThrow(() => {
        logger.info('vpc-smoke-test log entry');
      });
    });
  });

  describe('Metrics', () => {
    test('emit does not throw', () => {
      // Metrics uses EMF (stdout) — no direct VPC endpoint needed
      assert.doesNotThrow(() => {
        metrics.emit('VpcSmokeTest', 1, { unit: 'Count' });
      });
    });
  });

  describe('Tracer', () => {
    test('startSegment does not throw', async () => {
      // X-Ray uses the Lambda runtime agent — no direct VPC endpoint needed
      await assert.doesNotReject(async () => {
        await tracer.startSegment('vpc-smoke-test', async (segment) => {
          segment.addAnnotation('test', 'vpc-smoke');
          return 'ok';
        });
      });
    });
  });
});
