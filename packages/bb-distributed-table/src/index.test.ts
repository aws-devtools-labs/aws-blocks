// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test, describe } from 'node:test';
import { strict as assert } from 'node:assert';
import { DistributedTable, DistributedTableErrors } from './index.mock.js';
import { Scope } from '@aws-blocks/core';
import { z } from 'zod';

// ── Schemas ─────────────────────────────────────────────────────────────────

const userSchema = z.object({
	userId: z.string(),
	email: z.string().email(),
	name: z.string(),
	createdAt: z.number(),
});

const fileSchema = z.object({
	userId: z.string(),
	path: z.string(),
	data: z.string(),
});

// ── Helpers ─────────────────────────────────────────────────────────────────

let scopeCounter = 0;
function testScope() {
	return new Scope(`dt-test-${++scopeCounter}-${Date.now()}`);
}

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
	const items: T[] = [];
	for await (const item of iter) items.push(item);
	return items;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('DistributedTable', () => {

	// ── CRUD ────────────────────────────────────────────────────────────────

	describe('CRUD', () => {
		test('put and get', async () => {
			const table = new DistributedTable(testScope(), 'users', {
				schema: userSchema,
				key: { partitionKey: 'userId', sortKey: 'createdAt' },
			});
			const user = { userId: 'user1', email: 'test@example.com', name: 'Test', createdAt: 1000 };
			await table.put(user);
			assert.deepEqual(await table.get({ userId: 'user1', createdAt: 1000 }), user);
		});

		test('get returns null for missing item', async () => {
			const table = new DistributedTable(testScope(), 'users', {
				schema: userSchema,
				key: { partitionKey: 'userId', sortKey: 'createdAt' },
			});
			assert.equal(await table.get({ userId: 'nope', createdAt: 0 }), null);
		});

		test('put overwrites existing item', async () => {
			const table = new DistributedTable(testScope(), 'users', {
				schema: userSchema,
				key: { partitionKey: 'userId', sortKey: 'createdAt' },
			});
			const user = { userId: 'user1', email: 'test@example.com', name: 'Original', createdAt: 1000 };
			await table.put(user);
			await table.put({ ...user, name: 'Updated' });
			assert.equal((await table.get({ userId: 'user1', createdAt: 1000 }))?.name, 'Updated');
		});

		test('delete removes item', async () => {
			const table = new DistributedTable(testScope(), 'users', {
				schema: userSchema,
				key: { partitionKey: 'userId', sortKey: 'createdAt' },
			});
			await table.put({ userId: 'user1', email: 'test@example.com', name: 'Test', createdAt: 1000 });
			await table.delete({ userId: 'user1', createdAt: 1000 });
			assert.equal(await table.get({ userId: 'user1', createdAt: 1000 }), null);
		});

		test('partition key only (no sort key)', async () => {
			const schema = z.object({ id: z.string(), value: z.string() });
			const table = new DistributedTable(testScope(), 'simple', {
				schema,
				key: { partitionKey: 'id' },
			});
			await table.put({ id: 'item1', value: 'test' });
			assert.equal((await table.get({ id: 'item1' }))?.value, 'test');
			await table.delete({ id: 'item1' });
			assert.equal(await table.get({ id: 'item1' }), null);
		});
	});

	// ── Conditional put ─────────────────────────────────────────────────────

	describe('conditional put', () => {
		test('ifNotExists succeeds on new item', async () => {
			const table = new DistributedTable(testScope(), 'users', {
				schema: userSchema,
				key: { partitionKey: 'userId', sortKey: 'createdAt' },
			});
			const user = { userId: 'user1', email: 'test@example.com', name: 'Test', createdAt: 1000 };
			await table.put(user, { ifNotExists: true });
			assert.deepEqual(await table.get({ userId: 'user1', createdAt: 1000 }), user);
		});

		test('ifNotExists fails on existing item', async () => {
			const table = new DistributedTable(testScope(), 'users', {
				schema: userSchema,
				key: { partitionKey: 'userId', sortKey: 'createdAt' },
			});
			const user = { userId: 'user1', email: 'test@example.com', name: 'Test', createdAt: 1000 };
			await table.put(user);
			await assert.rejects(
				() => table.put(user, { ifNotExists: true }),
				(err: any) => err.name === DistributedTableErrors.ConditionalCheckFailed,
			);
		});

		test('ifFieldEquals succeeds when field matches', async () => {
			const table = new DistributedTable(testScope(), 'users', {
				schema: userSchema,
				key: { partitionKey: 'userId', sortKey: 'createdAt' },
			});
			await table.put({ userId: 'u1', email: 'a@b.com', name: 'Test', createdAt: 1000 });
			await table.put({ userId: 'u1', email: 'a@b.com', name: 'Updated', createdAt: 1000 }, { ifFieldEquals: { name: 'Test' } });
			assert.equal((await table.get({ userId: 'u1', createdAt: 1000 }))?.name, 'Updated');
		});

		test('ifFieldEquals fails when field does not match', async () => {
			const table = new DistributedTable(testScope(), 'users', {
				schema: userSchema,
				key: { partitionKey: 'userId', sortKey: 'createdAt' },
			});
			await table.put({ userId: 'u1', email: 'a@b.com', name: 'Test', createdAt: 1000 });
			await assert.rejects(
				() => table.put({ userId: 'u1', email: 'a@b.com', name: 'Fail', createdAt: 1000 }, { ifFieldEquals: { name: 'Wrong' } }),
				(err: any) => err.name === DistributedTableErrors.ConditionalCheckFailed,
			);
		});
	});

	// ── Conditional delete ──────────────────────────────────────────────────

	describe('conditional delete', () => {
		test('ifExists succeeds when item exists', async () => {
			const table = new DistributedTable(testScope(), 'users', {
				schema: userSchema,
				key: { partitionKey: 'userId', sortKey: 'createdAt' },
			});
			await table.put({ userId: 'u1', email: 'a@b.com', name: 'Test', createdAt: 1000 });
			await table.delete({ userId: 'u1', createdAt: 1000 }, { ifExists: true });
			assert.equal(await table.get({ userId: 'u1', createdAt: 1000 }), null);
		});

		test('ifExists fails when item does not exist', async () => {
			const table = new DistributedTable(testScope(), 'users', {
				schema: userSchema,
				key: { partitionKey: 'userId', sortKey: 'createdAt' },
			});
			await assert.rejects(
				() => table.delete({ userId: 'u1', createdAt: 1000 }, { ifExists: true }),
				(err: any) => err.name === DistributedTableErrors.ConditionalCheckFailed,
			);
		});

		test('ifFieldEquals succeeds when field matches', async () => {
			const table = new DistributedTable(testScope(), 'users', {
				schema: userSchema,
				key: { partitionKey: 'userId', sortKey: 'createdAt' },
			});
			await table.put({ userId: 'u1', email: 'a@b.com', name: 'Test', createdAt: 1000 });
			await table.delete({ userId: 'u1', createdAt: 1000 }, { ifFieldEquals: { name: 'Test' } });
			assert.equal(await table.get({ userId: 'u1', createdAt: 1000 }), null);
		});

		test('ifFieldEquals fails when field does not match', async () => {
			const table = new DistributedTable(testScope(), 'users', {
				schema: userSchema,
				key: { partitionKey: 'userId', sortKey: 'createdAt' },
			});
			await table.put({ userId: 'u1', email: 'a@b.com', name: 'Test', createdAt: 1000 });
			await assert.rejects(
				() => table.delete({ userId: 'u1', createdAt: 1000 }, { ifFieldEquals: { name: 'Wrong' } }),
				(err: any) => err.name === DistributedTableErrors.ConditionalCheckFailed,
			);
		});
	});

	// ── Schema validation ───────────────────────────────────────────────────

	describe('schema validation', () => {
		test('rejects invalid item on put', async () => {
			const table = new DistributedTable(testScope(), 'users', {
				schema: userSchema,
				key: { partitionKey: 'userId', sortKey: 'createdAt' },
			});
			await assert.rejects(
				() => table.put({ userId: 'u1', email: 'invalid-email', name: 'Test', createdAt: 1000 } as any),
				(err: any) => err.name === 'ValidationFailedException',
			);
		});

		test('rejects invalid item on putBatch', async () => {
			const table = new DistributedTable(testScope(), 'users', {
				schema: userSchema,
				key: { partitionKey: 'userId', sortKey: 'createdAt' },
			});
			await assert.rejects(
				() => table.putBatch([
					{ userId: 'u1', email: 'ok@example.com', name: 'Good', createdAt: 1000 },
					{ userId: 'u2', email: 'bad-email', name: 'Bad', createdAt: 2000 } as any,
				]),
				(err: any) => err.name === 'ValidationFailedException',
			);
		});
	});

	// ── readValidation (off | coerce | strict) ────────────────────────────────
	// Regression for the bug bash finding #1007: get() returned raw stored values
	// without reconciling them against the schema, so after a schema change a legacy
	// row no longer conformed to T — an added field was absent (a schema .default()
	// was neither applied nor persisted on write-back) and a required-no-default
	// field made the put() half of the read-modify-write cycle throw ValidationFailed.
	// `readValidation` defaults to 'coerce', which closes the coercible gap.

	describe('readValidation', () => {
		// V1: no `currency`. V2: adds `currency` with a default.
		const orderV1 = z.object({ orderId: z.string(), total: z.number() });
		const orderV2 = z.object({
			orderId: z.string(),
			total: z.number(),
			currency: z.string().default('USD'),
		});

		// Fixed scope so a V1 writer and a V2 reader share the same on-disk table,
		// simulating a schema augmentation over pre-existing (legacy) rows.
		function legacyScope() {
			return new Scope(`dt-legacy-${++scopeCounter}-${Date.now()}`);
		}

		test("default is 'coerce': get() coerces the legacy row through the current schema (fills default)", async () => {
			const scope = legacyScope();
			const v1 = new DistributedTable(scope, 'orders', { schema: orderV1, key: { partitionKey: 'orderId' } });
			await v1.put({ orderId: 'o1', total: 10 });

			// No readValidation option → defaults to 'coerce'.
			const v2 = new DistributedTable(scope, 'orders', { schema: orderV2, key: { partitionKey: 'orderId' } });
			const row = await v2.get({ orderId: 'o1' });
			assert.deepEqual(row, { orderId: 'o1', total: 10, currency: 'USD' });
		});

		test("default 'coerce': coerced read can be written back (fixes the read-modify-write cycle)", async () => {
			const scope = legacyScope();
			const v1 = new DistributedTable(scope, 'orders', { schema: orderV1, key: { partitionKey: 'orderId' } });
			await v1.put({ orderId: 'o1', total: 10 });

			const v2 = new DistributedTable(scope, 'orders', { schema: orderV2, key: { partitionKey: 'orderId' } });
			const row = await v2.get({ orderId: 'o1' });
			assert.ok(row);
			await v2.put({ ...row, total: 20 }); // must NOT throw ValidationFailed
			assert.deepEqual(await v2.get({ orderId: 'o1' }), { orderId: 'o1', total: 20, currency: 'USD' });
		});

		test("'off': get() returns the raw legacy row unchanged (opt-out of coercion)", async () => {
			const scope = legacyScope();
			const v1 = new DistributedTable(scope, 'orders', { schema: orderV1, key: { partitionKey: 'orderId' } });
			await v1.put({ orderId: 'o1', total: 10 });

			const v2 = new DistributedTable(scope, 'orders', {
				schema: orderV2, key: { partitionKey: 'orderId' }, readValidation: 'off',
			});
			const row = await v2.get({ orderId: 'o1' });
			assert.deepEqual(row, { orderId: 'o1', total: 10 }); // no currency injected
		});

		test("'coerce': an unrecoverable row is returned RAW (never throws) so it stays readable", async () => {
			const scope = legacyScope();
			// Write a row that violates the strict schema (total is a string, no coercion path).
			const loose = z.object({ orderId: z.string(), total: z.any() });
			const strict = z.object({ orderId: z.string(), total: z.number() });
			const w = new DistributedTable(scope, 'orders', { schema: loose, key: { partitionKey: 'orderId' } });
			await w.put({ orderId: 'bad', total: 'not-a-number' });

			const r = new DistributedTable(scope, 'orders', {
				schema: strict, key: { partitionKey: 'orderId' }, readValidation: 'coerce',
			});
			const row = await r.get({ orderId: 'bad' }); // must NOT throw
			assert.deepEqual(row, { orderId: 'bad', total: 'not-a-number' }); // raw fallback
		});

		test("'coerce' PRESERVES stored keys not in the schema (no silent data loss)", async () => {
			const scope = legacyScope();
			// Row stored under a schema that had an extra `legacyNote` field.
			const wide = z.object({ orderId: z.string(), total: z.number(), legacyNote: z.string() });
			const narrow = z.object({ orderId: z.string(), total: z.number() }); // current schema no longer declares legacyNote
			const w = new DistributedTable(scope, 'orders', { schema: wide, key: { partitionKey: 'orderId' } });
			await w.put({ orderId: 'o1', total: 10, legacyNote: 'keep me' });

			// coerce (default): unknown key is preserved (coerced output merged over the raw item).
			const coerceReader = new DistributedTable(scope, 'orders', { schema: narrow, key: { partitionKey: 'orderId' } });
			assert.deepEqual(await coerceReader.get({ orderId: 'o1' }), { orderId: 'o1', total: 10, legacyNote: 'keep me' });

			// off also preserves (raw passthrough) — same observable result here.
			const offReader = new DistributedTable(scope, 'orders', {
				schema: narrow, key: { partitionKey: 'orderId' }, readValidation: 'off',
			});
			assert.deepEqual(await offReader.get({ orderId: 'o1' }), { orderId: 'o1', total: 10, legacyNote: 'keep me' });
		});

		test("'coerce' read-modify-write does NOT drop an unknown stored key (the reviewer's scenario)", async () => {
			const scope = legacyScope();
			const wide = z.object({ orderId: z.string(), total: z.number(), couponCode: z.string() });
			const narrow = z.object({ orderId: z.string(), total: z.number() }); // couponCode no longer in schema
			const seed = new DistributedTable(scope, 'orders', { schema: wide, key: { partitionKey: 'orderId' } });
			await seed.put({ orderId: 'A1', total: 10, couponCode: 'SAVE10' });

			// Read, change an unrelated field, write back — couponCode must survive.
			const t = new DistributedTable(scope, 'orders', { schema: narrow, key: { partitionKey: 'orderId' } });
			const row = await t.get({ orderId: 'A1' });
			assert.ok(row);
			await t.put({ ...row, total: 50 });
			const after = await t.get({ orderId: 'A1' });
			assert.deepEqual(after, { orderId: 'A1', total: 50, couponCode: 'SAVE10' });
		});

		test("'coerce' adds a new default AND preserves an unknown key at the same time", async () => {
			const scope = legacyScope();
			const v1 = new DistributedTable(scope, 'orders', {
				schema: z.object({ orderId: z.string(), total: z.number(), couponCode: z.string() }),
				key: { partitionKey: 'orderId' },
			});
			await v1.put({ orderId: 'o1', total: 10, couponCode: 'X' });

			// V2 adds currency (default) and no longer declares couponCode.
			const v2 = new DistributedTable(scope, 'orders', {
				schema: z.object({ orderId: z.string(), total: z.number(), currency: z.string().default('USD') }),
				key: { partitionKey: 'orderId' },
			});
			assert.deepEqual(await v2.get({ orderId: 'o1' }), { orderId: 'o1', total: 10, currency: 'USD', couponCode: 'X' });
		});

		test("'coerce' preserves unknown keys nested inside a known object (deep)", async () => {
			const scope = legacyScope();
			const wide = z.object({ orderId: z.string(), meta: z.object({ a: z.number(), legacy: z.boolean() }) });
			const narrow = z.object({ orderId: z.string(), meta: z.object({ a: z.number() }) }); // dropped meta.legacy
			const w = new DistributedTable(scope, 'orders', { schema: wide, key: { partitionKey: 'orderId' } });
			await w.put({ orderId: 'o1', meta: { a: 1, legacy: true } });

			const t = new DistributedTable(scope, 'orders', { schema: narrow, key: { partitionKey: 'orderId' } });
			assert.deepEqual(await t.get({ orderId: 'o1' }), { orderId: 'o1', meta: { a: 1, legacy: true } });
		});

		test("'coerce' replaces arrays wholesale — never duplicates elements", async () => {
			const scope = legacyScope();
			const schema = z.object({ orderId: z.string(), tags: z.array(z.string()) });
			const w = new DistributedTable(scope, 'orders', { schema, key: { partitionKey: 'orderId' } });
			await w.put({ orderId: 'o1', tags: ['a', 'b'] });

			// Same schema on read: coerced tags === raw tags; merge must NOT concat them.
			const t = new DistributedTable(scope, 'orders', { schema, key: { partitionKey: 'orderId' } });
			assert.deepEqual(await t.get({ orderId: 'o1' }), { orderId: 'o1', tags: ['a', 'b'] });
		});

		test("'strict': get() throws ValidationFailed on a non-conforming stored row", async () => {
			const scope = legacyScope();
			const loose = z.object({ orderId: z.string(), total: z.any() });
			const strict = z.object({ orderId: z.string(), total: z.number() });
			const w = new DistributedTable(scope, 'orders', { schema: loose, key: { partitionKey: 'orderId' } });
			await w.put({ orderId: 'bad', total: 'not-a-number' });

			const r = new DistributedTable(scope, 'orders', {
				schema: strict, key: { partitionKey: 'orderId' }, readValidation: 'strict',
			});
			await assert.rejects(
				() => r.get({ orderId: 'bad' }),
				(err: any) => err.name === 'ValidationFailedException',
			);
		});

		test("'strict': a conforming row reads back fine", async () => {
			const scope = legacyScope();
			const v1 = new DistributedTable(scope, 'orders', { schema: orderV1, key: { partitionKey: 'orderId' } });
			await v1.put({ orderId: 'o1', total: 10 });
			const r = new DistributedTable(scope, 'orders', {
				schema: orderV1, key: { partitionKey: 'orderId' }, readValidation: 'strict',
			});
			assert.deepEqual(await r.get({ orderId: 'o1' }), { orderId: 'o1', total: 10 });
		});

		test('get() still returns null for a missing item (all modes)', async () => {
			for (const readValidation of ['off', 'coerce', 'strict'] as const) {
				const table = new DistributedTable(testScope(), 'orders', {
					schema: orderV2, key: { partitionKey: 'orderId' }, readValidation,
				});
				assert.equal(await table.get({ orderId: 'nope' }), null);
			}
		});

		test("default 'coerce': scan() and query() coerce yielded items", async () => {
			const scope = legacyScope();
			const v1 = new DistributedTable(scope, 'orders', { schema: orderV1, key: { partitionKey: 'orderId' } });
			await v1.put({ orderId: 'o1', total: 10 });
			await v1.put({ orderId: 'o2', total: 20 });

			const v2 = new DistributedTable(scope, 'orders', { schema: orderV2, key: { partitionKey: 'orderId' } });
			const scanned = await collect(v2.scan());
			assert.ok(scanned.every(o => o.currency === 'USD'));
			const queried = await collect(v2.query({ where: { orderId: { equals: 'o1' } } }));
			assert.deepEqual(queried, [{ orderId: 'o1', total: 10, currency: 'USD' }]);
		});

		test("default 'coerce': getBatch() coerces each hit and preserves null holes", async () => {
			const scope = legacyScope();
			const v1 = new DistributedTable(scope, 'orders', { schema: orderV1, key: { partitionKey: 'orderId' } });
			await v1.put({ orderId: 'o1', total: 10 });

			const v2 = new DistributedTable(scope, 'orders', { schema: orderV2, key: { partitionKey: 'orderId' } });
			const rows = await v2.getBatch([{ orderId: 'o1' }, { orderId: 'missing' }]);
			assert.deepEqual(rows, [{ orderId: 'o1', total: 10, currency: 'USD' }, null]);
		});
	});

	// ── Query: numeric sort key ─────────────────────────────────────────────

	describe('query (numeric sort key)', () => {
		function numTable() {
			const table = new DistributedTable(testScope(), 'users', {
				schema: userSchema,
				key: { partitionKey: 'userId', sortKey: 'createdAt' },
				indexes: { byUser: { partitionKey: 'userId', sortKey: 'createdAt' } },
			});
			return table;
		}

		async function seedNumeric(table: ReturnType<typeof numTable>) {
			await table.put({ userId: 'u1', email: 'a@b.com', name: 'A', createdAt: 1000 });
			await table.put({ userId: 'u1', email: 'b@b.com', name: 'B', createdAt: 2000 });
			await table.put({ userId: 'u1', email: 'c@b.com', name: 'C', createdAt: 3000 });
			await table.put({ userId: 'u1', email: 'd@b.com', name: 'D', createdAt: 4000 });
			await table.put({ userId: 'u1', email: 'e@b.com', name: 'E', createdAt: 5000 });
		}

		test('no filter — returns all items sorted', async () => {
			const table = numTable();
			await seedNumeric(table);
			const items = await collect(table.query({ index: 'byUser', where: { userId: { equals: 'u1' } } }));
			assert.equal(items.length, 5);
			assert.deepEqual(items.map(i => i.createdAt), [1000, 2000, 3000, 4000, 5000]);
		});

		test('equals', async () => {
			const table = numTable();
			await seedNumeric(table);
			const items = await collect(table.query({ index: 'byUser', where: { userId: { equals: 'u1' }, createdAt: { equals: 3000 } } }));
			assert.equal(items.length, 1);
			assert.equal(items[0].name, 'C');
		});

		test('greaterThan', async () => {
			const table = numTable();
			await seedNumeric(table);
			const items = await collect(table.query({ index: 'byUser', where: { userId: { equals: 'u1' }, createdAt: { greaterThan: 3000 } } }));
			assert.equal(items.length, 2);
			assert.deepEqual(items.map(i => i.createdAt), [4000, 5000]);
		});

		test('greaterThanOrEqual', async () => {
			const table = numTable();
			await seedNumeric(table);
			const items = await collect(table.query({ index: 'byUser', where: { userId: { equals: 'u1' }, createdAt: { greaterThanOrEqual: 3000 } } }));
			assert.equal(items.length, 3);
			assert.deepEqual(items.map(i => i.createdAt), [3000, 4000, 5000]);
		});

		test('lessThan', async () => {
			const table = numTable();
			await seedNumeric(table);
			const items = await collect(table.query({ index: 'byUser', where: { userId: { equals: 'u1' }, createdAt: { lessThan: 3000 } } }));
			assert.equal(items.length, 2);
			assert.deepEqual(items.map(i => i.createdAt), [1000, 2000]);
		});

		test('lessThanOrEqual', async () => {
			const table = numTable();
			await seedNumeric(table);
			const items = await collect(table.query({ index: 'byUser', where: { userId: { equals: 'u1' }, createdAt: { lessThanOrEqual: 3000 } } }));
			assert.equal(items.length, 3);
			assert.deepEqual(items.map(i => i.createdAt), [1000, 2000, 3000]);
		});

		test('between (inclusive)', async () => {
			const table = numTable();
			await seedNumeric(table);
			const items = await collect(table.query({ index: 'byUser', where: { userId: { equals: 'u1' }, createdAt: { between: [2000, 4000] } } }));
			assert.equal(items.length, 3);
			assert.deepEqual(items.map(i => i.createdAt), [2000, 3000, 4000]);
		});

		test('between — single match', async () => {
			const table = numTable();
			await seedNumeric(table);
			const items = await collect(table.query({ index: 'byUser', where: { userId: { equals: 'u1' }, createdAt: { between: [2500, 3500] } } }));
			assert.equal(items.length, 1);
			assert.equal(items[0].createdAt, 3000);
		});

		test('between — no match', async () => {
			const table = numTable();
			await seedNumeric(table);
			const items = await collect(table.query({ index: 'byUser', where: { userId: { equals: 'u1' }, createdAt: { between: [5500, 6000] } } }));
			assert.equal(items.length, 0);
		});

		test('limit', async () => {
			const table = numTable();
			await seedNumeric(table);
			const items = await collect(table.query({ index: 'byUser', where: { userId: { equals: 'u1' } }, limit: 2 }));
			assert.equal(items.length, 2);
			assert.deepEqual(items.map(i => i.createdAt), [1000, 2000]);
		});

		test('filter + limit combined', async () => {
			const table = numTable();
			await seedNumeric(table);
			const items = await collect(table.query({ index: 'byUser', where: { userId: { equals: 'u1' }, createdAt: { greaterThan: 1000 } }, limit: 2 }));
			assert.equal(items.length, 2);
			assert.deepEqual(items.map(i => i.createdAt), [2000, 3000]);
		});

		test('partition isolation — different pk returns nothing', async () => {
			const table = numTable();
			await seedNumeric(table);
			const items = await collect(table.query({ index: 'byUser', where: { userId: { equals: 'other' } } }));
			assert.equal(items.length, 0);
		});

		test('nonexistent index throws', async () => {
			const table = numTable();
			await assert.rejects(
				// @ts-expect-error — 'nonexistent' is not a defined index name
				async () => { for await (const _ of table.query({ index: 'nonexistent', where: { userId: { equals: 'u1' } } })) {} },
				/Index 'nonexistent' not found/,
			);
		});

	});

	// ── Query: string sort key ──────────────────────────────────────────────

	describe('query (string sort key)', () => {
		function strTable() {
			return new DistributedTable(testScope(), 'files', {
				schema: fileSchema,
				key: { partitionKey: 'userId', sortKey: 'path' },
				indexes: { byUser: { partitionKey: 'userId', sortKey: 'path' } },
			});
		}

		async function seedStrings(table: ReturnType<typeof strTable>) {
			await table.put({ userId: 'u1', path: '/docs/a.txt', data: 'a' });
			await table.put({ userId: 'u1', path: '/docs/b.txt', data: 'b' });
			await table.put({ userId: 'u1', path: '/images/cat.jpg', data: 'c' });
			await table.put({ userId: 'u1', path: '/images/dog.jpg', data: 'd' });
			await table.put({ userId: 'u1', path: '/videos/clip.mp4', data: 'e' });
		}

		test('no filter — returns all sorted lexicographically', async () => {
			const table = strTable();
			await seedStrings(table);
			const items = await collect(table.query({ index: 'byUser', where: { userId: { equals: 'u1' } } }));
			assert.equal(items.length, 5);
			// Lexicographic: /docs/a < /docs/b < /images/cat < /images/dog < /videos/clip
			assert.deepEqual(items.map(i => i.path), [
				'/docs/a.txt', '/docs/b.txt', '/images/cat.jpg', '/images/dog.jpg', '/videos/clip.mp4',
			]);
		});

		test('equals', async () => {
			const table = strTable();
			await seedStrings(table);
			const items = await collect(table.query({ index: 'byUser', where: { userId: { equals: 'u1' }, path: { equals: '/docs/a.txt' } } }));
			assert.equal(items.length, 1);
			assert.equal(items[0].data, 'a');
		});

		test('beginsWith', async () => {
			const table = strTable();
			await seedStrings(table);
			const items = await collect(table.query({ index: 'byUser', where: { userId: { equals: 'u1' }, path: { beginsWith: '/docs/' } } }));
			assert.equal(items.length, 2);
			assert.ok(items.every(i => i.path.startsWith('/docs/')));
		});

		test('beginsWith — no match', async () => {
			const table = strTable();
			await seedStrings(table);
			const items = await collect(table.query({ index: 'byUser', where: { userId: { equals: 'u1' }, path: { beginsWith: '/music/' } } }));
			assert.equal(items.length, 0);
		});

		test('greaterThan (lexicographic)', async () => {
			const table = strTable();
			await seedStrings(table);
			const items = await collect(table.query({ index: 'byUser', where: { userId: { equals: 'u1' }, path: { greaterThan: '/images/' } } }));
			assert.equal(items.length, 3);
		});

		test('lessThan (lexicographic)', async () => {
			const table = strTable();
			await seedStrings(table);
			const items = await collect(table.query({ index: 'byUser', where: { userId: { equals: 'u1' }, path: { lessThan: '/images/' } } }));
			assert.equal(items.length, 2);
		});

		test('between (lexicographic, inclusive)', async () => {
			const table = strTable();
			await seedStrings(table);
			const items = await collect(table.query({ index: 'byUser', where: { userId: { equals: 'u1' }, path: { between: ['/docs/', '/images/d'] } } }));
			assert.equal(items.length, 3);
		});

		test('limit', async () => {
			const table = strTable();
			await seedStrings(table);
			const items = await collect(table.query({ index: 'byUser', where: { userId: { equals: 'u1' } }, limit: 3 }));
			assert.equal(items.length, 3);
		});

		test('beginsWith + limit combined', async () => {
			const table = strTable();
			await seedStrings(table);
			const items = await collect(table.query({ index: 'byUser', where: { userId: { equals: 'u1' }, path: { beginsWith: '/images/' } }, limit: 1 }));
			assert.equal(items.length, 1);
			assert.ok(items[0].path.startsWith('/images/'));
		});
	});

	// ── Primary key query ───────────────────────────────────────────────────

	describe('query (primary key)', () => {
		function pkTable() {
			return new DistributedTable(testScope(), 'pk-query', {
				schema: fileSchema,
				key: { partitionKey: 'userId', sortKey: 'path' } as const,
			});
		}

		async function seed(table: ReturnType<typeof pkTable>) {
			await table.put({ userId: 'u1', path: '/docs/a.txt', data: 'a' });
			await table.put({ userId: 'u1', path: '/docs/b.txt', data: 'b' });
			await table.put({ userId: 'u1', path: '/images/c.png', data: 'c' });
			await table.put({ userId: 'u2', path: '/docs/d.txt', data: 'd' });
		}

		test('returns all items for a partition key', async () => {
			const table = pkTable();
			await seed(table);
			const items = await collect(table.query({ where: { userId: { equals: 'u1' } } }));
			assert.equal(items.length, 3);
			for (const item of items) assert.equal(item.userId, 'u1');
		});

		test('supports sort key conditions', async () => {
			const table = pkTable();
			await seed(table);
			const items = await collect(table.query({ where: { userId: { equals: 'u1' }, path: { beginsWith: '/docs/' } } }));
			assert.equal(items.length, 2);
			for (const item of items) assert.ok(item.path.startsWith('/docs/'));
		});

		test('returns empty for non-existent partition key', async () => {
			const table = pkTable();
			await seed(table);
			const items = await collect(table.query({ where: { userId: { equals: 'nobody' } } }));
			assert.equal(items.length, 0);
		});

		test('order desc reverses sort key order', async () => {
			const table = pkTable();
			await seed(table);
			const items = await collect(table.query({ where: { userId: { equals: 'u1' } }, order: 'desc' }));
			assert.equal(items.length, 3);
			assert.ok(items[0].path > items[1].path);
		});
	});

	// ── Scan ────────────────────────────────────────────────────────────────

	describe('scan', () => {
		test('returns all items', async () => {
			const table = new DistributedTable(testScope(), 'users', {
				schema: userSchema,
				key: { partitionKey: 'userId', sortKey: 'createdAt' },
			});
			await table.put({ userId: 'u1', email: 'a@b.com', name: 'A', createdAt: 1000 });
			await table.put({ userId: 'u2', email: 'b@b.com', name: 'B', createdAt: 2000 });
			await table.put({ userId: 'u3', email: 'c@b.com', name: 'C', createdAt: 3000 });
			assert.equal((await collect(table.scan())).length, 3);
		});

		test('respects limit', async () => {
			const table = new DistributedTable(testScope(), 'users', {
				schema: userSchema,
				key: { partitionKey: 'userId', sortKey: 'createdAt' },
			});
			await table.put({ userId: 'u1', email: 'a@b.com', name: 'A', createdAt: 1000 });
			await table.put({ userId: 'u2', email: 'b@b.com', name: 'B', createdAt: 2000 });
			await table.put({ userId: 'u3', email: 'c@b.com', name: 'C', createdAt: 3000 });
			assert.equal((await collect(table.scan({ limit: 2 }))).length, 2);
		});

		test('empty table returns nothing', async () => {
			const table = new DistributedTable(testScope(), 'users', {
				schema: userSchema,
				key: { partitionKey: 'userId', sortKey: 'createdAt' },
			});
			assert.equal((await collect(table.scan())).length, 0);
		});
	});

	// ── Batch operations ────────────────────────────────────────────────────

	describe('batch operations', () => {
		test('putBatch and getBatch', async () => {
			const table = new DistributedTable(testScope(), 'users', {
				schema: userSchema,
				key: { partitionKey: 'userId', sortKey: 'createdAt' },
			});
			const items = [
				{ userId: 'u1', email: 'a@b.com', name: 'A', createdAt: 1000 },
				{ userId: 'u2', email: 'b@b.com', name: 'B', createdAt: 2000 },
				{ userId: 'u3', email: 'c@b.com', name: 'C', createdAt: 3000 },
			];
			await table.putBatch(items);
			const results = await table.getBatch([
				{ userId: 'u1', createdAt: 1000 },
				{ userId: 'u2', createdAt: 2000 },
				{ userId: 'missing', createdAt: 9999 },
			]);
			assert.equal(results.length, 3);
			assert.deepEqual(results[0], items[0]);
			assert.deepEqual(results[1], items[1]);
			assert.equal(results[2], null);
		});

		test('deleteBatch', async () => {
			const table = new DistributedTable(testScope(), 'users', {
				schema: userSchema,
				key: { partitionKey: 'userId', sortKey: 'createdAt' },
			});
			await table.putBatch([
				{ userId: 'u1', email: 'a@b.com', name: 'A', createdAt: 1000 },
				{ userId: 'u2', email: 'b@b.com', name: 'B', createdAt: 2000 },
			]);
			await table.deleteBatch([
				{ userId: 'u1', createdAt: 1000 },
				{ userId: 'u2', createdAt: 2000 },
			]);
			assert.equal(await table.get({ userId: 'u1', createdAt: 1000 }), null);
			assert.equal(await table.get({ userId: 'u2', createdAt: 2000 }), null);
		});
	});

	// ── Error constants ─────────────────────────────────────────────────────

	describe('error constants', () => {
		test('DistributedTableErrors has expected values', () => {
			assert.equal(DistributedTableErrors.ConditionalCheckFailed, 'ConditionalCheckFailedException');
			assert.equal(DistributedTableErrors.ValidationFailed, 'ValidationFailedException');
		});
	});

	// ── TypeScript type safety ──────────────────────────────────────────────

	describe('type safety', () => {
		test('key config rejects non-existent field names', () => {
			new DistributedTable(testScope(), 'bad', {
				schema: userSchema,
				// @ts-expect-error — 'nonExistent' is not a field in the schema
				key: { partitionKey: 'nonExistent' },
			});
		});

		test('key config rejects non-existent sort key field', () => {
			new DistributedTable(testScope(), 'bad', {
				schema: userSchema,
				// @ts-expect-error — 'badField' is not a field in the schema
				key: { partitionKey: 'userId', sortKey: 'badField' },
			});
		});

		test('index config rejects non-existent field names', () => {
			new DistributedTable(testScope(), 'bad', {
				schema: userSchema,
				key: { partitionKey: 'userId' },
				// @ts-expect-error — 'fake' is not a field in the schema
				indexes: { byFake: { partitionKey: 'fake' } },
			});
		});

		test('put rejects items missing required fields', () => {
			const table = new DistributedTable(testScope(), 'users', {
				schema: userSchema,
				key: { partitionKey: 'userId', sortKey: 'createdAt' },
			});
			// @ts-expect-error — missing 'name' and 'createdAt'
			const _badItem: Parameters<typeof table.put>[0] = { userId: 'u1', email: 'a@b.com' };
		});

		test('ifFieldEquals rejects non-schema fields', () => {
			const table = new DistributedTable(testScope(), 'users', {
				schema: userSchema,
				key: { partitionKey: 'userId', sortKey: 'createdAt' },
			});
			// @ts-expect-error — 'nonField' is not in the schema
			const _badOpts: Parameters<typeof table.put>[1] = { ifFieldEquals: { nonField: 'value' } };
		});

		test('get rejects empty key object', () => {
			const table = new DistributedTable(testScope(), 'users', {
				schema: userSchema,
				key: { partitionKey: 'userId', sortKey: 'createdAt' },
			});
			// @ts-expect-error — empty object is missing required key fields
			const _badKey: Parameters<typeof table.get>[0] = {};
		});

		test('get rejects key missing sort key', () => {
			const table = new DistributedTable(testScope(), 'users', {
				schema: userSchema,
				key: { partitionKey: 'userId', sortKey: 'createdAt' },
			});
			// @ts-expect-error — missing 'createdAt' sort key
			const _badKey: Parameters<typeof table.get>[0] = { userId: 'u1' };
		});

		test('delete rejects empty key object', () => {
			const table = new DistributedTable(testScope(), 'users', {
				schema: userSchema,
				key: { partitionKey: 'userId', sortKey: 'createdAt' },
			});
			// @ts-expect-error — empty object is missing required key fields
			const _badKey: Parameters<typeof table.delete>[0] = {};
		});

		test('query rejects at runtime for nonexistent index', async () => {
			const table = new DistributedTable(testScope(), 'users', {
				schema: userSchema,
				key: { partitionKey: 'userId', sortKey: 'createdAt' },
			});
			await assert.rejects(
				// @ts-expect-error — table has no indexes, testing runtime rejection
				async () => { for await (const _ of table.query({ index: 'doesNotExist', where: { userId: { equals: 'u1' } } })) {} },
				/Index 'doesNotExist' not found/,
			);
		});
	});
});
