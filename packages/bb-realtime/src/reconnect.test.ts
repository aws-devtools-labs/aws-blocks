// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * TDD (red) coverage for PR1 (Option B): production Realtime auto-reconnect +
 * resubscribe-with-replayed-token, a surviving keep-alive ping timer, and the
 * new optional `SubscribeOptions.onReconnect` callback.
 *
 * These tests encode the INTENDED post-fix contract so they fail today and pass
 * once PR1 lands. They drive the production middleware through the same test
 * surface `mock-middleware.ts` already exposes (`hydrate` +
 * `__resetConnectionsForTest`) — a surface `aws-middleware.ts` does NOT export
 * yet — and reference `SubscribeOptions.onReconnect`, which does not exist yet.
 * Until PR1 adds them, this file is the RED signal: it fails to compile / load.
 *
 * Unlike the mock's reconnect regression (see ws-server.test.ts, "token replay
 * on reconnect"), these run against a fake in-process WebSocket rather than the
 * live dev server, because the retry-cap assertion (#1) must observe that the
 * middleware STOPS opening sockets after MAX_RECONNECT — something a real
 * server cannot prove — and the keep-alive assertion (#4) must drive timers
 * deterministically via node:test mock timers.
 */
import { describe, it, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
// INTENDED PR1 surface — mirrors mock-middleware's `export function hydrate` and
// `__resetConnectionsForTest`. Missing on aws-middleware today (RED).
import { hydrate, __resetConnectionsForTest } from './aws-middleware.js';
import type { RealtimeChannelClient } from './aws-middleware.js';
import type { SubscribeOptions } from './types.js';

// Mirror the mock's caps so the intended production behavior is asserted 1:1.
const MAX_RECONNECT = 5;
const KEEP_ALIVE_MS = 9 * 60 * 1000;

const CHANNEL = 'my-app-rt/chat/room-1';
const WS_URL = 'wss://example.execute-api.us-west-2.amazonaws.com/prod';
const CONNECT_TOKEN = 'connect-token-abc';
const CHANNEL_TOKEN = 'channel-token-xyz';

/**
 * Minimal in-process WebSocket stand-in. Records every constructed socket and
 * every frame sent, and exposes drivers so a test can deterministically emit
 * open/close/message events the way API Gateway would.
 */
class FakeWebSocket {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;

	/** Every socket the middleware has constructed, in creation order. */
	static instances: FakeWebSocket[] = [];
	static reset(): void {
		FakeWebSocket.instances = [];
	}

	readonly url: string;
	readyState: number = FakeWebSocket.CONNECTING;
	sent: string[] = [];
	onopen: ((ev: unknown) => void) | null = null;
	onmessage: ((ev: { data: string }) => void) | null = null;
	onerror: ((ev: unknown) => void) | null = null;
	onclose: ((ev: { code?: number }) => void) | null = null;

	constructor(url: string) {
		this.url = url;
		FakeWebSocket.instances.push(this);
	}

	send(data: string): void {
		this.sent.push(data);
	}

	close(): void {
		this.readyState = FakeWebSocket.CLOSED;
		this.onclose?.({ code: 1000 });
	}

	// ── Test drivers ────────────────────────────────────────────────────────

	/** Simulate the socket finishing its handshake. */
	emitOpen(): void {
		this.readyState = FakeWebSocket.OPEN;
		this.onopen?.({});
	}

	/** Simulate the server dropping the connection with a given close code. */
	emitServerClose(code: number): void {
		this.readyState = FakeWebSocket.CLOSED;
		this.onclose?.({ code });
	}

	/** Simulate a server-to-client frame. */
	emitMessage(payload: unknown): void {
		this.onmessage?.({ data: JSON.stringify(payload) });
	}

	/** Parsed frames this socket has sent whose `action` matches. */
	framesFor(action: string): Record<string, unknown>[] {
		const out: Record<string, unknown>[] = [];
		for (const raw of this.sent) {
			const parsed: Record<string, unknown> = JSON.parse(raw);
			if (parsed.action === action) out.push(parsed);
		}
		return out;
	}
}

/** Type guard so `hydrate`'s `unknown` result can be used without a cast. */
function isChannelClient(value: unknown): value is RealtimeChannelClient {
	return typeof value === 'object' && value !== null && 'subscribe' in value;
}

/** Hydrate a production channel descriptor into a live client. */
function hydrateClient(): RealtimeChannelClient {
	const client = hydrate({
		__blocks: 'realtime/channel',
		channel: CHANNEL,
		wsUrl: WS_URL,
		connectToken: CONNECT_TOKEN,
		token: CHANNEL_TOKEN,
	});
	assert.ok(isChannelClient(client), 'hydrate should return a channel client');
	return client;
}

describe('AWS (production) middleware: reconnect + resubscribe (PR1)', () => {
	beforeEach(() => {
		FakeWebSocket.reset();
		// Install the fake without a cast — defineProperty's target is untyped.
		Object.defineProperty(globalThis, 'WebSocket', {
			value: FakeWebSocket,
			configurable: true,
			writable: true,
		});
		mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
	});

	afterEach(() => {
		mock.timers.reset();
		__resetConnectionsForTest();
	});

	it('production middleware auto-reconnects after an unexpected close (1006) with a retry cap', () => {
		const client = hydrateClient();
		client.subscribe(() => {});

		const first = FakeWebSocket.instances[0];
		assert.ok(first, 'a socket should be created on subscribe');
		first.emitOpen();

		// Server drops the connection abnormally (1006). The middleware must
		// schedule a reconnect (open a new socket) rather than giving up.
		first.emitServerClose(1006);
		mock.timers.tick(60_000); // drain any backoff delay

		assert.ok(
			FakeWebSocket.instances.length >= 2,
			`expected a reconnect socket after a 1006 close, saw ${FakeWebSocket.instances.length} socket(s)`,
		);

		// Every subsequent attempt also fails immediately; the middleware must
		// stop after MAX_RECONNECT attempts and not spin forever.
		for (let i = 0; i < MAX_RECONNECT + 5; i++) {
			const latest = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
			latest.emitServerClose(1006);
			mock.timers.tick(60_000);
		}

		// 1 original + MAX_RECONNECT reconnect attempts, then it gives up.
		assert.strictEqual(
			FakeWebSocket.instances.length,
			1 + MAX_RECONNECT,
			`expected 1 original + ${MAX_RECONNECT} capped reconnects, saw ${FakeWebSocket.instances.length}`,
		);
	});

	it('production middleware resubscribes stored channels with the replayed token on reconnect', () => {
		const client = hydrateClient();
		client.subscribe(() => {});

		const first = FakeWebSocket.instances[0];
		first.emitOpen();
		first.emitMessage({ type: 'subscribe_success', channel: CHANNEL });

		// Drop and let the middleware reconnect.
		first.emitServerClose(1006);
		mock.timers.tick(60_000);

		const second = FakeWebSocket.instances[1];
		assert.ok(second, 'middleware should open a new socket to reconnect');
		second.emitOpen();

		const resubs = second.framesFor('subscribe');
		assert.strictEqual(resubs.length, 1, 'exactly one resubscribe frame expected on the reconnected socket');
		assert.strictEqual(resubs[0].channel, CHANNEL);
		assert.strictEqual(
			resubs[0].token,
			CHANNEL_TOKEN,
			'the stored channel token must be replayed on resubscribe (same guarantee the mock proves)',
		);
	});

	it('onReconnect callback fires after a successful resubscribe (onDisconnect fires on the drop)', () => {
		const client = hydrateClient();
		const events: string[] = [];
		// `onReconnect` does not exist on SubscribeOptions yet — this declaration
		// is the RED signal for the new callback (no cast, no ts-ignore directive).
		const options: SubscribeOptions = {
			onMessage: () => {},
			onDisconnect: () => {
				events.push('disconnect');
			},
			onReconnect: () => {
				events.push('reconnect');
			},
		};
		client.subscribe(options);

		const first = FakeWebSocket.instances[0];
		first.emitOpen();
		first.emitMessage({ type: 'subscribe_success', channel: CHANNEL });

		first.emitServerClose(1006);
		mock.timers.tick(60_000);

		const second = FakeWebSocket.instances[1];
		assert.ok(second, 'middleware should reconnect');
		second.emitOpen();
		// onReconnect must only fire once the resubscribe is confirmed.
		second.emitMessage({ type: 'subscribe_success', channel: CHANNEL });

		assert.deepStrictEqual(
			events,
			['disconnect', 'reconnect'],
			'onDisconnect on the drop, then onReconnect only after resubscribe completes',
		);
	});

	it('keep-alive ping timer is re-established on the new socket after a reconnect', () => {
		const client = hydrateClient();
		client.subscribe(() => {});

		const first = FakeWebSocket.instances[0];
		first.emitOpen();

		first.emitServerClose(1006);
		mock.timers.tick(60_000);

		const second = FakeWebSocket.instances[1];
		assert.ok(second, 'middleware should reconnect');
		second.emitOpen();

		// Advance past one keep-alive interval. A ping must be sent on the NEW
		// socket, proving the interval was re-armed rather than left dead.
		second.sent.length = 0;
		mock.timers.tick(KEEP_ALIVE_MS + 1000);

		const pings = second.framesFor('ping');
		assert.ok(pings.length >= 1, 'keep-alive ping should be sent on the reconnected socket');
	});
});
