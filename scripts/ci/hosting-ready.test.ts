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
/** How the helper reports `XML`: whitespace runs collapsed to one space. */
const XML_SNIPPET = '<?xml version="1.0" encoding="UTF-8"?> <ListBucketResult><Name>bucket</Name></ListBucketResult>';
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
			`HTTP 200 application/xml: ${XML_SNIPPET}`,
		);
		assert.equal(describeResponse(res(403, null, ''), ''), 'HTTP 403 (no content-type)');
		assert.equal(
			describeResponse(res(200, 'text/plain', 'x'.repeat(500)), 'x'.repeat(500)).length,
			'HTTP 200 text/plain: '.length + 120,
		);
	});
});

describe('waitForHostingReady', () => {
	it('returns once every answer has been HTML for 15 s, polling every 2 s', async () => {
		const clock = fakeClock();
		const lines: string[] = [];
		const fetch = seqFetch([res(200, 'text/html', HTML)]);
		const r = await waitForHostingReady(URL_, { fetch, ...clock, log: (l) => lines.push(l) });
		// HTML at 0, 2, …, 14 spans 14 s, not enough; the answer at 16 s ends the wait.
		assert.deepEqual(r, { attempts: 9, elapsedMs: 16_000 });
		assert.deepEqual(clock.sleeps, Array(8).fill(2_000));
		assert.equal(fetch.urls.length, 9);
		assert.deepEqual(lines, [
			`✅ ${URL_} served HTML on every request for 16.0s (9 in a row; 16.0s after the deploy, 9 request(s))`,
		]);
	});

	it('restarts the span on any other answer, so HTML before it does not count', async () => {
		const clock = fakeClock();
		const lines: string[] = [];
		const fetch = seqFetch([
			Object.assign(new TypeError('fetch failed'), {
				cause: Object.assign(new Error('getaddrinfo'), { code: 'ENOTFOUND' }),
			}),
			res(200, 'application/xml', XML),
			// A router that refuses requests until it has its route table.
			res(503, null, ''),
			// HTML from 6 s to 14 s, then an edge server without the route table.
			...Array(5).fill(res(200, 'text/html; charset=utf-8', HTML)),
			res(404, 'text/html', 'Not Found'),
			// HTML from 18 s on: ready once that has lasted 15 s.
			res(200, 'text/html; charset=utf-8', HTML),
		]);
		const r = await waitForHostingReady(URL_, { fetch, ...clock, log: (l) => lines.push(l) });
		assert.deepEqual(r, { attempts: 18, elapsedMs: 34_000 });
		// One line per new kind of answer (again after HTML), then the result.
		assert.deepEqual(lines, [
			`⏳ ${URL_} is not serving the app yet: TypeError: fetch failed (ENOTFOUND)`,
			`⏳ ${URL_} is not serving the app yet: HTTP 200 application/xml: ${XML_SNIPPET}`,
			`⏳ ${URL_} is not serving the app yet: HTTP 503 (no content-type)`,
			`⏳ ${URL_} is not serving the app yet: HTTP 404 text/html: Not Found`,
			`✅ ${URL_} served HTML on every request for 16.0s (9 in a row; 34.0s after the deploy, 18 request(s))`,
		]);
	});

	it('throws once the budget is spent, naming the URL, the span, the budget and the last response', async () => {
		const clock = fakeClock();
		const fetch = seqFetch([res(200, 'application/xml', XML)]);
		await assert.rejects(
			waitForHostingReady(URL_, { fetch, ...clock, timeoutMs: 12_000, intervalMs: 5_000, log: () => {} }),
			(error: Error) => {
				assert.equal(
					error.message,
					`${URL_} did not serve an HTML document (HTTP 200, text/html) on every request for 15s within 12s ` +
						`of the deploy (4 requests). Last response: HTTP 200 application/xml: ${XML_SNIPPET}`,
				);
				return true;
			},
		);
		// Requests at 0, 5, 10 and the deadline (12): the last sleep is cut to what is left.
		assert.deepEqual(clock.sleeps, [5_000, 5_000, 2_000]);
	});

	it('throws when the budget ends before HTML has lasted the span', async () => {
		const clock = fakeClock();
		const fetch = seqFetch([res(200, 'application/xml', XML), res(200, 'text/html', HTML)]);
		// HTML from 2 s; at the 12 s deadline it has lasted 10 s.
		await assert.rejects(
			waitForHostingReady(URL_, { fetch, ...clock, timeoutMs: 12_000, log: () => {} }),
			/on every request for 15s within 12s of the deploy \(7 requests\)\. Last response: HTML$/,
		);
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
					/did not serve an HTML document \(HTTP 200, text\/html\) on every request for \d+s within \d+s of the deploy \(\d+ requests\)\. Last response: TimeoutError/,
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

	it('fails with the connection error when nothing listens on the port', async () => {
		const server = createServer();
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		const { port } = server.address() as AddressInfo;
		await new Promise((resolve) => server.close(resolve));
		await assert.rejects(
			waitForHostingReady(`http://127.0.0.1:${port}/`, { timeoutMs: 100, intervalMs: 50, log: () => {} }),
			/Last response: Error: connect ECONNREFUSED/,
		);
	});

	it('waits on a real server through XML, 503 and a flap back to XML, each request on a new connection', async () => {
		const answers = ['xml', '503', 'html', 'xml', 'html'];
		let requests = 0;
		let connections = 0;
		const server = createServer((_req, response) => {
			const answer = answers[Math.min(requests++, answers.length - 1)];
			if (answer === '503') {
				response.writeHead(503, { 'cache-control': 'no-store', 'retry-after': '5' });
				response.end();
				return;
			}
			response.writeHead(200, { 'content-type': answer === 'html' ? 'text/html; charset=utf-8' : 'application/xml' });
			response.end(answer === 'html' ? HTML : XML);
		});
		server.on('connection', () => {
			connections += 1;
		});
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
		try {
			const { port } = server.address() as AddressInfo;
			const url = `http://127.0.0.1:${port}/`;
			const lines: string[] = [];
			const r = await waitForHostingReady(url, { intervalMs: 20, spanMs: 100, log: (l) => lines.push(l) });
			// After the flap, HTML must last 100 ms at a request every ≥20 ms: at least 6 more requests.
			assert.ok(r.attempts >= 4 + 6, `ready after ${r.attempts} requests`);
			assert.equal(requests, r.attempts);
			assert.equal(connections, requests, 'every request opens its own connection');
			assert.deepEqual(lines.slice(0, 3), [
				`⏳ ${url} is not serving the app yet: HTTP 200 application/xml: ${XML_SNIPPET}`,
				`⏳ ${url} is not serving the app yet: HTTP 503 (no content-type)`,
				`⏳ ${url} is not serving the app yet: HTTP 200 application/xml: ${XML_SNIPPET}`,
			]);
			assert.match(lines[3], /^✅ .* served HTML on every request for \d+\.\ds \(\d+ in a row; /);
			assert.equal(lines.length, 4);
		} finally {
			await new Promise((resolve) => server.close(resolve));
		}
	});
});
