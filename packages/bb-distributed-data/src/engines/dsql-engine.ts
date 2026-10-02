// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Production DSQL engine — pg.Pool with IAM token authentication.
 */

import pg from 'pg';
import type { DatabaseEngine, TransactionHandle } from '@aws-blocks/data-common';
import { translateDsqlError } from '../errors.js';
import { DEFAULT_POOL_SIZE } from '../constants.js';

export interface DsqlEngineConfig {
  endpoint: string;
  region: string;
  getAuthToken: () => Promise<string>;
  poolSize?: number;
  /** PostgreSQL role name to connect as (mapped from IAM via `AWS IAM GRANT`). */
  role: string;
  /**
   * Postgres `application_name` connection parameter. Shows in `pg_stat_activity`
   * on the server. Used by the AWS runtime layer to propagate the BB user-agent
   * chain (e.g. `"aws-blocks/0.2.6 bb/DistributedDatabase/0.1.0"`).
   */
  applicationName?: string;
}

export class DsqlEngine implements DatabaseEngine {
  private pool: pg.Pool;

  constructor(config: DsqlEngineConfig) {
    // DSQL clusters have a fixed connection contract: port 5432,
    // database 'postgres', TLS required.
    this.pool = new pg.Pool({
      host: config.endpoint,
      port: 5432,
      user: config.role,
      database: 'postgres',
      ssl: true,
      max: config.poolSize ?? DEFAULT_POOL_SIZE,
      password: config.getAuthToken,
      ...(config.applicationName ? { application_name: config.applicationName } : {}),
    });
  }

  async query<T>(sql: string, params?: unknown[]): Promise<T[]> {
    try { return (await this.pool.query(sql, params)).rows; }
    catch (e) {
      const err = e as pg.DatabaseError;
      console.error('[DsqlEngine] query failed', { code: err.code, severity: err.severity });
      translateDsqlError(err);
    }
  }

  async execute(sql: string, params?: unknown[]): Promise<{ rowCount: number }> {
    try { return { rowCount: (await this.pool.query(sql, params)).rowCount ?? 0 }; }
    catch (e) {
      const err = e as pg.DatabaseError;
      console.error('[DsqlEngine] execute failed', { code: err.code, severity: err.severity });
      translateDsqlError(err);
    }
  }

  async beginTransaction(): Promise<TransactionHandle> {
    try {
      const client = await this.pool.connect();
      await client.query('BEGIN');
      return client;
    } catch (e) {
      const err = e as pg.DatabaseError;
      console.error('[DsqlEngine] beginTransaction failed', { code: err.code, severity: err.severity });
      translateDsqlError(err);
    }
  }

  async commitTransaction(handle: TransactionHandle): Promise<void> {
    const client = handle as pg.PoolClient;
    try { await client.query('COMMIT'); }
    catch (e) {
      client.release();
      const err = e as pg.DatabaseError;
      console.error('[DsqlEngine] commitTransaction failed', { code: err.code, severity: err.severity });
      translateDsqlError(err);
    }
    client.release();
  }

  async rollbackTransaction(handle: TransactionHandle): Promise<void> {
    const client = handle as pg.PoolClient;
    try { await client.query('ROLLBACK'); }
    catch (e) {
      const err = e as pg.DatabaseError;
      console.error('[DsqlEngine] rollbackTransaction failed', { code: err.code, severity: err.severity });
    }
    finally { client.release(); }
  }

  async queryInTransaction<T>(handle: TransactionHandle, sql: string, params?: unknown[]): Promise<T[]> {
    try { return (await (handle as pg.PoolClient).query(sql, params)).rows; }
    catch (e) {
      const err = e as pg.DatabaseError;
      console.error('[DsqlEngine] queryInTransaction failed', { code: err.code, severity: err.severity });
      translateDsqlError(err);
    }
  }

  async executeInTransaction(handle: TransactionHandle, sql: string, params?: unknown[]): Promise<{ rowCount: number }> {
    try { return { rowCount: (await (handle as pg.PoolClient).query(sql, params)).rowCount ?? 0 }; }
    catch (e) {
      const err = e as pg.DatabaseError;
      console.error('[DsqlEngine] executeInTransaction failed', { code: err.code, severity: err.severity });
      translateDsqlError(err);
    }
  }

  async destroy(): Promise<void> { await this.pool.end(); }
}
