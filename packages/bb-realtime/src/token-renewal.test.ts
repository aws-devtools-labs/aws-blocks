// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * What the client transport does when the server ends a live subscription
 * because its channel token expired or access was revoked (the server checks on
 * every keep-alive ping): a channel with `refresh` renews in place, any other
 * channel reports `onDisconnect('error')`. Driven with a fake in-process WebSocket.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { hydrate, __resetConnectionsForTest } from './aws-middleware.js';
import type { RealtimeChannelClient } from './aws-middleware.js';
import { hydrate as mockHydrate, __resetConnectionsForTest as mockReset } from './mock-middleware.js';
import type { DisconnectReason, RealtimeChannelDescriptor } from './types.js';

const CHANNEL = 'my-app-rt/chat/room-1';
const WS_URL = 'wss://example.execute-api.us-west-2.amazonaws.com/renew';

class FakeWebSocket {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;
	static instances: FakeWebSocket[] = [];

	readonly url: string;
	readyState: number = FakeWebSocket.CONNECTING;
	sent: Record<string, unknown>[] = [];
	onopen: ((ev: unknown) => void) | null = null;
	onmessage: ((ev: { data: string }) => void) | null = null;
	onerror: ((ev: unknown) => void) | null = null;
	onclose: ((ev: { code?: number }) => void) | null = null;

	constructor(url: string) {
		this.url = url;
		FakeWebSocket.instances.push(this);
	}

	send(data: string): void { this.sent.push(JSON.parse(data)); }
	close(): void { this.readyState = FakeWebSocket.CLOSED; this.onclose?.({ code: 1000 }); }
	emitOpen(): void { this.readyState = FakeWebSocket.OPEN; this.onopen?.({}); }
	emitMessage(payload: unknown): void { this.onmessage?.({ data: JSON.stringify(payload) }); }
	subscribes(): Record<string, unknown>[] { return this.sent.filter(f => f.action === 'subscribe'); }
}

function isChannelClient(value: unknown): value is RealtimeChannelClient {
	return typeof value === 'object' && value !== null && 'subscribe' in value;
}

const descriptor = (token: string): RealtimeChannelDescriptor & { wsUrl: string; connectToken: string; token: string } => ({
	__blocks: 'realtime/channel', channel: CHANNEL, wsUrl: WS_URL, connectToken: 'connect-1', token,
});

const tick = () => new Promise((resolve) => setImmediate(resolve));

for (const [label, hydrateFn, resetFn] of [
	['AWS middleware', hydrate, __resetConnectionsForTest],
	['mock middleware', mockHydrate, mockReset],
] as const) {
	describe(`${label}: server ends a live subscription`, () => {
		beforeEach(() => {
			FakeWebSocket.instances = [];
			Object.defineProperty(globalThis, 'WebSocket', { value: FakeWebSocket, configurable: true, writable: true });
		});
		afterEach(() => { resetFn(); });

		function live(options: { refresh?: () => Promise<RealtimeChannelDescriptor> }) {
			const client = hydrateFn(descriptor('token-1'));
			assert.ok(isChannelClient(client));
			const reasons: DisconnectReason[] = [];
			let reconnects = 0;
			const sub = client.subscribe({ onMessage: () => {}, onDisconnect: (r) => reasons.push(r), onReconnect: () => { reconnects++; }, ...options });
			const socket = FakeWebSocket.instances[0];
			socket.emitOpen();
			socket.emitMessage({ type: 'subscribe_success', channel: CHANNEL });
			return { sub, socket, reasons, reconnects: () => reconnects };
		}

		it('reports onDisconnect("error") when the channel cannot renew', async () => {
			const { socket, reasons } = live({});
			socket.emitMessage({ type: 'error', channel: CHANNEL, code: 'access_revoked', message: 'Unauthorized: access revoked' });
			await tick();
			assert.deepStrictEqual(reasons, ['error']);
		});

		it('reports onDisconnect("error") for a revoked channel even though it can refresh', async () => {
			let refreshed = 0;
			const { socket, reasons } = live({ refresh: async () => { refreshed++; return descriptor('token-2'); } });
			socket.emitMessage({ type: 'error', channel: CHANNEL, code: 'access_revoked', message: 'Unauthorized: access revoked' });
			await tick();
			assert.deepStrictEqual(reasons, ['error']);
			assert.strictEqual(refreshed, 0, 'a revoked subscription is not renewed');
		});
	});
}

for (const [label, hydrateFn, resetFn] of [
	['AWS middleware', hydrate, __resetConnectionsForTest],
	['mock middleware', mockHydrate, mockReset],
] as const) describe(`${label}: expired token renews in place`, () => {
	beforeEach(() => {
		FakeWebSocket.instances = [];
		Object.defineProperty(globalThis, 'WebSocket', { value: FakeWebSocket, configurable: true, writable: true });
	});
	afterEach(() => { resetFn(); });

	function live(refresh?: () => Promise<RealtimeChannelDescriptor>) {
		const client = hydrateFn(descriptor('token-1'));
		assert.ok(isChannelClient(client));
		const reasons: DisconnectReason[] = [];
		let reconnects = 0;
		client.subscribe({ onMessage: () => {}, onDisconnect: (r) => reasons.push(r), onReconnect: () => { reconnects++; }, ...(refresh ? { refresh } : {}) });
		const socket = FakeWebSocket.instances[0];
		socket.emitOpen();
		socket.emitMessage({ type: 'subscribe_success', channel: CHANNEL });
		return { socket, reasons, reconnects: () => reconnects };
	}

	it('fetches a fresh descriptor and subscribes again on the same socket, without disconnecting', async () => {
		const { socket, reasons, reconnects } = live(async () => descriptor('token-2'));
		socket.emitMessage({ type: 'error', channel: CHANNEL, code: 'token_expired', message: 'Unauthorized: token expired' });
		await tick();
		assert.deepStrictEqual(socket.subscribes().map(f => f.token), ['token-1', 'token-2']);
		assert.deepStrictEqual(reasons, []);
		assert.strictEqual(reconnects(), 0);
		assert.strictEqual(FakeWebSocket.instances.length, 1);
	});

	it('reports onDisconnect("error") when the renewal fails', async () => {
		const { socket, reasons } = live(async () => { throw new Error('refresh failed'); });
		socket.emitMessage({ type: 'error', channel: CHANNEL, code: 'token_expired', message: 'Unauthorized: token expired' });
		await tick();
		await tick();
		assert.deepStrictEqual(reasons, ['error']);
		assert.deepStrictEqual(socket.subscribes().map(f => f.token), ['token-1']);
	});

	it('reports onDisconnect("error") when the channel has no refresh', async () => {
		const { socket, reasons } = live();
		socket.emitMessage({ type: 'error', channel: CHANNEL, code: 'token_expired', message: 'Unauthorized: token expired' });
		await tick();
		assert.deepStrictEqual(reasons, ['error']);
	});
});

for (const [label, hydrateFn, resetFn] of [
	['AWS middleware', hydrate, __resetConnectionsForTest],
	['mock middleware', mockHydrate, mockReset],
] as const) describe(`${label}: one channel ending does not disturb its siblings`, () => {
	beforeEach(() => {
		FakeWebSocket.instances = [];
		Object.defineProperty(globalThis, 'WebSocket', { value: FakeWebSocket, configurable: true, writable: true });
	});
	afterEach(() => { resetFn(); });

	it('notifies only the ended channel, and not again on a later drop', async () => {
		const other = 'my-app-rt/chat/room-2';
		const open = (channel: string, reasons: DisconnectReason[]) => {
			const client = hydrateFn({ ...descriptor('token-1'), channel });
			assert.ok(isChannelClient(client));
			client.subscribe({ onMessage: () => {}, onDisconnect: (r) => reasons.push(r) });
		};
		const endedReasons: DisconnectReason[] = [];
		const siblingReasons: DisconnectReason[] = [];
		open(CHANNEL, endedReasons);
		open(other, siblingReasons);
		const socket = FakeWebSocket.instances[0];
		socket.emitOpen();
		socket.emitMessage({ type: 'subscribe_success', channel: CHANNEL });
		socket.emitMessage({ type: 'subscribe_success', channel: other });
		socket.emitMessage({ type: 'error', channel: CHANNEL, code: 'access_revoked', message: 'Unauthorized: access revoked' });
		await tick();
		assert.deepStrictEqual(endedReasons, ['error']);
		assert.deepStrictEqual(siblingReasons, []);
		socket.close();
		await tick();
		assert.deepStrictEqual(endedReasons, ['error'], 'the ended channel is not notified of a later drop');
	});
});

describe('client pool: one socket per endpoint and principal', () => {
	/** A connect token whose payload names `sub`, as the server mints it (the signature is irrelevant to pooling). */
	const connectTokenFor = (sub?: string) =>
		`${Buffer.from(JSON.stringify({ channel: 'my-app-rt$connect', exp: 1, iat: 1, jti: 'x', ...(sub ? { sub } : {}) })).toString('base64url')}.sig`;

	for (const [label, hydrateFn, resetFn] of [
		['AWS middleware', hydrate, __resetConnectionsForTest],
		['mock middleware', mockHydrate, mockReset],
	] as const) {
		describe(label, () => {
			beforeEach(() => {
				FakeWebSocket.instances = [];
				Object.defineProperty(globalThis, 'WebSocket', { value: FakeWebSocket, configurable: true, writable: true });
			});
			afterEach(() => { resetFn(); });

			const subscribeWith = (channel: string, connectToken: string) => {
				const client = hydrateFn({ __blocks: 'realtime/channel', channel, wsUrl: WS_URL, connectToken, token: 't' });
				assert.ok(isChannelClient(client));
				client.subscribe(() => {});
			};

			it('opens a separate socket per principal, each carrying its own connect token', () => {
				const a = connectTokenFor('user-a');
				const b = connectTokenFor('user-b');
				subscribeWith('my-app-rt/chat/a', a);
				subscribeWith('my-app-rt/chat/b', b);
				assert.strictEqual(FakeWebSocket.instances.length, 2);
				assert.ok(FakeWebSocket.instances[0].url.endsWith(encodeURIComponent(a)));
				assert.ok(FakeWebSocket.instances[1].url.endsWith(encodeURIComponent(b)));
			});

			it('keeps a user-bound handle off the socket of an unbound one', () => {
				subscribeWith('my-app-rt/chat/a', connectTokenFor());
				subscribeWith('my-app-rt/chat/b', connectTokenFor('user-a'));
				assert.strictEqual(FakeWebSocket.instances.length, 2);
			});

			it('drops a channel whose refresh returns a handle for a different user', async () => {
				const reasons: DisconnectReason[] = [];
				const client = hydrateFn({ __blocks: 'realtime/channel', channel: CHANNEL, wsUrl: WS_URL, connectToken: connectTokenFor('user-a'), token: 't1' });
				assert.ok(isChannelClient(client));
				client.subscribe({
					onMessage: () => {},
					onDisconnect: (r) => reasons.push(r),
					refresh: async () => ({ __blocks: 'realtime/channel', channel: CHANNEL, wsUrl: WS_URL, connectToken: connectTokenFor('user-b'), token: 't2' }),
				});
				const socket = FakeWebSocket.instances[0];
				socket.emitOpen();
				socket.emitMessage({ type: 'subscribe_success', channel: CHANNEL });
				socket.emitMessage({ type: 'error', channel: CHANNEL, code: 'token_expired', message: 'Unauthorized: token expired' });
				await tick();
				await tick();
				assert.deepStrictEqual(reasons, ['error']);
				assert.deepStrictEqual(socket.subscribes().map(f => f.token), ['t1'], 'no resubscribe with the other user\'s token');
			});

			it('shares one socket between handles for the same principal', () => {
				subscribeWith('my-app-rt/chat/a', connectTokenFor('user-a'));
				subscribeWith('my-app-rt/chat/b', connectTokenFor('user-a'));
				assert.strictEqual(FakeWebSocket.instances.length, 1);
			});
		});
	}
});
