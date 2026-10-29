// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// The HTTP edge recorder end to end: wraps a stub fetch, writes HttpRecords.
// Runs in its own process (node:test isolates files), so it can turn recording
// on before the recorder module reads E2E_PARITY_DIR.

import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HttpRecord } from '../src/core/types.js';

const dir = mkdtempSync(join(tmpdir(), 'parity-http-'));
process.env.E2E_PARITY_DIR = dir;
process.env.BLOCKS_API_URL = 'http://localhost:3000/aws-blocks/api';

const sent: string[] = [];
globalThis.fetch = (async (input: string | URL | Request) => {
	const url = String(input instanceof Request ? input.url : input);
	sent.push(url);
	if (url.includes('/rpc-fail')) throw new TypeError('fetch failed');
	if (url.endsWith('/aws-blocks/api/api')) {
		return new Response('{"jsonrpc":"2.0","result":1,"id":1}', {
			headers: { 'content-type': 'application/json; charset=utf-8', 'x-amzn-requestid': 'abc' },
		});
	}
	const headers = new Headers({ 'content-type': 'application/json', location: 'http://localhost:3000/aws-blocks/home?x=1' });
	headers.append('set-cookie', 'sid=secret-value; HttpOnly; Path=/; SameSite=Lax');
	return new Response('{"user":{"id":"u-1","at":"2026-10-29T10:00:00Z"}}', { status: 302, headers });
}) as typeof fetch;

const { installParityRecorder } = await import('../src/client/recorder.js');
installParityRecorder('http-test');

function records(): HttpRecord[] {
	return readFileSync(join(dir, 'http-test.jsonl'), 'utf8')
		.split('\n')
		.filter(Boolean)
		.map((l) => JSON.parse(l) as HttpRecord);
}

test('records RPC calls by method and raw routes by path, never cookie values or infra headers', async () => {
	const rpc = await fetch('http://localhost:3000/aws-blocks/api/api', {
		method: 'POST',
		body: JSON.stringify({ jsonrpc: '2.0', method: 'api.kvGet', params: ['k'], id: 7 }),
	});
	assert.strictEqual(await rpc.text(), '{"jsonrpc":"2.0","result":1,"id":1}', 'the caller still reads the body');
	const raw = await fetch('http://localhost:3000/aws-blocks/auth/signin/google?state=abc&code=xyz', { redirect: 'manual' });
	assert.match(await raw.text(), /u-1/);
	await new Promise((r) => setTimeout(r, 20));

	const [a, b] = records();
	assert.strictEqual(a.route, 'rpc api.kvGet');
	assert.deepStrictEqual(a.params, ['k']);
	assert.strictEqual(a.status, 200);
	assert.deepStrictEqual(a.headers, { 'content-type': 'application/json;charset=utf-8' });
	assert.strictEqual(a.body, undefined);

	assert.strictEqual(b.route, '/aws-blocks/auth/signin/google?code&state');
	assert.strictEqual(b.method, 'GET');
	assert.strictEqual(b.headers.location, '/aws-blocks/home?x');
	assert.deepStrictEqual(b.cookies, { sid: 'set; HttpOnly; Path=/; SameSite=lax' });
	assert.deepStrictEqual(b.body, { user: { id: 'u-1', at: '2026-10-29T10:00:00Z' } });
	assert.ok(!JSON.stringify(records()).includes('secret-value'));
});

test('a request that fails before a response is recorded with its error and still throws', async () => {
	await assert.rejects(fetch('http://localhost:3000/rpc-fail'), TypeError);
	const last = records().at(-1);
	assert.strictEqual(last?.status, null);
	assert.strictEqual(last?.error, 'TypeError');
});
