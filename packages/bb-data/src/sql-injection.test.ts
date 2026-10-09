// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * SQL injection regression tests — validates that parameterized queries
 * are safe against real PostgreSQL (PGlite).
 *
 * Unit tests for the sql tagged template (parameterization, branding, forgery)
 * live in @aws-blocks/data-common alongside the implementation.
 *
 * These tests live here because they exercise the full engine stack
 * (PGliteEngine + sql tag together) to prove injection safety end-to-end.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert';
import { sql } from '@aws-blocks/data-common';
import { PGliteEngine } from './engines/pglite-engine.js';
import { RLSEnabledDatabase } from './database.js';

// Track every engine created so it can be released in teardown. PGlite 0.3+
// no longer force-exits the process on an un-destroyed instance (0.2 did), so a
// leaked WASM instance keeps the Node event loop open and `node --test` hangs
// until the CI job times out. Destroying them here lets the runner exit cleanly.
const engines: PGliteEngine[] = [];

function createDb(): RLSEnabledDatabase {
  const engine = new PGliteEngine(`.bb-data-sql-test-${process.pid}`);
  engines.push(engine);
  return new RLSEnabledDatabase(engine);
}

afterEach(async () => {
  for (const engine of engines.splice(0)) {
    await engine.destroy().catch(() => {});
  }
});

async function setupTable(db: RLSEnabledDatabase) {
  await db.execute(sql`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT, role TEXT DEFAULT 'user')`);
  await db.execute(sql`DELETE FROM users`);
  await db.execute(sql`INSERT INTO users VALUES ('u1', 'Alice', 'user')`);
  await db.execute(sql`INSERT INTO users VALUES ('u2', 'Bob', 'admin')`);
}

test('injection: DROP TABLE in interpolation is treated as a value, not executed', async () => {
  const db = createDb();
  await setupTable(db);

  const malicious = "'; DROP TABLE users; --";
  const rows = await db.query(sql`SELECT * FROM users WHERE id = ${malicious}`);
  assert.deepStrictEqual(rows, []); // no match, but table still exists

  // Table must still exist and have all rows
  const all = await db.query(sql`SELECT * FROM users ORDER BY id`);
  assert.strictEqual(all.length, 2);
});

test('injection: OR 1=1 in interpolation does not bypass WHERE clause', async () => {
  const db = createDb();
  await setupTable(db);

  const malicious = "' OR '1'='1";
  const rows = await db.query(sql`SELECT * FROM users WHERE id = ${malicious}`);
  assert.deepStrictEqual(rows, []); // no match — the whole string is the parameter value
});

test('injection: UNION SELECT in interpolation is treated as a value', async () => {
  const db = createDb();
  await setupTable(db);

  const malicious = "' UNION SELECT id, name, role FROM users --";
  const rows = await db.query(sql`SELECT * FROM users WHERE name = ${malicious}`);
  assert.deepStrictEqual(rows, []); // no match, no union executed
});

test('injection: stacked queries via semicolon in interpolation are harmless', async () => {
  const db = createDb();
  await setupTable(db);

  const malicious = "x'; DELETE FROM users; SELECT '";
  await db.execute(sql`UPDATE users SET name = ${malicious} WHERE id = ${'u1'}`);

  // All rows must still exist
  const all = await db.query(sql`SELECT * FROM users ORDER BY id`);
  assert.strictEqual(all.length, 2);
  // u1's name should literally be the malicious string
  const u1 = await db.queryOne<{ name: string }>(sql`SELECT name FROM users WHERE id = ${'u1'}`);
  assert.strictEqual(u1?.name, malicious);
});

test('injection: comment injection (--) in interpolation is treated as a value', async () => {
  const db = createDb();
  await setupTable(db);

  const malicious = "admin' --";
  const rows = await db.query(sql`SELECT * FROM users WHERE name = ${malicious} AND role = ${'user'}`);
  assert.deepStrictEqual(rows, []); // no match — comment syntax is just data
});

test('injection: integer column with string payload is rejected as invalid type, not executed as SQL', async () => {
  const db = createDb();
  await db.execute(sql`CREATE TABLE IF NOT EXISTS orders (id SERIAL PRIMARY KEY, amount INTEGER, note TEXT)`);
  await db.execute(sql`DELETE FROM orders`);
  await db.execute(sql`INSERT INTO orders (amount, note) VALUES (100, 'legit')`);

  const malicious = "1 OR 1=1";
  // Postgres rejects "1 OR 1=1" as invalid integer — proving it's treated as
  // a parameter value, not interpreted as SQL. If it were executed as SQL,
  // it would return all rows instead of throwing a type error. The engine
  // re-tags the driver error to a branded QueryFailed with a stable BB message
  // (raw driver text never crosses the wire), keeping the original Postgres
  // error as `cause` — so the invalid-integer proof is read off the cause.
  await assert.rejects(
    () => db.query(sql`SELECT * FROM orders WHERE amount = ${malicious}`),
    (err: Error) => {
      const raw = err.cause instanceof Error ? err.cause : err;
      return raw.message.includes('invalid input syntax for type integer');
    }
  );
});
