// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Where a `Database`'s local PGlite data lives, and which process may open it. The
 * mock (`index.mock.ts`) and the `bb-data` CLI both resolve and lock the directory
 * here, so `bb-data migrate`, `status` and `generate-types` work on the same database
 * that `npm run dev` uses, and never at the same time.
 *
 * @module
 */

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { linkSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync, type Dirent } from 'node:fs';
import { dirname, join } from 'node:path';
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

// ── One process per local database ──────────────────────────────────────────
// PGlite runs PostgreSQL inside one process: two processes on one data directory
// corrupt it. So the dev mock (role `app`) and the CLI (role `cli`) both take
// `<dataDir>.lock`, next to the data directory, BEFORE they open PGlite:
//   - Acquire: hard-link a complete record `{ pid, start, role, token }` to the
//     lock path. link(2) fails with EEXIST when the lock exists (like O_EXCL), and
//     a reader never sees a half-written record.
//   - Stale: the holder's pid is dead, or now belongs to a process with another
//     start time (pid reused). Take over by renaming the lock to a unique name,
//     checking that it is the record that was inspected, deleting it, and
//     acquiring again. A fresh lock moved by mistake is linked back.
//   - Release: when the process exits, only if the lock still holds our record.
// A process that already holds the lock (several `Database`s with one fullId)
// gets it again.

export type LocalDatabaseRole = 'app' | 'cli';

interface LockRecord {
  pid: number;
  /** Start time of `pid`, to tell a reused pid apart; null where it can't be read. */
  start: string | null;
  role: LocalDatabaseRole;
  token: string;
}

/** Lock path → the exact record this process wrote there. */
const heldLocks = new Map<string, string>();

function lockPath(dataDir: string): string {
  return `${dataDir}.lock`;
}

function readRaw(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

function parseRecord(raw: string): LockRecord | null {
  try {
    const record = JSON.parse(raw);
    return typeof record?.pid === 'number' ? record : null;
  } catch {
    return null;
  }
}

/** A process's start time (Linux: `/proc/<pid>/stat`; macOS: `ps`); null elsewhere or when it is gone. */
function processStartTime(pid: number): string | null {
  try {
    if (process.platform === 'linux') {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      // Field 22 (starttime); fields 3+ follow the parenthesized command name.
      return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? null;
    }
    if (process.platform === 'darwin') {
      const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      return out.trim() || null;
    }
  } catch {
    /* gone, or not readable */
  }
  return null;
}

let ownStart: string | null | undefined;
function ownStartTime(): string | null {
  if (ownStart === undefined) ownStart = processStartTime(process.pid);
  return ownStart;
}

/** Whether the recorded holder is still running: its pid is alive and was not reused. */
function isHolderAlive(record: LockRecord): boolean {
  try {
    process.kill(record.pid, 0);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EPERM') return false;
  }
  if (!record.start) return true;
  const start = record.pid === process.pid ? ownStartTime() : processStartTime(record.pid);
  return !start || start === record.start;
}

function releaseOnExit(path: string, raw: string): void {
  if (heldLocks.size === 0) {
    process.once('exit', () => {
      for (const [held, mine] of heldLocks) if (readRaw(held) === mine) rmSync(held, { force: true });
    });
  }
  heldLocks.set(path, raw);
}

/** Remove a stale lock without ever removing a fresh one. */
function removeStaleLock(path: string, inspected: string): void {
  const aside = `${path}.stale-${process.pid}-${randomUUID()}`;
  try {
    renameSync(path, aside);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw e;
  }
  if (readRaw(aside) !== inspected) {
    // Another process replaced the stale lock between our read and our rename:
    // put its fresh lock back, unless yet another one already took its place.
    try {
      linkSync(aside, path);
    } catch {
      /* the path is taken again; that holder owns it */
    }
  }
  rmSync(aside, { force: true });
}

function inUseMessage(dataDir: string, holder: LockRecord, path: string): string {
  const by =
    holder.role === 'cli'
      ? `in use by a \`bb-data\` command (pid ${holder.pid}). Wait for it to finish, or stop it`
      : `open in another process (pid ${holder.pid}), most likely \`npm run dev\`. Stop it first (\`npm run dev:stop\`)`;
  return (
    `The local database ${dataDir} is ${by}: two processes on one PGlite database corrupt it. ` +
    `If that process is not using the database, delete ${path}.`
  );
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Take the local database at `dataDir` for this process, until it exits. Call it
 * before opening PGlite on the directory.
 *
 * While another process holds it, waits up to `waitMs` for it to be released. The
 * CLI does not wait for an app process (a dev server keeps its database open until
 * it stops).
 *
 * @param role - `app` for the dev mock, `cli` for a `bb-data` command.
 * @returns `dataDir`
 * @throws When another live process still holds the database (the message names
 *   it and says what to do).
 */
export function lockLocalDatabase(
  dataDir: string,
  role: LocalDatabaseRole,
  waitMs = role === 'cli' ? 60_000 : 30_000,
): string {
  const path = lockPath(dataDir);
  mkdirSync(dirname(path), { recursive: true });
  const raw = JSON.stringify({ pid: process.pid, start: ownStartTime(), role, token: randomUUID() } satisfies LockRecord);
  const tmp = `${path}.${process.pid}-${randomUUID()}`;
  writeFileSync(tmp, raw);
  const deadline = Date.now() + waitMs;
  let announced = false;
  try {
    for (;;) {
      try {
        linkSync(tmp, path);
        releaseOnExit(path, raw);
        return dataDir;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      }
      const inspected = readRaw(path);
      if (inspected === null) continue; // released meanwhile
      const holder = parseRecord(inspected);
      if (!holder || !isHolderAlive(holder)) {
        removeStaleLock(path, inspected);
        continue;
      }
      if (holder.pid === process.pid) return dataDir; // already ours
      if ((role === 'cli' && holder.role === 'app') || Date.now() > deadline) {
        throw new Error(inUseMessage(dataDir, holder, path));
      }
      if (!announced) {
        console.log(`Waiting for pid ${holder.pid} (${holder.role === 'cli' ? 'a bb-data command' : 'an app'}) to release ${dataDir}...`);
        announced = true;
      }
      sleepSync(200);
    }
  } finally {
    rmSync(tmp, { force: true });
  }
}
