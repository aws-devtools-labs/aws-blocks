// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Local-mode behavior of `Database` / `DatabaseCluster`: owned and shared
 * clusters, schema isolation, the DSQL validation layer, conflict simulation
 * and retry, migrations through the rewriter, and the three construction-time
 * rules (unique ids, schema collisions, the binding marker).
 */
import assert from 'node:assert';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, afterEach, beforeEach, describe, test } from 'node:test';
import { ApiError, isBlocksError, Scope } from '@aws-blocks/core';
import { _closeAllPgliteClusters } from './engines/pglite-cluster.js';
import {
	_resetDatabaseRegistry,
	createKyselyAdapter,
	Database,
	DatabaseCluster,
	DatabaseErrors,
	sql,
} from './index.mock.js';

const DATA_DIR = join(process.cwd(), '.bb-data');
let counter = 0;
const app = () => new Scope(`bbdb-test-${process.pid}-${++counter}`);

beforeEach(() => {
	_resetDatabaseRegistry();
});

afterEach(async () => {
	await _closeAllPgliteClusters();
	rmSync(DATA_DIR, { recursive: true, force: true });
	rmSync(join(process.cwd(), 'aws-blocks'), { recursive: true, force: true });
});

after(async () => {
	await _closeAllPgliteClusters();
});

describe('Database (owned distributed cluster)', () => {
	test('query / queryOne / execute round-trip and queryOne returns null when absent', async () => {
		const db = new Database(app(), 'db');
		assert.deepStrictEqual(db.cluster, { kind: 'distributed', id: 'default' });
		assert.strictEqual(db.schemaName, 'public');
		// DDL at runtime is refused on a distributed cluster (parity with the deployed grant)…
		await assert.rejects(db.execute(sql`CREATE TABLE t (id TEXT PRIMARY KEY)`), /DDL statements .* not allowed/);
		// …so the schema comes from a migration.
		await withMigrations(db, { '001.sql': 'CREATE TABLE t (id TEXT PRIMARY KEY, n INTEGER NOT NULL DEFAULT 0);' });
		const { rowCount } = await db.execute(sql`INSERT INTO t (id, n) VALUES (${'a'}, ${1})`);
		assert.strictEqual(rowCount, 1);
		assert.deepStrictEqual(await db.queryOne<{ id: string; n: number }>(sql`SELECT * FROM t WHERE id = ${'a'}`), {
			id: 'a',
			n: 1,
		});
		assert.strictEqual(await db.queryOne(sql`SELECT * FROM t WHERE id = ${'zzz'}`), null);
		assert.strictEqual((await db.query(sql`SELECT * FROM t`)).length, 1);
	});

	test('duplicate key is a 409 UniqueConstraintViolation', async () => {
		const db = new Database(app(), 'db');
		await withMigrations(db, { '001.sql': 'CREATE TABLE t (id TEXT PRIMARY KEY);' });
		await db.execute(sql`INSERT INTO t VALUES (${'a'})`);
		await assert.rejects(db.execute(sql`INSERT INTO t VALUES (${'a'})`), (e: unknown) => {
			assert.ok(e instanceof ApiError);
			assert.strictEqual(e.status, 409);
			assert.ok(isBlocksError(e, DatabaseErrors.UniqueConstraintViolation));
			return true;
		});
	});

	test('transaction commits, rolls back on a thrown error, and re-tags unknown errors', async () => {
		const db = new Database(app(), 'db');
		await withMigrations(db, { '001.sql': 'CREATE TABLE acct (id TEXT PRIMARY KEY, balance INTEGER NOT NULL);' });
		await db.execute(sql`INSERT INTO acct VALUES (${'a'}, ${100}), (${'b'}, ${0})`);
		await db.transaction(async (tx) => {
			await tx.execute(sql`UPDATE acct SET balance = balance - ${30} WHERE id = ${'a'}`);
			await tx.execute(sql`UPDATE acct SET balance = balance + ${30} WHERE id = ${'b'}`);
		});
		assert.strictEqual(
			(await db.queryOne<{ balance: number }>(sql`SELECT balance FROM acct WHERE id = ${'b'}`))?.balance,
			30,
		);
		await assert.rejects(
			db.transaction(async (tx) => {
				await tx.execute(sql`UPDATE acct SET balance = 0 WHERE id = ${'a'}`);
				throw new Error('boom');
			}),
			(e: Error) => e.name === DatabaseErrors.TransactionFailed,
		);
		assert.strictEqual(
			(await db.queryOne<{ balance: number }>(sql`SELECT balance FROM acct WHERE id = ${'a'}`))?.balance,
			70,
		);
	});

	test('a db.query() inside a transaction callback joins the open transaction instead of deadlocking', async () => {
		const db = new Database(app(), 'db');
		await withMigrations(db, { '001.sql': 'CREATE TABLE t (id TEXT PRIMARY KEY);' });
		await db.transaction(async (tx) => {
			await tx.execute(sql`INSERT INTO t VALUES (${'a'})`);
			const rows = await db.query(sql`SELECT * FROM t`);
			assert.strictEqual(rows.length, 1, 'sees its own uncommitted write');
		});
	});

	test('simulateConflict makes the next commit a retriable 409; retryOnConflict re-runs the callback', async () => {
		const db = new Database(app(), 'db');
		await withMigrations(db, { '001.sql': 'CREATE TABLE t (id TEXT PRIMARY KEY);' });
		db.simulateConflict();
		await assert.rejects(
			db.transaction(async (tx) => {
				await tx.execute(sql`INSERT INTO t VALUES (${'x'})`);
			}),
			(e: unknown) => {
				assert.ok(e instanceof ApiError && e.status === 409 && e.retriable);
				assert.ok(isBlocksError(e, DatabaseErrors.SerializationFailure));
				return true;
			},
		);
		assert.strictEqual(await db.queryOne(sql`SELECT * FROM t WHERE id = ${'x'}`), null, 'rolled back');

		db.simulateConflict();
		let attempts = 0;
		await db.transaction(
			async (tx) => {
				attempts++;
				await tx.execute(sql`INSERT INTO t VALUES (${'y'})`);
			},
			{ retryOnConflict: true },
		);
		assert.strictEqual(attempts, 2);
		assert.ok(await db.queryOne(sql`SELECT * FROM t WHERE id = ${'y'}`));
	});

	test('the DSQL validation layer rejects unsupported SQL at query time with a doc citation', async () => {
		const db = new Database(app(), 'db');
		await withMigrations(db, { '001.sql': 'CREATE TABLE t (id TEXT PRIMARY KEY);' });
		await assert.rejects(
			db.execute(sql`TRUNCATE t`),
			(e: Error) => e.name === 'DsqlValidationError' && /aurora-dsql/.test(e.message),
		);
	});

	test('the row limit is enforced per transaction on a distributed cluster', async () => {
		const db = new Database(app(), 'db');
		await withMigrations(db, { '001.sql': 'CREATE TABLE t (id INTEGER PRIMARY KEY);' });
		await assert.rejects(
			db.transaction(async (tx) => {
				await tx.execute(sql`INSERT INTO t SELECT generate_series(1, 3001)`);
			}),
			(e: Error) => e.name === DatabaseErrors.TransactionRowLimitExceeded,
		);
	});

	test('withRLS and crud are refused at runtime on a distributed cluster', async () => {
		const db = new Database(app(), 'db') as unknown as Database<'provisioned'>;
		await assert.rejects(db.withRLS({ userId: 'u' }), /Not available on a 'distributed' cluster/);
		assert.throws(
			() => db.crud({ tables: [], auth: async () => ({ userId: 'u' }) }),
			/Not available on a 'distributed' cluster/,
		);
	});

	test('migrations run through the rewriter: SERIAL becomes an identity column, indexes are created, files recorded once', async () => {
		const db = new Database(app(), 'db');
		await withMigrations(db, {
			'001_items.sql':
				'CREATE TABLE items (id SERIAL PRIMARY KEY, name TEXT NOT NULL);\nCREATE INDEX items_name ON items (name);',
			'002_seed.sql': "INSERT INTO items (name) VALUES ('first');\nINSERT INTO items (name) VALUES ('second');",
		});
		const rows = await db.query<{ id: number; name: string }>(sql`SELECT id, name FROM items ORDER BY id`);
		assert.deepStrictEqual(
			rows.map((r) => r.name),
			['first', 'second'],
		);
		const applied = await db.query<{ name: string }>(sql`SELECT name FROM _migrations ORDER BY name`);
		assert.deepStrictEqual(
			applied.map((r) => r.name),
			['001_items.sql', '002_seed.sql'],
		);
	});

	test('a migration a distributed cluster cannot run fails at startup, naming the file', async () => {
		const db = new Database(app(), 'db');
		await assert.rejects(
			withMigrations(db, { '001_fk.sql': 'CREATE TABLE a (id TEXT PRIMARY KEY, b TEXT REFERENCES b(id));' }),
			/001_fk\.sql: Foreign keys need a 'provisioned' cluster/,
		);
	});

	test('Kysely adapter runs against the same engine', async () => {
		const db = new Database(app(), 'db');
		await withMigrations(db, { '001.sql': 'CREATE TABLE t (id TEXT PRIMARY KEY, n INTEGER);' });
		const kysely = createKyselyAdapter<{ t: { id: string; n: number } }>(db);
		await kysely.insertInto('t').values({ id: 'k', n: 7 }).execute();
		const row = await kysely.selectFrom('t').select(['id', 'n']).where('id', '=', 'k').executeTakeFirst();
		assert.deepStrictEqual(row, { id: 'k', n: 7 });
	});
});

describe('DatabaseCluster (shared)', () => {
	test('two blocks on one cluster each get their own schema and do not see each other', async () => {
		const scope = app();
		const main = new DatabaseCluster(scope, 'main', { type: 'provisioned', minCapacity: 0.5 });
		const users = new Database(scope, 'users', { cluster: main });
		const orders = new Database(scope, 'orders', { cluster: main });
		assert.deepStrictEqual(users.cluster, { kind: 'provisioned', id: main.fullId });
		assert.strictEqual(users.schemaName, 'users');
		assert.strictEqual(orders.schemaName, 'orders');
		// A provisioned cluster allows runtime DDL (full PostgreSQL).
		await users.execute(sql`CREATE TABLE items (id TEXT PRIMARY KEY)`);
		await orders.execute(sql`CREATE TABLE items (id TEXT PRIMARY KEY)`);
		await users.execute(sql`INSERT INTO items VALUES (${'u1'})`);
		await orders.execute(sql`INSERT INTO items VALUES (${'o1'}), (${'o2'})`);
		assert.strictEqual((await users.query(sql`SELECT * FROM items`)).length, 1);
		assert.strictEqual((await orders.query(sql`SELECT * FROM items`)).length, 2);
		// Concurrent transactions from both blocks stay isolated.
		await Promise.all([
			users.transaction(async (tx) => {
				await tx.execute(sql`INSERT INTO items VALUES (${'u2'})`);
				assert.strictEqual((await tx.query(sql`SELECT * FROM items`)).length, 2);
			}),
			orders.transaction(async (tx) => {
				await tx.execute(sql`INSERT INTO items VALUES (${'o3'})`);
				assert.strictEqual((await tx.query(sql`SELECT * FROM items`)).length, 3);
			}),
		]);
	});

	test('withRLS works on a provisioned cluster once the roles exist', async () => {
		const scope = app();
		const main = new DatabaseCluster(scope, 'main', { type: 'provisioned' });
		const db = new Database(scope, 'db', { cluster: main });
		await db.execute(sql`CREATE ROLE authenticated`);
		await db.execute(sql`CREATE TABLE notes (id TEXT PRIMARY KEY, owner TEXT NOT NULL)`);
		await db.execute(sql`GRANT USAGE ON SCHEMA db TO authenticated`);
		await db.execute(sql`GRANT SELECT ON notes TO authenticated`);
		await db.execute(sql`ALTER TABLE notes ENABLE ROW LEVEL SECURITY`);
		await db.execute(
			sql`CREATE POLICY own ON notes FOR SELECT TO authenticated USING (owner = current_setting('request.jwt.claims', true)::json->>'sub')`,
		);
		await db.execute(sql`INSERT INTO notes VALUES (${'n1'}, ${'alice'}), (${'n2'}, ${'bob'})`);
		const scoped = await db.withRLS({ userId: 'alice' });
		const mine = await scoped.query<{ id: string }>(sql`SELECT id FROM notes`);
		assert.deepStrictEqual(
			mine.map((r) => r.id),
			['n1'],
		);
	});

	test('a shared distributed cluster keeps the validation layer', async () => {
		const scope = app();
		const shared = new DatabaseCluster(scope, 'shared', { type: 'distributed' });
		const db = new Database(scope, 'db', { cluster: shared });
		await assert.rejects(db.execute(sql`CREATE TABLE t (id TEXT)`), /DDL statements .* not allowed/);
	});

	test('two blocks with the same schemaName on one cluster is an error', () => {
		const scope = app();
		const main = new DatabaseCluster(scope, 'main', { type: 'provisioned' });
		new Database(scope, 'users', { cluster: main, schemaName: 'public' });
		assert.throws(
			() => new Database(scope, 'orders', { cluster: main, schemaName: 'public' }),
			new RegExp(
				`Database '${scope.id}-users' and '${scope.id}-orders' both use schema 'public' on cluster '${scope.id}-main'\\.`,
			),
		);
	});

	test('fromExisting returns a plain, shareable value', () => {
		const ext = DatabaseCluster.fromExisting({ connectionString: 'postgres://u:p@localhost:5432/db' });
		assert.strictEqual(ext.kind, 'external');
		assert.ok(Object.isFrozen(ext));
		const scope = app();
		const a = new Database(scope, 'a', { cluster: ext });
		const b = new Database(scope, 'b', { cluster: ext, schemaName: 'public' });
		assert.deepStrictEqual(a.cluster, { kind: 'external', id: 'external' });
		assert.strictEqual(a.schemaName, 'a');
		assert.strictEqual(b.schemaName, 'public');
		assert.throws(() => DatabaseCluster.fromExisting({} as never), /needs a connectionString/);
	});
});

describe('block identity', () => {
	test('Database registers as an official block; DatabaseCluster is part of it, not a block', () => {
		Scope._resetRegistry();
		const scope = app();
		const main = new DatabaseCluster(scope, 'main', { type: 'provisioned' });
		const db = new Database(scope, 'db', { cluster: main });
		assert.strictEqual(db.bbName, 'Database');
		assert.strictEqual(main.bbName, undefined);
		const { blocks, totalCount, customBlocksCount } = Scope.getRegisteredBlocks();
		assert.deepStrictEqual(
			blocks.map((b) => b.name).filter((n) => n.startsWith('Database')),
			['Database'],
		);
		assert.strictEqual(customBlocksCount, 0, 'the cluster is not counted as a custom block');
		assert.ok(totalCount >= 1);
	});
});

describe('construction-time rules', () => {
	test('Database short ids are unique per app', () => {
		new Database(new Scope('shop'), 'orders');
		assert.throws(
			() => new Database(new Scope('admin'), 'orders'),
			/Database id 'orders' is used twice: 'shop-orders' and 'admin-orders'\. Database ids must be unique per app\./,
		);
	});

	test('DatabaseCluster short ids are unique per app', () => {
		new DatabaseCluster(new Scope('shop'), 'main', { type: 'distributed' });
		assert.throws(
			() => new DatabaseCluster(new Scope('admin'), 'main', { type: 'provisioned' }),
			/DatabaseCluster id 'main' is used twice/,
		);
	});

	test('the binding marker stops a block from moving clusters', () => {
		const scope = app();
		new Database(scope, 'orders');
		assert.ok(existsSync(join(DATA_DIR, `${scope.id}-orders`, 'binding.json')));
		_resetDatabaseRegistry();
		const main = new DatabaseCluster(scope, 'main', { type: 'provisioned' });
		assert.throws(
			() => new Database(scope, 'orders', { cluster: main }),
			new RegExp(
				`Deploy stopped: Database '${scope.id}-orders' is bound to its default cluster \\(distributed\\) and cannot move to '${scope.id}-main' \\(provisioned\\)`,
			),
		);
	});

	test('an explicit migrationsPath must exist; the default may be absent', () => {
		const scope = app();
		assert.throws(
			() => new Database(scope, 'a', { migrationsPath: './nope/missing' }),
			/migrationsPath '\.\/nope\/missing' does not exist/,
		);
		const db = new Database(scope, 'b');
		assert.strictEqual(db.migrationsPath, undefined);
	});

	test('the default migrations directory is ./aws-blocks/migrations/{id}', async () => {
		const dir = join(process.cwd(), 'aws-blocks', 'migrations', 'inv');
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, '001.sql'), 'CREATE TABLE inv (id TEXT PRIMARY KEY);');
		const db = new Database(app(), 'inv');
		assert.strictEqual(db.migrationsPath, dir);
		assert.deepStrictEqual(await db.query(sql`SELECT * FROM inv`), []);
	});
});

/** Write migration files into a temp directory and point a fresh block at them by re-running its migrations. */
async function withMigrations(db: Database, files: Record<string, string>): Promise<void> {
	const dir = join(DATA_DIR, `${db.fullId}-migrations`);
	mkdirSync(dir, { recursive: true });
	for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
	// The block was constructed without a migrationsPath; run the same path the constructor would.
	const { buildMigrationPlan } = await import('./migrations/plan.js');
	const { loadMigrationFiles, runMigrationPlan } = await import('./migrations/runner.js');
	const { MockEngine } = await import('./engines/mock-engine.js');
	const engine = (await db.getEngine()) as InstanceType<typeof MockEngine>;
	const plan = buildMigrationPlan(loadMigrationFiles(dir), db.cluster.kind);
	await engine.withDdl(() => runMigrationPlan(engine, plan, { schemaName: db.schemaName, log: () => {} }));
}
