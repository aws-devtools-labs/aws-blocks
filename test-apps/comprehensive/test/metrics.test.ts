// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test, describe } from 'node:test';
import assert from 'node:assert';
import type { api as apiType } from 'cdk-blocks';

export function metricsTests(getApi: () => typeof apiType) {
  describe('Metrics BB', () => {

    test('Metrics - emit single metric returns success', async () => {
      const api = getApi();
      const result = await api.metricsEmit('RequestCount', 1);
      assert.deepStrictEqual(result, { success: true });
    });

    test('Metrics - emit with unit returns success', async () => {
      const api = getApi();
      const result = await api.metricsEmit('Latency', 42, { unit: 'Milliseconds' });
      assert.deepStrictEqual(result, { success: true });
    });

    test('Metrics - emit with dimensions returns success', async () => {
      const api = getApi();
      const result = await api.metricsEmit('ErrorCount', 0, {
        unit: 'Count',
        dimensions: { endpoint: '/api/test', method: 'GET' },
      });
      assert.deepStrictEqual(result, { success: true });
    });

    test('Metrics - emit with high resolution returns success', async () => {
      const api = getApi();
      const result = await api.metricsEmit('CPUSpike', 95.2, {
        unit: 'Percent',
        resolution: 'high',
      });
      assert.deepStrictEqual(result, { success: true });
    });

    test('Metrics - emitBatch returns success', async () => {
      const api = getApi();
      const result = await api.metricsEmitBatch([
        { name: 'RequestCount', value: 1, unit: 'Count' },
        { name: 'Latency', value: 42, unit: 'Milliseconds' },
        { name: 'ErrorCount', value: 0, unit: 'Count' },
      ]);
      assert.deepStrictEqual(result, { success: true });
    });

    test('Metrics - emit bare (no default dimensions) returns success', async () => {
      const api = getApi();
      const result = await api.metricsEmitBare('SimpleMetric', 100);
      assert.deepStrictEqual(result, { success: true });
    });

    test('Metrics - child emitter returns success', async () => {
      const api = getApi();
      const result = await api.metricsChild(
        { endpoint: '/api/orders', method: 'POST' },
        'OrderPlaced',
        1,
      );
      assert.deepStrictEqual(result, { success: true });
    });

    test('Metrics - flush returns success (no-op)', async () => {
      const api = getApi();
      const result = await api.metricsFlush();
      assert.deepStrictEqual(result, { success: true });
    });

    test('Metrics - emit rejects empty metric name', async () => {
      const api = getApi();
      await assert.rejects(
        () => api.metricsEmit('', 1),
        /InvalidMetricNameException/,
      );
    });

    test('Metrics - emitBatch rejects invalid metric name in batch', async () => {
      const api = getApi();
      await assert.rejects(
        () => api.metricsEmitBatch([{ name: '', value: 1 }]),
        /InvalidMetricNameException/,
      );
    });

  });
}
