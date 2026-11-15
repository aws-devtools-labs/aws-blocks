// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Waits until a freshly deployed Hosting sandbox serves its HTML document, so
// a hosting E2E suite does not start before the site does. Each
// test-apps/hosting-*/test/sandbox-deploy.ts calls it after the deploy.
//
// Why the site isn't ready when the deploy returns:
// - CloudFront door: the distribution is live tens of seconds before the
//   stack's last resource writes the edge router's route table to the
//   KeyValueStore, and that write then takes seconds to reach each edge
//   server. Until a server has it, its router has no route table: `/` has come
//   back `200 application/xml` from the S3 origin and the SPA page has gone
//   the first test's whole 10 s without an `#app-status` element. A
//   router that refuses those requests answers `503` instead.
// - ALB door: sandbox deploys run `cdk deploy --method direct --express`, which
//   returns before the load balancer accepts connections, so the first request
//   has failed with `ECONNREFUSED`.
//
// Edge servers get the route table at different times, so a few HTML answers
// aren't enough: a suite's next request has come back XML 1.5 s after this
// wait saw HTML, and a 404 1 s after it saw HTML three times in a row (each
// request reaches only one of many edge servers). The wait returns once every
// answer has been HTML for READY_SPAN_MS, requesting every POLL_INTERVAL_MS on
// a new connection; any other answer (XML, a 503, an error) starts the span
// again.
//
// The wait only gates the start: it checks `200 text/html` for the site root
// and nothing else. The suites still assert the document, and a site that
// never serves HTML fails here once the budget is spent, with the last
// response it saw.

import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { setTimeout as delay } from 'node:timers/promises';

/**
 * Budget for starting requests, the same as `deploy --wait-live`'s default.
 * The wait ends within this plus the request timeout.
 */
export const READY_TIMEOUT_MS = 180_000;
/** Delay between two requests. */
export const POLL_INTERVAL_MS = 2_000;
/** How long every answer must have been HTML before the site counts as ready. */
export const READY_SPAN_MS = 15_000;
/**
 * Default per-request timeout; it covers reading the body too. Not cut to
 * what is left of the budget: a request cut short would report a timeout as
 * the last response instead of what the site actually answered.
 */
export const REQUEST_TIMEOUT_MS = 10_000;

/** The part of a response the wait reads. */
export interface ReadyResponse {
	status: number;
	headers: { get(name: string): string | null };
	text(): Promise<string>;
}

/** One request with its own timeout; resolves on any HTTP status. */
export type ReadyFetch = (url: string, timeoutMs: number) => Promise<ReadyResponse>;

/** Options for {@link waitForHostingReady}; the clock and fetch are injectable for tests. */
export interface ReadyOptions {
	timeoutMs?: number;
	intervalMs?: number;
	requestTimeoutMs?: number;
	spanMs?: number;
	fetch?: ReadyFetch;
	now?: () => number;
	sleep?: (ms: number) => Promise<unknown>;
	log?: (line: string) => void;
}

/**
 * GET `url` on a new connection (no keep-alive agent), reading the whole body
 * within `timeoutMs`. A new connection can land on a different edge server, so
 * a streak of answers is not one server's view repeated.
 */
export const fetchOnce: ReadyFetch = (url, timeoutMs) => {
	const signal = AbortSignal.timeout(timeoutMs);
	const request = new URL(url).protocol === 'http:' ? httpRequest : httpsRequest;
	// The executor form: the test apps that import this compile against ES2022,
	// which has no `Promise.withResolvers`.
	return new Promise<ReadyResponse>((resolve, reject) => {
		const fail = (error: unknown) => reject(signal.aborted ? signal.reason : error);
		const req = request(url, { agent: false, signal, headers: { 'cache-control': 'no-cache' } }, (res) => {
			const chunks: Buffer[] = [];
			res.on('data', (chunk: Buffer) => chunks.push(chunk));
			res.on('error', fail);
			res.on('end', () => {
				const body = Buffer.concat(chunks).toString('utf8');
				resolve({
					status: res.statusCode ?? 0,
					headers: {
						get: (name: string) => {
							const value = res.headers[name.toLowerCase()];
							return value === undefined ? null : Array.isArray(value) ? value.join(', ') : value;
						},
					},
					text: async () => body,
				});
			});
		});
		req.on('error', fail);
		req.end();
	});
};

/** Whether a response is the HTML document a suite's first test asks for. */
export function isHtmlDocument(res: ReadyResponse): boolean {
	return res.status === 200 && /^text\/html\b/i.test(res.headers.get('content-type') ?? '');
}

/**
 * One line for a response that is not ready yet: status, content type and
 * the start of the body.
 */
export function describeResponse(res: ReadyResponse, body: string): string {
	const snippet = body.replace(/\s+/g, ' ').trim().slice(0, 120);
	return `HTTP ${res.status} ${res.headers.get('content-type') || '(no content-type)'}${snippet ? `: ${snippet}` : ''}`;
}

function describeError(error: unknown): string {
	if (!(error instanceof Error)) return String(error);
	const cause = error.cause instanceof Error ? error.cause : undefined;
	const code = cause && 'code' in cause ? ` (${String(cause.code)})` : cause ? ` (${cause.message})` : '';
	return `${error.name}: ${error.message}${code}`;
}

/**
 * Request `url` until every answer, for at least `spanMs` from the first of
 * them, has been `200` with a `text/html` content type, or throw once
 * `timeoutMs` has passed. Logs each new kind of not-ready answer once (again
 * after an HTML answer), and the wait's length when it ends.
 *
 * @param url the site root, e.g. `https://d123.cloudfront.net`
 */
export async function waitForHostingReady(
	url: string | undefined,
	options: ReadyOptions = {},
): Promise<{ attempts: number; elapsedMs: number }> {
	const {
		timeoutMs = READY_TIMEOUT_MS,
		intervalMs = POLL_INTERVAL_MS,
		requestTimeoutMs = REQUEST_TIMEOUT_MS,
		spanMs = READY_SPAN_MS,
		fetch = fetchOnce,
		now = Date.now,
		sleep = delay,
		log = console.log,
	} = options;
	if (!url) throw new Error('No hosting URL to wait for: the deployed stack has no HostingUrl output.');
	const start = now();
	let attempts = 0;
	/** When the current run of HTML answers began; undefined while there is none. */
	let htmlSince: number | undefined;
	let inARow = 0;
	let last = '';
	for (;;) {
		attempts += 1;
		let seen: string;
		try {
			const res = await fetch(url, requestTimeoutMs);
			const body = await res.text();
			seen = isHtmlDocument(res) ? 'HTML' : describeResponse(res, body);
		} catch (error) {
			seen = describeError(error);
		}
		if (seen === 'HTML') {
			htmlSince ??= now();
			inARow += 1;
			const spanned = now() - htmlSince;
			if (spanned >= spanMs) {
				const elapsedMs = now() - start;
				log(
					`✅ ${url} served HTML on every request for ${(spanned / 1000).toFixed(1)}s ` +
						`(${inARow} in a row; ${(elapsedMs / 1000).toFixed(1)}s after the deploy, ${attempts} request(s))`,
				);
				return { attempts, elapsedMs };
			}
		} else {
			htmlSince = undefined;
			inARow = 0;
			if (seen !== last) log(`⏳ ${url} is not serving the app yet: ${seen}`);
		}
		last = seen;
		const elapsed = now() - start;
		if (elapsed >= timeoutMs) {
			throw new Error(
				`${url} did not serve an HTML document (HTTP 200, text/html) on every request for ` +
					`${Math.round(spanMs / 1000)}s within ${Math.round(timeoutMs / 1000)}s of the deploy ` +
					`(${attempts} requests). Last response: ${last}`,
			);
		}
		await sleep(Math.min(intervalMs, timeoutMs - elapsed));
	}
}
