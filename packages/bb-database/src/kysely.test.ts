// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Kysely through DatabaseDialect, against the local engine of an aurora cluster.
import assert from 'node:assert';
import { describe, test } from 'node:test';
import { isBlocksError } from '@aws-blocks/core';
import { type Generated, Kysely, sql as ksql } from 'kysely';
import { Database, DatabaseCluster, DatabaseErrors, sql } from './index.mock.js';
import { DatabaseDialect } from './kysely.js';
import { migrations } from './test-support/fixtures.js';
import { freshScope, installLocalTestHooks } from './test-support/lifecycle.js';

installLocalTestHooks({ mockDataPrefix: 'bbkysely' });

interface Schema {
	acct: { id: Generated<number>; email: string; balance: Generated<number> };
}

const DDL =
	'CREATE TABLE acct (id SERIAL PRIMARY KEY, email TEXT UNIQUE NOT NULL, balance INTEGER NOT NULL DEFAULT 0);';

function setup() {
	const scope = freshScope('bbkysely');
	const cluster = new DatabaseCluster(scope, 'main', { type: 'aurora' });
	const db = new Database(scope, 'bank', { cluster, migrationsPath: migrations({ '001.sql': DDL }) });
	const kysely = new Kysely<Schema>({ dialect: new DatabaseDialect(db) });
	return { db, kysely };
}

const balances = async (kysely: Kysely<Schema>) =>
	(await kysely.selectFrom('acct').select(['email', 'balance']).orderBy('id').execute()).map((r) => r.balance);

async function seed(kysely: Kysely<Schema>) {
	await kysely
		.insertInto('acct')
		.values([
			{ email: 'a@x', balance: 100 },
			{ email: 'b@x', balance: 0 },
		])
		.execute();
}

describe('Kysely through DatabaseDialect', () => {
	test('insert and select', async () => {
		const { db, kysely } = setup();
		const row = await kysely.insertInto('acct').values({ email: 'a@x' }).returningAll().executeTakeFirstOrThrow();
		assert.deepStrictEqual(row, { id: 1, email: 'a@x', balance: 0 });
		const plain = await kysely.insertInto('acct').values({ email: 'b@x' }).executeTakeFirst();
		assert.strictEqual(plain.numInsertedOrUpdatedRows, 1n, 'INSERT without RETURNING reports the affected count');
		const updated = await kysely.updateTable('acct').set({ balance: 5 }).executeTakeFirst();
		assert.strictEqual(updated.numUpdatedRows, 2n);
		const rows = await kysely.selectFrom('acct').select(['id', 'email']).orderBy('id').execute();
		assert.deepStrictEqual(rows, [
			{ id: 1, email: 'a@x' },
			{ id: 2, email: 'b@x' },
		]);
		const viaBlock = await db.queryOne<{ n: number }>(sql`SELECT count(*)::int AS n FROM acct`);
		assert.strictEqual(viaBlock?.n, 2, 'the block sees the same schema');
	});

	test('transaction commit', async () => {
		const { kysely } = setup();
		await seed(kysely);
		await kysely.transaction().execute(async (trx) => {
			await trx.updateTable('acct').set({ balance: 70 }).where('email', '=', 'a@x').execute();
			await trx.updateTable('acct').set({ balance: 30 }).where('email', '=', 'b@x').execute();
		});
		assert.deepStrictEqual(await balances(kysely), [70, 30]);
	});

	test('transaction rollback', async () => {
		const { db, kysely } = setup();
		await seed(kysely);
		await assert.rejects(
			kysely.transaction().execute(async (trx) => {
				await trx.updateTable('acct').set({ balance: 70 }).where('email', '=', 'a@x').execute();
				throw new Error('boom');
			}),
			/boom/,
		);
		assert.deepStrictEqual(await balances(kysely), [100, 0]);
		// The local cluster mutex was freed: a block-level statement runs.
		assert.strictEqual((await db.execute(sql`UPDATE acct SET balance = balance`)).rowCount, 2);
	});

	test('unique violation keeps the block error name', async () => {
		const { kysely } = setup();
		await seed(kysely);
		const isUnique = (e: unknown) => isBlocksError(e, DatabaseErrors.UniqueConstraintViolation);
		await assert.rejects(kysely.insertInto('acct').values({ email: 'a@x' }).execute(), isUnique);
		await assert.rejects(
			kysely.transaction().execute((trx) => trx.insertInto('acct').values({ email: 'a@x' }).execute()),
			isUnique,
		);
		assert.deepStrictEqual(await balances(kysely), [100, 0]);
	});

	test('an isolation level is applied, and a savepoint rolls back to itself', async () => {
		const { kysely } = setup();
		await seed(kysely);
		const iso = await kysely
			.transaction()
			.setIsolationLevel('serializable')
			.execute((trx) =>
				ksql<{ iso: string }>`select current_setting('transaction_isolation') as iso`.execute(trx),
			);
		assert.strictEqual(iso.rows[0]?.iso, 'serializable');

		const trx = await kysely.startTransaction().execute();
		await trx.updateTable('acct').set({ balance: 1 }).where('email', '=', 'a@x').execute();
		const sp = await trx.savepoint('sp').execute();
		await sp.updateTable('acct').set({ balance: 2 }).where('email', '=', 'b@x').execute();
		await sp.rollbackToSavepoint('sp').execute();
		await trx.commit().execute();
		assert.deepStrictEqual(await balances(kysely), [1, 0]);
	});

	test('a Kysely statement inside db.transaction() runs in that transaction', async () => {
		const { db, kysely } = setup();
		await seed(kysely);
		await assert.rejects(
			db.transaction(async (tx) => {
				await tx.execute(sql`UPDATE acct SET balance = 50 WHERE email = ${'a@x'}`);
				const seen = await kysely
					.selectFrom('acct')
					.select('balance')
					.where('email', '=', 'a@x')
					.executeTakeFirst();
				assert.strictEqual(seen?.balance, 50, 'Kysely reads the uncommitted write');
				await kysely.updateTable('acct').set({ balance: 50 }).where('email', '=', 'b@x').execute();
				throw new Error('undo');
			}),
		);
		assert.deepStrictEqual(await balances(kysely), [100, 0], 'the Kysely write rolled back with it');
	});

	test('affected rows come from the engine, not from the statement text', async () => {
		const { kysely } = setup();
		await seed(kysely);
		// A literal that reads like a keyword must not change what is counted.
		const literal = await ksql`update acct set email = 'returning@x' where email = 'b@x'`.execute(kysely);
		assert.strictEqual(literal.numAffectedRows, 1n);
		const returning = await ksql<{ id: number }>`update acct set balance = balance + 1 returning id`.execute(
			kysely,
		);
		assert.strictEqual(returning.numAffectedRows, 2n);
		assert.strictEqual(returning.rows.length, 2);
		const none = await kysely
			.updateTable('acct')
			.set({ balance: 9 })
			.where('email', '=', 'nobody')
			.executeTakeFirst();
		assert.strictEqual(none.numUpdatedRows, 0n);
		const select = await ksql`select 1 as one`.execute(kysely);
		assert.strictEqual(select.numAffectedRows, 0n, 'a query changes no rows');
	});

	test('a statement outside `trx` inside a Kysely transaction fails instead of waiting forever', async () => {
		const { db, kysely } = setup();
		await seed(kysely);
		const refused = (e: unknown) =>
			isBlocksError(e, DatabaseErrors.QueryFailed) && /a Kysely transaction was open/.test(String(e));
		await kysely.transaction().execute(async (trx) => {
			await trx.updateTable('acct').set({ balance: 70 }).where('email', '=', 'a@x').execute();
			await Promise.all([
				assert.rejects(db.query(sql`SELECT 1`), refused, 'a statement on the block'),
				assert.rejects(
					kysely.selectFrom('acct').selectAll().execute(),
					refused,
					'a statement on the root instance',
				),
			]);
		});
		assert.deepStrictEqual(
			await balances(kysely),
			[70, 0],
			'the transaction commits and the session is free again',
		);
	});

	test('streaming is refused', async () => {
		const { kysely } = setup();
		await assert.rejects(async () => {
			for await (const _row of kysely.selectFrom('acct').selectAll().stream()) {
				// Not reached.
			}
		}, /does not support streaming/);
	});

	test('a Kysely instance is created without an engine; the first statement needs one', async () => {
		// What an instance at module scope meets during CDK synth: a Database that has no engine.
		const noEngine = { cluster: { kind: 'aurora' as const, id: 'none' }, schemaName: 'none' };
		const kysely = new Kysely<Schema>({ dialect: new DatabaseDialect(noEngine) });
		await assert.rejects(kysely.selectFrom('acct').selectAll().execute(), /CDK synth build has no engine/);
	});
});
