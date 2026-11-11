// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Every TypeScript snippet of README.md, in README order, as a compile-only
 * contract. The body never runs: the test passes when this file compiles
 * against the package's own types. A line the README marks as a compile error
 * carries `@ts-expect-error`, so the marker itself fails the build if the
 * README's claim stops being true. Keep this file in step with README.md.
 */
import assert from 'node:assert';
import { test } from 'node:test';
import type { ScopeParent } from '@aws-blocks/core';
import { ApiNamespace, isBlocksError } from '@aws-blocks/core';
import { z } from 'zod';
import { KVStore, KVStoreErrors } from './index.mock.js';

declare const scope: ScopeParent;
/** Stand-in for `new AuthBasic(scope, 'auth')`: bb-auth-basic depends on this package, so it cannot be imported here. */
declare const auth: { requireAuth(context: unknown): Promise<{ userId: string; username: string }> };

// biome-ignore lint/correctness/noUnusedVariables: compile-only contract, never called
async function _readme() {
	// ── Pick a form ─────────────────────────────────────────────────────────────

	// 1. No options. A string key and a string value.
	const cache = new KVStore(scope, 'cache');

	// 2. A schema and an index. Typed values, and a read by another field.
	const users = new KVStore(scope, 'users', {
		schema: z.object({ name: z.string(), email: z.string() }),
		indexes: { byEmail: { partitionKey: 'email' } },
	});

	// 3. A schema and a key. Records that you list in order inside a group.
	const todos = new KVStore(scope, 'todos', {
		schema: z.object({
			userId: z.string(),
			todoId: z.string(),
			title: z.string(),
			done: z.boolean(),
			version: z.number(),
		}),
		key: { partitionKey: 'userId', sortKey: 'todoId' },
	});

	// ── Keys ────────────────────────────────────────────────────────────────────

	await cache.get('greeting');
	await todos.get({ userId: 'alice', todoId: '001' });

	// @ts-expect-error compile error: the key is an object
	await todos.get('alice');
	// @ts-expect-error compile error: todoId is missing
	await todos.get({ userId: 'alice' });

	// ── Branded key fields ──────────────────────────────────────────────────────

	const UserId = z.string().brand<'UserId'>();
	const NoteId = z.string().brand<'NoteId'>();
	const notes = new KVStore(scope, 'notes', {
		schema: z.object({ userId: UserId, noteId: NoteId, text: z.string() }),
		key: { partitionKey: 'userId', sortKey: 'noteId' },
	});

	const userId = UserId.parse('alice');
	const noteId = NoteId.parse('n1');
	await notes.get({ userId, noteId });

	// @ts-expect-error compile error
	await notes.get({ userId: noteId, noteId: userId });
	// @ts-expect-error compile error: plain strings have no brand
	await notes.get({ userId: 'alice', noteId: 'n1' });

	// ── Values ──────────────────────────────────────────────────────────────────

	const counts = new KVStore<number>(scope, 'counts');
	await counts.put('visits', 42);

	await cache.put('greeting', 'hello');
	await users.put('u1', { name: 'Ada', email: 'ada@example.com' });
	await todos.put({ userId: 'alice', todoId: '001' }, { title: 'Write the README', done: false, version: 1 });

	const todo = await todos.get({ userId: 'alice', todoId: '001' });
	void todo;

	// ── Expiry ──────────────────────────────────────────────────────────────────

	// Relative. The item expires 5 minutes from now.
	await cache.put('otp:alice', '123456', { ttlSeconds: 300 });

	// Absolute. A Date, or Unix epoch time in seconds.
	await cache.put('banner', 'Sale ends soon', { expiresAt: new Date('2027-01-01') });

	// No expiry. The item stays until you delete it.
	await cache.put('config:theme', 'dark');

	const sessions = new KVStore(scope, 'sessions', {
		schema: z.object({ sessionId: z.string(), userId: z.string(), expiresAt: z.number() }),
		key: { partitionKey: 'sessionId' },
		ttl: 'expiresAt',
	});
	await sessions.put({ sessionId: 's1' }, { userId: 'alice', expiresAt: Math.floor(Date.now() / 1000) + 3600 });

	// ── Conditional writes ──────────────────────────────────────────────────────

	// Create only. Fails if the key exists.
	await cache.put('lock:report', 'worker-1', { ifNotExists: true, ttlSeconds: 60 });

	// Compare a value that is not an object.
	await cache.put('lock:report', 'worker-2', { ifValueEquals: 'worker-1' });

	// Compare fields of an object value. This is optimistic locking with a version field.
	const current = await todos.get({ userId: 'alice', todoId: '001' });
	if (current) {
		await todos.put(
			{ userId: 'alice', todoId: '001' },
			{ ...current, done: true, version: current.version + 1 },
			{ ifFieldEquals: { version: current.version } },
		);
	}

	// Create it, or replace it only if it is unchanged.
	await cache.put('config:theme', 'light', { ifNotExists: true, ifValueEquals: 'dark' });

	// Delete only if the value still matches.
	await cache.delete('lock:report', { ifValueEquals: 'worker-2' });

	// ── Read consistency ────────────────────────────────────────────────────────

	await cache.get('greeting', { consistentRead: false });

	// ── Query ───────────────────────────────────────────────────────────────────

	for await (const { key, value } of todos.query({
		where: { userId: { equals: 'alice' }, todoId: { beginsWith: '2026-' } },
		order: 'desc',
		limit: 10,
	})) {
		console.log(key.todoId, value.title);
	}

	const matches = await Array.fromAsync(
		users.query({ index: 'byEmail', where: { email: { equals: 'ada@example.com' } } }),
	);
	void matches;

	const readings = new KVStore(scope, 'readings', {
		schema: z.object({ deviceId: z.string(), at: z.number(), celsius: z.number() }),
		key: { partitionKey: 'deviceId', sortKey: 'at' },
	});
	const lastHour = readings.query({
		where: { deviceId: { equals: 'd1' }, at: { greaterThan: Date.now() - 3_600_000 } },
	});
	void lastHour;

	// ── Pages ───────────────────────────────────────────────────────────────────

	const todoApi = new ApiNamespace(scope, 'todo-api', (context) => ({
		async listTodos(cursor?: string) {
			const user = await auth.requireAuth(context);
			// The partition comes from the signed-in user, never from the request.
			const page = todos.query({ where: { userId: { equals: user.userId } }, limit: 20, cursor });
			const entries = await Array.fromAsync(page);
			return { todos: entries.map((entry) => entry.value), cursor: page.cursor };
		},
		async addTodo(title: string) {
			const user = await auth.requireAuth(context);
			const todoId = crypto.randomUUID();
			await todos.put({ userId: user.userId, todoId }, { title, done: false, version: 1 }, { ifNotExists: true });
			return { todoId };
		},
	}));
	void todoApi;

	// ── Batch calls ─────────────────────────────────────────────────────────────

	const [first, second] = await todos.getBatch([
		{ userId: 'alice', todoId: '001' },
		{ userId: 'alice', todoId: '002' },
	]);
	void first;
	void second;

	await todos.putBatch([
		{ key: { userId: 'alice', todoId: '003' }, value: { title: 'Ship', done: false, version: 1 } },
	]);

	await todos.deleteBatch([{ userId: 'alice', todoId: '003' }]);

	// ── Errors ──────────────────────────────────────────────────────────────────

	try {
		await cache.put('lock:report', 'worker-3', { ifNotExists: true });
	} catch (e: unknown) {
		if (isBlocksError(e, KVStoreErrors.ConditionalCheckFailed)) {
			// another worker holds the lock
		} else {
			throw e;
		}
	}

	// ── Use a table that exists ─────────────────────────────────────────────────

	const legacyOrders = new KVStore(scope, 'legacy-orders', {
		schema: z.object({ customerId: z.string(), orderId: z.string(), total: z.number() }),
		key: { partitionKey: 'customerId', sortKey: 'orderId' },
		table: KVStore.fromExisting('my-existing-table'),
	});
	void legacyOrders;

	// ── Rewrite a store of strings as objects ───────────────────────────────────

	const memberSchema = z.object({ name: z.string(), email: z.string() });
	type Member = z.infer<typeof memberSchema>;

	// Step 1. While the move runs, the store holds both shapes.
	const members = new KVStore<string | Member>(scope, 'members');

	// Step 2. In a job handler, write each string back as an object, with its expiry.
	for await (const { key, value, expiresAt } of members.scan()) {
		if (typeof value !== 'string') continue;
		try {
			await members.put(key, memberSchema.parse(JSON.parse(value)), { ifValueEquals: value, expiresAt });
		} catch (e: unknown) {
			// Another writer changed the item. The next run picks it up.
			if (!isBlocksError(e, KVStoreErrors.ConditionalCheckFailed)) throw e;
		}
	}

	// Step 3. When no strings remain, add the schema, and then the index:
	const membersWithIndex = new KVStore(scope, 'members', {
		schema: memberSchema,
		indexes: { byEmail: { partitionKey: 'email' } },
	});
	void membersWithIndex;

	// ── Copy a store to a new key ───────────────────────────────────────────────

	const todosById = new KVStore(scope, 'todos-by-id', {
		schema: z.object({
			userId: z.string(),
			todoId: z.string(),
			title: z.string(),
			done: z.boolean(),
			version: z.number(),
		}),
		key: { partitionKey: 'todoId' },
	});

	for await (const { value, expiresAt } of todos.scan()) {
		await todosById.put({ todoId: value.todoId }, value, { expiresAt });
	}

	// ── Durability and security defaults ────────────────────────────────────────

	const sharedKey = KVStore.fromKmsKey('arn:aws:kms:us-east-1:111122223333:key/abcd-1234');
	const audit = new KVStore(scope, 'audit', {
		protection: 'locked',
		pointInTimeRecovery: { retentionDays: 7 },
		encryption: sharedKey,
	});
	void audit;
}

test('every README snippet compiles against the built types', () => {
	// The contract above is checked by the compiler; this test only records that the file built.
	assert.strictEqual(typeof _readme, 'function');
});
