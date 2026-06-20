// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert';
import { setTimeout as sleep } from 'node:timers/promises';
import { EventBus, EventBusErrors } from './index.mock.js';
import { subscriptionId, sanitizeType, validateEventType } from './internal.js';

// Subscribers run on a 0ms timer, so let the microtask/timer queue drain.
async function flush(ms = 20): Promise<void> {
	await sleep(ms);
}

test('EventBus - delivers an event to a matching subscriber with context', async () => {
	const bus = new EventBus(null as any, 'events');
	let received: any;
	let ctx: any;

	bus.on('order.placed', async (detail, c) => {
		received = detail;
		ctx = c;
	});

	const { eventId } = await bus.publish('order.placed', { id: 'o_1', total: 42 });
	await flush();

	assert.deepStrictEqual(received, { id: 'o_1', total: 42 });
	assert.strictEqual(ctx.type, 'order.placed');
	assert.strictEqual(ctx.eventId, eventId);
	assert.ok(ctx.publishedAt, 'publishedAt should be set');
	assert.ok(ctx.source.endsWith('events'), 'source should be the bus fullId');
});

test('EventBus - fans one event out to every subscriber for that type', async () => {
	const bus = new EventBus(null as any, 'events');
	const calls: string[] = [];

	bus.on('order.placed', async () => { calls.push('a'); });
	bus.on('order.placed', async () => { calls.push('b'); });

	await bus.publish('order.placed', { id: 'o_2' });
	await flush();

	assert.deepStrictEqual(calls.sort(), ['a', 'b']);
});

test('EventBus - only matching subscribers fire', async () => {
	const bus = new EventBus(null as any, 'events');
	let placed = 0;
	let shipped = 0;

	bus.on('order.placed', async () => { placed++; });
	bus.on('order.shipped', async () => { shipped++; });

	await bus.publish('order.placed', { id: 'o_3' });
	await flush();

	assert.strictEqual(placed, 1);
	assert.strictEqual(shipped, 0);
});

test('EventBus - wildcard subscriber receives every event', async () => {
	const bus = new EventBus(null as any, 'events');
	const seen: string[] = [];

	bus.on('*', async (_detail, ctx) => { seen.push(ctx.type); });

	await bus.publish('order.placed', { id: 'o_4' });
	await bus.publish('user.signed-up', { id: 'u_1' });
	await flush();

	assert.deepStrictEqual(seen.sort(), ['order.placed', 'user.signed-up']);
});

test('EventBus - on() is chainable', async () => {
	const bus = new EventBus(null as any, 'events');
	const ret = bus.on('a', async () => {}).on('b', async () => {});
	assert.strictEqual(ret, bus);
	assert.strictEqual(bus._stats.subscriptions, 2);
});

test('EventBus - publish returns a unique eventId', async () => {
	const bus = new EventBus(null as any, 'events');
	const r1 = await bus.publish('e', { n: 1 });
	const r2 = await bus.publish('e', { n: 2 });
	assert.ok(typeof r1.eventId === 'string' && r1.eventId.length > 0);
	assert.notStrictEqual(r1.eventId, r2.eventId);
});

test('EventBus - publishing the wildcard type throws InvalidEventType', async () => {
	const bus = new EventBus(null as any, 'events');
	await assert.rejects(
		() => bus.publish('*' as any, {}),
		(err: Error) => err.name === EventBusErrors.InvalidEventType,
	);
});

test('EventBus - publishing an empty type throws InvalidEventType', async () => {
	const bus = new EventBus(null as any, 'events');
	await assert.rejects(
		() => bus.publish('' as any, {}),
		(err: Error) => err.name === EventBusErrors.InvalidEventType,
	);
});

test('EventBus - oversized detail throws PayloadTooLarge', async () => {
	const bus = new EventBus(null as any, 'events');
	const big = { blob: 'x'.repeat(257 * 1024) };
	await assert.rejects(
		() => bus.publish('big', big),
		(err: Error) => err.name === EventBusErrors.PayloadTooLarge,
	);
});

test('EventBus - subscriber schema rejection does not crash publish', async () => {
	const bus = new EventBus(null as any, 'events');
	const failing = {
		'~standard': {
			version: 1 as const,
			vendor: 'test',
			validate: () => ({ issues: [{ message: 'nope' }] }),
		},
	};

	let delivered = false;
	bus.on('x', async () => { delivered = true; }, { schema: failing as any });

	await bus.publish('x', { whatever: true });
	await flush();

	assert.strictEqual(delivered, false, 'handler should not run when schema rejects');
	assert.strictEqual(bus._stats.failed, 1);
});

test('EventBus - a throwing subscriber is isolated from others', async () => {
	const bus = new EventBus(null as any, 'events');
	let good = 0;

	bus.on('e', async () => { throw new Error('boom'); });
	bus.on('e', async () => { good++; });

	await bus.publish('e', {});
	await flush();

	assert.strictEqual(good, 1);
	assert.strictEqual(bus._stats.failed, 1);
	assert.strictEqual(bus._stats.delivered, 1);
});

test('internal - subscriptionId is deterministic across layers', () => {
	assert.strictEqual(subscriptionId('app-events', 'order.placed', 0), 'app-events-order_placed-0');
	assert.strictEqual(subscriptionId('app-events', '*', 2), 'app-events-all-2');
});

test('internal - sanitizeType collapses non-alphanumerics', () => {
	assert.strictEqual(sanitizeType('order.placed'), 'order_placed');
	assert.strictEqual(sanitizeType('a--b..c'), 'a_b_c');
	assert.strictEqual(sanitizeType('*'), 'all');
});

test('internal - validateEventType narrows valid strings', () => {
	assert.doesNotThrow(() => validateEventType('order.placed'));
	assert.throws(() => validateEventType(123 as any), (e: Error) => e.name === EventBusErrors.InvalidEventType);
});
