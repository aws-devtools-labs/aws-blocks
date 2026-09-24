// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * E2E tests for DistributedDatabase mock engine (PGlite + validation).
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { DatabaseBase, sql, type Transaction } from '@aws-blocks/data-common';
import { DsqlMockEngine } from './engines/dsql-mock-engine.js';
import { DistributedDatabaseErrors } from './errors.js';
import { runMigrations } from './migrations.js';
import { transactionWithRetry } from './transaction.js';
import type { TransactionOptions } from './types.js';

const DIR = '.bb-data/__test_dsql_e2e__';

describe('DistributedDatabase E2E (mock)', () => {
  let engine: DsqlMockEngine;
  let db: DatabaseBase;

  before(async () => {
    rmSync(DIR, { recursive: true, force: true });
    engine = new DsqlMockEngine(DIR);
    db = new DatabaseBase(engine);
    // Schema setup is DDL, which the app runtime rejects (parity with prod
    // dsql:DbConnect). Run it through the migration-style withDdl escape hatch.
    await engine.withDdl(async () => {
      await db.execute(sql`CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE)`);
      await db.execute(sql`CREATE TABLE accounts (id TEXT PRIMARY KEY, balance INT NOT NULL DEFAULT 0)`);
    });
  });

  after(async () => {
    await engine.destroy();
    rmSync(DIR, { recursive: true, force: true });
  });

  it('CRUD', async () => {
    await db.execute(sql`INSERT INTO users (id, name, email) VALUES (${'u1'}, ${'Alice'}, ${'a@t.com'})`);
    await db.execute(sql`INSERT INTO users (id, name, email) VALUES (${'u2'}, ${'Bob'}, ${'b@t.com'})`);
    const rows = await db.query<{ name: string }>(sql`SELECT name FROM users ORDER BY name`);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].name, 'Alice');

    const one = await db.queryOne<{ name: string }>(sql`SELECT name FROM users WHERE id = ${'u1'}`);
    assert.equal(one?.name, 'Alice');
    assert.equal(await db.queryOne(sql`SELECT * FROM users WHERE id = ${'x'}`), null);

    const upd = await db.execute(sql`UPDATE users SET name = ${'A2'} WHERE id = ${'u1'}`);
    assert.equal(upd.rowCount, 1);
  });

  it('transaction commits', async () => {
    await db.execute(sql`INSERT INTO accounts (id, balance) VALUES (${'a1'}, ${1000})`);
    await db.execute(sql`INSERT INTO accounts (id, balance) VALUES (${'a2'}, ${500})`);
    await db.transaction(async (tx) => {
      await tx.execute(sql`UPDATE accounts SET balance = balance - ${100} WHERE id = ${'a1'}`);
      await tx.execute(sql`UPDATE accounts SET balance = balance + ${100} WHERE id = ${'a2'}`);
    });
    const a1 = await db.queryOne<{ balance: number }>(sql`SELECT balance FROM accounts WHERE id = ${'a1'}`);
    assert.equal(a1?.balance, 900);
  });

  it('transaction rolls back on error', async () => {
    const before = await db.queryOne<{ balance: number }>(sql`SELECT balance FROM accounts WHERE id = ${'a1'}`);
    await assert.rejects(() => db.transaction(async (tx) => {
      await tx.execute(sql`UPDATE accounts SET balance = 0 WHERE id = ${'a1'}`);
      throw new Error('fail');
    }));
    const after = await db.queryOne<{ balance: number }>(sql`SELECT balance FROM accounts WHERE id = ${'a1'}`);
    assert.equal(after?.balance, before?.balance);
  });

  it('simulateConflict throws SerializationFailure', async () => {
    engine.simulateConflict();
    await assert.rejects(
      () => db.transaction(async (tx) => { await tx.execute(sql`UPDATE accounts SET balance = 1 WHERE id = ${'a1'}`); }),
      (e: Error) => { assert.equal(e.name, DistributedDatabaseErrors.SerializationFailure); return true; }
    );
  });

  it('retryOnConflict recovers', async () => {
    engine.simulateConflict();
    const result = await transactionWithRetry(
      db,
      async (tx) => { await tx.execute(sql`UPDATE accounts SET balance = balance + ${1} WHERE id = ${'a2'}`); return 'ok'; },
      { retryOnConflict: true }
    );
    assert.equal(result, 'ok');
  });

  it('rejects FK at query time', async () => {
    await assert.rejects(() => db.execute(sql`CREATE TABLE bad (id TEXT REFERENCES users(id))`), { name: 'DsqlValidationError' });
  });

  it('rejects DDL+DML in transaction', async () => {
    await assert.rejects(() => db.transaction(async (tx) => {
      await tx.execute(sql`INSERT INTO users (id, name) VALUES (${'x'}, ${'X'})`);
      await tx.execute(sql`CREATE TABLE fail (id TEXT)`);
    }), { name: 'DsqlPermissionError' });
  });

  it('unique constraint violation', async () => {
    await assert.rejects(
      () => db.execute(sql`INSERT INTO users (id, name, email) VALUES (${'u1'}, ${'Dup'}, ${'dup@t.com'})`),
      (e: Error) => { assert.equal(e.name, DistributedDatabaseErrors.UniqueConstraintViolation); return true; }
    );
  });
});

describe('Migration runner E2E', () => {
  const DIR2 = '.bb-data/__test_dsql_migrations__';
  let engine: DsqlMockEngine;

  before(async () => { rmSync(DIR2, { recursive: true, force: true }); engine = new DsqlMockEngine(DIR2); });
  after(async () => { await engine.destroy(); rmSync(DIR2, { recursive: true, force: true }); });

  it('runs and tracks migrations', async () => {
    const applied = await engine.withDdl(() => runMigrations(engine, {
      '001.sql': 'CREATE TABLE t (id TEXT PRIMARY KEY, name TEXT)',
      '002.sql': "INSERT INTO t (id, name) VALUES ('1', 'Admin')",
    }));
    assert.deepEqual(applied, ['001.sql', '002.sql']);
    const rows = await engine.query<{ name: string }>('SELECT name FROM t');
    assert.equal(rows[0].name, 'Admin');
  });

  it('skips already-applied', async () => {
    const applied = await engine.withDdl(() => runMigrations(engine, {
      '001.sql': 'CREATE TABLE t (id TEXT PRIMARY KEY, name TEXT)',
      '002.sql': "INSERT INTO t (id, name) VALUES ('1', 'Admin')",
      '003.sql': 'ALTER TABLE t ADD COLUMN age INT',
    }));
    assert.deepEqual(applied, ['003.sql']);
  });

  it('rejects invalid migrations', async () => {
    await assert.rejects(() => engine.withDdl(() => runMigrations(engine, {
      '004.sql': 'CREATE TABLE bad (id TEXT REFERENCES t(id))',
    })), { name: 'DsqlMigrationValidationError' });
  });
});

// ─── DsqlMockEngine — CREATE INDEX ASYNC parity ─────────────────────────────
// DSQL supports `CREATE INDEX ASYNC` for non-blocking index builds. The mock
// engine must accept this syntax and execute it synchronously (PGlite doesn't
// understand the ASYNC keyword natively).

describe('DsqlMockEngine — CREATE INDEX ASYNC parity', () => {
  const DIR3 = '.bb-data/__test_dsql_async_index__';
  let engine: DsqlMockEngine;
  let db: DatabaseBase;

  before(async () => {
    rmSync(DIR3, { recursive: true, force: true });
    engine = new DsqlMockEngine(DIR3);
    db = new DatabaseBase(engine);
    // CREATE INDEX is DDL, which the app runtime rejects. This suite exercises
    // the engine's CREATE INDEX ASYNC preprocessing directly, so run all DDL
    // through the withDdl escape hatch (the same one the migration runner uses).
    await engine.withDdl(() => db.execute(sql`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT, active BOOLEAN DEFAULT true)`));
  });

  after(async () => {
    await engine.destroy();
    rmSync(DIR3, { recursive: true, force: true });
  });

  it('accepts CREATE INDEX ASYNC (executes as synchronous locally)', async () => {
    await assert.doesNotReject(
      () => engine.withDdl(() => db.execute(sql`CREATE INDEX ASYNC idx_users_email ON users(email)`))
    );
  });

  it('makes the index usable immediately after CREATE INDEX ASYNC', async () => {
    await engine.withDdl(() => db.execute(sql`CREATE INDEX ASYNC idx_users_active ON users(active)`));
    // If the index was actually created, EXPLAIN/usage and inserts still work.
    await db.execute(sql`INSERT INTO users (id, email, active) VALUES (${'u-async'}, ${'a@t.com'}, ${true})`);
    const row = await db.queryOne<{ id: string }>(sql`SELECT id FROM users WHERE active = ${true} AND id = ${'u-async'}`);
    assert.equal(row?.id, 'u-async');
  });

  it('accepts CREATE UNIQUE INDEX ASYNC', async () => {
    await assert.doesNotReject(
      () => engine.withDdl(() => db.execute(sql`CREATE UNIQUE INDEX ASYNC idx_users_email_uniq ON users(email)`))
    );
  });

  it('accepts CREATE INDEX ASYNC with IF NOT EXISTS', async () => {
    await assert.doesNotReject(
      () => engine.withDdl(() => db.execute(sql`CREATE INDEX ASYNC IF NOT EXISTS idx_users_email2 ON users(email)`))
    );
  });

  it('accepts a partial CREATE INDEX ASYNC (WHERE clause)', async () => {
    await assert.doesNotReject(
      () => engine.withDdl(() => db.execute(sql`CREATE INDEX ASYNC idx_users_active_email ON users(email) WHERE active = true`))
    );
  });

  it('still supports a plain CREATE INDEX (no ASYNC)', async () => {
    await assert.doesNotReject(
      () => engine.withDdl(() => db.execute(sql`CREATE INDEX idx_users_plain ON users(id)`))
    );
  });

  it('rejects CREATE INDEX ASYNC with a DESC sort order on a key', async () => {
    await assert.rejects(
      () => engine.withDdl(() => db.execute(sql`CREATE INDEX ASYNC idx_users_email_desc ON users (email DESC)`)),
      /sort order/i,
    );
  });

  it('rejects ALTER TABLE DROP COLUMN', async () => {
    await engine.withDdl(() => db.execute(sql`CREATE TABLE legacy (id TEXT PRIMARY KEY, obsolete TEXT)`));
    await assert.rejects(
      () => engine.withDdl(() => db.execute(sql`ALTER TABLE legacy DROP COLUMN obsolete`)),
      /DROP COLUMN/i,
    );
  });

  it('does not strip ASYNC outside of CREATE INDEX (column named "async")', async () => {
    await engine.withDdl(() => db.execute(sql`CREATE TABLE jobs (id TEXT PRIMARY KEY, async BOOLEAN)`));
    await db.execute(sql`INSERT INTO jobs (id, async) VALUES (${'j1'}, ${true})`);
    const row = await db.queryOne<{ async: boolean }>(sql`SELECT async FROM jobs WHERE id = ${'j1'}`);
    assert.equal(row?.async, true);
  });

  it('does not strip the word ASYNC inside a string literal', async () => {
    await engine.withDdl(() => db.execute(sql`CREATE TABLE notes (id TEXT PRIMARY KEY, body TEXT)`));
    await db.execute(sql`INSERT INTO notes (id, body) VALUES (${'n1'}, ${'run ASYNC index later'})`);
    const row = await db.queryOne<{ body: string }>(sql`SELECT body FROM notes WHERE id = ${'n1'}`);
    assert.equal(row?.body, 'run ASYNC index later');
  });

  it('runs migrations that use CREATE INDEX ASYNC', async () => {
    const DIR4 = '.bb-data/__test_dsql_async_index_mig__';
    rmSync(DIR4, { recursive: true, force: true });
    const mengine = new DsqlMockEngine(DIR4);
    try {
      const applied = await mengine.withDdl(() => runMigrations(mengine, {
        '001_create_posts.sql': 'CREATE TABLE posts (id TEXT PRIMARY KEY, slug TEXT)',
        '002_index_slug.sql': 'CREATE INDEX ASYNC idx_posts_slug ON posts(slug)',
      }));
      assert.deepEqual(applied, ['001_create_posts.sql', '002_index_slug.sql']);
    } finally {
      await mengine.destroy();
      rmSync(DIR4, { recursive: true, force: true });
    }
  });
});
