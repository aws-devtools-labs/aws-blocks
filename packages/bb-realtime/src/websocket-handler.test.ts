// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the deployed WebSocket handler (`handleWebSocketEvent` in
 * index.aws.ts), driven through the handler the Realtime block registers.
 *
 * Under the default test conditions index.aws.ts resolves its DistributedTable
 * and AppSetting dependencies to their local mocks, so the connections table and
 * token secret live in `.bb-data/`. Only the API Gateway Management API client
 * is stubbed, to capture what the handler posts to each connection.
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { setTimeout as delay } from 'node:timers/promises';
import { ApiGatewayManagementApiClient } from '@aws-sdk/client-apigatewaymanagementapi';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { Scope } from '@aws-blocks/core';
import { DistributedTable } from '@aws-blocks/bb-distributed-table';
import { Realtime } from './index.aws.js';

const DOMAIN = 'example.execute-api.us-east-1.amazonaws.com';
const STAGE = 'prod';

const anySchema: StandardSchemaV1<unknown> = {
	'~standard': { version: 1, vendor: 'test', validate: (value: unknown) => ({ value }) },
};

interface Posted {
	ConnectionId: string;
	Data: string;
}

const posted: Posted[] = [];
const originalSend = ApiGatewayManagementApiClient.prototype.send;
const originalCallbackUrl = process.env.BLOCKS_RT_CALLBACK_URL;

const scope = new Scope(`rt-ws-${Math.random().toString(36).slice(2)}`);
const rt = new Realtime(scope, 'rt', { namespaces: { chat: Realtime.namespace(anySchema) } });

// The mock connections table the handler writes to.
interface ConnectionRecord {
	connectionId: string;
	channel: string;
	expiresAt: number;
}
const connectionRecordSchema: StandardSchemaV1<ConnectionRecord> = {
	'~standard': { version: 1, vendor: 'test', validate: (value: unknown) => ({ value: value as ConnectionRecord }) },
};
/**
 * A fresh view of the handler's connections table: same fullId, so the same
 * `.bb-data/` file. The mock loads the file when constructed, so build one per read.
 */
const connectionsOnDisk = () =>
	new DistributedTable(rt, 'connections', {
		schema: connectionRecordSchema,
		key: { partitionKey: 'connectionId', sortKey: 'channel' } as const,
		indexes: { 'channel-index': { partitionKey: 'channel', sortKey: 'connectionId' } } as const,
		ttl: 'expiresAt',
	});

function wsHandler(): (event: unknown) => Promise<{ statusCode: number }> {
	const handlers: Map<string, (event: unknown) => Promise<{ statusCode: number }>> =
		(globalThis as any).__BLOCKS_LAMBDA_EVENT_HANDLERS__;
	const handler = handlers.get(`blocks.websocket:${rt.fullId}`);
	assert.ok(handler, 'Realtime registers a blocks.websocket handler');
	return handler;
}

function connectEvent(connectionId: string, token: string) {
	return {
		requestContext: { eventType: 'CONNECT', connectionId, domainName: DOMAIN, stage: STAGE },
		queryStringParameters: { token },
	};
}

function messageEvent(connectionId: string, body: unknown) {
	return {
		requestContext: { eventType: 'MESSAGE', connectionId, domainName: DOMAIN, stage: STAGE },
		body: JSON.stringify(body),
	};
}

/** What the handler posted to `connectionId`, parsed. */
function repliesTo(connectionId: string): Array<{ type: string; channel?: string; message?: string }> {
	return posted.filter(p => p.ConnectionId === connectionId).map(p => JSON.parse(p.Data));
}

async function channelRecords(connectionId: string): Promise<string[]> {
	const records = await Array.fromAsync(connectionsOnDisk().query({ where: { connectionId: { equals: connectionId } } }));
	return records.map(r => r.channel).sort();
}

let nextId = 0;
const newConnectionId = () => `conn-${process.pid}-${nextId++}`;

before(() => {
	process.env.BLOCKS_RT_CALLBACK_URL = `https://${DOMAIN}/${STAGE}`;
	ApiGatewayManagementApiClient.prototype.send = (async (command: { input: Posted }) => {
		posted.push(command.input);
		return {};
	}) as typeof originalSend;
});

after(() => {
	ApiGatewayManagementApiClient.prototype.send = originalSend;
	if (originalCallbackUrl === undefined) delete process.env.BLOCKS_RT_CALLBACK_URL;
	else process.env.BLOCKS_RT_CALLBACK_URL = originalCallbackUrl;
});

beforeEach(() => {
	posted.length = 0;
});

/** A connection that completed $connect with the channel's connect token. */
async function connected(channel = 'room-1') {
	// toJSON() is the wire descriptor a client receives.
	const json = (await rt.getChannel('chat', channel)).toJSON();
	const descriptor = { channel: json.channel, token: String(json.token), connectToken: String(json.connectToken) };
	const connectionId = newConnectionId();
	const res = await wsHandler()(connectEvent(connectionId, descriptor.connectToken));
	assert.strictEqual(res.statusCode, 200);
	return { connectionId, descriptor };
}

describe('WebSocket handler: subscribe', () => {
	it('subscribes with a channel token and delivers published messages', async () => {
		const { connectionId, descriptor } = await connected();
		await wsHandler()(messageEvent(connectionId, { action: 'subscribe', channel: descriptor.channel, token: descriptor.token }));
		assert.deepStrictEqual(repliesTo(connectionId), [{ type: 'subscribe_success', channel: descriptor.channel }]);

		await rt.publish('chat', 'room-1', { text: 'hi' });
		assert.deepStrictEqual(repliesTo(connectionId).at(-1), { type: 'message', channel: descriptor.channel, data: { text: 'hi' } });
	});

	for (const [label, channel] of [
		['a number', 42],
		['an object', { toString: 'x' }],
		['an empty string', ''],
		['a path with no namespace', 'rt-ws/room-1'],
		['a path with no instance', '/chat/room-1'],
		['the connection record key', '__connection__'],
		['a path over 1024 bytes', `rt-ws/chat/${'x'.repeat(1024)}`],
	] as const) {
		it(`rejects ${label} as the channel and records nothing`, async () => {
			const { connectionId, descriptor } = await connected();
			await wsHandler()(messageEvent(connectionId, { action: 'subscribe', channel, token: descriptor.token }));
			assert.deepStrictEqual(repliesTo(connectionId), [{ type: 'error', message: 'Invalid channel' }]);
			assert.deepStrictEqual(await channelRecords(connectionId), ['__connection__']);
		});
	}

	it('rejects a subscribe authorized only by the connect token', async () => {
		const { connectionId, descriptor } = await connected();
		const channel = `${rt.fullId}$connect/chat/room-1`;
		await wsHandler()(messageEvent(connectionId, { action: 'subscribe', channel, token: descriptor.connectToken }));
		assert.deepStrictEqual(repliesTo(connectionId), [{ type: 'error', channel, message: 'Unauthorized: invalid or expired token' }]);
		assert.deepStrictEqual(await channelRecords(connectionId), ['__connection__']);
	});

	for (const [label, token] of [['a missing token', undefined], ['an empty token', ''], ['a token that is not a string', { a: 1 }]] as const) {
		it(`answers a subscribe with ${label} with Unauthorized, as the local server does`, async () => {
			const { connectionId, descriptor } = await connected();
			const res = await wsHandler()(messageEvent(connectionId, { action: 'subscribe', channel: descriptor.channel, token }));
			assert.strictEqual(res.statusCode, 200);
			assert.deepStrictEqual(repliesTo(connectionId), [{ type: 'error', channel: descriptor.channel, message: 'Unauthorized: missing token' }]);
			assert.deepStrictEqual(await channelRecords(connectionId), ['__connection__']);
		});
	}
});

/**
 * Run `fn` with a channel-index that lags the table the way a DynamoDB GSI does: `publish()`
 * finds a channel's subscribers there, but DynamoDB updates the index after the table write, so
 * an index query sees a record only `lagMs` after its put.
 */
async function withLaggingChannelIndex(lagMs: number, fn: () => Promise<void>): Promise<void> {
	const visibleAt = new Map<string, number>();
	const recordKey = (r: { connectionId?: unknown; channel?: unknown }) => `${String(r.connectionId)} ${String(r.channel)}`;
	const originalPut = DistributedTable.prototype.put;
	const originalQuery = DistributedTable.prototype.query;
	DistributedTable.prototype.put = function (this: InstanceType<typeof DistributedTable>, item: Record<string, unknown>, ...rest: unknown[]) {
		visibleAt.set(recordKey(item), Date.now() + lagMs);
		return (originalPut as (...args: unknown[]) => Promise<void>).call(this, item, ...rest);
	} as typeof originalPut;
	DistributedTable.prototype.query = function (this: InstanceType<typeof DistributedTable>, options: { index?: string }) {
		const records = (originalQuery as (o: unknown) => AsyncIterable<Record<string, unknown>>).call(this, options);
		if (options.index !== 'channel-index') return records;
		return (async function* () {
			for await (const r of records) if ((visibleAt.get(recordKey(r)) ?? 0) <= Date.now()) yield r;
		})();
	} as typeof originalQuery;
	try {
		await fn();
	} finally {
		DistributedTable.prototype.put = originalPut;
		DistributedTable.prototype.query = originalQuery;
	}
}

/**
 * Run `fn` with every channel-index query answered by `lookup()` instead of the table, passing it
 * the number of channel-index queries made so far.
 */
async function withChannelIndexLookup(
	lookup: () => AsyncIterable<Record<string, unknown>>,
	fn: (lookups: () => number) => Promise<void>,
): Promise<void> {
	let count = 0;
	const originalQuery = DistributedTable.prototype.query;
	DistributedTable.prototype.query = function (this: InstanceType<typeof DistributedTable>, options: { index?: string }) {
		if (options.index !== 'channel-index') return (originalQuery as (o: unknown) => AsyncIterable<Record<string, unknown>>).call(this, options);
		count++;
		return lookup();
	} as typeof originalQuery;
	try {
		await fn(() => count);
	} finally {
		DistributedTable.prototype.query = originalQuery;
	}
}

/** Run `fn` with console.warn captured; returns what it warned. */
async function capturingWarnings(fn: () => Promise<void>): Promise<string[]> {
	const warnings: string[] = [];
	const originalWarn = console.warn;
	console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
	try {
		await fn();
	} finally {
		console.warn = originalWarn;
	}
	return warnings;
}

describe('WebSocket handler: subscribe confirmation and the channel index', () => {
	it('confirms a subscribe only once publish() can find it, so the first publish after it is delivered', async () => {
		await withLaggingChannelIndex(300, async () => {
			const { connectionId, descriptor } = await connected('room-lag');
			await wsHandler()(messageEvent(connectionId, { action: 'subscribe', channel: descriptor.channel, token: descriptor.token }));
			assert.deepStrictEqual(repliesTo(connectionId), [{ type: 'subscribe_success', channel: descriptor.channel }]);

			// What a client does as soon as `established` resolves.
			await rt.publish('chat', 'room-lag', { text: 'first' });
			assert.deepStrictEqual(repliesTo(connectionId).at(-1), { type: 'message', channel: descriptor.channel, data: { text: 'first' } });
		});
	});

	it('still confirms, with a warning, a subscribe the index has not shown after its wait', async () => {
		const warnings = await capturingWarnings(() => withLaggingChannelIndex(Number.POSITIVE_INFINITY, async () => {
			const { connectionId, descriptor } = await connected('room-never');
			const started = Date.now();
			await wsHandler()(messageEvent(connectionId, { action: 'subscribe', channel: descriptor.channel, token: descriptor.token }));
			assert.ok(Date.now() - started < 5000, 'the wait is bounded');
			assert.deepStrictEqual(repliesTo(connectionId), [{ type: 'subscribe_success', channel: descriptor.channel }]);
		}));
		assert.ok(warnings.some(w => /without seeing it on channel-index \(not visible after 3000ms\)/.test(w)), 'the late index is reported');
	});

	it('confirms, with a warning, a subscribe whose channel-index lookup fails after the record was written', async () => {
		const throttled = Object.assign(new Error('The level of configured provisioned throughput for the index was exceeded.'), {
			name: 'ProvisionedThroughputExceededException',
		});
		const warnings = await capturingWarnings(() => withChannelIndexLookup(
			// What DistributedTable's query does once the SDK has given up retrying the throttled read.
			() => ({ [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(throttled) }) }),
			async () => {
				const { connectionId, descriptor } = await connected('room-throttled');
				const res = await wsHandler()(messageEvent(connectionId, { action: 'subscribe', channel: descriptor.channel, token: descriptor.token }));
				assert.strictEqual(res.statusCode, 200);
				assert.deepStrictEqual(await channelRecords(connectionId), ['__connection__', descriptor.channel].sort(), 'the subscription was recorded');
				assert.deepStrictEqual(repliesTo(connectionId), [{ type: 'subscribe_success', channel: descriptor.channel }]);
			},
		));
		assert.ok(warnings.some(w => /the lookup failed \(ProvisionedThroughputExceededException: /.test(w)), 'the failed lookup is reported');
	});

	it('confirms within its budget when a channel-index lookup never answers, and stops looking', { timeout: 10_000 }, async () => {
		const never: AsyncIterable<Record<string, unknown>> = { [Symbol.asyncIterator]: () => ({ next: () => new Promise<never>(() => {}) }) };
		const warnings = await capturingWarnings(() => withChannelIndexLookup(() => never, async (lookups) => {
			const { connectionId, descriptor } = await connected('room-hung');
			const started = Date.now();
			await wsHandler()(messageEvent(connectionId, { action: 'subscribe', channel: descriptor.channel, token: descriptor.token }));
			const elapsed = Date.now() - started;
			assert.ok(elapsed >= 2900 && elapsed < 4000, `confirmed at the 3000 ms budget (after ${elapsed} ms)`);
			assert.deepStrictEqual(repliesTo(connectionId), [{ type: 'subscribe_success', channel: descriptor.channel }]);
			assert.strictEqual(lookups(), 1, 'one lookup, abandoned at the deadline');
			// Real time on purpose: a poll left running in the background would show up as more lookups.
			await delay(500);
			assert.strictEqual(lookups(), 1, 'nothing keeps polling after the confirmation');
		}));
		assert.ok(warnings.some(w => /without seeing it on channel-index \(not visible after 3000ms\)/.test(w)), 'the timeout is reported');
	});
});

describe('WebSocket handler: unsubscribe', () => {
	it('removes a subscription', async () => {
		const { connectionId, descriptor } = await connected();
		await wsHandler()(messageEvent(connectionId, { action: 'subscribe', channel: descriptor.channel, token: descriptor.token }));
		assert.deepStrictEqual(await channelRecords(connectionId), ['__connection__', descriptor.channel].sort());

		await wsHandler()(messageEvent(connectionId, { action: 'unsubscribe', channel: descriptor.channel }));
		assert.deepStrictEqual(await channelRecords(connectionId), ['__connection__']);
	});

	it('does not remove the connection record', async () => {
		const { connectionId } = await connected();
		await wsHandler()(messageEvent(connectionId, { action: 'unsubscribe', channel: '__connection__' }));
		assert.deepStrictEqual(await channelRecords(connectionId), ['__connection__']);
	});

	it('ignores a non-string channel without touching the connections table', async () => {
		const { connectionId } = await connected();
		// The mock table accepts any sort key and would just delete nothing, so check
		// that the handler never calls delete() for this connection.
		const deletedFor: string[] = [];
		const originalDelete = DistributedTable.prototype.delete;
		DistributedTable.prototype.delete = function (this: InstanceType<typeof DistributedTable>, key: Record<string, unknown>, ...rest: unknown[]) {
			if (key.connectionId === connectionId) deletedFor.push(String(key.connectionId));
			return (originalDelete as (...args: unknown[]) => Promise<void>).call(this, key, ...rest);
		} as typeof originalDelete;
		try {
			const res = await wsHandler()(messageEvent(connectionId, { action: 'unsubscribe', channel: { S: 'x' } }));
			assert.strictEqual(res.statusCode, 200);
		} finally {
			DistributedTable.prototype.delete = originalDelete;
		}
		assert.deepStrictEqual(deletedFor, []);
		assert.deepStrictEqual(await channelRecords(connectionId), ['__connection__']);
	});
});
