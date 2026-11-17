// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Compile-time contract of the public types. The body never runs: the test
 * passes when this file compiles, and a line marked `@ts-expect-error` must
 * fail to compile. If a rule stops being enforced, the marker itself becomes a
 * build error. The contract is checked against the built types of both runtime
 * entries.
 */
import assert from 'node:assert';
import { test } from 'node:test';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import type { KVStore as AwsKVStore } from './index.aws.js';
import { KVStore } from './index.mock.js';

/** A schema with the given input and output types; the validator never runs here. */
declare function schemaOf<In, Out = In>(): StandardSchemaV1<In, Out>;
declare const scope: { id: string };

// The aws-runtime class must expose the same signatures as the mock. A method
// of one that does not accept the other's arguments fails here.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const _sameGet: Same<KVStore<string>['get'], AwsKVStore<string>['get']> = true;
const _samePut: Same<KVStore<string>['put'], AwsKVStore<string>['put']> = true;
const _sameQuery: Same<KVStore<string>['query'], AwsKVStore<string>['query']> = true;
void _sameGet;
void _samePut;
void _sameQuery;

// biome-ignore lint/correctness/noUnusedVariables: compile-only contract, never called
async function _contract() {
	// ── 1. Zero options: a string key and a string value ────────────────────────
	const cache = new KVStore(scope, 'cache');
	await cache.put('greeting', 'hello', { ttlSeconds: 300 });
	const greeting: string | null = await cache.get('greeting');
	// The two shipped compositions stay.
	await cache.put('greeting', 'hi', { ifNotExists: true, ifValueEquals: 'hello' });
	await cache.delete('greeting', { ifExists: true, ifValueEquals: 'hi' });
	for await (const { key, value } of cache.scan()) {
		const k: string = key;
		const v: string = value;
		void k;
		void v;
	}
	// @ts-expect-error the value type is string
	await cache.put('x', { a: 1 });
	// @ts-expect-error a string store takes a string key, not a pair
	await cache.get(['a', 'b']);
	// @ts-expect-error a string store takes a string key, not an object
	await cache.get({ id: 'a' });
	// @ts-expect-error ifFieldEquals needs an object value
	await cache.put('x', 'y', { ifFieldEquals: { a: 1 } });
	// @ts-expect-error ttlSeconds and expiresAt exclude each other
	await cache.put('x', 'y', { ttlSeconds: 60, expiresAt: 1800000000 });
	// @ts-expect-error a string store with no index has nothing to query
	cache.query({ index: 'nope', where: { x: { equals: 'x' } } });
	// @ts-expect-error a key needs a schema
	new KVStore(scope, 'bad', { key: { partitionKey: 'length' } });
	// @ts-expect-error an index needs a schema
	new KVStore(scope, 'bad', { indexes: { byLength: { partitionKey: 'length' } } });

	// A typed store with no schema, as today.
	interface Profile {
		name: string;
		email: string;
		version: number;
	}
	const profiles = new KVStore<Profile>(scope, 'profiles');
	await profiles.put('u1', { name: 'A', email: 'a@example.com', version: 2 }, { ifFieldEquals: { version: 1 } });
	await profiles.put(
		'u1',
		{ name: 'A', email: 'a@example.com', version: 1 },
		{ ifNotExists: true, ifFieldEquals: { version: 0 } },
	);
	await profiles.put(
		'u1',
		{ name: 'A', email: 'a@example.com', version: 2 },
		// @ts-expect-error an object value has no whole-value compare
		{ ifValueEquals: { name: 'A', email: 'a@example.com', version: 1 } },
	);
	// @ts-expect-error ifFieldEquals needs at least one field
	await profiles.delete('u1', { ifFieldEquals: {} });
	// @ts-expect-error ifFieldEquals takes fields of the value only
	await profiles.delete('u1', { ifFieldEquals: { nope: 1 } });
	const lists = new KVStore<number[]>(scope, 'lists');
	await lists.put('a', [1, 2], { ifValueEquals: [1] });
	// @ts-expect-error an array is not an object value
	await lists.put('a', [1, 2], { ifFieldEquals: { length: 1 } });

	// ── 2. A schema and a declared key ──────────────────────────────────────────
	interface Order {
		userId: string;
		orderId: string;
		total: number;
		placedAt: number;
		note?: string;
		tags: string[];
	}
	const orders = new KVStore(scope, 'orders', {
		schema: schemaOf<Order>(),
		key: { partitionKey: 'userId', sortKey: 'orderId' },
	});
	const orderKey = { userId: 'alice', orderId: '001' };
	await orders.put(orderKey, { total: 12, placedAt: 1, tags: [] });
	await orders.put(
		orderKey,
		{ userId: 'alice', orderId: '001', total: 12, placedAt: 1, tags: [] },
		{ ifNotExists: true },
	);
	const order = await orders.get({ userId: 'alice', orderId: '001' }, { consistentRead: true });
	if (order) await orders.put(orderKey, { ...order, total: 13 }, { ifFieldEquals: { total: order.total } });
	for await (const { key, value } of orders.query({
		where: { userId: { equals: 'alice' }, orderId: { beginsWith: '2026-' } },
		order: 'desc',
		limit: 20,
	})) {
		const u: string = key.userId;
		const o: string = key.orderId;
		const t: number = value.total;
		void u;
		void o;
		void t;
	}
	await orders.getBatch([orderKey]);
	await orders.putBatch([{ key: orderKey, value: { total: 1, placedAt: 1, tags: [] }, ttlSeconds: 60 }]);
	await orders.deleteBatch([orderKey]);
	// @ts-expect-error a store with a declared key rejects a string key
	await orders.get('alice');
	// @ts-expect-error a store with a declared key rejects a pair
	await orders.get(['alice', '001']);
	// @ts-expect-error the sort field is required
	await orders.get({ userId: 'alice' });
	// @ts-expect-error a key has the key fields only
	await orders.get({ userId: 'alice', orderId: '001', total: 12 });
	// @ts-expect-error a key field has the type of the schema field
	await orders.get({ userId: 1, orderId: '001' });
	// @ts-expect-error the value must carry every field that is not a key field
	await orders.put(orderKey, { userId: 'alice', orderId: '001' });
	// @ts-expect-error a value field has the type of the schema field
	await orders.put(orderKey, { total: 'x', placedAt: 1, tags: [] });
	// @ts-expect-error a query needs the partition field
	orders.query({ where: { orderId: { beginsWith: '2026-' } } });
	// @ts-expect-error the partition field takes equals only
	orders.query({ where: { userId: { beginsWith: 'a' } } });
	// @ts-expect-error the sort field takes one condition
	orders.query({ where: { userId: { equals: 'alice' }, orderId: { greaterThan: 'a', lessThan: 'z' } } });
	// @ts-expect-error a field that is not in the key cannot appear in where
	orders.query({ where: { userId: { equals: 'alice' }, total: { equals: 12 } } });
	// @ts-expect-error a batch key is checked like any key
	await orders.deleteBatch([{ userId: 'alice' }]);
	// @ts-expect-error a key field must exist in the schema
	new KVStore(scope, 'bad', { schema: schemaOf<Order>(), key: { partitionKey: 'nope' } });
	// @ts-expect-error an optional field cannot be a key field
	new KVStore(scope, 'bad', { schema: schemaOf<Order>(), key: { partitionKey: 'note' } });
	// @ts-expect-error a key field holds a string or a number
	new KVStore(scope, 'bad', { schema: schemaOf<Order>(), key: { partitionKey: 'tags' } });
	// @ts-expect-error an explicit type argument with a key fails, and does not widen the key in silence
	new KVStore<Order>(scope, 'bad', { schema: schemaOf<Order>(), key: { partitionKey: 'userId' } });

	// A number sort field.
	interface Reading {
		deviceId: string;
		at: number;
		celsius: number;
	}
	const readings = new KVStore(scope, 'readings', {
		schema: schemaOf<Reading>(),
		key: { partitionKey: 'deviceId', sortKey: 'at' },
	});
	readings.query({ where: { deviceId: { equals: 'd1' }, at: { between: [1, 2] } } });
	// @ts-expect-error a number sort field has no beginsWith
	readings.query({ where: { deviceId: { equals: 'd1' }, at: { beginsWith: '1' } } });
	// @ts-expect-error a sort condition has the type of the sort field
	readings.query({ where: { deviceId: { equals: 'd1' }, at: { greaterThan: 'x' } } });

	// A key with one field.
	interface Job {
		jobId: string;
		state: string;
		version: number;
	}
	const jobs = new KVStore(scope, 'jobs', { schema: schemaOf<Job>(), key: { partitionKey: 'jobId' } });
	await jobs.put({ jobId: 'j1' }, { state: 'queued', version: 1 }, { ifNotExists: true });
	// @ts-expect-error a key with one field takes no second field
	await jobs.get({ jobId: 'j1', state: 'queued' });

	// ── 3. Indexes ──────────────────────────────────────────────────────────────
	interface Connection {
		connectionId: string;
		channel: string;
		joinedAt: number;
		nickname?: string;
	}
	const connections = new KVStore(scope, 'connections', {
		schema: schemaOf<Connection>(),
		key: { partitionKey: 'connectionId', sortKey: 'channel' },
		indexes: {
			byChannel: { partitionKey: 'channel', sortKey: 'connectionId' },
			byNickname: { partitionKey: 'nickname' },
		},
	});
	connections.query({
		index: 'byChannel',
		where: { channel: { equals: 'room-1' }, connectionId: { beginsWith: 'a' } },
	});
	connections.query({ index: 'byNickname', where: { nickname: { equals: 'sam' } } });
	connections.query({ where: { connectionId: { equals: 'c1' } } });
	// @ts-expect-error the index name must be declared
	connections.query({ index: 'nope', where: { channel: { equals: 'room-1' } } });
	// @ts-expect-error where takes the fields of the chosen index
	connections.query({ index: 'byChannel', where: { connectionId: { equals: 'c1' } } });
	// @ts-expect-error an index field must exist in the schema
	new KVStore(scope, 'bad', { schema: schemaOf<Connection>(), indexes: { x: { partitionKey: 'nope' } } });

	// An index on a store with a string key.
	const users = new KVStore(scope, 'users', {
		schema: schemaOf<Profile>(),
		indexes: { byEmail: { partitionKey: 'email' } },
	});
	await users.put('u1', { name: 'A', email: 'a@example.com', version: 1 });
	const user: Profile | null = await users.get('u1');
	users.query({ index: 'byEmail', where: { email: { equals: 'a@example.com' } } });
	// @ts-expect-error a string store has no key to query by, so the query needs an index
	users.query({ where: { email: { equals: 'a@example.com' } } });
	// @ts-expect-error an index field holds a string or a number
	new KVStore(scope, 'bad', { schema: schemaOf<Order>(), indexes: { x: { partitionKey: 'tags' } } });

	// ── 4. The input type and the output type of a schema ───────────────────────
	// A brand stops a swap of two key fields. The stand-in below has the shape that zod's .brand() gives.
	type Brand<T, B extends string> = T & { readonly __brand: B };
	type UserId = Brand<string, 'UserId'>;
	type OrderId = Brand<string, 'OrderId'>;
	interface BrandedIn {
		userId: string;
		orderId: string;
		total: number;
		currency?: string;
	}
	interface BrandedOut {
		userId: UserId;
		orderId: OrderId;
		total: number;
		currency: string;
	}
	const branded = new KVStore(scope, 'branded', {
		schema: schemaOf<BrandedIn, BrandedOut>(),
		key: { partitionKey: 'userId', sortKey: 'orderId' },
		indexes: { byOrder: { partitionKey: 'orderId' } },
	});
	const userId = 'alice' as UserId;
	const orderId = '001' as OrderId;
	await branded.put({ userId, orderId }, { total: 12 }); // the input type: currency has a default, and the key supplies the key fields
	const brandedOrder = await branded.get({ userId, orderId });
	if (brandedOrder) {
		const c: string = brandedOrder.currency;
		const u: UserId = brandedOrder.userId;
		void c;
		void u;
		await branded.put({ userId, orderId }, { ...brandedOrder, total: 13 }); // a value from a read goes back into put
		await branded.put(
			{ userId: brandedOrder.userId, orderId: brandedOrder.orderId },
			{ total: 14 },
			{ ifFieldEquals: { total: brandedOrder.total } },
		);
	}
	branded.query({ index: 'byOrder', where: { orderId: { equals: orderId } } });
	// @ts-expect-error two branded key fields cannot swap
	await branded.get({ userId: orderId, orderId: userId });
	// @ts-expect-error a plain string is not a branded key field
	await branded.get({ userId: 'alice', orderId: '001' });
	// @ts-expect-error a branded index field rejects another brand
	branded.query({ index: 'byOrder', where: { orderId: { equals: userId } } });
	// @ts-expect-error put takes the input type, so total stays required
	await branded.put({ userId, orderId }, { currency: 'USD' });

	// A schema that changes a type. The read type and the write type differ.
	interface EventIn {
		id: string;
		at: string;
	}
	interface EventOut {
		id: string;
		at: Date;
	}
	const events = new KVStore(scope, 'events', { schema: schemaOf<EventIn, EventOut>() });
	await events.put('e1', { id: 'e1', at: '2026-11-10' });
	const event = await events.get('e1');
	if (event) {
		const at: Date = event.at;
		void at;
		// @ts-expect-error the store holds the input type, so a Date from a read does not go back into put
		await events.put('e1', event);
	}
	// @ts-expect-error a key field cannot change its type between input and output
	new KVStore(scope, 'bad', { schema: schemaOf<{ id: number }, { id: string }>(), key: { partitionKey: 'id' } });
	// @ts-expect-error an index field cannot change its type between input and output
	new KVStore(scope, 'bad', { schema: schemaOf<EventIn, EventOut>(), indexes: { byAt: { partitionKey: 'at' } } });

	// ── 5. Pages, the ttl option, and a union value type ────────────────────────
	const requestCursor = undefined as string | undefined;
	const firstPage = orders.query({ where: { userId: { equals: 'alice' } }, limit: 20, cursor: requestCursor });
	for await (const { value } of firstPage) {
		void value;
	}
	const nextCursor: string | undefined = firstPage.cursor;
	const scanPage = cache.scan({ limit: 100, cursor: nextCursor });
	void scanPage.cursor;
	// @ts-expect-error a cursor is a string
	orders.query({ where: { userId: { equals: 'alice' } }, cursor: 5 });

	interface Session {
		sessionId: string;
		userId: string;
		expiresAt: number;
	}
	const sessions = new KVStore(scope, 'sessions', {
		schema: schemaOf<Session>(),
		key: { partitionKey: 'sessionId' },
		ttl: 'expiresAt',
	});
	await sessions.put({ sessionId: 's1' }, { userId: 'alice', expiresAt: 1800000000 });
	// @ts-expect-error ttl names a number field
	new KVStore(scope, 'bad', { schema: schemaOf<Session>(), ttl: 'userId' });
	// @ts-expect-error ttl names a field of the schema
	new KVStore(scope, 'bad', { schema: schemaOf<Session>(), ttl: 'nope' });
	// @ts-expect-error ttl needs a schema
	new KVStore(scope, 'bad', { ttl: 'expiresAt' });

	const mixed = new KVStore<string | Profile>(scope, 'mixed');
	await mixed.put('k', 'text', { ifValueEquals: 'old text' });
	await mixed.put('k', { name: 'A', email: 'a@example.com', version: 2 }, { ifFieldEquals: { version: 1 } });
	await mixed.put(
		'k',
		{ name: 'A', email: 'a@example.com', version: 2 },
		// @ts-expect-error a union value type still has no whole-value compare of an object
		{ ifValueEquals: { name: 'A', email: 'a@example.com', version: 1 } },
	);

	// A rewrite keeps the expiry of each item.
	for await (const { key, value, expiresAt } of cache.scan()) {
		await cache.put(key, value.trim(), { ifValueEquals: value, expiresAt });
	}
	void greeting;
	void user;
}

test('the public types compile with their 49 rejections', () => {
	// The contract above is checked by the compiler; this test only records that the file built.
	assert.strictEqual(typeof _contract, 'function');
});
