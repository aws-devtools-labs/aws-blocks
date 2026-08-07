// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * PGlite engine wrapped with DSQL validation layer for local development.
 */

import { PGlite } from '@electric-sql/pglite';
import { existsSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { initializePgliteWithRetry, type DatabaseEngine, type TransactionHandle } from '@aws-blocks/data-common';
import { DistributedDatabaseErrors, PG_SERIALIZATION_FAILURE, translateDsqlError } from '../errors.js';
import { validateStatement, classifyStatement, TransactionTracker } from '../validation.js';

function cleanStaleLock(dataDir: string): void {
  const pidFile = join(dataDir, 'postmaster.pid');
  if (existsSync(pidFile)) { try { unlinkSync(pidFile); } catch {} }
}

interface MockTxHandle { active: boolean; tracker: TransactionTracker; }

/**
 * Preprocess a SQL statement for execution on the DSQL mock (PGlite).
 *
 * 1. Validates the statement against DSQL compatibility rules (throws on
 *    unsupported features like FK, TRUNCATE, SERIAL, etc.).
 * 2. Rejects DDL statements — in production the app Lambda only has
 *    dsql:DbConnect (DML-only). DDL must go in migration files.
 * 3. Normalizes DSQL-only syntax that PGlite doesn't understand — currently
 *    just `CREATE [UNIQUE] INDEX ASYNC` (stripped to a synchronous CREATE INDEX).
 *
 * Returns the normalized SQL ready for PGlite execution.
 */
function preprocessSqlForDsqlMock(sql: string, { allowDdl = false } = {}): string {
  validateStatement(sql);
  if (!allowDdl && classifyStatement(sql) === 'ddl') {
    const err = new Error(
      'DDL statements (CREATE, ALTER, DROP) are not allowed in the app runtime. ' +
      'Use migration files instead — the migration Lambda has dsql:DbConnectAdmin for DDL.',
    );
    err.name = 'DsqlPermissionError';
    throw err;
  }
  return sql.replace(/\b(CREATE\s+(?:UNIQUE\s+)?INDEX)\s+ASYNC\b/gi, '$1');
}

export class DsqlMockEngine implements DatabaseEngine {
  private db: PGlite;
  private closed = false;
  private shouldConflict = false;
  private _allowDdl = false;
  private readonly dataDir: string;
  private readonly createClient: (dataDir: string) => PGlite;
  private ready?: Promise<PGlite>;

  /**
   * @param dataDir - directory the PGlite mock persists to.
   * @param createClient - factory for the underlying PGlite instance; defaults
   *   to a real `PGlite`. Exposed as a seam so tests can inject an instance
   *   that simulates a WASM init trap.
   */
  constructor(dataDir: string, createClient: (dataDir: string) => PGlite = (dir) => new PGlite(dir)) {
    this.dataDir = dataDir;
    this.createClient = createClient;
    this.db = this.createDb();
  }

  private createDb(): PGlite {
    cleanStaleLock(this.dataDir);
    mkdirSync(this.dataDir, { recursive: true });
    return this.createClient(this.dataDir);
  }

  /**
   * Force PGlite's lazy WASM initialization, retrying past intermittent
   * `_pg_initdb` `unreachable` traps by recreating the instance. Runs once per
   * engine; a permanent failure is not cached, so a later query can retry once
   * transient memory pressure eases.
   */
  private ensureReady(): Promise<PGlite> {
    if (!this.ready) {
      this.ready = initializePgliteWithRetry(this.db, () => (this.db = this.createDb()), {
        onRetry: (attempt, error) =>
          console.warn(`[DsqlMockEngine] PGlite init trap on attempt ${attempt}; recreating instance`, error),
      })
        // Pin this.db to the settled instance explicitly (not just via the recreate closure).
        .then((db) => (this.db = db))
        .catch((error) => {
          this.ready = undefined;
          throw error;
        });
    }
    return this.ready;
  }

  /** Test helper: simulate OCC conflict on next commit. */
  simulateConflict(): void { this.shouldConflict = true; }

  /**
   * Temporarily allow DDL statements (used by the migration runner).
   * In normal app usage, DDL is rejected to match production behavior.
   */
  async withDdl<T>(fn: () => Promise<T>): Promise<T> {
    this._allowDdl = true;
    try { return await fn(); } finally { this._allowDdl = false; }
  }

  async query<T>(sql: string, params?: unknown[]): Promise<T[]> {
    const normalized = preprocessSqlForDsqlMock(sql, { allowDdl: this._allowDdl });
    try { await this.ensureReady(); return (await this.db.query<T>(normalized, params)).rows; }
    catch (e) { translateDsqlError(e as Error); }
  }

  async execute(sql: string, params?: unknown[]): Promise<{ rowCount: number }> {
    const normalized = preprocessSqlForDsqlMock(sql, { allowDdl: this._allowDdl });
    try { await this.ensureReady(); return { rowCount: (await this.db.query(normalized, params)).affectedRows ?? 0 }; }
    catch (e) { translateDsqlError(e as Error); }
  }

  async beginTransaction(): Promise<TransactionHandle> {
    try {
      await this.ensureReady();
      await this.db.query('BEGIN');
      return { active: true, tracker: new TransactionTracker() } as MockTxHandle;
    } catch (e) { translateDsqlError(e as Error); }
  }

  async commitTransaction(handle: TransactionHandle): Promise<void> {
    if (this.shouldConflict) {
      this.shouldConflict = false;
      await this.db.query('ROLLBACK');
      const err = Object.assign(
        new Error('SerializationFailureException: OCC conflict — transaction not committed.'),
        { code: PG_SERIALIZATION_FAILURE, name: DistributedDatabaseErrors.SerializationFailure }
      );
      throw err;
    }
    await this.db.query('COMMIT');
    (handle as MockTxHandle).tracker.reset();
  }

  async rollbackTransaction(handle: TransactionHandle): Promise<void> {
    await this.db.query('ROLLBACK');
    (handle as MockTxHandle).tracker.reset();
  }

  async queryInTransaction<T>(handle: TransactionHandle, sql: string, params?: unknown[]): Promise<T[]> {
    const normalized = preprocessSqlForDsqlMock(sql, { allowDdl: this._allowDdl });
    (handle as MockTxHandle).tracker.recordStatement(sql);
    try { return (await this.db.query<T>(normalized, params)).rows; }
    catch (e) { translateDsqlError(e as Error); }
  }

  async executeInTransaction(handle: TransactionHandle, sql: string, params?: unknown[]): Promise<{ rowCount: number }> {
    const normalized = preprocessSqlForDsqlMock(sql, { allowDdl: this._allowDdl });
    const h = handle as MockTxHandle;
    h.tracker.recordStatement(sql);
    try {
      const rowCount = (await this.db.query(normalized, params)).affectedRows ?? 0;
      h.tracker.recordRowCount(rowCount);
      return { rowCount };
    } catch (e) { translateDsqlError(e as Error); }
  }

  async destroy(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.db.close();
  }
}
