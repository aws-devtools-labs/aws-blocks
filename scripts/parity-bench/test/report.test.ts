// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Unit tests for the parity differ.

import { test } from 'node:test';
import assert from 'node:assert';
import { snapshot } from '../src/client/recorder.js';
import { cell, diff, suiteMapper } from '../src/core/report.js';
import type { CallRecord, ProbeOutcome, ProbeRecord, RecordedOutcome, SweepRecord } from '../src/core/types.js';
import { COMPREHENSIVE_SUITE_BLOCKS } from '../src/suites.js';

const blockOfTest = suiteMapper(COMPREHENSIVE_SUITE_BLOCKS);

function call(env: string, test: string, seq: number, args: unknown[], outcome: RecordedOutcome): CallRecord {
	return { kind: 'call', env, process: 'main', test, seq, method: 'api.kvGet', args, outcome, ms: 1 };
}

function probe(env: string, outcome: ProbeOutcome): ProbeRecord {
	return { kind: 'probe', env, block: 'bb-distributed-data', caseId: 'dsql.row-limit.execute.4000', outcome, cleanup: 'ok', ms: 1 };
}

test('generated inputs echoed back, ids and timestamps do not count as differences', () => {
	const l = call('local', 'KVStore > CRUD > put and get', 0, ['kv-aaa111'], {
		ok: true,
		value: { key: 'kv-aaa111', id: '0b5e3c9a-1111-4a4a-8b8b-123456789abc', at: '2026-10-29T10:00:00.000Z', n: 1761732000000 },
	});
	const d = call('sandbox', 'KVStore > CRUD > put and get', 0, ['kv-bbb222'], {
		ok: true,
		value: { key: 'kv-bbb222', id: '9f9f9f9f-2222-4b4b-8c8c-abcdefabcdef', at: '2026-10-29T11:11:11Z', n: 1761735600000 },
	});
	const [f] = diff([l], [d], { blockOfTest });
	assert.strictEqual(f.verdict, 'same');
	assert.strictEqual(f.block, 'bb-kv-store');
});

test('ok locally but an error deployed is a silent divergence', () => {
	const [f] = diff(
		[probe('local', { status: 'ok', value: { rowCount: 4000 } })],
		[probe('sandbox', { status: 'error', error: { name: 'QueryFailed', httpStatus: 500, causeCode: '54000' } })],
	);
	assert.strictEqual(f.verdict, 'breaks-deployed-only');
	assert.match(f.deployed ?? '', /QueryFailed.*54000/);
});

test('different error names are an error-shape divergence; messages are ignored', () => {
	const t = 'DSQL Database BB > DSQL - x';
	const [a] = diff(
		[call('local', t, 0, [], { ok: false, error: { name: 'TransactionRowLimitExceededException', status: 500 } })],
		[call('sandbox', t, 0, [], { ok: false, error: { name: 'QueryFailed', status: 500 } })],
	);
	assert.strictEqual(a.verdict, 'differs-error');
	const [b] = diff(
		[call('local', t, 0, [], { ok: false, error: { name: 'X', status: 409, message: 'local wording' } })],
		[call('sandbox', t, 0, [], { ok: false, error: { name: 'X', status: 409, message: 'aws wording' } })],
	);
	assert.strictEqual(b.verdict, 'same');
});

test('a call whose two deployed runs disagree is noise, and a one-sided call is unmatched', () => {
	const t = 'DistributedTable > query > eventually consistent';
	const findings = diff(
		[call('local', t, 0, [], { ok: true, value: [1, 2] }), call('local', t, 1, [], { ok: true, value: 1 })],
		[call('sandbox', t, 0, [], { ok: true, value: [1] })],
		{ baseline: [call('sandbox', t, 0, [], { ok: true, value: [1, 2] })] },
	);
	assert.deepStrictEqual(findings.map((f) => f.verdict).sort(), ['noisy', 'unmatched']);
});

test('snapshot redacts credential-like keys and survives live objects and cycles', () => {
	class Channel {}
	const cyclic: Record<string, unknown> = { a: 1 };
	cyclic.self = cyclic;
	assert.deepStrictEqual(snapshot({ accessToken: 'abc', password: 'pw', code: '123456', ch: new Channel(), cyclic }), {
		accessToken: '<redacted:3>',
		password: '<redacted:2>',
		code: '<redacted:6>',
		ch: '<Channel>',
		cyclic: { a: 1, self: '<cycle-or-deep>' },
	});
});

function sweep(env: string, breakpoint: number | null, name?: string): SweepRecord {
	return {
		kind: 'sweep',
		env,
		block: 'bb-distributed-data',
		caseId: 'dsql.row-limit.execute',
		unit: 'rows',
		documented: 3000,
		breakpoint,
		max: 10000,
		...(name ? { errorAtBreakpoint: { name } } : {}),
		monotonic: true,
		attempts: [],
		ms: 1,
	};
}

test('a slider that never breaks locally but breaks deployed is silent; equal breakpoints with different errors differ in shape', () => {
	const [silent] = diff([sweep('local', null)], [sweep('sandbox', 3001, 'QueryFailed')]);
	assert.strictEqual(silent.verdict, 'breaks-deployed-only');
	assert.match(silent.local ?? '', /no break up to 10000 rows/);
	const [later] = diff([sweep('local', 5000, 'X')], [sweep('sandbox', 3001, 'X')]);
	assert.strictEqual(later.verdict, 'breaks-deployed-only');
	const [shape] = diff([sweep('local', 3001, 'QueryFailedException')], [sweep('sandbox', 3001, 'QueryFailed')]);
	assert.strictEqual(shape.verdict, 'differs-error');
	const [same] = diff([sweep('local', 3001, 'X')], [sweep('sandbox', 3001, 'X')]);
	assert.strictEqual(same.verdict, 'same');
});

test('table cells escape backslashes before pipes and fold newlines', () => {
	assert.strictEqual(cell('a|b'), 'a\\|b');
	// A recorded value ending in a backslash must not un-escape the following pipe.
	assert.strictEqual(cell('a\\|b'), 'a\\\\\\|b');
	assert.strictEqual(cell('line1\nline2\r\nline3'), 'line1 line2 line3');
	assert.strictEqual(cell(undefined), '—');
});
