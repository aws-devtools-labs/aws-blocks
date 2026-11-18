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
	rootAnnotations: Record<string, unknown>;
	rootMetadata: Record<string, unknown>;
	children: TraceRecord[];
}

function gate() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => { resolve = done; });
	return { promise, resolve };
}

function readTraces(): TraceRecord[] {
	const file = '.bb-data/lifecycle-test/traces.json';
	return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
}

beforeEach(() => { rmSync('.bb-data', { recursive: true, force: true }); });

for (const fail of [false, true]) {
	test(`deferred work starts a new root after its parent ${fail ? 'throws' : 'returns'}`, async () => {
		const tracer = new Tracer(new Scope('lifecycle'), 'test');
		const release = gate();
		let deferred!: Promise<string | null>;
		let requestId: string | null = null;
		const error = new Error('request failed');
		const request = tracer.startSegment('request', async () => {
			requestId = tracer.getTraceId();
			tracer.addAnnotation('request', true);
			deferred = new Promise((resolve, reject) => {
				setTimeout(() => {
					release.promise.then(async () => {
						const nextId = tracer.getTraceId();
						tracer.addAnnotation('job', true);
						tracer.addMetadata('kind', 'job');
						return tracer.startSegment('job', async () => {
							assert.equal(tracer.getTraceId(), nextId);
							return nextId;
						});
					}).then(resolve, reject);
				}, 0);
			});
			if (fail) throw error;
		});
		if (fail) await assert.rejects(request, (caught: unknown) => caught === error);
		else await request;
		release.resolve();
		const jobId = await deferred;
		assert.notEqual(requestId, jobId);
		const traces = readTraces();
		assert.deepEqual(traces.map((trace) => trace.segment), ['request', 'job']);
		assert.deepEqual(traces[0].rootAnnotations, { request: true });
		assert.deepEqual(traces[1].rootAnnotations, { job: true });
		assert.deepEqual(traces[1].rootMetadata, { kind: 'job' });
		assert.deepEqual(traces[1].children, []);
	});
}

test('deferred work makes a fresh sampling decision after an unsampled root closes', async () => {
	const tracer = new Tracer(new Scope('lifecycle'), 'test', { samplingRate: 0.5 });
	const release = gate();
	let deferred!: Promise<void>;
	const originalRandom = Math.random;
	let calls = 0;
	Math.random = () => [0.9, 0.1][calls++] ?? 1;
	try {
		await tracer.startSegment('unsampled', async () => {
			tracer.addMetadata('discarded', true);
			deferred = new Promise((resolve, reject) => {
				setTimeout(() => {
					release.promise.then(() => tracer.startSegment('job', async () => {})).then(resolve, reject);
				}, 0);
			});
		});
		release.resolve();
		await deferred;
	} finally { Math.random = originalRandom; }
	assert.equal(calls, 2);
	const traces = readTraces();
	assert.deepEqual(traces.map((trace) => trace.segment), ['job']);
	assert.deepEqual(traces[0].rootMetadata, {});
});

test('deferred descendants of closed children attach to the nearest open ancestor', async () => {
	const tracer = new Tracer(new Scope('lifecycle'), 'test');
	const release = gate();
	let deferred!: Promise<void>;
	await tracer.startSegment('outer', async () => {
		await tracer.startSegment('child', async () => {
			await tracer.startSegment('grandchild', async () => {
				deferred = new Promise((resolve, reject) => {
					setTimeout(() => {
						release.promise.then(() => tracer.startSegment('later', async () => {})).then(resolve, reject);
					}, 0);
				});
			});
		});
		release.resolve();
		await deferred;
	});
	const [outer] = readTraces();
	assert.deepEqual(outer.children.map((child) => child.segment), ['child', 'later']);
	assert.deepEqual(outer.children[0].children.map((child) => child.segment), ['grandchild']);
	assert.deepEqual(outer.children[0].children[0].children, []);
});

test('an open descendant cannot keep its root active after the root closes', async () => {
	const tracer = new Tracer(new Scope('lifecycle'), 'test');
	const release = gate();
	let child!: Promise<void>;
	let rootId: string | null = null;
	await tracer.startSegment('root', async () => {
		rootId = tracer.getTraceId();
		child = tracer.startSegment('unfinished-child', async () => {
			await release.promise;
			await tracer.startSegment('later', async () => {
				assert.notEqual(tracer.getTraceId(), rootId);
			});
		});
	});
	release.resolve();
	await child;
	assert.deepEqual(readTraces().map((trace) => trace.segment), ['root', 'later']);
});
