// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test, afterEach } from 'node:test';
import assert from 'node:assert';
import { PGliteEngine, recoverIncompleteDataDir } from './pglite-engine.js';
import { DatabaseErrors } from '../errors.js';
import { rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const TEST_DIR = '.bb-data-test-' + process.pid;
let engine: PGliteEngine;

afterEach(async () => {
  if (engine) {
    await engine.destroy().catch(() => {});
  }
  rmSync(TEST_DIR, { recursive: true, force: true });
});

async function setup(): Promise<PGliteEngine> {
  engine = new PGliteEngine(TEST_DIR);
  await engine.execute('CREATE TABLE t (id TEXT PRIMARY KEY, value TEXT)');
  return engine;
}

// --- Core: query ---

test('query returns rows', async () => {
  await setup();
  await engine.execute("INSERT INTO t (id, value) VALUES ('a', 'one')");
  const rows = await engine.query<{ id: string; value: string }>('SELECT * FROM t');
  assert.deepStrictEqual(rows, [{ id: 'a', value: 'one' }]);
});

test('query returns empty array for no matches', async () => {
  await setup();
  const rows = await engine.query('SELECT * FROM t WHERE id = $1', ['nope']);
  assert.deepStrictEqual(rows, []);
});

test('query supports parameter binding', async () => {
  await setup();
  await engine.execute("INSERT INTO t (id, value) VALUES ('a', 'one')");
  await engine.execute("INSERT INTO t (id, value) VALUES ('b', 'two')");
  const rows = await engine.query<{ id: string }>('SELECT id FROM t WHERE id = $1', ['b']);
  assert.deepStrictEqual(rows, [{ id: 'b' }]);
});

// --- Core: execute ---

test('execute returns rowCount for INSERT', async () => {
  await setup();
  const result = await engine.execute("INSERT INTO t (id, value) VALUES ('a', 'one')");
  assert.strictEqual(result.rowCount, 1);
});

test('execute returns rowCount for UPDATE', async () => {
  await setup();
  await engine.execute("INSERT INTO t (id, value) VALUES ('a', 'one')");
  const result = await engine.execute("UPDATE t SET value = 'two' WHERE id = 'a'");
  assert.strictEqual(result.rowCount, 1);
});

test('execute returns rowCount 0 for UPDATE with no matches', async () => {
  await setup();
  const result = await engine.execute("UPDATE t SET value = 'two' WHERE id = 'nope'");
  assert.strictEqual(result.rowCount, 0);
});

test('execute returns rowCount for DELETE', async () => {
  await setup();
  await engine.execute("INSERT INTO t (id, value) VALUES ('a', 'one')");
  const result = await engine.execute("DELETE FROM t WHERE id = 'a'");
  assert.strictEqual(result.rowCount, 1);
});

// --- Core: error translation ---

test('duplicate key throws UniqueConstraintViolation', async () => {
  await setup();
  await engine.execute("INSERT INTO t (id, value) VALUES ('a', 'one')");
  await assert.rejects(
    () => engine.execute("INSERT INTO t (id, value) VALUES ('a', 'dupe')"),
    (err: Error) => {
      assert.strictEqual(err.name, DatabaseErrors.UniqueConstraintViolation);
      return true;
    }
  );
});

test('invalid SQL throws QueryFailed', async () => {
  await setup();
  await assert.rejects(
    () => engine.query('SELECT FROM INVALID SYNTAX !!!'),
    (err: Error) => {
      assert.strictEqual(err.name, DatabaseErrors.QueryFailed);
      return true;
    }
  );
});

// --- Core: destroy ---

test('destroy prevents further queries', async () => {
  await setup();
  await engine.destroy();
  await assert.rejects(() => engine.query('SELECT 1'));
});

// --- Transactions ---

test('transaction commits on success', async () => {
  await setup();
  const handle = await engine.beginTransaction();
  await engine.executeInTransaction(handle, "INSERT INTO t (id, value) VALUES ('a', 'one')");
  await engine.commitTransaction(handle);

  const rows = await engine.query<{ id: string }>('SELECT id FROM t');
  assert.deepStrictEqual(rows, [{ id: 'a' }]);
});

test('transaction rolls back', async () => {
  await setup();
  const handle = await engine.beginTransaction();
  await engine.executeInTransaction(handle, "INSERT INTO t (id, value) VALUES ('a', 'one')");
  await engine.rollbackTransaction(handle);

  const rows = await engine.query('SELECT * FROM t');
  assert.deepStrictEqual(rows, []);
});

test('queryInTransaction sees uncommitted data', async () => {
  await setup();
  const handle = await engine.beginTransaction();
  await engine.executeInTransaction(handle, "INSERT INTO t (id, value) VALUES ('a', 'one')");
  const rows = await engine.queryInTransaction<{ id: string }>(handle, 'SELECT id FROM t');
  assert.deepStrictEqual(rows, [{ id: 'a' }]);
  await engine.rollbackTransaction(handle);
});

test('executeInTransaction returns rowCount', async () => {
  await setup();
  const handle = await engine.beginTransaction();
  const result = await engine.executeInTransaction(handle, "INSERT INTO t (id, value) VALUES ('a', 'one')");
  assert.strictEqual(result.rowCount, 1);
  await engine.rollbackTransaction(handle);
});

test('error translation works within transactions', async () => {
  await setup();
  await engine.execute("INSERT INTO t (id, value) VALUES ('a', 'one')");
  const handle = await engine.beginTransaction();
  await assert.rejects(
    () => engine.executeInTransaction(handle, "INSERT INTO t (id, value) VALUES ('a', 'dupe')"),
    (err: Error) => {
      assert.strictEqual(err.name, DatabaseErrors.UniqueConstraintViolation);
      return true;
    }
  );
  await engine.rollbackTransaction(handle);
});

// --- Regression: constructor creates missing intermediate directories ---
// index.mock.ts constructs the engine with a nested path (e.g. `.bb-data/main`).
// On a fresh checkout / after `rm -rf .bb-data`, PGlite's initdb only creates
// the leaf directory and ENOENTs on the missing parent. The constructor must
// create the full path itself.
test('constructor does not crash when parent directory is missing', async () => {
  const nested = join(TEST_DIR, 'deeply', 'nested', 'app-main');
  // Sanity: parent does not exist yet.
  assert.strictEqual(existsSync(join(TEST_DIR, 'deeply')), false);
  engine = new PGliteEngine(nested);
  await engine.execute('CREATE TABLE t (id TEXT PRIMARY KEY)');
  const rows = await engine.query('SELECT * FROM t');
  assert.deepStrictEqual(rows, []);
});

// --- Regression (#98): recover from an interrupted initdb ---
// When `tsx watch` SIGTERMs/SIGKILLs the dev server while a `Database` block is
// still running first-boot initdb, the data dir is left half-written: it exists
// and is non-empty but lacks the PG_VERSION / global/pg_control markers a
// complete data dir has. `new PGlite(dir)` then aborts on it, the dev server's
// local-deploy phase rejects before `listen()`, and the port never binds. The
// engine must detect this and re-initialize the leaf dir instead of aborting.

test('recovers from an incompletely-initialized data directory (interrupted initdb)', async () => {
  // Simulate a half-written initdb: a non-empty dir with no PG_VERSION. Opening
  // this with PGlite aborts the process (verified manually) — the constructor
  // must wipe and re-init it instead.
  mkdirSync(join(TEST_DIR, 'global'), { recursive: true });
  writeFileSync(join(TEST_DIR, 'postmaster.opts'), 'half-written\n');
  assert.strictEqual(existsSync(join(TEST_DIR, 'PG_VERSION')), false);

  engine = new PGliteEngine(TEST_DIR);
  // A successful query proves the dir was re-initialized rather than aborting.
  await engine.execute('CREATE TABLE t (id TEXT PRIMARY KEY, value TEXT)');
  const rows = await engine.query('SELECT * FROM t');
  assert.deepStrictEqual(rows, []);
  // The recovered dir is now a complete data directory.
  assert.strictEqual(existsSync(join(TEST_DIR, 'PG_VERSION')), true);
});

test('preserves a fully-initialized data directory across restart', async () => {
  // A complete dir (PG_VERSION + global/pg_control present) must NOT be wiped by
  // the recovery path — data persists across dev-server restarts as before.
  engine = new PGliteEngine(TEST_DIR);
  await engine.execute('CREATE TABLE t (id TEXT PRIMARY KEY, value TEXT)');
  await engine.execute("INSERT INTO t (id, value) VALUES ('a', 'one')");
  await engine.destroy();

  // Reopen the same directory — recovery must treat it as initialized and leave
  // the data intact.
  engine = new PGliteEngine(TEST_DIR);
  const rows = await engine.query<{ id: string; value: string }>('SELECT * FROM t');
  assert.deepStrictEqual(rows, [{ id: 'a', value: 'one' }]);
});

// --- Regression (#98 review): never wipe a PARENT of a complete data dir ---
// index.mock.ts opens leaf dirs (`.bb-data/<id>`), but cli.ts constructs
// `new PGliteEngine('.bb-data')` on the ROOT. After a normal dev run the root is
// non-empty (it holds a complete child like `main/`) yet has no root-level
// PG_VERSION — the original recovery treated "non-empty + markers absent" as
// "partial" and recursively wiped the root, destroying every local database.
// Recovery must affirmatively detect a partial data dir and leave a parent of
// real data dirs untouched. (We exercise recoverIncompleteDataDir directly: a
// parent dir is not a valid PGlite data dir, so `new PGlite(parent)` would abort
// the process — the very crash callers must never reach by wiping it.)
test('does not wipe a parent directory that contains a complete child data dir', async () => {
  // Build a complete child data dir with persisted data (mirrors `.bb-data/main`).
  const child = join(TEST_DIR, 'main');
  const childEngine = new PGliteEngine(child);
  await childEngine.execute('CREATE TABLE t (id TEXT PRIMARY KEY, value TEXT)');
  await childEngine.execute("INSERT INTO t (id, value) VALUES ('a', 'one')");
  await childEngine.destroy();
  // Sanity: the child is a complete data dir and the parent has no root markers.
  assert.strictEqual(existsSync(join(child, 'PG_VERSION')), true);
  assert.strictEqual(existsSync(join(TEST_DIR, 'PG_VERSION')), false);

  // Run recovery against the PARENT like the CLI's `new PGliteEngine('.bb-data')`
  // would. It must NOT wipe the parent or the child.
  recoverIncompleteDataDir(TEST_DIR);

  // The child data dir and its data must survive untouched.
  assert.strictEqual(existsSync(join(child, 'PG_VERSION')), true);
  const survivor = new PGliteEngine(child);
  const rows = await survivor.query<{ id: string; value: string }>('SELECT * FROM t');
  assert.deepStrictEqual(rows, [{ id: 'a', value: 'one' }]);
  await survivor.destroy();
});

test('does not wipe a non-empty directory with no PGlite artifacts', async () => {
  // Unrelated user files in a directory that is not a data dir at all: recovery
  // must leave them alone rather than recursively deleting the directory.
  mkdirSync(TEST_DIR, { recursive: true });
  writeFileSync(join(TEST_DIR, 'README.txt'), 'not a database\n');
  mkdirSync(join(TEST_DIR, 'notes'), { recursive: true });
  writeFileSync(join(TEST_DIR, 'notes', 'todo.txt'), 'keep me\n');

  recoverIncompleteDataDir(TEST_DIR);

  // The user files must still be present.
  assert.strictEqual(existsSync(join(TEST_DIR, 'README.txt')), true);
  assert.strictEqual(existsSync(join(TEST_DIR, 'notes', 'todo.txt')), true);
});
