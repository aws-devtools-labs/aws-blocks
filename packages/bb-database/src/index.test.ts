// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, afterEach, beforeEach, describe, test } from 'node:test';
import { ApiError, blocksError, isBlocksError, Scope } from '@aws-blocks/core';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { _resetDatabaseRegistry } from './core/construction.js';
import { internalAccess } from './core/internal.js';
import { _closeAllPgliteClusters } from './engines/pglite-cluster.js';
import { Database, DatabaseCluster, DatabaseErrors, sql } from './index.mock.js';
import { simulateConflict } from './testing.js';

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

describe('Database (owned DSQL cluster)', () => {
	test('query / queryOne / execute round-trip and queryOne returns null when absent', async () => {
		const db = new Database(app(), 'db');
		assert.deepStrictEqual(db.cluster, { kind: 'dsql', id: 'default' });
		assert.strictEqual(db.schemaName, 'public');
		await assert.rejects(db.execute(sql`CREATE TABLE t (id TEXT PRIMARY KEY)`), /DDL statements .* not allowed/);
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
			await db.execute(sql`INSERT INTO t VALUES (${'b'})`);
		});
		assert.strictEqual((await db.query(sql`SELECT * FROM t`)).length, 2);
	});

	test('an ApiError or a branded Blocks error thrown inside transaction() reaches the caller unchanged; the transaction still rolls back', async () => {
		const db = new Database(app(), 'db');
		await withMigrations(db, { '001.sql': 'CREATE TABLE acct (id TEXT PRIMARY KEY, balance INTEGER NOT NULL);' });
		await db.execute(sql`INSERT INTO acct VALUES (${'a'}, ${100})`);
		await assert.rejects(
			db.transaction(async (tx) => {
				await tx.execute(sql`UPDATE acct SET balance = 0 WHERE id = ${'a'}`);
				throw new ApiError('no such customer', 404);
			}),
			(e: unknown) => e instanceof ApiError && e.status === 404 && e.message === 'no such customer',
		);
		await assert.rejects(
			db.transaction(async () => {
				throw blocksError('InsufficientFundsException', 'not enough');
			}),
			(e: Error) => e.name === 'InsufficientFundsException' && e.message.includes('not enough'),
		);
		await assert.rejects(
			db.transaction(async () => {
				throw new Error('driver text');
			}),
			(e: Error) => e.name === DatabaseErrors.TransactionFailed && !e.message.includes('driver text'),
		);
		assert.strictEqual(
			(await db.queryOne<{ balance: number }>(sql`SELECT balance FROM acct WHERE id = ${'a'}`))?.balance,
			100,
		);
	});

	test('a result schema types and validates rows; a mismatch is ResultValidationFailed and rolls a transaction back', async () => {
		const db = new Database(app(), 'db');
		await withMigrations(db, { '001.sql': 'CREATE TABLE t (id TEXT PRIMARY KEY, n INTEGER NOT NULL);' });
		await db.execute(sql`INSERT INTO t VALUES (${'a'}, ${1}), (${'b'}, ${2})`);
		const Row = schemaOf(
			(v): v is { id: string; n: number } => isRecord(v) && typeof v.id === 'string' && typeof v.n === 'number',
		);
		const rows = await db.query(sql`SELECT id, n FROM t ORDER BY id`, { schema: Row });
		type _Rows = Expect<Equal<typeof rows, { id: string; n: number }[]>>;
		assert.deepStrictEqual(rows, [
			{ id: 'a', n: 1 },
			{ id: 'b', n: 2 },
		]);
		const one = await db.queryOne(sql`SELECT id, n FROM t WHERE id = ${'a'}`, { schema: Row });
		type _One = Expect<Equal<typeof one, { id: string; n: number } | null>>;
		assert.deepStrictEqual(one, { id: 'a', n: 1 });
		assert.strictEqual(await db.queryOne(sql`SELECT id, n FROM t WHERE id = ${'zzz'}`, { schema: Row }), null);
		const Upper = {
			'~standard': {
				version: 1,
				vendor: 'test',
				validate: (v: unknown) =>
					isRecord(v) && typeof v.id === 'string'
						? { value: { id: v.id.toUpperCase() } }
						: { issues: [{ message: 'no id' }] },
			},
		} satisfies StandardSchemaV1<unknown, { id: string }>;
		assert.deepStrictEqual(await db.query(sql`SELECT id FROM t ORDER BY id`, { schema: Upper }), [
			{ id: 'A' },
			{ id: 'B' },
		]);
		const Wrong = schemaOf(
			(v): v is { id: number } => isRecord(v) && typeof v.id === 'number',
			'id must be a number',
		);
		await assert.rejects(db.query(sql`SELECT id FROM t`, { schema: Wrong }), (e: Error) => {
			assert.ok(isBlocksError(e, DatabaseErrors.ResultValidationFailed));
			assert.match(e.message, /id must be a number/);
			return true;
		});
		await assert.rejects(
			db.transaction(async (tx) => {
				await tx.execute(sql`UPDATE t SET n = 99 WHERE id = ${'a'}`);
				await tx.queryOne(sql`SELECT id FROM t WHERE id = ${'a'}`, { schema: Wrong });
			}),
			(e: Error) => e.name === DatabaseErrors.ResultValidationFailed,
		);
		assert.strictEqual(
			(
				await db.queryOne(sql`SELECT n FROM t WHERE id = ${'a'}`, {
					schema: schemaOf((v): v is { n: number } => isRecord(v) && typeof v.n === 'number'),
				})
			)?.n,
			1,
		);
	});

	test('simulateConflict makes the next commit a retriable 409; retryOnConflict re-runs the callback', async () => {
		const db = new Database(app(), 'db');
		await withMigrations(db, { '001.sql': 'CREATE TABLE t (id TEXT PRIMARY KEY);' });
		simulateConflict(db);
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

		simulateConflict(db);
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

	test('dsql-lint rejects unsupported SQL at query time with its rule, suggestion, and a doc citation', async () => {
		const db = new Database(app(), 'db');
		await withMigrations(db, { '001.sql': 'CREATE TABLE t (id TEXT PRIMARY KEY);' });
		await assert.rejects(
			db.execute(sql`TRUNCATE t`),
			(e: Error) =>
				e.name === 'DsqlValidationError' &&
				/truncate: TRUNCATE is not supported/.test(e.message) &&
				/aurora-dsql/.test(e.message),
		);
	});

	test('the 3,000-row limit is enforced per transaction and per auto-commit statement, and rolls back', async () => {
		const db = new Database(app(), 'db');
		await withMigrations(db, { '001.sql': 'CREATE TABLE t (id INTEGER PRIMARY KEY);' });
		await assert.rejects(
			db.transaction(async (tx) => {
				await tx.execute(sql`INSERT INTO t SELECT generate_series(1, 3001)`);
			}),
			(e: Error) => e.name === DatabaseErrors.TransactionRowLimitExceeded,
		);
		await assert.rejects(
			db.execute(sql`INSERT INTO t SELECT generate_series(1, 3001)`),
			(e: Error) => e.name === DatabaseErrors.TransactionRowLimitExceeded,
		);
		assert.strictEqual(await db.queryOne(sql`SELECT * FROM t`), null, 'the auto-commit statement was rolled back');
		await db.execute(sql`INSERT INTO t SELECT generate_series(1, 3000)`);
		assert.strictEqual((await db.queryOne<{ n: number }>(sql`SELECT count(*)::int AS n FROM t`))?.n, 3000);
	});

	test('rows a foreign key cascades count toward the row limit', async () => {
		const db = new Database(app(), 'db');
		await withMigrations(db, {
			'001.sql': [
				'CREATE TABLE parent (id TEXT PRIMARY KEY);',
				'CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id TEXT REFERENCES parent(id) ON DELETE CASCADE);',
				'CREATE TABLE grandchild (id INTEGER PRIMARY KEY, child_id INTEGER REFERENCES child(id) ON DELETE CASCADE);',
			].join('\n'),
			// Two files: a migration's DML runs in one transaction, and DSQL's row limit applies to it as well.
			'002.sql':
				"INSERT INTO parent VALUES ('p');\nINSERT INTO child SELECT g, 'p' FROM generate_series(1, 1500) g;",
			'003.sql': 'INSERT INTO grandchild SELECT g, g FROM generate_series(1, 1500) g;',
		});
		await assert.rejects(
			db.execute(sql`DELETE FROM parent WHERE id = ${'p'}`),
			(e: Error) => e.name === DatabaseErrors.TransactionRowLimitExceeded && /cascades included/.test(e.message),
		);
		assert.strictEqual(
			(await db.queryOne<{ n: number }>(sql`SELECT count(*)::int AS n FROM child`))?.n,
			1500,
			'rolled back',
		);
		await db.execute(sql`DELETE FROM grandchild WHERE id > ${1000}`);
		await db.execute(sql`DELETE FROM parent WHERE id = ${'p'}`);
		assert.strictEqual((await db.queryOne<{ n: number }>(sql`SELECT count(*)::int AS n FROM child`))?.n, 0);
	});

	test('the 10 MiB limit is enforced before the statement runs', async () => {
		const db = new Database(app(), 'db');
		await withMigrations(db, { '001.sql': 'CREATE TABLE blobs (id TEXT PRIMARY KEY, body TEXT);' });
		await assert.rejects(
			db.execute(sql`INSERT INTO blobs VALUES (${'a'}, ${'x'.repeat(11 * 1024 * 1024)})`),
			(e: Error) => e.name === DatabaseErrors.TransactionRowLimitExceeded && /10 MiB/.test(e.message),
		);
	});

	test('DSQL migrations run as written: an identity column, constraints added NOT VALID then validated, an ASYNC index, a view', async () => {
		const db = new Database(app(), 'db');
		await withMigrations(db, {
			'001_users.sql': 'CREATE TABLE users (id TEXT PRIMARY KEY);',
			'002_items.sql': [
				'CREATE TABLE items (id BIGINT GENERATED BY DEFAULT AS IDENTITY (CACHE 65536) PRIMARY KEY, user_id TEXT NOT NULL, qty INTEGER NOT NULL);',
				'ALTER TABLE items ADD CONSTRAINT items_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE NOT VALID;',
				'ALTER TABLE ASYNC items VALIDATE CONSTRAINT items_user;',
				'ALTER TABLE items ADD CONSTRAINT items_qty CHECK (qty >= 0) NOT VALID;',
				'ALTER TABLE ASYNC items VALIDATE CONSTRAINT items_qty;',
				'CREATE INDEX ASYNC items_user ON items (user_id);',
				'CREATE VIEW item_counts AS SELECT user_id, count(*) AS n FROM items GROUP BY user_id;',
			].join('\n'),
			'003_seed.sql':
				"INSERT INTO users VALUES ('u1');\nINSERT INTO items (user_id, qty) VALUES ('u1', 1);\nINSERT INTO items (user_id, qty) VALUES ('u1', 2);",
		});
		const rows = await db.query<{ id: number | string; qty: number }>(sql`SELECT id, qty FROM items ORDER BY id`);
		assert.deepStrictEqual(
			rows.map((r) => [Number(r.id), r.qty]),
			[
				[1, 1],
				[2, 2],
			],
		);
		assert.strictEqual(
			(
				await db.queryOne<{ data_type: string }>(
					sql`SELECT data_type FROM information_schema.columns WHERE table_name = 'items' AND column_name = 'id'`,
				)
			)?.data_type,
			'bigint',
		);
		assert.ok(
			await db.queryOne(sql`SELECT 1 FROM pg_indexes WHERE indexname = 'items_user'`),
			'the ASYNC index exists',
		);
		const queryFailed = (e: Error) => e.name === DatabaseErrors.QueryFailed;
		await assert.rejects(db.execute(sql`INSERT INTO items (user_id, qty) VALUES (${'nobody'}, ${1})`), queryFailed);
		await assert.rejects(db.execute(sql`INSERT INTO items (user_id, qty) VALUES (${'u1'}, ${-1})`), queryFailed);
		assert.deepStrictEqual(
			(
				await db.query<{ convalidated: boolean }>(
					sql`SELECT convalidated FROM pg_constraint WHERE conname IN ('items_user', 'items_qty')`,
				)
			).map((r) => r.convalidated),
			[true, true],
		);
		assert.strictEqual(
			(
				await db.queryOne<{ n: number | string }>(sql`SELECT n FROM item_counts WHERE user_id = 'u1'`)
			)?.n.toString(),
			'2',
		);
		const applied = await db.query<{ name: string }>(sql`SELECT name FROM _migrations ORDER BY name`);
		assert.deepStrictEqual(
			applied.map((r) => r.name),
			['001_users.sql', '002_items.sql', '003_seed.sql'],
		);
	});

	test('a migration a DSQL cluster cannot run fails at startup, naming the file', async () => {
		const db = new Database(app(), 'db');
		await assert.rejects(
			withMigrations(db, {
				'001_rls.sql': 'CREATE TABLE a (id TEXT PRIMARY KEY);\nALTER TABLE a ENABLE ROW LEVEL SECURITY;',
			}),
			/001_rls\.sql: at_unsupported_row_level_security/,
		);
	});

	test('a PostgreSQL spelling of a DSQL form fails at startup with dsql-lint’s rule and suggestion, nothing is rewritten', async () => {
		const db = new Database(app(), 'db');
		await assert.rejects(
			withMigrations(db, {
				'001_init.sql': 'CREATE TABLE t (id SERIAL PRIMARY KEY, n INT);',
				'002_index.sql': 'CREATE INDEX t_n ON t (n);',
				'003_fk.sql': 'ALTER TABLE t ADD CONSTRAINT t_fk FOREIGN KEY (n) REFERENCES u(id);',
			}),
			(e: Error) => {
				assert.strictEqual(e.name, 'DsqlMigrationValidationError');
				assert.match(e.message, /001_init\.sql: serial_type: .*GENERATED BY DEFAULT AS IDENTITY/);
				assert.match(e.message, /002_index\.sql: index_async: .*CREATE INDEX ASYNC/);
				assert.match(e.message, /003_fk\.sql: foreign_key_not_valid: .*NOT VALID/);
				return true;
			},
		);
		assert.strictEqual(await db.queryOne(sql`SELECT 1 FROM pg_tables WHERE tablename = 't'`), null, 'nothing ran');
	});

	test('a job wait copied from the AWS examples runs locally as a no-op', async () => {
		const db = new Database(app(), 'db');
		await withMigrations(db, {
			'001_init.sql': [
				'CREATE TABLE t (id TEXT PRIMARY KEY, n INTEGER NOT NULL);',
				'CREATE INDEX ASYNC t_n ON t (n);',
				// The waits the DSQL user guide shows; locally there is no job, so the sys stub returns at once.
				"SELECT sys.wait_for_job('jh2gbtx4mzhgfkbimtgwn5j45y');",
				"SELECT sys.wait_for_job(job_id) FROM sys.jobs WHERE status IN ('submitted', 'processing');",
			].join('\n'),
		});
		assert.ok(await db.queryOne(sql`SELECT 1 FROM pg_indexes WHERE indexname = 't_n'`), 'the index was built');
		assert.deepStrictEqual(await db.query(sql`SELECT job_id FROM sys.jobs`), [], 'sys.jobs is empty locally');
		assert.deepStrictEqual(
			(await db.query<{ name: string }>(sql`SELECT name FROM _migrations`)).map((r) => r.name),
			['001_init.sql'],
		);
	});
});

describe('DatabaseCluster (shared DSQL)', () => {
	test('two blocks on one cluster each get their own schema and do not see each other', async () => {
		const scope = app();
		const shared = new DatabaseCluster(scope, 'shared', { type: 'dsql' });
		const users = new Database(scope, 'users', { cluster: shared });
		const orders = new Database(scope, 'orders', { cluster: shared });
		assert.deepStrictEqual(users.cluster, { kind: 'dsql', id: shared.fullId });
		assert.strictEqual(users.schemaName, 'users');
		assert.strictEqual(orders.schemaName, 'orders');
		await withMigrations(users, { '001.sql': 'CREATE TABLE items (id TEXT PRIMARY KEY);' });
		await withMigrations(orders, { '001.sql': 'CREATE TABLE items (id TEXT PRIMARY KEY);' });
		await users.execute(sql`INSERT INTO items VALUES (${'u1'})`);
		await orders.execute(sql`INSERT INTO items VALUES (${'o1'}), (${'o2'})`);
		assert.strictEqual((await users.query(sql`SELECT * FROM items`)).length, 1);
		assert.strictEqual((await orders.query(sql`SELECT * FROM items`)).length, 2);
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
		assert.ok(existsSync(join(DATA_DIR, shared.fullId, 'pglite')));
		assert.ok(!existsSync(join(DATA_DIR, users.fullId, 'pglite')));
	});

	test('a shared DSQL cluster keeps the DSQL checks', async () => {
		const scope = app();
		const shared = new DatabaseCluster(scope, 'shared', { type: 'dsql' });
		const db = new Database(scope, 'db', { cluster: shared });
		await assert.rejects(db.execute(sql`CREATE TABLE t (id TEXT)`), /DDL statements .* not allowed/);
	});

	test('two blocks with the same schemaName on one cluster is an error', () => {
		const scope = app();
		const shared = new DatabaseCluster(scope, 'shared', { type: 'dsql' });
		new Database(scope, 'users', { cluster: shared, schemaName: 'public' });
		assert.throws(
			() => new Database(scope, 'orders', { cluster: shared, schemaName: 'public' }),
			new RegExp(
				`Database '${scope.id}-users' and '${scope.id}-orders' both use schema 'public' on cluster '${scope.id}-shared'\\.`,
			),
		);
	});
});

describe('block identity', () => {
	test('Database registers as an official block; DatabaseCluster is part of it, not a block', () => {
		Scope._resetRegistry();
		const scope = app();
		const shared = new DatabaseCluster(scope, 'shared', { type: 'dsql' });
		const db = new Database(scope, 'db', { cluster: shared });
		assert.strictEqual(db.bbName, 'Database');
		assert.strictEqual(shared.bbName, undefined);
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
		new DatabaseCluster(new Scope('shop'), 'main', { type: 'dsql' });
		assert.throws(
			() => new DatabaseCluster(new Scope('admin'), 'main', { type: 'dsql' }),
			/DatabaseCluster id 'main' is used twice/,
		);
	});

	test('closing a local cluster that never ran a statement resolves', async () => {
		// Regression: PGlite 0.5.10's close() hangs before its init completes, and a
		// block whose migration fails validation never reaches the engine.
		new Database(app(), 'idle');
		const timeout = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 15_000).unref());
		assert.notStrictEqual(await Promise.race([_closeAllPgliteClusters().then(() => 'closed'), timeout]), 'timeout');
	});

	test('an explicit migrationsPath must exist; the default may be absent', () => {
		const scope = app();
		assert.throws(
			() => new Database(scope, 'a', { migrationsPath: './nope/missing' }),
			/migrationsPath '\.\/nope\/missing' does not exist/,
		);
		const db = new Database(scope, 'b');
		assert.strictEqual(internalAccess(db, 'test').migrationsPath, undefined);
	});

	test('the default migrations directory is ./aws-blocks/migrations/{id}', async () => {
		const dir = join(process.cwd(), 'aws-blocks', 'migrations', 'inv');
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, '001.sql'), 'CREATE TABLE inv (id TEXT PRIMARY KEY);');
		const db = new Database(app(), 'inv');
		assert.strictEqual(internalAccess(db, 'test').migrationsPath, dir);
		assert.deepStrictEqual(await db.query(sql`SELECT * FROM inv`), []);
	});
});

async function withMigrations(db: Database, files: Record<string, string>): Promise<void> {
	const dir = join(DATA_DIR, `${db.fullId}-migrations`);
	mkdirSync(dir, { recursive: true });
	for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
	const { buildMigrationPlan } = await import('./migrations/plan.js');
	const { loadMigrationFiles, runMigrationPlan } = await import('./migrations/runner.js');
	const { MockEngine } = await import('./engines/mock-engine.js');
	const engine = (await internalAccess(db, 'withMigrations').engine()) as InstanceType<typeof MockEngine>;
	const plan = buildMigrationPlan(loadMigrationFiles(dir));
	await engine.withDdl(() => runMigrationPlan(engine, plan, { schemaName: db.schemaName, log: () => {} }));
}

function schemaOf<T>(check: (v: unknown) => v is T, message = 'invalid row'): StandardSchemaV1<unknown, T> {
	return {
		'~standard': {
			version: 1,
			vendor: 'bb-database-test',
			validate: (value) => (check(value) ? { value } : { issues: [{ message }] }),
		},
	};
}

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null;
}

type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;
type Expect<T extends true> = T;
