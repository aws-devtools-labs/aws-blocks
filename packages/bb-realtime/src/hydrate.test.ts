// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `hydrate()` runs on every RPC response once the realtime client middleware
 * is registered, so it must return the server's data unchanged apart from the
 * `realtime/channel` descriptors it rewrites. A JSON key named `__proto__` is
 * an ordinary own data property after `JSON.parse`; copying it with
 * `result[k] = v` would set the copy's prototype instead, dropping the key and
 * making its contents look inherited.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { hydrate as awsHydrate } from './aws-middleware.js';
import type { RealtimeChannelClient } from './aws-middleware.js';
import { hydrate as mockHydrate } from './mock-middleware.js';

const DESCRIPTOR_JSON =
	'{"__blocks":"realtime/channel","channel":"app-rt/chat/room","wsUrl":"wss://example.invalid/realtime","connectToken":"connect-token","token":"channel-token"}';

for (const [layer, hydrate] of [
	['aws-middleware', awsHydrate],
	['mock-middleware', mockHydrate],
] as const) {
	describe(`${layer} hydrate: own keys are preserved`, () => {
		it('keeps an own "__proto__" key as data and leaves the prototype alone', () => {
			const out = hydrate(JSON.parse('{"tags":{"__proto__":{"pinned":true},"bob":1}}')) as {
				tags: Record<string, unknown>;
			};
			assert.deepStrictEqual(Object.keys(out.tags), ['__proto__', 'bob']);
			assert.strictEqual(Object.getPrototypeOf(out.tags), Object.prototype);
			assert.deepStrictEqual(Object.getOwnPropertyDescriptor(out.tags, '__proto__'), {
				value: { pinned: true },
				writable: true,
				enumerable: true,
				configurable: true,
			});
			assert.strictEqual('pinned' in out.tags, false);
			assert.strictEqual(out.tags.bob, 1);
		});

		it('hydrates a descriptor under an own "__proto__" key without making it the prototype', () => {
			const out = hydrate(JSON.parse(`{"room":{"__proto__":${DESCRIPTOR_JSON}}}`)) as {
				room: Record<string, unknown>;
			};
			assert.strictEqual(Object.getPrototypeOf(out.room), Object.prototype);
			assert.strictEqual('subscribe' in out.room, false);
			const own = Object.getOwnPropertyDescriptor(out.room, '__proto__')?.value as RealtimeChannelClient;
			assert.strictEqual(typeof own.subscribe, 'function');
		});

		it('still hydrates descriptors nested in objects and arrays', () => {
			const out = hydrate(JSON.parse(`{"channel":${DESCRIPTOR_JSON},"list":[${DESCRIPTOR_JSON},1],"plain":{"n":2}}`)) as {
				channel: RealtimeChannelClient;
				list: [RealtimeChannelClient, number];
				plain: unknown;
			};
			assert.strictEqual(typeof out.channel.subscribe, 'function');
			assert.ok(Array.isArray(out.list));
			assert.strictEqual(typeof out.list[0].subscribe, 'function');
			assert.strictEqual(out.list[1], 1);
			assert.deepStrictEqual(out.plain, { n: 2 });
		});
	});
}
