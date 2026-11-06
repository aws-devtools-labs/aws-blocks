// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { Scope } from '@aws-blocks/core';
import { Tracer } from './index.mock.js';

interface TraceRecord {
	traceId: string;
	segment: string;
	endTime: number;
	rootAnnotations: Record<string, unknown>;
	rootMetadata: Record<string, unknown>;
	error?: { name: string; message: string };
	children: TraceRecord[];
}

function gate() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => { resolve = done; });
	return { promise, resolve };
}

function readTraces(id = 'test'): TraceRecord[] {
	return JSON.parse(readFileSync(`.bb-data/concurrent-${id}/traces.json`, 'utf8'));
}

beforeEach(() => {
	rmSync('.bb-data', { recursive: true, force: true });
});

test('overlapping roots keep separate IDs, annotations, metadata and completed records', async () => {
	const tracer = new Tracer(new Scope('concurrent'), 'test');
	const firstRelease = gate();
	const secondRelease = gate();
	const ids: Array<string | null> = [];
	const first = tracer.startSegment('first', async () => {
		ids.push(tracer.getTraceId());
		tracer.addAnnotation('request', 'first');
		tracer.addMetadata('request', { id: 'first' });
		await firstRelease.promise;
		assert.equal(tracer.getTraceId(), ids[0]);
	});
	const second = tracer.startSegment('second', async () => {
		ids.push(tracer.getTraceId());
		tracer.addAnnotation('request', 'second');
		tracer.addMetadata('request', { id: 'second' });
		await secondRelease.promise;
		assert.equal(tracer.getTraceId(), ids[1]);
	});
	firstRelease.resolve();
	secondRelease.resolve();
	await Promise.all([first, second]);
	assert.notEqual(ids[0], ids[1]);
	const traces = readTraces();
	assert.equal(traces.length, 2);
	for (const [index, name] of ['first', 'second'].entries()) {
		const trace = traces[index];
		assert.equal(trace.segment, name);
		assert.equal(trace.traceId, ids[index]);
		assert.deepEqual(trace.children, []);
		assert.ok(trace.endTime > 0);
		assert.deepEqual(trace.rootAnnotations, { request: name });
		assert.deepEqual(trace.rootMetadata, { request: { id: name } });
	}
});

test('parallel children remain siblings with their own nested descendants', async () => {
	const tracer = new Tracer(new Scope('concurrent'), 'test');
	const firstRelease = gate();
	const secondRelease = gate();
	await tracer.startSegment('outer', async () => {
		const first = tracer.startSegment('first', async () => {
			await firstRelease.promise;
			await tracer.startSegment('first-child', async () => {});
		});
		const second = tracer.startSegment('second', async () => {
			await secondRelease.promise;
			await tracer.startSegment('second-child', async () => {});
		});
		firstRelease.resolve();
		secondRelease.resolve();
		await Promise.all([first, second]);
		await tracer.startSegment('after', async () => {});
	});
	const [outer] = readTraces();
	assert.deepEqual(outer.children.map((child) => child.segment), ['first', 'second', 'after']);
	for (const child of outer.children) {
		assert.equal(child.traceId, outer.traceId);
		assert.ok(child.endTime > 0);
	}
	assert.deepEqual(outer.children[0].children.map((child) => child.segment), ['first-child']);
	assert.deepEqual(outer.children[1].children.map((child) => child.segment), ['second-child']);
});

for (const rolls of [[0.9, 0.1], [0.1, 0.9]]) {
	test(`overlapping roots make independent sampling decisions (${rolls.join(', ')})`, async () => {
		const tracer = new Tracer(new Scope('concurrent'), 'test', { samplingRate: 0.5 });
		const release = gate();
		const originalRandom = Math.random;
		let calls = 0;
		Math.random = () => rolls[calls++] ?? 1;
		try {
			const run = (name: string) => tracer.startSegment(name, async () => {
				await release.promise;
				await tracer.startSegment(`${name}-child`, async () => {});
			});
			const first = run('first');
			const second = run('second');
			release.resolve();
			await Promise.all([first, second]);
		} finally {
			Math.random = originalRandom;
		}
		assert.equal(calls, 2, 'sampling must run once per root, never per child');
		const traces = readTraces();
		assert.equal(traces.length, 1);
		const sampledName = rolls[0] < 0.5 ? 'first' : 'second';
		assert.equal(traces[0].segment, sampledName);
		assert.deepEqual(traces[0].children.map((child) => child.segment), [`${sampledName}-child`]);
	});
}

test('a failing parallel child restores its parent without affecting its sibling', async () => {
	const tracer = new Tracer(new Scope('concurrent'), 'test');
	const release = gate();
	const error = new Error('child failed');
	await tracer.startSegment('outer', async () => {
		const failing = tracer.startSegment('failing', async () => {
			await release.promise;
			throw error;
		});
		const rejection = assert.rejects(failing, (caught: unknown) => caught === error);
		const sibling = tracer.startSegment('sibling', async () => {
			await release.promise;
			await tracer.startSegment('descendant', async () => {});
		});
		release.resolve();
		await Promise.all([rejection, sibling]);
		await tracer.startSegment('after', async () => {});
	});
	const [outer] = readTraces();
	assert.deepEqual(outer.children.map((child) => child.segment), ['failing', 'sibling', 'after']);
	assert.deepEqual(outer.children[0].error, { name: 'Error', message: error.message });
	assert.deepEqual(outer.children[1].children.map((child) => child.segment), ['descendant']);
	assert.equal(outer.error, undefined);
});

test('annotations and IDs staged outside a segment belong only to the next root', async () => {
	const tracer = new Tracer(new Scope('concurrent'), 'test');
	const firstId = tracer.getTraceId();
	tracer.addAnnotation('request', 'first');
	tracer.addMetadata('request', 'first');
	const release = gate();
	const first = tracer.startSegment('first', async () => { await release.promise; });
	const secondId = tracer.getTraceId();
	tracer.addAnnotation('request', 'second');
	tracer.addMetadata('request', 'second');
	const second = tracer.startSegment('second', async () => {});
	release.resolve();
	await Promise.all([first, second]);
	assert.notEqual(firstId, secondId);
	const traces = readTraces();
	const firstTrace = traces.find((trace) => trace.segment === 'first');
	const secondTrace = traces.find((trace) => trace.segment === 'second');
	assert.ok(firstTrace);
	assert.ok(secondTrace);
	assert.equal(firstTrace.traceId, firstId);
	assert.equal(secondTrace.traceId, secondId);
	assert.deepEqual(firstTrace.rootAnnotations, { request: 'first' });
	assert.deepEqual(secondTrace.rootAnnotations, { request: 'second' });
	assert.deepEqual(firstTrace.rootMetadata, { request: 'first' });
	assert.deepEqual(secondTrace.rootMetadata, { request: 'second' });
});

test('unsampled root annotations do not leak into a later sampled trace', async () => {
	const tracer = new Tracer(new Scope('concurrent'), 'test', { samplingRate: 0.5 });
	const originalRandom = Math.random;
	let calls = 0;
	Math.random = () => [0.9, 0.1][calls++] ?? 1;
	try {
		tracer.addAnnotation('discarded', true);
		await tracer.startSegment('unsampled', async () => {
			tracer.addMetadata('discarded', true);
			assert.ok(tracer.getTraceId());
		});
		assert.equal(existsSync('.bb-data/concurrent-test/traces.json'), false);
		await tracer.startSegment('sampled', async () => {});
	} finally {
		Math.random = originalRandom;
	}
	const [trace] = readTraces();
	assert.deepEqual(trace.rootAnnotations, {});
	assert.deepEqual(trace.rootMetadata, {});
});
