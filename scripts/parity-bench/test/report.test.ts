// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Unit tests for the parity differ.

import { test } from 'node:test';
import assert from 'node:assert';
import { cookieAttributes, snapshot } from '../src/client/recorder.js';
import { cell, diff, renderMarkdown, suiteMapper } from '../src/core/report.js';
import type { CallRecord, HttpRecord, ProbeOutcome, ProbeRecord, RecordedOutcome, SweepRecord } from '../src/core/types.js';
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
		[call('local', t, 0, [], { ok: true, value: [1, 2] }), call('local', t, 1, ['other-key'], { ok: true, value: 1 })],
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

function callOf(env: string, test: string, seq: number, method: string, args: unknown[], outcome: RecordedOutcome): CallRecord {
	return { kind: 'call', env, process: 'main', test, seq, method, args, outcome, ms: 1 };
}

const ok = (value: unknown): RecordedOutcome => ({ ok: true, value });

test('shape, then order, then value: the most severe difference wins', () => {
	const t = 'KVStore > x';
	const verdict = (l: unknown, d: unknown) => diff([call('local', t, 0, [], ok(l))], [call('sandbox', t, 0, [], ok(d))])[0];
	const shape = verdict({ when: '<date>' }, { when: 'tuesday' });
	assert.strictEqual(shape.verdict, 'differs-shape');
	assert.match(shape.local ?? '', /\$\.when: date/);
	assert.strictEqual(verdict([{ k: 'one' }, { k: 'two' }], [{ k: 'two' }, { k: 'one' }]).verdict, 'differs-order');
	assert.strictEqual(verdict({ a: 1, b: 2 }, { b: 2, a: 1 }).verdict, 'same');
	assert.strictEqual(verdict({ a: 1 }, { a: 2 }).verdict, 'differs-value');
});

test('alignment survives poll loops and extra calls', () => {
	const t = 'AsyncJob BB > x';
	// Local: submit two jobs, each result ready at once. Deployed: the same, but the loop polls both jobs in turn.
	const local = [
		callOf('local', t, 0, 'api.submit', ['p'], ok('job-aaaaaa')),
		callOf('local', t, 1, 'api.result', ['job-aaaaaa'], ok({ done: true })),
		callOf('local', t, 2, 'api.result', ['job-bbbbbb'], ok({ done: true })),
		callOf('local', t, 3, 'api.cleanup', [], ok(null)),
	];
	const deployed = [
		callOf('sandbox', t, 0, 'api.submit', ['p'], ok('job-cccccc')),
		callOf('sandbox', t, 1, 'api.result', ['job-cccccc'], ok(null)),
		callOf('sandbox', t, 2, 'api.result', ['job-dddddd'], ok(null)),
		callOf('sandbox', t, 3, 'api.result', ['job-cccccc'], ok({ done: true })),
		callOf('sandbox', t, 4, 'api.result', ['job-dddddd'], ok({ done: true })),
		callOf('sandbox', t, 5, 'api.cleanup', [], ok(null)),
	];
	const findings = diff(local, deployed);
	assert.deepStrictEqual(
		findings.map((f) => [f.key, f.verdict]),
		[
			// The job ids differ, but each is passed to a later call: generated data, normalized away.
			['main | AsyncJob BB > x | api.submit', 'same'],
			['main | AsyncJob BB > x | api.result', 'same'],
			['main | AsyncJob BB > x | api.result #2', 'same'],
			['main | AsyncJob BB > x | api.cleanup', 'same'],
		],
	);
	assert.match(findings[1].deployed ?? '', /\[×2\]/);
});

test('a read after a write is compared on its own, not folded into the earlier read', () => {
	const t = 'KVStore > y';
	const run = (env: string, after: unknown) => [
		callOf(env, t, 0, 'api.get', ['k-123456'], ok(null)),
		callOf(env, t, 1, 'api.put', ['k-123456', 'v'], ok(null)),
		callOf(env, t, 2, 'api.get', ['k-123456'], ok(after)),
	];
	const findings = diff(run('local', 'v'), run('sandbox', null));
	assert.deepStrictEqual(
		findings.map((f) => f.verdict),
		['same', 'same', 'differs-shape'],
	);
});

test('ids generated earlier in the test and the deployed stack prefix are normalized', () => {
	const t = 'Realtime > z';
	const run = (env: string, id: string, prefix: string) => [
		callOf(env, t, 0, 'api.create', [id], ok(null)),
		callOf(env, t, 1, 'api.list', [], ok([{ pk: id, channel: `${prefix}test-app-collab/${id}` }])),
		callOf(env, t, 2, 'api.cron', [], ok({ jobName: `${prefix}test-app-minute-cron` })),
	];
	const findings = diff(run('local', 'dt-mvtky4xj-5va3', ''), run('sandbox', 'dt-mvtm7lq4-3ykf', 'bb-test-alice-k8g-'));
	assert.deepStrictEqual(
		findings.map((f) => f.verdict),
		['same', 'same', 'same'],
	);
});

test('a second local run marks run-to-run noise without a second deploy', () => {
	const t = 'AppSetting > secret';
	const [f] = diff([call('local', t, 0, [], ok({ value: 'abc' }))], [call('sandbox', t, 0, [], ok({ value: 'xyz' }))], {
		localBaseline: [call('local', t, 0, [], ok({ value: 'def' }))],
	});
	assert.strictEqual(f.verdict, 'noisy');
});

function http(env: string, test: string, fields: Partial<HttpRecord>): HttpRecord {
	return {
		kind: 'http',
		env,
		process: 'main',
		test,
		seq: 0,
		method: 'POST',
		route: '/aws-blocks/auth/signin',
		requestKey: env,
		status: 200,
		headers: {},
		cookies: {},
		ms: 1,
		...fields,
	};
}

test('HTTP: a cookie attribute that differs is an edge difference, summarized by facet', () => {
	const t = 'AuthOIDC > sign-in';
	const findings = diff(
		[http('local', t, { cookies: { sid: 'set; HttpOnly; Path=/; SameSite=lax' } })],
		[http('sandbox', t, { cookies: { sid: 'set; HttpOnly; Path=/; SameSite=lax; Secure' } })],
		{ blockOfTest },
	);
	assert.strictEqual(findings[0].verdict, 'differs-http');
	assert.strictEqual(findings[0].block, 'bb-auth-oidc');
	assert.deepStrictEqual(findings[0].facets, [
		'cookie sid: set; HttpOnly; Path=/; SameSite=lax → set; HttpOnly; Path=/; SameSite=lax; Secure',
	]);
	assert.match(renderMarkdown(findings, { local: 'l', deployed: 'd' }), /## HTTP edge differences by facet/);
});

test('HTTP: ok locally but 5xx deployed is silent; equal edges compare the JSON body', () => {
	const t = 'RawRoute > x';
	const [silent] = diff([http('local', t, {})], [http('sandbox', t, { status: 502 })]);
	assert.strictEqual(silent.verdict, 'breaks-deployed-only');
	const [body] = diff([http('local', t, { body: { at: '<date>' } })], [http('sandbox', t, { body: { at: 'x' } })]);
	assert.strictEqual(body.verdict, 'differs-shape');
	const [same] = diff(
		[http('local', t, { headers: { 'content-type': 'application/json' } })],
		[http('sandbox', t, { headers: { 'content-type': 'application/json' } })],
	);
	assert.strictEqual(same.verdict, 'same');
});

test('cookie attributes: order-independent, value never kept, clearing detected', () => {
	assert.deepStrictEqual(cookieAttributes('sid=secret; Secure; Path=/; HttpOnly; SameSite=Lax'), [
		'sid',
		'set; HttpOnly; Path=/; SameSite=lax; Secure',
	]);
	assert.deepStrictEqual(cookieAttributes('sid=; Max-Age=0; Path=/'), ['sid', 'cleared; Max-Age=0; Path=/']);
	assert.deepStrictEqual(cookieAttributes('sid=x; Domain=example.com; Expires=Thu, 01 Jan 1970 00:00:00 GMT', 1), [
		'sid',
		'cleared; Domain; Expires=past',
	]);
});

test('HTTP: cookie names built from a raw RPC request\'s generated params are normalized', () => {
	const t = 'API method response cookies > x';
	const run = (env: string, prefix: string) => [
		http(env, t, { route: 'rpc api.setTwoCookies', params: [prefix], cookies: { [`${prefix}-a`]: 'set; Path=/' } }),
	];
	const [f] = diff(run('local', 'mcmvtn4oe7'), run('sandbox', 'mcmvtn6xzl'));
	assert.strictEqual(f.verdict, 'same');
});
