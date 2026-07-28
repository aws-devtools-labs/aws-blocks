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
import { kv, table, files, job, setting, rt, auth, logger, metrics, tracer } from '../aws-blocks/index.js';

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
