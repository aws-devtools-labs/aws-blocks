// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `createTestClient()` (`@aws-blocks/blocks/utils`): each test user's calls
 * carry that user's cookies and no one else's — not another test user's, not
 * the shared jar `installCookieJar()` puts on `fetch`. Against a real HTTP
 * server on loopback that sets a session cookie per sign-in.
 */

import assert from 'node:assert';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import { ApiNamespaceClient } from '@aws-blocks/core/client';
import { createTestClient, getLastAuthCode, installCookieJar } from './utils.js';

type SessionApi = {
	signIn(name: string): Promise<{ ok: true }>;
	whoAmI(): Promise<string | null>;
};

let server: Server;
let url: string;

before(async () => {
	server = createServer((req, res) => {
		let body = '';
		req.on('data', (c) => {
			body += c;
		});
		req.on('end', () => {
			const rpc: { method: string; params: unknown[]; id: number } = JSON.parse(body);
			const cookie = /(?:^|; )session=([^;]*)/.exec(req.headers.cookie ?? '')?.[1] ?? null;
			const headers: Record<string, string | string[]> = { 'content-type': 'application/json' };
			let result: unknown;
			if (rpc.method.endsWith('.signIn')) {
				headers['set-cookie'] = [`session=${String(rpc.params[0])}; Path=/; HttpOnly`];
				result = { ok: true };
			} else {
				result = cookie;
			}
			res.writeHead(200, headers).end(JSON.stringify({ jsonrpc: '2.0', result, id: rpc.id }));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/aws-blocks/api`;
});

after(() => {
	server.close();
});

describe('createTestClient', () => {
	test('two test users hold two sessions at once', async () => {
		const app = {
			api: ApiNamespaceClient<SessionApi>('api', { url }),
			other: ApiNamespaceClient<SessionApi>('other', { url }),
		};
		const alice = createTestClient(app);
		const bob = createTestClient(app);
		await alice.api.signIn('alice');
		await bob.api.signIn('bob');
		assert.strictEqual(await alice.api.whoAmI(), 'alice');
		assert.strictEqual(await bob.api.whoAmI(), 'bob');
		// One user's clients share the jar: a session started on one is sent by the others.
		assert.strictEqual(await alice.other.whoAmI(), 'alice');
		// The clients passed in are unchanged: they send no cookie.
		assert.strictEqual(await app.api.whoAmI(), null);
		assert.strictEqual(alice.api, alice.api, 'the same bound client each time');
	});

	test('a single client gets its own jar; values that are not clients pass through', async () => {
		const api = ApiNamespaceClient<SessionApi>('api', { url });
		const carol = createTestClient(api);
		await carol.signIn('carol');
		assert.strictEqual(await carol.whoAmI(), 'carol');
		const mixed = createTestClient({ api, version: 3 });
		assert.strictEqual(mixed.version, 3);
		assert.strictEqual(await mixed.api.whoAmI(), null);
	});

	test("installCookieJar's shared jar and test users' jars never mix", async () => {
		const restore = installCookieJar();
		try {
			const api = ApiNamespaceClient<SessionApi>('api', { url });
			await api.signIn('shared');
			const dave = createTestClient({ api });
			assert.strictEqual(await dave.api.whoAmI(), null, "the shared jar's cookie is not sent");
			await dave.api.signIn('dave');
			assert.strictEqual(await dave.api.whoAmI(), 'dave');
			assert.strictEqual(await api.whoAmI(), 'shared', "a test user's sign-in does not reach the shared jar");
		} finally {
			restore();
		}
	});

	test('a test user sends through the global fetch as it is at call time (a mock installed after import)', async () => {
		const api = ApiNamespaceClient<SessionApi>('api', { url });
		const erin = createTestClient({ api });
		const original = globalThis.fetch;
		const seen: string[] = [];
		globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
			seen.push(String(input));
			return original(input, init);
		}) as typeof fetch;
		try {
			await erin.api.signIn('erin');
			assert.strictEqual(await erin.api.whoAmI(), 'erin');
			assert.deepStrictEqual(seen, [`${url}/api`, `${url}/api`]);
		} finally {
			globalThis.fetch = original;
		}
		// Restored: later calls go straight to the restored fetch, and keep the session.
		assert.strictEqual(await erin.api.whoAmI(), 'erin');
		assert.strictEqual(seen.length, 2);
	});

	test('getLastAuthCode is exported next to it (from @aws-blocks/bb-auth/testing)', () => {
		assert.strictEqual(typeof getLastAuthCode, 'function');
	});
});
