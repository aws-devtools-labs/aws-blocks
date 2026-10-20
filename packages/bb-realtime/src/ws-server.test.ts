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
import { connect as netConnect, type AddressInfo } from 'node:net';
import { PassThrough } from 'node:stream';
import { WebSocket } from 'ws';
import { attach, closeWebSocketServer, localRealtimeBus, isAllowedUpgradeOrigin } from './ws-server.js';
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

	it('uses the data key when broadcasting a server-side publish', async () => {
		const token = mintChannelToken(CHANNEL, LOCAL_TOKEN_SECRET);
		const { ws: subscriber } = await subscribe({ channel: CHANNEL, token });

		const received = new Promise<{ type: string; channel: string; data: { text: string } }>((resolve) => {
			subscriber.on('message', (data) => {
				const message = JSON.parse(data.toString());
				if (message.type === 'message') resolve(message);
			});
		});

		localRealtimeBus.emit('broadcast', { channel: CHANNEL, data: { text: 'from server' } });

		const message = await received;
		assert.deepStrictEqual(message.data, { text: 'from server' });
		assert.strictEqual('payload' in message, false, 'local messages must use the AWS runtime data key');

		subscriber.close();
	});
});

// Parity with the deployed WebSocket handler (index.aws.ts), which accepts only
// subscribe / unsubscribe / ping. A client-originated `publish` used to be
// broadcast locally with NO authorization of any kind, so any connected client
// could inject payloads into any channel.
describe('WebSocket server: client publish is not supported (parity with AWS)', () => {
	it('never broadcasts a client-originated publish, and tells the sender', async () => {
		const token = mintChannelToken(CHANNEL, LOCAL_TOKEN_SECRET);
		const { ws: subscriber } = await subscribe({ channel: CHANNEL, token });
		let leaked = false;
		subscriber.on('message', (data) => { if (JSON.parse(data.toString()).type === 'message') leaked = true; });

		const publisher = new WebSocket(`ws://localhost:${port}/realtime`);
		await new Promise<void>((resolve, reject) => { publisher.on('open', resolve); publisher.on('error', reject); });
		const reply = new Promise<{ type: string; message: string }>((resolve) => publisher.on('message', (d) => resolve(JSON.parse(d.toString()))));
		publisher.send(JSON.stringify({ action: 'publish', channel: CHANNEL, payload: { text: 'injected' } }));

		const r = await reply;
		assert.strictEqual(r.type, 'error');
		assert.match(r.message, /publish/i);
		await new Promise((res) => setTimeout(res, 150));
		assert.strictEqual(leaked, false, 'a client publish must never reach subscribers');
		publisher.close();
		subscriber.close();
	});
});

// WebSocket handshakes are exempt from CORS, so without an Origin check any page
// the developer visits could open ws://localhost:3000/realtime (cross-site
// WebSocket hijacking).
describe('WebSocket server: Origin validation on upgrade', () => {
	const open = (origin?: string) =>
		new Promise<'open' | number>((resolve) => {
			const ws = new WebSocket(`ws://localhost:${port}/realtime`, origin ? { origin } : {});
			ws.on('open', () => { ws.close(); resolve('open'); });
			ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
			ws.on('error', () => resolve(0));
		});

	it('rejects a cross-site Origin with 403', async () => {
		assert.strictEqual(await open('https://evil.example'), 403);
	});

	it('rejects a lookalike Origin (localhost as a subdomain)', async () => {
		assert.strictEqual(await open('http://localhost.evil.example:3000'), 403);
	});

	it('accepts loopback Origins (the dev server and its frontend)', async () => {
		assert.strictEqual(await open('http://localhost:3000'), 'open');
		assert.strictEqual(await open('http://127.0.0.1:3100'), 'open');
		assert.strictEqual(await open('http://[::1]:3000'), 'open');
	});

	it('accepts a client that sends no Origin (non-browser tools, server-side tests)', async () => {
		assert.strictEqual(await open(), 'open');
	});
});

describe('WebSocket server: raw-socket errors during upgrade (issue #1108 regression)', () => {
	it('survives a connection reset in the middle of a /realtime upgrade', async () => {
		const unhandled: unknown[] = [];
		const onUnhandled = (err: unknown) => unhandled.push(err);
		process.on('uncaughtException', onUnhandled);

		try {
			for (let i = 0; i < 20; i++) {
				const socket = netConnect({ host: '127.0.0.1', port });
				await new Promise<void>((resolve, reject) => {
					socket.once('connect', resolve);
					socket.once('error', reject);
				});
				socket.on('error', () => {}); // client side of the reset — not under test

				// Partial upgrade request: headers arrive, the handshake never completes.
				socket.write(
					'GET /realtime HTTP/1.1\r\n' +
						`Host: localhost:${port}\r\n` +
						'Upgrade: websocket\r\n' +
						'Connection: Upgrade\r\n' +
						'Sec-WebSocket-Version: 13\r\n' +
						'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n',
				);

				// Abort with RST (setNoDelay + destroy after linger 0) during the upgrade window.
				socket.resetAndDestroy();
				await new Promise((r) => setTimeout(r, 10));
			}

			// The event loop must still be alive and the server still serving.
			const token = mintChannelToken(CHANNEL, LOCAL_TOKEN_SECRET);
			const { ws, reply } = await subscribe({ channel: CHANNEL, token });
			assert.strictEqual(reply.type, 'subscribe_success');
			ws.close();

			assert.deepStrictEqual(unhandled, [], 'raw-socket errors during upgrade must not go unhandled');
		} finally {
			process.off('uncaughtException', onUnhandled);
		}
	});

	it('attaches a socket error listener before routing, and error triggers destroy', async () => {
		const probe = new PassThrough();

		// Drive the server's own upgrade listeners with a non-/realtime path so the
		// handler returns immediately after attaching its error listener.
		const req = { url: '/not-realtime', headers: { host: `localhost:${port}` } };
		for (const listener of httpServer.listeners('upgrade')) {
			(listener as (r: unknown, s: unknown, h: unknown) => void)(req, probe, Buffer.alloc(0));
		}

		assert.ok(probe.listenerCount('error') > 0, 'upgrade handler must attach a socket error listener');
		assert.doesNotThrow(() => probe.emit('error', new Error('ECONNRESET')));
		assert.strictEqual(probe.destroyed, true, 'socket error must destroy the socket');
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

	it('fires onReconnect after the mock reconnects and resubscribes (not on the initial subscribe)', async () => {
		const token = mintChannelToken(CHANNEL, LOCAL_TOKEN_SECRET);

		const events: string[] = [];
		const client = hydrate({
			__blocks: 'realtime/channel',
			channel: CHANNEL,
			wsUrl: `ws://localhost:${port}/realtime`,
			token,
		}) as {
			subscribe: (o: {
				onMessage: (m: unknown) => void;
				onDisconnect?: (reason: string) => void;
				onReconnect?: () => void;
			}) => { established: Promise<void>; connection: WebSocket; unsubscribe: () => void };
		};

		const sub = client.subscribe({
			onMessage: () => {},
			onDisconnect: () => { events.push('disconnect'); },
			onReconnect: () => { events.push('reconnect'); },
		});
		await sub.established;

		// onReconnect must NOT fire on the initial connect.
		assert.strictEqual(events.length, 0, 'onReconnect must not fire on the initial subscribe');

		// Force a reconnect by closing the underlying socket. The middleware's
		// onclose schedules a reconnect that resubscribes and then fires onReconnect.
		sub.connection.close();

		// Wait for the reconnect (backoff starts ~1s) and resubscribe to complete.
		await new Promise((r) => setTimeout(r, 1500));

		assert.ok(events.includes('disconnect'), 'onDisconnect fires on the drop');
		assert.ok(events.includes('reconnect'), 'onReconnect fires after the reconnect resubscribes');
		assert.strictEqual(events[events.length - 1], 'reconnect', 'onReconnect fires after the disconnect');

		sub.unsubscribe();
		__resetConnectionsForTest();
	});
});

describe('isAllowedUpgradeOrigin — BLOCKS_DEV_HOST opt-in', () => {
	it('a WILDCARD opt-in (0.0.0.0 / ::) admits a same-origin page reached by IP address', () => {
		assert.strictEqual(isAllowedUpgradeOrigin('http://192.168.1.10:3000', '0.0.0.0', '192.168.1.10:3000'), true);
		assert.strictEqual(isAllowedUpgradeOrigin('http://[fd00::1]:3000', '::', '[fd00::1]:3000'), true);
	});

	it('a wildcard opt-in rejects a DNS-name Origin even when it matches Host (DNS rebinding)', () => {
		// evil.example re-pointed at this machine: the browser sends Origin and Host both = evil.example
		assert.strictEqual(isAllowedUpgradeOrigin('http://evil.example:3000', '0.0.0.0', 'evil.example:3000'), false);
	});

	it('a wildcard opt-in rejects a cross-origin IP, and requires a Host to compare against', () => {
		assert.strictEqual(isAllowedUpgradeOrigin('http://10.0.0.5:3000', '0.0.0.0', '10.0.0.6:3000'), false);
		assert.strictEqual(isAllowedUpgradeOrigin('http://10.0.0.5:3000', '0.0.0.0', undefined), false);
	});

	it('a concrete opt-in admits exactly that host (case-insensitive) and nothing else', () => {
		assert.strictEqual(isAllowedUpgradeOrigin('https://MyBox.example.com', 'mybox.example.com', 'mybox.example.com'), true);
		assert.strictEqual(isAllowedUpgradeOrigin('https://other.example.com', 'mybox.example.com', 'other.example.com'), false);
	});

	it('without an opt-in, a LAN origin is rejected', () => {
		assert.strictEqual(isAllowedUpgradeOrigin('http://192.168.1.10:3000', undefined, '192.168.1.10:3000'), false);
	});
});
