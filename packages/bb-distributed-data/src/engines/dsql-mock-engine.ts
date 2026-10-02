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
   * @internal Mock stand-in for Aurora DSQL CDC: record the primary key of
   * every row written to `table` (row trigger into `_blocks_sync_cdc`).
   * Runs on PGlite directly, past the DSQL validation layer, because real DSQL
   * has no triggers; app SQL still cannot create them.
   */
  async captureChanges(table: string, primaryKey: string): Promise<void> {
    await this.ensureReady();
    // Like a CDC record: the operation, and the row (`after`) for inserts and
    // updates, only the key (`before`) for deletes.
    await this.db.exec(
      `CREATE TABLE IF NOT EXISTS _blocks_sync_cdc (seq bigserial PRIMARY KEY, tbl text NOT NULL, op text NOT NULL, img jsonb NOT NULL);
       CREATE OR REPLACE FUNCTION _blocks_sync_capture() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN
         IF TG_OP = 'DELETE' THEN
           INSERT INTO _blocks_sync_cdc (tbl, op, img) VALUES (TG_ARGV[0], 'd', jsonb_build_object(TG_ARGV[1], to_jsonb(OLD) -> TG_ARGV[1]));
         ELSE
           INSERT INTO _blocks_sync_cdc (tbl, op, img) VALUES (TG_ARGV[0], CASE WHEN TG_OP = 'INSERT' THEN 'c' ELSE 'u' END, to_jsonb(NEW));
         END IF;
         RETURN NULL;
       END $$;`,
    );
    const quoted = table.split('.').map((part) => `"${part}"`).join('.');
    const trigger = `"_blocks_sync_${table.replace('.', '_')}"`;
    // Names are validated identifiers (sync.tables, information_schema).
    await this.db.exec(
      `CREATE OR REPLACE TRIGGER ${trigger} AFTER INSERT OR UPDATE OR DELETE ON ${quoted}
         FOR EACH ROW EXECUTE FUNCTION _blocks_sync_capture('${table}', '${primaryKey}')`,
    );
  }

  /** @internal Take (and clear) the changes recorded by {@link captureChanges}, by table, in order. */
  async takeChanges(): Promise<Map<string, { op: 'c' | 'u' | 'd'; row: Record<string, unknown> }[]>> {
    await this.ensureReady();
    const { rows } = await this.db.query<{ tbl: string; op: 'c' | 'u' | 'd'; img: Record<string, unknown> }>(
      'DELETE FROM _blocks_sync_cdc RETURNING seq, tbl, op, img',
    );
    rows.sort((a, b) => Number((a as { seq?: number }).seq) - Number((b as { seq?: number }).seq));
    const changes = new Map<string, { op: 'c' | 'u' | 'd'; row: Record<string, unknown> }[]>();
    for (const { tbl, op, img } of rows) {
      const list = changes.get(tbl) ?? [];
      list.push({ op, row: img });
      changes.set(tbl, list);
    }
    return changes;
  }

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
