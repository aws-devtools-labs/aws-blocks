// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * E2E test: `bb-database connect` against a real Supabase database.
 *
 * The CLI runs as a child process (`dist/cli.js`, `--output json`); the connection string reaches it on stdin
 * and nowhere else.
 *
 *   - `--check-only` reports what it found: verified TLS, the server version, the attributes of the login role,
 *     the roles it may switch to, the tables whose policies call Supabase's `auth` functions, the pooler mode.
 *   - A CA that did not sign the server certificate, and a string with a TLS parameter, are refused (exit code
 *     1) and nothing is stored.
 *   - `--no-input` without `--value-stdin` is a usage error (exit code 2).
 *   - After a local `connect`, a `Database` built with `DatabaseCluster.fromExisting({ name })` in a process
 *     whose working directory is the project directory runs a statement.
 *   - No run, passing or failing, prints the password or the connection string. `runCli()` checks this for
 *     every run; the last case states it for the runs of this file.
 *
 * Requires env var SUPABASE_DB_URL; skips when it is not set. TLS is verified against the pinned CA
 * (`DATABASE_CA_CERT`, or the fixture).
 */
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import {
	allRuns,
	type ConnectReport,
	caPem,
	connectionFields,
	env,
	failure,
	leaksIn,
	need,
	onFreshConnection,
	outputOf,
	PACKAGE_ENTRY,
	report,
	runCli,
	runNode,
	type Workspace,
	withParameter,
	withPort,
	workspace,
} from './support.js';

const skip = !env.dbUrl;

let hasOpenssl = false;
try {
	execFileSync('openssl', ['version'], { stdio: 'pipe' });
	hasOpenssl = true;
} catch {
	hasOpenssl = false;
}

const JSON_NO_INPUT = ['--no-input', '--output', 'json'];

// Builds the block in local mode with the connection's short name and runs one statement. The package entry
// and `@aws-cdk-blocks/core` are given by URL, because this file is outside the repository.
const SELECT_ONE = `
import { readFileSync } from 'node:fs';
const [coreUrl, entryUrl, caFile] = process.argv.slice(2);
const { Scope } = await import(coreUrl);
const { Database, DatabaseCluster, sql } = await import(entryUrl);
const db = new Database(new Scope('bbdb-e2e-child'), 'db', {
	cluster: DatabaseCluster.fromExisting({ name: 'e2e', ca: readFileSync(caFile, 'utf8') }),
});
const row = await db.queryOne(sql\`select 1 as one\`);
process.stdout.write(JSON.stringify({ row, cluster: db.cluster }), () => process.exit(0));
`;

describe('bb-database connect E2E: Supabase', { skip }, () => {
	const url = need(env.dbUrl, 'SUPABASE_DB_URL');
	const host = connectionFields(url).host;
	const onSupabasePooler = host.endsWith('.pooler.supabase.com');
	let ws: Workspace;

	const stored = () => existsSync(join(ws.cwd, '.cdk-blocks/local/data', 'settings.json'));

	before(() => {
		ws = workspace('bbdb-connect-e2e-');
	});

	after(() => {
		ws?.remove();
	});

	test('connect --check-only reports TLS, the server, the role and the policies, and stores nothing', async () => {
		// No newline after the string, as `printf %s` gives it; the other runs end it with one, as `echo` does.
		const run = await runCli(['connect', '--check-only', '--ca', ws.caFile, '--value-stdin', ...JSON_NO_INPUT], {
			cwd: ws.cwd,
			stdin: url,
		});
		const found = report<ConnectReport>(run);

		assert.strictEqual(found.name, 'db-url', 'the default name');
		assert.strictEqual(found.stored, 'none');
		assert.deepStrictEqual(found.tls, { verified: true, trust: 'ca' });
		assert.strictEqual(typeof found.host.ipv4, 'boolean');
		assert.ok(Array.isArray(found.warnings), 'warnings is a list');

		// What the report says about the server and the role is what the database says on a direct connection.
		const [actual] = await onFreshConnection<{
			version: string;
			name: string;
			superuser: boolean;
			bypass_rls: boolean;
		}>(
			url,
			`SELECT current_setting('server_version') AS version, r.rolname::text AS name,
			        r.rolsuper AS superuser, r.rolbypassrls AS bypass_rls
			 FROM pg_roles r WHERE r.rolname = current_user`,
		);
		assert.ok(typeof found.server.version === 'string' && found.server.version.length > 0, 'a server version');
		const major = actual.version.split('.')[0];
		assert.ok(found.server.version.includes(major), `the server version names major ${major}`);
		assert.strictEqual(found.role.name, actual.name);
		assert.strictEqual(found.role.superuser, actual.superuser);
		assert.strictEqual(found.role.bypassRls, actual.bypass_rls);

		assert.ok(Array.isArray(found.role.canSetRole), 'canSetRole is a list');
		assert.ok(found.role.canSetRole.includes('authenticated'), 'the role may switch to authenticated');
		assert.ok(found.role.canSetRole.includes('anon'), 'the role may switch to anon');

		// The fixture's policy on todos is `auth.uid() = user_id`.
		const todos = found.policies.usingAuthFunctions.filter((p) => p.table === 'todos');
		assert.deepStrictEqual(todos, [{ table: 'todos', policy: 'users_own_todos' }]);

		if (onSupabasePooler) {
			const mode = connectionFields(url).port === 6543 ? 'transaction' : 'session';
			assert.deepStrictEqual(found.pooler, { provider: 'supabase', mode });
		}

		assert.deepStrictEqual(readdirSync(ws.cwd), [], '--check-only writes nothing in the project directory');
	});

	test('connect --check-only reports transaction mode for port 6543', async (t) => {
		if (!onSupabasePooler) {
			t.skip('the connection string is not a Supabase pooler string');
			return;
		}
		const run = await runCli(['connect', '--check-only', '--ca', ws.caFile, '--value-stdin', ...JSON_NO_INPUT], {
			cwd: ws.cwd,
			stdin: `${withPort(url, '6543')}\n`,
		});
		const found = report<ConnectReport>(run);
		assert.deepStrictEqual(found.tls, { verified: true, trust: 'ca' });
		assert.deepStrictEqual(found.pooler, { provider: 'supabase', mode: 'transaction' });
		assert.ok(found.role.canSetRole.includes('authenticated') && found.role.canSetRole.includes('anon'));
		assert.deepStrictEqual(readdirSync(ws.cwd), [], '--check-only writes nothing in the project directory');
	});

	test('a CA that did not sign the server certificate: exit code 1, an error, nothing stored', async (t) => {
		if (!hasOpenssl) {
			t.skip('openssl is not installed');
			return;
		}
		// A throwaway self-signed certificate: a valid CA file that the server's chain does not lead to.
		const wrongCa = ws.beside('wrong-ca.crt');
		execFileSync(
			'openssl',
			[
				'req',
				'-x509',
				'-newkey',
				'rsa:2048',
				'-nodes',
				'-days',
				'1',
				'-subj',
				'/CN=bb-database-e2e-wrong-ca',
				'-keyout',
				ws.beside('wrong-ca.key'),
				'-out',
				wrongCa,
			],
			{ stdio: 'pipe' },
		);
		assert.match(readFileSync(wrongCa, 'utf8'), /-----BEGIN CERTIFICATE-----/);

		// Without --check-only: a run that would store the string if it did not fail.
		const filesBefore = readdirSync(ws.cwd);
		const run = await runCli(['connect', '--name', 'e2e', '--ca', wrongCa, '--value-stdin', ...JSON_NO_INPUT], {
			cwd: ws.cwd,
			stdin: `${url}\n`,
		});
		failure(run, 1);
		assert.ok(!stored(), 'no settings file');
		assert.deepStrictEqual(readdirSync(ws.cwd), filesBefore, 'nothing is written in the project directory');
	});

	test('a string with ?sslmode=no-verify: exit code 1, the error names the TLS parameter, nothing stored', async () => {
		const filesBefore = readdirSync(ws.cwd);
		const run = await runCli(['connect', '--name', 'e2e', '--ca', ws.caFile, '--value-stdin', ...JSON_NO_INPUT], {
			cwd: ws.cwd,
			stdin: `${withParameter(url, 'sslmode', 'no-verify')}\n`,
		});
		const error = failure(run, 1);
		assert.match(error.message, /sslmode/, 'the message names the parameter');
		assert.ok(!stored(), 'no settings file');
		assert.deepStrictEqual(readdirSync(ws.cwd), filesBefore, 'nothing is written in the project directory');
	});

	test('--no-input without --value-stdin: exit code 2, nothing stored', async () => {
		const filesBefore = readdirSync(ws.cwd);
		const run = await runCli(['connect', '--name', 'e2e', '--ca', ws.caFile, ...JSON_NO_INPUT], { cwd: ws.cwd });
		assert.strictEqual(run.code, 2, `a usage error${outputOf(run)}`);
		assert.ok(!stored(), 'no settings file');
		assert.deepStrictEqual(readdirSync(ws.cwd), filesBefore, 'nothing is written in the project directory');
	});

	test('connect stores the string in the local settings store and writes the CA module', async () => {
		const run = await runCli(['connect', '--name', 'e2e', '--ca', ws.caFile, '--value-stdin', ...JSON_NO_INPUT], {
			cwd: ws.cwd,
			stdin: `${url}\n`,
		});
		const connected = report<ConnectReport>(run);
		assert.strictEqual(connected.name, 'e2e');
		assert.strictEqual(connected.stored, 'local');
		assert.deepStrictEqual(connected.tls, { verified: true, trust: 'ca' });
		assert.ok(stored(), '<cwd>/.cdk-blocks/local/data/settings.json exists');

		// One module per connection name; the default name `db-url` has the plain `database.ca.ts`.
		const caModule = join(ws.cwd, 'cdk-blocks', 'database.e2e.ca.ts');
		assert.ok(typeof connected.caModule === 'string', 'connect reports the CA module it wrote');
		assert.strictEqual(realpathSync(resolve(ws.cwd, connected.caModule)), caModule);
		const written = readFileSync(caModule, 'utf8');
		assert.match(written, /^\/\/ Written by `npm run db -- connect --ca`/m);
		assert.match(written, /export const DATABASE_CA\s*=/, 'the module exports DATABASE_CA');
		// The certificate itself is in the module: the first line of its body, which has no line break in it.
		const firstLine = caPem()
			.split(/\r?\n/)
			.find((line) => line.length > 0 && !line.startsWith('-----'));
		assert.ok(firstLine && written.includes(firstLine), 'the module carries the PEM text');
	});

	test('a Database built with the connection name runs a statement in the project directory', async () => {
		const script = ws.beside('select-one.mjs');
		writeFileSync(script, SELECT_ONE);
		const run = await runNode(
			script,
			[import.meta.resolve('@aws-cdk-blocks/core'), pathToFileURL(PACKAGE_ENTRY).href, ws.caFile],
			{ cwd: ws.cwd },
		);
		assert.strictEqual(run.code, 0, `the child process failed${outputOf(run)}`);
		// The last line: the block may log above it.
		const result: unknown = JSON.parse(run.stdout.trim().split('\n').pop() ?? 'null');
		assert.deepStrictEqual(result, {
			row: { one: 1 },
			cluster: { kind: 'external', id: 'external' },
		});
	});

	test('no run, passing or failing, printed the password or the connection string', () => {
		const runs = allRuns();
		assert.ok(
			runs.some((r) => r.code === 0) && runs.some((r) => r.code === 1) && runs.some((r) => r.code === 2),
			'the runs of this file include a passing one, a refused one and a usage error',
		);
		for (const run of runs) {
			assert.deepStrictEqual(leaksIn(run.stdout), [], `${run.command}: stdout`);
			assert.deepStrictEqual(leaksIn(run.stderr), [], `${run.command}: stderr`);
		}
	});
});
