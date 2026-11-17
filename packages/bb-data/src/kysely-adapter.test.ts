// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test, afterEach } from 'node:test';
import assert from 'node:assert';
import { DatabaseErrors } from './index.mock.js';
import { PGliteEngine } from './engines/pglite-engine.js';
import { RLSEnabledDatabase } from './database.js';
import { createKyselyAdapter } from '@aws-blocks/data-common';
import { sql } from '@aws-blocks/data-common';
import { rmSync } from 'node:fs';

const TEST_DIR = '.bb-data-kysely-' + process.pid;

// Track engines so teardown releases the WASM instance — PGlite 0.3+ does not
// force-exit on close, so an unclosed engine holds the event loop open and
// `node --test` never exits.
const engines: PGliteEngine[] = [];

afterEach(async () => {
  for (const engine of engines.splice(0)) {
    await engine.destroy().catch(() => {});
  }
  rmSync(TEST_DIR, { recursive: true, force: true });
});

interface TestSchema {
  t: { id: string; value: string };
}

function setup() {
  const engine = new PGliteEngine(TEST_DIR);
  engines.push(engine);
  const db = new RLSEnabledDatabase(engine);
  const kysely = createKyselyAdapter<TestSchema>(db);
  return { db, kysely };
}

test('createKyselyAdapter returns a Kysely instance', () => {
  const { kysely } = setup();
  assert.ok(kysely);
  assert.ok(typeof kysely.selectFrom === 'function');
});

test('Kysely selectFrom returns rows', async () => {
  const { db, kysely } = setup();
  await db.execute(sql`CREATE TABLE t (id TEXT PRIMARY KEY, value TEXT)`);
  await db.execute(sql`INSERT INTO t VALUES ('a', 'one')`);

  const rows = await kysely.selectFrom('t').selectAll().execute();
  assert.deepStrictEqual(rows, [{ id: 'a', value: 'one' }]);
});

test('Kysely insertInto works', async () => {
  const { db, kysely } = setup();
  await db.execute(sql`CREATE TABLE t (id TEXT PRIMARY KEY, value TEXT)`);

  await kysely.insertInto('t').values({ id: 'a', value: 'one' }).execute();

  const rows = await db.query<{ id: string; value: string }>(sql`SELECT * FROM t`);
  assert.deepStrictEqual(rows, [{ id: 'a', value: 'one' }]);
});

test('Kysely transaction commits', async () => {
  const { db, kysely } = setup();
  await db.execute(sql`CREATE TABLE t (id TEXT PRIMARY KEY, value TEXT)`);

  await kysely.transaction().execute(async (trx) => {
    await trx.insertInto('t').values({ id: 'a', value: 'one' }).execute();
  });

  const rows = await db.query<{ id: string }>(sql`SELECT id FROM t`);
  assert.deepStrictEqual(rows, [{ id: 'a' }]);
});

test('Kysely errors are translated to DatabaseErrors', async () => {
  const { db, kysely } = setup();
  await db.execute(sql`CREATE TABLE t (id TEXT PRIMARY KEY, value TEXT)`);
  await db.execute(sql`INSERT INTO t VALUES ('a', 'one')`);

  await assert.rejects(
    () => kysely.insertInto('t').values({ id: 'a', value: 'dupe' }).execute(),
    (err: Error) => {
      assert.strictEqual(err.name, DatabaseErrors.UniqueConstraintViolation);
      return true;
    }
  );
});
