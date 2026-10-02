// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * DistributedDatabase — Local development entry point.
 * PGlite + DSQL validation layer.
 */

import { ApiError, Scope, registerSdkIdentifiers } from '@aws-blocks/core';
import type { ScopeParent } from '@aws-blocks/core';
import { DatabaseBase, classifyWrite, unwrapQuery, type SqlQuery, type Transaction } from '@aws-blocks/data-common';
import { ServerShape } from '@aws-blocks/data-common/sync-shared';
import { deriveTokenKey, validateSyncOptions } from '@aws-blocks/data-common/sync';
import type { Shape, ShapeOptions } from '@aws-blocks/data-common/sync';
import { SyncRuntime } from './sync/runtime.js';
import { DsqlMockEngine } from './engines/dsql-mock-engine.js';
import { runMigrations, loadMigrationsFromDir } from './migrations.js';
import { transactionWithRetry } from './transaction.js';
import type { DistributedDatabaseOptions, TransactionOptions } from './types.js';
import { DistributedDatabaseErrors } from './errors.js';
import { Logger } from '@aws-blocks/bb-logger';
import type { ChildLogger } from '@aws-blocks/bb-logger';
import { BB_NAME, BB_VERSION } from './version.js';

/**
 * Shape tokens in local dev are signed with a fixed key. They only grant
 * access to the local dev server's own PGlite data.
 */
const LOCAL_SHAPE_TOKEN_KEY = deriveTokenKey('aws-blocks-local-sync');

/** Statements that can change rows: these ring the bell of a synced table. */
const WRITE_STATEMENT = /^\s*(WITH\b[\s\S]*\b)?(INSERT|UPDATE|DELETE|MERGE)\b/i;

export class DistributedDatabase extends Scope {
  private base: DatabaseBase;
  private mockEngine: DsqlMockEngine;
  private migrationsRun: Promise<void> | null = null;
  private readonly sync: SyncRuntime | null = null;
  private capture: Promise<void> | null = null;

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

    if (options?.sync) {
      validateSyncOptions(this.fullId, options.sync, 'DistributedDatabase');
      this.sync = new SyncRuntime({
        db: this,
        sync: options.sync,
        getEngine: async () => {
          await this.ready();
          return this.mockEngine;
        },
        getTokenKey: async () => LOCAL_SHAPE_TOKEN_KEY,
        log: this.log,
      });
      this.registerClientMiddleware('@aws-blocks/bb-distributed-data/sync-client');
      // Stand-in for CDC: record changed keys once the tables exist.
      const sync = this.sync;
      const tables = options.sync.tables;
      this.capture = this.ready().then(async () => {
        for (const table of tables) {
          const primaryKey = await sync.primaryKey(table).catch(() => null);
          if (primaryKey) await this.mockEngine.captureChanges(table, primaryKey);
        }
      });
      this.capture.catch((e: unknown) => this.log.warn('Sync change capture failed', { error: String(e) }));
    }
  }

  /**
   * Locally, app writes ring the bell directly (there is no CDC stream). Row
   * triggers record the changed keys, so the bell carries them as it does on
   * AWS, where Aurora DSQL CDC rings it for writes from any client.
   */
  private async afterWrite<R>(result: R): Promise<R> {
    const sync = this.sync;
    if (!sync) return result;
    try {
      await this.capture;
      const changes = await this.mockEngine.takeChanges();
      await Promise.all([...changes].map(([table, images]) => sync.ring(table, { tsMs: Date.now(), images })));
    } catch (e: unknown) {
      this.log.warn('Sync bell failed', { error: String(e) });
    }
    return result;
  }

  private async ready(): Promise<void> { if (this.migrationsRun) await this.migrationsRun; }

  async query<T>(query: SqlQuery): Promise<T[]> {
    await this.ready();
    const rows = await this.base.query<T>(query);
    if (this.sync && WRITE_STATEMENT.test(unwrapQuery(query).sql)) {
      await this.sync.untrackedWrite(unwrapQuery(query).sql);
      await this.afterWrite(undefined);
    }
    return rows;
  }
  async queryOne<T>(query: SqlQuery): Promise<T | null> {
    await this.ready();
    const row = await this.base.queryOne<T>(query);
    if (this.sync && WRITE_STATEMENT.test(unwrapQuery(query).sql)) {
      await this.sync.untrackedWrite(unwrapQuery(query).sql);
      await this.afterWrite(undefined);
    }
    return row;
  }
  async execute(query: SqlQuery): Promise<{ rowCount: number }> {
    await this.ready();
    // With sync, a write runs in a tracked transaction, so its keys reach open shapes (read-your-writes).
    const sync = this.sync;
    if (sync && classifyWrite(unwrapQuery(query).sql, sync.tables)) {
      return this.afterWrite(await transactionWithRetry(this.base, (tx) => tx.execute(query), undefined, sync.tracking));
    }
    return this.afterWrite(await this.base.execute(query));
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
    await this.ready();
    return this.afterWrite(await transactionWithRetry(this.base, fn, options, this.sync?.tracking));
  }

  /**
   * Issue a live shape: the rows of `table` that match `where`, synced to the
   * browser. Return it from an `ApiNamespace` method; the client receives a
   * {@link Shape} that keeps a local copy of the rows and applies changes as
   * they happen. Requires `sync` in the DistributedDatabase options.
   *
   * Authorize before you call this: the shape grants read access to exactly the
   * rows it describes, for as long as its token lives. The client cannot
   * change the table, filter, or columns. When the shape expires, the client
   * calls the same API method again, which re-runs your check.
   *
   * @param options - The table, row filter, columns, key, and token lifetime
   * @returns A shape handle that serializes to the client
   * @throws {DistributedDatabaseErrors.ShapeInvalid} If sync is not enabled, the
   *   table is not in `sync.tables`, a name is invalid, or a filter parameter
   *   has an unsupported type
   *
   * @example
   * export const api = new ApiNamespace(scope, 'api', (context) => ({
   *   async myTodos() {
   *     const user = await auth.requireAuth(context);
   *     return db.shape<Todo>({ table: 'todos', where: sql`owner_id = ${user.userId}` });
   *   },
   * }));
   */
  async shape<T>(options: ShapeOptions<T>): Promise<Shape<T>> {
    if (!this.sync) {
      throw new ApiError(
        `DistributedDatabase "${this.fullId}" does not have sync enabled. Add \`sync: { tables: [...] }\` to its options.`,
        400,
        { name: DistributedDatabaseErrors.ShapeInvalid },
      );
    }
    return new ServerShape<T>(await this.sync.issue(options));
  }

  /** Test helper: simulate OCC conflict on next commit. */
  simulateConflict(): void { this.mockEngine.simulateConflict(); }

  /** @internal */
  getEngine() { return this.base.getEngine(); }
}

export { sql, createKyselyAdapter } from '@aws-blocks/data-common';
export type { SqlQuery, Transaction } from '@aws-blocks/data-common';
export { DistributedDatabaseErrors } from './errors.js';
export type { DistributedDatabaseOptions, DistributedSyncOptions, TransactionOptions } from './types.js';
export type { Shape, ShapeDescriptor, ShapeOptions } from '@aws-blocks/data-common/sync';
