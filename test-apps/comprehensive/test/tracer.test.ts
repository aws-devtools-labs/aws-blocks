// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, test } from 'node:test';
import assert from 'node:assert';
import type { api as apiType } from 'cdk-blocks';

export function tracerTests(getApi: () => typeof apiType) {

  describe('Tracer', () => {

    test('startSegment executes fn and returns result', async () => {
      const api = getApi();
      const result = await api.tracerStartSegment('test-op');
      assert.deepStrictEqual(result, { traced: true });
    });

    test('getTraceId returns a valid trace ID', async () => {
      const api = getApi();
      const { traceId } = await api.tracerGetTraceId();
      assert.ok(traceId, 'traceId should not be null');
      assert.ok(typeof traceId === 'string');
      assert.ok(traceId.length > 0);
    });

    test('addAnnotation succeeds', async () => {
      const api = getApi();
      const result = await api.tracerAddAnnotation('region', 'us-east-1');
      assert.deepStrictEqual(result, { success: true });
    });

    test('addMetadata succeeds', async () => {
      const api = getApi();
      const result = await api.tracerAddMetadata('context', { requestId: '123' });
      assert.deepStrictEqual(result, { success: true });
    });

    test('startSegment with error records error', async () => {
      const api = getApi();
      const result = await api.tracerStartSegmentWithError();
      assert.deepStrictEqual(result, { errorRecorded: true });
    });

    test('startSegment with HTTP status succeeds', async () => {
      const api = getApi();
      const result = await api.tracerStartSegmentWithHttpStatus(200);
      assert.deepStrictEqual(result, { success: true });
    });

    test('disabled tracer still executes fn but returns null traceId', async () => {
      const api = getApi();
      const result = await api.tracerDisabledExecutesFn();
      assert.strictEqual(result.executed, true);
      assert.strictEqual(result.traceId, null);
    });
  });
}
