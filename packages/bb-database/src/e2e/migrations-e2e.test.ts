// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * E2E test: `bb-database migrate`, `status` and `types` against a real Supabase database.
 *
 * Ports `packages/bb-data/src/crud/migrations-e2e.test.ts`. Everything under test goes through the block's CLI
 * as a child process (`dist/cli.js`, `--output json`), in a fresh project directory per `describe`:
 * `connect --name e2e` stores the connection string locally, then `migrate <dir> --name e2e --yes`.
 *
 *   - "runMigrations": applies a file and records it, skips applied files, applies the second file in order,
 *     rolls back a bad file and does not record it.
 *   - "external migrate + type refresh": applies the CREATE, the generated types show the new table, a delta
 *     file shows the new column, applying again applies nothing.
 *   - "run-all baseline": a real `pg_dump --schema-only` baseline rebuilds a schema on an empty target.
 *
 * Not ported: "refresh preserves a hand-edited singular". The singular was metadata of bb-data's `crud()`
 * (`database.meta.ts`); this block generates one `Tables` interface and has no such file.
 * The original's "session port + advisory lock" wording does not apply: the runner takes no lock, and connects
 * to the port of the string it is given.
 *
 * Added: `status` before and after each step; `migrate` refuses to run when it cannot ask; the ledger keeps the
 * columns the bb-data runner gave it; nothing of a baseline file is left on a later connection.
 *
 * Tables, schema and file names are the originals', so the cleanup of either suite removes what the other left
 * behind. For the same reason the two suites must not run at the same time on one project: the root
 * `test:e2e:supabase` script runs its files one after the other.
 *
 * Direct SQL (`pg`, TLS verified against the pinned CA) is used for setup, cleanup and for reading what the CLI
 * did. Requires env var SUPABASE_DB_URL; skips when it is not set.
 */
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { after, before, describe, test } from 'node:test';
import {
	type ConnectReport,
	columnsOf,
	connectionFields,
	env,
	failure,
	type MarkAppliedReport,
	type MigrateReport,
	need,
	onFreshConnection,
	openDb,
	outputOf,
	type Plumbing,
	redact,
	report,
	runCli,
	type StatusReport,
	type TypesReport,
	type Workspace,
	withPort,
	workspace,
} from './support.js';

const skip = !env.dbUrl;

/** The name of the connection in the local settings store of each project directory. */
const NAME = 'e2e';

/** The ledger as the bb-data runner creates it (`packages/data-common/src/migrations.ts`). */
const LEGACY_LEDGER = `
	CREATE TABLE IF NOT EXISTS public._migrations (
		id SERIAL PRIMARY KEY,
		name TEXT NOT NULL UNIQUE,
		applied_at TIMESTAMP NOT NULL DEFAULT NOW()
	)
`;

/**
 * `connect --name e2e --ca <file> --value-stdin`: stores the string in `<cwd>/.cdk-blocks/local/data/settings.json`.
 */
async function connect(ws: Workspace, connectionString: string): Promise<ConnectReport> {
	const run = await runCli(
		['connect', '--name', NAME, '--ca', ws.caFile, '--value-stdin', '--no-input', '--output', 'json'],
		{ cwd: ws.cwd, stdin: `${connectionString}\n` },
	);
	const connected = report<ConnectReport>(run);
	assert.strictEqual(connected.stored, 'local', 'connect stores the string in the local settings store');
	return connected;
}

/** `migrate <dir> --name e2e --yes --no-input --output json`, plus `extra`. */
function migrate(ws: Workspace, dir: string, ...extra: string[]) {
	return runCli(['migrate', dir, '--name', NAME, '--yes', '--no-input', '--output', 'json', ...extra], {
		cwd: ws.cwd,
	});
}

async function status(ws: Workspace, dir: string): Promise<StatusReport> {
	const run = await runCli(['status', dir, '--name', NAME, '--no-input', '--output', 'json'], { cwd: ws.cwd });
	const listed = report<StatusReport>(run);
	assert.ok(Array.isArray(listed.applied) && Array.isArray(listed.pending), 'status lists applied and pending');
	return listed;
}

/** The names in `public._migrations` among `names`, sorted. */
async function recorded(db: Plumbing, names: string[]): Promise<string[]> {
	const rows = await db.query<{ name: string }>(
		'SELECT name FROM public._migrations WHERE name = ANY($1::text[]) ORDER BY name',
		[names],
	);
	return rows.map((r) => r.name);
}

/** The host of the connection string, which `migrate` reports as the database it ran on. */
const hostOf = (connectionString: string) => connectionFields(connectionString).host;

describe('bb-database migrate E2E: Supabase', { skip }, () => {
	const url = need(env.dbUrl, 'SUPABASE_DB_URL');
	let ws: Workspace;
	let db: Plumbing;
	let dir: string;
	let ledgerColumns: string[];

	const TABLE = '_test_migrate_e2e';
	const CREATE_FILE = '9999_create_test_table.sql';
	const ADD_FILE = '9999_add_column.sql';
	const BAD_FILE = '9999_bad_migration.sql';
	const ALL = [CREATE_FILE, ADD_FILE, BAD_FILE];

	// Clean up: drop test table and migration tracking entries
	const cleanup = async () => {
		await db.exec(`DROP TABLE IF EXISTS public.${TABLE}`);
		await db.exec(`DELETE FROM public._migrations WHERE name LIKE '9999_%'`);
	};

	before(async () => {
		ws = workspace('bbdb-migrate-e2e-');
		dir = join(ws.cwd, 'migrations');
		mkdirSync(dir);
		db = openDb(url);
		// The project of the suite has the ledger of the bb-data runner, with its `id` column. Created here
		// when it is absent, so the upgrade case below does not depend on which suite ran first.
		await db.exec(LEGACY_LEDGER);
		// What a run that died left behind.
		await cleanup();
		ledgerColumns = await columnsOf(db, '_migrations');
		await connect(ws, url);
	});

	after(async () => {
		if (db) {
			await cleanup();
			await db.end();
		}
		ws?.remove();
	});

	test('status lists a file that was not applied as pending', async () => {
		writeFileSync(
			join(dir, CREATE_FILE),
			`
        CREATE TABLE IF NOT EXISTS ${TABLE} (
          id serial PRIMARY KEY,
          value text NOT NULL
        );
      `,
		);
		const listed = await status(ws, dir);
		assert.deepStrictEqual(listed.pending, [CREATE_FILE]);
		assert.ok(!listed.applied.includes(CREATE_FILE), 'the file is not listed as applied');
	});

	test('migrate does not run when it cannot ask and --yes is absent (exit code 2)', async () => {
		const run = await runCli(['migrate', dir, '--name', NAME, '--no-input', '--output', 'json'], { cwd: ws.cwd });
		assert.strictEqual(run.code, 2, `a usage error${outputOf(run)}`);
		assert.deepStrictEqual(await recorded(db, ALL), [], 'nothing was recorded');
		assert.deepStrictEqual(await columnsOf(db, TABLE), [], 'nothing was applied');
	});

	test('applies a migration and tracks it', async () => {
		const result = report<MigrateReport>(await migrate(ws, dir, '--no-types'));
		assert.deepStrictEqual(result.applied, [CREATE_FILE]);
		assert.ok(
			typeof result.host === 'string' && result.host.includes(hostOf(url)),
			'migrate reports the host it ran on',
		);
		assert.strictEqual(result.types, undefined, '--no-types writes no types file');
		assert.ok(!existsSync(join(ws.cwd, 'cdk-blocks', 'database.types.ts')), '--no-types writes no types file');

		// Verify table exists
		assert.deepStrictEqual(await columnsOf(db, TABLE), ['id', 'value']);
		// Verify it is tracked
		assert.deepStrictEqual(await recorded(db, ALL), [CREATE_FILE]);
	});

	test('status lists the file as applied after migrate', async () => {
		const listed = await status(ws, dir);
		assert.deepStrictEqual(listed.pending, []);
		assert.ok(listed.applied.includes(CREATE_FILE), 'the file is listed as applied');
	});

	test('skips already-applied migrations', async () => {
		// The same name with a statement that fails when it runs again: an applied file is skipped by name.
		writeFileSync(join(dir, CREATE_FILE), `CREATE TABLE ${TABLE} (id serial PRIMARY KEY, value text NOT NULL);`);
		const result = report<MigrateReport>(await migrate(ws, dir, '--no-types'));
		assert.deepStrictEqual(result.applied, [], 'Should skip already-applied migration');
	});

	test('applies second migration in order', async () => {
		writeFileSync(
			join(dir, ADD_FILE),
			`ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS extra boolean DEFAULT false;`,
		);
		const before = await status(ws, dir);
		assert.deepStrictEqual(before.pending, [ADD_FILE]);
		assert.ok(before.applied.includes(CREATE_FILE) && !before.applied.includes(ADD_FILE));

		const result = report<MigrateReport>(await migrate(ws, dir, '--no-types'));
		assert.deepStrictEqual(result.applied, [ADD_FILE]);

		// Verify column exists
		assert.deepStrictEqual(await columnsOf(db, TABLE), ['id', 'value', 'extra']);
		assert.deepStrictEqual(await recorded(db, ALL), [ADD_FILE, CREATE_FILE]);

		const after = await status(ws, dir);
		assert.deepStrictEqual(after.pending, []);
		assert.ok(after.applied.includes(CREATE_FILE) && after.applied.includes(ADD_FILE));
	});

	test('rolls back on failure', async () => {
		// The first statement is valid, so there is something to roll back; the original's first statement was
		// not (`ADD COLUMN oops` with no type), which left the rollback itself unproven.
		writeFileSync(join(dir, BAD_FILE), `ALTER TABLE ${TABLE} ADD COLUMN oops text; THIS IS INVALID SQL;`);
		const run = await migrate(ws, dir, '--no-types');
		const error = failure(run, 1);
		// Design 10.5: a failure names the file and the SQLSTATE (42601, syntax error).
		assert.ok(error.message.includes(BAD_FILE), 'the error names the file');
		assert.ok(error.message.includes('42601'), 'the error carries the SQLSTATE');

		// Verify the bad migration was NOT tracked
		assert.deepStrictEqual(await recorded(db, [BAD_FILE]), [], 'Failed migration should not be tracked');
		// and that its first statement did not stay
		assert.deepStrictEqual(await columnsOf(db, TABLE), ['id', 'value', 'extra'], 'the file was rolled back');
		// and that the files before it are still recorded
		assert.deepStrictEqual(await recorded(db, ALL), [ADD_FILE, CREATE_FILE]);
	});

	test('status lists the failed file as pending', async () => {
		const listed = await status(ws, dir);
		assert.deepStrictEqual(listed.pending, [BAD_FILE]);
		assert.ok(listed.applied.includes(CREATE_FILE) && listed.applied.includes(ADD_FILE));
		assert.ok(!listed.applied.includes(BAD_FILE));
	});

	test('the ledger of the bb-data runner is used as it is: its columns do not change', async () => {
		assert.ok(ledgerColumns.includes('name') && ledgerColumns.includes('applied_at'), 'the ledger was there');
		assert.deepStrictEqual(await columnsOf(db, '_migrations'), ledgerColumns);
	});
});

/**
 * E2E: the dev-loop flow: apply a migration with `migrate`, which then refreshes the generated types, against a
 * real Supabase DB.
 *
 * Asserts the customer-visible promise: after a migration, the generated `cdk-blocks/database.types.ts`
 * reflects the new schema. Idempotent re-application applies nothing.
 *
 * Uses the originals' non-underscore table name with a distinctive prefix, and high migration numbers, cleaned
 * up in after().
 */
describe('bb-database migrate + types E2E: Supabase', { skip }, () => {
	const url = need(env.dbUrl, 'SUPABASE_DB_URL');
	let ws: Workspace;
	let db: Plumbing;
	let typesFile: string;

	const TABLE = 'regen_e2e_widgets';
	const CREATE_FILE = '9990_create_regen_e2e_widgets.sql';
	const ALTER_FILE = '9991_add_regen_e2e_priority.sql';
	// Relative to the project directory, as a developer types it.
	const DIR = 'migrations';

	const cleanup = async () => {
		await db.exec(`DROP TABLE IF EXISTS public.${TABLE}`);
		await db.query('DELETE FROM public._migrations WHERE name IN ($1, $2)', [CREATE_FILE, ALTER_FILE]);
	};

	/**
	 * The part of the generated file that declares `table`: the braces after its property in `Tables` when the
	 * columns are written there, otherwise the whole file (the property may name a type declared elsewhere).
	 */
	const declarationOf = (file: string, table: string): string => {
		const start = new RegExp(`['"]?\\b${table}\\b['"]?\\??:\\s*\\{`).exec(file);
		if (!start) return file;
		let depth = 0;
		for (let i = start.index + start[0].length - 1; i < file.length; i++) {
			if (file[i] === '{') depth++;
			if (file[i] === '}' && --depth === 0) return file.slice(start.index, i + 1);
		}
		return file;
	};

	/** A column with the given type, with or without quotes around the name. `type` is a regular expression. */
	const column = (name: string, type: string) => new RegExp(`['"]?\\b${name}\\b['"]?\\??:\\s*${type}`);

	before(async () => {
		ws = workspace('bbdb-types-e2e-');
		typesFile = join(ws.cwd, 'cdk-blocks', 'database.types.ts');
		mkdirSync(join(ws.cwd, DIR));
		db = openDb(url);
		await db.exec(LEGACY_LEDGER);
		// Clean slate so the CREATE migration is genuinely pending.
		await cleanup();
		writeFileSync(
			join(ws.cwd, DIR, CREATE_FILE),
			`CREATE TABLE ${TABLE} (id serial PRIMARY KEY, name text NOT NULL); ALTER TABLE ${TABLE} ENABLE ROW LEVEL SECURITY;`,
		);
		await connect(ws, url);
	});

	after(async () => {
		if (db) {
			await cleanup();
			await db.end();
		}
		ws?.remove();
	});

	test('migrate applies the CREATE', async () => {
		const result = report<MigrateReport>(await migrate(ws, DIR));
		assert.deepStrictEqual(result.applied, [CREATE_FILE]);
		assert.deepStrictEqual(await columnsOf(db, TABLE), ['id', 'name']);
		// migrate then refreshes the types, at the default path.
		assert.ok(typeof result.types === 'string', 'migrate reports the types file it wrote');
		assert.strictEqual(realpathSync(resolve(ws.cwd, result.types)), typesFile);
	});

	test('the generated types reflect the new table', async () => {
		const written = readFileSync(typesFile, 'utf8');
		assert.match(written, /export interface Tables\b/, 'one Tables interface');
		assert.match(written, /\btype Generated</, 'Generated is declared in the file');

		assert.match(written, new RegExp(`['"]?\\b${TABLE}\\b['"]?\\??:`), 'a property for the new table');
		const widgets = declarationOf(written, TABLE);
		assert.match(widgets, column('name', 'string\\b'), 'types include the name column');
		assert.match(widgets, column('id', 'Generated<'), 'a column with a default is Generated');

		// The fixture's tables, as section 11.2 of the design maps the column types.
		assert.match(written, /['"]?\btodos\b['"]?\??:/, 'a property for todos');
		const todos = declarationOf(written, 'todos');
		assert.match(todos, column('id', 'Generated<string>'), 'uuid with a default is Generated<string>');
		assert.match(todos, column('user_id', 'string\\b'), 'uuid is string');
		assert.match(todos, column('content', 'string\\b'), 'text is string');
		assert.match(todos, column('done', 'Generated<boolean>'), 'boolean with a default is Generated<boolean>');
		const log = declarationOf(written, 'no_pk_log');
		assert.match(log, column('event_type', 'string\\b'), 'text is string');
		assert.match(log, column('created_at', 'Generated<Date>'), 'timestamptz with a default is Generated<Date>');

		// `types` on its own writes the same file and lists the tables.
		const run = await runCli(['types', '--name', NAME, '--no-input', '--output', 'json'], { cwd: ws.cwd });
		const result = report<TypesReport>(run);
		assert.strictEqual(realpathSync(resolve(ws.cwd, result.out)), typesFile);
		assert.ok(result.tables.includes(TABLE), 'the new table is listed');
		assert.ok(result.tables.includes('todos'), 'the fixture table is listed');
		assert.strictEqual(readFileSync(typesFile, 'utf8'), written, 'the same schema gives the same file');

		// connect and the refresh write these two files and no others: no scaffolding.
		assert.deepStrictEqual(readdirSync(join(ws.cwd, 'cdk-blocks')).sort(), ['database.e2e.ca.ts', 'database.types.ts']);
	});

	test('a delta migration + refresh surfaces the new column', async () => {
		writeFileSync(join(ws.cwd, DIR, ALTER_FILE), `ALTER TABLE ${TABLE} ADD COLUMN priority int;`);
		const before = await status(ws, DIR);
		assert.deepStrictEqual(before.pending, [ALTER_FILE]);
		assert.ok(before.applied.includes(CREATE_FILE) && !before.applied.includes(ALTER_FILE));

		const result = report<MigrateReport>(await migrate(ws, DIR));
		assert.deepStrictEqual(result.applied, [ALTER_FILE], 'only the new delta applies');

		const widgets = declarationOf(readFileSync(typesFile, 'utf8'), TABLE);
		assert.match(widgets, /\bpriority\b/, 'refreshed types include the new priority column');
		assert.match(widgets, column('priority', '[^;,\\n}]*\\|\\s*null'), 'a nullable column is T | null');

		const after = await status(ws, DIR);
		assert.deepStrictEqual(after.pending, []);
		assert.ok(after.applied.includes(CREATE_FILE) && after.applied.includes(ALTER_FILE));
	});

	test('re-applying is idempotent (nothing pending)', async () => {
		const result = report<MigrateReport>(await migrate(ws, DIR));
		assert.deepStrictEqual(result.applied, [], 'no migrations re-applied');
	});
});

/**
 * E2E: `migrate --mark-applied`, for a schema dump of what the database already has.
 *
 * The table exists before the first run, as it does in a database that was built outside the migration files.
 * The baseline file creates that table, so it fails if it runs; marked, it is recorded and the next file applies.
 */
describe('bb-database migrate --mark-applied E2E: Supabase', { skip }, () => {
	const url = need(env.dbUrl, 'SUPABASE_DB_URL');
	let ws: Workspace;
	let db: Plumbing;

	const TABLE = 'mark_applied_e2e_widgets';
	const BASELINE = '9992_mark_applied_e2e_baseline.sql';
	const NEXT = '9993_mark_applied_e2e_note.sql';
	const DIR = 'migrations';

	const cleanup = async () => {
		await db.exec(`DROP TABLE IF EXISTS public.${TABLE}`);
		await db.query('DELETE FROM public._migrations WHERE name IN ($1, $2)', [BASELINE, NEXT]);
	};

	before(async () => {
		ws = workspace('bbdb-mark-e2e-');
		mkdirSync(join(ws.cwd, DIR));
		db = openDb(url);
		await db.exec(LEGACY_LEDGER);
		await cleanup();
		const create = `CREATE TABLE ${TABLE} (id serial PRIMARY KEY); ALTER TABLE ${TABLE} ENABLE ROW LEVEL SECURITY;`;
		await db.exec(create.replaceAll(TABLE, `public.${TABLE}`));
		writeFileSync(join(ws.cwd, DIR, BASELINE), create);
		writeFileSync(join(ws.cwd, DIR, NEXT), `ALTER TABLE ${TABLE} ADD COLUMN note text;`);
		await connect(ws, url);
	});

	after(async () => {
		if (db) {
			await cleanup();
			await db.end();
		}
		ws?.remove();
	});

	test('without the mark, the baseline fails on the database it describes and nothing is recorded', async () => {
		const error = failure(await migrate(ws, DIR, '--no-types'));
		assert.match(error.message, new RegExp(`${BASELINE} failed`));
		assert.deepStrictEqual(await recorded(db, [BASELINE, NEXT]), []);
		assert.deepStrictEqual(await columnsOf(db, TABLE), ['id']);
	});

	test('--mark-applied records the file and does not run it', async () => {
		const result = report<MarkAppliedReport>(await migrate(ws, DIR, '--mark-applied', BASELINE));
		assert.deepStrictEqual(result.marked, [BASELINE]);
		assert.deepStrictEqual(result.alreadyApplied, []);
		assert.strictEqual(result.host, connectionFields(url).host);
		assert.deepStrictEqual(await recorded(db, [BASELINE, NEXT]), [BASELINE]);
		assert.deepStrictEqual(await columnsOf(db, TABLE), ['id']);
	});

	test('status lists it as applied, and migrate applies only the file after it', async () => {
		const listed = await status(ws, DIR);
		assert.deepStrictEqual(listed.applied, [BASELINE]);
		assert.deepStrictEqual(listed.pending, [NEXT]);
		const result = report<MigrateReport>(await migrate(ws, DIR, '--no-types'));
		assert.deepStrictEqual(result.applied, [NEXT]);
		assert.deepStrictEqual(await columnsOf(db, TABLE), ['id', 'note']);
	});

	test('a second mark records nothing', async () => {
		const result = report<MarkAppliedReport>(await migrate(ws, DIR, '--mark-applied', BASELINE));
		assert.deepStrictEqual(result.marked, []);
		assert.deepStrictEqual(result.alreadyApplied, [BASELINE]);
		assert.deepStrictEqual(await recorded(db, [BASELINE, NEXT]), [BASELINE, NEXT]);
	});

	test('a name that is not a file of the directory is a usage error', async () => {
		const error = failure(await migrate(ws, DIR, '--mark-applied', '9994_not_there.sql'), 2);
		assert.strictEqual(error.name, 'UsageError');
		assert.deepStrictEqual(await recorded(db, ['9994_not_there.sql']), []);
	});
});

/**
 * E2E: the empty-DB "run-all" baseline path. A real `pg_dump --schema-only` baseline is applied to an EMPTY
 * target with `migrate`, exercising a file with: SET noise, the session-level
 * `set_config('search_path', '', false)`, a dollar-quoted function body (with a `CREATE TABLE` literal), RLS
 * enable + policy, and GRANTs.
 *
 * Isolation: everything lives in a throwaway SCRATCH SCHEMA (`bb_runall_e2e`), never `public`, so it cannot
 * touch the shared `todos` fixture.
 *
 * Requires `SUPABASE_DB_URL` AND a `pg_dump` whose major >= the server's; skips otherwise (the CI runner's
 * default `pg_dump` may be too old).
 */
let hasPgDump = false;
try {
	execFileSync('pg_dump', ['--version'], { stdio: 'pipe' });
	hasPgDump = true;
} catch {
	hasPgDump = false;
}

describe('bb-database migrate run-all baseline (empty target) E2E: Supabase', { skip: skip || !hasPgDump }, () => {
	const url = need(env.dbUrl, 'SUPABASE_DB_URL');
	// pg_dump and the setup need a session: the string as given, on the session port.
	const sessionUrl = withPort(url, '5432');
	let ws: Workspace;
	let db: Plumbing;
	let dir: string;
	let defaultSearchPath: string;
	let baselineApplied = false;

	const SCHEMA = 'bb_runall_e2e';
	const BASELINE_FILE = '000_baseline.sql';

	// Source schema (what a customer's existing DB looks like). Created in setup,
	// dumped via pg_dump, then dropped so the target is genuinely empty.
	const SETUP_SQL = `
    CREATE SCHEMA ${SCHEMA};
    CREATE TABLE ${SCHEMA}.gadgets (
      id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
      owner_id text NOT NULL,
      name text NOT NULL
    );
    CREATE FUNCTION ${SCHEMA}.note() RETURNS text LANGUAGE sql AS $$
      SELECT 'CREATE TABLE phantom (x int); not a real statement'::text
    $$;
    ALTER TABLE ${SCHEMA}.gadgets ENABLE ROW LEVEL SECURITY;
    CREATE POLICY gadgets_owner ON ${SCHEMA}.gadgets
      USING ((owner_id = ((current_setting('request.jwt.claims', true))::jsonb ->> 'sub')));
    GRANT SELECT, INSERT ON ${SCHEMA}.gadgets TO authenticated;
  `;

	const dropSchema = () => db.exec(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
	const forgetBaseline = () => db.query('DELETE FROM public._migrations WHERE name = $1', [BASELINE_FILE]);
	const searchPath = async (connectionString: string) =>
		(await onFreshConnection<{ search_path: string }>(connectionString, 'SHOW search_path'))[0]?.search_path;

	before(async () => {
		ws = workspace('bbdb-runall-e2e-');
		dir = join(ws.cwd, 'migrations');
		mkdirSync(dir);
		db = openDb(sessionUrl);
		await db.exec(LEGACY_LEDGER);
		await dropSchema();
		await forgetBaseline();
		await db.exec(SETUP_SQL);
		defaultSearchPath = need(await searchPath(url), 'the search_path of a new connection');
		await connect(ws, url);
	});

	after(async () => {
		if (db) {
			await dropSchema();
			await forgetBaseline();
			await db.end();
		}
		ws?.remove();
	});

	test('a real pg_dump baseline rebuilds the schema on an empty target (run-all)', async (t) => {
		// Generate a REAL baseline from the source schema, scoped to the scratch schema. Credentials go via PG*
		// env vars, never argv. The certificate is verified against the pinned CA, as everywhere in this suite.
		// Skip, don't fail, if pg_dump is older than the server; any other failure of pg_dump fails the test.
		const target = connectionFields(sessionUrl);
		let baselineSql: string;
		try {
			baselineSql = execFileSync('pg_dump', ['--schema-only', `--schema=${SCHEMA}`, '--no-owner'], {
				encoding: 'utf-8',
				maxBuffer: 64 * 1024 * 1024,
				stdio: ['ignore', 'pipe', 'pipe'],
				env: {
					...process.env,
					PGHOST: target.host,
					PGPORT: String(target.port),
					PGUSER: target.user,
					PGPASSWORD: target.password,
					PGDATABASE: target.database,
					PGSSLMODE: 'verify-full',
					PGSSLROOTCERT: ws.caFile,
				},
			});
		} catch (e) {
			const stderr = redact(String(e instanceof Error && 'stderr' in e ? e.stderr : '').trim());
			if (/server version mismatch/i.test(stderr)) {
				t.skip(`pg_dump is incompatible with the server: ${stderr}`);
				return;
			}
			assert.fail(`pg_dump failed: ${stderr || 'no message on stderr'}`);
		}

		// Sanity: this is genuine pg_dump output with the risky constructs we care about.
		assert.match(
			baselineSql,
			/set_config\('search_path', '', false\)/,
			'baseline resets search_path (the run-all hazard)',
		);
		assert.match(baselineSql, new RegExp(`CREATE SCHEMA ${SCHEMA}`), 'baseline recreates the schema');
		assert.match(baselineSql, /CREATE POLICY/, 'baseline includes the RLS policy');
		assert.match(baselineSql, /GRANT/, 'baseline includes grants');

		writeFileSync(join(dir, BASELINE_FILE), baselineSql);

		// Empty the target: drop the source schema so the baseline genuinely rebuilds it.
		await dropSchema();
		await forgetBaseline();

		const pending = await status(ws, dir);
		assert.deepStrictEqual(pending.pending, [BASELINE_FILE]);

		const result = report<MigrateReport>(await migrate(ws, dir, '--no-types'));
		assert.deepStrictEqual(result.applied, [BASELINE_FILE], 'baseline applied');
		baselineApplied = true;

		// The schema was rebuilt end-to-end: table, RLS policy, and grant all present.
		const tbl = await db.query<{ c: number }>(
			`SELECT count(*)::int AS c FROM pg_tables WHERE schemaname=$1 AND tablename='gadgets'`,
			[SCHEMA],
		);
		assert.strictEqual(tbl[0].c, 1, 'table rebuilt');
		const pol = await db.query<{ c: number }>(
			`SELECT count(*)::int AS c FROM pg_policies WHERE schemaname=$1 AND tablename='gadgets'`,
			[SCHEMA],
		);
		assert.strictEqual(pol[0].c, 1, 'RLS policy rebuilt');
		const grant = await db.query<{ c: number }>(
			`SELECT count(*)::int AS c FROM information_schema.role_table_grants
       WHERE table_schema=$1 AND table_name='gadgets' AND grantee='authenticated'`,
			[SCHEMA],
		);
		assert.ok(grant[0].c >= 1, 'grant to authenticated rebuilt');
		const fn = await db.query<{ note: string }>(`SELECT ${SCHEMA}.note() AS note`);
		assert.strictEqual(fn[0].note, 'CREATE TABLE phantom (x int); not a real statement', 'function rebuilt whole');

		// Tracked, and idempotent on re-run.
		const tracked = await db.query<{ name: string }>('SELECT name FROM public._migrations WHERE name = $1', [
			BASELINE_FILE,
		]);
		assert.strictEqual(tracked.length, 1, 'baseline recorded in _migrations');
		const again = report<MigrateReport>(await migrate(ws, dir, '--no-types'));
		assert.deepStrictEqual(again.applied, [], 'nothing re-applies');
		assert.deepStrictEqual((await status(ws, dir)).pending, []);
	});

	test('nothing of the baseline is left on a later connection: the default search_path', async (t) => {
		if (!baselineApplied) {
			t.skip('the baseline was not applied');
			return;
		}
		// The file set search_path to '' for its session. Connections opened after it through the same string,
		// several at a time so that more than one server connection of the pooler answers, have the default.
		const seen = await Promise.all(Array.from({ length: 5 }, () => searchPath(url)));
		assert.notStrictEqual(defaultSearchPath, '', 'the default search_path is not empty');
		assert.deepStrictEqual(
			seen,
			Array.from({ length: 5 }, () => defaultSearchPath),
		);
		// And an unqualified name still resolves to public on one of them.
		const ledger = await onFreshConnection<{ c: number }>(url, 'SELECT count(*)::int AS c FROM _migrations');
		assert.ok(ledger[0].c >= 1, 'the ledger is found without a schema name');
	});
});
