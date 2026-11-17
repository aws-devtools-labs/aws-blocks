// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Posts one JSON-RPC call at a resolved endpoint and turns the outcome into a
 * result the user can read.
 *
 * The point of this module is that four things which the reference console
 * collapses into a single `ok` boolean are four different diagnoses:
 *
 *   1. The call never went out — a malformed method, caught here rather than
 *      posted. `transportErrorCode: 'BAD_METHOD'`, `httpStatus: 0`.
 *   2. The call could not reach anything. Split in two on purpose: `'TIMEOUT'`
 *      means "your app is slow / wedged", `'UNREACHABLE'` means "nothing is
 *      listening". They lead to different next steps, so the reference's single
 *      catch block — which reports both as unreachable under a 502 it invented —
 *      throws away the more useful half of the answer.
 *   3. The app answered with an HTTP status. That status is reported VERBATIM: a
 *      401 from the app's own auth is a result to inspect, not a failure of the
 *      dashboard, so it is never rewritten into an error of ours.
 *   4. The app answered 200 carrying a JSON-RPC error envelope. `ok` is still
 *      true, because transport succeeded; the error surfaces in `rpcError` with
 *      its `kind`. The reference reads `ok: response.ok` here and so reports a
 *      failed call as a success.
 *
 * `ok` therefore means TRANSPORT success only — a response was received — and
 * nothing about whether the method did what was asked.
 */

import type { RpcInvokeResponse } from '../contract/v1.js';
import { type RpcErrorInfo, encodeRpcRequest, extractRpcError, isValidRpcMethod } from './rpc-codec.js';

/** Default call budget. Long enough for a cold Lambda, short enough to not hang a page. */
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Cap on a non-JSON body kept as text.
 *
 * An HTML error page is diagnostic in its first few hundred bytes; the rest is
 * boilerplate that would be pushed through a JSON response for nothing. The cap
 * is REPORTED alongside the text (`truncated`, `totalLength`) so a short body and
 * a clipped one are never confused.
 */
const NON_JSON_BODY_CAP = 4_096;

export interface InvokeParams {
	/** Already resolved and validated server-side by `rpc-endpoint.ts`. */
	endpoint: string;
	/** `namespace.method`. */
	method: string;
	params: unknown[];
	timeoutMs?: number;
	/** Test seam. Tests must never reach a socket, not even loopback. */
	fetchImpl?: typeof fetch;
	/** Test seam for `durationMs`, so a timing assertion is not wall-clock dependent. */
	now?: () => number;
}

/**
 * A non-JSON response body, preserved as what actually came back.
 *
 * `await response.json()` throws on an API Gateway HTML page or a proxy's
 * plain-text 502, and the reference's `.catch(() => null)` turns the single most
 * diagnostic artefact of the whole call into `null`. The body is read as text and
 * only then parsed, so a body that is not JSON is still evidence.
 */
export interface NonJsonBody {
	nonJsonBody: string;
	contentType: string;
	/** True when the text was clipped at `cap`. */
	truncated?: boolean;
	/** The cap applied, stated so the truncation is self-describing. */
	cap?: number;
	/** Length of the untruncated text. */
	totalLength?: number;
}

/**
 * The invoke outcome, minus the fields the route layer owns (`apiVersion`,
 * `stage`, `mode`).
 *
 * `rpcError` is narrowed to the codec's `RpcErrorInfo`, which adds `kind`
 * ('application' for a positive code, 'protocol' for a reserved `-32xxx`) and
 * `retriable` on top of the contract's `{ code?, message, name? }`. It widens
 * back to the contract shape, so a route can return this unchanged; keeping the
 * richer type here means a caller can act on the distinction instead of
 * re-deriving it from a bare number.
 */
export type InvokeResult = Omit<RpcInvokeResponse, 'apiVersion' | 'stage' | 'mode' | 'rpcError'> & {
	rpcError?: RpcErrorInfo;
};

/**
 * Invokes `method` at `endpoint`. Never rejects: a bad method, a timeout and a
 * dead server are all results, because each of them is something the user asked
 * to find out.
 */
export async function invokeRpc(params: InvokeParams): Promise<InvokeResult> {
	const { endpoint, method, params: callParams, timeoutMs = DEFAULT_TIMEOUT_MS } = params;
	const fetchImpl = params.fetchImpl ?? fetch;
	const now = params.now ?? Date.now;

	// Outcome 1: never dispatched. Validating before the fetch is what keeps a
	// method like '../../admin' off the wire entirely, rather than posting it and
	// reporting back whatever the app made of it.
	if (!isValidRpcMethod(method)) {
		return {
			endpoint,
			ok: false,
			// 0, not a borrowed 502: no request was made, so there is no status to
			// report. A synthesised status would read as the app having answered.
			httpStatus: 0,
			durationMs: 0,
			body: null,
			transportErrorCode: 'BAD_METHOD',
			rpcError: {
				message: `'${method}' is not a valid method name. Expected 'namespace.method'.`,
				kind: 'protocol',
			},
		};
	}

	const body = encodeRpcRequest(method, callParams);
	const startedAt = now();

	let response: Response;
	try {
		response = await fetchImpl(endpoint, {
			method: 'POST',
			// Content-Type and NOTHING else. The reference forwards the incoming
			// `Cookie` header, which hands the developer's dashboard session to
			// whatever host the endpoint names — an endpoint that is user-supplied
			// configuration. An auth-gated method answering 401 is a legitimate,
			// inspectable result (outcome 3), which is a better failure mode than
			// leaking a session to get a 200. Adding a credential path later is a
			// deliberate design with its own threat model — an allowlist of hosts,
			// an explicit per-call token — not a convenience to bolt on here.
			headers: { 'content-type': 'application/json' },
			body,
			signal: AbortSignal.timeout(timeoutMs),
		});
	} catch (error) {
		// Outcome 2. Duration is reported even here: how long a call took before
		// failing is often the whole diagnosis — an instant failure is a refused
		// connection, a slow one is a black hole.
		const durationMs = now() - startedAt;
		const timedOut = isTimeout(error);
		return {
			endpoint,
			ok: false,
			httpStatus: 0,
			durationMs,
			body: null,
			transportErrorCode: timedOut ? 'TIMEOUT' : 'UNREACHABLE',
			rpcError: {
				message: timedOut
					? `The call did not complete within ${timeoutMs}ms.`
					: `Could not reach ${endpoint}: ${describeError(error)}`,
				kind: 'protocol',
			},
		};
	}

	const parsedBody = await readBody(response);
	const durationMs = now() - startedAt;
	// Outcomes 3 and 4. The status is passed through untouched, and the JSON-RPC
	// error is reported beside it rather than folded into it: `ok` answers "did a
	// response arrive", `httpStatus` answers "what did the app say", `rpcError`
	// answers "did the method fail". Collapsing them loses two of the three.
	//
	// The body is NOT redacted. The data browser masks fields because it bulk-
	// displays records the user never asked for individually; here the user named
	// one method and asked what it returns, so masking part of the answer would
	// corrupt the thing being inspected — and would make the playground useless
	// for the case it is most needed, debugging an auth or token flow.
	const rpcError = extractRpcError(parsedBody);
	return {
		endpoint,
		ok: true,
		httpStatus: response.status,
		durationMs,
		body: parsedBody,
		...(rpcError ? { rpcError } : {}),
	};
}

/**
 * Reads the response as text, then tries to parse it.
 *
 * Text-first is the whole point: parse-first loses the body on any response that
 * is not JSON, which is exactly the set of responses worth looking at.
 */
async function readBody(response: Response): Promise<unknown> {
	const contentType = response.headers.get('content-type') ?? '';
	let text: string;
	try {
		text = await response.text();
	} catch (error) {
		// A body that fails mid-stream still gets reported as what it was.
		return {
			nonJsonBody: `<unreadable response body: ${describeError(error)}>`,
			contentType,
		} satisfies NonJsonBody;
	}

	if (text === '') {
		// An empty body is a fact about the response, not an absent one. The
		// reference reports it as `null`, indistinguishable from JSON `null`.
		return { nonJsonBody: '', contentType } satisfies NonJsonBody;
	}

	try {
		return JSON.parse(text);
	} catch {
		return truncateBody(text, contentType);
	}
}

/** Clips an over-long body and states the cap, so truncation is visible. */
function truncateBody(text: string, contentType: string): NonJsonBody {
	if (text.length <= NON_JSON_BODY_CAP) return { nonJsonBody: text, contentType };
	return {
		nonJsonBody: text.slice(0, NON_JSON_BODY_CAP),
		contentType,
		truncated: true,
		cap: NON_JSON_BODY_CAP,
		totalLength: text.length,
	};
}

/**
 * Whether a thrown fetch error is a timeout rather than a connection failure.
 *
 * `AbortSignal.timeout` rejects with a `TimeoutError` DOMException; an
 * `AbortController` abort gives `AbortError`. Both are treated as a timeout —
 * the call was cut short by us, not refused by the network — while a
 * `TypeError: fetch failed` (ECONNREFUSED, DNS) is unreachable.
 */
function isTimeout(error: unknown): boolean {
	if (typeof error !== 'object' || error === null) return false;
	const name = (error as { name?: unknown }).name;
	return name === 'TimeoutError' || name === 'AbortError';
}

/** A message for a thrown value of unknown shape, without leaking a stack. */
function describeError(error: unknown): string {
	if (error instanceof Error) {
		const cause = (error as { cause?: unknown }).cause;
		const causeCode = typeof cause === 'object' && cause !== null ? (cause as { code?: unknown }).code : undefined;
		return typeof causeCode === 'string' ? `${error.message} (${causeCode})` : error.message;
	}
	return String(error);
}
