// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

'use client';

import type { SettingWriteResponse, WriteResponse } from '@/contract/v1';
import { ApiRequestError, getSessionToken } from '@/lib/api-client';

/**
 * Mutating Dashboard API access — the POST/DELETE counterpart to `apiGet`.
 *
 * It exists as its own helper for one reason that shapes the whole write UI: a
 * refusal is not a failure. The write routes answer a refused write with a
 * `WriteResponse` envelope — `ok: false` plus a `refusalCode` — and a non-2xx
 * status alongside it (403 for `LOCKED`). Throwing on the status would collapse
 * actionable guidance ("switch to edit", "stop the dev server") into an
 * exception with a number in it, and the UI would render a red error where the
 * server actually sent instructions.
 *
 * So: a parseable envelope is RETURNED whatever the status, and only a response
 * with nothing usable in it (a proxy error page, a dropped connection, the
 * token gate's bare 401) throws.
 */

/** The server requires this on mutating routes; a missing type is a 415. */
const JSON_CONTENT_TYPE = 'application/json';

/**
 * The refusal codes, as `WriteResponse.refusalCode` spells them.
 *
 * They are matched against `ApiError.error.code` as well, because the write
 * routes currently answer a locked cloud write with an `ApiError` envelope
 * (`{ error: { code: 'LOCKED', … } }`) rather than the `WriteResponse` the
 * contract's `refusalCode` describes. Both are normalised to the same shape
 * below, so the UI's guidance path does not depend on which one arrives.
 */
const REFUSAL_CODES: ReadonlySet<string> = new Set([
	'LOCKED',
	'LOCAL_SERVER_RUNNING',
	'ALREADY_EXISTS',
	'NOT_FOUND',
	'VALIDATION_FAILED',
]);

function asRecord(body: unknown): Record<string, unknown> | undefined {
	if (typeof body !== 'object' || body === null) return undefined;
	return body as Record<string, unknown>;
}

/** The `{ code, message }` of an `ApiError` envelope, when that is what arrived. */
function apiErrorOf(body: unknown): { code: string; message: string } | undefined {
	const error = asRecord(asRecord(body)?.error);
	if (error === undefined) return undefined;
	const code = typeof error.code === 'string' ? error.code : '';
	const message = typeof error.message === 'string' ? error.message : '';
	return { code, message };
}

/**
 * Whether a decoded body is a response envelope we can hand back as-is.
 * `unlocked` covers `UnlockResponse`; `ok` / `refusalCode` cover `WriteResponse`.
 */
function isResponseEnvelope(body: unknown): boolean {
	const record = asRecord(body);
	if (record === undefined) return false;
	return 'ok' in record || 'refusalCode' in record || 'unlocked' in record;
}

/** A plain `message` on the body, for the thrown message when there is no `error`. */
function detailOf(body: unknown): string {
	const message = asRecord(body)?.message;
	return typeof message === 'string' ? message : '';
}

/**
 * Send a JSON body to a mutating Dashboard API route and decode the response.
 *
 * The session token travels the same way `apiGet` sends it — an `Authorization`
 * header read from the in-memory/sessionStorage copy of the launch fragment.
 * The browser adds `Origin` and `Sec-Fetch-Site` itself, which is what the
 * server's mutation guard checks alongside the content type.
 *
 * @throws ApiRequestError when the response is a real error rather than a refusal.
 */
/**
 * The refusal codes a CLIENT can observe, which is deliberately one wider than
 * `WriteResponse['refusalCode']`.
 *
 * The contract type describes what the records route puts in a `WriteResponse`
 * body. A locked cloud write is not one of those: the unlock gate is a property
 * of the session rather than an outcome of this record, so it is answered with
 * HTTP 403 and an `ApiError` whose code is `LOCKED` — which also means a client
 * that checks only the status cannot mistake a refused write for an applied one.
 *
 * `apiMutate` normalises both envelopes into one shape, so from a component's
 * point of view `LOCKED` arrives exactly like any other refusal. This type is
 * where that widening is stated, rather than the contract claiming the server
 * sends a value it never sends.
 */
export type ObservedRefusalCode = NonNullable<WriteResponse['refusalCode']> | 'LOCKED';

/**
 * A `WriteResponse` as a client actually receives it, carrying the wider
 * {@link ObservedRefusalCode}. Use this rather than the bare contract type when
 * typing an `apiMutate` write call, so the `LOCKED` branch is reachable instead
 * of being narrowed away as impossible.
 */
export type ObservedWriteResponse = Omit<WriteResponse, 'refusalCode'> & { refusalCode?: ObservedRefusalCode };

/**
 * The same widening for a settings write, whose refusals are its own set.
 *
 * `LOCKED` arrives here from two different gates, neither of which is an
 * outcome of the setting itself: the cloud write unlock, and the confirmation a
 * production write needs. Both answer with an `ApiError`, which `apiMutate`
 * flattens into this shape, so a component reads one field.
 */
export type ObservedSettingWriteResponse = Omit<SettingWriteResponse, 'refusalCode'> & {
	refusalCode?: NonNullable<SettingWriteResponse['refusalCode']> | 'LOCKED';
};

export async function apiMutate<T>(path: string, method: 'POST' | 'PUT' | 'DELETE', body: unknown): Promise<T> {
	const token = getSessionToken();
	const headers: Record<string, string> = { 'content-type': JSON_CONTENT_TYPE };
	if (token) headers.authorization = `Bearer ${token}`;

	const response = await fetch(path, { method, headers, body: JSON.stringify(body) });

	// Read as text first: an empty body and an HTML error page both make
	// `response.json()` throw, and neither should surface as a parse crash.
	const text = await response.text();
	let decoded: unknown;
	try {
		decoded = text.length > 0 ? JSON.parse(text) : undefined;
	} catch {
		decoded = undefined;
	}

	if (response.ok && decoded !== undefined) return decoded as T;

	// The refusal path. A 403 LOCKED or a 409 ALREADY_EXISTS is guidance the
	// caller renders, so it is handed back — flattened into the `WriteResponse`
	// shape when it came dressed as an `ApiError`, so callers read one shape.
	const apiError = apiErrorOf(decoded);
	if (apiError && REFUSAL_CODES.has(apiError.code)) {
		return {
			apiVersion: asRecord(decoded)?.apiVersion,
			ok: false,
			message: apiError.message,
			refusalCode: apiError.code,
		} as T;
	}
	if (apiError === undefined && isResponseEnvelope(decoded)) return decoded as T;

	const detail = apiError?.message ?? detailOf(decoded);
	throw new ApiRequestError(response.status, `${path} failed with ${response.status}${detail ? `: ${detail}` : ''}`);
}
