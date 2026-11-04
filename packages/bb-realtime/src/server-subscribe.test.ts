// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * A server-side subscriber on AWS gets messages from the in-process EventEmitter
 * and from its WebSocket, and `publish()` drives both for every message. These
 * tests replay what one `publish()` does (emit locally, then API Gateway delivers
 * the same message on the socket) at each stage of the subscription, and assert
 * the handler runs exactly once each time.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import { localListener, serverSubscribe } from './server-subscribe.js';

const CHANNEL = 'app-rt/chat/room-1';

class FakeWebSocket {
	static instances: FakeWebSocket[] = [];
	sent: string[] = [];
	onopen: ((ev: unknown) => void) | null = null;
	onmessage: ((ev: { data: string }) => void) | null = null;
	onerror: ((ev: unknown) => void) | null = null;
	onclose: ((ev: { code?: number }) => void) | null = null;
	constructor(readonly url: string) {
		FakeWebSocket.instances.push(this);
	}
	send(data: string): void {
		this.sent.push(data);
	}
	close(): void {
		this.onclose?.({ code: 1000 });
	}
	emitMessage(payload: unknown): void {
		this.onmessage?.({ data: JSON.stringify(payload) });
	}
}

const savedWebSocket = (globalThis as { WebSocket?: unknown }).WebSocket;
beforeEach(() => {
	FakeWebSocket.instances = [];
	(globalThis as { WebSocket?: unknown }).WebSocket = FakeWebSocket;
});
afterEach(() => {
	(globalThis as { WebSocket?: unknown }).WebSocket = savedWebSocket;
});

/** Subscribe the way index.aws.ts does: socket plus gated in-process listener. */
function subscribe(handler: (m: unknown) => void) {
	const emitter = new EventEmitter();
	const sub = serverSubscribe('wss://example/prod', 'connect-token', CHANNEL, 'channel-token', handler);
	sub.established.catch(() => {});
	emitter.on(CHANNEL, localListener(handler, () => sub));
	const ws = FakeWebSocket.instances[0];
	/** One publish(): in-process emit, plus API Gateway's delivery to this process's own connection. */
	const publish = (data: unknown) => {
		emitter.emit(CHANNEL, data);
		ws.emitMessage({ type: 'message', channel: CHANNEL, data });
	};
	return { sub, ws, publish };
}

test('before the subscription is acknowledged, a publish reaches the handler once (in-process)', () => {
	const seen: unknown[] = [];
	const { sub, publish } = subscribe((m) => seen.push(m));
	publish({ n: 1 });
	assert.deepStrictEqual(seen, [{ n: 1 }]);
	assert.strictEqual(sub.isLive(), false);
});

test('once acknowledged, a publish reaches the handler once (socket), not twice', async () => {
	const seen: unknown[] = [];
	const { sub, ws, publish } = subscribe((m) => seen.push(m));
	ws.onopen?.({});
	ws.emitMessage({ type: 'subscribe_success', channel: CHANNEL });
	await sub.established;
	assert.strictEqual(sub.isLive(), true);
	publish({ n: 1 });
	publish({ n: 2 });
	assert.deepStrictEqual(seen, [{ n: 1 }, { n: 2 }]);
});

test('a publish from another process (socket only) reaches a live subscriber once', async () => {
	const seen: unknown[] = [];
	const { sub, ws } = subscribe((m) => seen.push(m));
	ws.emitMessage({ type: 'subscribe_success', channel: CHANNEL });
	await sub.established;
	ws.emitMessage({ type: 'message', channel: CHANNEL, data: { from: 'elsewhere' } });
	assert.deepStrictEqual(seen, [{ from: 'elsewhere' }]);
});

test('after the socket closes, in-process delivery takes over, still once per publish', async () => {
	const seen: unknown[] = [];
	const { sub, ws, publish } = subscribe((m) => seen.push(m));
	ws.emitMessage({ type: 'subscribe_success', channel: CHANNEL });
	await sub.established;
	ws.onclose?.({ code: 1006 });
	assert.strictEqual(sub.isLive(), false);
	publish({ n: 1 });
	assert.deepStrictEqual(seen, [{ n: 1 }]);
});

test('unsubscribe stops both paths', async () => {
	const seen: unknown[] = [];
	const emitter = new EventEmitter();
	const handler = (m: unknown) => seen.push(m);
	const sub = serverSubscribe('wss://example/prod', 't', CHANNEL, 'c', handler);
	const local = localListener(handler, () => sub);
	emitter.on(CHANNEL, local);
	const ws = FakeWebSocket.instances[0];
	ws.emitMessage({ type: 'subscribe_success', channel: CHANNEL });
	await sub.established;
	sub.unsubscribe();
	emitter.off(CHANNEL, local);
	emitter.emit(CHANNEL, { n: 1 });
	ws.emitMessage({ type: 'message', channel: CHANNEL, data: { n: 1 } });
	assert.deepStrictEqual(seen, []);
});
