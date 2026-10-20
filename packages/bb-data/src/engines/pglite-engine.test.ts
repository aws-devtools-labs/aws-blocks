// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test, afterEach } from 'node:test';
import assert from 'node:assert';
import { ApiError } from '@aws-blocks/core';
import { PGlite } from '@electric-sql/pglite';
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

test('duplicate key throws UniqueConstraintViolation as ApiError status 409', async () => {
  await setup();
  await engine.execute("INSERT INTO t (id, value) VALUES ('a', 'one')");
  await assert.rejects(
    () => engine.execute("INSERT INTO t (id, value) VALUES ('a', 'dupe')"),
    (err: unknown) => {
      assert.ok(err instanceof ApiError, 'expected an ApiError');
      assert.strictEqual(err.status, 409, 'duplicate key must be 409, not 500');
      assert.strictEqual(err.name, DatabaseErrors.UniqueConstraintViolation);
      assert.strictEqual(err.retriable, false, 'duplicate key is not retriable');
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
    (err: unknown) => {
      assert.ok(err instanceof ApiError, 'expected an ApiError');
      assert.strictEqual(err.status, 409);
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

// --- Regression #188: PGlite WASM `_pg_initdb` `unreachable` init trap ---
// The first query forces PGlite's lazy WASM initdb, which can intermittently
// trap with `unreachable` under memory pressure and kill the process during
// runMigrations. The engine must recreate the instance and retry instead.
// A factory injects a first instance that traps on the init probe; recovery
// then falls through to a REAL PGlite so data round-trips end-to-end.

test('recovers when the first PGlite instance traps during init', async () => {
  const dir = join(TEST_DIR, 'init-trap-recover');
  let creates = 0;
  const factory = (d: string): PGlite => {
    creates++;
    if (creates === 1) {
      return {
        query: async () => {
          throw new Error('Aborted(). Build with -sASSERTIONS for more info. RuntimeError: unreachable');
        },
        close: async () => {},
      } as unknown as PGlite;
    }
    return new PGlite(d);
  };
  engine = new PGliteEngine(dir, factory);
  await engine.execute('CREATE TABLE t (id TEXT PRIMARY KEY)');
  await engine.execute("INSERT INTO t (id) VALUES ('ok')");
  const rows = await engine.query<{ id: string }>('SELECT id FROM t');
  assert.deepStrictEqual(rows, [{ id: 'ok' }]);
  assert.strictEqual(creates, 2, 'engine should recreate the trapped instance exactly once');
});

test('surfaces a QueryFailed error when init keeps trapping', async () => {
  const dir = join(TEST_DIR, 'init-trap-persistent');
  const factory = (): PGlite =>
    ({
      query: async () => {
        throw new Error('RuntimeError: unreachable');
      },
      close: async () => {},
    }) as unknown as PGlite;
  engine = new PGliteEngine(dir, factory);
  await assert.rejects(
    () => engine.execute('CREATE TABLE t (id TEXT PRIMARY KEY)'),
    (err: Error) => {
      assert.strictEqual(err.name, DatabaseErrors.QueryFailed);
      return true;
    },
  );
});

// --- Regression #188 (recovery): a later call must succeed after the init
// retry budget is fully exhausted, once memory pressure eases and the factory
// stops trapping. The exhausted attempt closes the last instance; if the
// engine kept that dead handle, the next call would re-probe a CLOSED instance
// whose error is a "closed" error (NOT `unreachable`) and thus non-retryable,
// wedging the engine permanently. The trapped instances below faithfully model
// a real PGlite: `unreachable` while open, a "closed" error after close().
test('recovers on a later call after the init-retry budget is exhausted', async () => {
  const dir = join(TEST_DIR, 'init-trap-exhaust-recover');
  let creates = 0;
  const factory = (d: string): PGlite => {
    creates++;
    // Default maxAttempts is 3, so the first ensureReady probes creates 1..3.
    if (creates <= 3) {
      let closed = false;
      return {
        query: async () => {
          throw new Error(
            closed ? 'PGlite is closed' : 'Aborted(). RuntimeError: unreachable',
          );
        },
        close: async () => {
          closed = true;
        },
      } as unknown as PGlite;
    }
    return new PGlite(d);
  };
  engine = new PGliteEngine(dir, factory);

  // First call exhausts the 3-attempt retry budget and rejects.
  await assert.rejects(
    () => engine.execute('CREATE TABLE t (id TEXT PRIMARY KEY)'),
    (err: Error) => {
      assert.strictEqual(err.name, DatabaseErrors.QueryFailed);
      return true;
    },
  );

  // Once the factory stops trapping, a later call must recover on a fresh
  // instance instead of re-probing the closed handle forever.
  await engine.execute('CREATE TABLE t (id TEXT PRIMARY KEY)');
  await engine.execute("INSERT INTO t (id) VALUES ('ok')");
  const rows = await engine.query<{ id: string }>('SELECT id FROM t');
  assert.deepStrictEqual(rows, [{ id: 'ok' }]);
  assert.ok(creates >= 4, 'engine should build a fresh instance after exhaustion');
});

// --- Regression: destroy() before the first query ---
// PGlite 0.5.10's close() never resolves while the instance is still
// initializing (electric-sql/pglite#1148). The other tests always query before
// destroy(), which forces init, so these pin the never-queried path.

/** Rejects if `promise` has not settled within `ms`, so a hang fails the test instead of stalling it. */
async function settlesWithin<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not settle within ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

test('destroy resolves for an engine that never ran a query', async () => {
  engine = new PGliteEngine(join(TEST_DIR, 'destroy-before-query'));
  await settlesWithin(engine.destroy(), 15_000, 'destroy()');
});

test('destroy waits for PGlite init to settle before closing', async () => {
  let ready = false;
  let closed = false;
  // Mimics PGlite 0.5.10: close() hangs if it is called before init has settled.
  const factory = (): PGlite =>
    ({
      waitReady: new Promise<void>((resolve) => setTimeout(() => { ready = true; resolve(); }, 50)),
      query: async () => ({ rows: [] }),
      close: () => (ready ? Promise.resolve().then(() => { closed = true; }) : new Promise<void>(() => {})),
    }) as unknown as PGlite;
  engine = new PGliteEngine(join(TEST_DIR, 'destroy-waits-for-init'), factory);
  await settlesWithin(engine.destroy(), 5_000, 'destroy()');
  assert.strictEqual(closed, true, 'destroy() should close the instance once init settles');
});
