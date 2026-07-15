// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test, afterEach } from 'node:test';
import assert from 'node:assert';
import { PGlite } from '@electric-sql/pglite';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { DsqlMockEngine } from './dsql-mock-engine.js';
import { DistributedDatabaseErrors } from '../errors.js';

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
