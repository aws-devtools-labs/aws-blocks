// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { ApiNamespaceClient } from './index.js';
import { isStaleConnectionError } from './stale-connection.js';

/**
 * What the abrupt-close server does with a request it does not answer normally.
 *
 * - `fin`: `socket.end()` — the client sees `other side closed` (`UND_ERR_SOCKET`).
 * - `rst`: `socket.resetAndDestroy()` — the client sees `ECONNRESET`.
 */
type DropMode = 'fin' | 'rst';

interface AbruptServer {
	url: string;
	/** Every request that reached the server, answered or dropped, as `method:params[0]`. */
	arrived: string[];
	/** Requests the RPC handler actually executed, as `params[0]`. */
	executed: string[];
	close(): Promise<void>;
}

/**
 * A JSON-RPC echo server that closes keep-alive sockets abruptly, the way a deployed
 * API endpoint (API Gateway, a load balancer) closes an idle pooled connection at the
 * moment the client reuses it.
 *
 * `drop(n)` decides, for the n-th request on a socket (1-based), whether to drop it
 * without a response. It advertises `Keep-Alive: timeout=60` so the client keeps the
 * socket pooled and reuses it.
 */
async function startAbruptServer(opts: {
	drop: (requestOnSocket: number) => boolean;
	mode: DropMode;
	/** Send the response headers and part of the body, then reset the socket. */
	truncateResponse?: boolean;
}): Promise<AbruptServer> {
	const arrived: string[] = [];
	const executed: string[] = [];
	const perSocket = new WeakMap<Socket, number>();
	const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
		const n = (perSocket.get(req.socket) ?? 0) + 1;
		perSocket.set(req.socket, n);
		let body = '';
		req.setEncoding('utf-8');
		req.on('data', (chunk: string) => {
			body += chunk;
		});
		req.on('end', () => {
			const rpc = JSON.parse(body) as { id: number; method: string; params: unknown[] };
			arrived.push(`${rpc.method}:${String(rpc.params[0])}`);
			if (opts.drop(n)) {
				// Dropped before the handler runs: an idle close never executes the request.
				if (opts.mode === 'rst') req.socket.resetAndDestroy();
				else req.socket.end();
				return;
			}
			executed.push(String(rpc.params[0]));
			const payload = JSON.stringify({ jsonrpc: '2.0', result: rpc.params[0], id: rpc.id });
			res.setHeader('content-type', 'application/json');
			res.setHeader('keep-alive', 'timeout=60');
			if (opts.truncateResponse) {
				res.setHeader('content-length', String(payload.length));
				res.write(payload.slice(0, 5), () => {
					setTimeout(() => req.socket.resetAndDestroy(), 20);
				});
				return;
			}
			res.end(payload);
		});
	});
	server.keepAliveTimeout = 60_000;
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const { port } = server.address() as AddressInfo;
	return {
		url: `http://127.0.0.1:${port}/aws-blocks/api`,
		arrived,
		executed,
		close: () =>
			new Promise<void>((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	};
}

/** Let undici finish returning the first response's socket to the pool before reusing it. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

describe('client: stale pooled keep-alive socket (FX54)', () => {
	for (const mode of ['fin', 'rst'] as const) {
		describe(`server drops a reused socket (${mode === 'fin' ? 'other side closed' : 'ECONNRESET'})`, () => {
			let srv: AbruptServer;
			before(async () => {
				srv = await startAbruptServer({ drop: (n) => n > 1, mode });
			});
			after(() => srv.close());

			it('the call after an idle gap succeeds, and the server executes it exactly once', async () => {
				const api = ApiNamespaceClient<{ echo(v: string): string }>('api', { url: srv.url });
				assert.strictEqual(await api.echo('first'), 'first');
				await settle();
				assert.strictEqual(await api.echo('second'), 'second');
				// The first copy of 'second' reached the dropped socket and was never executed;
				// the one resend went out on a fresh connection.
				assert.deepStrictEqual(srv.arrived, ['api.echo:first', 'api.echo:second', 'api.echo:second']);
				assert.deepStrictEqual(srv.executed, ['first', 'second']);
			});
		});
	}

	it('retries at most once: a connection that fails twice surfaces the error', async () => {
		const srv = await startAbruptServer({ drop: () => true, mode: 'fin' });
		try {
			const api = ApiNamespaceClient<{ echo(v: string): string }>('api', { url: srv.url });
			await assert.rejects(api.echo('never'), (e: unknown) => {
				assert.ok(e instanceof TypeError, `expected TypeError, got ${String(e)}`);
				assert.strictEqual(e.message, 'fetch failed');
				return true;
			});
			assert.deepStrictEqual(srv.arrived, ['api.echo:never', 'api.echo:never']);
			assert.deepStrictEqual(srv.executed, []);
		} finally {
			await srv.close();
		}
	});

	it('never retries once response bytes arrived (connection lost mid-body)', async () => {
		const srv = await startAbruptServer({ drop: () => false, mode: 'rst', truncateResponse: true });
		try {
			const api = ApiNamespaceClient<{ echo(v: string): string }>('api', { url: srv.url });
			await assert.rejects(api.echo('once'));
			assert.deepStrictEqual(srv.arrived, ['api.echo:once']);
			assert.deepStrictEqual(srv.executed, ['once']);
		} finally {
			await srv.close();
		}
	});
});

describe('isStaleConnectionError', () => {
	/** What Node's fetch (undici) rejects with for a network failure. */
	const fetchFailed = (cause: unknown) => new TypeError('fetch failed', { cause });
	const withCode = (code: string, message = code) => Object.assign(new Error(message), { code });

	it('matches the socket errors a stale pooled connection produces', () => {
		assert.strictEqual(isStaleConnectionError(fetchFailed(withCode('UND_ERR_SOCKET', 'other side closed'))), true);
		assert.strictEqual(isStaleConnectionError(fetchFailed(withCode('ECONNRESET', 'read ECONNRESET'))), true);
		assert.strictEqual(isStaleConnectionError(fetchFailed(withCode('EPIPE', 'write EPIPE'))), true);
		assert.strictEqual(isStaleConnectionError(fetchFailed(new Error('other side closed'))), true);
	});

	it('does not match timeouts or aborts', () => {
		for (const code of [
			'UND_ERR_HEADERS_TIMEOUT',
			'UND_ERR_BODY_TIMEOUT',
			'UND_ERR_CONNECT_TIMEOUT',
			'ETIMEDOUT',
			'UND_ERR_ABORTED',
		]) {
			assert.strictEqual(isStaleConnectionError(fetchFailed(withCode(code))), false, code);
		}
		assert.strictEqual(isStaleConnectionError(new DOMException('aborted', 'AbortError')), false);
		assert.strictEqual(isStaleConnectionError(new DOMException('timed out', 'TimeoutError')), false);
	});

	it('does not match other failures', () => {
		// A refused or unresolvable connection is not a stale pooled socket.
		assert.strictEqual(isStaleConnectionError(fetchFailed(withCode('ECONNREFUSED'))), false);
		assert.strictEqual(isStaleConnectionError(fetchFailed(withCode('ENOTFOUND'))), false);
		// Browsers reject with a bare TypeError and no cause (they resend on a stale socket themselves).
		assert.strictEqual(isStaleConnectionError(new TypeError('Failed to fetch')), false);
		// The socket code alone, without fetch's TypeError wrapper, is not a fetch network failure.
		assert.strictEqual(isStaleConnectionError(withCode('ECONNRESET')), false);
		assert.strictEqual(isStaleConnectionError(new TypeError('fetch failed')), false);
		assert.strictEqual(isStaleConnectionError(undefined), false);
		assert.strictEqual(isStaleConnectionError('ECONNRESET'), false);
	});
});
