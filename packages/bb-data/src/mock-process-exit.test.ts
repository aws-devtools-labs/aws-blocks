// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * Regression test (L68 (b)): a short-lived script that imports a backend with a
 * `Database` under default conditions (the local mock) never exited. PGlite, the
 * engine behind the mock, re-arms a ref'd emulated `setitimer` about every 10s,
 * and the mock never closed the engine, so the event loop never emptied — and
 * the next start found a stale `postmaster.pid` (`Removed stale postmaster.pid`).
 *
 * Each run is a fresh child process against the SAME `.bb-data` (the normal case
 * after the first `npm run dev`). A hang shows up as a SIGKILL at the timeout
 * instead of hanging this suite.
 */

const distDir = dirname(fileURLToPath(import.meta.url));
const RUN_TIMEOUT_MS = 30_000;
/** A run must finish well inside the timeout: PGlite's emulated timer fires every ~10s. */
const EXIT_WITHIN_MS = 20_000;

interface Run {
	signal: NodeJS.Signals | null;
	status: number | null;
	stdout: string;
	stderr: string;
	elapsedMs: number;
}

function findFiles(dir: string, name: string): string[] {
	if (!existsSync(dir)) return [];
	const found: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) found.push(...findFiles(path, name));
		else if (entry.name === name) found.push(path);
	}
	return found;
}

describe('Database mock — a short-lived script exits on its own and closes PGlite', () => {
	let tmp: string;
	let script: string;
	const runs: Run[] = [];
	const pidFilesAfter: string[][] = [];

	const runOnce = (n: number): Run => {
		const start = Date.now();
		const result = spawnSync(process.execPath, [script, String(n)], {
			cwd: tmp,
			env: { ...process.env, NODE_OPTIONS: '' },
			encoding: 'utf-8',
			timeout: RUN_TIMEOUT_MS,
			killSignal: 'SIGKILL',
		});
		return {
			signal: result.signal,
			status: result.status,
			stdout: String(result.stdout ?? ''),
			stderr: String(result.stderr ?? ''),
			elapsedMs: Date.now() - start,
		};
	};

	before(() => {
		tmp = mkdtempSync(join(tmpdir(), 'blocks-db-mock-exit-'));
		mkdirSync(join(tmp, 'migrations'));
		writeFileSync(join(tmp, 'migrations', '001_notes.sql'), 'CREATE TABLE notes (n INT PRIMARY KEY);\n');

		// Resolved here (from inside the package), so the child needs no node_modules of its own.
		const coreUrl = import.meta.resolve('@aws-blocks/core');
		const mockUrl = pathToFileURL(join(distDir, 'index.mock.js')).href;
		script = join(tmp, 'app.mjs');
		writeFileSync(
			script,
			`const { Scope } = await import(${JSON.stringify(coreUrl)});
const { Database, sql } = await import(${JSON.stringify(mockUrl)});
const scope = new Scope('app');
const db = new Database(scope, 'main', { migrationsPath: ${JSON.stringify(join(tmp, 'migrations'))} });
const n = Number(process.argv[2]);
await db.execute(sql\`INSERT INTO notes (n) VALUES (\${n})\`);
const rows = await db.query(sql\`SELECT n FROM notes ORDER BY n\`);
console.log('ROWS ' + JSON.stringify(rows.map((r) => r.n)));
`,
		);

		// Run 1 creates `.bb-data`; runs 2 and 3 start against the existing one.
		for (const n of [1, 2, 3]) {
			runs.push(runOnce(n));
			pidFilesAfter.push(findFiles(join(tmp, '.bb-data'), 'postmaster.pid'));
		}
	});

	after(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	for (const [i, label] of ['a fresh .bb-data', 'an existing .bb-data', 'an existing .bb-data, again'].entries()) {
		it(`exits on its own within ${EXIT_WITHIN_MS / 1000}s against ${label}`, () => {
			const run = runs[i];
			assert.strictEqual(
				run.signal,
				null,
				`run ${i + 1} was still running after ${RUN_TIMEOUT_MS}ms — something kept the event loop alive.\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`,
			);
			assert.strictEqual(run.status, 0, `stderr:\n${run.stderr}`);
			assert.ok(run.elapsedMs < EXIT_WITHIN_MS, `run ${i + 1} took ${run.elapsedMs}ms`);
		});

		it(`leaves no postmaster.pid behind (${label})`, () => {
			assert.deepStrictEqual(pidFilesAfter[i], [], 'PGlite was not shut down cleanly');
		});
	}

	it('the next start never finds a stale postmaster.pid', () => {
		for (const run of runs) {
			assert.ok(!`${run.stdout}${run.stderr}`.includes('stale postmaster.pid'), run.stdout);
		}
	});

	it('data persists across restarts', () => {
		const rowsOf = (run: Run) => {
			const line = run.stdout.split('\n').find((l) => l.startsWith('ROWS '));
			assert.ok(line, `no ROWS line in stdout:\n${run.stdout}\nstderr:\n${run.stderr}`);
			return JSON.parse(line.slice('ROWS '.length));
		};
		assert.deepStrictEqual(rowsOf(runs[0]), [1]);
		assert.deepStrictEqual(rowsOf(runs[1]), [1, 2]);
		assert.deepStrictEqual(rowsOf(runs[2]), [1, 2, 3]);
	});
});

describe('Database mock — a long-running process (the dev server) keeps running', () => {
	let tmp: string;
	let child: ReturnType<typeof spawn>;
	let stdout = '';
	let stderr = '';
	let exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
	/** Longer than PGlite's ~10s emulated timer, so it fires at least once while the server runs. */
	const IDLE_MS = 12_000;

	const waitFor = async (pattern: RegExp, ms: number): Promise<RegExpMatchArray> => {
		const deadline = Date.now() + ms;
		while (Date.now() < deadline) {
			const match = stdout.match(pattern);
			if (match) return match;
			await delay(50);
		}
		throw new Error(`timed out waiting for ${pattern}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
	};

	before(() => {
		tmp = mkdtempSync(join(tmpdir(), 'blocks-db-mock-server-'));
		mkdirSync(join(tmp, 'migrations'));
		writeFileSync(join(tmp, 'migrations', '001_notes.sql'), 'CREATE TABLE notes (n INT PRIMARY KEY);\n');
		const coreUrl = import.meta.resolve('@aws-blocks/core');
		const mockUrl = pathToFileURL(join(distDir, 'index.mock.js')).href;
		const script = join(tmp, 'server.mjs');
		writeFileSync(
			script,
			`import { createServer } from 'node:http';
const { Scope } = await import(${JSON.stringify(coreUrl)});
const { Database, sql } = await import(${JSON.stringify(mockUrl)});
const db = new Database(new Scope('app'), 'main', { migrationsPath: ${JSON.stringify(join(tmp, 'migrations'))} });
await db.execute(sql\`INSERT INTO notes (n) VALUES (1)\`);
// Registered after the Database, so the mock's exit hook closes PGlite first and
// this query has to reopen it.
process.once('beforeExit', async () => {
	await db.execute(sql\`INSERT INTO notes (n) VALUES (3)\`);
	const rows = await db.query(sql\`SELECT n FROM notes ORDER BY n\`);
	console.log('AFTER ' + JSON.stringify(rows.map((r) => r.n)));
});
const server = createServer(async (req, res) => {
	if (req.url === '/stop') { res.end('bye'); server.close(); return; }
	await db.execute(sql\`INSERT INTO notes (n) VALUES (2)\`);
	const rows = await db.query(sql\`SELECT n FROM notes ORDER BY n\`);
	res.end(JSON.stringify(rows.map((r) => r.n)));
});
server.listen(0, '127.0.0.1', () => console.log('PORT ' + server.address().port));
`,
		);
		child = spawn(process.execPath, [script], { cwd: tmp, env: { ...process.env, NODE_OPTIONS: '' } });
		child.stdout?.on('data', (d) => {
			stdout += String(d);
		});
		child.stderr?.on('data', (d) => {
			stderr += String(d);
		});
		exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
	});

	after(() => {
		if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
		rmSync(tmp, { recursive: true, force: true });
	});

	it('stays up while its server holds the loop, serves queries, then exits and closes PGlite once the server stops', async () => {
		const [, port] = await waitFor(/PORT (\d+)/, RUN_TIMEOUT_MS);
		await delay(IDLE_MS);
		assert.strictEqual(child.exitCode, null, `the server process exited on its own:\n${stdout}\n${stderr}`);
		assert.strictEqual(child.signalCode, null);

		const res = await fetch(`http://127.0.0.1:${port}/rows`);
		assert.deepStrictEqual(await res.json(), [1, 2], 'the database answers after PGlite’s timer has fired');

		await (await fetch(`http://127.0.0.1:${port}/stop`)).text();
		const exit = await Promise.race([exited, delay(EXIT_WITHIN_MS, null, { ref: false })]);
		assert.ok(exit, `still running ${EXIT_WITHIN_MS}ms after its server closed:\n${stdout}\n${stderr}`);
		assert.deepStrictEqual(exit, { code: 0, signal: null }, stderr);

		// A query in a later `beforeExit` listener reopens the engine (after the close finished).
		assert.match(stdout, /AFTER \[1,2,3\]/);
		assert.deepStrictEqual(findFiles(join(tmp, '.bb-data'), 'postmaster.pid'), []);
	});
});
