// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * DistributedDatabase — AWS Lambda runtime entry point.
 * pg driver + IAM token authentication.
 */

import { Scope, registerSdkIdentifiers } from '@aws-blocks/core';
import type { ScopeParent } from '@aws-blocks/core';
import { DatabaseBase, type SqlQuery, type Transaction } from '@aws-blocks/data-common';
import { DsqlSigner } from '@aws-sdk/dsql-signer';
import { DsqlEngine } from './engines/dsql-engine.js';
import { transactionWithRetry } from './transaction.js';
import { Counter } from './counter.js';
import type { DistributedDatabaseOptions, TransactionOptions } from './types.js';
import { ENV_SANITIZE, sanitizeDbRoleName } from './constants.js';
import { Logger } from '@aws-blocks/bb-logger';
import type { ChildLogger } from '@aws-blocks/bb-logger';

export class DistributedDatabase extends Scope {
  private _base: DatabaseBase | null = null;

  /** @internal Logger for internal operations. Defaults to error-level when not provided. */
  protected log: ChildLogger;

  constructor(scope: ScopeParent, id: string, _options?: DistributedDatabaseOptions) {
    super(id, { parent: scope });
    this.log = _options?.logger ?? new Logger(this, 'logger', { level: 'error' });
    const envName = this.fullId.replace(ENV_SANITIZE, '_');
    const clusterEndpoint = process.env[`BLOCKS_${envName}_ENDPOINT`] ?? '';
    registerSdkIdentifiers(this.fullId, { clusterEndpoint });
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

  query<T>(query: SqlQuery): Promise<T[]> { return this.base.query<T>(query); }
  queryOne<T>(query: SqlQuery): Promise<T | null> { return this.base.queryOne<T>(query); }
  execute(query: SqlQuery): Promise<{ rowCount: number }> { return this.base.execute(query); }

  /**
   * Execute a function within a transaction with optional OCC retry.
   *
   * DSQL uses Optimistic Concurrency Control. Commit may fail with
   * SerializationFailureException if another transaction modified the same rows.
   */
  async transaction<T>(fn: (tx: Transaction) => Promise<T>, options?: TransactionOptions): Promise<T> {
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
    return new Counter(async () => this.base, name);
  }

  /** @internal */
  getEngine() { return this.base.getEngine(); }
}

export { sql, createKyselyAdapter } from '@aws-blocks/data-common';
export type { SqlQuery, Transaction } from '@aws-blocks/data-common';
export { DistributedDatabaseErrors } from './errors.js';
export { Counter } from './counter.js';
export type { DistributedDatabaseOptions, TransactionOptions } from './types.js';
