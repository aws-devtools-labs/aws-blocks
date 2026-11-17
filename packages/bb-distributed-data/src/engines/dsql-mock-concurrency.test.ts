// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Overlapping work on the local DSQL mock: PGlite has one session, so the
 * engine must keep each transaction to itself.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Scope, isBlocksError } from '@aws-blocks/core';
import { DatabaseBase, sql } from '@aws-blocks/data-common';
import { DsqlMockEngine } from './dsql-mock-engine.js';
import { DistributedDatabase } from '../index.mock.js';
import { DistributedDatabaseErrors } from '../errors.js';

const DIR = `.bb-data-dsql-concurrency-test-${process.pid}`;

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

describe('DsqlMockEngine session isolation', () => {
  let engine: DsqlMockEngine;
  let db: DatabaseBase;

  const value = async () =>
    (await db.queryOne<{ value: number }>(sql`SELECT value FROM counters WHERE id = ${'c'}`))?.value;

  before(async () => {
    rmSync(DIR, { recursive: true, force: true });
    engine = new DsqlMockEngine(join(DIR, 'engine'));
    db = new DatabaseBase(engine);
    await engine.withDdl(() => db.execute(sql`CREATE TABLE counters (id TEXT PRIMARY KEY, value INT NOT NULL)`));
  });

  after(async () => {
    await engine.destroy();
    rmSync(DIR, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await db.execute(sql`DELETE FROM counters WHERE id = ${'c'}`);
    await db.execute(sql`INSERT INTO counters (id, value) VALUES (${'c'}, ${0})`);
  });

  it('runs overlapping read-modify-write transactions one after the other', async () => {
    const increment = () =>
      db.transaction(async (tx) => {
        const row = await tx.queryOne<{ value: number }>(sql`SELECT value FROM counters WHERE id = ${'c'}`);
        await tick();
        await tx.execute(sql`UPDATE counters SET value = ${(row?.value ?? 0) + 1} WHERE id = ${'c'}`);
      });
    await Promise.all([increment(), increment(), increment()]);
    assert.equal(await value(), 3);
  });

  it('keeps a standalone write out of a transaction that rolls back', async () => {
    let outside: Promise<unknown> | undefined;
    await assert.rejects(
      db.transaction(async (tx) => {
        await tx.execute(sql`UPDATE counters SET value = value + 10 WHERE id = ${'c'}`);
        outside = db.execute(sql`UPDATE counters SET value = value + 100 WHERE id = ${'c'}`);
        await tick();
        throw new Error('app error');
      }),
      /app error/,
    );
    await outside;
    assert.equal(await value(), 100);
  });

  it('runs a standalone write after the open transaction commits', async () => {
    let outside: Promise<unknown> | undefined;
    await db.transaction(async (tx) => {
      await tx.execute(sql`UPDATE counters SET value = 5 WHERE id = ${'c'}`);
      outside = db.execute(sql`UPDATE counters SET value = value * 2 WHERE id = ${'c'}`);
      await tick();
      await tx.execute(sql`UPDATE counters SET value = value + 1 WHERE id = ${'c'}`);
    });
    await outside;
    assert.equal(await value(), 12);
  });

  it('still applies every concurrent standalone update', async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => db.execute(sql`UPDATE counters SET value = value + 1 WHERE id = ${'c'}`)),
    );
    assert.deepEqual(results.map((r) => r.status), Array(5).fill('fulfilled'));
    assert.equal(await value(), 5);
  });

  it('frees the session after a simulated conflict, without rolling back the next transaction', async () => {
    engine.simulateConflict();
    const conflicted = db.transaction(async (tx) => {
      await tx.execute(sql`UPDATE counters SET value = value + 1 WHERE id = ${'c'}`);
    });
    const next = db.transaction(async (tx) => {
      await tx.execute(sql`UPDATE counters SET value = value + 10 WHERE id = ${'c'}`);
    });
    await assert.rejects(conflicted, (e: unknown) => isBlocksError(e, DistributedDatabaseErrors.SerializationFailure));
    await next;
    assert.equal(await value(), 10);
  });

  it('frees the session after a statement in a transaction fails', async () => {
    await assert.rejects(
      db.transaction(async (tx) => {
        await tx.execute(sql`INSERT INTO counters (id, value) VALUES (${'c'}, ${1})`);
      }),
      (e: unknown) => isBlocksError(e, DistributedDatabaseErrors.UniqueConstraintViolation),
    );
    await db.execute(sql`UPDATE counters SET value = 7 WHERE id = ${'c'}`);
    assert.equal(await value(), 7);
  });

  it('refuses a statement on a transaction that has ended', async () => {
    const handle = await engine.beginTransaction();
    await engine.commitTransaction(handle);
    await assert.rejects(
      engine.executeInTransaction(handle, 'UPDATE counters SET value = 1'),
      (e: unknown) => isBlocksError(e, DistributedDatabaseErrors.TransactionFailed),
    );
    await engine.rollbackTransaction(handle);
    assert.equal(await value(), 0);
  });
});

describe('DistributedDatabase (mock) inside a transaction callback', () => {
  let db: DistributedDatabase;
  const migrations = join(DIR, 'migrations');

  const value = async () =>
    (await db.queryOne<{ value: number }>(sql`SELECT value FROM counters WHERE id = ${'c'}`))?.value;

  before(async () => {
    Scope._resetRegistry();
    rmSync(DIR, { recursive: true, force: true });
    mkdirSync(migrations, { recursive: true });
    writeFileSync(join(migrations, '001_counters.sql'), 'CREATE TABLE counters (id TEXT PRIMARY KEY, value INT NOT NULL)');
    db = new DistributedDatabase(new Scope(`dsql-concurrency-${process.pid}`), 'db', { migrationsPath: migrations });
    await db.execute(sql`INSERT INTO counters (id, value) VALUES (${'c'}, ${0})`);
  });

  after(async () => {
    await db.getEngine().destroy();
    rmSync(DIR, { recursive: true, force: true });
    rmSync(`.bb-data/${db.fullId}`, { recursive: true, force: true });
  });

  it("runs the block's own statements in the open transaction", async () => {
    await assert.rejects(
      db.transaction(async (tx) => {
        await tx.execute(sql`UPDATE counters SET value = value + 1 WHERE id = ${'c'}`);
        await db.execute(sql`UPDATE counters SET value = value + 1 WHERE id = ${'c'}`);
        assert.equal(await value(), 2);
        throw new Error('app error');
      }),
      /app error/,
    );
    assert.equal(await value(), 0);
  });

  it('refuses a nested transaction() instead of waiting on its own session', async () => {
    await db.transaction(async () => {
      await assert.rejects(
        db.transaction(async () => {}),
        (e: unknown) => isBlocksError(e, DistributedDatabaseErrors.TransactionFailed),
      );
    });
  });

  it('runs a statement left running after the callback returns as its own write', async () => {
    let late: Promise<unknown> | undefined;
    await db.transaction(async (tx) => {
      await tx.execute(sql`UPDATE counters SET value = 1 WHERE id = ${'c'}`);
      late = tick().then(() => db.execute(sql`UPDATE counters SET value = value + 1 WHERE id = ${'c'}`));
    });
    await late;
    assert.equal(await value(), 2);
  });
});
