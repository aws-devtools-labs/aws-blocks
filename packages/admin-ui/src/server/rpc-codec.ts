// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The Blocks JSON-RPC wire format, as the dashboard speaks it.
 *
 * SOURCE OF TRUTH: `packages/core/src/rpc.ts`. This is a deliberate
 * reimplementation of ~30 lines rather than an import, because `admin-ui` does
 * not depend on `@aws-blocks/core` and should not start: the dashboard installs
 * into a *user's* project, so a core dependency would have to match whichever
 * core version that app pins, and a mismatch would be a silently wrong codec
 * rather than an install error.
 *
 * The cost of that independence is drift, so it is paid for explicitly:
 * `rpc-codec.test.ts` pins the exact wire bytes AND, when core's build is
 * resolvable (i.e. inside this monorepo), asserts our encoder agrees with core's
 * own `encodeRpcRequest` for a range of inputs. Outside the monorepo that check
 * skips rather than fails, which is the honest behaviour for a package that
 * ships standalone.
 */

const JSONRPC_VERSION = '2.0';

/**
 * Monotonic request id.
 *
 * A counter rather than `Date.now()`, which the reference console uses: two
 * calls in the same millisecond get the same id there, and JSON-RPC ids are how
 * a response is matched to its request. We only ever have one call in flight per
 * request, so the practical damage is limited — but an id that can repeat is not
 * an id, and the fix is one variable.
 */
let nextId = 1;

/** Reset for tests, so an id assertion does not depend on execution order. */
export function resetRpcIdForTests(): void {
	nextId = 1;
}

/**
 * `namespace.methodName`, the shape core's dispatcher parses.
 *
 * Both halves must be identifier-like. Validating here means a malformed method
 * never reaches the network: without it, `method: '../../admin'` would be posted
 * to the app's endpoint and the failure would come back as whatever the app made
 * of it.
 */
const METHOD_PATTERN = /^[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*$/;

export function isValidRpcMethod(method: string): boolean {
	return METHOD_PATTERN.test(method);
}

/** The request body core's `parseRpcRequest` expects, as a JSON string. */
export function encodeRpcRequest(method: string, params: unknown[]): string {
	return JSON.stringify({ jsonrpc: JSONRPC_VERSION, method, params, id: nextId++ });
}

/**
 * The JSON-RPC error carried by a response body, or `undefined` when the body is
 * a success or is not a JSON-RPC envelope at all.
 *
 * `kind` preserves a distinction core makes and the reference console loses: a
 * POSITIVE `code` is an application error whose number is an HTTP status (409
 * for a conflict, say), while a negative `-32xxx` is a reserved protocol error
 * (method not found, bad params). They mean different things to the person
 * reading the result — one is their own business logic answering, the other is
 * the call never having been dispatched — so the playground labels them
 * differently rather than printing a bare number.
 */
export interface RpcErrorInfo {
	code?: number;
	message: string;
	name?: string;
	retriable?: boolean;
	kind: 'application' | 'protocol';
}

export function extractRpcError(body: unknown): RpcErrorInfo | undefined {
	if (typeof body !== 'object' || body === null) return undefined;
	const error = (body as { error?: unknown }).error;
	if (typeof error !== 'object' || error === null) return undefined;

	const record = error as { code?: unknown; message?: unknown; data?: unknown };
	const code = typeof record.code === 'number' ? record.code : undefined;
	const message = typeof record.message === 'string' ? record.message : 'The API returned an error with no message.';
	const data =
		typeof record.data === 'object' && record.data !== null ? (record.data as Record<string, unknown>) : {};

	return {
		...(code !== undefined ? { code } : {}),
		message,
		...(typeof data.name === 'string' ? { name: data.name } : {}),
		...(data.retriable === true ? { retriable: true } : {}),
		// Undefined code is treated as protocol-level: a body claiming an error
		// without a code did not come from application logic we can attribute.
		kind: code !== undefined && code > 0 ? 'application' : 'protocol',
	};
}

/** True when the body is a JSON-RPC envelope carrying a `result`. */
export function hasRpcResult(body: unknown): boolean {
	return typeof body === 'object' && body !== null && 'result' in (body as Record<string, unknown>);
}
