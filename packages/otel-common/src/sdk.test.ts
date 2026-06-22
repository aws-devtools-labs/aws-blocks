// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert';
import { trace, metrics } from '@opentelemetry/api';
import { logs } from '@opentelemetry/api-logs';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import { InMemoryMetricExporter, AggregationTemporality } from '@opentelemetry/sdk-metrics';
import { InMemoryLogRecordExporter } from '@opentelemetry/sdk-logs';
import {
	getOrCreateOtelSdk,
	registerOtelFlusher,
	flushOtel,
	getOtelMeterProvider,
	getOtelTracerProvider,
	getOtelLoggerProvider,
} from './sdk.js';
import type { OtelExporters } from './sdk.js';

function inMemoryExporters(): OtelExporters {
	return {
		traceExporter: () => new InMemorySpanExporter(),
		metricExporter: () => new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE),
		logExporter: () => new InMemoryLogRecordExporter(),
	};
}

const savedEnv = { ...process.env };

afterEach(() => {
	// Reset process-global SDK + flushers between tests.
	delete (globalThis as any).__BLOCKS_OTEL_SDK__;
	delete (globalThis as any).__BLOCKS_OTEL_FLUSHERS__;
	delete (globalThis as any).__BLOCKS_OTEL_FLUSH__;
	// Restore env (tests mutate BLOCKS_STACK_NAME / AWS_* for resource detection).
	for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
	Object.assign(process.env, savedEnv);
});

describe('getOrCreateOtelSdk', () => {
	test('wires up a real (non-noop) tracer — spans get valid, non-zero contexts', () => {
		getOrCreateOtelSdk({ resource: { serviceName: 'test-svc' } }, inMemoryExporters());
		const span = trace.getTracer('test').startSpan('probe');
		const ctx = span.spanContext();
		span.end();
		assert.match(ctx.traceId, /^[0-9a-f]{32}$/);
		assert.notStrictEqual(ctx.traceId, '0'.repeat(32));
	});

	test('registers non-noop meter and logger providers', () => {
		getOrCreateOtelSdk({ resource: { serviceName: 'test-svc' } }, inMemoryExporters());
		const meterName = (metrics.getMeterProvider() as any)?.constructor?.name ?? '';
		const loggerName = (logs.getLoggerProvider() as any)?.constructor?.name ?? '';
		assert.doesNotMatch(meterName, /noop/i, `meter provider was ${meterName}`);
		assert.doesNotMatch(loggerName, /noop/i, `logger provider was ${loggerName}`);
	});

	test('is a singleton — repeated calls return the same instance', () => {
		const a = getOrCreateOtelSdk({ resource: { serviceName: 'test-svc' } }, inMemoryExporters());
		const b = getOrCreateOtelSdk({ resource: { serviceName: 'other-svc' } }, inMemoryExporters());
		assert.strictEqual(a, b);
	});
});

// The SDK 2.x MeterProvider stores its Resource privately at `_sharedState.resource`;
// we read it directly to assert our resource-building logic (a focused unit test of our
// own wiring, not the SDK's public contract).
describe('resource (service identity + detection)', () => {
	test('sets service.name/namespace/version from explicit options', () => {
		const sdk = getOrCreateOtelSdk({
			resource: { serviceName: 'orders', serviceNamespace: 'shop', serviceVersion: '1.2.3' },
		}, inMemoryExporters());
		const attrs = (sdk.meterProvider as any)._sharedState?.resource?.attributes ?? {};
		assert.strictEqual(attrs['service.name'], 'orders');
		assert.strictEqual(attrs['service.namespace'], 'shop');
		assert.strictEqual(attrs['service.version'], '1.2.3');
	});

	test('defaults service.name to the Lambda function name when present', () => {
		delete process.env.BLOCKS_STACK_NAME;
		process.env.AWS_LAMBDA_FUNCTION_NAME = 'my-fn';
		const sdk = getOrCreateOtelSdk({ defaultServiceName: 'fallback-id' }, inMemoryExporters());
		const attrs = (sdk.meterProvider as any)._sharedState?.resource?.attributes ?? {};
		assert.strictEqual(attrs['service.name'], 'my-fn');
	});

	test('falls back to BLOCKS_STACK_NAME when no Lambda function name', () => {
		delete process.env.AWS_LAMBDA_FUNCTION_NAME;
		process.env.BLOCKS_STACK_NAME = 'my-stack';
		const sdk = getOrCreateOtelSdk({ defaultServiceName: 'fallback-id' }, inMemoryExporters());
		const attrs = (sdk.meterProvider as any)._sharedState?.resource?.attributes ?? {};
		assert.strictEqual(attrs['service.name'], 'my-stack');
	});

	test('local dev (no Lambda/stack env) → service.name is the block fullId, never unknown_service', () => {
		delete process.env.AWS_LAMBDA_FUNCTION_NAME;
		delete process.env.BLOCKS_STACK_NAME;
		const sdk = getOrCreateOtelSdk({ defaultServiceName: 'my-app-metrics' }, inMemoryExporters());
		const attrs = (sdk.meterProvider as any)._sharedState?.resource?.attributes ?? {};
		assert.strictEqual(attrs['service.name'], 'my-app-metrics');
		assert.doesNotMatch(String(attrs['service.name']), /unknown_service/);
	});

	test('merges AWS Lambda detected attributes (faas.*/cloud.*) when in a Lambda env', () => {
		// Satisfy the awsLambdaDetector guard + the env vars it reads.
		process.env.AWS_EXECUTION_ENV = 'AWS_Lambda_nodejs20.x';
		process.env.AWS_REGION = 'us-east-1';
		process.env.AWS_LAMBDA_FUNCTION_NAME = 'fn-x';
		process.env.AWS_LAMBDA_FUNCTION_VERSION = '$LATEST';
		process.env.AWS_LAMBDA_FUNCTION_MEMORY_SIZE = '512';
		const sdk = getOrCreateOtelSdk({ resource: { serviceName: 'orders' } }, inMemoryExporters());
		const attrs = (sdk.meterProvider as any)._sharedState?.resource?.attributes ?? {};
		assert.strictEqual(attrs['service.name'], 'orders', 'explicit service.name preserved');
		assert.strictEqual(attrs['cloud.provider'], 'aws');
		assert.strictEqual(attrs['cloud.platform'], 'aws_lambda');
		assert.strictEqual(attrs['faas.name'], 'fn-x');
	});
});

describe('provider accessors (library escape hatch)', () => {
	test('return the initialized SDK providers', () => {
		const sdk = getOrCreateOtelSdk({ resource: { serviceName: 'test-svc' } }, inMemoryExporters());
		assert.strictEqual(getOtelMeterProvider(), sdk.meterProvider);
		assert.strictEqual(getOtelTracerProvider(), sdk.tracerProvider);
		assert.strictEqual(getOtelLoggerProvider(), sdk.loggerProvider);
	});

	test('do not throw when no SDK is initialized (fall back to API global)', () => {
		assert.doesNotThrow(() => getOtelMeterProvider());
		assert.doesNotThrow(() => getOtelTracerProvider());
		assert.doesNotThrow(() => getOtelLoggerProvider());
		// A library can get a correctly-named meter off the returned provider.
		const meter = getOtelMeterProvider().getMeter('their-lib', '1.0');
		assert.ok(typeof meter.createCounter === 'function');
	});
});

describe('flushOtel', () => {
	test('is a safe no-op when no SDK is initialized', async () => {
		await assert.doesNotReject(flushOtel());
	});

	test('invokes every registered flusher', async () => {
		let calls = 0;
		registerOtelFlusher(async () => { calls++; });
		registerOtelFlusher(async () => { calls++; });
		await flushOtel();
		assert.strictEqual(calls, 2);
	});

	test('does not throw when a flusher rejects (telemetry loss must not fail the request)', async () => {
		registerOtelFlusher(async () => { throw new Error('export failed'); });
		await assert.doesNotReject(flushOtel());
	});

	test('getOrCreateOtelSdk auto-registers a flusher', async () => {
		getOrCreateOtelSdk({ resource: { serviceName: 'test-svc' } }, inMemoryExporters());
		const flushers = (globalThis as any).__BLOCKS_OTEL_FLUSHERS__ as Set<unknown>;
		assert.ok(flushers && flushers.size >= 1);
		await assert.doesNotReject(flushOtel());
	});
});
