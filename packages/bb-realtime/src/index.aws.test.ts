/**
 * AWS runtime `subscribe()` lifecycle tests.
 *
 * Uses a loopback fake SSM endpoint and a stub `globalThis.WebSocket`; no AWS calls.
 */

import assert from 'node:assert';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { Scope } from '@aws-blocks/core';
import { Realtime } from './index.aws.js';

class FakeWebSocket {
	static instances: FakeWebSocket[] = [];
	closed = false;
	onopen: (() => void) | null = null;
	onmessage: ((ev: { data: string }) => void) | null = null;
	onclose: (() => void) | null = null;
	onerror: (() => void) | null = null;
	constructor(public url: string) {
		FakeWebSocket.instances.push(this);
	}
	send(_data: string): void {}
	close(): void {
		this.closed = true;
	}
}

describe('Realtime (AWS runtime): subscribe() unsubscribe', () => {
	let srv: http.Server;
	let rt: InstanceType<typeof Realtime>;
	// Drains the cached secret promise and its `.then` continuation (no wall-clock wait).
	const settle = async () => {
		await (rt as unknown as { _cachedSecretPromise: Promise<unknown> })._cachedSecretPromise;
		await new Promise(setImmediate);
	};
	const savedEnv = { ...process.env };
	const savedWs = (globalThis as { WebSocket: unknown }).WebSocket;

	before(async () => {
		srv = http.createServer((req, res) => {
			req.resume();
			req.on('end', () => {
				res.setHeader('content-type', 'application/x-amz-json-1.1');
				res.end(
					JSON.stringify({
						Parameter: { Name: '/x', Value: JSON.stringify('test-secret'), Type: 'SecureString' },
					}),
				);
			});
		});
		await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
		Object.assign(process.env, {
			AWS_ENDPOINT_URL: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`,
			AWS_ACCESS_KEY_ID: 'fake',
			AWS_SECRET_ACCESS_KEY: 'fake',
			AWS_REGION: 'us-east-1',
			AWS_EC2_METADATA_DISABLED: 'true',
			BLOCKS_RT_WS_URL: 'wss://example.invalid/rt',
		});
		(globalThis as { WebSocket: unknown }).WebSocket = FakeWebSocket;
		const schema = { '~standard': { version: 1, vendor: 't', validate: (v: unknown) => ({ value: v }) } } as const;
		rt = new Realtime(new Scope('app'), 'rt', { namespaces: { chat: Realtime.namespace(schema) } });
		await settle();
	});

	after(() => {
		srv.close();
		process.env = savedEnv;
		(globalThis as { WebSocket: unknown }).WebSocket = savedWs;
	});

	it('unsubscribing synchronously never leaves a socket open or calls the handler', async () => {
		FakeWebSocket.instances = [];
		const got: unknown[] = [];
		const off = rt.subscribe('chat', 'room-1', (m: unknown) => got.push(m));
		off();
		await settle();
		for (const ws of FakeWebSocket.instances) {
			ws.onmessage?.({ data: JSON.stringify({ type: 'message', channel: 'app-rt/chat/room-1', data: 'late' }) });
		}
		assert.deepStrictEqual(
			FakeWebSocket.instances.filter((ws) => !ws.closed).length,
			0,
			'socket left open after unsubscribe',
		);
		assert.deepStrictEqual(got, []);
	});

	it('unsubscribing after the socket is attached closes it', async () => {
		FakeWebSocket.instances = [];
		const off = rt.subscribe('chat', 'room-2', () => {});
		await settle();
		assert.strictEqual(FakeWebSocket.instances.length, 1);
		assert.strictEqual(FakeWebSocket.instances[0].closed, false);
		off();
		assert.strictEqual(FakeWebSocket.instances[0].closed, true);
	});
});
