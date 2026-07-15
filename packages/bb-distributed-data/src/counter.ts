// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Atomic named counters for {@link DistributedDatabase} (Aurora DSQL).
 *
 * Aurora DSQL does not support sequences (`SERIAL`, `BIGSERIAL`, `CREATE SEQUENCE`),
 * so code that needs a monotonic sequence number is otherwise forced into a racy
 * `SELECT MAX(seq) + 1` read-modify-write: two concurrent callers read the same
 * max and both write the same next value, producing duplicate or skipped numbers.
 *
 * This primitive replaces that pattern with a single atomic upsert against a
 * framework-managed `_blocks_counters` table, wrapped in an OCC-retrying
 * transaction so concurrent callers never observe a duplicate value.
 */

import type { DatabaseBase, DatabaseEngine } from '@aws-blocks/data-common';
import { sql } from '@aws-blocks/data-common';
import { transactionWithRetry } from './transaction.js';

/** Name of the framework-managed table backing all atomic counters. */
export const COUNTER_TABLE = '_blocks_counters';

/**
 * Idempotent DDL for the framework-managed counter table.
 *
 * Created by the migration Lambda (as admin) in production and by the mock
 * engine during local init — never by the app runtime, which is DML-only.
 */
export const COUNTER_TABLE_DDL =
  `CREATE TABLE IF NOT EXISTS ${COUNTER_TABLE} (name TEXT PRIMARY KEY, value BIGINT NOT NULL DEFAULT 0)`;

/**
 * Create the framework-managed counter table if it does not already exist.
 *
 * Must run with DDL privileges — the admin role via the migration Lambda in
 * production, or inside `DsqlMockEngine.withDdl(...)` locally. The app runtime
 * only has DML access and must not call this.
 */
export async function ensureCounterTable(engine: DatabaseEngine): Promise<void> {
  await engine.execute(COUNTER_TABLE_DDL);
}

function assertValidName(name: string): void {
  if (typeof name !== 'string' || name.length === 0) {
    throw new Error('Counter name must be a non-empty string');
  }
}

function assertInteger(label: string, n: number): void {
  if (!Number.isInteger(n)) {
    throw new Error(`Counter ${label} must be an integer, received: ${n}`);
  }
}

/**
 * A named, atomic counter backed by {@link DistributedDatabase} (Aurora DSQL).
 *
 * Obtain one via {@link DistributedDatabase.counter}. Every mutation is a single
 * atomic upsert wrapped in an OCC-retrying transaction, so concurrent callers
 * never observe a duplicate or skipped value — the correct replacement for a
 * racy `SELECT MAX(seq) + 1` read-modify-write.
 *
 * Values are stored as `BIGINT` and returned as `number`; they are exact up to
 * `Number.MAX_SAFE_INTEGER` (2^53 − 1).
 *
 * @example
 * ```ts
 * // Per-user monotonic sequence, race-free under concurrency:
 * const seq = await db.counter(`notes:${userId}`).next();
 * await db.execute(sql`
 *   INSERT INTO notes (id, user_id, seq, body) VALUES (${id}, ${userId}, ${seq}, ${body})
 * `);
 * ```
 */
export class Counter {
  /** @internal Use {@link DistributedDatabase.counter} to construct. */
  constructor(
    private readonly resolveBase: () => Promise<DatabaseBase>,
    private readonly name: string,
  ) {
    assertValidName(name);
  }

  /**
   * Atomically add `delta` to the counter and return its new value.
   * The first call on a never-seen counter returns `delta` (default 1).
   *
   * @param delta - Integer amount to add. Defaults to 1. May be negative.
   * @returns The counter value after applying `delta`.
   */
  async next(delta = 1): Promise<number> {
    assertInteger('delta', delta);
    const base = await this.resolveBase();
    return transactionWithRetry(
      base,
      async (tx) => {
        const rows = await tx.query<{ value: string | number | bigint }>(sql`
          INSERT INTO _blocks_counters (name, value) VALUES (${this.name}, ${delta})
          ON CONFLICT (name) DO UPDATE SET value = _blocks_counters.value + ${delta}
          RETURNING value
        `);
        return Number(rows[0]!.value);
      },
      { retryOnConflict: true },
    );
  }

  /**
   * Read the current counter value without modifying it.
   * Returns 0 if the counter has never been incremented.
   */
  async current(): Promise<number> {
    const base = await this.resolveBase();
    const row = await base.queryOne<{ value: string | number | bigint }>(
      sql`SELECT value FROM _blocks_counters WHERE name = ${this.name}`,
    );
    return row ? Number(row.value) : 0;
  }

  /**
   * Atomically set the counter to an explicit value (default 0).
   * The next {@link Counter.next} call returns `value + delta`.
   *
   * @param value - Integer value to store. Defaults to 0.
   */
  async reset(value = 0): Promise<void> {
    assertInteger('value', value);
    const base = await this.resolveBase();
    await transactionWithRetry(
      base,
      async (tx) => {
        await tx.execute(sql`
          INSERT INTO _blocks_counters (name, value) VALUES (${this.name}, ${value})
          ON CONFLICT (name) DO UPDATE SET value = ${value}
        `);
      },
      { retryOnConflict: true },
    );
  }
}
