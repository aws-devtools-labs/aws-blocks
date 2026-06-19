// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import pg from 'pg';
import type { DatabaseEngine, TransactionHandle } from '@aws-blocks/data-common';
import { translatePgError } from './pg-error-translator.js';
import { DatabaseErrors } from '../errors.js';

/**
 * Configuration for connecting to a PostgreSQL-compatible database.
 */
export interface PgClientEngineConfig {
  /** PostgreSQL connection URI (e.g. postgresql://user:pass@host:5432/db). */
  connectionString: string;
  /** SSL configuration. Defaults to `{ rejectUnauthorized: true }`. */
  ssl?: { rejectUnauthorized?: boolean; ca?: string };
  /** Maximum number of clients in the pool. @default 5 */
  poolSize?: number;
  /** Milliseconds to wait for a connection before erroring. Unset = wait indefinitely. */
  connectionTimeoutMillis?: number;
}

/**
 * Guard against an unprovisioned secret reaching the pool. The connection string
 * is seeded into SSM by the in-stack copyFrom copy custom resource during
 * `npm run sandbox` / `npm run deploy`; if that step found no connection string
 * (e.g. it's missing from `.env.local` / `.env.production`), the AppSetting secret
 * Custom Resource leaves a random base64url placeholder in SSM. Connecting with it
 * surfaces as an opaque pg parse/auth error — fail loud and actionable instead.
 */
function assertPostgresUrl(connectionString: string): void {
  if (!/^postgres(ql)?:\/\//i.test((connectionString ?? '').trim())) {
    const err = new Error(
      'Database connection string is not a valid postgres:// URL — the connection ' +
      'secret was not provisioned to SSM (the deployed value is a placeholder). ' +
      'Ensure your connection string is set in .env.local (sandbox) or .env.production ' +
      '(deploy), then re-run `npm run sandbox` / `npm run deploy`. See MIGRATION_GUIDE.md.',
    );
    err.name = DatabaseErrors.ConnectionFailed;
    throw err;
  }
}

/**
 * DatabaseEngine implementation using the `pg` library.
 * Connects to any PostgreSQL-compatible database (Supabase, Neon, DSQL, etc.)
 * via a connection pool.
 */
export class PgClientEngine implements DatabaseEngine {
  private pool: pg.Pool;

  constructor(config: PgClientEngineConfig) {
    assertPostgresUrl(config.connectionString);
    this.pool = new pg.Pool({
      connectionString: config.connectionString,
      max: config.poolSize ?? 5,
      ssl: config.ssl ?? { rejectUnauthorized: true },
      ...(config.connectionTimeoutMillis !== undefined && {
        connectionTimeoutMillis: config.connectionTimeoutMillis,
      }),
    });
  }

  async query<T>(sql: string, params?: unknown[]): Promise<T[]> {
    try {
      const result = await this.pool.query(sql, params);
      return result.rows;
    } catch (e) {
      translatePgError(e, 'PgClientEngine');
    }
  }

  async execute(sql: string, params?: unknown[]): Promise<{ rowCount: number }> {
    try {
      const result = await this.pool.query(sql, params);
      return { rowCount: result.rowCount ?? 0 };
    } catch (e) {
      translatePgError(e, 'PgClientEngine');
    }
  }

  async beginTransaction(): Promise<TransactionHandle> {
    try {
      const client = await this.pool.connect();
      await client.query('BEGIN');
      return client;
    } catch (e) {
      translatePgError(e, 'PgClientEngine');
    }
  }

  async commitTransaction(handle: TransactionHandle): Promise<void> {
    const client = handle as pg.PoolClient;
    try {
      await client.query('COMMIT');
    } finally {
      client.release();
    }
  }

  async rollbackTransaction(handle: TransactionHandle): Promise<void> {
    const client = handle as pg.PoolClient;
    try {
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
  }

  async queryInTransaction<T>(handle: TransactionHandle, sql: string, params?: unknown[]): Promise<T[]> {
    try {
      const client = handle as pg.PoolClient;
      const result = await client.query(sql, params);
      return result.rows;
    } catch (e) {
      translatePgError(e, 'PgClientEngine');
    }
  }

  async executeInTransaction(handle: TransactionHandle, sql: string, params?: unknown[]): Promise<{ rowCount: number }> {
    try {
      const client = handle as pg.PoolClient;
      const result = await client.query(sql, params);
      return { rowCount: result.rowCount ?? 0 };
    } catch (e) {
      translatePgError(e, 'PgClientEngine');
    }
  }

  async destroy(): Promise<void> {
    await this.pool.end();
  }
}
