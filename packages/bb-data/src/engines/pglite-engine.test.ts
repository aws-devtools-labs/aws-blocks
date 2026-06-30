// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test, afterEach } from 'node:test';
import assert from 'node:assert';
import { PGliteEngine } from './pglite-engine.js';
import { DatabaseErrors } from '../errors.js';
import { rmSync, existsSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
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

test('constructor recovers an incomplete PGlite init directory', async () => {
  const partial = join(TEST_DIR, 'partial-init');
  mkdirSync(partial, { recursive: true });
  writeFileSync(join(partial, 'PG_VERSION'), '16\n');

  engine = new PGliteEngine(partial);
  await engine.execute('CREATE TABLE t (id TEXT PRIMARY KEY)');
  await engine.execute("INSERT INTO t (id) VALUES ('ok')");

  const rows = await engine.query<{ id: string }>('SELECT id FROM t');
  assert.deepStrictEqual(rows, [{ id: 'ok' }]);
  assert.strictEqual(existsSync(join(partial, 'base')), true);
  assert.strictEqual(existsSync(join(partial, 'global')), true);

  const corruptDirs = readdirSync(TEST_DIR).filter((entry) => entry.startsWith('partial-init.corrupt-'));
  assert.strictEqual(corruptDirs.length, 1);
  assert.strictEqual(existsSync(join(TEST_DIR, corruptDirs[0], 'PG_VERSION')), true);
});

test('constructor recovers a PGlite init directory with empty required directories', async () => {
  const partial = join(TEST_DIR, 'empty-required-dirs');
  mkdirSync(join(partial, 'base'), { recursive: true });
  mkdirSync(join(partial, 'global'), { recursive: true });
  writeFileSync(join(partial, 'PG_VERSION'), '16\n');

  engine = new PGliteEngine(partial);
  await engine.execute('CREATE TABLE t (id TEXT PRIMARY KEY)');
  await engine.execute("INSERT INTO t (id) VALUES ('ok')");

  const rows = await engine.query<{ id: string }>('SELECT id FROM t');
  assert.deepStrictEqual(rows, [{ id: 'ok' }]);
  assert.strictEqual(existsSync(join(partial, 'global', 'pg_control')), true);

  const corruptDirs = readdirSync(TEST_DIR).filter((entry) => entry.startsWith('empty-required-dirs.corrupt-'));
  assert.strictEqual(corruptDirs.length, 1);
  assert.strictEqual(existsSync(join(TEST_DIR, corruptDirs[0], 'global')), true);
});

test('constructor recovers a PGlite leaf directory before PG_VERSION is written', async () => {
  const partial = join(TEST_DIR, 'pre-version-init');
  mkdirSync(join(partial, 'base'), { recursive: true });

  engine = new PGliteEngine(partial);
  await engine.execute('CREATE TABLE t (id TEXT PRIMARY KEY)');
  await engine.execute("INSERT INTO t (id) VALUES ('ok')");

  const rows = await engine.query<{ id: string }>('SELECT id FROM t');
  assert.deepStrictEqual(rows, [{ id: 'ok' }]);
  assert.strictEqual(existsSync(join(partial, 'PG_VERSION')), true);

  const corruptDirs = readdirSync(TEST_DIR).filter((entry) => entry.startsWith('pre-version-init.corrupt-'));
  assert.strictEqual(corruptDirs.length, 1);
  assert.strictEqual(existsSync(join(TEST_DIR, corruptDirs[0], 'base')), true);
});
