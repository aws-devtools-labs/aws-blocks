// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for the local-dev WebSocket server.
 *
 * Regression coverage for BUG-1: a client that connected directly to the
 * WebSocket and sent a `subscribe` message without a token used to fall
 * through to `subscribe_success`, bypassing the API's requireAuth() gate.
 * The server must reject subscribe requests that omit a token, mirroring the
 * AWS Lambda authorizer.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { attach, closeWebSocketServer, localRealtimeBus } from './ws-server.js';
import { LOCAL_TOKEN_SECRET } from './local-dev.js';
import { mintChannelToken } from './utils.js';
import { hydrate, __resetConnectionsForTest } from './mock-middleware.js';

// The mock middleware uses the browser `WebSocket` global. Provide it from `ws`.
(globalThis as any).WebSocket = (globalThis as any).WebSocket ?? WebSocket;

const CHANNEL = 'my-app-rt/chat/secret-room';

let httpServer: Server;
let port: number;

before(async () => {
	httpServer = createServer();
	attach(httpServer);
	await new Promise<void>((resolve) => httpServer.listen(0, resolve));
	port = (httpServer.address() as AddressInfo).port;
});

after(async () => {
	closeWebSocketServer();
	await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

/** Open a connection, send one subscribe message, and resolve with the first server reply. */
function subscribe(message: Record<string, unknown>): Promise<{ ws: WebSocket; reply: any }> {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(`ws://localhost:${port}/realtime`);
		ws.on('open', () => ws.send(JSON.stringify({ action: 'subscribe', ...message })));
		ws.on('message', (data) => resolve({ ws, reply: JSON.parse(data.toString()) }));
		ws.on('error', reject);
	});
}

describe('WebSocket server: subscribe authorization', () => {
	it('rejects a subscribe with no token (BUG-1 regression)', async () => {
		const { ws, reply } = await subscribe({ channel: CHANNEL });
		assert.strictEqual(reply.type, 'error');
		assert.match(reply.message, /Unauthorized: missing token/);
		ws.close();
	});

	it('rejects a subscribe with an invalid token', async () => {
		const { ws, reply } = await subscribe({ channel: CHANNEL, token: 'not.a.valid.token' });
		assert.strictEqual(reply.type, 'error');
		assert.match(reply.message, /Unauthorized: invalid or expired token/);
		ws.close();
	});

	it('accepts a subscribe with a valid token', async () => {
		const token = mintChannelToken(CHANNEL, LOCAL_TOKEN_SECRET);
		const { ws, reply } = await subscribe({ channel: CHANNEL, token });
		assert.strictEqual(reply.type, 'subscribe_success');
		assert.strictEqual(reply.channel, CHANNEL);
		ws.close();
	});

	it('does not deliver messages to a client that failed to subscribe without a token', async () => {
		const token = mintChannelToken(CHANNEL, LOCAL_TOKEN_SECRET);

		// Authorized subscriber — should receive the broadcast.
		const authed = new WebSocket(`ws://localhost:${port}/realtime`);
		await new Promise<void>((resolve) => authed.on('open', resolve));
		const authedSubscribed = new Promise<void>((resolve) => {
			authed.on('message', (data) => {
				if (JSON.parse(data.toString()).type === 'subscribe_success') resolve();
			});
		});
		authed.send(JSON.stringify({ action: 'subscribe', channel: CHANNEL, token }));
		await authedSubscribed;

		// Unauthorized subscriber — token omitted, should be rejected and never join.
		const intruder = new WebSocket(`ws://localhost:${port}/realtime`);
		await new Promise<void>((resolve) => intruder.on('open', resolve));
		let intruderGotMessage = false;
		intruder.on('message', (data) => {
			if (JSON.parse(data.toString()).type === 'message') intruderGotMessage = true;
		});
		intruder.send(JSON.stringify({ action: 'subscribe', channel: CHANNEL }));

		// Give the intruder's rejected subscribe time to settle, then broadcast.
		await new Promise((r) => setTimeout(r, 50));
		const authedGotMessage = new Promise<{ type: string; channel: string; data: { sender: string; text: string } }>((resolve) => {
			authed.on('message', (data) => {
				const msg = JSON.parse(data.toString());
				if (msg.type === 'message') resolve(msg);
			});
		});
		localRealtimeBus.emit('broadcast', { channel: CHANNEL, data: { sender: 'alice', text: 'Top secret' } });

		const message = await authedGotMessage;
		assert.deepStrictEqual(message.data, { sender: 'alice', text: 'Top secret' });
		assert.strictEqual('payload' in message, false, 'local messages must use the AWS runtime data key');
		assert.strictEqual(intruderGotMessage, false, 'unauthorized client must not receive the broadcast');

		authed.close();
		intruder.close();
	});

	it('uses the data key when forwarding a client publish', async () => {
		const token = mintChannelToken(CHANNEL, LOCAL_TOKEN_SECRET);
		const { ws: subscriber } = await subscribe({ channel: CHANNEL, token });

		const received = new Promise<{ type: string; channel: string; data: { text: string } }>((resolve) => {
			subscriber.on('message', (data) => {
				const message = JSON.parse(data.toString());
				if (message.type === 'message') resolve(message);
			});
		});

		const publisher = new WebSocket(`ws://localhost:${port}/realtime`);
		await new Promise<void>((resolve, reject) => {
			publisher.on('open', resolve);
			publisher.on('error', reject);
		});
		publisher.send(JSON.stringify({ action: 'publish', channel: CHANNEL, payload: { text: 'from client' } }));

		const message = await received;
		assert.deepStrictEqual(message.data, { text: 'from client' });
		assert.strictEqual('payload' in message, false, 'local messages must use the AWS runtime data key');

		publisher.close();
		subscriber.close();
	});
});

describe('Mock middleware: token replay on reconnect (regression)', () => {
	it('resends the channel token after a reconnect so resubscribe is authorized', async () => {
		const token = mintChannelToken(CHANNEL, LOCAL_TOKEN_SECRET);

		// Hydrate a server-issued channel descriptor exactly as the client SDK would.
		const client = hydrate({
			__blocks: 'realtime/channel',
			channel: CHANNEL,
			wsUrl: `ws://localhost:${port}/realtime`,
			token,
		}) as { subscribe: (h: (m: unknown) => void) => { established: Promise<void>; connection: WebSocket; unsubscribe: () => void } };

		const received: any[] = [];
		const sub = client.subscribe((msg) => received.push(msg));
		await sub.established;

		// Force a reconnect by closing the underlying socket. The middleware's
		// onclose handler schedules a reconnect that resubscribes every channel.
		// Before the fix, that resubscribe omitted the token and the server
		// rejected it as "missing token", silently dropping the subscription.
		sub.connection.close();

		// Wait for the middleware to reconnect and resubscribe (backoff starts ~1s).
		await new Promise((r) => setTimeout(r, 1500));

		localRealtimeBus.emit('broadcast', { channel: CHANNEL, data: { text: 'after reconnect' } });

		// Allow the broadcast to round-trip to the reconnected client.
		await new Promise((r) => setTimeout(r, 200));

		assert.ok(
			received.some((m) => m?.text === 'after reconnect'),
			'client should still receive messages after reconnect (token must be replayed)',
		);

		sub.unsubscribe();
		__resetConnectionsForTest();
	});
});
