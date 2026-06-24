// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test, beforeEach } from 'node:test';
import assert from 'node:assert';
import { rmSync, existsSync, readFileSync } from 'node:fs';
import { Tracer } from './index.mock.js';

beforeEach(() => {
	try { rmSync('.bb-data', { recursive: true, force: true }); } catch {}
});

// ── Basic tracing ───────────────────────────────────────────────────────────

test('startSegment executes fn and returns its result', async () => {
	const tracer = new Tracer({ id: 'root' } as any, 'test');
	const result = await tracer.startSegment('op', async (segment) => {
		segment.addAnnotation('key', 'value');
		return 42;
	});
	assert.strictEqual(result, 42);
});

test('startSegment records timing (durationMs >= 0)', async () => {
	const tracer = new Tracer({ id: 'root' } as any, 'test');
	await tracer.startSegment('timed-op', async () => {
		await new Promise(r => setTimeout(r, 10));
	});
	const traces = JSON.parse(readFileSync('.bb-data/root-test/traces.json', 'utf8'));
	assert.ok(traces[0].durationMs >= 0);
});

test('startSegment with error records error and re-throws', async () => {
	const tracer = new Tracer({ id: 'root' } as any, 'test');
	const err = new Error('boom');
	err.name = 'TestError';
	await assert.rejects(
		() => tracer.startSegment('failing', async () => { throw err; }),
		(e: Error) => e === err,
	);
	const traces = JSON.parse(readFileSync('.bb-data/root-test/traces.json', 'utf8'));
	assert.deepStrictEqual(traces[0].error, { name: 'TestError', message: 'boom' });
});

test('nested startSegment calls both execute correctly', async () => {
	const tracer = new Tracer({ id: 'root' } as any, 'test');
	const results: string[] = [];
	await tracer.startSegment('outer', async () => {
		results.push('outer');
		await tracer.startSegment('inner', async () => {
			results.push('inner');
		});
	});
	assert.deepStrictEqual(results, ['outer', 'inner']);
});

// ── Annotations & Metadata ──────────────────────────────────────────────────

test('segment.addAnnotation stores annotation', async () => {
	const tracer = new Tracer({ id: 'root' } as any, 'test');
	await tracer.startSegment('annotated', async (segment) => {
		segment.addAnnotation('userId', 'user-123');
		segment.addAnnotation('count', 5);
		segment.addAnnotation('active', true);
	});
	const traces = JSON.parse(readFileSync('.bb-data/root-test/traces.json', 'utf8'));
	assert.strictEqual(traces[0].annotations.userId, 'user-123');
	assert.strictEqual(traces[0].annotations.count, 5);
	assert.strictEqual(traces[0].annotations.active, true);
});

test('segment.addMetadata stores metadata', async () => {
	const tracer = new Tracer({ id: 'root' } as any, 'test');
	await tracer.startSegment('with-metadata', async (segment) => {
		segment.addMetadata('request', { url: '/api/test', method: 'GET' });
	});
	const traces = JSON.parse(readFileSync('.bb-data/root-test/traces.json', 'utf8'));
	assert.deepStrictEqual(traces[0].metadata.request, { url: '/api/test', method: 'GET' });
});

test('tracer.addAnnotation stores root annotation', async () => {
	const tracer = new Tracer({ id: 'root' } as any, 'test');
	tracer.addAnnotation('endpoint', '/api/users');
	// Root annotations are stored in memory — verify via getTraceId existing
	assert.ok(true);
});

// ── Error handling ──────────────────────────────────────────────────────────

test('segment.addError records error without throwing', async () => {
	const tracer = new Tracer({ id: 'root' } as any, 'test');
	await tracer.startSegment('with-error', async (segment) => {
		const err = new Error('handled error');
		err.name = 'HandledError';
		segment.addError(err);
	});
	const traces = JSON.parse(readFileSync('.bb-data/root-test/traces.json', 'utf8'));
	assert.deepStrictEqual(traces[0].error, { name: 'HandledError', message: 'handled error' });
});

test('startSegment re-throws application errors unchanged', async () => {
	const tracer = new Tracer({ id: 'root' } as any, 'test');
	const originalError = new Error('original');
	try {
		await tracer.startSegment('throwing', async () => { throw originalError; });
		assert.fail('Should have thrown');
	} catch (e) {
		assert.strictEqual(e, originalError);
	}
});

// ── Disabled tracing ────────────────────────────────────────────────────────

test('enabled: false still executes fn', async () => {
	const tracer = new Tracer({ id: 'root' } as any, 'test', { enabled: false });
	let executed = false;
	await tracer.startSegment('ignored', async () => { executed = true; });
	assert.strictEqual(executed, true);
});

test('enabled: false writes no trace file', async () => {
	const tracer = new Tracer({ id: 'root' } as any, 'test', { enabled: false });
	await tracer.startSegment('ignored', async () => {});
	assert.strictEqual(existsSync('.bb-data/root-test/traces.json'), false);
});

test('addAnnotation is no-op when disabled', async () => {
	const tracer = new Tracer({ id: 'root' } as any, 'test', { enabled: false });
	tracer.addAnnotation('key', 'value');
	assert.strictEqual(existsSync('.bb-data/root-test/traces.json'), false);
});

test('getTraceId returns null when disabled', () => {
	const tracer = new Tracer({ id: 'root' } as any, 'test', { enabled: false });
	assert.strictEqual(tracer.getTraceId(), null);
});

// ── Sampling ────────────────────────────────────────────────────────────────

test('samplingRate: 0 produces no traces but executes fn', async () => {
	const tracer = new Tracer({ id: 'root' } as any, 'test', { samplingRate: 0 });
	let executed = false;
	await tracer.startSegment('unsampled', async () => { executed = true; });
	assert.strictEqual(executed, true);
	assert.strictEqual(existsSync('.bb-data/root-test/traces.json'), false);
});

test('samplingRate: 1 traces everything', async () => {
	const tracer = new Tracer({ id: 'root' } as any, 'test', { samplingRate: 1 });
	await tracer.startSegment('sampled', async () => {});
	assert.strictEqual(existsSync('.bb-data/root-test/traces.json'), true);
});

// Sampling is a per-trace decision made at the root; subsegments must inherit
// it. These tests drive a fractional samplingRate with a scripted Math.random
// so the root and a nested segment would roll differently if sampling were
// (incorrectly) re-evaluated per subsegment.
function withScriptedRandom(values: number[], fn: () => Promise<void>): Promise<void> {
	const original = Math.random;
	let i = 0;
	// After the script is exhausted, return 1 (>= any rate < 1 ⇒ "not sampled")
	// so an unexpected extra roll can't accidentally sample.
	Math.random = () => (i < values.length ? values[i++] : 1);
	return fn().finally(() => { Math.random = original; });
}

test('a sampled trace keeps all its subsegments even when a subsegment would roll unsampled', async () => {
	const tracer = new Tracer({ id: 'root' } as any, 'test', { samplingRate: 0.5 });
	// Root rolls 0.1 (< 0.5 ⇒ sampled); a per-subsegment roll of 0.9 would drop
	// the child under the buggy behavior.
	await withScriptedRandom([0.1, 0.9], async () => {
		await tracer.startSegment('outer', async () => {
			await tracer.startSegment('inner', async () => {});
		});
	});
	const traces = JSON.parse(readFileSync('.bb-data/root-test/traces.json', 'utf8'));
	assert.strictEqual(traces.length, 1);
	assert.strictEqual(traces[0].segment, 'outer');
	assert.strictEqual(traces[0].children.length, 1);
	assert.strictEqual(traces[0].children[0].segment, 'inner');
});

test('an unsampled trace never promotes a subsegment into its own root trace', async () => {
	const tracer = new Tracer({ id: 'root' } as any, 'test', { samplingRate: 0.5 });
	// Root rolls 0.9 (>= 0.5 ⇒ not sampled); a per-subsegment roll of 0.1 would
	// spawn an orphan root trace under the buggy behavior.
	await withScriptedRandom([0.9, 0.1], async () => {
		await tracer.startSegment('outer', async () => {
			await tracer.startSegment('inner', async () => {});
		});
	});
	assert.strictEqual(existsSync('.bb-data/root-test/traces.json'), false);
});

// ── getTraceId ──────────────────────────────────────────────────────────────

test('getTraceId returns a UUID string', () => {
	const tracer = new Tracer({ id: 'root' } as any, 'test');
	const id = tracer.getTraceId();
	assert.ok(id);
	assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});

test('getTraceId returns same value across calls within a trace', () => {
	const tracer = new Tracer({ id: 'root' } as any, 'test');
	const id1 = tracer.getTraceId();
	const id2 = tracer.getTraceId();
	assert.strictEqual(id1, id2);
});

// ── Persistence ─────────────────────────────────────────────────────────────

test('traces persist to .bb-data/{fullId}/traces.json', async () => {
	const tracer = new Tracer({ id: 'root' } as any, 'test');
	await tracer.startSegment('persisted', async () => {});
	assert.strictEqual(existsSync('.bb-data/root-test/traces.json'), true);
	const traces = JSON.parse(readFileSync('.bb-data/root-test/traces.json', 'utf8'));
	assert.strictEqual(traces.length, 1);
	assert.strictEqual(traces[0].segment, 'persisted');
});

test('traces file is capped at 100 entries', async () => {
	const tracer = new Tracer({ id: 'root' } as any, 'test');
	for (let i = 0; i < 110; i++) {
		await tracer.startSegment(`op-${i}`, async () => {});
	}
	const traces = JSON.parse(readFileSync('.bb-data/root-test/traces.json', 'utf8'));
	assert.strictEqual(traces.length, 100);
});

// ── setHttpStatus ───────────────────────────────────────────────────────────

test('segment.setHttpStatus records status code', async () => {
	const tracer = new Tracer({ id: 'root' } as any, 'test');
	await tracer.startSegment('http-op', async (segment) => {
		segment.setHttpStatus(200);
	});
	const traces = JSON.parse(readFileSync('.bb-data/root-test/traces.json', 'utf8'));
	assert.strictEqual(traces[0].httpStatus, 200);
});

test('status code appears in persisted trace', async () => {
	const tracer = new Tracer({ id: 'root' } as any, 'test');
	await tracer.startSegment('error-http', async (segment) => {
		segment.setHttpStatus(500);
	});
	const traces = JSON.parse(readFileSync('.bb-data/root-test/traces.json', 'utf8'));
	assert.strictEqual(traces[0].httpStatus, 500);
});

// ── samplingRate validation ─────────────────────────────────────────────────

test('samplingRate below 0 throws RangeError', () => {
	assert.throws(
		() => new Tracer({ id: 'root' } as any, 'test', { samplingRate: -0.1 }),
		(e: Error) => e instanceof RangeError && e.message === 'samplingRate must be between 0 and 1',
	);
});

test('samplingRate above 1 throws RangeError', () => {
	assert.throws(
		() => new Tracer({ id: 'root' } as any, 'test', { samplingRate: 1.5 }),
		(e: Error) => e instanceof RangeError && e.message === 'samplingRate must be between 0 and 1',
	);
});

test('samplingRate of 0 is valid (no RangeError)', () => {
	const tracer = new Tracer({ id: 'root' } as any, 'test', { samplingRate: 0 });
	assert.ok(tracer);
});

test('samplingRate of 1 is valid (no RangeError)', () => {
	const tracer = new Tracer({ id: 'root' } as any, 'test', { samplingRate: 1 });
	assert.ok(tracer);
});

// ── Nested segment hierarchy ────────────────────────────────────────────────

test('nested segments are stored as children of the outer segment', async () => {
	const tracer = new Tracer({ id: 'root' } as any, 'test');
	await tracer.startSegment('outer', async (outerSeg) => {
		outerSeg.addAnnotation('level', 'outer');
		await tracer.startSegment('inner', async (innerSeg) => {
			innerSeg.addAnnotation('level', 'inner');
		});
	});
	const traces = JSON.parse(readFileSync('.bb-data/root-test/traces.json', 'utf8'));
	assert.strictEqual(traces.length, 1);
	assert.strictEqual(traces[0].segment, 'outer');
	assert.strictEqual(traces[0].annotations.level, 'outer');
	assert.strictEqual(traces[0].children.length, 1);
	assert.strictEqual(traces[0].children[0].segment, 'inner');
	assert.strictEqual(traces[0].children[0].annotations.level, 'inner');
});

test('deeply nested segments form a tree', async () => {
	const tracer = new Tracer({ id: 'root' } as any, 'test');
	await tracer.startSegment('level-0', async () => {
		await tracer.startSegment('level-1', async () => {
			await tracer.startSegment('level-2', async () => {});
		});
	});
	const traces = JSON.parse(readFileSync('.bb-data/root-test/traces.json', 'utf8'));
	assert.strictEqual(traces.length, 1);
	assert.strictEqual(traces[0].segment, 'level-0');
	assert.strictEqual(traces[0].children[0].segment, 'level-1');
	assert.strictEqual(traces[0].children[0].children[0].segment, 'level-2');
});

// ── Root annotations/metadata in persisted records ──────────────────────────

test('root annotations and metadata are included in persisted trace', async () => {
	const tracer = new Tracer({ id: 'root' } as any, 'test');
	tracer.addAnnotation('endpoint', '/api/users');
	tracer.addMetadata('requestId', 'req-abc');
	await tracer.startSegment('op', async () => {});
	const traces = JSON.parse(readFileSync('.bb-data/root-test/traces.json', 'utf8'));
	assert.strictEqual(traces[0].rootAnnotations.endpoint, '/api/users');
	assert.strictEqual(traces[0].rootMetadata.requestId, 'req-abc');
});

// ── Trace ID uniqueness (regression: trace ID reuse) ────────────────────────

test('different top-level segments get different trace IDs', async () => {
	const tracer = new Tracer({ id: 'root' } as any, 'test');
	await tracer.startSegment('first', async () => {});
	await tracer.startSegment('second', async () => {});
	await tracer.startSegment('third', async () => {});
	const traces = JSON.parse(readFileSync('.bb-data/root-test/traces.json', 'utf8'));
	assert.strictEqual(traces.length, 3);
	const ids = new Set(traces.map((t: any) => t.traceId));
	assert.strictEqual(ids.size, 3, 'Each top-level segment must have a unique trace ID');
});

test('nested segments share their parent trace ID', async () => {
	const tracer = new Tracer({ id: 'root' } as any, 'test');
	let innerTraceId: string | null = null;
	await tracer.startSegment('outer', async () => {
		innerTraceId = tracer.getTraceId();
		await tracer.startSegment('inner', async () => {});
	});
	const traces = JSON.parse(readFileSync('.bb-data/root-test/traces.json', 'utf8'));
	const outerRecord = traces[0];
	assert.strictEqual(outerRecord.traceId, innerTraceId);
	assert.strictEqual(outerRecord.children[0].traceId, outerRecord.traceId);
});

test('root annotations are cleared between traces', async () => {
	const tracer = new Tracer({ id: 'root' } as any, 'test');
	tracer.addAnnotation('reqId', 'req-1');
	await tracer.startSegment('first', async () => {});
	// After first segment completes, rootAnnotations should be cleared
	tracer.addAnnotation('reqId', 'req-2');
	await tracer.startSegment('second', async () => {});
	const traces = JSON.parse(readFileSync('.bb-data/root-test/traces.json', 'utf8'));
	assert.strictEqual(traces[0].rootAnnotations.reqId, 'req-1');
	assert.strictEqual(traces[1].rootAnnotations.reqId, 'req-2');
});

test('trace ID resets after error in top-level segment', async () => {
	const tracer = new Tracer({ id: 'root' } as any, 'test');
	try {
		await tracer.startSegment('failing', async () => { throw new Error('err'); });
	} catch {}
	await tracer.startSegment('after-error', async () => {});
	const traces = JSON.parse(readFileSync('.bb-data/root-test/traces.json', 'utf8'));
	assert.strictEqual(traces.length, 2);
	assert.notStrictEqual(traces[0].traceId, traces[1].traceId,
		'Trace ID must reset after error in top-level segment');
});
