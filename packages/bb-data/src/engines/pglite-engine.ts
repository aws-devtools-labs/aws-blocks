// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseEngine, TransactionHandle } from '@aws-blocks/data-common';
import { DatabaseErrors, wrapError } from '../errors.js';

/** PostgreSQL error code for unique constraint violations. */
const PG_UNIQUE_VIOLATION = '23505';

/** PostgreSQL error code class for connection exceptions. */
const PG_CONNECTION_EXCEPTION_CLASS = '08';
const PGLITE_INITIALIZED_DATA_DIR_ENTRIES = ['PG_VERSION', 'base', 'global', 'global/pg_control'];
const PGLITE_DATA_DIR_MARKERS = [
  'PG_VERSION',
  'base',
  'global',
  'pg_wal',
  'pg_xact',
  'postgresql.conf',
  'postgresql.auto.conf',
  'postmaster.pid',
];

/**
 * Translate a PGlite/PostgreSQL error to a standardized DatabaseErrors name.
 *
 * @example
 * // PostgreSQL error code 23505 → UniqueConstraintViolation
 * // PostgreSQL error code 08xxx → ConnectionFailed
 * // All other errors → QueryFailed
 */
function translateError(e: unknown): never {
  if (e instanceof Error) {
    const code = (e as any).code as string | undefined;
    if (code === PG_UNIQUE_VIOLATION) {
      e.name = DatabaseErrors.UniqueConstraintViolation;
    } else if (code && code.startsWith(PG_CONNECTION_EXCEPTION_CLASS)) {
      e.name = DatabaseErrors.ConnectionFailed;
    } else {
      e.name = DatabaseErrors.QueryFailed;
    }
    console.debug(`[PGliteEngine] ${e.name}`, { code });
    throw e;
  }
  wrapError(e);
}

/**
 * Remove stale postmaster.pid left by a previous unclean shutdown.
 * PGlite runs PostgreSQL in-process via WASM — there is no external
 * postmaster process — so a leftover pid file is always stale and
 * causes PGlite to crash with `Aborted()`.
 */
function cleanStaleLock(dataDir: string): void {
  const pidFile = join(dataDir, 'postmaster.pid');
  if (existsSync(pidFile)) {
    try {
      unlinkSync(pidFile);
      console.log(`[PGliteEngine] Removed stale postmaster.pid from ${dataDir}`);
    } catch {}
  }
}

function hasInitializedPgliteDataDir(dataDir: string): boolean {
  // PGlite loadTar writes PG_VERSION before the directory tree. Requiring
  // global/pg_control ensures base/global exist and contain PostgreSQL state.
  return PGLITE_INITIALIZED_DATA_DIR_ENTRIES.every((entry) => existsSync(join(dataDir, entry)));
}

function hasInitializedPgliteChildDataDir(dataDir: string, entries: string[]): boolean {
  return entries.some((entry) => hasInitializedPgliteDataDir(join(dataDir, entry)));
}

function looksLikePgliteDataDir(entries: string[]): boolean {
  return entries.some((entry) => PGLITE_DATA_DIR_MARKERS.includes(entry));
}

function isErrnoException(error: unknown): error is { code?: string } {
  return typeof error === 'object' && error !== null && 'code' in error;
}

function nextCorruptDataDir(dataDir: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `${dataDir}.corrupt-${timestamp}-${process.pid}-${randomUUID().slice(0, 8)}`;
}

function recoverIncompletePgliteDataDir(dataDir: string): void {
  let entries: string[];
  try {
    entries = readdirSync(dataDir);
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ENOENT') return;
    throw error;
  }
  if (entries.length === 0 || hasInitializedPgliteDataDir(dataDir)) return;

  if (!looksLikePgliteDataDir(entries) || hasInitializedPgliteChildDataDir(dataDir, entries)) return;

  const corruptDataDir = nextCorruptDataDir(dataDir);
  renameSync(dataDir, corruptDataDir);
  mkdirSync(dataDir, { recursive: true });
  console.log(
    `[PGliteEngine] Moved incomplete PGlite data directory from ${dataDir} to ${corruptDataDir}; created a fresh directory. Delete matching .corrupt-* directories when they are no longer needed.`
  );
}

/**
 * DatabaseEngine implementation using PGlite (WASM PostgreSQL).
 * Used for local development. Data persists in the specified directory.
 *
 * Limitation: PGlite runs in a single connection. Concurrent calls to
 * `beginTransaction()` will interleave on the same connection. This is
 * acceptable for single-threaded local dev servers but must not be used
 * in multi-request concurrent environments.
 */
export class PGliteEngine implements DatabaseEngine {
  private db: PGlite;
  private closed = false;

  constructor(dataDir: string = '.bb-data') {
    // PGlite's initdb only creates the leaf directory, not intermediate
    // parents. Because index.mock.ts uses nested paths (e.g. `.bb-data/main`),
    // a fresh checkout or `rm -rf .bb-data` would otherwise ENOENT on first
    // boot. Create the full path up front (matches DsqlMockEngine).
    mkdirSync(dataDir, { recursive: true });
    recoverIncompletePgliteDataDir(dataDir);
    cleanStaleLock(dataDir);
    this.db = new PGlite(dataDir);
  }

  async query<T>(sql: string, params?: unknown[]): Promise<T[]> {
    try {
      const result = await this.db.query<T>(sql, params);
      return result.rows;
    } catch (e) {
      translateError(e);
    }
  }

  async execute(sql: string, params?: unknown[]): Promise<{ rowCount: number }> {
    try {
      const result = await this.db.query(sql, params);
      return { rowCount: result.affectedRows ?? 0 };
    } catch (e) {
      translateError(e);
    }
  }

  async beginTransaction(): Promise<TransactionHandle> {
    try {
      await this.db.query('BEGIN');
      return { active: true };
    } catch (e) {
      translateError(e);
    }
  }

  async commitTransaction(_handle: TransactionHandle): Promise<void> {
    try {
      await this.db.query('COMMIT');
    } catch (e) {
      translateError(e);
    }
  }

  async rollbackTransaction(_handle: TransactionHandle): Promise<void> {
    try {
      await this.db.query('ROLLBACK');
    } catch (e) {
      translateError(e);
    }
  }

  async queryInTransaction<T>(_handle: TransactionHandle, sql: string, params?: unknown[]): Promise<T[]> {
    return this.query<T>(sql, params);
  }

  async executeInTransaction(_handle: TransactionHandle, sql: string, params?: unknown[]): Promise<{ rowCount: number }> {
    return this.execute(sql, params);
  }

  async destroy(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.db.close();
  }
}
