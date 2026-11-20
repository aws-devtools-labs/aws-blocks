// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Plumbing shared by the Supabase end-to-end tests of this block: the environment, the pinned CA, direct `pg`
// connections for setup and cleanup, and a runner for the block's CLI. Nothing here is the API under test.
//
// Two rules hold for everything in this file:
//   - TLS is always verified against the pinned CA. No connection is made without it.
//   - No message built here contains the connection string or its password. Output of a child process is
//     passed through `redact()` before it reaches an assertion message.

import assert from 'node:assert';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

/** The environment of the `E2E Supabase` job. Every value is absent on a machine without the secrets. */
export const env = {
	projectRef: process.env.SUPABASE_PROJECT_REF,
	anonKey: process.env.SUPABASE_ANON_KEY,
	dbUrl: process.env.SUPABASE_DB_URL,
	user1Email: process.env.SUPABASE_TEST_USER_1_EMAIL,
	user1Password: process.env.SUPABASE_TEST_USER_1_PASSWORD,
	user2Email: process.env.SUPABASE_TEST_USER_2_EMAIL,
	user2Password: process.env.SUPABASE_TEST_USER_2_PASSWORD,
};

/** `value`, or a failure that names the variable and not its value. */
export function need(value: string | undefined, name: string): string {
	if (!value) throw new Error(`${name} is not set`);
	return value;
}

/** `packages/bb-database/`, from `src/e2e/` and from `dist/e2e/` alike. */
export const PACKAGE_ROOT = fileURLToPath(new URL('../../', import.meta.url));
/** The block's bin, as built. */
export const CLI = join(PACKAGE_ROOT, 'dist', 'cli.js');
/** The package's default entry, as built: what `@aws-cdk-blocks/bb-database` resolves to in local mode. */
export const PACKAGE_ENTRY = join(PACKAGE_ROOT, 'dist', 'index.mock.js');

const FIXTURE_CA = join(PACKAGE_ROOT, 'test', 'fixtures', 'supabase-ca.crt');
const PEM_HEADER = '-----BEGIN CERTIFICATE-----';

/**
 * PEM text of the CA that every connection of these tests is verified against. `DATABASE_CA_CERT` is the path
 * of a PEM file (what the CI job sets) or the PEM text itself; without it, the committed Supabase root CA.
 */
export function caPem(): string {
	const configured = process.env.DATABASE_CA_CERT;
	if (!configured) return readFileSync(FIXTURE_CA, 'utf8');
	return configured.includes(PEM_HEADER) ? configured : readFileSync(configured, 'utf8');
}

// `new URL()` puts its input on the error it throws, so that error never leaves this function.
function parse(connectionString: string): URL {
	try {
		return new URL(connectionString);
	} catch {
		throw new Error('The connection string of the test is not a URL.');
	}
}

/** The same connection string on another port: 5432 is session mode on the Supabase pooler, 6543 transaction mode. */
export function withPort(connectionString: string, port: string): string {
	const url = parse(connectionString);
	url.port = port;
	return protect(url.toString());
}

/** The same connection string with one more query parameter. */
export function withParameter(connectionString: string, name: string, value: string): string {
	const url = parse(connectionString);
	url.searchParams.set(name, value);
	return protect(url.toString());
}

/** Host, port, user, password and database of a connection string, as discrete fields. */
export function connectionFields(connectionString: string) {
	const url = parse(connectionString);
	return {
		host: url.hostname,
		port: Number(url.port || '5432'),
		user: decodeURIComponent(url.username),
		password: decodeURIComponent(url.password),
		database: decodeURIComponent(url.pathname.replace(/^\//, '')) || 'postgres',
	};
}

/** A direct connection for setup, cleanup and checks that the API under test must not make for itself. */
export interface Plumbing {
	/** One statement with bound parameters; its rows. */
	query<R extends pg.QueryResultRow>(text: string, params?: unknown[]): Promise<R[]>;
	/** One or more statements without parameters. */
	exec(text: string): Promise<void>;
	end(): Promise<void>;
}

/** One `pg` connection to the database of `connectionString`, with the certificate verified against the pinned CA. */
export function openDb(connectionString: string): Plumbing {
	const pool = new pg.Pool({
		...connectionFields(connectionString),
		ssl: { ca: caPem(), rejectUnauthorized: true },
		max: 1,
		connectionTimeoutMillis: 20_000,
	});
	// An idle connection that the pooler closes must not end the test process.
	pool.on('error', () => {});
	return {
		async query<R extends pg.QueryResultRow>(text: string, params: unknown[] = []): Promise<R[]> {
			return (await pool.query<R>(text, params)).rows;
		},
		async exec(text: string): Promise<void> {
			await pool.query(text);
		},
		end: () => pool.end(),
	};
}

/** Runs one statement on a connection of its own, opened for it and closed after it. */
export async function onFreshConnection<R extends pg.QueryResultRow>(
	connectionString: string,
	text: string,
	params: unknown[] = [],
): Promise<R[]> {
	const db = openDb(connectionString);
	try {
		return await db.query<R>(text, params);
	} finally {
		await db.end();
	}
}

/** The column names of `public.<table>`, in order; empty when the table does not exist. */
export async function columnsOf(db: Plumbing, table: string, schema = 'public'): Promise<string[]> {
	const rows = await db.query<{ column_name: string }>(
		`SELECT column_name FROM information_schema.columns
		 WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position`,
		[schema, table],
	);
	return rows.map((r) => r.column_name);
}

// ─── Secrets ─────────────────────────────────────────────────────────────────

const secrets = new Map<string, 'the connection string' | 'the password'>();

/** Registers a connection string and its password as text that no output and no message may contain. */
export function protect(connectionString: string): string {
	const url = parse(connectionString);
	secrets.set(connectionString, 'the connection string');
	for (const password of [url.password, decodeURIComponent(url.password)]) {
		if (password) secrets.set(password, 'the password');
	}
	return connectionString;
}

if (env.dbUrl) protect(env.dbUrl);

/** `text` with every registered secret replaced, safe for an assertion message. */
export function redact(text: string): string {
	let out = text;
	for (const secret of secrets.keys()) out = out.split(secret).join('[redacted]');
	return out;
}

/** What `text` reveals: `'the password'`, `'the connection string'`, or nothing. Never the value. */
export function leaksIn(text: string): string[] {
	const found = new Set<string>();
	for (const [secret, label] of secrets) if (text.includes(secret)) found.add(label);
	return [...found].sort();
}

// ─── Child processes ─────────────────────────────────────────────────────────

/** One finished child process. */
export interface Run {
	/** What ran, for messages: the arguments, which never hold a secret. */
	command: string;
	code: number;
	stdout: string;
	stderr: string;
}

const runs: Run[] = [];

/** Every child process this test file has run so far. */
export function allRuns(): readonly Run[] {
	return runs;
}

function tail(text: string): string {
	const safe = redact(text).trim();
	return safe.length > 1500 ? `…${safe.slice(-1500)}` : safe;
}

/** The output of a run for an assertion message, with secrets removed. */
export function outputOf(run: Run): string {
	return `\n--- stdout ---\n${tail(run.stdout)}\n--- stderr ---\n${tail(run.stderr)}`;
}

/**
 * Runs `node <script> <args>` in `cwd`, writes `stdin` to it, and waits for it to exit. Fails when the output
 * contains the connection string or its password, whatever the exit code: that holds for every run of every test.
 */
export function runNode(script: string, args: string[], options: { cwd: string; stdin?: string }): Promise<Run> {
	const command = [script === CLI ? 'bb-database' : 'node', ...args].join(' ');
	return new Promise<Run>((resolve, reject) => {
		const child = execFile(
			process.execPath,
			[script, ...args],
			{ cwd: options.cwd, encoding: 'utf8', timeout: 180_000, maxBuffer: 32 * 1024 * 1024 },
			(error, stdout, stderr) => {
				const code = error ? error.code : 0;
				if (typeof code !== 'number') {
					reject(new Error(`${command}: no exit code (${error?.killed ? 'timed out' : 'failed to start'})`));
					return;
				}
				const run: Run = { command, code, stdout, stderr };
				runs.push(run);
				const leaked = leaksIn(stdout + stderr);
				if (leaked.length > 0) {
					reject(new assert.AssertionError({ message: `${command} printed ${leaked.join(' and ')}` }));
					return;
				}
				resolve(run);
			},
		);
		// A child that exits before it reads its input closes the pipe; that is not a failure of the test.
		child.stdin?.on('error', () => {});
		child.stdin?.end(options.stdin ?? '');
	});
}

/** Runs the block's CLI (`packages/bb-database/dist/cli.js`) in `cwd`. */
export function runCli(args: string[], options: { cwd: string; stdin?: string }): Promise<Run> {
	return runNode(CLI, args, options);
}

function jsonObject(run: Run): Record<string, unknown> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(run.stdout);
	} catch {
		assert.fail(`${run.command}: stdout is not one JSON document${outputOf(run)}`);
	}
	assert.ok(
		typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed),
		`${run.command}: stdout is not a JSON object${outputOf(run)}`,
	);
	return { ...parsed };
}

function field(value: unknown, key: string): unknown {
	return typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined;
}

/**
 * The JSON object a successful run printed: exit code 0, stdout that is one JSON object and nothing else, and
 * `ok: true`. `T` is the shape section 11.2 of the design gives the verb; the tests assert the fields they read.
 */
export function report<T extends { ok: true }>(run: Run): T {
	assert.strictEqual(run.code, 0, `${run.command}: exit code ${run.code}${outputOf(run)}`);
	const parsed = jsonObject(run);
	assert.strictEqual(parsed.ok, true, `${run.command}: ok is not true${outputOf(run)}`);
	return parsed as T;
}

/** The `error` of a failed run: the given exit code and `{ ok: false, error: { name, message } }` on stdout. */
export function failure(run: Run, code = 1): { name: string; message: string } {
	assert.strictEqual(run.code, code, `${run.command}: exit code ${run.code}, expected ${code}${outputOf(run)}`);
	const parsed = jsonObject(run);
	assert.strictEqual(parsed.ok, false, `${run.command}: ok is not false${outputOf(run)}`);
	const name = field(parsed.error, 'name');
	const message = field(parsed.error, 'message');
	assert.ok(
		typeof name === 'string' && name.length > 0,
		`${run.command}: error.name is not a string${outputOf(run)}`,
	);
	assert.ok(
		typeof message === 'string' && message.length > 0,
		`${run.command}: error.message is not a string${outputOf(run)}`,
	);
	return { name, message };
}

// ─── CLI output, as section 11.2 of the design states it ─────────────────────

export interface ConnectReport {
	ok: true;
	name: string;
	stored: 'local' | 'ssm' | 'none';
	parameterName?: string;
	caModule?: string;
	tls: { verified: true; trust: 'ca' | 'system' };
	host: { ipv4: boolean };
	server: { version: string };
	role: { name: string; superuser: boolean; bypassRls: boolean; canSetRole: string[] };
	pooler?: { provider: 'supabase'; mode: 'direct' | 'session' | 'transaction' };
	policies: { usingAuthFunctions: { table: string; policy: string }[] };
	warnings: string[];
}

export interface MigrateReport {
	ok: true;
	host: string;
	applied: string[];
	types?: string;
}

export interface MarkAppliedReport {
	ok: true;
	host: string;
	marked: string[];
	alreadyApplied: string[];
}

export interface TypesReport {
	ok: true;
	out: string;
	tables: string[];
}

export interface StatusReport {
	ok: true;
	applied: string[];
	pending: string[];
}

// ─── Working directories ─────────────────────────────────────────────────────

/** A temp directory for one `describe`: an empty project directory to run the CLI in, and the CA as a file beside it. */
export interface Workspace {
	/** The project directory: the `cwd` of every CLI run. Empty at the start. */
	cwd: string;
	/** The pinned CA as a PEM file, outside `cwd`. */
	caFile: string;
	/** A path beside `cwd` for other files of the test. */
	beside(name: string): string;
	remove(): void;
}

export function workspace(prefix: string): Workspace {
	// Resolved, so that a path the CLI prints from its own `process.cwd()` compares equal (macOS: /var is a link).
	const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
	const cwd = join(root, 'app');
	mkdirSync(cwd);
	const caFile = join(root, 'ca.crt');
	writeFileSync(caFile, caPem());
	return {
		cwd,
		caFile,
		beside: (name) => join(root, name),
		remove: () => rmSync(root, { recursive: true, force: true }),
	};
}
