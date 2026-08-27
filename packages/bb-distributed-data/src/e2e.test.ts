// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * E2E tests for the DistributedDatabase public API.
 *
 * Exercises the full user-facing surface: DistributedDatabase class with migrations,
 * CRUD, transactions, OCC retry, and DSQL validation guardrails.
 *
 * Runs against the mock engine (PGlite) locally. The same test scenarios
 * would apply against a real DSQL cluster — swap the import condition to
 * 'aws-runtime' and provide DSQL_ENDPOINT / AWS_REGION env vars.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DistributedDatabase, sql, DistributedDatabaseErrors } from './index.mock.js';
import type { Transaction } from './index.mock.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

const TEST_DIR = '.bb-data/__test_dsql_public_api__';
const MIGRATIONS_DIR = join(TEST_DIR, 'migrations');

/** Minimal scope stub — DistributedDatabase extends Scope which needs a parent. */
const scope = { id: 'test' };

function uniqueId(): string {
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// ── Setup migrations on disk ────────────────────────────────────────────────

function writeMigrations(files: Record<string, string>): void {
  rmSync(MIGRATIONS_DIR, { recursive: true, force: true });
  mkdirSync(MIGRATIONS_DIR, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(MIGRATIONS_DIR, name), content);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Test Suite: DistributedDatabase with migrations
// ═══════════════════════════════════════════════════════════════════════════════

describe('DistributedDatabase — public API with migrations', () => {
  let db: InstanceType<typeof DistributedDatabase>;

  before(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
    writeMigrations({
      '001_create_users.sql': `CREATE TABLE users (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL
      )`,
      '002_create_accounts.sql': `CREATE TABLE accounts (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        balance INT NOT NULL DEFAULT 0
      )`,
      '003_seed_admin.sql': `INSERT INTO users (id, name, email) VALUES ('admin', 'Admin', 'admin@test.com')`,
    });
    db = new DistributedDatabase(scope as any, 'e2e', { migrationsPath: MIGRATIONS_DIR });
  });

  after(async () => {
    await (db as any).mockEngine.destroy();
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // ── Migrations ──────────────────────────────────────────────────────────

  describe('migrations', () => {
    it('applies migrations and seeds data on first query', async () => {
      const admin = await db.queryOne<{ name: string; email: string }>(
        sql`SELECT name, email FROM users WHERE id = ${'admin'}`
      );
      assert.equal(admin?.name, 'Admin');
      assert.equal(admin?.email, 'admin@test.com');
    });

    it('created all tables from migrations', async () => {
      // Verify accounts table exists by inserting
      const { rowCount } = await db.execute(
        sql`INSERT INTO accounts (id, owner_id, balance) VALUES (${'acc-check'}, ${'admin'}, ${0})`
      );
      assert.equal(rowCount, 1);
      await db.execute(sql`DELETE FROM accounts WHERE id = ${'acc-check'}`);
    });
  });

  // ── CRUD Operations ─────────────────────────────────────────────────────

  describe('CRUD', () => {
    it('insert and query', async () => {
      const id = uniqueId();
      const { rowCount } = await db.execute(
        sql`INSERT INTO users (id, name, email) VALUES (${id}, ${'Alice'}, ${`alice-${id}@test.com`})`
      );
      assert.equal(rowCount, 1);

      const rows = await db.query<{ id: string; name: string }>(
        sql`SELECT id, name FROM users WHERE id = ${id}`
      );
      assert.equal(rows.length, 1);
      assert.equal(rows[0].name, 'Alice');

      await db.execute(sql`DELETE FROM users WHERE id = ${id}`);
    });

    it('queryOne returns row or null', async () => {
      const id = uniqueId();
      await db.execute(
        sql`INSERT INTO users (id, name, email) VALUES (${id}, ${'Bob'}, ${`bob-${id}@test.com`})`
      );

      const found = await db.queryOne<{ name: string }>(sql`SELECT name FROM users WHERE id = ${id}`);
      assert.equal(found?.name, 'Bob');

      const missing = await db.queryOne(sql`SELECT * FROM users WHERE id = ${'nonexistent'}`);
      assert.equal(missing, null);

      await db.execute(sql`DELETE FROM users WHERE id = ${id}`);
    });

    it('update returns affected row count', async () => {
      const id = uniqueId();
      await db.execute(
        sql`INSERT INTO users (id, name, email) VALUES (${id}, ${'Carol'}, ${`carol-${id}@test.com`})`
      );

      const { rowCount } = await db.execute(sql`UPDATE users SET name = ${'Carol2'} WHERE id = ${id}`);
      assert.equal(rowCount, 1);

      const updated = await db.queryOne<{ name: string }>(sql`SELECT name FROM users WHERE id = ${id}`);
      assert.equal(updated?.name, 'Carol2');

      await db.execute(sql`DELETE FROM users WHERE id = ${id}`);
    });

    it('delete returns affected row count', async () => {
      const id = uniqueId();
      await db.execute(
        sql`INSERT INTO users (id, name, email) VALUES (${id}, ${'Del'}, ${`del-${id}@test.com`})`
      );

      const { rowCount } = await db.execute(sql`DELETE FROM users WHERE id = ${id}`);
      assert.equal(rowCount, 1);

      const gone = await db.queryOne(sql`SELECT * FROM users WHERE id = ${id}`);
      assert.equal(gone, null);
    });

    it('query with multiple results ordered', async () => {
      const ids = [uniqueId(), uniqueId(), uniqueId()];
      for (const [i, id] of ids.entries()) {
        await db.execute(
          sql`INSERT INTO users (id, name, email) VALUES (${id}, ${`User${i}`}, ${`u${i}-${id}@test.com`})`
        );
      }

      const rows = await db.query<{ name: string }>(
        sql`SELECT name FROM users WHERE id = ANY(${ids}) ORDER BY name`
      );
      assert.equal(rows.length, 3);
      assert.equal(rows[0].name, 'User0');
      assert.equal(rows[2].name, 'User2');

      for (const id of ids) await db.execute(sql`DELETE FROM users WHERE id = ${id}`);
    });
  });

  // ── Transactions ────────────────────────────────────────────────────────

  describe('transactions', () => {
    it('commits atomically', async () => {
      const a = uniqueId();
      const b = uniqueId();
      await db.execute(sql`INSERT INTO accounts (id, owner_id, balance) VALUES (${a}, ${'x'}, ${1000})`);
      await db.execute(sql`INSERT INTO accounts (id, owner_id, balance) VALUES (${b}, ${'y'}, ${500})`);

      await db.transaction(async (tx: Transaction) => {
        await tx.execute(sql`UPDATE accounts SET balance = balance - ${200} WHERE id = ${a}`);
        await tx.execute(sql`UPDATE accounts SET balance = balance + ${200} WHERE id = ${b}`);
      });

      const accA = await db.queryOne<{ balance: number }>(sql`SELECT balance FROM accounts WHERE id = ${a}`);
      const accB = await db.queryOne<{ balance: number }>(sql`SELECT balance FROM accounts WHERE id = ${b}`);
      assert.equal(accA?.balance, 800);
      assert.equal(accB?.balance, 700);

      await db.execute(sql`DELETE FROM accounts WHERE id = ${a}`);
      await db.execute(sql`DELETE FROM accounts WHERE id = ${b}`);
    });

    it('rolls back on error — no partial writes', async () => {
      const id = uniqueId();
      await db.execute(sql`INSERT INTO accounts (id, owner_id, balance) VALUES (${id}, ${'z'}, ${100})`);

      await assert.rejects(() => db.transaction(async (tx: Transaction) => {
        await tx.execute(sql`UPDATE accounts SET balance = ${0} WHERE id = ${id}`);
        throw new Error('Simulated failure');
      }), /Simulated failure/);

      const acc = await db.queryOne<{ balance: number }>(sql`SELECT balance FROM accounts WHERE id = ${id}`);
      assert.equal(acc?.balance, 100); // unchanged

      await db.execute(sql`DELETE FROM accounts WHERE id = ${id}`);
    });

    it('returns value from transaction callback', async () => {
      const id = uniqueId();
      await db.execute(sql`INSERT INTO accounts (id, owner_id, balance) VALUES (${id}, ${'w'}, ${42})`);

      const result = await db.transaction(async (tx: Transaction) => {
        const row = await tx.queryOne<{ balance: number }>(sql`SELECT balance FROM accounts WHERE id = ${id}`);
        return row!.balance * 2;
      });
      assert.equal(result, 84);

      await db.execute(sql`DELETE FROM accounts WHERE id = ${id}`);
    });
  });

  // ── OCC Conflict & Retry ───────────────────────────────────────────────

  describe('OCC conflict handling', () => {
    it('throws SerializationFailureException without retry', async () => {
      const id = uniqueId();
      await db.execute(sql`INSERT INTO accounts (id, owner_id, balance) VALUES (${id}, ${'occ'}, ${50})`);

      db.simulateConflict();
      await assert.rejects(
        () => db.transaction(async (tx: Transaction) => {
          await tx.execute(sql`UPDATE accounts SET balance = ${99} WHERE id = ${id}`);
        }),
        (e: Error) => {
          assert.equal(e.name, DistributedDatabaseErrors.SerializationFailure);
          return true;
        }
      );

      await db.execute(sql`DELETE FROM accounts WHERE id = ${id}`);
    });

    it('retryOnConflict recovers transparently', async () => {
      const id = uniqueId();
      await db.execute(sql`INSERT INTO accounts (id, owner_id, balance) VALUES (${id}, ${'occ2'}, ${10})`);

      db.simulateConflict();
      const result = await db.transaction(
        async (tx: Transaction) => {
          await tx.execute(sql`UPDATE accounts SET balance = balance + ${5} WHERE id = ${id}`);
          return 'done';
        },
        { retryOnConflict: true }
      );
      assert.equal(result, 'done');

      const acc = await db.queryOne<{ balance: number }>(sql`SELECT balance FROM accounts WHERE id = ${id}`);
      assert.equal(acc?.balance, 15);

      await db.execute(sql`DELETE FROM accounts WHERE id = ${id}`);
    });

    it('respects maxRetries limit', async () => {
      const id = uniqueId();
      await db.execute(sql`INSERT INTO accounts (id, owner_id, balance) VALUES (${id}, ${'occ3'}, ${1})`);

      // Simulate conflict on every attempt — should exhaust retries
      let attempts = 0;
      const origSimulate = db.simulateConflict.bind(db);

      await assert.rejects(
        () => db.transaction(
          async (tx: Transaction) => {
            attempts++;
            db.simulateConflict(); // re-arm for next attempt
            await tx.execute(sql`UPDATE accounts SET balance = ${99} WHERE id = ${id}`);
          },
          { retryOnConflict: true, maxRetries: 2 }
        ),
        (e: Error) => {
          assert.equal(e.name, DistributedDatabaseErrors.SerializationFailure);
          return true;
        }
      );
      // 1 initial + 2 retries = 3 attempts
      assert.equal(attempts, 3);

      await db.execute(sql`DELETE FROM accounts WHERE id = ${id}`);
    });
  });

  // ── DSQL Validation Guardrails ─────────────────────────────────────────

  describe('DSQL validation at query time', () => {
    it('accepts FOREIGN KEY syntax before the runtime DDL permission check', async () => {
      await assert.rejects(
        () => db.execute(sql`CREATE TABLE bad_fk (id TEXT, ref TEXT REFERENCES users(id))`),
        { name: 'DsqlPermissionError' }
      );
    });

    it('rejects SERIAL/BIGSERIAL', async () => {
      await assert.rejects(
        () => db.execute(sql`CREATE TABLE bad_serial (id SERIAL PRIMARY KEY)`),
        { name: 'DsqlValidationError' }
      );
    });

    it('rejects TRUNCATE', async () => {
      await assert.rejects(
        () => db.execute(sql`TRUNCATE TABLE users`),
        { name: 'DsqlValidationError' }
      );
    });

    it('rejects CREATE VIEW at runtime', async () => {
      await assert.rejects(
        () => db.execute(sql`CREATE VIEW user_names AS SELECT name FROM users`),
        { name: 'DsqlPermissionError' }
      );
    });

    it('rejects CREATE TRIGGER', async () => {
      await assert.rejects(
        () => db.execute(sql`CREATE TRIGGER t BEFORE INSERT ON users FOR EACH ROW EXECUTE FUNCTION f()`),
        { name: 'DsqlValidationError' }
      );
    });

    it('rejects TEMP TABLE', async () => {
      await assert.rejects(
        () => db.execute(sql`CREATE TEMP TABLE staging (id TEXT)`),
        { name: 'DsqlValidationError' }
      );
    });

    // DDL is rejected outright in the app runtime (parity with prod
    // dsql:DbConnect, which is DML-only), so any CREATE inside a normal
    // transaction surfaces as DsqlPermissionError before the DDL/DML mixing
    // rule is ever evaluated.
    it('rejects DDL + DML in same transaction', async () => {
      await assert.rejects(
        () => db.transaction(async (tx: Transaction) => {
          await tx.execute(sql`INSERT INTO users (id, name, email) VALUES (${'x'}, ${'X'}, ${'x@t.com'})`);
          await tx.execute(sql`CREATE TABLE should_fail (id TEXT PRIMARY KEY)`);
        }),
        { name: 'DsqlPermissionError' }
      );
    });

    it('rejects multiple DDL in same transaction', async () => {
      await assert.rejects(
        () => db.transaction(async (tx: Transaction) => {
          await tx.execute(sql`CREATE TABLE t1 (id TEXT PRIMARY KEY)`);
          await tx.execute(sql`CREATE TABLE t2 (id TEXT PRIMARY KEY)`);
        }),
        { name: 'DsqlPermissionError' }
      );
    });
  });

  // ── Error Translation ──────────────────────────────────────────────────

  describe('error translation', () => {
    it('unique constraint violation → UniqueConstraintViolationException', async () => {
      const id = uniqueId();
      await db.execute(
        sql`INSERT INTO users (id, name, email) VALUES (${id}, ${'First'}, ${`dup-${id}@test.com`})`
      );

      await assert.rejects(
        () => db.execute(
          sql`INSERT INTO users (id, name, email) VALUES (${id}, ${'Second'}, ${`dup2-${id}@test.com`})`
        ),
        (e: Error) => {
          assert.equal(e.name, DistributedDatabaseErrors.UniqueConstraintViolation);
          return true;
        }
      );

      await db.execute(sql`DELETE FROM users WHERE id = ${id}`);
    });

    it('unique constraint on email column', async () => {
      const id1 = uniqueId();
      const id2 = uniqueId();
      const email = `shared-${uniqueId()}@test.com`;

      await db.execute(sql`INSERT INTO users (id, name, email) VALUES (${id1}, ${'A'}, ${email})`);

      await assert.rejects(
        () => db.execute(sql`INSERT INTO users (id, name, email) VALUES (${id2}, ${'B'}, ${email})`),
        (e: Error) => {
          assert.equal(e.name, DistributedDatabaseErrors.UniqueConstraintViolation);
          return true;
        }
      );

      await db.execute(sql`DELETE FROM users WHERE id = ${id1}`);
    });
  });

  // ── Concurrent-style Scenarios ─────────────────────────────────────────

  describe('realistic scenarios', () => {
    it('bank transfer — debit and credit are atomic', async () => {
      const alice = uniqueId();
      const bob = uniqueId();
      await db.execute(sql`INSERT INTO accounts (id, owner_id, balance) VALUES (${alice}, ${'alice'}, ${1000})`);
      await db.execute(sql`INSERT INTO accounts (id, owner_id, balance) VALUES (${bob}, ${'bob'}, ${200})`);

      await db.transaction(async (tx: Transaction) => {
        const sender = await tx.queryOne<{ balance: number }>(
          sql`SELECT balance FROM accounts WHERE id = ${alice}`
        );
        if (!sender || sender.balance < 300) throw new Error('Insufficient funds');
        await tx.execute(sql`UPDATE accounts SET balance = balance - ${300} WHERE id = ${alice}`);
        await tx.execute(sql`UPDATE accounts SET balance = balance + ${300} WHERE id = ${bob}`);
      });

      const a = await db.queryOne<{ balance: number }>(sql`SELECT balance FROM accounts WHERE id = ${alice}`);
      const b = await db.queryOne<{ balance: number }>(sql`SELECT balance FROM accounts WHERE id = ${bob}`);
      assert.equal(a?.balance, 700);
      assert.equal(b?.balance, 500);

      await db.execute(sql`DELETE FROM accounts WHERE id = ${alice}`);
      await db.execute(sql`DELETE FROM accounts WHERE id = ${bob}`);
    });

    it('insufficient funds — transaction aborts cleanly', async () => {
      const acc = uniqueId();
      await db.execute(sql`INSERT INTO accounts (id, owner_id, balance) VALUES (${acc}, ${'poor'}, ${10})`);

      await assert.rejects(
        () => db.transaction(async (tx: Transaction) => {
          const row = await tx.queryOne<{ balance: number }>(
            sql`SELECT balance FROM accounts WHERE id = ${acc}`
          );
          if (!row || row.balance < 1000) throw new Error('Insufficient funds');
          await tx.execute(sql`UPDATE accounts SET balance = balance - ${1000} WHERE id = ${acc}`);
        }),
        /Insufficient funds/
      );

      const row = await db.queryOne<{ balance: number }>(sql`SELECT balance FROM accounts WHERE id = ${acc}`);
      assert.equal(row?.balance, 10); // unchanged

      await db.execute(sql`DELETE FROM accounts WHERE id = ${acc}`);
    });

    it('batch insert with unique IDs', async () => {
      const ids: string[] = [];
      for (let i = 0; i < 10; i++) {
        const id = uniqueId();
        ids.push(id);
        await db.execute(
          sql`INSERT INTO accounts (id, owner_id, balance) VALUES (${id}, ${`owner-${i}`}, ${i * 100})`
        );
      }

      const rows = await db.query<{ balance: number }>(
        sql`SELECT balance FROM accounts WHERE id = ANY(${ids}) ORDER BY balance`
      );
      assert.equal(rows.length, 10);
      assert.equal(rows[0].balance, 0);
      assert.equal(rows[9].balance, 900);

      for (const id of ids) await db.execute(sql`DELETE FROM accounts WHERE id = ${id}`);
    });

    it('read-after-write consistency within transaction', async () => {
      const id = uniqueId();
      await db.execute(sql`INSERT INTO accounts (id, owner_id, balance) VALUES (${id}, ${'rw'}, ${0})`);

      await db.transaction(async (tx: Transaction) => {
        await tx.execute(sql`UPDATE accounts SET balance = ${500} WHERE id = ${id}`);
        const row = await tx.queryOne<{ balance: number }>(sql`SELECT balance FROM accounts WHERE id = ${id}`);
        assert.equal(row?.balance, 500); // sees own write
      });

      await db.execute(sql`DELETE FROM accounts WHERE id = ${id}`);
    });
  });
});
