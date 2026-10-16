// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { describe, it } from 'node:test';

import { resetRpcIdForTests } from './rpc-codec.js';
import { type InvokeResult, type NonJsonBody, invokeRpc } from './rpc-invoke.js';

const ENDPOINT = 'http://localhost:3000/aws-blocks/api';

interface Captured {
	url: string;
	init: RequestInit;
}

/**
 * A fetch stand-in that records the request. Tests never touch a socket, not
 * even loopback: a developer with something else on port 3000 would otherwise
 * see this suite flake.
 */
function stubFetch(response: Response | (() => never | Promise<Response>)): {
	fetchImpl: typeof fetch;
	calls: Captured[];
} {
	const calls: Captured[] = [];
	const fetchImpl = ((input: string | URL | Request, init: RequestInit = {}) => {
		calls.push({ url: String(input), init });
		if (typeof response === 'function') return Promise.resolve(response());
		return Promise.resolve(response);
	}) as unknown as typeof fetch;
	return { fetchImpl, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** A clock that advances a fixed amount per read, so durations are deterministic. */
function stepClock(step: number): () => number {
	let value = 1_000;
	return () => {
		const current = value;
		value += step;
		return current;
	};
}

function nonJson(result: InvokeResult): NonJsonBody {
	return result.body as NonJsonBody;
}

describe('invokeRpc — a successful call', () => {
	it('posts the exact JSON-RPC wire body and reports the result', async () => {
		resetRpcIdForTests();
		const { fetchImpl, calls } = stubFetch(jsonResponse({ jsonrpc: '2.0', id: 1, result: [{ id: 't1' }] }));

		const result = await invokeRpc({
			endpoint: ENDPOINT,
			method: 'todos.list',
			params: [{ limit: 10 }],
			fetchImpl,
			now: stepClock(12),
		});

		assert.strictEqual(calls.length, 1);
		assert.strictEqual(calls[0]?.url, ENDPOINT);
		assert.strictEqual(calls[0]?.init.method, 'POST');
		const sent = JSON.parse(String(calls[0]?.init.body));
		assert.strictEqual(sent.jsonrpc, '2.0');
		assert.strictEqual(sent.method, 'todos.list');
		assert.deepStrictEqual(sent.params, [{ limit: 10 }]);
		assert.strictEqual(typeof sent.id, 'number');
		assert.deepStrictEqual(calls[0]?.init.headers, { 'content-type': 'application/json' });

		assert.strictEqual(result.ok, true);
		assert.strictEqual(result.httpStatus, 200);
		assert.strictEqual(result.endpoint, ENDPOINT);
		assert.deepStrictEqual(result.body, { jsonrpc: '2.0', id: 1, result: [{ id: 't1' }] });
		assert.strictEqual(result.rpcError, undefined);
		assert.strictEqual(result.transportErrorCode, undefined);
	});

	it('sends no header other than content-type — no cookie, no authorization', async () => {
		const { fetchImpl, calls } = stubFetch(jsonResponse({ result: null }));
		await invokeRpc({ endpoint: ENDPOINT, method: 'todos.list', params: [], fetchImpl });

		const headers = calls[0]?.init.headers as Record<string, string>;
		assert.deepStrictEqual(Object.keys(headers), ['content-type']);
		// Explicit: the reference forwards the developer's session cookie to
		// whatever host the endpoint names.
		assert.strictEqual(headers.cookie, undefined);
		assert.strictEqual(headers.Cookie, undefined);
		assert.strictEqual(headers.authorization, undefined);
		assert.strictEqual(headers.Authorization, undefined);
		assert.strictEqual((calls[0]?.init as { credentials?: string }).credentials, undefined);
	});

	it('treats a null result as success, not as a missing answer', async () => {
		const { fetchImpl } = stubFetch(jsonResponse({ jsonrpc: '2.0', id: 1, result: null }));
		const result = await invokeRpc({ endpoint: ENDPOINT, method: 'todos.get', params: ['missing'], fetchImpl });

		assert.strictEqual(result.ok, true);
		assert.strictEqual(result.httpStatus, 200);
		assert.deepStrictEqual(result.body, { jsonrpc: '2.0', id: 1, result: null });
		assert.strictEqual(result.rpcError, undefined);
	});

	it('reports durationMs from the injected clock', async () => {
		const { fetchImpl } = stubFetch(jsonResponse({ result: 1 }));
		const result = await invokeRpc({
			endpoint: ENDPOINT,
			method: 'todos.count',
			params: [],
			fetchImpl,
			now: stepClock(37),
		});

		assert.strictEqual(result.durationMs, 37);
	});
});

describe('invokeRpc — a JSON-RPC error envelope at HTTP 200', () => {
	it('keeps ok true (transport succeeded) and reports an application error', async () => {
		const { fetchImpl } = stubFetch(
			jsonResponse({ jsonrpc: '2.0', id: 1, error: { code: 409, message: 'Todo already exists' } }),
		);
		const result = await invokeRpc({ endpoint: ENDPOINT, method: 'todos.create', params: [{}], fetchImpl });

		// The reference reads `ok: response.ok` and so calls this a success.
		assert.strictEqual(result.ok, true);
		assert.strictEqual(result.httpStatus, 200);
		assert.strictEqual(result.rpcError?.kind, 'application');
		assert.strictEqual(result.rpcError?.code, 409);
		assert.strictEqual(result.rpcError?.message, 'Todo already exists');
		assert.strictEqual(result.transportErrorCode, undefined);
	});

	it('reports a reserved -32601 as a protocol error', async () => {
		const { fetchImpl } = stubFetch(
			jsonResponse({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'Method not found' } }),
		);
		const result = await invokeRpc({ endpoint: ENDPOINT, method: 'todos.nope', params: [], fetchImpl });

		assert.strictEqual(result.ok, true);
		assert.strictEqual(result.httpStatus, 200);
		assert.strictEqual(result.rpcError?.kind, 'protocol');
		assert.strictEqual(result.rpcError?.code, -32601);
	});

	it('carries the Blocks error name and retriable flag through', async () => {
		const { fetchImpl } = stubFetch(
			jsonResponse({
				error: { code: 503, message: 'Try again', data: { name: 'ThrottledError', retriable: true } },
			}),
		);
		const result = await invokeRpc({ endpoint: ENDPOINT, method: 'todos.list', params: [], fetchImpl });

		assert.strictEqual(result.rpcError?.name, 'ThrottledError');
		assert.strictEqual(result.rpcError?.retriable, true);
	});
});

describe('invokeRpc — an upstream HTTP status', () => {
	it('surfaces a 401 verbatim, inventing no error of ours', async () => {
		const { fetchImpl } = stubFetch(jsonResponse({ message: 'Unauthorized' }, 401));
		const result = await invokeRpc({ endpoint: ENDPOINT, method: 'todos.list', params: [], fetchImpl });

		// A 401 from the app's own auth is a RESULT to inspect: transport worked.
		assert.strictEqual(result.httpStatus, 401);
		assert.strictEqual(result.ok, true);
		assert.strictEqual(result.transportErrorCode, undefined);
		assert.strictEqual(result.rpcError, undefined);
		assert.deepStrictEqual(result.body, { message: 'Unauthorized' });
	});

	it('surfaces a 500 verbatim and keeps its body', async () => {
		const { fetchImpl } = stubFetch(jsonResponse({ error: { code: -32603, message: 'Internal error' } }, 500));
		const result = await invokeRpc({ endpoint: ENDPOINT, method: 'todos.list', params: [], fetchImpl });

		assert.strictEqual(result.httpStatus, 500);
		assert.strictEqual(result.ok, true);
		assert.strictEqual(result.transportErrorCode, undefined);
		assert.strictEqual(result.rpcError?.kind, 'protocol');
	});
});

describe('invokeRpc — preserving a non-JSON body', () => {
	it('keeps an HTML error page as text with its content type', async () => {
		const html = '<html><body><h1>502 Bad Gateway</h1></body></html>';
		const { fetchImpl } = stubFetch(new Response(html, { status: 502, headers: { 'content-type': 'text/html' } }));
		const result = await invokeRpc({ endpoint: ENDPOINT, method: 'todos.list', params: [], fetchImpl });

		assert.strictEqual(result.httpStatus, 502);
		// The reference's `.catch(() => null)` destroys exactly this.
		assert.strictEqual(nonJson(result).nonJsonBody, html);
		assert.strictEqual(nonJson(result).contentType, 'text/html');
		assert.strictEqual(nonJson(result).truncated, undefined);
	});

	it('truncates an over-long body and states the cap', async () => {
		const huge = 'x'.repeat(10_000);
		const { fetchImpl } = stubFetch(new Response(huge, { status: 500, headers: { 'content-type': 'text/plain' } }));
		const result = await invokeRpc({ endpoint: ENDPOINT, method: 'todos.list', params: [], fetchImpl });

		const body = nonJson(result);
		assert.strictEqual(body.truncated, true);
		assert.strictEqual(body.cap, 4_096);
		assert.strictEqual(body.nonJsonBody.length, 4_096);
		assert.strictEqual(body.totalLength, 10_000);
	});

	it('reports an empty body as empty rather than as null', async () => {
		const { fetchImpl } = stubFetch(new Response('', { status: 200, headers: { 'content-type': 'text/plain' } }));
		const result = await invokeRpc({ endpoint: ENDPOINT, method: 'todos.clear', params: [], fetchImpl });

		assert.strictEqual(result.httpStatus, 200);
		assert.strictEqual(nonJson(result).nonJsonBody, '');
		// The reference reports this as `null`, indistinguishable from JSON null.
		assert.notStrictEqual(result.body, null);
	});

	it('does not redact the response body', async () => {
		// The user named one method and asked what it returns; masking part of the
		// answer would corrupt the thing being inspected.
		const secretish = { result: { accessToken: 'eyJhbGciOi.payload.sig', email: 'dev@example.com' } };
		const { fetchImpl } = stubFetch(jsonResponse(secretish));
		const result = await invokeRpc({ endpoint: ENDPOINT, method: 'auth.session', params: [], fetchImpl });

		assert.deepStrictEqual(result.body, secretish);
	});
});

describe('invokeRpc — the call could not reach anything', () => {
	it('reports a timeout as TIMEOUT with httpStatus 0 and a duration', async () => {
		const { fetchImpl } = stubFetch(() => {
			throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
		});
		const result = await invokeRpc({
			endpoint: ENDPOINT,
			method: 'todos.list',
			params: [],
			timeoutMs: 500,
			fetchImpl,
			now: stepClock(500),
		});

		assert.strictEqual(result.transportErrorCode, 'TIMEOUT');
		assert.strictEqual(result.ok, false);
		// 0, never a borrowed 502: nothing answered, so there is no status.
		assert.strictEqual(result.httpStatus, 0);
		assert.strictEqual(result.durationMs, 500);
		assert.strictEqual(result.body, null);
		assert.match(String(result.rpcError?.message), /500ms/);
	});

	it('reports an AbortError as TIMEOUT too', async () => {
		const { fetchImpl } = stubFetch(() => {
			throw Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
		});
		const result = await invokeRpc({ endpoint: ENDPOINT, method: 'todos.list', params: [], fetchImpl });

		assert.strictEqual(result.transportErrorCode, 'TIMEOUT');
	});

	it('reports a refused connection as UNREACHABLE, distinct from a timeout', async () => {
		const { fetchImpl } = stubFetch(() => {
			throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
		});
		const result = await invokeRpc({
			endpoint: ENDPOINT,
			method: 'todos.list',
			params: [],
			fetchImpl,
			now: stepClock(3),
		});

		// "not running" and "slow" lead to different next steps; the reference
		// reports both as unreachable under a 502 it made up.
		assert.strictEqual(result.transportErrorCode, 'UNREACHABLE');
		assert.strictEqual(result.ok, false);
		assert.strictEqual(result.httpStatus, 0);
		assert.strictEqual(result.durationMs, 3);
		assert.match(String(result.rpcError?.message), /ECONNREFUSED/);
	});

	it('never rejects, whatever was thrown', async () => {
		const { fetchImpl } = stubFetch(() => {
			throw 'a string, not an Error';
		});
		const result = await invokeRpc({ endpoint: ENDPOINT, method: 'todos.list', params: [], fetchImpl });

		assert.strictEqual(result.transportErrorCode, 'UNREACHABLE');
		assert.strictEqual(result.ok, false);
	});
});

describe('invokeRpc — the call never went out', () => {
	it('rejects a malformed method as BAD_METHOD without performing a fetch', async () => {
		const { fetchImpl, calls } = stubFetch(jsonResponse({ result: 'should never be reached' }));
		const result = await invokeRpc({ endpoint: ENDPOINT, method: '../../admin', params: [], fetchImpl });

		assert.strictEqual(calls.length, 0);
		assert.strictEqual(result.transportErrorCode, 'BAD_METHOD');
		assert.strictEqual(result.ok, false);
		assert.strictEqual(result.httpStatus, 0);
		assert.strictEqual(result.durationMs, 0);
		assert.strictEqual(result.body, null);
		assert.strictEqual(result.rpcError?.kind, 'protocol');
	});

	it('rejects every non namespace.method shape the same way', async () => {
		for (const method of ['todos', 'todos.', '.list', 'todos.list.extra', '1bad.method', '']) {
			const { fetchImpl, calls } = stubFetch(jsonResponse({ result: null }));
			const result = await invokeRpc({ endpoint: ENDPOINT, method, params: [], fetchImpl });
			assert.strictEqual(result.transportErrorCode, 'BAD_METHOD', method);
			assert.strictEqual(calls.length, 0, method);
		}
	});
});
