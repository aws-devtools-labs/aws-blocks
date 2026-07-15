// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the atomic Counter primitive (DSQL upsert semantics).
 *
 * Runs against the mock engine (PGlite). The atomic upsert replaces the racy
 * `SELECT MAX(seq) + 1` read-modify-write that DSQL otherwise forces (no
 * sequences), so the headline test asserts no duplicate values under
 * concurrent increments.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { DatabaseBase, sql } from '@aws-blocks/data-common';
import { DsqlMockEngine } from './engines/dsql-mock-engine.js';
import { Counter, ensureCounterTable, COUNTER_TABLE } from './counter.js';
import { DistributedDatabase } from './index.mock.js';

const DIR = '.bb-data/__test_counter__';

describe('Counter (mock)', () => {
  let engine: DsqlMockEngine;
  let base: DatabaseBase;
  const counter = (name: string) => new Counter(async () => base, name);

  before(async () => {
    rmSync(DIR, { recursive: true, force: true });
    engine = new DsqlMockEngine(DIR);
    base = new DatabaseBase(engine);
    // The counter table is DDL — created by admin/migrations in prod. Locally
    // it goes through the same withDdl escape hatch the migration runner uses.
    await engine.withDdl(() => ensureCounterTable(engine));
  });

  after(async () => {
    await engine.destroy();
    rmSync(DIR, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await base.execute(sql`DELETE FROM _blocks_counters`);
  });

  it('next() returns a monotonic sequence starting at 1', async () => {
    const c = counter('seq');
    assert.equal(await c.next(), 1);
    assert.equal(await c.next(), 2);
    assert.equal(await c.next(), 3);
  });

  it('next(delta) adds an arbitrary integer, including negatives', async () => {
    const c = counter('by-tens');
    assert.equal(await c.next(10), 10);
    assert.equal(await c.next(5), 15);
    assert.equal(await c.next(-3), 12);
  });

  it('current() reads without incrementing; unknown counter is 0', async () => {
    const c = counter('reads');
    assert.equal(await c.current(), 0);
    await c.next();
    await c.next();
    assert.equal(await c.current(), 2);
    assert.equal(await c.current(), 2);
  });

  it('reset() sets an explicit value', async () => {
    const c = counter('resettable');
    await c.next();
    await c.next();
    await c.reset(100);
    assert.equal(await c.current(), 100);
    assert.equal(await c.next(), 101);
    await c.reset();
    assert.equal(await c.current(), 0);
  });

  it('named counters are independent', async () => {
    const a = counter('a');
    const b = counter('b');
    await a.next();
    await a.next();
    await a.next();
    await b.next();
    assert.equal(await a.current(), 3);
    assert.equal(await b.current(), 1);
  });

  it('recovers from an OCC conflict via retry without double counting', async () => {
    const c = counter('occ');
    assert.equal(await c.next(), 1);
    engine.simulateConflict();
    // First commit throws 40001 and rolls back; retry succeeds. The rolled-back
    // attempt must NOT leak its increment.
    assert.equal(await c.next(), 2);
    assert.equal(await c.current(), 2);
  });

  it('concurrent next() calls never produce a duplicate value', async () => {
    const c = counter('race');
    const N = 25;
    const results = await Promise.all(Array.from({ length: N }, () => c.next()));
    const unique = new Set(results);
    assert.equal(
      unique.size,
      N,
      `expected ${N} unique values, got ${unique.size}: ${[...results].sort((x, y) => x - y).join(',')}`,
    );
    assert.equal(Math.max(...results), N);
    assert.equal(Math.min(...results), 1);
    assert.equal(await c.current(), N);
  });

  it('rejects an empty counter name', () => {
    assert.throws(() => counter(''), /non-empty string/);
  });

  it('rejects a non-integer delta or reset value', async () => {
    const c = counter('validate');
    await assert.rejects(() => c.next(1.5), /must be an integer/);
    await assert.rejects(() => c.reset(0.5), /must be an integer/);
  });
});

describe('DistributedDatabase.counter (mock integration)', () => {
  const scope = { id: 'test' };
  let db: InstanceType<typeof DistributedDatabase>;

  before(async () => {
    db = new DistributedDatabase(scope as any, 'counterint');
    // Clear any state persisted from a previous run of this data dir.
    await db.execute(sql`DELETE FROM _blocks_counters`);
  });

  after(async () => {
    await (db as any).mockEngine.destroy();
  });

  it('auto-creates the counter table with no migrations configured', async () => {
    // No migrationsPath was provided, yet counter() works — proving the table
    // is created during init (mirrors the migration Lambda creating it in prod).
    const seq = db.counter('notes:user-1');
    assert.equal(await seq.next(), 1);
    assert.equal(await seq.next(), 2);
    assert.equal(await db.counter('notes:user-2').next(), 1);
  });

  it('persists to the framework-managed _blocks_counters table', async () => {
    assert.equal(COUNTER_TABLE, '_blocks_counters');
    await db.counter('direct-check').next(7);
    const row = await db.queryOne<{ value: string | number }>(
      sql`SELECT value FROM _blocks_counters WHERE name = ${'direct-check'}`,
    );
    assert.equal(Number(row?.value), 7);
  });
});
