// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { describe, it } from 'node:test';
import {
	MAX_TAIL_GROUPS,
	MAX_TAIL_SESSIONS,
	acquireTailSlot,
	activeTailSessionCount,
	buildLogGroupArns,
	buildTailFilterPattern,
	tailEventToLogEntry,
} from './live-tail.js';

describe('buildLogGroupArns', () => {
	it('builds ARNs and caps at the API maximum', () => {
		const names = Array.from({ length: 15 }, (_, i) => `/aws/lambda/fn-${i}`);
		const arns = buildLogGroupArns(names, 'us-east-1', '111111111111');
		assert.strictEqual(arns.length, MAX_TAIL_GROUPS);
		assert.strictEqual(arns[0], 'arn:aws:logs:us-east-1:111111111111:log-group:/aws/lambda/fn-0');
	});
});

describe('buildTailFilterPattern', () => {
	it('returns undefined with no filters', () => {
		assert.strictEqual(buildTailFilterPattern({}), undefined);
	});

	it('compiles a level facet to a JSON selector', () => {
		assert.strictEqual(buildTailFilterPattern({ level: 'ERROR' }), '{ $.level = "error" }');
	});

	it('compiles free text to a quoted term and combines with level', () => {
		assert.strictEqual(
			buildTailFilterPattern({ level: 'warn', text: 'timeout' }),
			'{ $.level = "warn" } "timeout"',
		);
	});

	it('strips embedded quotes from user input', () => {
		assert.strictEqual(buildTailFilterPattern({ text: 'a"b' }), '"ab"');
	});
});

describe('tailEventToLogEntry', () => {
	it('parses bb-logger JSON events with group name from the ARN identifier', () => {
		const entry = tailEventToLogEntry({
			timestamp: Date.UTC(2026, 7, 18, 10, 0, 0),
			message: JSON.stringify({ level: 'error', message: 'boom', logger: 'app', timestamp: 't', traceId: '1-a' }),
			logGroupIdentifier: 'arn:aws:logs:us-east-1:1:log-group:/aws/lambda/fn',
			logStreamName: 'stream-1',
		});
		assert.strictEqual(entry.level, 'error');
		assert.strictEqual(entry.message, 'boom');
		assert.strictEqual(entry.logGroup, '/aws/lambda/fn');
		assert.strictEqual(entry.logStream, 'stream-1');
		assert.strictEqual(entry.timestamp, '2026-08-18T10:00:00.000Z');
	});

	it('keeps non-JSON messages raw', () => {
		const entry = tailEventToLogEntry({ message: 'REPORT RequestId: x\n' });
		assert.strictEqual(entry.level, undefined);
		assert.strictEqual(entry.message, 'REPORT RequestId: x');
		assert.strictEqual(entry.logGroup, '(unknown)');
	});
});

describe('tail session registry', () => {
	it('enforces the concurrent session cap and releases idempotently', () => {
		assert.strictEqual(activeTailSessionCount(), 0);
		const releases: Array<() => void> = [];
		for (let i = 0; i < MAX_TAIL_SESSIONS; i++) {
			const release = acquireTailSlot();
			assert.ok(release, `slot ${i} should be granted`);
			releases.push(release);
		}
		assert.strictEqual(acquireTailSlot(), undefined);
		assert.strictEqual(activeTailSessionCount(), MAX_TAIL_SESSIONS);

		// Double-release must not free a second slot.
		releases[0]();
		releases[0]();
		assert.strictEqual(activeTailSessionCount(), MAX_TAIL_SESSIONS - 1);

		const again = acquireTailSlot();
		assert.ok(again);
		again();
		for (const release of releases.slice(1)) release();
		assert.strictEqual(activeTailSessionCount(), 0);
	});
});
