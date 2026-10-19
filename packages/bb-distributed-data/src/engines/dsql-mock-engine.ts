// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * PGlite engine wrapped with DSQL validation layer for local development.
 */

import { PGlite } from '@electric-sql/pglite';
import { existsSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { initializePgliteWithRetry, type DatabaseEngine, type TransactionHandle } from '@aws-blocks/data-common';
import { DistributedDatabaseErrors, DSQL_PERMISSION_ERROR_NAME, DDL_NOT_ALLOWED_MESSAGE, PG_SERIALIZATION_FAILURE, translateDsqlError } from '../errors.js';
import { brandBlocksError } from '@aws-blocks/core';
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
 *    unsupported features like TRUNCATE, SERIAL, etc.).
 * 2. Rejects DDL statements — in production the app Lambda only has
 *    dsql:DbConnect (DML-only). DDL must go in migration files.
 * 3. Normalizes DSQL's asynchronous DDL for PGlite: `CREATE [UNIQUE] INDEX ASYNC`
 *    and `ALTER TABLE ASYNC` run as their synchronous PostgreSQL forms.
 *
 * Returns the normalized SQL ready for PGlite execution.
 */
function preprocessSqlForDsqlMock(sql: string, { allowDdl = false } = {}): string {
  validateStatement(sql);
  if (!allowDdl && classifyStatement(sql) === 'ddl') {
    const err = new Error(DDL_NOT_ALLOWED_MESSAGE);
    err.name = DSQL_PERMISSION_ERROR_NAME;
    // Branded so the name crosses the RPC wire on the mock path. The name is
    // internal (not on the public DistributedDatabaseErrors) because only this
    // mock guard produces it. The message is BB-authored (no raw driver text),
    // so forwarding it is safe (D-003).
    throw brandBlocksError(err);
  }
  return stripAsyncDdlKeyword(sql);
}

/** PostgreSQL lexer whitespace (space, tab, newline, carriage return, form feed, vertical tab). */
const SQL_WHITESPACE = /[ \t\n\r\f\v]/;
/** PostgreSQL identifier characters: ASCII letters, digits, `_`, `$`, and any non-ASCII character. */
const SQL_IDENTIFIER_CHAR = /[A-Za-z0-9_$\u0080-\uFFFF]/;

/** Index of the first character at or after `start` that is not whitespace or a comment. */
function skipWhitespaceAndComments(sql: string, start: number): number {
  let i = start;
  for (;;) {
    while (i < sql.length && SQL_WHITESPACE.test(sql[i])) i++;
    if (sql.startsWith('--', i)) {
      // A line comment ends at the next newline or carriage return.
      while (i < sql.length && sql[i] !== '\n' && sql[i] !== '\r') i++;
    } else if (sql.startsWith('/*', i)) {
      // PostgreSQL block comments nest.
      let depth = 1;
      i += 2;
      while (i < sql.length && depth > 0) {
        if (sql.startsWith('/*', i)) { depth++; i += 2; }
        else if (sql.startsWith('*/', i)) { depth--; i += 2; }
        else i++;
      }
    } else {
      return i;
    }
  }
}

/**
 * Drop the `ASYNC` keyword from a statement that starts with
 * `CREATE [UNIQUE] INDEX ASYNC` or `ALTER TABLE ASYNC`, so PGlite runs it
 * synchronously. Only the statement's leading keywords are read, so string
 * literals and later clauses keep their text. Keywords match case-insensitively
 * on ASCII letters only, as in PostgreSQL.
 */
function stripAsyncDdlKeyword(sql: string): string {
  const words: string[] = [];
  let i = skipWhitespaceAndComments(sql, 0);
  while (words.length < 4) {
    let end = i;
    while (end < sql.length && SQL_IDENTIFIER_CHAR.test(sql[end])) end++;
    const word = sql.slice(i, end).replace(/[a-z]/g, c => c.toUpperCase());
    if (!word) return sql;
    words.push(word);
    if (word === 'ASYNC') {
      const lead = words.slice(0, -1).join(' ');
      const isAsyncDdl = lead === 'CREATE INDEX' || lead === 'CREATE UNIQUE INDEX' || lead === 'ALTER TABLE';
      return isAsyncDdl ? sql.slice(0, i) + sql.slice(end) : sql;
    }
    i = skipWhitespaceAndComments(sql, end);
  }
  return sql;
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
          // Init retry is exhausted; initializePgliteWithRetry has already closed
          // the last trapped instance, so this.db now points at a dead handle.
          // Reset readiness AND swap in a fresh, un-probed instance. Without the
          // swap, the next call would re-probe the CLOSED handle, whose error is a
          // "closed" error (not an `unreachable` trap) and is therefore classified
          // non-retryable — permanently wedging the engine and defeating the
          // "a later query can retry" recovery documented above. Recreating here
          // is best effort; if it throws we keep propagating the original init error.
          this.ready = undefined;
          try {
            this.db = this.createDb();
          } catch {
            // Leave the dead handle in place; the original init error is more useful.
          }
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
      // Route through translateDsqlError so the mock surfaces the SAME 409
      // ApiError (name preserved, retriable) the real DSQL engine produces for
      // SQLSTATE 40001 — keeping mock and aws paths behaviorally identical.
      translateDsqlError(err);
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
