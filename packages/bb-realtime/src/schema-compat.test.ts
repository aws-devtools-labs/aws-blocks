// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Schema forward-compatibility tests.
 *
 * Confirms that connected clients receiving messages with additional fields
 * (from a namespace schema evolution) do not crash or lose data. The framework
 * passes the raw deserialized payload to handlers without receive-side
 * validation, ensuring additive schema changes are backward-compatible.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { Realtime } from './index.js';
import { attach, closeWebSocketServer, localRealtimeBus } from './ws-server.js';
import { LOCAL_TOKEN_SECRET } from './local-dev.js';
import { mintChannelToken } from './utils.js';
import { hydrate, __resetConnectionsForTest } from './mock-middleware.js';

(globalThis as any).WebSocket = (globalThis as any).WebSocket ?? WebSocket;

// ── Test schemas ────────────────────────────────────────────────────────────

// Schema v2: accepts { sender: string, text: string } plus any extra fields
function chatSchema(): StandardSchemaV1<{ sender: string; text: string; [k: string]: unknown }> {
	return {
		'~standard': {
			version: 1,
			vendor: 'test',
			validate(value: unknown) {
				const v = value as any;
				if (typeof v?.sender !== 'string' || typeof v?.text !== 'string') {
					return { issues: [{ message: 'Expected { sender: string, text: string }' }] };
				}
				return { value: v };
			},
		},
	};
}

function permissiveSchema(): StandardSchemaV1<any> {
	return { '~standard': { version: 1, vendor: 'test', validate: (v) => ({ value: v }) } };
}

const mockScope = { id: 'compat-test' };

// ── Unit-level tests (in-process EventEmitter path) ─────────────────────────

describe('Schema forward-compatibility (in-process)', () => {
	it('subscriber receives extra fields without error when schema evolves', async () => {
		const rt = new Realtime(mockScope, 'rt', {
			namespaces: { chat: Realtime.namespace(chatSchema()) },
		});

		const received: unknown[] = [];
		rt.subscribe('chat', 'room-1', (msg) => received.push(msg));

		// Publish message with additional fields (simulates schema v2 publish)
		await rt.publish('chat', 'room-1', {
			sender: 'alice',
			text: 'hello',
			timestamp: 1719430000,
			metadata: { priority: 'high' },
		});

		assert.strictEqual(received.length, 1);
		const msg = received[0] as any;
		assert.strictEqual(msg.sender, 'alice');
		assert.strictEqual(msg.text, 'hello');
		// Extra fields pass through — not stripped
		assert.strictEqual(msg.timestamp, 1719430000);
		assert.deepStrictEqual(msg.metadata, { priority: 'high' });
	});

	it('handler that destructures only old fields works fine with new fields present', async () => {
		const rt = new Realtime(mockScope, 'rt2', {
			namespaces: { chat: Realtime.namespace(chatSchema()) },
		});

		let result: { sender: string; text: string } | null = null;
		rt.subscribe('chat', 'room-1', (msg: any) => {
			const { sender, text } = msg;
			result = { sender, text };
		});

		await rt.publish('chat', 'room-1', {
			sender: 'bob',
			text: 'world',
			timestamp: 1719430001,
			reactions: ['👍'],
		});

		assert.deepStrictEqual(result, { sender: 'bob', text: 'world' });
	});

	it('various payload shapes pass through without framework error', async () => {
		const rt = new Realtime(mockScope, 'rt3', {
			namespaces: { events: Realtime.namespace(permissiveSchema()) },
		});

		const received: unknown[] = [];
		rt.subscribe('events', 'ch1', (msg) => received.push(msg));

		await rt.publish('events', 'ch1', { type: 'new_event', data: [1, 2, 3] });
		await rt.publish('events', 'ch1', 'just a string');
		await rt.publish('events', 'ch1', 42);

		assert.strictEqual(received.length, 3);
		assert.deepStrictEqual(received[0], { type: 'new_event', data: [1, 2, 3] });
		assert.strictEqual(received[1], 'just a string');
		assert.strictEqual(received[2], 42);
	});
});

// ── WebSocket-level test (confirms middleware catch protects subscriptions) ──

const WS_CHANNEL = 'compat-test-rt/chat/room-ws';

describe('Schema forward-compatibility (WebSocket)', () => {
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
		__resetConnectionsForTest();
		await new Promise<void>((resolve) => httpServer.close(() => resolve()));
	});

	it('handler that throws on new fields does not kill subscription', async () => {
		const token = mintChannelToken(WS_CHANNEL, LOCAL_TOKEN_SECRET);
		const client = hydrate({
			__blocks: 'realtime/channel',
			channel: WS_CHANNEL,
			wsUrl: `ws://localhost:${port}/realtime`,
			token,
		}) as any;

		const received: unknown[] = [];
		let callCount = 0;
		const sub = client.subscribe((msg: any) => {
			callCount++;
			if (callCount === 1) {
				// Old handler crashes on unexpected shape
				throw new Error('unexpected field!');
			}
			received.push(msg);
		});
		await sub.established;

		// First broadcast — handler throws, but middleware catches
		localRealtimeBus.emit('broadcast', { channel: WS_CHANNEL, payload: { sender: 'a', text: 'hi', newField: true } });
		await new Promise((r) => setTimeout(r, 100));

		// Second broadcast — subscription still alive
		localRealtimeBus.emit('broadcast', { channel: WS_CHANNEL, payload: { sender: 'b', text: 'bye' } });
		await new Promise((r) => setTimeout(r, 100));

		assert.strictEqual(callCount, 2, 'handler called for both messages');
		assert.strictEqual(received.length, 1, 'second message delivered after first handler threw');
		assert.deepStrictEqual(received[0], { sender: 'b', text: 'bye' });
		sub.unsubscribe();
	});

	it('extra fields in messages are delivered intact over WebSocket', async () => {
		const channel = 'compat-test-rt/chat/room-ws2';
		const token = mintChannelToken(channel, LOCAL_TOKEN_SECRET);
		const client = hydrate({
			__blocks: 'realtime/channel',
			channel,
			wsUrl: `ws://localhost:${port}/realtime`,
			token,
		}) as any;

		const received: unknown[] = [];
		const sub = client.subscribe((msg: any) => received.push(msg));
		await sub.established;

		localRealtimeBus.emit('broadcast', { channel, payload: { sender: 'x', text: 'hi', v2Field: [1, 2] } });
		await new Promise((r) => setTimeout(r, 100));

		assert.strictEqual(received.length, 1);
		const msg = received[0] as any;
		assert.strictEqual(msg.sender, 'x');
		assert.strictEqual(msg.text, 'hi');
		assert.deepStrictEqual(msg.v2Field, [1, 2]);
		sub.unsubscribe();
		__resetConnectionsForTest();
	});
});
