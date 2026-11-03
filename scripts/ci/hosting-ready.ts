// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Waits until a freshly deployed Hosting sandbox serves its HTML document, so
// a hosting E2E suite does not start before the site does. Each
// test-apps/hosting-*/test/sandbox-deploy.ts calls it after the deploy.
//
// Sandbox deploys run `cdk deploy --method direct --express`, which returns
// once CloudFormation reports the resources created ("It may continue
// becoming available in the background"). The edge can then still answer
// with something other than the app: right after the deploy, `/` has come
// back `200 application/xml` instead of the app's page, and the SPA page has
// gone the first test's whole 10 s without an `#app-status` element. A
// Playwright retry deploys again and starts just as early, so it fails the
// same way.
//
// The wait only gates the start: it returns on the first `200 text/html`
// response for the site root and checks nothing else. The suites still
// assert the document, and a site that never serves HTML fails here once the
// budget is spent, with the last response it saw.

import { setTimeout as delay } from 'node:timers/promises';

/**
 * Budget for starting requests, the same as `deploy --wait-live`'s default.
 * The wait ends within this plus the request timeout.
 */
export const READY_TIMEOUT_MS = 180_000;
/** Delay between two requests. */
export const POLL_INTERVAL_MS = 5_000;
/**
 * Default per-request timeout; it covers reading the body too. Not cut to
 * what is left of the budget: a request cut short would report a timeout as
 * the last response instead of what the site actually answered.
 */
export const REQUEST_TIMEOUT_MS = 10_000;

/** The part of a `fetch` Response the wait reads. */
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
	fetch?: ReadyFetch;
	now?: () => number;
	sleep?: (ms: number) => Promise<unknown>;
	log?: (line: string) => void;
}

const fetchOnce: ReadyFetch = (url, timeoutMs) =>
	fetch(url, { signal: AbortSignal.timeout(timeoutMs), cache: 'no-store' });

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
 * Request `url` until it answers `200` with a `text/html` content type, or
 * throw once `timeoutMs` has passed. Logs each new kind of not-ready answer
 * once, and the wait's length when it ends.
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
		fetch = fetchOnce,
		now = Date.now,
		sleep = delay,
		log = console.log,
	} = options;
	if (!url) throw new Error('No hosting URL to wait for: the deployed stack has no HostingUrl output.');
	const start = now();
	let attempts = 0;
	let last = '';
	for (;;) {
		attempts += 1;
		let seen: string;
		try {
			const res = await fetch(url, requestTimeoutMs);
			const body = await res.text();
			if (isHtmlDocument(res)) {
				const elapsedMs = now() - start;
				log(
					`✅ ${url} serves HTML (${(elapsedMs / 1000).toFixed(1)}s after the deploy, ${attempts} request(s))`,
				);
				return { attempts, elapsedMs };
			}
			seen = describeResponse(res, body);
		} catch (error) {
			seen = describeError(error);
		}
		if (seen !== last) log(`⏳ ${url} is not serving the app yet: ${seen}`);
		last = seen;
		const elapsed = now() - start;
		if (elapsed >= timeoutMs) {
			throw new Error(
				`${url} did not serve an HTML document (HTTP 200, text/html) within ${Math.round(timeoutMs / 1000)}s ` +
					`of the deploy (${attempts} requests). Last response: ${last}`,
			);
		}
		await sleep(Math.min(intervalMs, timeoutMs - elapsed));
	}
}
