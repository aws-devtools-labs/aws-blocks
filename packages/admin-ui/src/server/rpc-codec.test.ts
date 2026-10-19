// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { encodeRpcRequest, extractRpcError, hasRpcResult, isValidRpcMethod, resetRpcIdForTests } from './rpc-codec.js';

describe('isValidRpcMethod', () => {
	it('accepts namespace.method', () => {
		for (const method of ['todos.list', 'Todos.listAll', '_private.$dollar', 'a1.b2']) {
			assert.strictEqual(isValidRpcMethod(method), true, method);
		}
	});

	it('rejects anything that is not two identifiers', () => {
		for (const method of ['todos', 'todos.', '.list', 'todos.list.extra', '1bad.method', 'todos list', '']) {
			assert.strictEqual(isValidRpcMethod(method), false, method);
		}
	});

	it('rejects a traversal-shaped method before it can be posted anywhere', () => {
		for (const method of ['../../admin', 'todos.list/../../x', 'http://evil.example']) {
			assert.strictEqual(isValidRpcMethod(method), false, method);
		}
	});
});

describe('encodeRpcRequest', () => {
	it('emits the exact wire shape core parses', () => {
		resetRpcIdForTests();
		assert.strictEqual(
			encodeRpcRequest('todos.list', [{ limit: 10 }]),
			'{"jsonrpc":"2.0","method":"todos.list","params":[{"limit":10}],"id":1}',
		);
	});

	it('keeps params positional, including an empty call', () => {
		resetRpcIdForTests();
		assert.strictEqual(
			encodeRpcRequest('todos.count', []),
			'{"jsonrpc":"2.0","method":"todos.count","params":[],"id":1}',
		);
	});

	it('increments the id, so two calls are distinguishable', () => {
		resetRpcIdForTests();
		const first = JSON.parse(encodeRpcRequest('a.b', []));
		const second = JSON.parse(encodeRpcRequest('a.b', []));
		assert.strictEqual(first.id, 1);
		assert.strictEqual(second.id, 2);
		// The reference uses Date.now(), which repeats within a millisecond.
		assert.notStrictEqual(first.id, second.id);
	});
});

describe('extractRpcError', () => {
	it('reads an application error as application, keyed off a positive code', () => {
		const info = extractRpcError({ error: { code: 409, message: 'Todo already exists' } });
		assert.deepStrictEqual(info, { code: 409, message: 'Todo already exists', kind: 'application' });
	});

	it('reads a reserved -32xxx code as protocol', () => {
		const info = extractRpcError({ error: { code: -32601, message: 'Method not found' } });
		assert.strictEqual(info?.kind, 'protocol');
	});

	it('carries the Blocks error name and retriable flag from data', () => {
		const info = extractRpcError({
			error: { code: 503, message: 'Try again', data: { name: 'ThrottledError', retriable: true } },
		});
		assert.strictEqual(info?.name, 'ThrottledError');
		assert.strictEqual(info?.retriable, true);
	});

	it('omits retriable when it is not literally true', () => {
		const info = extractRpcError({ error: { code: 500, message: 'x', data: { retriable: 'yes' } } });
		assert.strictEqual(info?.retriable, undefined);
	});

	it('substitutes a message rather than reporting an empty error', () => {
		const info = extractRpcError({ error: { code: 500 } });
		assert.match(info?.message ?? '', /no message/);
	});

	it('treats a coded-less error as protocol, since it cannot be attributed to app logic', () => {
		assert.strictEqual(extractRpcError({ error: { message: 'something' } })?.kind, 'protocol');
	});

	it('returns undefined for a success body, a non-object and a non-envelope', () => {
		for (const body of [{ result: [] }, { jsonrpc: '2.0', result: null, id: 1 }, null, 'text', 42, [], {}]) {
			assert.strictEqual(extractRpcError(body), undefined, JSON.stringify(body));
		}
	});

	it('returns undefined when error is present but not an object', () => {
		assert.strictEqual(extractRpcError({ error: 'boom' }), undefined);
	});
});

describe('hasRpcResult', () => {
	it('is true for a result, including a null one', () => {
		// A method returning null is a SUCCESS. Treating a null result as "no
		// result" would report a working void method as a failure.
		assert.strictEqual(hasRpcResult({ result: null }), true);
		assert.strictEqual(hasRpcResult({ result: [] }), true);
	});

	it('is false for an error envelope and for a non-envelope', () => {
		assert.strictEqual(hasRpcResult({ error: { message: 'x' } }), false);
		assert.strictEqual(hasRpcResult(null), false);
		assert.strictEqual(hasRpcResult('<html>502</html>'), false);
	});
});

describe('drift guard against packages/core, the source of truth', () => {
	/**
	 * `admin-ui` reimplements the codec rather than depending on core (see
	 * `rpc-codec.ts` for why). This asserts the two agree, so core changing the
	 * wire format cannot leave the dashboard silently speaking the old one.
	 *
	 * Skipped when core's build is not resolvable, which is the case for a
	 * standalone install of this package — a skip is correct there, a failure
	 * would be noise.
	 */
	const here = dirname(fileURLToPath(import.meta.url));
	// dist/server/ → packages/admin-ui/ → packages/ → core
	const coreRpc = join(here, '..', '..', '..', 'core', 'dist', 'rpc.js');

	it('produces the same wire bytes as core.encodeRpcRequest', async (t) => {
		if (!existsSync(coreRpc)) {
			t.skip(`core build not present at ${coreRpc} — standalone install, nothing to compare against`);
			return;
		}
		const core = (await import(coreRpc)) as {
			encodeRpcRequest: (namespace: string, method: string, args: unknown[]) => string;
		};

		for (const [namespace, method, args] of [
			['todos', 'list', []],
			['todos', 'create', [{ title: 'x', done: false }]],
			['users', 'find', ['u1', 42, null]],
		] as [string, string, unknown[]][]) {
			resetRpcIdForTests();
			const ours = JSON.parse(encodeRpcRequest(`${namespace}.${method}`, args));
			const theirs = JSON.parse(core.encodeRpcRequest(namespace, method, args));
			// Ids are independent counters by design; everything else must match.
			assert.deepStrictEqual(
				{ ...ours, id: 0 },
				{ ...theirs, id: 0 },
				`wire format drift for ${namespace}.${method} — reconcile with packages/core/src/rpc.ts`,
			);
			assert.strictEqual(typeof theirs.id, 'number');
		}
	});
});
