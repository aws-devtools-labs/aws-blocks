// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Where a `Database`'s local PGlite data lives, and which process has it open. The
 * mock (`index.mock.ts`) and the `bb-data` CLI both resolve the directory here, so
 * `bb-data migrate`, `status` and `generate-types` work on the same database that
 * `npm run dev` uses.
 *
 * @module
 */

import { linkSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync, type Dirent } from 'node:fs';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { hasInitializedPgliteDataDir } from './engines/pglite-engine.js';

/** Local Building Block data, relative to the app root (the dev server's working directory). */
const LOCAL_DATA_ROOT = '.bb-data';

/** The PGlite data directory of the local `Database` with this `fullId`: `.bb-data/<fullId>`. */
export function localDatabaseDir(fullId: string): string {
  return join(LOCAL_DATA_ROOT, fullId);
}

/**
 * The `fullId`s of the local databases under `.bb-data/` (each directory that holds an
 * initialized PGlite database), sorted.
 */
export function listLocalDatabases(): string[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(LOCAL_DATA_ROOT, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && hasInitializedPgliteDataDir(localDatabaseDir(e.name)))
    .map((e) => e.name)
    .sort();
}

/**
 * The data directory a CLI command targets: `.bb-data/<block>` when `block` (a
 * `fullId`) is given, else the only local database. Returns `null` when no local
 * database exists yet. The directory may not exist when `block` is given.
 *
 * @throws If `block` is not a plain directory name, or if there are several local
 *   databases and `block` is not given (the message lists them).
 */
export function resolveLocalDatabaseDir(block: string | undefined): string | null {
  if (block !== undefined) {
    if (!block || block === '.' || block === '..' || /[\\/]/.test(block)) {
      throw new Error(`--block expects a database id such as "my-app-main", got "${block}".`);
    }
    return localDatabaseDir(block);
  }
  const found = listLocalDatabases();
  if (found.length > 1) {
    throw new Error(
      `There are several local databases in ${LOCAL_DATA_ROOT}/: ${found.join(', ')}. ` +
        'Pass --block <id> to pick one.',
    );
  }
  return found.length === 1 ? localDatabaseDir(found[0]) : null;
}

/**
 * Like {@link resolveLocalDatabaseDir}, for commands that need a database.
 *
 * @param options.mustExist - Also require `.bb-data/<block>` to hold a database,
 *   for commands that only read (`generate-types`); `migrate` creates it.
 * @throws As {@link resolveLocalDatabaseDir}, and when there is no local database
 *   yet (the message says how to get one).
 */
export function requireLocalDatabaseDir(block: string | undefined, options?: { mustExist?: boolean }): string {
  const dir = resolveLocalDatabaseDir(block);
  if (dir && (!options?.mustExist || hasInitializedPgliteDataDir(dir))) return dir;
  if (dir) {
    const found = listLocalDatabases();
    throw new Error(
      `There is no local database in ${dir}. ` +
        (found.length > 0 ? `Local databases: ${found.join(', ')}.` : 'There is none yet.'),
    );
  }
  throw new Error(
    `There is no local database in ${LOCAL_DATA_ROOT}/ yet. Start the app (\`npm run dev\`) and make ` +
      'one request that queries the database: the first query creates it and applies the migrations. ' +
      `Or pass --block <id> to create ${LOCAL_DATA_ROOT}/<id> now. The id is the Database's fullId: ` +
      "\"my-app-main\" for new Database(new Scope('my-app'), 'main').",
  );
}

// ── Which process has a local database open ─────────────────────────────────
// PGlite runs PostgreSQL inside one process: two processes on one data directory
// corrupt it. The mock records that an app process (the dev server, a test run)
// has the database open; the CLI takes the database for the length of a command.
// The record is `<dataDir>.lock`, next to the data directory: `{ pid, by }`.

interface LockRecord {
  pid: number;
  by: 'app' | 'cli';
}

const heldLocks = new Set<string>();

function lockPath(dataDir: string): string {
  return `${dataDir}.lock`;
}

function readLock(path: string): LockRecord | null {
  try {
    const record = JSON.parse(readFileSync(path, 'utf8'));
    return typeof record?.pid === 'number' ? record : null;
  } catch {
    return null;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Remove this process's records when it exits (a successor's record is left alone). */
function releaseOnExit(path: string): void {
  if (heldLocks.size === 0) {
    process.once('exit', () => {
      for (const held of heldLocks) if (readLock(held)?.pid === process.pid) rmSync(held, { force: true });
    });
  }
  heldLocks.add(path);
}

/**
 * Record that this process has the database at `dataDir` open, until it exits.
 * Never refuses — the app works as before — so the CLI can tell the database is in
 * use. Best-effort: a missing record only weakens that check.
 */
export function markLocalDatabaseOpen(dataDir: string): void {
  const path = lockPath(dataDir);
  const tmp = `${path}.${process.pid}`;
  try {
    writeFileSync(tmp, JSON.stringify({ pid: process.pid, by: 'app' } satisfies LockRecord));
    renameSync(tmp, path); // atomic: a reader never sees a half-written record
    releaseOnExit(path);
  } catch {
    rmSync(tmp, { force: true });
  }
}

/**
 * Take the database at `dataDir` for this CLI process, until it exits. Waits while
 * another bb-data command has it.
 *
 * @returns `dataDir`
 * @throws When an app process (`npm run dev`) has the database open, or another
 *   bb-data command still has it after `timeoutMs`.
 */
export async function lockLocalDatabase(dataDir: string, timeoutMs = 60_000): Promise<string> {
  const path = lockPath(dataDir);
  const tmp = `${path}.${process.pid}`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(tmp, JSON.stringify({ pid: process.pid, by: 'cli' } satisfies LockRecord));
  const deadline = Date.now() + timeoutMs;
  let announced = false;
  try {
    for (;;) {
      try {
        linkSync(tmp, path); // atomic create-if-absent, with the full record in place
        releaseOnExit(path);
        return dataDir;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      }
      const holder = readLock(path);
      if (!holder || holder.pid === process.pid || !isAlive(holder.pid)) {
        rmSync(path, { force: true }); // left behind by a process that is gone
        continue;
      }
      if (holder.by === 'app') {
        throw new Error(
          `${dataDir} is open in another process (pid ${holder.pid}), most likely \`npm run dev\`. ` +
            'Stop it first (`npm run dev:stop`): two processes on one PGlite database corrupt it. ' +
            `If that process is not using the database, delete ${path}.`,
        );
      }
      if (Date.now() > deadline) {
        throw new Error(
          `Another bb-data command (pid ${holder.pid}) is still using ${dataDir}. ` +
            `If that process is not using the database, delete ${path}.`,
        );
      }
      if (!announced) {
        console.log(`Waiting for another bb-data command (pid ${holder.pid}) to finish with ${dataDir}...`);
        announced = true;
      }
      await sleep(200);
    }
  } finally {
    rmSync(tmp, { force: true });
  }
}
