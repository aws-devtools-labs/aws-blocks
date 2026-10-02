// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { DatabaseBase } from '@aws-blocks/data-common';
import type { DatabaseEngine, TransactionHandle, Transaction, SqlQuery } from '@aws-blocks/data-common';
import { unwrapQuery } from '@aws-blocks/data-common';
import { DatabaseErrors, isKnownDatabaseErrorName, reTagged } from './errors.js';
import { setRLSContext, type RLSContext } from './rls.js';

/** Read a diagnostic field (e.g. pg `code`/`severity`) off an unknown caught value. */
function readErrorField(err: unknown, key: string): unknown {
  return typeof err === 'object' && err !== null && key in err ? Reflect.get(err, key) : undefined;
}

/**
 * Transaction implementation that routes calls through a DatabaseEngine
 * using an opaque TransactionHandle.
 *
 * Used by {@link RLSScopedDatabase.transaction} to inject RLS context
 * before delegating to the engine's transaction methods.
 */
class RLSTransactionImpl implements Transaction {
  constructor(private engine: DatabaseEngine, private handle: TransactionHandle) {}

  async query<T>(query: SqlQuery): Promise<T[]> {
    const { sql, params } = unwrapQuery(query);
    return this.engine.queryInTransaction<T>(this.handle, sql, params);
  }

  async queryOne<T>(query: SqlQuery): Promise<T | null> {
    const { sql, params } = unwrapQuery(query);
    const rows = await this.engine.queryInTransaction<T>(this.handle, sql, params);
    return rows[0] ?? null;
  }

  async execute(query: SqlQuery): Promise<{ rowCount: number }> {
    const { sql, params } = unwrapQuery(query);
    return this.engine.executeInTransaction(this.handle, sql, params);
  }
}

/**
 * DatabaseBase extended with Row Level Security, raw query methods, and
 * TransactionFailed error naming. Used internally by the Database class.
 *
 * Exported as `DatabaseBase` for direct use in tests and external packages.
 */
export class RLSEnabledDatabase extends DatabaseBase {
  constructor(engine: DatabaseEngine) {
    super(engine);
  }

  /**
   * Return a new DatabaseBase scoped with RLS context.
   * Every query executed on the returned instance runs inside a transaction
   * with Supabase-compatible session variables (SET LOCAL ROLE + request.jwt.claims).
   */
  withRLS(context: RLSContext): RLSEnabledDatabase {
    return new RLSScopedDatabase(this.engine, context);
  }

  /**
   * Execute a raw SQL query (internal — used by crud() handlers).
   * Bypasses the branded SqlQuery requirement.
   * @internal
   */
  async queryRaw<T>(sql: string, params: unknown[]): Promise<T[]> {
    return this.engine.query<T>(sql, params);
  }

  /**
   * Execute a raw SQL statement (internal — used by crud() handlers).
   * @internal
   */
  async executeRaw(sql: string, params: unknown[]): Promise<{ rowCount: number }> {
    return this.engine.execute(sql, params);
  }

  /**
   * Execute a function within a database transaction.
   * Auto-commits on success, auto-rolls back if the function throws.
   *
   * @param fn - Function receiving a {@link Transaction} with query/queryOne/execute methods
   * @returns The value returned by `fn`
   * @throws {DatabaseErrors.TransactionFailed} If the transaction cannot be committed
   *   or if `fn` throws a non-database error
   *
   * @example
   * import { sql } from '@aws-blocks/bb-data';
   * await db.transaction(async (tx) => {
   *   await tx.execute(sql`UPDATE accounts SET balance = balance - ${100} WHERE id = ${fromId}`);
   *   await tx.execute(sql`UPDATE accounts SET balance = balance + ${100} WHERE id = ${toId}`);
   * });
   */
  override async transaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
    try {
      return await super.transaction(fn);
    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e));
      // A known DatabaseErrors name means an engine translator already produced a
      // branded BB error — re-throw it as-is. Otherwise re-tag to TransactionFailed
      // as a branded error with a stable message (raw error kept as cause) so the
      // name crosses the wire without leaking driver text (D-003).
      if (isKnownDatabaseErrorName(error.name)) throw error;
      throw reTagged(DatabaseErrors.TransactionFailed, error);
    }
  }
}

/**
 * Injects RLS session variables (SET LOCAL ROLE + claims) into every operation.
 * Returned by `withRLS()`. Cannot be nested.
 */
class RLSScopedDatabase extends RLSEnabledDatabase {
  private ctx: RLSContext;

  constructor(engine: DatabaseEngine, ctx: RLSContext) {
    super(engine);
    this.ctx = ctx;
  }

  /** @throws Always — cannot nest RLS scopes. */
  override withRLS(_context: RLSContext): RLSEnabledDatabase {
    throw new Error('Cannot nest withRLS() calls. This database is already RLS-scoped.');
  }

  override async query<T>(query: SqlQuery): Promise<T[]> {
    const { sql, params } = unwrapQuery(query);
    return this.queryRaw<T>(sql, params);
  }

  async queryRaw<T>(sql: string, params: unknown[]): Promise<T[]> {
    const handle = await this.engine.beginTransaction();
    try {
      await setRLSContext(this.engine, handle, this.ctx);
      const rows = await this.engine.queryInTransaction<T>(handle, sql, params);
      await this.engine.commitTransaction(handle);
      return rows;
    } catch (e) {
      await this.engine.rollbackTransaction(handle).catch(() => {});
      throw e;
    }
  }

  override async queryOne<T>(query: SqlQuery): Promise<T | null> {
    const rows = await this.query<T>(query);
    return rows[0] ?? null;
  }

  override async execute(query: SqlQuery): Promise<{ rowCount: number }> {
    const { sql, params } = unwrapQuery(query);
    return this.executeRaw(sql, params);
  }

  async executeRaw(sql: string, params: unknown[]): Promise<{ rowCount: number }> {
    const handle = await this.engine.beginTransaction();
    try {
      await setRLSContext(this.engine, handle, this.ctx);
      const result = await this.engine.executeInTransaction(handle, sql, params);
      await this.engine.commitTransaction(handle);
      return result;
    } catch (e) {
      await this.engine.rollbackTransaction(handle).catch(() => {});
      throw e;
    }
  }

  override async transaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
    const handle = await this.engine.beginTransaction();
    try {
      await setRLSContext(this.engine, handle, this.ctx);
      const tx = new RLSTransactionImpl(this.engine, handle);
      const result = await fn(tx);
      await this.engine.commitTransaction(handle);
      return result;
    } catch (e) {
      try {
        await this.engine.rollbackTransaction(handle);
      } catch (rollbackErr) {
        console.error('[Database] Rollback failed after transaction error', {
          code: readErrorField(rollbackErr, 'code'),
          severity: readErrorField(rollbackErr, 'severity'),
        });
      }
      const error = e instanceof Error ? e : new Error(String(e));
      // A known DatabaseErrors name means an engine translator already produced a
      // branded BB error — re-throw it as-is. Otherwise re-tag to TransactionFailed
      // as a branded error with a stable message (raw error kept as cause) so the
      // name crosses the wire without leaking driver text (D-003).
      if (isKnownDatabaseErrorName(error.name)) throw error;
      throw reTagged(DatabaseErrors.TransactionFailed, error);
    }
  }
}
