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
import type { DistributedDatabaseOptions, TransactionOptions } from './types.js';
import { Logger } from '@aws-blocks/bb-logger';
import type { ChildLogger } from '@aws-blocks/bb-logger';
import { BB_NAME, BB_VERSION } from './version.js';

export class DistributedDatabase extends Scope {
  private base: DatabaseBase;
  private mockEngine: DsqlMockEngine;
  private migrationsRun: Promise<void> | null = null;

  /** @internal Logger for internal operations. Defaults to error-level when not provided. */
  protected log: ChildLogger;

  constructor(scope: ScopeParent, id: string, options?: DistributedDatabaseOptions) {
    super(id, { parent: scope, bbName: BB_NAME, bbVersion: BB_VERSION });
    this.log = options?.logger ?? new Logger(this, 'logger', { level: 'error' });
    this.mockEngine = new DsqlMockEngine(`.bb-data/${this.fullId}`);
    this.base = new DatabaseBase(this.mockEngine);
    registerSdkIdentifiers(this.fullId, { clusterEndpoint: `mock-endpoint-${this.fullId}` });

    if (options?.migrationsPath) {
      const path = options.migrationsPath;
      this.migrationsRun = loadMigrationsFromDir(path)
        .then(m => this.mockEngine.withDdl(() => runMigrations(this.mockEngine, m)))
        .then(() => {});
    }
  }

  private async ready(): Promise<void> { if (this.migrationsRun) await this.migrationsRun; }

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

  /** Test helper: simulate OCC conflict on next commit. */
  simulateConflict(): void { this.mockEngine.simulateConflict(); }

  /** @internal */
  getEngine() { return this.base.getEngine(); }
}

export { sql, createKyselyAdapter } from '@aws-blocks/data-common';
export type { SqlQuery, Transaction } from '@aws-blocks/data-common';
export { DistributedDatabaseErrors } from './errors.js';
export type { DistributedDatabaseOptions, TransactionOptions } from './types.js';
