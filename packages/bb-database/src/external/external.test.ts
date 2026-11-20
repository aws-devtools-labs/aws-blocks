// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// A block on an existing PostgreSQL database (`DatabaseCluster.fromExisting()`): everything that needs no database.

import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import { describe, test } from 'node:test';
import { ApiError, isBlocksError } from '@aws-cdk-blocks/core';
import type pg from 'pg';
import { linesToPaste } from '../cli/commands.js';
import { externalPoolConfig, PgEngine, type PgPool, type PgPoolClient } from '../engines/pg-engine.js';
import {
	DatabaseErrors,
	isConnectionLost,
	isConnectionRefused,
	MIGRATION_FAILED_ERROR_NAME,
	translatePgError,
} from '../errors.js';
import { Database as LambdaDatabase, DatabaseCluster as LambdaDatabaseCluster } from '../index.aws.js';
import { Database, DatabaseCluster, sql } from '../index.mock.js';
import { buildMigrationPlan, lintMigrationFiles } from '../migrations/plan.js';
import { runMigrationPlan } from '../migrations/runner.js';
import { registerInternalAccess } from '../runtime/internal.js';
import { roleDatabase } from '../runtime/scoped.js';
import { freshScope, installLocalTestHooks } from '../test-support/lifecycle.js';
import { RecordingEngine } from '../test-support/recording-engine.js';
import { parseConnectionString } from './connection.js';
import { readSsmConnectionString } from './ssm-store.js';

installLocalTestHooks();

const CONFIG_ERROR = 'DatabaseConfigurationError';
const PASSWORD = 'S3cr3t-pa55';
const CA = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n';
const url = (rest = '') => `postgresql://app.ref:${PASSWORD}@db.example.com:6543/appdb${rest}`;

function configError(fn: () => unknown, pattern: RegExp): void {
	assert.throws(fn, (e: unknown) => {
		assert.ok(isBlocksError(e, CONFIG_ERROR), `expected ${CONFIG_ERROR}, got ${String(e)}`);
		assert.match((e as Error).message, pattern);
		assert.ok(!(e as Error).message.includes(PASSWORD), 'the message must not carry the password');
		assert.ok(!JSON.stringify(e).includes(PASSWORD), 'no enumerable field may carry the password');
		return true;
	});
}

describe('parseConnectionString', () => {
	test('splits a URL into the fields the driver takes', () => {
		assert.deepStrictEqual(parseConnectionString(url(), 'The value'), {
			host: 'db.example.com',
			port: 6543,
			user: 'app.ref',
			password: PASSWORD,
			database: 'appdb',
		});
	});

	test('the port defaults to 5432, the database to postgres, and user and password are decoded', () => {
		const fields = parseConnectionString('postgres://us%40er:p%23ss%2Fword@host.example', 'The value');
		assert.deepStrictEqual(fields, {
			host: 'host.example',
			port: 5432,
			user: 'us@er',
			password: 'p#ss/word',
			database: 'postgres',
		});
	});

	test('a value that is not a PostgreSQL URL is refused by the name of its source', () => {
		// What a secret that was never set looks like: a random placeholder.
		configError(
			() => parseConnectionString('q8Zb3_placeholder', "The SSM parameter '/stack-db-url'"),
			/\/stack-db-url.*Store one with `npm run db connect`/,
		);
		configError(() => parseConnectionString(null, 'The value'), /The value has no value\..*`npm run db connect`/);
		configError(() => parseConnectionString('  ', 'The value'), /The value has no value/);
		configError(() => parseConnectionString(`mysql://u:${PASSWORD}@h/db`, 'The value'), /postgres:\/\//);
	});

	test("a URL the parser rejects is reported without the parser's own error, which carries the input", () => {
		configError(
			() => parseConnectionString(`postgresql://u:${PASSWORD}@host:port/db`, 'The value'),
			/not a valid URL/,
		);
	});

	for (const parameter of [
		'sslmode=no-verify',
		'sslmode=require',
		'ssl=0',
		'ssl=no-verify',
		'sslrootcert=/tmp/ca.crt',
	]) {
		test(`the TLS parameter ${parameter} is refused, not stripped`, () => {
			configError(
				() => parseConnectionString(url(`?${parameter}`), 'The value'),
				new RegExp(`'${parameter.split('=')[0]}'`),
			);
		});
	}

	test('other parameters are ignored', () => {
		assert.strictEqual(parseConnectionString(url('?application_name=x&pgbouncer=true'), 'The value').port, 6543);
	});
});

describe('the pool of an existing database', () => {
	const connection = parseConnectionString(url(), 'The value');

	test('gets discrete fields and never a connection string', () => {
		const config = externalPoolConfig({ kind: 'external', connection, ca: CA });
		assert.strictEqual(config.connectionString, undefined);
		assert.strictEqual(config.host, 'db.example.com');
		assert.strictEqual(config.port, 6543);
		assert.strictEqual(config.password, PASSWORD);
	});

	test('always verifies: the given authority, or the system trust store', () => {
		assert.deepStrictEqual(externalPoolConfig({ kind: 'external', connection, ca: CA }).ssl, { ca: CA });
		// `true`, not `undefined`: with no `ssl` at all pg would read PGSSLMODE from the environment.
		assert.strictEqual(externalPoolConfig({ kind: 'external', connection }).ssl, true);
	});
});

function driverError(code: string, message = code): Error {
	return Object.assign(new Error(message), { code });
}

describe('errors of a connection that was not made', () => {
	const refused = [
		'ECONNREFUSED',
		'ENOTFOUND',
		'EADDRNOTAVAIL',
		'SELF_SIGNED_CERT_IN_CHAIN',
		'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
		'ERR_TLS_CERT_ALTNAME_INVALID',
		'28P01',
		'28000',
		'3D000',
		'53300',
	];
	for (const code of refused) {
		test(`${code} is ConnectionFailed and is not tried again`, () => {
			const error = driverError(code);
			assert.ok(isConnectionRefused(error));
			assert.ok(!isConnectionLost(error));
			const quiet = console.error;
			console.error = () => {};
			try {
				assert.throws(
					() => translatePgError(error, 'PgEngine'),
					(e: unknown) => isBlocksError(e, DatabaseErrors.ConnectionFailed),
				);
			} finally {
				console.error = quiet;
			}
		});
	}

	test('a statement error stays QueryFailed', () => {
		assert.ok(!isConnectionRefused(driverError('42601')));
		assert.ok(!isConnectionRefused(new Error('boom')));
	});

	for (const [code, name, status] of [
		['23514', DatabaseErrors.CheckViolation, 400],
		['23502', DatabaseErrors.NotNullViolation, 400],
		['23503', DatabaseErrors.ForeignKeyViolation, 409],
	] as const) {
		test(`${code} is ${name}, HTTP ${status}, with a message that has no value of the row`, () => {
			const error = Object.assign(new Error('Failing row contains (secret-value, null).'), { code });
			assert.throws(
				() => translatePgError(error, 'PgEngine'),
				(e: unknown) => {
					assert.ok(e instanceof ApiError && isBlocksError(e, name));
					assert.strictEqual(e.status, status);
					assert.ok(!e.message.includes('secret-value'));
					assert.ok(!JSON.stringify(e).includes('secret-value'), 'the cause is not serialized');
					assert.strictEqual(e.cause, error);
					return true;
				},
			);
		});
	}

	test('a connect that timed out is not a lost connection, so it is not tried again', () => {
		assert.ok(!isConnectionLost(new Error('Connection terminated due to connection timeout')));
		assert.ok(!isConnectionLost(new Error('timeout exceeded when trying to connect')));
		assert.ok(isConnectionLost(new Error('Connection terminated unexpectedly')));
		assert.ok(isConnectionLost(driverError('ECONNRESET')));
	});
});

// A client that behaves like pg's: an EventEmitter, so an `error` event with no listener throws.
class EmittingClient extends EventEmitter implements PgPoolClient {
	readonly statements: { sql: string; params?: unknown[] }[] = [];
	released = 0;
	async query(sql: string, params?: unknown[]): Promise<pg.QueryResult> {
		this.statements.push({ sql, params });
		return { rows: [], rowCount: 0, command: sql.split(' ')[0], oid: 0, fields: [] };
	}
	release(): void {
		this.released++;
	}
}

class OneClientPool implements PgPool {
	readonly client = new EmittingClient();
	queries = 0;
	failQuery?: Error;
	async connect(): Promise<PgPoolClient> {
		return this.client;
	}
	async query(sql: string, params?: unknown[]): Promise<pg.QueryResult> {
		this.queries++;
		if (this.failQuery) throw this.failQuery;
		return this.client.query(sql, params);
	}
	async end(): Promise<void> {}
}

const connection = parseConnectionString(url(), 'The value');

describe('PgEngine and a connection that ends', () => {
	test('a connection that ends between two statements of a transaction does not end the process', async () => {
		const pool = new OneClientPool();
		const engine = new PgEngine({ kind: 'external', connection, pool });
		const quiet = console.warn;
		console.warn = () => {};
		try {
			const handle = await engine.beginTransaction();
			// Without a listener, emit() throws: that is how Node ends a process on an unhandled `error` event.
			assert.doesNotThrow(() => pool.client.emit('error', driverError('57P01', 'terminating connection')));
			await engine.rollbackTransaction(handle);
		} finally {
			console.warn = quiet;
		}
		assert.strictEqual(pool.client.released, 1);
		assert.strictEqual(pool.client.listenerCount('error'), 0, 'the listener goes when the client is returned');
	});

	test('the listener goes with a commit too', async () => {
		const pool = new OneClientPool();
		const engine = new PgEngine({ kind: 'external', connection, pool });
		await engine.commitTransaction(await engine.beginTransaction());
		assert.strictEqual(pool.client.listenerCount('error'), 0);
	});

	test('a statement whose connect timed out is not sent again', async () => {
		const pool = new OneClientPool();
		pool.failQuery = new Error('Connection terminated due to connection timeout');
		const engine = new PgEngine({ kind: 'external', connection, pool });
		await assert.rejects(engine.query('SELECT 1'), (e: unknown) =>
			isBlocksError(e, DatabaseErrors.ConnectionFailed),
		);
		assert.strictEqual(pool.queries, 1);
	});
});

describe('DatabaseCluster.fromExisting()', () => {
	const source = { get: async () => url() };

	test('returns a plain reference and reads nothing', () => {
		let reads = 0;
		const counted = {
			get: async () => {
				reads++;
				return url();
			},
		};
		const ref = DatabaseCluster.fromExisting({ connectionString: counted, ca: CA });
		assert.strictEqual(ref.type, 'external');
		assert.strictEqual(ref.ca, CA);
		assert.strictEqual(reads, 0);
		assert.deepStrictEqual(DatabaseCluster.fromExisting({ name: 'db-url' }), {
			__brand: 'ExistingClusterRef',
			type: 'external',
			name: 'db-url',
		});
	});

	test('needs exactly one of name and connectionString', () => {
		configError(() => DatabaseCluster.fromExisting({}), /exactly one/);
		configError(() => DatabaseCluster.fromExisting({ name: 'db-url', connectionString: source }), /exactly one/);
	});

	test('a connection string written in code is refused', () => {
		// @ts-expect-error: a string is not a source; the value never belongs in code
		configError(() => DatabaseCluster.fromExisting({ connectionString: url() }), /never written in code/);
	});

	test('name and ca are checked', () => {
		configError(() => DatabaseCluster.fromExisting({ name: '/a/b' }), /'name'/);
		configError(() => DatabaseCluster.fromExisting({ name: 'db-url', ca: './prod-ca.crt' }), /PEM text/);
	});

	test('a block on it reports kind external and lives in public unless it names a schema', () => {
		const scope = freshScope('ext');
		const db = new Database(scope, 'db', { cluster: DatabaseCluster.fromExisting({ connectionString: source }) });
		assert.deepStrictEqual(db.cluster, { kind: 'external', id: 'external' });
		assert.strictEqual(db.schemaName, 'public');
		const other = new Database(scope, 'reports', {
			cluster: DatabaseCluster.fromExisting({ connectionString: source }),
			schemaName: 'reports',
		});
		assert.strictEqual(other.schemaName, 'reports');
	});

	test('two blocks on one database may not share a schema; two databases may both use public', () => {
		const scope = freshScope('ext');
		new Database(scope, 'a', { cluster: DatabaseCluster.fromExisting({ name: 'main' }) });
		configError(
			() => new Database(scope, 'b', { cluster: DatabaseCluster.fromExisting({ name: 'main' }) }),
			/both use schema/,
		);
		new Database(scope, 'c', { cluster: DatabaseCluster.fromExisting({ name: 'other' }) });
	});

	test('a stored value that is not a connection string stops the first statement, naming the local setting', async () => {
		const db = new Database(freshScope('ext'), 'db', {
			cluster: DatabaseCluster.fromExisting({ connectionString: { get: async () => 'not-set-yet' } }),
		});
		await assert.rejects(db.query(sql`SELECT 1`), (e: unknown) => isBlocksError(e, CONFIG_ERROR));
	});
});

// The catalog an external run reads: the server version and an empty ledger.
class ExternalEngine extends RecordingEngine {
	constructor(private readonly serverVersion: number) {
		super();
	}
	protected override answer(sql: string): unknown[] {
		if (sql === 'SHOW server_version_num') return [{ server_version_num: String(this.serverVersion) }];
		return [];
	}
}

const inFileTransaction = (engine: RecordingEngine): string[] =>
	engine.calls.filter((c) => c.handle !== undefined || /^(BEGIN|COMMIT|ROLLBACK)$/.test(c.sql)).map((c) => c.sql);

describe('migrations on an existing database', () => {
	const files = { '001_items.sql': 'CREATE TABLE items (id int);\nINSERT INTO items VALUES (1);' };

	test('the file check is not applied: PostgreSQL reports what it refuses', () => {
		assert.doesNotThrow(() =>
			lintMigrationFiles({ '001.sql': 'BEGIN; CREATE INDEX CONCURRENTLY i ON t (c); COMMIT;' }, 'external'),
		);
	});

	test('one transaction per file: the limits in one query, the statements, RESET ALL, the ledger row, COMMIT', async () => {
		const engine = new ExternalEngine(170006);
		const { applied } = await runMigrationPlan(engine, buildMigrationPlan(files, 'external'), {
			schemaName: 'public',
			log: () => {},
		});
		assert.deepStrictEqual(applied, ['001_items.sql']);
		const statements = engine.calls.filter((c) => c.handle !== undefined).map((c) => c.sql);
		assert.deepStrictEqual(statements, [
			'BEGIN',
			'SET LOCAL idle_in_transaction_session_timeout = 60000',
			'CREATE TABLE items (id int)',
			'INSERT INTO items VALUES (1)',
			'RESET ALL',
			'INSERT INTO "public"."_migrations" (name) VALUES ($1)',
			'COMMIT',
		]);
		const handles = new Set(engine.calls.filter((c) => c.handle !== undefined).map((c) => c.handle));
		assert.strictEqual(handles.size, 1, 'the ledger row is written in the transaction of the file');
	});

	test('in the migration function the server also bounds the statements, and the transaction from PostgreSQL 17', async () => {
		const settings = async (version: number) => {
			const engine = new ExternalEngine(version);
			await runMigrationPlan(engine, buildMigrationPlan(files, 'external'), {
				schemaName: 'public',
				boundToInvocation: true,
				log: () => {},
			});
			return inFileTransaction(engine).filter((s) => s.startsWith('SET LOCAL'));
		};
		// One query, so the limits cost one round trip per file whatever their number.
		assert.deepStrictEqual(await settings(160004), [
			'SET LOCAL idle_in_transaction_session_timeout = 60000; SET LOCAL statement_timeout = 540000',
		]);
		assert.deepStrictEqual(await settings(170006), [
			'SET LOCAL idle_in_transaction_session_timeout = 60000; SET LOCAL statement_timeout = 540000; ' +
				'SET LOCAL transaction_timeout = 540000',
		]);
	});

	test('a schema other than public is set for the transaction only', async () => {
		const engine = new ExternalEngine(170006);
		await runMigrationPlan(engine, buildMigrationPlan(files, 'external'), { schemaName: 'reports', log: () => {} });
		assert.deepStrictEqual(
			inFileTransaction(engine).filter((s) => s.startsWith('SET LOCAL')),
			['SET LOCAL idle_in_transaction_session_timeout = 60000; SET LOCAL search_path TO "reports", "public"'],
		);
	});

	test("a file's own SET of a limit the runner applies is skipped, so the limit holds for the whole file", async () => {
		// Every pg_dump file starts with these lines. A plain SET after the runner's SET LOCAL replaces it.
		const dump = {
			'000_baseline.sql':
				'SET statement_timeout = 0;\nSET lock_timeout = 0;\nSET idle_in_transaction_session_timeout = 0;\n' +
				'SET transaction_timeout = 0;\nCREATE TABLE t (id int);',
		};
		const sent = async (boundToInvocation: boolean) => {
			const engine = new ExternalEngine(170006);
			await runMigrationPlan(engine, buildMigrationPlan(dump, 'external'), {
				schemaName: 'public',
				boundToInvocation,
				log: () => {},
			});
			return inFileTransaction(engine).filter((s) => /^SET (?!LOCAL)/.test(s));
		};
		// From the command line the runner applies the idle limit only; the others are the file's to set.
		assert.deepStrictEqual(await sent(false), [
			'SET statement_timeout = 0',
			'SET lock_timeout = 0',
			'SET transaction_timeout = 0',
		]);
		// In the migration function it also bounds the statement and the transaction.
		assert.deepStrictEqual(await sent(true), ['SET lock_timeout = 0']);
	});

	test("a pg_dump file's SET transaction_timeout is skipped below PostgreSQL 17 and sent from 17", async () => {
		const dump = {
			'000_baseline.sql': 'SET statement_timeout = 0;\nSET transaction_timeout = 0;\nCREATE TABLE t (id int);',
		};
		const run = async (version: number) => {
			const engine = new ExternalEngine(version);
			await runMigrationPlan(engine, buildMigrationPlan(dump, 'external'), {
				schemaName: 'public',
				log: () => {},
			});
			return engine.statements.includes('SET transaction_timeout = 0');
		};
		assert.strictEqual(await run(150014), false);
		assert.strictEqual(await run(170006), true);
	});

	test('a failure names the file, the statement, the SQLSTATE and the server message, and nothing is recorded', async () => {
		const engine = new ExternalEngine(170006);
		const server = Object.assign(new Error('relation "missing" does not exist'), { code: '42P01' });
		engine.failOn.set('INSERT INTO items VALUES (1)', new Error('The database query failed', { cause: server }));
		await assert.rejects(
			runMigrationPlan(engine, buildMigrationPlan(files, 'external'), { schemaName: 'public', log: () => {} }),
			(e: unknown) => {
				assert.ok(isBlocksError(e, MIGRATION_FAILED_ERROR_NAME));
				const message = (e as Error).message;
				assert.match(message, /001_items\.sql failed at statement 2 of 2: INSERT INTO items VALUES \(1\)/);
				assert.match(message, /SQLSTATE 42P01: relation "missing" does not exist/);
				assert.match(message, /Nothing from the file was applied/);
				return true;
			},
		);
		assert.ok(engine.statements.includes('ROLLBACK'));
		assert.ok(!engine.statements.some((s) => s.startsWith('INSERT INTO "public"."_migrations"')));
	});

	test('a file that another run recorded first is rolled back with a message that says so', async () => {
		const engine = new ExternalEngine(170006);
		const duplicate = Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' });
		engine.failOn.set(
			/^INSERT INTO "public"\."_migrations"/,
			new Error('The item violates a unique constraint', { cause: duplicate }),
		);
		await assert.rejects(
			runMigrationPlan(engine, buildMigrationPlan(files, 'external'), { schemaName: 'public', log: () => {} }),
			(e: unknown) => {
				assert.ok(isBlocksError(e, MIGRATION_FAILED_ERROR_NAME));
				assert.match((e as Error).message, /applied by another run at the same time/);
				return true;
			},
		);
		assert.strictEqual(engine.statements.at(-1), 'ROLLBACK');
	});
});

describe('a connection string that the application stored itself', () => {
	// AppSetting.put() and Secret.put() store the value as JSON, so the parameter holds the string in quotes.
	const fake = (value: string) =>
		({ send: async () => ({ Parameter: { Value: value } }) }) as unknown as NonNullable<
			Parameters<typeof readSsmConnectionString>[1]
		>;

	test('a JSON-encoded value is decoded, as the app decodes it at run time', async () => {
		const url = `postgresql://app:${PASSWORD}@db.example.com:6543/postgres`;
		const stored = await readSsmConnectionString('/stack-db-url', fake(JSON.stringify(url)));
		assert.strictEqual(stored.value, url);
		assert.strictEqual(parseConnectionString(stored.value, stored.label).host, 'db.example.com');
	});

	test('a value that `npm run db -- connect --stage` stored as it is stays as it is', async () => {
		const url = `postgresql://app:${PASSWORD}@db.example.com:6543/postgres`;
		assert.strictEqual((await readSsmConnectionString('/stack-db-url', fake(url))).value, url);
	});
});

describe('the lines that connect prints', () => {
	const result = {
		ok: true as const,
		name: 'db-url',
		stored: 'local' as const,
		tls: { verified: true as const, trust: 'system' as const },
		host: { ipv4: true },
		server: { version: '17.6' },
		role: { name: 'postgres', superuser: false, bypassRls: true, canSetRole: [] },
		policies: { usingAuthFunctions: [] },
		warnings: [],
	};

	test('name the directory that `db migrate` applies, so a deploy runs the same files', () => {
		// The block's own default is cdk-blocks/migrations/<id>; without this line a deploy finds no file.
		assert.match(linesToPaste(result, true), /\n {2}migrationsPath: '\.\/migrations',\n/);
	});

	test('do not name a directory that does not exist: an explicit path must exist', () => {
		const lines = linesToPaste(result, false);
		assert.doesNotMatch(lines, /^ {2}migrationsPath/m);
		assert.match(lines, /migrationsPath: '\.\/migrations'/, 'the option is shown as a comment');
	});
});

describe('the Lambda entry on an existing database', () => {
	test('is constructible with no stack name, as the tools that load it need; the first statement then fails', async () => {
		const stackName = process.env.BLOCKS_STACK_NAME;
		delete process.env.BLOCKS_STACK_NAME;
		try {
			// Client generation loads this entry on the developer machine, where there is no deployed stack.
			const db = new LambdaDatabase(freshScope('ext-aws'), 'db', {
				cluster: LambdaDatabaseCluster.fromExisting({ name: 'db-url' }),
			});
			assert.deepStrictEqual(db.cluster, { kind: 'external', id: 'external' });
			await assert.rejects(db.query(sql`SELECT 1`), (e: unknown) => {
				assert.ok(isBlocksError(e, CONFIG_ERROR));
				assert.match((e as Error).message, /BLOCKS_STACK_NAME is not set/);
				return true;
			});
		} finally {
			if (stackName !== undefined) process.env.BLOCKS_STACK_NAME = stackName;
		}
	});

	test("reads the app's own source with the first statement, not in the constructor", async () => {
		let reads = 0;
		const source = {
			get: async () => {
				reads++;
				return 'not-a-connection-string';
			},
		};
		const db = new LambdaDatabase(freshScope('ext-aws'), 'db', {
			cluster: LambdaDatabaseCluster.fromExisting({ connectionString: source }),
		});
		assert.strictEqual(reads, 0);
		await assert.rejects(db.query(sql`SELECT 1`), (e: unknown) => isBlocksError(e, CONFIG_ERROR));
		assert.strictEqual(reads, 1);
	});
});

describe('asRole()', () => {
	test('each statement is one transaction that starts with the role and the claims as bound parameters', async () => {
		const pool = new OneClientPool();
		const engine = new PgEngine({ kind: 'external', connection, pool });
		const parent = {
			cluster: { kind: 'external' as const, id: 'external' },
			schemaName: 'public',
			fullId: 'app-db',
		};
		registerInternalAccess(parent, {
			engine: async () => engine,
			session: () => {
				throw new Error('not used');
			},
			simulateConflict: () => {},
			migrationsPath: undefined,
		});
		await roleDatabase(parent, 'authenticated', { sub: 'user-1' }).query(sql`SELECT ${1}::int AS n`);
		assert.deepStrictEqual(pool.client.statements, [
			{ sql: 'BEGIN', params: undefined },
			{
				sql: "SELECT set_config('role', $1, true), set_config('request.jwt.claims', $2, true)",
				params: ['authenticated', '{"sub":"user-1"}'],
			},
			{ sql: 'SELECT $1::int AS n', params: [1] },
			{ sql: 'COMMIT', params: undefined },
		]);
		pool.client.statements.length = 0;
		await roleDatabase(parent, 'anon').query(sql`SELECT 1`);
		assert.deepStrictEqual(pool.client.statements[1].params, ['anon', '{}']);
	});

	test('needs a role name, and is refused on a dsql cluster', () => {
		const dsql = { cluster: { kind: 'dsql' as const, id: 'default' }, schemaName: 'public', fullId: 'app-db' };
		configError(() => roleDatabase(dsql, 'authenticated'), /Aurora DSQL/);
		const external = {
			cluster: { kind: 'external' as const, id: 'external' },
			schemaName: 'public',
			fullId: 'app-db',
		};
		configError(() => roleDatabase(external, ''), /name of a database role/);
	});
});

describe('DatabaseCluster.fromExisting({ dataApi })', () => {
	const dataApi = {
		clusterArn: 'arn:aws:rds:us-east-1:123456789012:cluster:app',
		secretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:app-AbCdEf',
		database: 'app',
	};

	test('returns a plain reference with the three values', () => {
		assert.deepStrictEqual(DatabaseCluster.fromExisting({ dataApi }), {
			__brand: 'ExistingClusterRef',
			type: 'external',
			dataApi,
		});
	});

	test('is one of three sources, takes no ca, and needs all three values', () => {
		configError(() => DatabaseCluster.fromExisting({ name: 'db-url', dataApi }), /exactly one/);
		configError(() => DatabaseCluster.fromExisting({ dataApi, ca: CA }), /'ca' is for a connection string/);
		configError(() => DatabaseCluster.fromExisting({ dataApi: { ...dataApi, database: '' } }), /dataApi\.database/);
		// @ts-expect-error: the secret is required
		configError(() => DatabaseCluster.fromExisting({ dataApi: { clusterArn: 'a', database: 'd' } }), /secretArn/);
	});

	test('a block on it is external, in public, and cannot name another schema', () => {
		const scope = freshScope('ext-data-api');
		const db = new Database(scope, 'db', { cluster: DatabaseCluster.fromExisting({ dataApi }) });
		assert.deepStrictEqual(db.cluster, { kind: 'external', id: 'external' });
		assert.strictEqual(db.schemaName, 'public');
		configError(
			() =>
				new Database(scope, 'other', { cluster: DatabaseCluster.fromExisting({ dataApi }), schemaName: 'app' }),
			/reached through the RDS Data API has the schema\s+'public'/,
		);
	});

	test('two blocks on one cluster and database claim the same schema', () => {
		const scope = freshScope('ext-data-api');
		new Database(scope, 'a', { cluster: DatabaseCluster.fromExisting({ dataApi }) });
		configError(
			() => new Database(scope, 'b', { cluster: DatabaseCluster.fromExisting({ dataApi }) }),
			/both use schema 'public'/,
		);
		// Another database of the same cluster is another place.
		new Database(scope, 'c', {
			cluster: DatabaseCluster.fromExisting({ dataApi: { ...dataApi, database: 'two' } }),
		});
	});

	test('the migration runner sends its settings one by one to an engine that takes one statement in a call', async () => {
		class OneStatementEngine extends ExternalEngine {
			readonly oneStatementPerCall = true;
		}
		const engine = new OneStatementEngine(160004);
		await runMigrationPlan(
			engine,
			buildMigrationPlan({ '001_items.sql': 'CREATE TABLE items (id int);' }, 'external'),
			{
				schemaName: 'public',
				boundToInvocation: true,
				log: () => {},
			},
		);
		assert.deepStrictEqual(
			inFileTransaction(engine).filter((s) => s.startsWith('SET LOCAL')),
			['SET LOCAL idle_in_transaction_session_timeout = 60000', 'SET LOCAL statement_timeout = 540000'],
		);
	});
});
