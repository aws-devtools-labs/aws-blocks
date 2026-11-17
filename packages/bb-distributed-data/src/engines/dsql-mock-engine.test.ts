// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test, afterEach } from 'node:test';
import assert from 'node:assert';
import { PGlite } from '@electric-sql/pglite';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { DsqlMockEngine } from './dsql-mock-engine.js';
import { DistributedDatabaseErrors } from '../errors.js';
import { ApiError } from '@aws-blocks/core';

const TEST_DIR = '.bb-data-dsql-mock-test-' + process.pid;
let engine: DsqlMockEngine;

afterEach(async () => {
  if (engine) await engine.destroy().catch(() => {});
  rmSync(TEST_DIR, { recursive: true, force: true });
});

// --- Regression #188: PGlite WASM `_pg_initdb` `unreachable` init trap ---
// The DSQL mock wraps PGlite; the same lazy-init WASM trap kills the dev server
// during runMigrations. A factory injects a first instance that traps on the
// init probe; recovery falls through to a REAL PGlite so data round-trips.

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
  engine = new DsqlMockEngine(dir, factory);
  await engine.withDdl(() => engine.execute('CREATE TABLE t (id TEXT PRIMARY KEY)'));
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
  engine = new DsqlMockEngine(dir, factory);
  await assert.rejects(
    () => engine.execute("INSERT INTO t (id) VALUES ('x')"),
    (err: Error) => {
      assert.strictEqual(err.name, DistributedDatabaseErrors.QueryFailed);
      return true;
    },
  );
});

// beginTransaction() forces the same lazy WASM init as query()/execute(); an
// exhausted init-retry at transaction start must also normalize to QueryFailed
// rather than leaking a raw `RuntimeError: unreachable`.
test('surfaces a QueryFailed error when init keeps trapping during beginTransaction', async () => {
  const dir = join(TEST_DIR, 'init-trap-begin-transaction');
  const factory = (): PGlite =>
    ({
      query: async () => {
        throw new Error('RuntimeError: unreachable');
      },
      close: async () => {},
    }) as unknown as PGlite;
  engine = new DsqlMockEngine(dir, factory);
  await assert.rejects(
    () => engine.beginTransaction(),
    (err: Error) => {
      assert.strictEqual(err.name, DistributedDatabaseErrors.QueryFailed);
      return true;
    },
  );
});

// --- Regression #188 (recovery): a later call must succeed after the init
// retry budget is fully exhausted, once the factory stops trapping. The
// exhausted attempt closes the last instance; keeping that dead handle would
// make the next call re-probe a CLOSED instance whose error is a "closed"
// error (NOT `unreachable`) and thus non-retryable, wedging the engine
// permanently. Trapped instances model a real PGlite: `unreachable` while
// open, a "closed" error after close().
test('recovers on a later call after the init-retry budget is exhausted', async () => {
  const dir = join(TEST_DIR, 'init-trap-exhaust-recover');
  let creates = 0;
  const factory = (d: string): PGlite => {
    creates++;
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
  engine = new DsqlMockEngine(dir, factory);

  // First call exhausts the 3-attempt retry budget and rejects.
  await assert.rejects(
    () => engine.withDdl(() => engine.execute('CREATE TABLE t (id TEXT PRIMARY KEY)')),
    (err: Error) => {
      assert.strictEqual(err.name, DistributedDatabaseErrors.QueryFailed);
      return true;
    },
  );

  // Once the factory stops trapping, a later call must recover on a fresh
  // instance instead of re-probing the closed handle forever.
  await engine.withDdl(() => engine.execute('CREATE TABLE t (id TEXT PRIMARY KEY)'));
  await engine.execute("INSERT INTO t (id) VALUES ('ok')");
  const rows = await engine.query<{ id: string }>('SELECT id FROM t');
  assert.deepStrictEqual(rows, [{ id: 'ok' }]);
  assert.ok(creates >= 4, 'engine should build a fresh instance after exhaustion');
});

// --- OCC conflict surfaces as HTTP 409 (Conflict) ---
// A simulated serialization-failure (SQLSTATE 40001) on commit must reach the
// caller as an ApiError with status 409 — not a plain 500 — while preserving
// the SerializationFailure name and flagging the conflict retriable, so mock
// and real DSQL engines behave identically over the JSON-RPC wire.
test('commit OCC conflict surfaces as an ApiError with status 409', async () => {
  const dir = join(TEST_DIR, 'occ-conflict-409');
  engine = new DsqlMockEngine(dir);
  const handle = await engine.beginTransaction();
  engine.simulateConflict();
  await assert.rejects(
    () => engine.commitTransaction(handle),
    (e: unknown) => {
      assert.ok(e instanceof ApiError, 'expected an ApiError');
      assert.strictEqual(e.status, 409);
      assert.strictEqual(e.name, DistributedDatabaseErrors.SerializationFailure);
      assert.strictEqual(e.retriable, true);
      return true;
    },
  );
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
  engine = new DsqlMockEngine(join(TEST_DIR, 'destroy-before-query'));
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
  engine = new DsqlMockEngine(join(TEST_DIR, 'destroy-waits-for-init'), factory);
  await settlesWithin(engine.destroy(), 5_000, 'destroy()');
  assert.strictEqual(closed, true, 'destroy() should close the instance once init settles');
});
