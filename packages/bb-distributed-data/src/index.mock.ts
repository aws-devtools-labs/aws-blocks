// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * DistributedDatabase — Local development entry point.
 * PGlite + DSQL validation layer.
 */

import { Scope, registerSdkIdentifiers } from '@aws-blocks/core';
import type { ScopeParent } from '@aws-blocks/core';
import { DatabaseBase, type SqlQuery, type Transaction } from '@aws-blocks/data-common';
import { DsqlMockEngine } from './engines/dsql-mock-engine.js';
import { runMigrations, loadMigrationsFromDir } from './migrations.js';
import { transactionWithRetry } from './transaction.js';
import { Counter, ensureCounterTable } from './counter.js';
import type { DistributedDatabaseOptions, TransactionOptions } from './types.js';
import { Logger } from '@aws-blocks/bb-logger';
import type { ChildLogger } from '@aws-blocks/bb-logger';

export class DistributedDatabase extends Scope {
  private base: DatabaseBase;
  private mockEngine: DsqlMockEngine;
  private initPromise: Promise<void>;

  /** @internal Logger for internal operations. Defaults to error-level when not provided. */
  protected log: ChildLogger;

  constructor(scope: ScopeParent, id: string, options?: DistributedDatabaseOptions) {
    super(id, { parent: scope });
    this.log = options?.logger ?? new Logger(this, 'logger', { level: 'error' });
    this.mockEngine = new DsqlMockEngine(`.bb-data/${this.fullId}`);
    this.base = new DatabaseBase(this.mockEngine);
    registerSdkIdentifiers(this.fullId, { clusterEndpoint: `mock-endpoint-${this.fullId}` });

    // Create the framework-managed counter table (and run migrations, if any)
    // in a single DDL window — the mock engine rejects DDL outside withDdl,
    // mirroring the app runtime's DML-only access.
    const migrationsPath = options?.migrationsPath;
    this.initPromise = this.mockEngine.withDdl(async () => {
      await ensureCounterTable(this.mockEngine);
      if (migrationsPath) {
        await runMigrations(this.mockEngine, await loadMigrationsFromDir(migrationsPath));
      }
    });
  }

  private async ready(): Promise<void> { await this.initPromise; }

  query<T>(query: SqlQuery): Promise<T[]> { return this.ready().then(() => this.base.query<T>(query)); }
  queryOne<T>(query: SqlQuery): Promise<T | null> { return this.ready().then(() => this.base.queryOne<T>(query)); }
  execute(query: SqlQuery): Promise<{ rowCount: number }> { return this.ready().then(() => this.base.execute(query)); }

  /**
   * Execute a function within a transaction with optional OCC retry.
   *
   * DSQL uses Optimistic Concurrency Control. Commit may fail with
   * SerializationFailureException if another transaction modified the same rows.
   */
  async transaction<T>(fn: (tx: Transaction) => Promise<T>, options?: TransactionOptions): Promise<T> {
    await this.ready();
    return transactionWithRetry(this.base, fn, options);
  }

  /**
   * Get a named atomic counter backed by this database.
   *
   * Use this instead of a racy `SELECT MAX(seq) + 1` read-modify-write when you
   * need a monotonic sequence number — DSQL has no sequences (SERIAL / BIGSERIAL).
   *
   * @param name - Stable identifier for the counter (e.g. `notes:${userId}`).
   */
  counter(name: string): Counter {
    return new Counter(async () => { await this.ready(); return this.base; }, name);
  }

  /** Test helper: simulate OCC conflict on next commit. */
  simulateConflict(): void { this.mockEngine.simulateConflict(); }

  /** @internal */
  getEngine() { return this.base.getEngine(); }
}

export { sql, createKyselyAdapter } from '@aws-blocks/data-common';
export type { SqlQuery, Transaction } from '@aws-blocks/data-common';
export { DistributedDatabaseErrors } from './errors.js';
export { Counter } from './counter.js';
export type { DistributedDatabaseOptions, TransactionOptions } from './types.js';
