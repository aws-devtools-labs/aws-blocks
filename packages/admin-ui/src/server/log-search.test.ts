// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { describe, it } from 'node:test';
import { buildInsightsQuery, rowsToLogEntries } from './log-search.js';

describe('buildInsightsQuery', () => {
	it('builds a bare query with defaults (1h range, limit 100)', () => {
		const resolved = buildInsightsQuery({ stage: 'sandbox' });
		assert.match(resolved.queryString, /^fields @timestamp, @message, @logStream, @log/);
		assert.match(resolved.queryString, /\| sort @timestamp desc/);
		assert.match(resolved.queryString, /\| limit 100$/);
		assert.ok(!resolved.queryString.includes('filter'));
		const rangeMs = resolved.endTime.getTime() - resolved.startTime.getTime();
		assert.strictEqual(rangeMs, 60 * 60_000);
	});

	it('compiles facets into filter clauses', () => {
		const resolved = buildInsightsQuery({
			stage: 'sandbox',
			level: 'ERROR',
			logger: 'checkout',
			traceId: '1-abc-def',
			text: 'boom',
		});
		assert.match(resolved.queryString, /\| filter level = 'error'/);
		assert.match(resolved.queryString, /\| filter logger like \/checkout\//);
		assert.match(resolved.queryString, /\| filter traceId = '1-abc-def'/);
		assert.match(resolved.queryString, /\| filter @message like \/\(\?i\)boom\//);
	});

	it('escapes quotes and regex metacharacters in user input', () => {
		const resolved = buildInsightsQuery({
			stage: 'sandbox',
			level: "err'or",
			text: 'a.b*c(d)',
			logger: 'x/y',
		});
		assert.ok(resolved.queryString.includes("filter level = 'err\\'or'"));
		assert.ok(resolved.queryString.includes('a\\.b\\*c\\(d\\)'));
		assert.ok(resolved.queryString.includes('x\\/y'));
	});

	it('clamps the limit to [1, 1000]', () => {
		assert.match(buildInsightsQuery({ stage: 's', limit: 5000 }).queryString, /\| limit 1000$/);
		assert.match(buildInsightsQuery({ stage: 's', limit: 0 }).queryString, /\| limit 1$/);
	});

	it('honors explicit time ranges and rejects invalid ones', () => {
		const resolved = buildInsightsQuery({
			stage: 's',
			start: '2026-08-18T10:00:00Z',
			end: '2026-08-18T11:00:00Z',
		});
		assert.strictEqual(resolved.startTime.toISOString(), '2026-08-18T10:00:00.000Z');
		assert.throws(() => buildInsightsQuery({ stage: 's', start: 'nonsense' }), /Invalid time range/);
		assert.throws(
			() => buildInsightsQuery({ stage: 's', start: '2026-08-18T12:00:00Z', end: '2026-08-18T11:00:00Z' }),
			/Invalid time range/,
		);
	});
});

describe('rowsToLogEntries', () => {
	it('parses bb-logger JSON lines into faceted entries', () => {
		const bbLine = JSON.stringify({
			level: 'error',
			message: 'payment failed',
			timestamp: '2026-08-18T10:00:00.000Z',
			logger: 'checkout',
			traceId: '1-abc',
			orderId: 42,
		});
		const [entry] = rowsToLogEntries([
			{
				'@timestamp': '2026-08-18 10:00:00.123',
				'@message': bbLine,
				'@logStream': '2026/08/18/[$LATEST]abc',
				'@log': '123456789012:/aws/lambda/my-fn',
			},
		]);
		assert.strictEqual(entry.level, 'error');
		assert.strictEqual(entry.logger, 'checkout');
		assert.strictEqual(entry.traceId, '1-abc');
		assert.strictEqual(entry.message, 'payment failed');
		assert.strictEqual(entry.logGroup, '/aws/lambda/my-fn');
		assert.strictEqual(entry.timestamp, '2026-08-18T10:00:00.123Z');
	});

	it('keeps non-JSON lines raw without facets', () => {
		const [entry] = rowsToLogEntries([
			{ '@timestamp': '2026-08-18 10:00:00.000', '@message': 'START RequestId: xyz\n', '@log': 'acct:/aws/lambda/fn' },
		]);
		assert.strictEqual(entry.level, undefined);
		assert.strictEqual(entry.message, 'START RequestId: xyz');
	});

	it('tolerates missing fields', () => {
		const [entry] = rowsToLogEntries([{}]);
		assert.strictEqual(entry.logGroup, '(unknown)');
		assert.strictEqual(entry.message, '');
	});
});
