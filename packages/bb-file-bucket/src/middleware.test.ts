// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The file-bucket client middleware runs on every RPC response, so it must
 * return the server's data unchanged apart from the `file-bucket/*`
 * descriptors it rewrites. A JSON key named `__proto__` is an ordinary own
 * data property after `JSON.parse`; copying it with `result[k] = v` would set
 * the copy's prototype instead, dropping the key and making its contents look
 * inherited.
 *
 * Drives the middleware the way a frontend does: a real `ApiNamespaceClient`
 * call with `fetch` stubbed. Only `./middleware.js` is loaded, because the
 * package's `./middleware` and `./mock-middleware` exports both resolve to
 * it, so nothing else can hydrate the response in its place.
 */
import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert';
import { ApiNamespaceClient } from '@aws-blocks/core/client';
import './middleware.js';
import type { FileDownloadClient } from './types.js';

type Api = { get: () => Promise<unknown> };

let originalFetch: typeof globalThis.fetch;
let responseBody = '';

beforeEach(() => {
	originalFetch = globalThis.fetch;
	globalThis.fetch = async () => new Response(responseBody);
});

afterEach(() => {
	globalThis.fetch = originalFetch;
});

async function call(resultJson: string): Promise<unknown> {
	responseBody = `{"jsonrpc":"2.0","id":1,"result":${resultJson}}`;
	return ApiNamespaceClient<Api>('api', { url: 'http://localhost:3001/aws-blocks/api' }).get();
}

describe('file-bucket client middleware: own keys are preserved', () => {
	test('keeps an own "__proto__" key as data and leaves the prototype alone', async () => {
		const out = (await call('{"tags":{"__proto__":{"pinned":true},"bob":1}}')) as {
			tags: Record<string, unknown>;
		};
		assert.deepStrictEqual(Object.keys(out.tags), ['__proto__', 'bob']);
		assert.strictEqual(Object.getPrototypeOf(out.tags), Object.prototype);
		assert.deepStrictEqual(Object.getOwnPropertyDescriptor(out.tags, '__proto__')?.value, { pinned: true });
		assert.strictEqual('pinned' in out.tags, false);
		assert.strictEqual(out.tags.bob, 1);
	});

	test('still hydrates descriptors nested in objects and arrays', async () => {
		const download = '{"__blocks":"file-bucket/download","url":"https://example.invalid/a.txt"}';
		const out = (await call(`{"file":${download},"list":[${download},1]}`)) as {
			file: FileDownloadClient;
			list: [FileDownloadClient, number];
		};
		assert.strictEqual(out.file.getUrl(), 'https://example.invalid/a.txt');
		assert.ok(Array.isArray(out.list));
		assert.strictEqual(out.list[0].getUrl(), 'https://example.invalid/a.txt');
		assert.strictEqual(out.list[1], 1);
	});
});
