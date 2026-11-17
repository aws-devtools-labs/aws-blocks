// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test, afterEach } from 'node:test';
import assert from 'node:assert';
import { Database, DatabaseErrors } from './index.mock.js';
import { PGliteEngine } from './engines/pglite-engine.js';
import { RLSEnabledDatabase } from './database.js';
import { sql } from '@aws-blocks/data-common';
import { rmSync } from 'node:fs';

const TEST_DIR = '.bb-data-contract-' + process.pid;
let base: RLSEnabledDatabase;

// Track every engine created so teardown can release its WASM instance.
// PGlite 0.3+ no longer force-exits on close, so an unclosed engine keeps
// the Node event loop alive and `node --test` never exits (57-min CI hang).
const engines: PGliteEngine[] = [];

afterEach(async () => {
  for (const engine of engines.splice(0)) {
    await engine.destroy().catch(() => {});
  }
  rmSync(TEST_DIR, { recursive: true, force: true });
});

function createDb(): RLSEnabledDatabase {
  const engine = new PGliteEngine(TEST_DIR);
  engines.push(engine);
  base = new RLSEnabledDatabase(engine);
  return base;
}

// --- query ---

test('Database.query returns rows', async () => {
  const db = createDb();
  await db.execute(sql`CREATE TABLE t (id TEXT PRIMARY KEY, value TEXT)`);
  await db.execute(sql`INSERT INTO t VALUES ('a', 'one')`);
  const rows = await db.query<{ id: string; value: string }>(sql`SELECT * FROM t`);
  assert.deepStrictEqual(rows, [{ id: 'a', value: 'one' }]);
});

test('Database.query returns empty array for no matches', async () => {
  const db = createDb();
  await db.execute(sql`CREATE TABLE t (id TEXT PRIMARY KEY)`);
  const rows = await db.query(sql`SELECT * FROM t WHERE id = ${'nope'}`);
  assert.deepStrictEqual(rows, []);
});

// --- queryOne ---

test('Database.queryOne returns first row', async () => {
  const db = createDb();
  await db.execute(sql`CREATE TABLE t (id TEXT PRIMARY KEY)`);
  await db.execute(sql`INSERT INTO t VALUES ('a')`);
  const row = await db.queryOne<{ id: string }>(sql`SELECT * FROM t WHERE id = ${'a'}`);
  assert.deepStrictEqual(row, { id: 'a' });
});

test('Database.queryOne returns null for no matches', async () => {
  const db = createDb();
  await db.execute(sql`CREATE TABLE t (id TEXT PRIMARY KEY)`);
  const row = await db.queryOne(sql`SELECT * FROM t WHERE id = ${'nope'}`);
  assert.strictEqual(row, null);
});

// --- execute ---

test('Database.execute returns rowCount', async () => {
  const db = createDb();
  await db.execute(sql`CREATE TABLE t (id TEXT PRIMARY KEY)`);
  const result = await db.execute(sql`INSERT INTO t VALUES ('a')`);
  assert.strictEqual(result.rowCount, 1);
});

// --- transaction ---

test('Database.transaction auto-commits on success', async () => {
  const db = createDb();
  await db.execute(sql`CREATE TABLE accounts (id TEXT PRIMARY KEY, balance INTEGER NOT NULL)`);
  await db.execute(sql`INSERT INTO accounts VALUES ('alice', 1000)`);
  await db.execute(sql`INSERT INTO accounts VALUES ('bob', 0)`);

  await db.transaction(async (tx) => {
    await tx.execute(sql`UPDATE accounts SET balance = balance - ${200} WHERE id = ${'alice'}`);
    await tx.execute(sql`UPDATE accounts SET balance = balance + ${200} WHERE id = ${'bob'}`);
  });

  const alice = await db.queryOne<{ balance: number }>(sql`SELECT balance FROM accounts WHERE id = ${'alice'}`);
  const bob = await db.queryOne<{ balance: number }>(sql`SELECT balance FROM accounts WHERE id = ${'bob'}`);
  assert.strictEqual(alice?.balance, 800);
  assert.strictEqual(bob?.balance, 200);
});

test('Database.transaction auto-rolls back when callback throws', async () => {
  const db = createDb();
  await db.execute(sql`CREATE TABLE t (id TEXT PRIMARY KEY, value TEXT)`);
  await db.execute(sql`INSERT INTO t VALUES ('a', 'original')`);

  await assert.rejects(
    () => db.transaction(async (tx) => {
      await tx.execute(sql`UPDATE t SET value = 'changed' WHERE id = 'a'`);
      throw new Error('abort');
    })
  );

  const row = await db.queryOne<{ value: string }>(sql`SELECT value FROM t WHERE id = ${'a'}`);
  assert.strictEqual(row?.value, 'original');
});

test('Database.transaction - queries inside see uncommitted changes', async () => {
  const db = createDb();
  await db.execute(sql`CREATE TABLE t (id TEXT PRIMARY KEY)`);

  await db.transaction(async (tx) => {
    await tx.execute(sql`INSERT INTO t VALUES ('a')`);
    const row = await tx.queryOne<{ id: string }>(sql`SELECT * FROM t WHERE id = ${'a'}`);
    assert.deepStrictEqual(row, { id: 'a' });
  });
});

test('Database.transaction - tx.queryOne returns null for no matches', async () => {
  const db = createDb();
  await db.execute(sql`CREATE TABLE t (id TEXT PRIMARY KEY)`);

  await db.transaction(async (tx) => {
    const row = await tx.queryOne(sql`SELECT * FROM t WHERE id = ${'nope'}`);
    assert.strictEqual(row, null);
  });
});

// --- error handling ---

test('UniqueConstraintViolation on duplicate key', async () => {
  const db = createDb();
  await db.execute(sql`CREATE TABLE t (id TEXT PRIMARY KEY)`);
  await db.execute(sql`INSERT INTO t VALUES ('a')`);

  await assert.rejects(
    () => db.execute(sql`INSERT INTO t VALUES ('a')`),
    (err: Error) => {
      assert.strictEqual(err.name, DatabaseErrors.UniqueConstraintViolation);
      return true;
    }
  );
});

test('QueryFailed on invalid SQL', async () => {
  const db = createDb();
  await assert.rejects(
    () => db.query(sql`SELECT FROM INVALID !!!`),
    (err: Error) => {
      assert.strictEqual(err.name, DatabaseErrors.QueryFailed);
      return true;
    }
  );
});

test('TransactionFailed wraps non-database errors in transaction', async () => {
  const db = createDb();
  await db.execute(sql`CREATE TABLE t (id TEXT PRIMARY KEY)`);

  await assert.rejects(
    () => db.transaction(async () => { throw new Error('app error'); }),
    (err: Error) => {
      assert.strictEqual(err.name, DatabaseErrors.TransactionFailed);
      return true;
    }
  );
});

// --- fromExisting ---

test('fromExisting returns the config object unchanged', async () => {
  const { fromExisting } = await import('./index.mock.js');
  const config = { host: 'my-cluster.rds.amazonaws.com', database: 'mydb', secretArn: 'arn:aws:secretsmanager:us-east-1:123:secret:x' };
  const result = fromExisting(config);
  assert.deepStrictEqual(result, config);
});
