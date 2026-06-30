// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { PGlite } from '@electric-sql/pglite';
import { existsSync, mkdirSync, readdirSync, rmSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseEngine, TransactionHandle } from '@aws-blocks/data-common';
import { DatabaseErrors, wrapError } from '../errors.js';

/** PostgreSQL error code for unique constraint violations. */
const PG_UNIQUE_VIOLATION = '23505';

/** PostgreSQL error code class for connection exceptions. */
const PG_CONNECTION_EXCEPTION_CLASS = '08';

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

/**
 * Top-level entries that, when present in a directory, affirmatively mark that
 * directory as being *itself* a PGlite/PostgreSQL data dir (as opposed to a
 * parent that merely contains data dirs). `postmaster.opts`/`postmaster.pid`
 * are written by PGlite's own boot, and `global`/`base` are PostgreSQL's own
 * data-dir subdirectories. None of these appear at the top level of a directory
 * like `.bb-data` that only contains child data dirs (e.g. `.bb-data/main`).
 */
const PGLITE_DATA_DIR_ARTIFACTS = ['postmaster.opts', 'postmaster.pid', 'global', 'base'];

/**
 * Detect and repair a half-written PGlite data directory left behind when a
 * previous boot was killed mid-`initdb` — e.g. `tsx watch` SIGTERMs (then, after
 * its grace period, SIGKILLs) the dev server while a `Database` block is still
 * running first-boot `initdb`/migrations.
 *
 * A complete PGlite/PostgreSQL data directory always contains both `PG_VERSION`
 * and `global/pg_control`. A directory that *is itself* a data dir (it carries
 * PGlite-own-level artifacts — `postmaster.opts`/`postmaster.pid`/`global`/`base`)
 * but is missing either completeness marker is a partially-initialized data dir:
 * `new PGlite(dir)` aborts on it with `Aborted()` (initdb refuses a non-empty
 * dir; an existing-DB open fails the control-file check). Before this guard that
 * abort rejected the dev server's local-deploy phase *before* it ever called
 * `listen()`, so the port never bound and the app stayed unreachable until
 * `.bb-data` was deleted by hand (issue #98).
 *
 * Contract: this function only ever re-initializes a directory that is *itself*
 * a partial PGlite data dir (artifacts present, completeness markers absent). It
 * NEVER deletes a directory that is complete, that contains complete child data
 * dirs (e.g. the `.bb-data` root the CLI opens, which holds `main/`), or that is
 * non-empty for any other reason. Recovery wipes only a leaf partial dir, which
 * holds no recoverable data (initdb never finished), so re-initializing it is
 * deterministic and loses nothing. Any non-empty directory that is neither
 * complete nor affirmatively partial is left untouched — PGlite/initdb proceeds
 * (or fails loudly) rather than this code destroying data it does not own.
 */
export function recoverIncompleteDataDir(dataDir: string): void {
  let entries: string[];
  try {
    entries = readdirSync(dataDir);
  } catch {
    return; // unreadable/missing — mkdirSync in the constructor handles creation
  }
  // Empty dir: a fresh checkout or post-`rm -rf` — PGlite will run initdb cleanly.
  if (entries.length === 0) return;
  // Complete data dir (both markers present): real data — never touch it.
  const initialized =
    existsSync(join(dataDir, 'PG_VERSION')) && existsSync(join(dataDir, 'global', 'pg_control'));
  if (initialized) return;
  // Affirmatively decide whether this directory is itself a partial data dir.
  // Without this check a parent that merely *contains* complete data dirs (the
  // `.bb-data` root the CLI opens, holding `main/`) would match "non-empty +
  // markers absent" and get recursively wiped — destroying every local database
  // (issue #98 review). Only a dir carrying PGlite-own-level artifacts at its
  // own level is a data dir we may re-initialize.
  const isPartialDataDir = entries.some((entry) => PGLITE_DATA_DIR_ARTIFACTS.includes(entry));
  if (!isPartialDataDir) {
    // Non-empty, not complete, and not a data dir of its own — e.g. a parent of
    // child data dirs, or unrelated user files. Leave it alone.
    return;
  }
  console.warn(
    `[PGliteEngine] Data directory ${dataDir} is incompletely initialized ` +
      `(PGlite artifacts present but missing PG_VERSION/global/pg_control) — re-initializing. ` +
      `A previous boot was likely interrupted mid-initdb (e.g. a dev-server restart).`,
  );
  rmSync(dataDir, { recursive: true, force: true });
  mkdirSync(dataDir, { recursive: true });
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
    // Repair a half-written data dir from an interrupted initdb BEFORE opening
    // it, so a single interrupted boot is recoverable instead of permanently
    // fatal (the dev-server port would otherwise never bind — see #98).
    recoverIncompleteDataDir(dataDir);
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
