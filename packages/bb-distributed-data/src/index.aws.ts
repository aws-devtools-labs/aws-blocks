// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * DistributedDatabase — AWS Lambda runtime entry point.
 * pg driver + IAM token authentication.
 */

import { ApiError, Scope, registerSdkIdentifiers } from '@aws-blocks/core';
import type { ScopeParent } from '@aws-blocks/core';
import { DatabaseBase, classifyWrite, unwrapQuery, type SqlQuery, type Transaction } from '@aws-blocks/data-common';
import { DsqlSigner } from '@aws-sdk/dsql-signer';
import { ServerShape } from '@aws-blocks/data-common/sync-shared';
import { deriveTokenKey, validateSyncOptions } from '@aws-blocks/data-common/sync';
import type { Shape, ShapeOptions } from '@aws-blocks/data-common/sync';
import { AppSetting } from '@aws-blocks/bb-app-setting';
import { DsqlEngine } from './engines/dsql-engine.js';
import { SyncRuntime } from './sync/runtime.js';
import { BellBatcher, BellFolder } from './sync/cdc.js';
import { DistributedDatabaseErrors } from './errors.js';
import { transactionWithRetry } from './transaction.js';
import type { DistributedDatabaseOptions, TransactionOptions } from './types.js';
import { ENV_SANITIZE, SYNC_TOKEN_SECRET_ID, cdcStreamName, sanitizeDbRoleName } from './constants.js';
import { Logger } from '@aws-blocks/bb-logger';
import type { ChildLogger } from '@aws-blocks/bb-logger';
import { BB_NAME, BB_VERSION } from './version.js';

/** Kinesis event source id in Lambda records (`aws:kinesis`). */
const KINESIS_EVENT_SOURCE = 'aws:kinesis';

export class DistributedDatabase extends Scope {
  private _base: DatabaseBase | null = null;
  private readonly sync: SyncRuntime | null = null;
  private tokenKey: Promise<string> | null = null;

  /** @internal Logger for internal operations. Defaults to error-level when not provided. */
  protected log: ChildLogger;

  constructor(scope: ScopeParent, id: string, _options?: DistributedDatabaseOptions) {
    super(id, { parent: scope, bbName: BB_NAME, bbVersion: BB_VERSION });
    this.log = _options?.logger ?? new Logger(this, 'logger', { level: 'error' });
    const envName = this.fullId.replace(ENV_SANITIZE, '_');
    const clusterEndpoint = process.env[`BLOCKS_${envName}_ENDPOINT`] ?? '';
    registerSdkIdentifiers(this.fullId, { clusterEndpoint });

    if (_options?.sync) {
      const sync = _options.sync;
      validateSyncOptions(this.fullId, sync, 'DistributedDatabase');
      const secret = new AppSetting(this, SYNC_TOKEN_SECRET_ID, { secret: true });
      this.sync = new SyncRuntime({
        db: this,
        sync,
        getEngine: async () => this.base.getEngine(),
        getTokenKey: () => {
          if (!this.tokenKey) {
            this.tokenKey = secret.get().then(deriveTokenKey);
            this.tokenKey.catch(() => {
              this.tokenKey = null;
            });
          }
          return this.tokenKey;
        },
        log: this.log,
      });
      this.registerClientMiddleware('@aws-blocks/bb-distributed-data/sync-client');

      // Aurora DSQL CDC → Kinesis → this Lambda. Each record rings the bell of
      // its table; one invocation's records fold into one bell per table.
      const runtime = this.sync;
      const batcher = new BellBatcher(new BellFolder(sync.tables), (table, bell) => runtime.ring(table, bell));
      this.registerLambdaEventHandler(
        KINESIS_EVENT_SOURCE,
        `stream/${cdcStreamName(this.fullId)}`,
        (record: { kinesis?: { data?: string } }) => batcher.handle(record.kinesis?.data ?? ''),
      );
    }
  }

  private get base(): DatabaseBase {
    if (!this._base) {
      const envName = this.fullId.replace(ENV_SANITIZE, '_');
      const endpoint = process.env[`BLOCKS_${envName}_ENDPOINT`];
      const region = process.env[`BLOCKS_${envName}_REGION`];
      if (!endpoint || !region) {
        throw new Error(`Missing env: BLOCKS_${envName}_ENDPOINT / BLOCKS_${envName}_REGION`);
      }
      const dbRole = sanitizeDbRoleName(this.fullId);
      const signer = new DsqlSigner({ hostname: endpoint, region });
      this._base = new DatabaseBase(new DsqlEngine({
        endpoint, region,
        role: dbRole,
        getAuthToken: () => signer.getDbConnectAuthToken(),
      }));
    }
    return this._base;
  }

  async query<T>(query: SqlQuery): Promise<T[]> {
    const rows = await this.base.query<T>(query);
    await this.sync?.untrackedWrite(unwrapQuery(query).sql);
    return rows;
  }
  async queryOne<T>(query: SqlQuery): Promise<T | null> {
    const row = await this.base.queryOne<T>(query);
    await this.sync?.untrackedWrite(unwrapQuery(query).sql);
    return row;
  }
  execute(query: SqlQuery): Promise<{ rowCount: number }> {
    // With sync, a write runs in a tracked transaction, so its keys reach open shapes (read-your-writes).
    const sync = this.sync;
    if (sync && classifyWrite(unwrapQuery(query).sql, sync.tables)) {
      return transactionWithRetry(this.base, (tx) => tx.execute(query), undefined, sync.tracking);
    }
    return this.base.execute(query);
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
    return transactionWithRetry(this.base, fn, options, this.sync?.tracking);
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

  /** @internal */
  getEngine() { return this.base.getEngine(); }
}

export { sql, createKyselyAdapter } from '@aws-blocks/data-common';
export type { SqlQuery, Transaction } from '@aws-blocks/data-common';
export { DistributedDatabaseErrors } from './errors.js';
export type { DistributedDatabaseOptions, DistributedSyncOptions, TransactionOptions } from './types.js';
export type { Shape, ShapeDescriptor, ShapeOptions } from '@aws-blocks/data-common/sync';
