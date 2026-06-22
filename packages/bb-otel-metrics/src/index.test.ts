// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert';
import { OtelMetrics, OtelMetricsErrors } from './index.aws.js';

const fakeScope = { id: 'root' } as any;

afterEach(() => {
	delete (globalThis as any).__BLOCKS_OTEL_SDK__;
	delete (globalThis as any).__BLOCKS_OTEL_FLUSHERS__;
});

describe('OtelMetrics — scope + identity', () => {
	test('extends Scope (id, parent, fullId)', () => {
		const m = new OtelMetrics(fakeScope, 'metrics');
		assert.strictEqual(m.id, 'metrics');
		assert.strictEqual(m.parent, fakeScope);
		assert.strictEqual(m.fullId, 'root-metrics');
	});

	test('has no namespace property (replaced by OTel resource attributes)', () => {
		const m = new OtelMetrics(fakeScope, 'm') as any;
		assert.strictEqual(m.namespace, undefined);
	});

	test('metricsKind is otlp (Dashboard routes to PromQL widgets)', () => {
		assert.strictEqual(new OtelMetrics(fakeScope, 'm').metricsKind, 'otlp');
	});

	test('defaultDimensions exposed for Dashboard MetricsBBRef compat', () => {
		const m = new OtelMetrics(fakeScope, 'm', { defaultAttributes: { service: 'orders' } });
		assert.deepStrictEqual(m.defaultDimensions, { service: 'orders' });
	});

	test('accepts service identity + meterName options without throwing', () => {
		assert.doesNotThrow(() => new OtelMetrics(fakeScope, 'm', {
			serviceName: 'orders', serviceNamespace: 'shop', serviceVersion: '1.0.0', meterName: 'orders.metrics',
		}));
	});
});

describe('OtelMetrics — ergonomic emission', () => {
	test('emit / flush / child do not throw; units are UCUM', () => {
		const m = new OtelMetrics(fakeScope, 'm', { defaultAttributes: { env: 'test' } });
		assert.doesNotThrow(() => m.emit('request.count', 1, { unit: '1' }));
		assert.doesNotThrow(() => m.emit('latency', 42, { unit: 'ms', attributes: { route: '/a' } }));
		assert.doesNotThrow(() => m.emit('payload.size', 2048, { unit: 'By' }));
		assert.doesNotThrow(() => m.flush());
		const child = m.child({ component: 'db' });
		assert.doesNotThrow(() => child.emit('queries', 3));
	});

	test('no emitBatch method (OTel batches at export, not at the API)', () => {
		const m = new OtelMetrics(fakeScope, 'm') as any;
		assert.strictEqual(m.emitBatch, undefined);
	});

	test('child returns an emitter (not an OtelMetrics) with merged attributes', () => {
		const m = new OtelMetrics(fakeScope, 'm', { defaultAttributes: { a: '1' } });
		const child = m.child({ b: '2' });
		assert.ok(typeof child.emit === 'function');
		assert.ok(!(child instanceof OtelMetrics));
		assert.deepStrictEqual((child as any).defaultDimensions, { a: '1', b: '2' });
	});
});

describe('OtelMetrics — validation', () => {
	test('rejects empty metric name', () => {
		const m = new OtelMetrics(fakeScope, 'm');
		assert.throws(() => m.emit('', 1), (e: Error) => e.name === OtelMetricsErrors.InvalidMetricName);
	});

	test('rejects metric name > 255 chars', () => {
		const m = new OtelMetrics(fakeScope, 'm');
		assert.throws(() => m.emit('x'.repeat(256), 1), (e: Error) => e.name === OtelMetricsErrors.InvalidMetricName);
	});

	test('no BatchTooLarge error constant (batch API removed)', () => {
		assert.strictEqual((OtelMetricsErrors as any).BatchTooLarge, undefined);
	});
});

describe('OtelMetrics — typed instruments + escape hatch', () => {
	test('counter/histogram/upDownCounter/observableGauge return usable handles', () => {
		const m = new OtelMetrics(fakeScope, 'm');
		assert.ok(typeof m.counter('c').add === 'function');
		assert.ok(typeof m.histogram('h').record === 'function');
		assert.ok(typeof m.upDownCounter('u').add === 'function');
		assert.doesNotThrow(() => m.observableGauge('g', (r) => r.observe(1)));
	});

	test('rawMeter exposes the OTel Meter', () => {
		const m = new OtelMetrics(fakeScope, 'm');
		assert.ok(typeof m.rawMeter.createCounter === 'function');
	});

	test('registers an OTel flusher on construction', () => {
		new OtelMetrics(fakeScope, 'm');
		const flushers = (globalThis as any).__BLOCKS_OTEL_FLUSHERS__ as Set<unknown> | undefined;
		assert.ok(flushers && flushers.size >= 1);
	});
});
