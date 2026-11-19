// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// The command line, as far as it runs with no database: arguments, exit codes, the shape of its output, and
// the types file from a local PostgreSQL (PGlite).

import assert from 'node:assert';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import type { Insertable, Generated as KyselyGenerated, Selectable } from 'kysely';
import { RecordingEngine } from '../test-support/recording-engine.js';
import { generateTypes } from './types-file.js';

const CLI = fileURLToPath(new URL('../cli.js', import.meta.url));
const cwd = mkdtempSync(join(tmpdir(), 'bb-database-cli-'));
after(() => rmSync(cwd, { recursive: true, force: true }));

interface Run {
	code: number;
	stdout: string;
	stderr: string;
}

function run(args: string[], stdin?: string, env?: Record<string, string>): Promise<Run> {
	return new Promise((resolve) => {
		const options = { cwd, env: { ...process.env, ...env } };
		const child = execFile(process.execPath, [CLI, ...args], options, (error, stdout, stderr) => {
			resolve({ code: error && typeof error.code === 'number' ? error.code : error ? 1 : 0, stdout, stderr });
		});
		child.stdin?.end(stdin ?? '');
	});
}

const json = (r: Run): { ok: boolean; error?: { name: string; message: string } } => JSON.parse(r.stdout);

describe('bb-database command line', () => {
	test('--help prints the usage and exits 0', async () => {
		const result = await run(['--help'], undefined, { BB_DATABASE_COMMAND: '' });
		assert.strictEqual(result.code, 0);
		assert.match(result.stdout, /^Usage: bb-database <command> \[options\]\n/);
		for (const verb of ['connect', 'migrate', 'types', 'status'])
			assert.match(result.stdout, new RegExp(`\\n  ${verb} `));
	});

	test('an unknown command, an unknown flag and a bad --stage are usage errors: exit code 2', async () => {
		assert.strictEqual((await run(['frobnicate'])).code, 2);
		assert.strictEqual((await run(['status', '--nope'])).code, 2);
		const stage = await run(
			['connect', '--stage', 'staging', '--value-stdin', '--output', 'json'],
			'postgresql://u:p@h/d',
		);
		assert.strictEqual(stage.code, 2);
		assert.strictEqual(json(stage).error?.name, 'UsageError');
	});

	test('with --no-input, connect needs the string on stdin and migrate needs --yes', async () => {
		const connect = await run(['connect', '--no-input', '--output', 'json']);
		assert.strictEqual(connect.code, 2);
		assert.deepStrictEqual(Object.keys(json(connect)).sort(), ['error', 'ok']);
		assert.strictEqual(json(connect).ok, false);
	});

	test('a value that is not a PostgreSQL URL fails with exit code 1 and one JSON object on stdout', async () => {
		const result = await run(
			['connect', '--value-stdin', '--no-input', '--check-only', '--output', 'json'],
			'hello',
		);
		assert.strictEqual(result.code, 1);
		assert.strictEqual(json(result).error?.name, 'DatabaseConfigurationError');
		assert.strictEqual(result.stdout.trim().split('\n').length, 1);
	});

	test('a secret in the input never reaches stdout or stderr', async () => {
		const secret = 'pa55-W0RD-not-for-output';
		const result = await run(
			['connect', '--value-stdin', '--no-input', '--check-only', '--output', 'json'],
			`postgresql://app:${secret}@db.example.com:6543/postgres?sslmode=no-verify`,
		);
		assert.strictEqual(result.code, 1);
		assert.match(json(result).error?.message ?? '', /'sslmode'/);
		assert.ok(!result.stdout.includes(secret) && !result.stderr.includes(secret));
	});

	test('migrate --stage is refused, not run on the development database', async () => {
		const result = await run(['migrate', '--stage', 'production', '--yes', '--output', 'json']);
		assert.strictEqual(result.code, 2);
		assert.match(json(result).error?.message ?? '', /development database only/);
	});

	test('--mark-applied takes a file of the directory, and --yes with --no-input', async () => {
		mkdirSync(join(cwd, 'migrations'), { recursive: true });
		writeFileSync(join(cwd, 'migrations', '000_baseline.sql'), 'CREATE TABLE t (id int);');
		const unknown = await run(['migrate', '--mark-applied', '001_nope.sql', '--yes', '--output', 'json']);
		assert.strictEqual(unknown.code, 2);
		assert.match(json(unknown).error?.message ?? '', /Not a file of \.\/migrations: 001_nope\.sql/);
		const unasked = await run(['migrate', '--mark-applied', '000_baseline.sql', '--no-input', '--output', 'json']);
		assert.strictEqual(unasked.code, 2);
		assert.match(json(unasked).error?.message ?? '', /pass --yes/);
	});

	test('a connection that was never stored is reported as not set', async () => {
		const result = await run(['types', '--name', 'never-stored', '--output', 'json']);
		assert.strictEqual(result.code, 1);
		assert.strictEqual(json(result).error?.name, 'DatabaseConfigurationError');
		assert.match(
			json(result).error?.message ?? '',
			/'never-stored' .* is not set, or is not a PostgreSQL connection string/,
		);
	});

	test('a missing migrations directory is a usage error', async () => {
		assert.strictEqual((await run(['status', './no-such-dir', '--output', 'json'])).code, 2);
	});
});

describe('bb-database command line, for a block that provisions its cluster', () => {
	const INDEX_MOCK = fileURLToPath(new URL('../index.mock.js', import.meta.url));
	const dir = join(cwd, 'cdk-blocks', 'migrations', 'main');

	before(() => {
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, '001_notes.sql'),
			'CREATE TABLE notes (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), body TEXT NOT NULL, pinned BOOLEAN);',
		);
	});

	test('types --block writes the Tables interface from the files and leaves .cdk-blocks/local/data alone', async () => {
		const result = await run(['types', '--block', 'main', '--out', 'gen/main.types.ts', '--output', 'json']);
		assert.strictEqual(result.code, 0, result.stdout + result.stderr);
		assert.deepStrictEqual(JSON.parse(result.stdout), { ok: true, out: 'gen/main.types.ts', tables: ['notes'] });
		const written = readFileSync(join(cwd, 'gen', 'main.types.ts'), 'utf8');
		assert.match(written, /^\/\/ Generated by `npm run db types`/m);
		assert.match(
			written,
			/notes: \{\n\t\tid: Generated<string>;\n\t\tbody: string;\n\t\tpinned: boolean \| null;\n\t\};/,
		);
		assert.ok(!existsSync(join(cwd, '.cdk-blocks/local/data', 'types-main')), 'no local database is made in the project');
	});

	test('under a wrapper, the paths of the options are resolved from the directory the user is in', async () => {
		// The db task runs this bin from the project root and names the user's directory.
		const elsewhere = join(cwd, 'elsewhere');
		mkdirSync(elsewhere, { recursive: true });
		const result = await run(
			[
				'types',
				'../cdk-blocks/migrations/main',
				'--block',
				'main',
				'--out',
				'out/main.types.ts',
				'--output',
				'json',
			],
			undefined,
			{ BB_DATABASE_START_DIR: elsewhere },
		);
		assert.strictEqual(result.code, 0, result.stdout + result.stderr);
		assert.strictEqual(JSON.parse(result.stdout).out, join(elsewhere, 'out', 'main.types.ts'));
		assert.ok(existsSync(join(elsewhere, 'out', 'main.types.ts')));
		// A value that is not a path stays as typed.
		const status = await run(['status', '--block', 'main', '--output', 'json'], undefined, {
			BB_DATABASE_START_DIR: elsewhere,
		});
		assert.strictEqual(status.code, 0, status.stdout + status.stderr);
	});

	test('a file the cluster type cannot run names the option for the other type', async () => {
		const aurora = join(cwd, 'cdk-blocks', 'migrations', 'tasks');
		mkdirSync(aurora, { recursive: true });
		writeFileSync(
			join(aurora, '001_tasks.sql'),
			'CREATE TABLE tasks (id SERIAL PRIMARY KEY, title TEXT NOT NULL);',
		);
		const asDsql = await run(['types', '--block', 'tasks', '--out', 'gen/tasks.types.ts', '--output', 'json']);
		assert.strictEqual(asDsql.code, 1);
		assert.match(json(asDsql).error?.message ?? '', /pass --type aurora/);
		const asAurora = await run([
			'types',
			'--block',
			'tasks',
			'--type',
			'aurora',
			'--out',
			'gen/tasks.types.ts',
			'--output',
			'json',
		]);
		assert.strictEqual(asAurora.code, 0, asAurora.stdout + asAurora.stderr);
		assert.match(readFileSync(join(cwd, 'gen', 'tasks.types.ts'), 'utf8'), /id: Generated<number>;/);
	});

	test('status --block lists every file as pending before the local database exists', async () => {
		const result = await run(['status', '--block', 'main', '--output', 'json']);
		assert.strictEqual(result.code, 0, result.stdout + result.stderr);
		const listed = JSON.parse(result.stdout);
		assert.deepStrictEqual(listed.applied, []);
		assert.deepStrictEqual(listed.pending, ['001_notes.sql']);
		assert.match(listed.note, /No local database of 'main'/);
	});

	test('status --block reads the local database of the block without opening it', async () => {
		// The block, as `npm run dev` runs it: its first statement applies the file.
		const script =
			`const { Database, sql } = await import(${JSON.stringify(INDEX_MOCK)});` +
			`const { Scope } = await import(${JSON.stringify(import.meta.resolve('@aws-cdk-blocks/core'))});` +
			"await new Database(new Scope('app'), 'main').query(sql`SELECT 1`);";
		await new Promise<void>((resolve, reject) =>
			execFile(process.execPath, ['--input-type=module', '-e', script], { cwd }, (error, _out, stderr) =>
				error ? reject(new Error(stderr)) : resolve(),
			),
		);
		writeFileSync(join(dir, '002_pinned_default.sql'), 'ALTER TABLE notes ALTER COLUMN pinned SET DEFAULT false;');
		const live = join(cwd, '.cdk-blocks/local/data', 'app-main', 'pglite');
		const before = statSync(join(live, 'global', 'pg_control')).mtimeMs;
		const result = await run(['status', '--block', 'main', '--output', 'json']);
		assert.strictEqual(result.code, 0, result.stdout + result.stderr);
		assert.deepStrictEqual(JSON.parse(result.stdout), {
			ok: true,
			applied: ['001_notes.sql'],
			pending: ['002_pinned_default.sql'],
		});
		assert.strictEqual(statSync(join(live, 'global', 'pg_control')).mtimeMs, before);
		assert.ok(!existsSync(join(live, 'postmaster.pid')), 'the directory was not opened');
	});

	test('options that do not fit a block are usage errors', async () => {
		for (const args of [
			['connect', '--block', 'main'],
			['migrate', '--block', 'main'],
			['status', '--block', 'main', '--stage', 'production'],
			['types', '--block', 'main', '--name', 'db-url'],
			['types', '--block', 'main', '--type', 'mysql'],
			['types', '--cluster', 'shared'],
		]) {
			const result = await run([...args, '--output', 'json']);
			assert.strictEqual(result.code, 2, `${args.join(' ')}: ${result.stdout}`);
			assert.strictEqual(json(result).error?.name, 'UsageError');
		}
	});
});

// The engine the generator reads through, on a local PostgreSQL.
class PgliteEngine extends RecordingEngine {
	constructor(private readonly db: PGlite) {
		super();
	}
	override async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
		return (await this.db.query<T>(sql, params)).rows;
	}
}

// The three helper types the generated file declares, copied here so the compiler checks them against Kysely's.
type ColumnType<S, I = S, U = S> = { readonly __select__: S; readonly __insert__: I; readonly __update__: U };
type Generated<T> = ColumnType<T, T | undefined, T>;

describe('the generated types file', () => {
	test('one Tables interface: column types as the engines return them, defaults as Generated', async () => {
		const db = new PGlite();
		await db.exec(`
			CREATE TABLE todos (
				id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
				owner uuid NOT NULL,
				title text NOT NULL,
				done boolean NOT NULL DEFAULT false,
				tags text[],
				amount numeric(10, 2),
				meta jsonb,
				created_at timestamptz NOT NULL DEFAULT now()
			);
			CREATE TABLE "Order Lines" ("line no" int NOT NULL, note varchar(20));
			CREATE TABLE _migrations (name text PRIMARY KEY);
		`);
		const file = await generateTypes(new PgliteEngine(db), 'public');
		await db.close();
		assert.deepStrictEqual(file.tables, ['Order Lines', 'todos']);
		const text = file.text;
		for (const line of [
			'export type ColumnType<S, I = S, U = S> = { readonly __select__: S; readonly __insert__: I; readonly __update__: U };',
			'export type Generated<T> = ColumnType<T, T | undefined, T>;',
			'export type GeneratedAlways<T> = ColumnType<T, never, never>;',
			'\t"Order Lines": {',
			'\t\t"line no": number;',
			'\t\tnote: string | null;',
			'\t\tid: GeneratedAlways<number>;',
			'\t\towner: string;',
			'\t\tdone: Generated<boolean>;',
			'\t\ttags: string[] | null;',
			'\t\tamount: string | null;',
			'\t\tmeta: unknown | null;',
			'\t\tcreated_at: Generated<Date>;',
		]) {
			assert.ok(text.includes(line), `missing line: ${line}`);
		}
		assert.ok(!text.includes('_migrations'), 'the ledger is not part of the app schema');
	});

	test("the file's Generated is structurally Kysely's, so Kysely accepts the Tables interface", () => {
		interface Tables {
			todos: { id: Generated<number>; title: string };
		}
		// Compile-time: an insert may leave out a generated column, and a selected row has the plain type.
		const insert: Insertable<Tables['todos']> = { title: 'x' };
		const row: Selectable<Tables['todos']> = { id: 1, title: 'x' };
		const same: KyselyGenerated<number> = undefined as unknown as Generated<number>;
		assert.strictEqual(insert.title, row.title);
		assert.strictEqual(same, undefined);
	});
});
