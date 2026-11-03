// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Unit tests for scripts/ci/hosting-ready.ts.
//
// Run: npx tsx --test scripts/ci/hosting-ready.test.ts

import assert from 'node:assert/strict';
import { createServer, type RequestListener } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';
import { describeResponse, isHtmlDocument, type ReadyResponse, waitForHostingReady } from './hosting-ready.js';

const URL_ = 'https://d123.cloudfront.net';
const XML = '<?xml version="1.0" encoding="UTF-8"?>\n<ListBucketResult><Name>bucket</Name></ListBucketResult>';
const HTML = '<!doctype html><html><body><div id="app-status">Loading</div></body></html>';

/** A response the way the helper reads it. */
function res(status: number, contentType: string | null, body: string): ReadyResponse {
	return {
		status,
		headers: { get: (name) => (name === 'content-type' ? contentType : null) },
		text: async () => body,
	};
}

/** A clock that only moves when the helper sleeps. */
function fakeClock() {
	let t = 0;
	const sleeps: number[] = [];
	return {
		now: () => t,
		sleep: async (ms: number) => {
			sleeps.push(ms);
			t += ms;
		},
		sleeps,
	};
}

/** Answers from `responses` in order, repeating the last; an Error is thrown. */
function seqFetch(responses: (ReadyResponse | Error)[]) {
	const urls: string[] = [];
	let i = 0;
	const fn = async (url: string) => {
		urls.push(url);
		const next = responses[Math.min(i++, responses.length - 1)];
		if (next instanceof Error) throw next;
		return next;
	};
	return Object.assign(fn, { urls });
}

describe('isHtmlDocument', () => {
	it('accepts only HTTP 200 with a text/html content type', () => {
		assert.equal(isHtmlDocument(res(200, 'text/html', HTML)), true);
		assert.equal(isHtmlDocument(res(200, 'text/html; charset=utf-8', HTML)), true);
		assert.equal(isHtmlDocument(res(200, 'application/xml', XML)), false);
		assert.equal(isHtmlDocument(res(200, null, HTML)), false);
		assert.equal(isHtmlDocument(res(503, 'text/html', 'No route found')), false);
		assert.equal(isHtmlDocument(res(403, 'text/html', 'Forbidden')), false);
	});
});

describe('describeResponse', () => {
	it('names the status, the content type and the start of the body on one line', () => {
		assert.equal(
			describeResponse(res(200, 'application/xml', XML), XML),
			`HTTP 200 application/xml: ${XML.replace('\n', ' ')}`,
		);
		assert.equal(describeResponse(res(403, null, ''), ''), 'HTTP 403 (no content-type)');
		assert.equal(
			describeResponse(res(200, 'text/plain', 'x'.repeat(500)), 'x'.repeat(500)).length,
			'HTTP 200 text/plain: '.length + 120,
		);
	});
});

describe('waitForHostingReady', () => {
	it('returns at once when the site already serves HTML', async () => {
		const clock = fakeClock();
		const fetch = seqFetch([res(200, 'text/html', HTML)]);
		const r = await waitForHostingReady(URL_, { fetch, ...clock, log: () => {} });
		assert.deepEqual(r, { attempts: 1, elapsedMs: 0 });
		assert.deepEqual(clock.sleeps, []);
		assert.deepEqual(fetch.urls, [URL_]);
	});

	it('waits through XML, a network error and an error page, then returns on the first HTML', async () => {
		const clock = fakeClock();
		const lines: string[] = [];
		const fetch = seqFetch([
			Object.assign(new TypeError('fetch failed'), {
				cause: Object.assign(new Error('getaddrinfo'), { code: 'ENOTFOUND' }),
			}),
			res(200, 'application/xml', XML),
			res(200, 'application/xml', XML),
			res(503, 'text/html', 'No route found'),
			res(200, 'text/html; charset=utf-8', HTML),
			res(200, 'application/xml', XML),
		]);
		const r = await waitForHostingReady(URL_, { fetch, ...clock, intervalMs: 5_000, log: (l) => lines.push(l) });
		assert.deepEqual(r, { attempts: 5, elapsedMs: 20_000 });
		assert.equal(fetch.urls.length, 5, 'stops at the first HTML response');
		// One line per new kind of answer, then the result.
		assert.deepEqual(lines, [
			`⏳ ${URL_} is not serving the app yet: TypeError: fetch failed (ENOTFOUND)`,
			`⏳ ${URL_} is not serving the app yet: HTTP 200 application/xml: ${XML.replace('\n', ' ')}`,
			`⏳ ${URL_} is not serving the app yet: HTTP 503 text/html: No route found`,
			`✅ ${URL_} serves HTML (20.0s after the deploy, 5 request(s))`,
		]);
	});

	it('throws once the budget is spent, naming the URL, the budget and the last response', async () => {
		const clock = fakeClock();
		const fetch = seqFetch([res(200, 'application/xml', XML)]);
		await assert.rejects(
			waitForHostingReady(URL_, { fetch, ...clock, timeoutMs: 12_000, intervalMs: 5_000, log: () => {} }),
			(error: Error) => {
				assert.equal(
					error.message,
					`${URL_} did not serve an HTML document (HTTP 200, text/html) within 12s of the deploy (4 requests). ` +
						`Last response: HTTP 200 application/xml: ${XML.replace('\n', ' ')}`,
				);
				return true;
			},
		);
		// Requests at 0, 5, 10 and the deadline (12): the last sleep is cut to what is left.
		assert.deepEqual(clock.sleeps, [5_000, 5_000, 2_000]);
	});

	// A server that accepts each request and never finishes it: the wait must
	// give up within the budget plus one request timeout, not hang.
	for (const [stall, handler] of [
		['sends no response', () => {}],
		[
			'sends headers and a body that never ends',
			(_req, response) => {
				response.writeHead(200, { 'content-type': 'text/html' });
				response.write('<!doctype html>');
			},
		],
	] satisfies [string, RequestListener][]) {
		// A hang never settles, so the per-test timeout catches it; the slack below is only for a slow runner.
		it(`gives up on a server that ${stall}`, { timeout: 10_000 }, async () => {
			const server = createServer(handler);
			await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
			try {
				const { port } = server.address() as AddressInfo;
				const url = `http://127.0.0.1:${port}/`;
				const timeoutMs = 300;
				const requestTimeoutMs = 200;
				const started = performance.now();
				await assert.rejects(
					waitForHostingReady(url, { timeoutMs, requestTimeoutMs, intervalMs: 50, log: () => {} }),
					/did not serve an HTML document \(HTTP 200, text\/html\) within \d+s of the deploy \(\d+ requests\)\. Last response: TimeoutError/,
				);
				const elapsed = performance.now() - started;
				assert.ok(elapsed >= timeoutMs, `waited ${elapsed} ms, less than the ${timeoutMs} ms budget`);
				// Budget plus one request timeout, with slack for a loaded runner.
				assert.ok(elapsed < timeoutMs + requestTimeoutMs + 3_000, `took ${elapsed} ms`);
			} finally {
				server.closeAllConnections();
				await new Promise((resolve) => server.close(resolve));
			}
		});
	}

	it('fails at once without a URL', async () => {
		await assert.rejects(waitForHostingReady(undefined, { log: () => {} }), /no HostingUrl output/);
	});

	it('waits on a real server that answers XML, then HTML', async () => {
		let requests = 0;
		const server = createServer((req, response) => {
			requests += 1;
			const ready = requests > 2;
			response.writeHead(200, { 'content-type': ready ? 'text/html; charset=utf-8' : 'application/xml' });
			response.end(ready ? HTML : XML);
		});
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		try {
			const { port } = server.address() as AddressInfo;
			const url = `http://127.0.0.1:${port}/`;
			const r = await waitForHostingReady(url, { intervalMs: 50, log: () => {} });
			assert.equal(r.attempts, 3);
			assert.equal(requests, 3);
		} finally {
			await new Promise((resolve) => server.close(resolve));
		}
	});
});
