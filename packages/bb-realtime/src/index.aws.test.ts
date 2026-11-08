/**
 * AWS runtime `subscribe()` lifecycle tests.
 *
 * Under the default test conditions `@aws-blocks/bb-app-setting` resolves to its
 * local mock, so the token secret comes from `.bb-data/settings.json` in a temp
 * working directory. `globalThis.WebSocket` is stubbed; no network calls.
 */

import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
	let rt: InstanceType<typeof Realtime>;
	// Drains the cached secret promise and its `.then` continuation (no wall-clock wait).
	const settle = async () => {
		await (rt as unknown as { _cachedSecretPromise: Promise<unknown> })._cachedSecretPromise;
		await new Promise(setImmediate);
	};
	const savedCwd = process.cwd();
	const savedWsUrl = process.env.BLOCKS_RT_WS_URL;
	const savedWs = (globalThis as { WebSocket: unknown }).WebSocket;
	let workDir: string;

	before(async () => {
		workDir = mkdtempSync(join(tmpdir(), 'bb-realtime-aws-'));
		process.chdir(workDir);
		process.env.BLOCKS_RT_WS_URL = 'wss://example.invalid/rt';
		(globalThis as { WebSocket: unknown }).WebSocket = FakeWebSocket;
		const schema = { '~standard': { version: 1, vendor: 't', validate: (v: unknown) => ({ value: v }) } } as const;
		rt = new Realtime(new Scope('app'), 'rt', { namespaces: { chat: Realtime.namespace(schema) } });
		await settle();
	});

	after(() => {
		process.chdir(savedCwd);
		rmSync(workDir, { recursive: true, force: true });
		if (savedWsUrl === undefined) delete process.env.BLOCKS_RT_WS_URL;
		else process.env.BLOCKS_RT_WS_URL = savedWsUrl;
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
