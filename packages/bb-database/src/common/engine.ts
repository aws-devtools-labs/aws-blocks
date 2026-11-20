// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Opaque handle representing an active transaction. Engine-specific.
 */
export type TransactionHandle = unknown;

/**
 * Core abstraction for database engine implementations.
 *
 * Each runtime (PGlite for local dev, a `pg` connection on AWS)
 * implements this interface. The `Database` class delegates all operations through it.
 *
 * Internal for now — designed to be exposable for provider extensibility.
 */
export interface DatabaseEngine {
  /** Execute a query and return rows. */
  query<T>(sql: string, params?: unknown[]): Promise<T[]>;

  /** Execute a mutation and return affected row count. */
  execute(sql: string, params?: unknown[]): Promise<{ rowCount: number }>;

  /** Begin a transaction, returning an engine-specific handle. */
  beginTransaction(): Promise<TransactionHandle>;

  /** Commit a transaction. */
  commitTransaction(handle: TransactionHandle): Promise<void>;

  /** Roll back a transaction. */
  rollbackTransaction(handle: TransactionHandle): Promise<void>;

  /** Execute a query within a transaction. */
  queryInTransaction<T>(handle: TransactionHandle, sql: string, params?: unknown[]): Promise<T[]>;

  /** Execute a mutation within a transaction. */
  executeInTransaction(handle: TransactionHandle, sql: string, params?: unknown[]): Promise<{ rowCount: number }>;

  /** Clean up resources (close connections, etc.). */
  destroy(): Promise<void>;

  /**
   * Set by an engine that takes one statement in a call (the RDS Data API). A caller that would send several
   * statements in one text sends them one by one.
   */
  readonly oneStatementPerCall?: boolean;
}
