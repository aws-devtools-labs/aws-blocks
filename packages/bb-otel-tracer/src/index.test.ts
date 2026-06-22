// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert';
import { SpanKind } from '@opentelemetry/api';
import { OtelTracer } from './index.aws.js';

const fakeScope = { id: 'root' } as any;

afterEach(() => {
	delete (globalThis as any).__BLOCKS_OTEL_SDK__;
	delete (globalThis as any).__BLOCKS_OTEL_FLUSHERS__;
});

describe('OtelTracer — startSegment', () => {
	test('returns the wrapped fn result and passes a segment', async () => {
		const t = new OtelTracer(fakeScope, 'tracer');
		let gotSegment = false;
		const result = await t.startSegment('fetch.user', async (segment) => {
			gotSegment = typeof segment.addAnnotation === 'function';
			segment.addAnnotation('user.id', 'u1');
			segment.addMetadata('payload', { a: 1 });
			segment.addEvent('did-work', { step: 'compute' });
			segment.setHttpStatus(200);
			return 42;
		});
		assert.strictEqual(result, 42);
		assert.ok(gotSegment);
	});

	test('records and re-throws errors', async () => {
		const t = new OtelTracer(fakeScope, 'tracer');
		await assert.rejects(
			() => t.startSegment('boom', async () => { throw new Error('kaboom'); }),
			/kaboom/,
		);
	});

	test('honors span kind + links options without throwing', async () => {
		const t = new OtelTracer(fakeScope, 'tracer');
		await assert.doesNotReject(() =>
			t.startSegment('srv', async () => 'ok', { kind: SpanKind.SERVER, attributes: { route: '/a' } }),
		);
	});

	test('getTraceId returns a real id inside a segment', async () => {
		const t = new OtelTracer(fakeScope, 'tracer');
		const id = await t.startSegment('seg', async () => t.getTraceId());
		assert.match(String(id), /^[0-9a-f]{32}$/);
	});
});

describe('OtelTracer — disabled', () => {
	test('still executes the wrapped fn and reports null trace id', async () => {
		const t = new OtelTracer(fakeScope, 'tracer', { enabled: false });
		let ran = false;
		const r = await t.startSegment('noop', async () => { ran = true; return 7; });
		assert.strictEqual(r, 7);
		assert.ok(ran);
		assert.strictEqual(t.getTraceId(), null);
	});
});

describe('OtelTracer — propagation + escape hatch', () => {
	test('inject writes a traceparent into the carrier inside an active span', async () => {
		const t = new OtelTracer(fakeScope, 'tracer');
		const carrier: Record<string, string> = {};
		await t.startSegment('seg', async () => { t.inject(carrier); });
		assert.ok('traceparent' in carrier, `carrier had keys: ${Object.keys(carrier).join(',')}`);
	});

	test('extract returns a context object', () => {
		const t = new OtelTracer(fakeScope, 'tracer');
		const ctx = t.extract({ traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01' });
		assert.ok(ctx);
	});

	test('rawTracer exposes the OTel Tracer', () => {
		const t = new OtelTracer(fakeScope, 'tracer');
		assert.ok(typeof t.rawTracer.startSpan === 'function');
		assert.ok(typeof t.rawTracer.startActiveSpan === 'function');
	});

	test('registers an OTel flusher on construction', () => {
		new OtelTracer(fakeScope, 'tracer');
		const flushers = (globalThis as any).__BLOCKS_OTEL_FLUSHERS__ as Set<unknown> | undefined;
		assert.ok(flushers && flushers.size >= 1);
	});
});
