// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Coverage for the production Realtime transport (PR1, Option B): it covers
 * production auto-reconnect + resubscribe with the replayed channel token, a
 * surviving keep-alive ping timer re-armed on the new socket, the optional
 * `SubscribeOptions.onReconnect` callback, and the failure paths (retry cap
 * give-up, stale-token resubscribe, transient onerror).
 *
 * These tests assert the shipped contract of the production middleware,
 * driving it through the same test surface `mock-middleware.ts` exposes
 * (`hydrate` + `__resetConnectionsForTest`) and exercising
 * `SubscribeOptions.onReconnect`.
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
// Production test surface — mirrors mock-middleware's `export function hydrate`
// and `__resetConnectionsForTest`.
import { hydrate, __resetConnectionsForTest } from './aws-middleware.js';
import type { RealtimeChannelClient } from './aws-middleware.js';
// Mock (local-dev) middleware surface — aliased so its refresh-on-reconnect
// wiring can be asserted alongside the production one in this file.
import { hydrate as mockHydrate, __resetConnectionsForTest as mockReset } from './mock-middleware.js';
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

	/**
	 * Simulate a low-level socket error (`onerror`). The browser fires this
	 * immediately before an abnormal `onclose`, so tests use it to prove the
	 * error path does not prematurely reject an in-flight established promise.
	 */
	emitError(): void {
		this.onerror?.({});
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

/**
 * Hydrate an additional channel on the SAME connection. Reusing `WS_URL` and
 * `CONNECT_TOKEN` means it multiplexes onto the one shared socket, so a test can
 * drive a reconnect where one channel resubscribes cleanly and another fails.
 */
function hydrateClientFor(channel: string, token: string): RealtimeChannelClient {
	const client = hydrate({
		__blocks: 'realtime/channel',
		channel,
		wsUrl: WS_URL,
		connectToken: CONNECT_TOKEN,
		token,
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
		// Giving up at the cap now rejects any in-flight established promise (see
		// the dedicated give-up test below); swallow it so the deliberate
		// rejection is not surfaced as an unhandled rejection. The socket-count
		// assertions below are unchanged.
		const sub = client.subscribe(() => {});
		sub.established.catch(() => {});

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
		// Exercises the `onReconnect` callback on SubscribeOptions (no cast, no
		// type-suppression directive).
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

	// (a) BLOCKING 1: onclose must not self-clear disconnectHandlers on the
	// reconnect branch, or only the first drop would ever notify.
	it('onDisconnect fires on every drop, not just the first', () => {
		const client = hydrateClient();
		let disconnects = 0;
		const options: SubscribeOptions = {
			onMessage: () => {},
			onDisconnect: () => {
				disconnects++;
			},
		};
		client.subscribe(options);

		// Cycle 1: open, confirm, drop.
		const s0 = FakeWebSocket.instances[0];
		s0.emitOpen();
		s0.emitMessage({ type: 'subscribe_success', channel: CHANNEL });
		s0.emitServerClose(1006);
		mock.timers.tick(60_000);

		// Cycle 2: the reconnect socket opens, confirms (resetting the cap), drops.
		const s1 = FakeWebSocket.instances[1];
		assert.ok(s1, 'middleware should reconnect after the first drop');
		s1.emitOpen();
		s1.emitMessage({ type: 'subscribe_success', channel: CHANNEL });
		s1.emitServerClose(1006);
		mock.timers.tick(60_000);

		assert.ok(FakeWebSocket.instances[2], 'middleware should reconnect after the second drop too');
		assert.strictEqual(
			disconnects,
			2,
			'onDisconnect must fire once per drop — disconnectHandlers must survive a reconnecting close',
		);
	});

	// (b) SUGGESTION 5: a flapping socket that opens then immediately closes must
	// still exhaust the cap. This only holds if reconnectAttempts is NOT reset on
	// every onopen (it is reset only once a resubscribe is confirmed).
	it('flapping socket (open then immediate close) still hits the retry cap', () => {
		const client = hydrateClient();
		// Give-up at the cap rejects the pending establishment; swallow it.
		const sub = client.subscribe(() => {});
		sub.established.catch(() => {});

		const first = FakeWebSocket.instances[0];
		first.emitOpen();
		first.emitServerClose(1006);
		mock.timers.tick(60_000);

		// Every reconnect socket OPENS (the flap) and then immediately drops again
		// without ever confirming a resubscribe, so the counter never resets.
		for (let i = 0; i < MAX_RECONNECT + 5; i++) {
			const latest = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
			latest.emitOpen();
			latest.emitServerClose(1006);
			mock.timers.tick(60_000);
		}

		assert.strictEqual(
			FakeWebSocket.instances.length,
			1 + MAX_RECONNECT,
			`a flapping socket must still stop after ${MAX_RECONNECT} reconnects, saw ${FakeWebSocket.instances.length}`,
		);
	});

	// (c) BLOCKING 2: a stale-token resubscribe error must be surfaced (not
	// silently dropped) AND must not wedge onReconnect for the channels that DID
	// resubscribe successfully.
	it('stale token on resubscribe surfaces error and does not wedge onReconnect', () => {
		const clientA = hydrateClientFor('my-app-rt/chat/room-A', 'token-A');
		const clientB = hydrateClientFor('my-app-rt/chat/room-B', 'token-B');
		const events: string[] = [];
		// Callbacks live on channel A (the one that resubscribes cleanly). Because
		// disconnect/reconnect handlers are connection-level, A's onDisconnect also
		// observes the surfaced failure of channel B.
		clientA.subscribe({
			onMessage: () => {},
			onDisconnect: (reason) => {
				events.push(`disc:${reason}`);
			},
			onReconnect: () => {
				events.push('reconn');
			},
		});
		clientB.subscribe(() => {});

		const s0 = FakeWebSocket.instances[0];
		s0.emitOpen();
		s0.emitMessage({ type: 'subscribe_success', channel: 'my-app-rt/chat/room-A' });
		s0.emitMessage({ type: 'subscribe_success', channel: 'my-app-rt/chat/room-B' });

		// Drop → reconnect. The drop itself notifies onDisconnect once.
		s0.emitServerClose(1006);
		mock.timers.tick(60_000);

		const s1 = FakeWebSocket.instances[1];
		assert.ok(s1, 'middleware should reconnect');
		s1.emitOpen();
		// Channel A resubscribes cleanly; channel B's replayed token is stale.
		s1.emitMessage({ type: 'subscribe_success', channel: 'my-app-rt/chat/room-A' });
		s1.emitMessage({ type: 'error', channel: 'my-app-rt/chat/room-B', message: 'token expired' });

		// The stale-token failure is surfaced via onDisconnect (in addition to the
		// original drop), so it is not lost silently.
		assert.strictEqual(
			events.filter((e) => e === 'disc:error').length,
			2,
			'expected one disconnect for the drop and one for the surfaced stale-token error',
		);
		// onReconnect still fires: resubscribePending drained even though one
		// channel failed, so the successful channel is not wedged.
		assert.ok(events.includes('reconn'), 'onReconnect must still fire for the channel that resubscribed');
		assert.strictEqual(events[events.length - 1], 'reconn', 'onReconnect fires only after the set fully drains');
	});

	// (d) BLOCKING 3: onerror must not reject an in-flight established promise —
	// a transient drop should be resolved by the resubscribe on reconnect.
	it('onerror during a transient drop does not reject an in-flight established promise', async () => {
		const client = hydrateClient();
		const sub = client.subscribe(() => {});

		const first = FakeWebSocket.instances[0];
		first.emitOpen();
		// established is still pending (no subscribe_success yet). onerror fires,
		// then the socket drops abnormally — neither may reject the promise.
		first.emitError();
		first.emitServerClose(1006);
		mock.timers.tick(60_000);

		const second = FakeWebSocket.instances[1];
		assert.ok(second, 'middleware should reconnect after the transient drop');
		second.emitOpen();
		second.emitMessage({ type: 'subscribe_success', channel: CHANNEL });

		// If onerror had rejected, this await would throw and fail the test.
		await sub.established;
	});

	// (e) BLOCKING 4: giving up at the cap must delete the pool entry so a later
	// subscribe() rebuilds a fresh connection instead of reusing a dead one.
	it('giving up at MAX_RECONNECT removes the connection so a later subscribe rebuilds', () => {
		const client = hydrateClient();
		const sub = client.subscribe(() => {});
		sub.established.catch(() => {});

		const first = FakeWebSocket.instances[0];
		first.emitOpen();
		first.emitServerClose(1006);
		mock.timers.tick(60_000);

		// Exhaust the cap (reconnect sockets never confirm), then a couple more.
		for (let i = 0; i < MAX_RECONNECT + 2; i++) {
			const latest = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
			latest.emitServerClose(1006);
			mock.timers.tick(60_000);
		}

		const afterGiveUp = FakeWebSocket.instances.length;
		assert.strictEqual(afterGiveUp, 1 + MAX_RECONNECT, 'should have stopped opening sockets at the cap');

		// A brand-new subscribe must build a fresh connection (new socket),
		// proving the wedged pool entry was removed.
		const client2 = hydrateClient();
		const sub2 = client2.subscribe(() => {});
		sub2.established.catch(() => {});

		assert.strictEqual(
			FakeWebSocket.instances.length,
			afterGiveUp + 1,
			'a later subscribe must rebuild a fresh connection after give-up',
		);
	});

	// (f) MEDIUM give-up: an UNCONFIRMED subscription whose retry cap is exhausted
	// must REJECT `established` (not hang), with the name the give-up path sets.
	it('sub.established rejects with ConnectionFailedException after the retry cap is exhausted', async () => {
		const client = hydrateClient();
		const sub = client.subscribe(() => {});

		const first = FakeWebSocket.instances[0];
		first.emitOpen();
		// Drop before any subscribe_success, so `established` stays pending, then
		// exhaust the cap — none of the reconnect sockets ever confirm.
		first.emitServerClose(1006);
		mock.timers.tick(60_000);
		for (let i = 0; i < MAX_RECONNECT + 2; i++) {
			const latest = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
			latest.emitServerClose(1006);
			mock.timers.tick(60_000);
		}

		// The give-up path (scheduleReconnect at MAX_RECONNECT) rejects any pending
		// establishment with a named ConnectionFailedException so awaiting callers
		// fail fast instead of hanging forever.
		await assert.rejects(
			sub.established,
			(err: Error) => err.name === 'ConnectionFailedException',
			'established must reject with ConnectionFailedException once the retry cap is exhausted',
		);
	});

	// ── Intent-based terminal classification (PR1) ────────────────────────────
	// The middleware no longer treats close CODE as the terminal signal. A drop
	// the client did not initiate reconnects on ANY code (clean 1000/1005 and GW
	// timeouts 1001/1006 alike); only a client-initiated teardown is terminal.

	// A no-status close (1005) used to be classified TERMINAL by close code. It is
	// now an unexpected drop and MUST reconnect + resubscribe with the replayed token.
	it('reconnects and resubscribes after an unexpected 1005 (no-status) close', () => {
		const client = hydrateClient();
		client.subscribe(() => {});

		const first = FakeWebSocket.instances[0];
		first.emitOpen();
		first.emitMessage({ type: 'subscribe_success', channel: CHANNEL });

		// 1005 was terminal under the old code-based rule; it must now reconnect.
		first.emitServerClose(1005);
		mock.timers.tick(60_000);

		const second = FakeWebSocket.instances[1];
		assert.ok(second, 'a 1005 close must now trigger a reconnect socket');
		second.emitOpen();

		const resubs = second.framesFor('subscribe');
		assert.strictEqual(resubs.length, 1, 'exactly one resubscribe frame expected after a 1005 reconnect');
		assert.strictEqual(resubs[0].channel, CHANNEL);
		assert.strictEqual(resubs[0].token, CHANNEL_TOKEN, 'the stored channel token must be replayed on a 1005 reconnect');
	});

	// A normal (1000) close that the client did NOT initiate is also an unexpected
	// drop under the intent-based rule and must reconnect.
	it('reconnects after an unexpected 1000 (normal) close the client did not initiate', () => {
		const client = hydrateClient();
		client.subscribe(() => {});

		const first = FakeWebSocket.instances[0];
		first.emitOpen();
		first.emitMessage({ type: 'subscribe_success', channel: CHANNEL });

		first.emitServerClose(1000);
		mock.timers.tick(60_000);

		assert.ok(
			FakeWebSocket.instances[1],
			'a 1000 close with live subscriptions must reconnect (intent-based, not code-based)',
		);
	});

	// A 1001 going-away (GW/server timeout) reconnects, and onDisconnect still
	// reports the code-derived reason 'timeout' independent of the reconnect decision.
	it('reconnects after a 1001 (going-away timeout) and reports reason "timeout"', () => {
		const client = hydrateClient();
		const reasons: string[] = [];
		const options: SubscribeOptions = {
			onMessage: () => {},
			onDisconnect: (reason) => { reasons.push(reason); },
		};
		client.subscribe(options);

		const first = FakeWebSocket.instances[0];
		first.emitOpen();
		first.emitMessage({ type: 'subscribe_success', channel: CHANNEL });

		first.emitServerClose(1001);
		mock.timers.tick(60_000);

		assert.ok(FakeWebSocket.instances[1], 'a 1001 timeout close must reconnect');
		assert.deepStrictEqual(reasons, ['timeout'], 'onDisconnect reason for 1001 must be "timeout"');
	});

	// A client unsubscribe is an INTENTIONAL close: it must NOT reconnect. The
	// teardown detaches onclose and sets intentionalClose before closing.
	it('a client unsubscribe (intentional close) does not reconnect', () => {
		const client = hydrateClient();
		const sub = client.subscribe(() => {});

		const first = FakeWebSocket.instances[0];
		first.emitOpen();
		first.emitMessage({ type: 'subscribe_success', channel: CHANNEL });

		// Unsubscribing the last channel closes the socket on purpose.
		sub.unsubscribe();
		mock.timers.tick(60_000);

		assert.strictEqual(
			FakeWebSocket.instances.length,
			1,
			'a client-initiated unsubscribe must not open a reconnect socket',
		);
	});

	// __resetConnectionsForTest is a deliberate teardown: terminal, no reconnect.
	it('__resetConnectionsForTest is terminal and does not reconnect', () => {
		const client = hydrateClient();
		client.subscribe(() => {});

		const first = FakeWebSocket.instances[0];
		first.emitOpen();
		first.emitMessage({ type: 'subscribe_success', channel: CHANNEL });

		__resetConnectionsForTest();
		mock.timers.tick(60_000);

		assert.strictEqual(
			FakeWebSocket.instances.length,
			1,
			'a deliberate reset must not schedule a reconnect',
		);
	});

	// ── PR3: token refresh on reconnect ───────────────────────────────────────

	const FRESH_WS_URL = 'wss://fresh.execute-api.us-west-2.amazonaws.com/prod';
	const FRESH_CONNECT_TOKEN = 'connect-token-fresh';
	const FRESH_CHANNEL_TOKEN = 'channel-token-fresh';

	// PR3 core: a reconnect must re-mint via refresh() BEFORE opening the socket,
	// so the new socket carries the fresh connect token (in the URL) and the
	// resubscribe carries the fresh channel token — not the stale stored ones.
	it('reconnect uses refresh() to open with a fresh wsUrl and resubscribe with a fresh token', async () => {
		const refresh = mock.fn(async () => ({
			__blocks: 'realtime/channel' as const,
			channel: CHANNEL,
			wsUrl: FRESH_WS_URL,
			connectToken: FRESH_CONNECT_TOKEN,
			token: FRESH_CHANNEL_TOKEN,
		}));
		const options: SubscribeOptions = { onMessage: () => {}, refresh };
		const client = hydrateClient();
		client.subscribe(options);

		const first = FakeWebSocket.instances[0];
		first.emitOpen();
		first.emitMessage({ type: 'subscribe_success', channel: CHANNEL });
		// refresh must NOT run on the initial subscribe — only on a reconnect.
		assert.strictEqual(refresh.mock.callCount(), 0, 'refresh must not be called on the initial subscribe');

		// Drop → reconnect. openSocket awaits refresh() before constructing the
		// socket, so its result lands on the microtask queue: flush it.
		first.emitServerClose(1006);
		mock.timers.tick(60_000);
		await new Promise((r) => setImmediate(r));

		assert.strictEqual(refresh.mock.callCount(), 1, 'refresh must be called once before the reconnect opens');
		const second = FakeWebSocket.instances[1];
		assert.ok(second, 'a reconnect socket should be constructed after refresh resolves');
		assert.ok(
			second.url.startsWith(FRESH_WS_URL),
			`reconnect socket must open with the fresh wsUrl; saw ${second.url}`,
		);
		assert.ok(
			second.url.includes(encodeURIComponent(FRESH_CONNECT_TOKEN)),
			'reconnect socket URL must carry the fresh connect token',
		);

		second.emitOpen();
		const resubs = second.framesFor('subscribe');
		assert.strictEqual(resubs.length, 1, 'exactly one resubscribe frame expected on the reconnected socket');
		assert.strictEqual(resubs[0].channel, CHANNEL);
		assert.strictEqual(
			resubs[0].token,
			FRESH_CHANNEL_TOKEN,
			'resubscribe must carry the fresh channel token, not the stale stored one',
		);
	});

	// Back-compat: with no refresh fn, a reconnect replays the stored wsUrl +
	// token exactly as before, and stays synchronous (no microtask flush needed).
	it('reconnect without refresh replays the stored token (back-compat)', () => {
		const client = hydrateClient();
		client.subscribe(() => {});

		const first = FakeWebSocket.instances[0];
		first.emitOpen();
		first.emitMessage({ type: 'subscribe_success', channel: CHANNEL });

		first.emitServerClose(1006);
		mock.timers.tick(60_000);

		const second = FakeWebSocket.instances[1];
		assert.ok(second, 'reconnect without refresh must open synchronously');
		assert.ok(second.url.startsWith(WS_URL), 'reconnect must reuse the stored wsUrl');
		second.emitOpen();
		const resubs = second.framesFor('subscribe');
		assert.strictEqual(
			resubs[0].token,
			CHANNEL_TOKEN,
			'the stored channel token is replayed unchanged when no refresh is provided',
		);
	});

	// A refresh() rejection must not crash: it surfaces via onDisconnect('error')
	// and falls back to backoff (no socket is built, and a later tick retries).
	it('refresh rejection does not crash; falls back to backoff and surfaces onDisconnect', async () => {
		const refresh = mock.fn(async (): Promise<never> => { throw new Error('mint failed'); });
		let errorDisconnects = 0;
		const client = hydrateClient();
		client.subscribe({
			onMessage: () => {},
			onDisconnect: (reason) => { if (reason === 'error') errorDisconnects++; },
			refresh,
		});

		const first = FakeWebSocket.instances[0];
		first.emitOpen();
		first.emitMessage({ type: 'subscribe_success', channel: CHANNEL });

		// Drop (onDisconnect 'error' #1) → reconnect attempts refresh, which rejects.
		first.emitServerClose(1006);
		mock.timers.tick(60_000);
		await new Promise((r) => setImmediate(r));

		assert.strictEqual(refresh.mock.callCount(), 1, 'refresh is attempted on reconnect');
		// refresh rejected BEFORE `new WebSocket(...)`, so no reconnect socket exists.
		assert.strictEqual(FakeWebSocket.instances.length, 1, 'a refresh failure must not construct a socket');
		// The failure is surfaced (drop + refresh-failure), not swallowed.
		assert.strictEqual(errorDisconnects, 2, 'onDisconnect(error) fires for the drop and again for the refresh failure');

		// Backoff was rescheduled rather than crashing — the next tick re-attempts.
		mock.timers.tick(60_000);
		await new Promise((r) => setImmediate(r));
		assert.strictEqual(refresh.mock.callCount(), 2, 'refresh is retried on the next backoff tick (no crash)');
	});
});

describe('Mock (local-dev) middleware: token refresh on reconnect', () => {
	beforeEach(() => {
		FakeWebSocket.reset();
		Object.defineProperty(globalThis, 'WebSocket', {
			value: FakeWebSocket,
			configurable: true,
			writable: true,
		});
		mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
	});

	afterEach(() => {
		mock.timers.reset();
		mockReset();
	});

	// Mirror of the production PR3 test: the mock reconnect path must also call
	// refresh() and resubscribe with the fresh token so local dev matches prod.
	it('mock reconnect calls refresh() and resubscribes with the fresh token', async () => {
		const FRESH_TOKEN = 'mock-channel-token-fresh';
		const refresh = mock.fn(async () => ({
			__blocks: 'realtime/channel' as const,
			channel: CHANNEL,
			wsUrl: WS_URL,
			token: FRESH_TOKEN,
		}));
		const client = mockHydrate({
			__blocks: 'realtime/channel',
			channel: CHANNEL,
			wsUrl: WS_URL,
			token: 'mock-channel-token-stale',
		});
		assert.ok(isChannelClient(client), 'mock hydrate should return a channel client');
		client.subscribe({ onMessage: () => {}, refresh });

		const first = FakeWebSocket.instances[0];
		first.emitOpen();
		first.emitMessage({ type: 'subscribe_success', channel: CHANNEL });
		assert.strictEqual(refresh.mock.callCount(), 0, 'refresh must not be called on the initial subscribe');

		// Force a drop → reconnect. The mock awaits refresh() before reopening.
		first.emitServerClose(1006);
		mock.timers.tick(60_000);
		await new Promise((r) => setImmediate(r));

		assert.strictEqual(refresh.mock.callCount(), 1, 'refresh must be called on the mock reconnect');
		const second = FakeWebSocket.instances[1];
		assert.ok(second, 'mock should open a reconnect socket after refresh resolves');
		second.emitOpen();
		const resubs = second.framesFor('subscribe');
		assert.strictEqual(resubs.length, 1, 'exactly one resubscribe frame on the mock reconnect');
		assert.strictEqual(
			resubs[0].token,
			FRESH_TOKEN,
			'mock resubscribe must carry the fresh token from refresh(), not the stale stored one',
		);
	});
});
