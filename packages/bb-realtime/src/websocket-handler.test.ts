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
import { ApiGatewayManagementApiClient } from '@aws-sdk/client-apigatewaymanagementapi';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { Scope, isBlocksError } from '@aws-blocks/core';
import { DistributedTable } from '@aws-blocks/bb-distributed-table';
import { Realtime, RealtimeErrors } from './index.aws.js';
import type { GetChannelOptions } from './index.aws.js';

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
	principal?: string;
	tokenExp?: number;
	tokenIat?: number;
	tokenId?: string;
	revokedAt?: number;
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
function repliesTo(connectionId: string): Array<{ type: string; channel?: string; message?: string; code?: string }> {
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
async function connected(channel = 'room-1', options?: GetChannelOptions) {
	// toJSON() is the wire descriptor a client receives.
	const json = (await rt.getChannel('chat', channel, options)).toJSON();
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

describe('WebSocket handler: channel token scope', () => {
	it('an exact token subscribes to its own channel', async () => {
		const { connectionId, descriptor } = await connected('room-a', { scope: 'exact' });
		await wsHandler()(messageEvent(connectionId, { action: 'subscribe', channel: descriptor.channel, token: descriptor.token }));
		assert.deepStrictEqual(repliesTo(connectionId), [{ type: 'subscribe_success', channel: descriptor.channel }]);
		assert.deepStrictEqual(await channelRecords(connectionId), ['__connection__', descriptor.channel]);
	});

	it('an exact token is refused for a sub-channel', async () => {
		const { connectionId, descriptor } = await connected('room-a', { scope: 'exact' });
		const channel = `${descriptor.channel}/b`;
		await wsHandler()(messageEvent(connectionId, { action: 'subscribe', channel, token: descriptor.token }));
		assert.deepStrictEqual(repliesTo(connectionId), [{ type: 'error', channel, message: 'Unauthorized: invalid or expired token' }]);
		assert.deepStrictEqual(await channelRecords(connectionId), ['__connection__']);
	});

	it('a default (subtree) token still subscribes to a sub-channel', async () => {
		const { connectionId, descriptor } = await connected('room-a');
		const channel = `${descriptor.channel}/b`;
		await wsHandler()(messageEvent(connectionId, { action: 'subscribe', channel, token: descriptor.token }));
		assert.deepStrictEqual(repliesTo(connectionId), [{ type: 'subscribe_success', channel }]);
	});

	it('getChannel() rejects an unknown scope value', async () => {
		await assert.rejects(
			() => rt.getChannel('chat', 'room-a', { scope: 'all' as unknown as 'exact' }),
			(e: unknown) => isBlocksError(e, RealtimeErrors.ValidationFailed),
		);
	});
});

describe('Realtime (AWS runtime): channel name grammar', () => {
	for (const name of ['', '/a', 'a/', 'a//b', '.', '..', 'a/../b']) {
		it(`publish(), subscribe() and getChannel() reject ${JSON.stringify(name)}`, async () => {
			const isInvalid = (e: unknown) => isBlocksError(e, RealtimeErrors.ValidationFailed);
			await assert.rejects(() => rt.publish('chat', name, {}), isInvalid);
			assert.throws(() => rt.subscribe('chat', name, () => {}), isInvalid);
			await assert.rejects(() => rt.getChannel('chat', name), isInvalid);
		});
	}

	it('rejects undefined as a channel name', async () => {
		const isInvalid = (e: unknown) => isBlocksError(e, RealtimeErrors.ValidationFailed);
		const name = undefined as unknown as string;
		await assert.rejects(() => rt.publish('chat', name, {}), isInvalid);
		assert.throws(() => rt.subscribe('chat', name, () => {}), isInvalid);
		await assert.rejects(() => rt.getChannel('chat', name), isInvalid);
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

describe('WebSocket handler: principal binding', () => {
	it('subscribes a user-bound channel token on a connection opened with the same user', async () => {
		const { connectionId, descriptor } = await connected('bound-1', { principal: 'user-a' });
		await wsHandler()(messageEvent(connectionId, { action: 'subscribe', channel: descriptor.channel, token: descriptor.token }));
		assert.deepStrictEqual(repliesTo(connectionId), [{ type: 'subscribe_success', channel: descriptor.channel }]);
	});

	it("refuses user-a's channel token on user-b's connection", async () => {
		const a = (await rt.getChannel('chat', 'bound-2', { principal: 'user-a' })).toJSON();
		const b = (await rt.getChannel('chat', 'bound-2', { principal: 'user-b' })).toJSON();
		const connectionId = newConnectionId();
		assert.strictEqual((await wsHandler()(connectEvent(connectionId, String(b.connectToken)))).statusCode, 200);
		await wsHandler()(messageEvent(connectionId, { action: 'subscribe', channel: a.channel, token: a.token }));
		assert.deepStrictEqual(repliesTo(connectionId), [{ type: 'error', channel: a.channel, message: 'Unauthorized: invalid or expired token' }]);
		assert.deepStrictEqual(await channelRecords(connectionId), ['__connection__']);
	});

	it('refuses a user-bound channel token on a connection opened without a user', async () => {
		const bound = (await rt.getChannel('chat', 'bound-3', { principal: 'user-a' })).toJSON();
		const unbound = (await rt.getChannel('chat', 'bound-3')).toJSON();
		const connectionId = newConnectionId();
		await wsHandler()(connectEvent(connectionId, String(unbound.connectToken)));
		await wsHandler()(messageEvent(connectionId, { action: 'subscribe', channel: bound.channel, token: bound.token }));
		assert.strictEqual(repliesTo(connectionId)[0]?.type, 'error');
		assert.deepStrictEqual(await channelRecords(connectionId), ['__connection__']);
	});

	it("refuses an unbound channel token on a user's connection", async () => {
		const bound = (await rt.getChannel('chat', 'bound-4', { principal: 'user-a' })).toJSON();
		const unbound = (await rt.getChannel('chat', 'bound-4')).toJSON();
		const connectionId = newConnectionId();
		await wsHandler()(connectEvent(connectionId, String(bound.connectToken)));
		await wsHandler()(messageEvent(connectionId, { action: 'subscribe', channel: unbound.channel, token: unbound.token }));
		assert.strictEqual(repliesTo(connectionId)[0]?.type, 'error');
		assert.deepStrictEqual(await channelRecords(connectionId), ['__connection__']);
	});

	it('refuses a subscribe on a connection that never connected', async () => {
		const descriptor = (await rt.getChannel('chat', 'bound-5')).toJSON();
		const connectionId = newConnectionId();
		await wsHandler()(messageEvent(connectionId, { action: 'subscribe', channel: descriptor.channel, token: descriptor.token }));
		assert.strictEqual(repliesTo(connectionId)[0]?.type, 'error');
		assert.deepStrictEqual(await channelRecords(connectionId), []);
	});

	for (const principal of ['', 'x'.repeat(257)]) {
		it(`getChannel() rejects the principal ${JSON.stringify(principal.slice(0, 8))} (${principal.length} chars)`, async () => {
			await assert.rejects(
				() => rt.getChannel('chat', 'bound-6', { principal }),
				(e: unknown) => isBlocksError(e, RealtimeErrors.ValidationFailed),
			);
		});
	}

	it('records the token details a ping needs on the subscription', async () => {
		const { connectionId, descriptor } = await connected('bound-7', { principal: 'user-a' });
		await wsHandler()(messageEvent(connectionId, { action: 'subscribe', channel: descriptor.channel, token: descriptor.token }));
		const record = await connectionsOnDisk().get({ connectionId, channel: descriptor.channel });
		assert.strictEqual(record?.principal, 'user-a');
		assert.ok(record?.tokenExp && record.tokenExp > Math.floor(Date.now() / 1000));
		assert.ok(record?.tokenIat);
		assert.ok(record?.tokenId);
	});
});

describe('WebSocket handler: channel path grammar', () => {
	for (const suffix of ['/..', '/../x', '/./x', '//x', '/..//x']) {
		it(`rejects a subscribe to a path ending in ${JSON.stringify(suffix)}`, async () => {
			const { connectionId, descriptor } = await connected('trav');
			const channel = `${descriptor.channel}${suffix}`;
			await wsHandler()(messageEvent(connectionId, { action: 'subscribe', channel, token: descriptor.token }));
			assert.deepStrictEqual(repliesTo(connectionId), [{ type: 'error', message: 'Invalid channel' }]);
			assert.deepStrictEqual(await channelRecords(connectionId), ['__connection__']);
		});
	}
});

/** Run `fn` with the clock `seconds` ahead, as if that much time had passed. */
async function withClockAdvanced<T>(seconds: number, fn: () => Promise<T>): Promise<T> {
	const realNow = Date.now;
	Date.now = () => realNow() + seconds * 1000;
	try {
		return await fn();
	} finally {
		Date.now = realNow;
	}
}

describe('WebSocket handler: ping re-checks subscriptions', () => {
	async function subscribed(channel: string, principal?: string) {
		const { connectionId, descriptor } = await connected(channel, principal === undefined ? undefined : { principal });
		await wsHandler()(messageEvent(connectionId, { action: 'subscribe', channel: descriptor.channel, token: descriptor.token }));
		posted.length = 0;
		return { connectionId, descriptor };
	}

	it('keeps a subscription whose token is still valid', async () => {
		const { connectionId, descriptor } = await subscribed('ping-ok', 'user-a');
		await wsHandler()(messageEvent(connectionId, { action: 'ping' }));
		assert.deepStrictEqual(repliesTo(connectionId), []);
		assert.deepStrictEqual(await channelRecords(connectionId), ['__connection__', descriptor.channel].sort());
	});

	it('drops a subscription whose token has expired and tells the client', async () => {
		const { connectionId, descriptor } = await subscribed('ping-expired', 'user-a');
		await withClockAdvanced(3700, () => wsHandler()(messageEvent(connectionId, { action: 'ping' })));
		assert.deepStrictEqual(repliesTo(connectionId), [
			{ type: 'error', channel: descriptor.channel, code: 'token_expired', message: 'Unauthorized: token expired' },
		]);
		assert.deepStrictEqual(await channelRecords(connectionId), ['__connection__']);
	});

	it('drops a subscription that has no token details (written before they were kept)', async () => {
		const { connectionId } = await connected('ping-legacy');
		await connectionsOnDisk().put({ connectionId, channel: 'legacy/ns/room', expiresAt: Math.floor(Date.now() / 1000) + 3600 });
		await wsHandler()(messageEvent(connectionId, { action: 'ping' }));
		assert.deepStrictEqual(await channelRecords(connectionId), ['__connection__']);
	});

	it('drops only the subscriptions that fail', async () => {
		const first = await subscribed('ping-mixed-old', 'user-a');
		// A second subscription made half an hour later outlives the first one's token.
		const later = await withClockAdvanced(1800, async () => {
			const descriptor = (await rt.getChannel('chat', 'ping-mixed-new', { principal: 'user-a' })).toJSON();
			await wsHandler()(messageEvent(first.connectionId, { action: 'subscribe', channel: descriptor.channel, token: descriptor.token }));
			return descriptor;
		});
		posted.length = 0;
		await withClockAdvanced(3700, () => wsHandler()(messageEvent(first.connectionId, { action: 'ping' })));
		assert.deepStrictEqual(await channelRecords(first.connectionId), ['__connection__', later.channel].sort());
		assert.deepStrictEqual(repliesTo(first.connectionId).map(r => [r.channel, r.code]), [[first.descriptor.channel, 'token_expired']]);
	});
});

describe('WebSocket handler: revokeAccess()', () => {
	it('refuses a subscribe with a handle minted before the revocation', async () => {
		const { connectionId, descriptor } = await connected('rev-1', { principal: 'rev-user-1' });
		await rt.revokeAccess('rev-user-1');
		await wsHandler()(messageEvent(connectionId, { action: 'subscribe', channel: descriptor.channel, token: descriptor.token }));
		assert.deepStrictEqual(repliesTo(connectionId), [
			{ type: 'error', channel: descriptor.channel, code: 'access_revoked', message: 'Unauthorized: access revoked' },
		]);
		assert.deepStrictEqual(await channelRecords(connectionId), ['__connection__']);
	});

	it('refuses a connection opened with a connect token minted before the revocation', async () => {
		const descriptor = (await rt.getChannel('chat', 'rev-2', { principal: 'rev-user-2' })).toJSON();
		await rt.revokeAccess('rev-user-2');
		const res = await wsHandler()(connectEvent(newConnectionId(), String(descriptor.connectToken)));
		assert.strictEqual(res.statusCode, 403);
	});

	it('ends a live subscription on the next ping', async () => {
		const { connectionId, descriptor } = await connected('rev-3', { principal: 'rev-user-3' });
		await wsHandler()(messageEvent(connectionId, { action: 'subscribe', channel: descriptor.channel, token: descriptor.token }));
		posted.length = 0;
		await rt.revokeAccess('rev-user-3');
		await wsHandler()(messageEvent(connectionId, { action: 'ping' }));
		assert.deepStrictEqual(repliesTo(connectionId), [
			{ type: 'error', channel: descriptor.channel, code: 'access_revoked', message: 'Unauthorized: access revoked' },
		]);
		assert.deepStrictEqual(await channelRecords(connectionId), ['__connection__']);
	});

	it('does not affect another user, or handles minted after the revocation', async () => {
		const other = await connected('rev-4', { principal: 'rev-other' });
		await wsHandler()(messageEvent(other.connectionId, { action: 'subscribe', channel: other.descriptor.channel, token: other.descriptor.token }));
		await rt.revokeAccess('rev-user-4');
		await new Promise(resolve => setTimeout(resolve, 1100));
		const fresh = await connected('rev-4', { principal: 'rev-user-4' });
		await wsHandler()(messageEvent(fresh.connectionId, { action: 'subscribe', channel: fresh.descriptor.channel, token: fresh.descriptor.token }));
		assert.strictEqual(repliesTo(fresh.connectionId).at(-1)?.type, 'subscribe_success');
		posted.length = 0;
		await wsHandler()(messageEvent(other.connectionId, { action: 'ping' }));
		assert.deepStrictEqual(repliesTo(other.connectionId), []);
	});

	it('stores the revocation in the connections table, apart from connection records', async () => {
		await rt.revokeAccess('rev-user-5');
		const record = await connectionsOnDisk().get({ connectionId: 'revoked#rev-user-5', channel: '__revoked__' });
		assert.ok(record?.revokedAt);
		assert.ok(record.expiresAt > record.revokedAt);
	});

	it('rejects an invalid principal', async () => {
		await assert.rejects(() => rt.revokeAccess(''), (e: unknown) => isBlocksError(e, RealtimeErrors.ValidationFailed));
		await assert.rejects(() => rt.revokeAccess(undefined as unknown as string), (e: unknown) => isBlocksError(e, RealtimeErrors.ValidationFailed));
	});
});
