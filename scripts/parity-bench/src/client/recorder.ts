// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Parity recorder — test plumbing, not customer code.
 *
 * When `E2E_PARITY_DIR` is set, every call the e2e suites make through the
 * generated client is appended as one JSON line (test name, call ordinal,
 * method, args, outcome, duration) to `<dir>/<process label>.jsonl`. Running the
 * same suite locally and against a deployed stack produces two recordings that
 * the differ (`../core/report.ts`) aligns by (test, ordinal) and diffs per Building Block.
 *
 * The same switch installs the HTTP edge recorder on `globalThis.fetch`: every
 * request the process sends — the generated client's RPC calls and each raw
 * `fetch` a suite makes — is appended with its status, app-level response
 * headers and cookie attributes (`HttpRecord`).
 *
 * Unset, every export is a no-op and the client is returned unwrapped, so a
 * normal e2e run is unaffected.
 */

import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach } from 'node:test';
import { normalize } from '../core/report.js';
import type { HttpRecord, ParityRecord, RecordedError, RecordedOutcome } from '../core/types.js';

const DIR = process.env.E2E_PARITY_DIR;
const ENV = process.env.BLOCKS_TEST_ENV || 'local';

export const parityRecording = !!DIR;

let file: string | undefined;
let processLabel = 'main';
let currentTest = '(setup)';
let seq = 0;
let httpSeq = 0;

/**
 * Start recording for this test process. Call once at module top level (it
 * registers a root `beforeEach`), with a label unique to the process — the
 * parent e2e run and each background-suite child write separate files.
 *
 * Call it before anything else wraps `fetch` (a cookie jar): the edge recorder
 * then sits closest to the network and sees the requests as sent.
 */
export function installParityRecorder(label: string): void {
	if (!DIR) return;
	processLabel = label;
	mkdirSync(DIR, { recursive: true });
	file = join(DIR, `${label}.jsonl`);
	writeFileSync(file, '');
	beforeEach((t) => {
		// Hooks receive the test's own context; `fullName` is the ' > '-joined describe path.
		currentTest = 'fullName' in t ? t.fullName : t.name;
		seq = 0;
		httpSeq = 0;
	});
	installHttpRecorder();
}

export function writeRecord(record: ParityRecord): void {
	if (file) appendFileSync(file, `${JSON.stringify(record)}\n`);
}

// Values whose key looks credential-like are never written, only their length.
const SENSITIVE_KEY = /^(code|otp)$|token|secret|password|cookie|authorization|session|credential/i;
const MAX_STRING = 2000;

/** A JSON-safe snapshot: redacts credential-like keys, truncates long strings, survives cycles and live objects. */
export function snapshot(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
	if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
	if (typeof value === 'string') return value.length > MAX_STRING ? `<string:${value.length}>` : value;
	if (typeof value === 'undefined') return '<undefined>';
	if (typeof value === 'bigint') return `<bigint:${value}>`;
	if (typeof value === 'function') return '<function>';
	if (typeof value !== 'object') return `<${typeof value}>`;
	if (seen.has(value) || depth > 8) return '<cycle-or-deep>';
	seen.add(value);
	if (value instanceof Date) return '<date>';
	if (value instanceof Uint8Array) return `<bytes:${value.byteLength}>`;
	if (Array.isArray(value)) return value.map((v) => snapshot(v, depth + 1, seen));
	const proto = Object.getPrototypeOf(value);
	if (proto !== Object.prototype && proto !== null) {
		// Live client objects (Transferables, streams): record the type, not the internals.
		return `<${value.constructor?.name ?? 'object'}>`;
	}
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(value)) {
		out[k] = SENSITIVE_KEY.test(k) && v != null ? `<redacted:${String(v).length}>` : snapshot(v, depth + 1, seen);
	}
	return out;
}

function isThenable(v: unknown): v is PromiseLike<unknown> {
	return typeof v === 'object' && v !== null && 'then' in v && typeof v.then === 'function';
}

function recordError(e: unknown): RecordedError {
	if (!(e instanceof Error)) return { name: `<thrown ${typeof e}>` };
	const status = 'status' in e && typeof e.status === 'number' ? e.status : undefined;
	return {
		name: e.name,
		...(status === undefined ? {} : { status }),
		message: e.message.slice(0, 200),
	};
}

/**
 * Wrap a generated client namespace so each method call is recorded. Returns
 * `target` untouched when recording is off. A method's own return value — a
 * promise, an async iterable, a live object — is passed through unchanged.
 */
export function recordClient<T extends object>(target: T, namespace: string): T {
	if (!DIR) return target;
	return new Proxy(target, {
		get(obj, prop, receiver) {
			const member = Reflect.get(obj, prop, receiver);
			if (typeof member !== 'function' || typeof prop !== 'string') return member;
			return (...args: unknown[]) => {
				const base = { kind: 'call' as const, env: ENV, process: processLabel, test: currentTest, seq: seq++ };
				const method = `${namespace}.${prop}`;
				const started = performance.now();
				const finish = (outcome: RecordedOutcome) =>
					writeRecord({ ...base, method, args: args.map((a) => snapshot(a)), outcome, ms: Math.round(performance.now() - started) });
				let result: unknown;
				try {
					result = member.apply(obj, args);
				} catch (e) {
					finish({ ok: false, error: recordError(e) });
					throw e;
				}
				if (isThenable(result)) {
					return Promise.resolve(result).then(
						(v) => {
							finish({ ok: true, value: snapshot(v) });
							return v;
						},
						(e: unknown) => {
							finish({ ok: false, error: recordError(e) });
							throw e;
						},
					);
				}
				finish({ ok: true, value: snapshot(result) });
				return result;
			};
		},
	});
}

// ── HTTP edge recorder ───────────────────────────────────────────────────────

/**
 * Response headers an app or a browser acts on. Everything else — request ids,
 * dates, gateway and CDN headers, content-length, transfer encodings — is
 * infrastructure that differs by design and would bury the real differences.
 */
const COMPARED_HEADERS = new Set([
	'allow',
	'cache-control',
	'content-disposition',
	'content-security-policy',
	'content-type',
	'cross-origin-embedder-policy',
	'cross-origin-opener-policy',
	'cross-origin-resource-policy',
	'location',
	'permissions-policy',
	'referrer-policy',
	'retry-after',
	'strict-transport-security',
	'vary',
	'www-authenticate',
	'x-content-type-options',
	'x-frame-options',
]);
const LIST_HEADERS = new Set(['vary', 'access-control-allow-headers', 'access-control-allow-methods', 'access-control-expose-headers']);
// JSON bodies on raw routes are recorded up to this size; RPC bodies are already in the CallRecord.
const MAX_BODY_BYTES = 64 * 1024;

const isComparedHeader = (name: string) => COMPARED_HEADERS.has(name) || name.startsWith('access-control-');

let appOrigin: string | undefined;

/** The origin the app's API is served from, once the harness has written it (`BLOCKS_API_URL` or `.blocks-sandbox/config.json`). */
function resolveAppOrigin(): string | undefined {
	if (appOrigin) return appOrigin;
	try {
		const apiUrl =
			process.env.BLOCKS_API_URL ??
			(JSON.parse(readFileSync('.blocks-sandbox/config.json', 'utf8')) as { apiUrl?: string }).apiUrl;
		if (apiUrl) appOrigin = new URL(apiUrl).origin;
	} catch {
		// Not written yet (server still starting): try again on the next request.
	}
	return appOrigin;
}

/** A URL in a form both environments share: the path on the app origin, `<presigned>`, or `<external>` + path. Query values are dropped. */
function routeOf(url: URL): string {
	if (url.searchParams.has('X-Amz-Signature') || url.pathname.startsWith('/.bb-file-bucket/')) return '<presigned>';
	const keys = [...new Set(url.searchParams.keys())].sort();
	const path = `${normalize(url.pathname, [])}${keys.length ? `?${keys.join('&')}` : ''}`;
	return url.origin === resolveAppOrigin() ? path : `<external>${path}`;
}

function headerValue(name: string, value: string, requestUrl: URL, requestOrigin: string | null): string {
	if (name === 'content-type') return value.toLowerCase().replace(/\s+/g, '');
	if (name === 'location') {
		try {
			return routeOf(new URL(value, requestUrl));
		} catch {
			return '<invalid>';
		}
	}
	if (name === 'access-control-allow-origin') {
		if (value === '*') return '*';
		if (value === requestOrigin) return '<request-origin>';
		return value === resolveAppOrigin() ? '<app-origin>' : '<other-origin>';
	}
	if (LIST_HEADERS.has(name)) {
		return value
			.split(',')
			.map((v) => v.trim().toLowerCase())
			.filter(Boolean)
			.sort()
			.join(',');
	}
	return String(normalize(value.trim(), []));
}

/** A Set-Cookie line as `[name, attributes]`: whether it sets or clears a value, then its attributes in a fixed order. Never the value. */
export function cookieAttributes(setCookie: string, now = Date.now()): [string, string] {
	const [pair = '', ...attrs] = setCookie.split(';').map((s) => s.trim());
	const eq = pair.indexOf('=');
	const name = eq === -1 ? pair : pair.slice(0, eq);
	const value = eq === -1 ? '' : pair.slice(eq + 1);
	let cleared = !value;
	const out: string[] = [];
	for (const attr of attrs) {
		const i = attr.indexOf('=');
		const key = (i === -1 ? attr : attr.slice(0, i)).toLowerCase();
		const v = i === -1 ? '' : attr.slice(i + 1).trim();
		if (key === 'httponly') out.push('HttpOnly');
		else if (key === 'secure') out.push('Secure');
		else if (key === 'partitioned') out.push('Partitioned');
		else if (key === 'samesite') out.push(`SameSite=${v.toLowerCase()}`);
		else if (key === 'path') out.push(`Path=${v}`);
		// The domain names the environment's host; only whether one is set is comparable.
		else if (key === 'domain') out.push('Domain');
		else if (key === 'max-age') {
			if (Number(v) <= 0) cleared = true;
			out.push(`Max-Age=${v}`);
		} else if (key === 'expires') {
			const past = Date.parse(v) <= now;
			if (past) cleared = true;
			out.push(past ? 'Expires=past' : 'Expires');
		}
	}
	return [name, [cleared ? 'cleared' : 'set', ...out.sort()].join('; ')];
}

const sha1 = (s: string) => createHash('sha1').update(s).digest('hex').slice(0, 16);

/** `route` and `requestKey` for a request: an RPC call is named by its method and keyed by its params. */
function describeRequest(url: URL, body: unknown): { route: string; requestKey: string; params?: unknown } {
	if (typeof body === 'string') {
		try {
			const rpc = JSON.parse(body) as { jsonrpc?: unknown; method?: unknown; params?: unknown };
			if (rpc && typeof rpc === 'object' && rpc.jsonrpc && typeof rpc.method === 'string') {
				return {
					route: `rpc ${rpc.method}`,
					requestKey: sha1(JSON.stringify(rpc.params ?? null)),
					params: snapshot(rpc.params ?? null),
				};
			}
		} catch {
			// Not JSON: a raw body.
		}
		return { route: routeOf(url), requestKey: sha1(`${url.href} ${body}`) };
	}
	return { route: routeOf(url), requestKey: sha1(url.href) };
}

function responseHeaders(response: Response, url: URL, requestOrigin: string | null): Pick<HttpRecord, 'headers' | 'cookies'> {
	const headers: Record<string, string> = {};
	response.headers.forEach((value, rawName) => {
		const name = rawName.toLowerCase();
		if (name !== 'set-cookie' && isComparedHeader(name)) headers[name] = headerValue(name, value, url, requestOrigin);
	});
	const cookies: Record<string, string> = {};
	for (const line of response.headers.getSetCookie?.() ?? []) {
		const [name, attributes] = cookieAttributes(line);
		cookies[name] = cookies[name] ? `${cookies[name]} + ${attributes}` : attributes;
	}
	return { headers, cookies };
}

/** The JSON body of a raw-route response, read from a clone so the caller's body is untouched. */
async function jsonBody(response: Response): Promise<unknown> {
	const type = response.headers.get('content-type') ?? '';
	const length = Number(response.headers.get('content-length') ?? 0);
	if (!type.includes('json') || length > MAX_BODY_BYTES) return undefined;
	try {
		return snapshot(await response.clone().json());
	} catch {
		return '<unparseable-json>';
	}
}

/**
 * Wrap `globalThis.fetch` so every exchange is recorded. The response is
 * returned to the caller as soon as it arrives; reading a raw route's JSON body
 * for the record happens on a clone, off the caller's path. A recorder failure
 * never reaches the request.
 */
function installHttpRecorder(): void {
	const inner = globalThis.fetch;
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const base = { kind: 'http' as const, env: ENV, process: processLabel, test: currentTest, seq: httpSeq++ };
		const started = performance.now();
		let request:
			| { url: URL; method: string; origin: string | null; route: string; requestKey: string; params?: unknown }
			| undefined;
		try {
			const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
			const url = new URL(href);
			const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
			const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
			request = { url, method, origin: headers.get('origin'), ...describeRequest(url, init?.body) };
		} catch {
			// A URL the recorder can't parse: let fetch report it, record nothing.
		}
		const finish = (fields: Pick<HttpRecord, 'status' | 'headers' | 'cookies'> & Partial<HttpRecord>) => {
			if (!request) return;
			writeRecord({
				...base,
				method: request.method,
				route: request.route,
				requestKey: request.requestKey,
				...(request.params === undefined ? {} : { params: request.params }),
				...fields,
				ms: Math.round(performance.now() - started),
			});
		};
		let response: Response;
		try {
			response = await inner(input, init);
		} catch (e) {
			finish({ status: null, error: e instanceof Error ? e.name : typeof e, headers: {}, cookies: {} });
			throw e;
		}
		try {
			if (request) {
				const edge = { status: response.status, ...responseHeaders(response, request.url, request.origin) };
				if (request.route.startsWith('rpc ')) finish(edge);
				else void jsonBody(response).then((body) => finish(body === undefined ? edge : { ...edge, body }));
			}
		} catch {
			// Never let recording break the request.
		}
		return response;
	}) as typeof fetch;
}
