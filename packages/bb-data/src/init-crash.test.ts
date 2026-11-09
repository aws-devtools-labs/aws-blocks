// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * A PGlite `_pg_initdb` WASM trap during constructor-time migrations must not
 * kill the host process. The constructor kicks off `runMigrations` eagerly; if
 * that promise rejects before any query awaits it, Node treats the rejection as
 * UNHANDLED and exits the dev server — the `dead_server` crash this guard
 * prevents. Run the scenario in a child process with `@electric-sql/pglite`
 * swapped for a stub that always traps, so an unhandled rejection shows up as a
 * non-zero exit instead of crashing the test runner. The eager migration's
 * `.catch()` must keep the process alive, while a query after the failed init
 * still surfaces a branded `QueryFailedException` (logged, never swallowed).
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

const STUB_PGLITE = `
export class PGlite {
  async query() {
    const trap = new Error('Aborted(Cannot enlarge memory arrays)');
    throw trap;
  }
  async close() {}
}
`;

// Traps on the first N query() calls across ALL instances (a module-level
// counter survives recreate), then succeeds. N is set to EXACTLY the eager
// migration's init-retry budget (3 attempts) so the first migration run fails
// and every later call succeeds — a deterministic boundary (osama-rizk round 2):
// no post-failure probe is left trapping, so the test does not depend on how
// many queries land inside a fuzzy trap window.
const STUB_PGLITE_RECOVER = (trapCount: number) => `
let calls = 0;
const TRAP_UNTIL = ${trapCount};
export class PGlite {
  async query(sql) {
    calls++;
    if (calls <= TRAP_UNTIL) throw new Error('Aborted(Cannot enlarge memory arrays)');
    // A migration runs CREATE TABLE etc.; the init probe is 'SELECT 1'. Return a
    // permissive shape good enough for both the probe and simple DDL/DML.
    return { rows: [], fields: [], affectedRows: 0 };
  }
  async exec() { return [{ rows: [], fields: [], affectedRows: 0 }]; }
  async close() {}
}
`;

const HOOKS = (stubUrl: string) => `
export async function resolve(specifier, context, next) {
  if (specifier === '@electric-sql/pglite') return { url: ${JSON.stringify(stubUrl)}, shortCircuit: true };
  return next(specifier, context);
}
`;

const CHILD = (indexMockUrl: string, coreUrl: string, migrationsDir: string) => `
import { Scope, isBlocksError } from ${JSON.stringify(coreUrl)};
import { Database, DatabaseErrors, sql } from ${JSON.stringify(indexMockUrl)};

const db = new Database(new Scope('app'), 'db', { migrationsPath: ${JSON.stringify(migrationsDir)} });
// Give the eager, unawaited migration promise time to reject. If its rejection
// is unhandled, Node exits non-zero HERE, before we print any RESULT line.
await new Promise((r) => setTimeout(r, 1500));
try {
  await db.query(sql\`SELECT 1\`);
  console.log('RESULT:resolved');
} catch (e) {
  console.log('RESULT:' + (isBlocksError(e, DatabaseErrors.QueryFailed) ? 'branded-query-failed' : 'unbranded:' + String(e)));
}
`;

test('constructor-time PGlite init trap leaves the process alive and surfaces a branded QueryFailed', () => {
	const work = mkdtempSync(join(tmpdir(), 'bd-init-crash-'));
	const migrations = join(work, 'migrations');
	mkdirSync(migrations);
	writeFileSync(join(migrations, '0001_init.sql'), 'CREATE TABLE notes (id TEXT PRIMARY KEY);');
	const stub = join(work, 'stub-pglite.mjs');
	writeFileSync(stub, STUB_PGLITE);
	const hooks = join(work, 'hooks.mjs');
	writeFileSync(hooks, HOOKS(pathToFileURL(stub).href));
	const register = join(work, 'register.mjs');
	writeFileSync(
		register,
		`import { register } from 'node:module'; register(${JSON.stringify(pathToFileURL(hooks).href)});`,
	);

	const indexMockUrl = new URL('./index.mock.js', import.meta.url).href;
	const coreUrl = import.meta.resolve('@aws-blocks/core');
	const child = join(work, 'child.mjs');
	writeFileSync(child, CHILD(indexMockUrl, coreUrl, migrations));

	const run = spawnSync(process.execPath, ['--import', pathToFileURL(register).href, child], {
		cwd: work,
		encoding: 'utf-8',
		timeout: 60_000,
	});

	// The process surviving (exit 0) is the core assertion — an unhandled
	// rejection from the eager migration would exit non-zero here.
	assert.equal(run.status, 0, `child exited ${run.status}\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`);
	// And the failed init still surfaces as a branded error to the caller.
	assert.match(run.stdout, /RESULT:branded-query-failed/);
	// "Logged, never swallowed": the trap is reported with the data-layer sentinel
	// (a bare `.catch(() => {})` would survive + brand but log nothing — this pins it).
	assert.match(run.stderr, /PGlite init trap: data layer unavailable/);
});

const RECOVER_CHILD = (indexMockUrl: string, coreUrl: string, migrationsDir: string) => `
import { Scope } from ${JSON.stringify(coreUrl)};
import { Database, sql } from ${JSON.stringify(indexMockUrl)};

const schema = { notes: { singular: 'note', plural: 'notes', primaryKey: 'id', columns: ['id'], autoGenerated: [] } };
const db = new Database(new Scope('app'), 'db', { migrationsPath: ${JSON.stringify(migrationsDir)}, schema });

// Deterministic recovery check (osama-rizk round 2): instead of a fixed sleep +
// single query (which is timing-coupled — if the query lands before the eager
// run has failed it awaits the SAME rejected run and reports a false negative),
// poll db.query() until it either succeeds or we exhaust a generous attempt cap.
// With the stub trapping EXACTLY the 3-attempt init-retry budget, the first
// post-failure re-run succeeds; the loop just removes the race on WHEN that is.
let recovered = false;
for (let i = 0; i < 40 && !recovered; i++) {
  try {
    const rows = await db.query(sql\`SELECT 1\`);
    recovered = Array.isArray(rows);
  } catch {
    await new Promise((r) => setTimeout(r, 50));
  }
}
console.log('RECOVERY:' + (recovered ? 'ok:true' : 'still-broken'));

// CRUD must ALSO recover: createCrudHandlers routes through the ensureReady gate
// (index.mock.ts), so after the heal a crud list hits the migrated table rather
// than 'relation notes does not exist'. Pins the gate against a refactor.
try {
  const crud = db.crud({ tables: ['notes'], auth: async () => ({ userId: 'u1' }) });
  const list = await crud.listNotes();
  console.log('CRUD:' + (Array.isArray(list) ? 'ok' : 'bad-shape'));
} catch (e) {
  console.log('CRUD:failed:' + String(e));
}
`;

test('a transient init trap does not wedge the Database — a later query recovers (migrations re-run)', () => {
	const work = mkdtempSync(join(tmpdir(), 'bd-init-recover-'));
	const migrations = join(work, 'migrations');
	mkdirSync(migrations);
	writeFileSync(join(migrations, '0001_init.sql'), 'CREATE TABLE notes (id TEXT PRIMARY KEY);');
	const stub = join(work, 'stub-pglite.mjs');
	// Trap EXACTLY the first migration run's init-retry budget (3 attempts); every
	// later call succeeds. Deterministic — no post-failure probe is left trapping.
	writeFileSync(stub, STUB_PGLITE_RECOVER(3));
	const hooks = join(work, 'hooks.mjs');
	writeFileSync(hooks, HOOKS(pathToFileURL(stub).href));
	const register = join(work, 'register.mjs');
	writeFileSync(
		register,
		`import { register } from 'node:module'; register(${JSON.stringify(pathToFileURL(hooks).href)});`,
	);

	const indexMockUrl = new URL('./index.mock.js', import.meta.url).href;
	const coreUrl = import.meta.resolve('@aws-blocks/core');
	const child = join(work, 'child.mjs');
	writeFileSync(child, RECOVER_CHILD(indexMockUrl, coreUrl, migrations));

	const run = spawnSync(process.execPath, ['--import', pathToFileURL(register).href, child], {
		cwd: work,
		encoding: 'utf-8',
		timeout: 60_000,
	});

	assert.equal(run.status, 0, `child exited ${run.status}\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`);
	// The data layer recovered: a later query succeeded instead of rejecting forever.
	assert.match(run.stdout, /RECOVERY:ok:true/, `expected recovery, got:\n${run.stdout}\nstderr:\n${run.stderr}`);
	// CRUD recovered too (the ensureReady gate re-ran migrations before the list).
	assert.match(run.stdout, /CRUD:ok/, `expected crud recovery, got:\n${run.stdout}\nstderr:\n${run.stderr}`);
	// Both sentinels present and in causal order: the trap was logged, then the
	// re-run logged the RECOVERED marker (which step 3's causal scan keys on).
	assert.match(run.stderr, /PGlite init trap: data layer unavailable/);
	assert.match(run.stderr, /PGlite init trap: data layer recovered/);
});
