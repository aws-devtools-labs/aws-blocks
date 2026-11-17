// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * DistributedDatabase — Local development entry point.
 * PGlite + DSQL validation layer.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { Scope, registerSdkIdentifiers, brandBlocksError } from '@aws-blocks/core';
import type { ScopeParent } from '@aws-blocks/core';
import { DatabaseBase, type SqlQuery, type Transaction, trackEager, logRecovery } from '@aws-blocks/data-common';
import { DsqlMockEngine } from './engines/dsql-mock-engine.js';
import { DistributedDatabaseErrors } from './errors.js';
import { runMigrations, loadMigrationsFromDir } from './migrations.js';
import { transactionWithRetry } from './transaction.js';
import type { DistributedDatabaseOptions, TransactionOptions } from './types.js';
import { Logger } from '@aws-blocks/bb-logger';
import type { ChildLogger } from '@aws-blocks/bb-logger';
import { BB_NAME, BB_VERSION } from './version.js';
import { assertNotMockInDeployedEnv } from '@aws-blocks/core/bb-utils';

// Fail closed if this mock entry loads in a deployed env — see assertNotMockInDeployedEnv.
assertNotMockInDeployedEnv('bb-distributed-data');

export class DistributedDatabase extends Scope {
  private base: DatabaseBase;
  private mockEngine: DsqlMockEngine;
  private migrationsRun: Promise<void> | null = null;
  /** Restart the eager migration run after a transient PGlite init trap cleared the cache. */
  private startMigrations?: () => Promise<void>;
  private readonly txScope = new AsyncLocalStorage<{ tx: Transaction; open: boolean }>();

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
      // See bb-data's index.mock.ts for the full rationale. Two concerns:
      //  1. keep the dev server alive — an unhandled rejection on this eager
      //     promise (notably a PGlite WASM init trap) would kill `npm run dev`;
      //  2. don't cache the failure forever — the DsqlMockEngine recovers, so on
      //     an init trap onTrap clears `migrationsRun` and ready() re-runs the
      //     idempotent migrations on the next query.
      let trapped = false;
      const startMigrations = () => {
        const retry = trapped;
        const run = loadMigrationsFromDir(path)
          .then(m => this.mockEngine.withDdl(() => runMigrations(this.mockEngine, m)))
          .then(() => {
            if (retry) {
              trapped = false;
              try {
                logRecovery(this.log, 'Migrations re-ran');
              } catch {}
            }
          });
        this.migrationsRun = trackEager(run, this.log, 'Migrations failed', () => {
          trapped = true;
          this.migrationsRun = null;
        });
        return run;
      };
      this.startMigrations = startMigrations;
      startMigrations();
    }
  }

  private async ready(): Promise<void> {
    if (!this.migrationsRun && this.startMigrations) this.startMigrations();
    if (this.migrationsRun) await this.migrationsRun;
  }

  query<T>(query: SqlQuery): Promise<T[]> {
    const tx = this.openTransaction();
    return tx ? tx.query<T>(query) : this.ready().then(() => this.base.query<T>(query));
  }
  queryOne<T>(query: SqlQuery): Promise<T | null> {
    const tx = this.openTransaction();
    return tx ? tx.queryOne<T>(query) : this.ready().then(() => this.base.queryOne<T>(query));
  }
  execute(query: SqlQuery): Promise<{ rowCount: number }> {
    const tx = this.openTransaction();
    return tx ? tx.execute(query) : this.ready().then(() => this.base.execute(query));
  }

  /**
   * Execute a function within a transaction with optional OCC retry.
   *
   * DSQL uses Optimistic Concurrency Control. Commit may fail with
   * SerializationFailureException if another transaction modified the same rows.
   * That conflict is an `ApiError` with status 409 (Conflict), flagged retriable,
   * so it serializes to JSON-RPC code 409 (not 500); `isBlocksError(e,
   * DistributedDatabaseErrors.SerializationFailure)` still matches by name.
   */
  async transaction<T>(fn: (tx: Transaction) => Promise<T>, options?: TransactionOptions): Promise<T> {
    if (this.openTransaction()) {
      throw brandBlocksError(Object.assign(
        new Error(`${DistributedDatabaseErrors.TransactionFailed}: The local database cannot open a transaction inside another transaction's callback. Run the work on the enclosing transaction.`),
        { name: DistributedDatabaseErrors.TransactionFailed },
      ));
    }
    await this.ready();
    return transactionWithRetry(this.base, async (tx) => {
      const scope = { tx, open: true };
      try { return await this.txScope.run(scope, () => fn(tx)); }
      finally { scope.open = false; }
    }, options);
  }

  /**
   * The transaction whose callback is running, if any. The local database has
   * one session, held by that transaction until it ends, so the block's own
   * statements inside the callback run in it rather than wait for it.
   */
  private openTransaction(): Transaction | undefined {
    const scope = this.txScope.getStore();
    return scope?.open ? scope.tx : undefined;
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
