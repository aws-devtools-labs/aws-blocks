// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { ApiError, blocksError, isBlocksError, Scope } from '@aws-cdk-blocks/core';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { z } from 'zod';
import { LOCAL_APP_ROLE } from './constants.js';
import { _closeAllPgliteClusters } from './engines/pglite-cluster.js';
import { DSQL_VALIDATION_ERROR_NAME, MIGRATION_FAILED_ERROR_NAME, MIGRATION_VALIDATION_ERROR_NAME } from './errors.js';
import { Database, DatabaseCluster, DatabaseErrors, sql, type Transaction } from './index.mock.js';
import { resolveMigrationsPath } from './migrations/runner.js';
import { _resetDatabaseRegistry } from './runtime/construction.js';
import { internalAccess } from './runtime/internal.js';
import { migrations, tempDir } from './test-support/fixtures.js';
import { freshScope, installLocalTestHooks, scopeId } from './test-support/lifecycle.js';
import { queryAsAdmin, resetMockSchema } from './test-support/mock-schema.js';
import { simulateConflict } from './testing.js';

const DATA_DIR = join(process.cwd(), '.cdk-blocks/local/data');
const app = () => freshScope('bbdb');
const limitExceeded = (e: unknown) => isBlocksError(e, DatabaseErrors.TransactionRowLimitExceeded);

installLocalTestHooks({ mockDataPrefix: 'bbdb' });

// One PGlite for the describe: every test's block has the same fullId, so it finds the cached cluster under
// the same data dir, and the public schema is reset between tests. A PGlite init costs about a second.
describe('Database (owned DSQL cluster)', () => {
	let current: Database | undefined;
	/** A block that owns its cluster, with `files` as its migrations. */
	const owned = (files: Record<string, string>): Database => {
		current = new Database(new Scope(scopeId('bbdb', 'owned')), 'db', { migrationsPath: migrations(files) });
		return current;
	};
	afterEach(async () => {
		if (current) await resetMockSchema(current);
		current = undefined;
	});

	test('a branded CDK Blocks error thrown inside transaction() reaches the caller unchanged', async () => {
		const db = owned({ '001.sql': 'CREATE TABLE acct (id TEXT PRIMARY KEY, balance INTEGER NOT NULL);' });
		await db.execute(sql`INSERT INTO acct VALUES (${'a'}, ${100})`);
		await assert.rejects(
			db.transaction(async () => {
				throw blocksError('InsufficientFundsException', 'not enough');
			}),
			{ name: 'InsufficientFundsException', message: /not enough/ },
		);
		await assert.rejects(
			db.transaction(async (tx) => {
				await tx.execute(sql`UPDATE acct SET balance = 0 WHERE id = ${'a'}`);
				throw new Error('driver text');
			}),
			(e: unknown) => {
				assert.ok(isBlocksError(e, DatabaseErrors.TransactionFailed), 'an unknown error is re-tagged');
				assert.doesNotMatch(e.message, /driver text/, 'without its text');
				return true;
			},
		);
		assert.strictEqual(
			(await db.queryOne<{ balance: number }>(sql`SELECT balance FROM acct WHERE id = ${'a'}`))?.balance,
			100,
			'the transaction rolled back',
		);
	});

	test('a result schema types and validates rows', async () => {
		const db = owned({ '001.sql': 'CREATE TABLE t (id TEXT PRIMARY KEY, n INTEGER NOT NULL);' });
		await db.execute(sql`INSERT INTO t VALUES (${'a'}, ${1}), (${'b'}, ${2})`);
		const Row = z.object({ id: z.string(), n: z.number() });
		const rows = await db.query(sql`SELECT id, n FROM t ORDER BY id`, { schema: Row });
		type _Rows = Expect<Equal<typeof rows, { id: string; n: number }[]>>;
		assert.deepStrictEqual(rows, [
			{ id: 'a', n: 1 },
			{ id: 'b', n: 2 },
		]);
		assert.strictEqual(await db.queryOne(sql`SELECT id, n FROM t WHERE id = ${'zzz'}`, { schema: Row }), null);
		// Hand-written: the contract is Standard Schema, not one library, and validate() may transform the row.
		const Upper = {
			'~standard': {
				version: 1,
				vendor: 'test',
				validate: (v: unknown) =>
					typeof v === 'object' && v !== null && 'id' in v && typeof v.id === 'string'
						? { value: { id: v.id.toUpperCase() } }
						: { issues: [{ message: 'no id' }] },
			},
		} satisfies StandardSchemaV1<unknown, { id: string }>;
		assert.deepStrictEqual(await db.query(sql`SELECT id FROM t ORDER BY id`, { schema: Upper }), [
			{ id: 'A' },
			{ id: 'B' },
		]);
		const Wrong = z.object({ id: z.number() });
		await assert.rejects(db.query(sql`SELECT id FROM t`, { schema: Wrong }), (e: unknown) => {
			assert.ok(isBlocksError(e, DatabaseErrors.ResultValidationFailed));
			assert.match(e.message, /A row did not match the result schema \(row 0 at 'id'\)$/);
			assert.ok(e.cause instanceof Error);
			return true;
		});
		await assert.rejects(
			db.transaction(async (tx) => {
				await tx.execute(sql`UPDATE t SET n = 99 WHERE id = ${'a'}`);
				await tx.queryOne(sql`SELECT id FROM t WHERE id = ${'a'}`, { schema: Wrong });
			}),
			(e: unknown) => isBlocksError(e, DatabaseErrors.ResultValidationFailed),
		);
		assert.strictEqual(
			(await db.queryOne(sql`SELECT n FROM t WHERE id = ${'a'}`, { schema: z.object({ n: z.number() }) }))?.n,
			1,
			'a mismatch inside a transaction rolls it back',
		);
	});

	test("a schema library's issue message stays on the server", async () => {
		const db = owned({ '001.sql': 'CREATE TABLE orders (id TEXT PRIMARY KEY, status TEXT NOT NULL);' });
		await db.execute(sql`INSERT INTO orders VALUES (${'o1'}, ${'refunded'})`);
		// zod 4's enum message no longer quotes the rejected value, so use a refinement
		// whose own message echoes it: the raw issue still carries sensitive row data,
		// which is exactly what bb-database must keep off the client.
		const Order = z.object({
			id: z.string(),
			status: z.string().refine((s) => s === 'paid' || s === 'pending', {
				error: (iss) => `status ${String(iss.input)} is not an allowed order status`,
			}),
		});
		await assert.rejects(db.query(sql`SELECT id, status FROM orders`, { schema: Order }), (e: unknown) => {
			assert.ok(isBlocksError(e, DatabaseErrors.ResultValidationFailed));
			assert.strictEqual(
				e.message,
				`${DatabaseErrors.ResultValidationFailed}: A row did not match the result schema (row 0 at 'status')`,
				'the client message carries the row index and path',
			);
			assert.ok(e.cause instanceof Error, 'the issues are the cause');
			assert.match(e.cause.message, /refunded/, 'the raw issue message quotes the row value');
			assert.ok('issues' in e.cause && Array.isArray(e.cause.issues) && e.cause.issues.length === 1);
			assert.strictEqual(Object.getOwnPropertyDescriptor(e, 'cause')?.enumerable, false);
			assert.ok(!JSON.stringify({ ...e, message: e.message }).includes('refunded'));
			return true;
		});
	});

	test('simulateConflict makes the next commit a retriable 409', async () => {
		const db = owned({ '001.sql': 'CREATE TABLE t (id TEXT PRIMARY KEY);' });
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
		assert.strictEqual(attempts, 2, 'retryOnConflict re-runs the callback');
		assert.ok(await db.queryOne(sql`SELECT * FROM t WHERE id = ${'y'}`));
	});

	test('simulateConflict before the first statement is kept for the app, not consumed by the migration run', async () => {
		const db = owned({ '001.sql': 'CREATE TABLE t (id TEXT PRIMARY KEY);' });
		simulateConflict(db);
		let attempts = 0;
		await db.transaction(
			async (tx) => {
				attempts++;
				await tx.execute(sql`INSERT INTO t VALUES (${'x'})`);
			},
			{ retryOnConflict: true },
		);
		assert.strictEqual(attempts, 2, 'the simulated conflict hit the first attempt of the app transaction');
		assert.ok(await db.queryOne(sql`SELECT * FROM t WHERE id = ${'x'}`));
	});

	// The callback arms the commit of its own transaction on each of its first `conflicts` runs.
	const insertAfterConflicts = (db: Database, id: string, conflicts: number) => {
		const counter = { attempts: 0 };
		const run = async (tx: Transaction) => {
			if (counter.attempts++ < conflicts) simulateConflict(db);
			await tx.execute(sql`INSERT INTO t VALUES (${id})`);
		};
		return { counter, run };
	};

	test('retryOnConflict commits a callback that conflicts maxRetries times, and throws on one conflict more', async () => {
		const db = owned({ '001.sql': 'CREATE TABLE t (id TEXT PRIMARY KEY);' });
		const within = insertAfterConflicts(db, 'within', 1);
		await db.transaction(within.run, { retryOnConflict: true, maxRetries: 1 });
		assert.strictEqual(within.counter.attempts, 2, 'one conflict, then the run that commits');
		assert.ok(await db.queryOne(sql`SELECT * FROM t WHERE id = ${'within'}`));

		const beyond = insertAfterConflicts(db, 'beyond', 2);
		await assert.rejects(db.transaction(beyond.run, { retryOnConflict: true, maxRetries: 1 }), (e: unknown) => {
			assert.ok(isBlocksError(e, DatabaseErrors.SerializationFailure));
			assert.ok(e instanceof ApiError && e.status === 409 && e.retriable);
			return true;
		});
		assert.strictEqual(beyond.counter.attempts, 2, 'the first run and one retry, no more');
		assert.strictEqual(await db.queryOne(sql`SELECT * FROM t WHERE id = ${'beyond'}`), null, 'rolled back');
	});

	test('the 3,000-row limit is enforced per auto-commit statement too', async () => {
		const db = owned({ '001.sql': 'CREATE TABLE t (id INTEGER PRIMARY KEY);' });
		await assert.rejects(db.execute(sql`INSERT INTO t SELECT generate_series(1, 3001)`), limitExceeded);
		assert.strictEqual(await db.queryOne(sql`SELECT * FROM t`), null, 'the auto-commit statement was rolled back');
		await db.execute(sql`INSERT INTO t SELECT generate_series(1, 3000)`);
		assert.strictEqual((await db.queryOne<{ n: number }>(sql`SELECT count(*)::int AS n FROM t`))?.n, 3000);
	});

	test('DML issued through query(), queryOne() or tx.query() counts toward the row limit like execute()', async () => {
		const db = owned({ '001.sql': 'CREATE TABLE t (id INTEGER PRIMARY KEY);' });
		const empty = async (why: string) => assert.strictEqual(await db.queryOne(sql`SELECT * FROM t`), null, why);
		await assert.rejects(db.query(sql`INSERT INTO t SELECT generate_series(1, 3001) RETURNING id`), limitExceeded);
		await empty('query() rolled the statement back');
		await assert.rejects(db.queryOne(sql`INSERT INTO t SELECT generate_series(1, 3001)`), limitExceeded);
		await empty('queryOne() without RETURNING uses the affected-row count, not the empty result');
		await assert.rejects(
			db.transaction(async (tx) => {
				await tx.query(sql`INSERT INTO t SELECT generate_series(1, 3001) RETURNING id`);
			}),
			limitExceeded,
		);
		await empty('tx.query() rolled the transaction back');
		await assert.rejects(
			db.transaction(async (tx) => {
				await tx.query(sql`INSERT INTO t SELECT generate_series(1, 3000) RETURNING id`);
				await tx.execute(sql`INSERT INTO t VALUES (${3001})`);
			}),
			limitExceeded,
		);
		await empty('rows from tx.query() and tx.execute() add up');
		assert.strictEqual(
			(await db.query(sql`SELECT g FROM generate_series(1, 5000) g`)).length,
			5000,
			'a SELECT is not counted',
		);
		const inserted = await db.query<{ id: number }>(
			sql`INSERT INTO t SELECT generate_series(1, 3000) RETURNING id`,
		);
		assert.strictEqual(inserted.length, 3000);
	});

	test('a bigint parameter is measured against the 10 MiB limit without failing the statement', async () => {
		const db = owned({ '001.sql': 'CREATE TABLE t (id BIGINT PRIMARY KEY);' });
		const { rowCount } = await db.execute(sql`INSERT INTO t VALUES (${9007199254740993n})`);
		assert.strictEqual(rowCount, 1);
		assert.deepStrictEqual(await db.queryOne<{ id: unknown }>(sql`SELECT id::text FROM t`), {
			id: '9007199254740993',
		});
	});

	test('rows a foreign key cascades count toward the row limit', async () => {
		const db = owned({
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
		await assert.rejects(db.execute(sql`DELETE FROM parent WHERE id = ${'p'}`), (e: unknown) => {
			assert.ok(limitExceeded(e));
			assert.match(e.message, /cascades included/);
			return true;
		});
		assert.strictEqual(
			(await db.queryOne<{ n: number }>(sql`SELECT count(*)::int AS n FROM child`))?.n,
			1500,
			'rolled back',
		);
		await db.execute(sql`DELETE FROM grandchild WHERE id > ${1000}`);
		await db.execute(sql`DELETE FROM parent WHERE id = ${'p'}`);
		assert.strictEqual((await db.queryOne<{ n: number }>(sql`SELECT count(*)::int AS n FROM child`))?.n, 0);
	});

	test('DSQL migrations run as written', async () => {
		const db = owned({
			'001_users.sql': 'CREATE TABLE users (id TEXT PRIMARY KEY);',
			'002_items.sql': [
				'CREATE TABLE items (id BIGINT GENERATED BY DEFAULT AS IDENTITY (CACHE 65536) PRIMARY KEY, user_id TEXT NOT NULL, qty INTEGER NOT NULL);',
				'ALTER TABLE items ADD CONSTRAINT items_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE NOT VALID;',
				'ALTER TABLE ASYNC items VALIDATE CONSTRAINT items_user;',
				'ALTER TABLE items ADD CONSTRAINT items_qty CHECK (qty >= 0) NOT VALID;',
				'ALTER TABLE ASYNC items VALIDATE CONSTRAINT items_qty;',
				'CREATE INDEX ASYNC items_user ON items (user_id);',
			].join('\n'),
			'003_seed.sql':
				"INSERT INTO users VALUES ('u1');\nINSERT INTO items (user_id, qty) VALUES ('u1', 1);\nINSERT INTO items (user_id, qty) VALUES ('u1', 2);",
		});
		assert.strictEqual(
			(
				await db.queryOne<{ data_type: string }>(
					sql`SELECT data_type FROM information_schema.columns WHERE table_name = 'items' AND column_name = 'id'`,
				)
			)?.data_type,
			'bigint',
			'the identity column is BIGINT',
		);
		assert.ok(
			await db.queryOne(sql`SELECT 1 FROM pg_indexes WHERE indexname = 'items_user'`),
			'the ASYNC index exists',
		);
		assert.deepStrictEqual(
			(
				await db.query<{ convalidated: boolean }>(
					sql`SELECT convalidated FROM pg_constraint WHERE conname IN ('items_user', 'items_qty')`,
				)
			).map((r) => r.convalidated),
			[true, true],
			'the constraints are validated',
		);
		const applied = await queryAsAdmin<{ name: string }>(db, 'SELECT name FROM _migrations ORDER BY name');
		assert.deepStrictEqual(
			applied.map((r) => r.name),
			['001_users.sql', '002_items.sql', '003_seed.sql'],
			'the applied files are recorded',
		);
	});

	test('a migration a DSQL cluster cannot run fails at construction, naming the file', () => {
		assert.throws(
			() =>
				owned({
					'001_rls.sql': 'CREATE TABLE a (id TEXT PRIMARY KEY);\nALTER TABLE a ENABLE ROW LEVEL SECURITY;',
				}),
			{ name: MIGRATION_VALIDATION_ERROR_NAME, message: /001_rls\.sql: at_unsupported_row_level_security/ },
		);
	});

	test('CREATE EXTENSION fails at construction on a DSQL cluster, even for an extension PGlite ships', () => {
		assert.throws(() => owned({ '001_ext.sql': 'CREATE EXTENSION IF NOT EXISTS citext;' }), {
			name: MIGRATION_VALIDATION_ERROR_NAME,
			message: /001_ext\.sql: unsupported_create_extension/,
		});
	});

	test('a PostgreSQL spelling of a DSQL form fails at construction with dsql-lint’s rule and suggestion', () => {
		assert.throws(
			() =>
				owned({
					'001_init.sql': 'CREATE TABLE t (id SERIAL PRIMARY KEY, n INT);',
					'002_index.sql': 'CREATE INDEX t_n ON t (n);',
					'003_fk.sql': 'ALTER TABLE t ADD CONSTRAINT t_fk FOREIGN KEY (n) REFERENCES u(id);',
				}),
			{
				name: MIGRATION_VALIDATION_ERROR_NAME,
				message: new RegExp(
					[
						'001_init\\.sql: serial_type: .*GENERATED BY DEFAULT AS IDENTITY',
						'002_index\\.sql: index_async: .*CREATE INDEX ASYNC',
						'003_fk\\.sql: foreign_key_not_valid: .*NOT VALID',
					].join('[\\s\\S]*'),
				),
			},
		);
	});

	test('a job wait copied from the AWS examples runs locally as a no-op', async () => {
		const db = owned({
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
			(await queryAsAdmin<{ name: string }>(db, 'SELECT name FROM _migrations')).map((r) => r.name),
			['001_init.sql'],
		);
	});
});

// One PGlite for the describe, as above; each test's blocks have their own ids, so their own schemas. The
// on-disk layout test constructs its own cluster.
describe('DatabaseCluster (shared DSQL)', () => {
	const table = { '001.sql': 'CREATE TABLE t (id TEXT PRIMARY KEY);' };
	const sharedCluster = () => {
		const scope = new Scope(scopeId('bbdb', 'shared'));
		return { scope, shared: new DatabaseCluster(scope, 'shared', { type: 'dsql' }) };
	};

	test('two blocks on one cluster run transactions concurrently, each in its own schema', async () => {
		const scope = app();
		const shared = new DatabaseCluster(scope, 'shared', { type: 'dsql' });
		const items = { '001.sql': 'CREATE TABLE items (id TEXT PRIMARY KEY);' };
		const users = new Database(scope, 'users', { cluster: shared, migrationsPath: migrations(items) });
		const orders = new Database(scope, 'orders', { cluster: shared, migrationsPath: migrations(items) });
		await users.execute(sql`INSERT INTO items VALUES (${'u1'})`);
		await orders.execute(sql`INSERT INTO items VALUES (${'o1'}), (${'o2'})`);
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
		assert.ok(existsSync(join(DATA_DIR, shared.fullId, 'pglite')), 'the data lives under the cluster');
		assert.ok(!existsSync(join(DATA_DIR, users.fullId, 'pglite')), 'not under the blocks');
	});

	test('a sibling block on the same cluster can be called inside a transaction() callback', {
		timeout: 15_000,
	}, async () => {
		const { scope, shared } = sharedCluster();
		const a = new Database(scope, 'a1', { cluster: shared, migrationsPath: migrations(table) });
		const b = new Database(scope, 'b1', { cluster: shared, migrationsPath: migrations(table) });
		await a.transaction(async (tx) => {
			await tx.execute(sql`INSERT INTO t VALUES (${'a1'})`);
			assert.deepStrictEqual(await b.query(sql`SELECT 1 AS one`), [{ one: 1 }]);
			const engine = await internalAccess(b, 'test').engine();
			await b.execute(sql`INSERT INTO t VALUES (${'b1'})`);
			// b's failing statement does not abort a's transaction.
			await assert.rejects(b.execute(sql`INSERT INTO t VALUES (${'b1'})`), (e: unknown) =>
				isBlocksError(e, DatabaseErrors.UniqueConstraintViolation),
			);
			assert.strictEqual(
				await internalAccess(b, 'test').engine(),
				engine,
				"the rollback to b's savepoint keeps b's engine; only the enclosing transaction's rollback drops it",
			);
			// a's statements still address a's schema, through tx and through the block.
			assert.deepStrictEqual(await tx.query(sql`SELECT id FROM t`), [{ id: 'a1' }]);
			await b.transaction(async (btx) => {
				await btx.execute(sql`INSERT INTO t VALUES (${'b2'})`);
				assert.deepStrictEqual(await a.query(sql`SELECT id FROM t`), [{ id: 'a1' }]);
			});
			await a.execute(sql`INSERT INTO t VALUES (${'a2'})`);
		});
		assert.deepStrictEqual(await a.query(sql`SELECT id FROM t ORDER BY id`), [{ id: 'a1' }, { id: 'a2' }]);
		assert.deepStrictEqual(await b.query(sql`SELECT id FROM t ORDER BY id`), [{ id: 'b1' }, { id: 'b2' }]);
	});

	test("locally a sibling's statement inside the callback is part of the transaction", {
		timeout: 15_000,
	}, async () => {
		const { scope, shared } = sharedCluster();
		const a = new Database(scope, 'a2', { cluster: shared, migrationsPath: migrations(table) });
		const b = new Database(scope, 'b2', { cluster: shared, migrationsPath: migrations(table) });
		await assert.rejects(
			a.transaction(async () => {
				await b.execute(sql`INSERT INTO t VALUES (${'b1'})`);
				throw new ApiError('abort', 409);
			}),
			(e: unknown) => e instanceof ApiError && e.status === 409,
		);
		assert.deepStrictEqual(await b.query(sql`SELECT id FROM t`), [], 'it rolled back with the transaction');
		// The cluster is usable afterwards: the mutex was released once.
		await b.execute(sql`INSERT INTO t VALUES (${'b2'})`);
		assert.deepStrictEqual(await b.query(sql`SELECT id FROM t`), [{ id: 'b2' }]);
	});

	test('a sibling whose migrations ran inside a rolled-back transaction runs them again', {
		timeout: 15_000,
	}, async () => {
		const { scope, shared } = sharedCluster();
		const a = new Database(scope, 'a3', { cluster: shared, migrationsPath: migrations(table) });
		const b = new Database(scope, 'b3', { cluster: shared, migrationsPath: migrations(table) });
		let built: unknown;
		await assert.rejects(
			a.transaction(async () => {
				// b's first statement ever: its schema, tables and `_migrations` rows are created inside a's
				// transaction and roll back with it.
				assert.deepStrictEqual(await b.query(sql`SELECT id FROM t`), []);
				built = await internalAccess(b, 'test').engine();
				throw new ApiError('abort', 409);
			}),
			(e: unknown) => e instanceof ApiError && e.status === 409,
		);
		assert.deepStrictEqual(await b.query(sql`SELECT id FROM t`), [], 'the tables are there again');
		assert.notStrictEqual(await internalAccess(b, 'test').engine(), built, 'on a rebuilt engine');
		assert.deepStrictEqual(
			(await queryAsAdmin<{ name: string }>(b, 'SELECT name FROM _migrations')).map((r) => r.name),
			['001.sql'],
			'the migrations were applied again',
		);
		await b.execute(sql`INSERT INTO t VALUES (${'b1'})`);
		assert.deepStrictEqual(await b.query(sql`SELECT id FROM t`), [{ id: 'b1' }]);
	});

	test('simulateConflict armed between a rollback-triggered invalidation and the rebuild hits the next transaction', {
		timeout: 15_000,
	}, async () => {
		const { scope, shared } = sharedCluster();
		const a = new Database(scope, 'a4', { cluster: shared, migrationsPath: migrations(table) });
		const b = new Database(scope, 'b4', { cluster: shared, migrationsPath: migrations(table) });
		await assert.rejects(
			a.transaction(async () => {
				await b.query(sql`SELECT id FROM t`);
				throw new ApiError('abort', 409);
			}),
			(e: unknown) => e instanceof ApiError && e.status === 409,
		);
		// b's engine is invalidated but not yet rebuilt.
		simulateConflict(b);
		let attempts = 0;
		await b.transaction(
			async (tx) => {
				attempts++;
				await tx.execute(sql`INSERT INTO t VALUES (${'b1'})`);
			},
			{ retryOnConflict: true },
		);
		assert.strictEqual(attempts, 2, 'the conflict is armed on the rebuilt engine, not the discarded one');
		assert.deepStrictEqual(await b.query(sql`SELECT id FROM t`), [{ id: 'b1' }]);
	});

	test('a shared DSQL cluster keeps the DSQL checks', async () => {
		const { scope, shared } = sharedCluster();
		const db = new Database(scope, 'checks', { cluster: shared });
		// dsql-lint first, on the statement text; then PostgreSQL, which refuses DDL from the app role.
		await assert.rejects(db.execute(sql`CREATE TABLE t (id SERIAL PRIMARY KEY)`), {
			name: DSQL_VALIDATION_ERROR_NAME,
		});
		await assert.rejects(db.execute(sql`CREATE TABLE t (id TEXT)`), { name: DatabaseErrors.QueryFailed });
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
	test('Database registers as an official block', () => {
		const scope = app();
		const shared = new DatabaseCluster(scope, 'shared', { type: 'dsql' });
		const db = new Database(scope, 'db', { cluster: shared });
		assert.strictEqual(db.bbName, 'Database');
		assert.strictEqual(shared.bbName, undefined, 'DatabaseCluster is part of it, not a block');
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
	// The app roots carry this process's id: a block's data dir is named after its fullId.
	test('Database short ids are unique per app', () => {
		const root = { id: scopeId('bbdb', 'app') };
		new Database(new Scope('shop', { parent: root }), 'orders');
		assert.throws(() => new Database(new Scope('admin', { parent: root }), 'orders'), {
			name: 'DatabaseConfigurationError',
			message:
				`DatabaseConfigurationError: Database id 'orders' is used twice: '${root.id}-shop-orders' and ` +
				`'${root.id}-admin-orders'. Database ids must be unique per app.`,
		});
	});

	test('short ids are unique per app, not per process', () => {
		const stackA = { id: scopeId('bbdb', 'StackA') };
		const stackB = { id: scopeId('bbdb', 'StackB') };
		new Database(new Scope('shop', { parent: stackA }), 'orders');
		new Database(new Scope('shop', { parent: stackB }), 'orders');
		new DatabaseCluster(new Scope('shop', { parent: stackA }), 'main', { type: 'dsql' });
		new DatabaseCluster(new Scope('shop', { parent: stackB }), 'main', { type: 'dsql' });
		assert.throws(
			() => new Database(new Scope('admin', { parent: stackA }), 'orders'),
			new RegExp(
				`Database id 'orders' is used twice: '${stackA.id}-shop-orders' and '${stackA.id}-admin-orders'`,
			),
		);
		assert.throws(
			() => new DatabaseCluster(new Scope('admin', { parent: stackB }), 'main', { type: 'dsql' }),
			new RegExp(
				`DatabaseCluster id 'main' is used twice: '${stackB.id}-shop-main' and '${stackB.id}-admin-main'`,
			),
		);
	});

	test('DatabaseCluster short ids are unique per app', () => {
		const root = { id: scopeId('bbdb', 'app') };
		new DatabaseCluster(new Scope('shop', { parent: root }), 'main', { type: 'dsql' });
		assert.throws(
			() => new DatabaseCluster(new Scope('admin', { parent: root }), 'main', { type: 'dsql' }),
			/DatabaseCluster id 'main' is used twice/,
		);
	});

	test('an explicit migrationsPath must exist; the default is ./cdk-blocks/migrations/{id}, when present', () => {
		const root = tempDir();
		assert.throws(() => resolveMigrationsPath('./nope/missing', 'a', 'app-a', root), {
			name: 'DatabaseConfigurationError',
			message:
				/Database 'app-a': migrationsPath '\.\/nope\/missing' does not exist \(resolved to .*nope.missing\)/,
		});
		assert.strictEqual(
			resolveMigrationsPath(undefined, 'b', 'app-b', root),
			undefined,
			'the default may be absent',
		);
		const inv = join(root, 'cdk-blocks', 'migrations', 'inv');
		mkdirSync(inv, { recursive: true });
		assert.strictEqual(resolveMigrationsPath(undefined, 'inv', 'app-inv', root), inv);
		assert.strictEqual(resolveMigrationsPath('./cdk-blocks/migrations/inv', 'x', 'app-x', root), inv);
		assert.strictEqual(resolveMigrationsPath(inv, 'x', 'app-x', root), inv, 'an absolute path is taken as is');
	});

	test('a Database with a missing migrationsPath fails at construction', () => {
		assert.throws(
			() => new Database(app(), 'a', { migrationsPath: './nope/missing' }),
			/migrationsPath '\.\/nope\/missing' does not exist/,
		);
	});
});

type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

describe('DatabaseCluster (shared Aurora, express configuration)', () => {
	const auroraCluster = () => {
		const scope = new Scope(scopeId('bbdb', 'aurora'));
		return { scope, shared: new DatabaseCluster(scope, 'main', { type: 'aurora' }) };
	};
	let current: Database | undefined;
	afterEach(async () => {
		if (current) await resetMockSchema(current, current.schemaName);
		current = undefined;
	});

	test('a statement that breaks a constraint is named for the constraint, and nothing is written', async () => {
		const { scope, shared } = auroraCluster();
		current = new Database(scope, 'rules', {
			cluster: shared,
			migrationsPath: migrations({
				'001_orders.sql': [
					'CREATE TABLE customers (id INTEGER PRIMARY KEY);',
					'CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customers(id),',
					'  total INTEGER NOT NULL CHECK (total >= 0));',
				].join('\n'),
			}),
		});
		const db = current;
		await db.execute(sql`INSERT INTO customers VALUES (1)`);
		const named = (name: string, status: number) => (e: unknown) =>
			e instanceof ApiError && isBlocksError(e, name) && e.status === status && !e.message.includes('4242');
		await assert.rejects(
			db.execute(sql`INSERT INTO orders VALUES (4242, 1, ${null})`),
			named(DatabaseErrors.NotNullViolation, 400),
		);
		await assert.rejects(
			db.execute(sql`INSERT INTO orders VALUES (4242, 1, ${-5})`),
			named(DatabaseErrors.CheckViolation, 400),
		);
		await assert.rejects(
			db.execute(sql`INSERT INTO orders VALUES (4242, 2, 10)`),
			named(DatabaseErrors.ForeignKeyViolation, 409),
		);
		await db.execute(sql`INSERT INTO orders VALUES (4242, 1, 10)`);
		// A row that others still refer to cannot be deleted: the same name, from the other side.
		await assert.rejects(
			db.execute(sql`DELETE FROM customers WHERE id = 1`),
			named(DatabaseErrors.ForeignKeyViolation, 409),
		);
		assert.deepStrictEqual(await db.query(sql`SELECT id FROM orders`), [{ id: 4242 }]);
	});

	test('PostgreSQL migrations run as written: SERIAL, a plain index, a trigger in PL/pgSQL, one transaction per file', async () => {
		const { scope, shared } = auroraCluster();
		current = new Database(scope, 'pg', {
			cluster: shared,
			migrationsPath: migrations({
				'001_notes.sql': [
					'CREATE TABLE notes (id SERIAL PRIMARY KEY, body TEXT NOT NULL, updated_at TIMESTAMPTZ);',
					'CREATE INDEX notes_body ON notes (body);',
					'CREATE FUNCTION touch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at := now(); RETURN NEW; END $$;',
					'CREATE TRIGGER notes_touch BEFORE INSERT OR UPDATE ON notes FOR EACH ROW EXECUTE FUNCTION touch();',
				].join('\n'),
			}),
		});
		const db = current;
		assert.deepStrictEqual(db.cluster, { kind: 'aurora', id: shared.fullId });
		assert.strictEqual((await db.execute(sql`INSERT INTO notes (body) VALUES ('a')`)).rowCount, 1);
		const row = await db.queryOne<{ id: number; updated_at: Date | null }>(sql`SELECT id, updated_at FROM notes`);
		assert.strictEqual(row?.id, 1, 'SERIAL assigned the id');
		assert.ok(row?.updated_at, 'the trigger ran');
		assert.ok(await db.queryOne(sql`SELECT 1 FROM pg_indexes WHERE indexname = 'notes_body'`), 'the index exists');
		assert.deepStrictEqual(
			(await queryAsAdmin<{ name: string }>(db, 'SELECT name FROM _migrations')).map((r) => r.name),
			['001_notes.sql'],
		);
		assert.deepStrictEqual(
			await queryAsAdmin(db, 'SELECT 1 FROM _migration_progress'),
			[],
			'nothing is left to resume',
		);
	});

	test('no DSQL limits: a transaction may change more than 3,000 rows, and no lint runs on handler SQL', async () => {
		const { scope, shared } = auroraCluster();
		current = new Database(scope, 'big', {
			cluster: shared,
			migrationsPath: migrations({ '001.sql': 'CREATE TABLE t (id SERIAL PRIMARY KEY, n INT);' }),
		});
		const db = current;
		const { rowCount } = await db.execute(sql`INSERT INTO t (n) SELECT g FROM generate_series(1, 3001) g`);
		assert.strictEqual(rowCount, 3001);
		await db.transaction(async (tx) => {
			assert.strictEqual((await tx.execute(sql`UPDATE t SET n = n + 1`)).rowCount, 3001);
		});
		assert.strictEqual((await db.queryOne<{ c: number }>(sql`SELECT count(*)::int AS c FROM t`))?.c, 3001);
	});

	test('a migration creates the extensions PGlite ships, and the block uses them', async () => {
		const { scope, shared } = auroraCluster();
		current = new Database(scope, 'ext', {
			cluster: shared,
			migrationsPath: migrations({
				'001_ext.sql': [
					'CREATE EXTENSION IF NOT EXISTS citext;',
					'CREATE EXTENSION IF NOT EXISTS pgcrypto;',
					'CREATE EXTENSION IF NOT EXISTS pg_trgm;',
					'CREATE EXTENSION IF NOT EXISTS hstore;',
					'CREATE EXTENSION IF NOT EXISTS "uuid-ossp";',
					'CREATE TABLE users (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), email CITEXT UNIQUE NOT NULL);',
				].join('\n'),
			}),
		});
		const db = current;
		await db.execute(sql`INSERT INTO users (email) VALUES ('Ada@Example.com')`);
		assert.deepStrictEqual(
			await db.query(sql`SELECT email FROM users WHERE email = 'ada@example.COM'`),
			[{ email: 'Ada@Example.com' }],
			'a citext comparison ignores case',
		);
		const row = await db.queryOne<{ digest: string; similar: number; tag: string; v4: string }>(
			sql`SELECT encode(digest('abc', 'sha256'), 'hex') AS digest, similarity('word', 'words') AS similar,
				('a=>1'::hstore) -> 'a' AS tag, uuid_generate_v4()::text AS v4`,
		);
		assert.strictEqual(row?.digest, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
		assert.ok((row?.similar ?? 0) > 0.5, 'pg_trgm similarity()');
		assert.strictEqual(row?.tag, '1', 'hstore');
		assert.match(row?.v4 ?? '', /^[0-9a-f-]{36}$/, 'uuid-ossp');
	});

	test('an extension PGlite does not ship fails the migration and names the extension', async () => {
		const { scope, shared } = auroraCluster();
		const db = new Database(scope, 'noext', {
			cluster: shared,
			migrationsPath: migrations({ '001_vector.sql': 'CREATE EXTENSION IF NOT EXISTS vector;' }),
		});
		await assert.rejects(db.query(sql`SELECT 1`), {
			name: MIGRATION_FAILED_ERROR_NAME,
			message: /001_vector\.sql[\s\S]*extension "vector" is not available[\s\S]*PGlite[\s\S]*citext/,
		});
	});

	test('a pg_dump header that clears search_path does not redirect the migration ledger', async () => {
		const { scope, shared } = auroraCluster();
		current = new Database(scope, 'sp', {
			cluster: shared,
			migrationsPath: migrations({
				'001.sql':
					"SELECT pg_catalog.set_config('search_path', '', false);\nCREATE TABLE sp.items (id integer PRIMARY KEY);",
			}),
		});
		const db = current;
		assert.strictEqual((await db.execute(sql`INSERT INTO items VALUES (1)`)).rowCount, 1);
		assert.deepStrictEqual(
			(await queryAsAdmin<{ name: string }>(db, 'SELECT name FROM _migrations')).map((r) => r.name),
			['001.sql'],
		);
	});

	test('DDL in a handler is refused, as the deployed app role has DML only; simulateConflict works', async () => {
		const { scope, shared } = auroraCluster();
		current = new Database(scope, 'ddl', {
			cluster: shared,
			migrationsPath: migrations({ '001.sql': 'CREATE TABLE t (id INT PRIMARY KEY);' }),
		});
		const db = current;
		// Refused by PostgreSQL, as on AWS: the statements run as a role that owns nothing and has DML only.
		for (const ddl of [
			sql`CREATE TABLE u (id INT)`,
			sql`ALTER TABLE t ADD COLUMN n INT`,
			sql`DROP TABLE t`,
			sql`TRUNCATE t`,
		]) {
			await assert.rejects(db.execute(ddl), { name: DatabaseErrors.QueryFailed });
		}
		await assert.rejects(db.query(sql`SELECT name FROM _migrations`), { name: DatabaseErrors.QueryFailed });
		simulateConflict(db);
		await assert.rejects(
			db.transaction(async (tx) => {
				await tx.execute(sql`INSERT INTO t VALUES (1)`);
			}),
			(e: unknown) => isBlocksError(e, DatabaseErrors.SerializationFailure),
		);
		assert.strictEqual(await db.queryOne(sql`SELECT 1 FROM t`), null, 'the conflicting transaction rolled back');
	});

	test('statements run as a plain role, so a Row Level Security policy applies to them', async () => {
		const { scope, shared } = auroraCluster();
		current = new Database(scope, 'rls', {
			cluster: shared,
			migrationsPath: migrations({
				'001_docs.sql': [
					'CREATE TABLE docs (id INT PRIMARY KEY, published BOOLEAN NOT NULL);',
					'ALTER TABLE docs ENABLE ROW LEVEL SECURITY;',
					'CREATE POLICY docs_published ON docs USING (published);',
					// The migration runs as the admin, which owns the table: its policies do not apply to it.
					'INSERT INTO docs VALUES (1, true), (2, false);',
				].join('\n'),
			}),
		});
		const db = current;
		assert.deepStrictEqual(await db.queryOne(sql`SELECT current_user AS role`), { role: LOCAL_APP_ROLE });
		assert.deepStrictEqual(await db.query(sql`SELECT id FROM docs`), [{ id: 1 }], 'the policy hides the other row');
		assert.strictEqual((await db.execute(sql`UPDATE docs SET published = true WHERE id = 2`)).rowCount, 0);
		await assert.rejects(db.execute(sql`INSERT INTO docs VALUES (3, false)`), { name: DatabaseErrors.QueryFailed });
		await db.transaction(async (tx) => {
			assert.deepStrictEqual(await tx.query(sql`SELECT id FROM docs`), [{ id: 1 }]);
		});
		assert.strictEqual((await queryAsAdmin(db, 'SELECT id FROM docs')).length, 2);
	});

	test('a sibling’s migration run inside a transaction leaves that transaction on the app role', async () => {
		const { scope, shared } = auroraCluster();
		const table = { '001.sql': 'CREATE TABLE t (id INT PRIMARY KEY);' };
		const a = new Database(scope, 'role_a', { cluster: shared, migrationsPath: migrations(table) });
		const b = new Database(scope, 'role_b', { cluster: shared, migrationsPath: migrations(table) });
		await a.transaction(async (tx) => {
			// b's first statement: its migrations run as the admin, in a savepoint of a's transaction.
			await b.execute(sql`INSERT INTO t VALUES (1)`);
			assert.deepStrictEqual(await tx.queryOne(sql`SELECT current_user AS role`), { role: LOCAL_APP_ROLE });
			await assert.rejects(b.execute(sql`CREATE TABLE u (id INT)`), { name: DatabaseErrors.QueryFailed });
			await tx.execute(sql`INSERT INTO t VALUES (2)`);
		});
		assert.deepStrictEqual(await a.query(sql`SELECT id FROM t`), [{ id: 2 }]);
		assert.deepStrictEqual(await b.query(sql`SELECT id FROM t`), [{ id: 1 }]);
	});

	test('an aurora and a dsql cluster can coexist in one app; a made-up type is rejected', () => {
		const scope = app();
		const aurora = new DatabaseCluster(scope, 'aurora', { type: 'aurora', minCapacity: 0.5, maxCapacity: 4 });
		const dsql = new DatabaseCluster(scope, 'dsql', { type: 'dsql' });
		assert.strictEqual(new Database(scope, 'a', { cluster: aurora }).cluster.kind, 'aurora');
		assert.strictEqual(new Database(scope, 'd', { cluster: dsql }).cluster.kind, 'dsql');
		assert.throws(
			() => new Database(scope, 'x', { cluster: { type: 'provisioned', fullId: 'nope' } as never }),
			/'cluster' must be a DatabaseCluster/,
		);
		// The same checks as at synth, so a bad value stops `npm run dev` too.
		assert.throws(
			() => new DatabaseCluster(scope, 'bad', { type: 'aurora', minCapacity: 0.3 }),
			/minCapacity must be a multiple of 0\.5/,
		);
	});
});

describe('local app role', () => {
	test('a data directory from before the app role gets the role and its grants on the next start', async () => {
		const files = migrations({ '001.sql': 'CREATE TABLE t (id TEXT PRIMARY KEY);' });
		const start = () => new Database(new Scope(scopeId('bbdb', 'olddir')), 'db', { migrationsPath: files });
		const before = start();
		await before.execute(sql`INSERT INTO t VALUES (${'kept'})`);
		// The directory as an earlier version left it: the tables and the ledger, no role and no grants.
		await queryAsAdmin(before, `DROP OWNED BY "${LOCAL_APP_ROLE}"`);
		await queryAsAdmin(before, `DROP ROLE "${LOCAL_APP_ROLE}"`);
		await _closeAllPgliteClusters();
		_resetDatabaseRegistry();
		Scope._resetRegistry();

		const after = start();
		assert.deepStrictEqual(await after.query(sql`SELECT id FROM t`), [{ id: 'kept' }]);
		assert.deepStrictEqual(await after.queryOne(sql`SELECT current_user AS role`), { role: LOCAL_APP_ROLE });
	});
});
