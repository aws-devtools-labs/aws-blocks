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
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, type Dirent } from 'node:fs';
import { basename, dirname, join } from 'node:path';
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
// `<dataDir>.lock`, next to the data directory, BEFORE they open PGlite.
//
// Records. Every file of the protocol holds one record `{ pid, start, role, token }`
// (start: the process start time, to tell a reused pid apart; token: random, new
// for every file created). A file is created only by hard-linking a complete
// record from a private temp file: link(2) fails with EEXIST when the path exists
// (the O_EXCL guarantee), never replaces it, and a reader never sees half a record.
//
// Acquire: link our record to the lock path P. If P exists, read its record X:
//   - X's process is alive: wait or refuse. A live lock is never touched.
//   - X's process is dead (or its pid now belongs to a process with another start
//     time): reap X, then try again.
// Reap X at P: create `P.reap-<X.token>` (link, so at most one reaper per record).
// Holding it, re-read P; if P still holds X, unlink P. Then unlink the reap file.
// If the reap file exists: its holder is alive → back off; dead → reap the reap
// file by the same rule (bounded depth), then try again.
// Release: on exit, unlink P only if it still holds our record.
//
// Safety: a record at a path Q is removed only (a) by its own process, which first
// checks Q still holds its record, or (b) by the one holder of `Q.reap-<token>`,
// after it saw the record's process dead and, while holding the reap file, saw Q
// still holding that record. Nothing renames or moves a file. Take any record X
// whose process is alive: (a) doesn't apply to other processes; (b) requires X's
// process to have been seen dead, and a dead process stays dead, so no reaper
// targets X. In (b) the unlink can only hit X: while the reaper holds
// `Q.reap-<X.token>`, X can leave Q only through that reaper (its owner is dead),
// and no other record can appear at Q while X is there (link fails). A reap file
// is a record under the same rules, so a live reaper keeps it. Hence a live
// process's lock is never removed, and two live processes never both hold P.
//
// A process that already holds the lock (several `Database`s with one fullId)
// gets it again.

export type LocalDatabaseRole = 'app' | 'cli';

interface LockRecord {
  pid: number;
  /** Start time of `pid`, to tell a reused pid apart; null where it can't be read. */
  start: string | null;
  role: LocalDatabaseRole | 'reap';
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

/** The reap file for a record: named by its token, or by a hash of an unreadable record. */
function reapPath(path: string, inspected: string): string {
  const token = parseRecord(inspected)?.token;
  const key =
    typeof token === 'string' && /^[\w-]{1,64}$/.test(token)
      ? token
      : createHash('sha256').update(inspected).digest('hex').slice(0, 32);
  return `${path}.reap-${key}`;
}

const MAX_REAP_DEPTH = 4;

/**
 * Remove the record `inspected` from `path`, whose process was seen dead (see the
 * safety argument above). Returns false when another live reaper holds it, so
 * the caller backs off.
 */
function reap(path: string, inspected: string, depth = 0): boolean {
  const reaper = reapPath(path, inspected);
  const record = newRecord('reap');
  const tmp = tempPath(path);
  writeFileSync(tmp, record);
  try {
    linkSync(tmp, reaper);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    const other = readRaw(reaper);
    if (other === null) return true; // that reaper finished; try again
    const holder = parseRecord(other);
    if (holder && isHolderAlive(holder)) return false;
    return depth < MAX_REAP_DEPTH && reap(reaper, other, depth + 1);
  } finally {
    rmSync(tmp, { force: true });
  }
  try {
    testHook('takeover');
    if (readRaw(path) === inspected) rmSync(path, { force: true });
  } finally {
    rmSync(reaper, { force: true }); // ours: only we remove it while we live
  }
  return true;
}

/**
 * After taking the lock: remove reap files left by reapers that died, and temp
 * files left by processes that died. Reap files go by the same rule as locks.
 */
function removeOrphans(path: string): void {
  const dir = dirname(path);
  const base = basename(path);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const file = join(dir, entry);
    if (entry.startsWith(`${base}.reap-`)) {
      const raw = readRaw(file);
      const holder = raw === null ? null : parseRecord(raw);
      if (raw !== null && !(holder && isHolderAlive(holder))) reap(file, raw);
      continue;
    }
    // `<lock>.<pid>-<uuid>`: a temp file whose process is gone (a link to it, if
    // any, is a separate name and stays).
    const pid = entry.startsWith(`${base}.`) ? /^(\d+)-[0-9a-f-]{36}$/.exec(entry.slice(base.length + 1))?.[1] : undefined;
    if (pid && !isHolderAlive({ pid: Number(pid), start: null, role: 'app', token: '' })) rmSync(file, { force: true });
  }
}

function newRecord(role: LockRecord['role']): string {
  return JSON.stringify({ pid: process.pid, start: ownStartTime(), role, token: randomUUID() } satisfies LockRecord);
}

function tempPath(path: string): string {
  return `${path}.${process.pid}-${randomUUID()}`;
}

function inUseMessage(dataDir: string, holder: LockRecord, path: string, role: LocalDatabaseRole): string {
  const by =
    holder.role === 'cli'
      ? `in use by a \`bb-data\` command (pid ${holder.pid}). Wait for it to finish, or stop it`
      : role === 'app'
        ? `in use by another app process (pid ${holder.pid}). Is another \`npm run dev\` running for this app, ` +
          'on another port? Stop it first (`npm run dev:stop -- --port <port>`)'
        : `open in another process (pid ${holder.pid}), most likely \`npm run dev\`. Stop it first (\`npm run dev:stop\`)`;
  return (
    `The local database ${dataDir} is ${by}: two processes on one PGlite database corrupt it. ` +
    `If that process is not using the database, delete ${path}.`
  );
}

/**
 * Whether this process holds the lock of `dataDir` (an earlier `Database` with the
 * same fullId took it): its PGlite engine is then live, and its `postmaster.pid` too.
 */
export function holdsLocalDatabase(dataDir: string): boolean {
  const path = lockPath(dataDir);
  const mine = heldLocks.get(path);
  return mine !== undefined && readRaw(path) === mine;
}

/** How long an app waits for another app process: a `tsx watch` restart, where the old process is exiting. */
const APP_RESTART_WAIT_MS = 10_000;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Test seam: with `BLOCKS_TEST_DB_LOCK_HOOKS=<dir>`, each protocol step announces
 * itself as `<dir>/<pid>.<step>`; a step listed in `BLOCKS_TEST_DB_LOCK_PAUSE`
 * stops there (the first time) until `<dir>/<pid>.<step>.go` exists. Lets tests
 * force a given interleaving of several processes.
 */
const pausedSteps = new Set<string>();
function testHook(step: 'stale-inspected' | 'takeover' | 'live-holder'): void {
  const dir = process.env.BLOCKS_TEST_DB_LOCK_HOOKS;
  if (!dir) return;
  writeFileSync(join(dir, `${process.pid}.${step}`), '');
  if (pausedSteps.has(step) || !(process.env.BLOCKS_TEST_DB_LOCK_PAUSE ?? '').split(',').includes(step)) return;
  pausedSteps.add(step);
  const go = join(dir, `${process.pid}.${step}.go`);
  while (!existsSync(go)) sleepSync(20);
}

/**
 * Take the local database at `dataDir` for this process, until it exits. Call it
 * before opening PGlite on the directory.
 *
 * While another process holds it, waits up to `waitMs` for it to be released. The
 * CLI does not wait for an app process (a dev server keeps its database open until
 * it stops); an app waits for another app at most 10 s (a `tsx watch` restart),
 * then refuses. Only this process (this module instance) re-enters its own lock.
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
  const raw = newRecord(role);
  const tmp = tempPath(path);
  writeFileSync(tmp, raw);
  const started = Date.now();
  const deadline = started + waitMs;
  let announced = false;
  try {
    for (;;) {
      let taken = true;
      try {
        linkSync(tmp, path);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        taken = false;
      }
      if (taken) {
        releaseOnExit(path, raw);
        try {
          removeOrphans(path);
        } catch {
          /* best-effort cleanup; the lock is ours either way */
        }
        return dataDir;
      }
      const inspected = readRaw(path);
      if (inspected === null) continue; // released meanwhile
      const holder = parseRecord(inspected);
      if (!holder || !isHolderAlive(holder)) {
        testHook('stale-inspected');
        if (!reap(path, inspected)) {
          if (Date.now() > deadline) throw new Error(`Another process is still removing a stale ${path}. Try again.`);
          sleepSync(50); // another live process is reaping that record
        }
        continue;
      }
      if (heldLocks.get(path) === inspected) return dataDir; // already ours, in this process
      testHook('live-holder');
      const until = role === 'app' && holder.role === 'app' ? Math.min(deadline, started + APP_RESTART_WAIT_MS) : deadline;
      if ((role === 'cli' && holder.role === 'app') || Date.now() > until) {
        throw new Error(inUseMessage(dataDir, holder, path, role));
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
