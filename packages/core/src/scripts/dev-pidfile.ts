// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The dev server's per-port pidfile protocol: the record of the session that
 * owns a front-door port, its exclusive claim, and its release.
 *
 * It has no dependency beyond Node.js, so the `blocks dev` CLI loads it
 * (`@aws-blocks/core/scripts/dev-pidfile`) to claim the session the moment it
 * starts, well before the dev server it starts has loaded (see
 * {@link claimDevSession}).
 */

import { spawnSync } from 'node:child_process';
import { linkSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { BLOCKS_SANDBOX_DIR } from '../common/constants.js';

/** Persisted identity of the dev server that owns a given front-door port. */
export interface DevServerPidRecord {
  /** The supervisor process's own pid. */
  pid: number;
  /** The supervisor's parent pid — the stable `tsx watch` watcher across reloads. */
  ppid: number;
  /** The front-door port this record guards. */
  port: number;
  /**
   * `pid`'s command line when the record was written (`''` where it can't be
   * read). A live `pid` counts as this dev server only while its command line
   * still matches, so a pid the OS has since reused never blocks a start.
   * Absent in a record written by an older version.
   */
  command?: string;
  /** `ppid`'s command line when the record was written; see {@link command}. */
  parentCommand?: string;
  /**
   * The frontend dev server this process started (POSIX only): its process
   * group and port. A later start of this app may reclaim the port from
   * processes in that group — and from nothing else (see {@link reclaimPort}).
   */
  frontend?: { pgid: number; port: number };
  /**
   * The record of a `blocks dev` CLI (`pid`, with its own parent as `ppid`)
   * whose dev server has not taken the session over yet. The CLI writes it
   * before it starts `tsx watch`, so that a `dev stop` during startup finds the
   * session, and stops it by signalling the CLI. The dev server that the CLI
   * starts replaces it with its own record (see {@link claimDevPidfile}).
   */
  starting?: true;
}

/** Parse a pidfile body into a {@link DevServerPidRecord}; `null` if absent/corrupt/incomplete. */
export function parsePidRecord(text: string): DevServerPidRecord | null {
  try {
    const o = JSON.parse(text);
    if (o && Number.isInteger(o.pid) && Number.isInteger(o.ppid) && Number.isInteger(o.port)) {
      const record: DevServerPidRecord = { pid: o.pid, ppid: o.ppid, port: o.port };
      if (typeof o.command === 'string') record.command = o.command;
      if (typeof o.parentCommand === 'string') record.parentCommand = o.parentCommand;
      if (o.starting === true) record.starting = true;
      if (o.frontend && Number.isInteger(o.frontend.pgid) && o.frontend.pgid > 1 && Number.isInteger(o.frontend.port)) {
        record.frontend = { pgid: o.frontend.pgid, port: o.frontend.port };
      }
      return record;
    }
  } catch {
    // Corrupt / empty pidfile — treat as absent.
  }
  return null;
}

/** True iff a signal can be delivered to `pid` (exists). `EPERM` (exists, not ours) counts as alive. */
export function isPidAlive(pid: number, kill: (pid: number, signal: number) => void = (p, s) => process.kill(p, s)): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Read `pid`'s full command line (`ps -ww -o command=`), '' on any failure or Windows. */
export function pidCommand(pid: number): string {
  if (process.platform === 'win32') return '';
  try {
    const { stdout } = spawnSync('ps', ['-ww', '-o', 'command=', '-p', String(pid)], {
      encoding: 'utf-8',
      windowsHide: true,
      timeout: 3000,
    });
    return (stdout ?? '').trim();
  } catch {
    return '';
  }
}

/** True iff `command` looks like a `tsx watch` supervisor (not a bare shell). */
export function isTsxWatcher(command: string): boolean {
  return /\btsx\b/.test(command) && /\bwatch\b/.test(command);
}

/** Which of a record's processes are still the ones it recorded. */
export interface RecordLiveness {
  /** The recorded dev server is alive, with the command line it had. */
  pidAlive: boolean;
  /** Its `tsx watch` parent is alive, with the command line it had: the session goes on across a reload. */
  watcherAlive: boolean;
}

/**
 * Check a record's processes against the live system. A pid counts only while
 * its command line still matches the recorded one (when the record has one),
 * and the parent only while it is a `tsx watch` supervisor: a plain
 * `node server.ts` start has the caller's shell as its parent, which outlives
 * the dev server and must not keep a stale record alive. The parent of a
 * {@link DevServerPidRecord.starting} record is the CLI's caller, never a watcher.
 */
export function recordLiveness(
  record: DevServerPidRecord,
  isAlive: (pid: number) => boolean,
  commandOf: (pid: number) => string,
): RecordLiveness {
  const pidAlive =
    isAlive(record.pid) && (record.command === undefined || commandOf(record.pid) === record.command);
  let watcherAlive = false;
  if (!record.starting && record.ppid > 1 && isAlive(record.ppid)) {
    const parent = commandOf(record.ppid);
    watcherAlive = isTsxWatcher(parent) && (record.parentCommand === undefined || parent === record.parentCommand);
  }
  return { pidAlive, watcherAlive };
}

/** Result of {@link evaluateSingleton}: proceed with startup, or exit (a live peer owns the port). */
export type SingletonDecision = { action: 'proceed' } | { action: 'exit'; reason: string };

/**
 * Decide whether a *new* dev-server invocation may take over an existing
 * pidfile, or must bow out because another session already owns `port`. This
 * is the singleton guard that stops two supervisors fighting over
 * `:3000`/`:3100`, WITHOUT breaking `tsx watch`'s own restart of the *same*
 * supervisor on a file change.
 *
 * - **No / corrupt pidfile** → proceed.
 * - **Same pid** → proceed (defensive; the record is our own).
 * - **Same parent (`ppid`) and the recorded child is gone** → proceed: `tsx
 *   watch` is the stable parent across reloads, and it relaunches after the old
 *   child exits. (Two jobs started from one shell also share a parent, so a
 *   live recorded child still goes through the owner check below.)
 * - **The recorded dev server, or its `tsx watch` session, is still alive**
 *   (see {@link recordLiveness}) → exit with a clear message. A session between
 *   two reloads has no live child but a live watcher, and still owns the port.
 * - **Otherwise** the record is stale → proceed.
 */
export function evaluateSingleton(
  existing: DevServerPidRecord | null,
  self: { pid: number; ppid: number },
  liveness: RecordLiveness,
): SingletonDecision {
  if (!existing) return { action: 'proceed' };
  if (existing.pid === self.pid) return { action: 'proceed' };
  if (existing.ppid === self.ppid && !liveness.pidAlive) return { action: 'proceed' }; // tsx-watch relaunch after old child exit
  if (liveness.pidAlive || liveness.watcherAlive) {
    const pid = liveness.pidAlive ? existing.pid : existing.ppid;
    const state = existing.starting ? 'starting' : 'running';
    return { action: 'exit', reason: `a dev server is already ${state} on :${existing.port} (pid ${pid})` };
  }
  return { action: 'proceed' };
}

/** Injectable seams for {@link claimDevPidfile} (real file system and process table by default). */
export interface ClaimPidfileDeps {
  /** Create `path` holding `body` only if it doesn't exist; false when it does. Atomic: no reader sees it half-written. */
  createExclusive: (path: string, body: string) => boolean;
  /** The file's body, or null when it doesn't exist. */
  read: (path: string) => string | null;
  /** Rename `from` to `to`; false when `from` doesn't exist. */
  rename: (from: string, to: string) => boolean;
  /** Replace `path` with `body` in one step (temp file + rename): readers see the old body or the new one, never no file. */
  replace: (path: string, body: string) => void;
  /** Delete `path` if it exists. */
  remove: (path: string) => void;
  isAlive: (pid: number) => boolean;
  commandOf: (pid: number) => string;
}

/** Outcome of {@link claimDevPidfile}. */
export type PidfileClaim =
  | {
      acquired: true;
      /** The stale record this start took over (a crashed predecessor, or our own `tsx watch` predecessor), if any. */
      previous: DevServerPidRecord | null;
    }
  | { acquired: false; reason: string };

/** Write `body` to `path` only if `path` doesn't exist, atomically (temp file + hard link; `wx` where links fail). */
function createFileExclusive(path: string, body: string): boolean {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, body);
  try {
    linkSync(tmp, path);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') return false;
    // A file system without hard links: fall back to an exclusive create.
    try {
      writeFileSync(path, body, { flag: 'wx' });
      return true;
    } catch (e2) {
      if ((e2 as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw e2;
    }
  } finally {
    try { unlinkSync(tmp); } catch { /* already gone */ }
  }
}

function defaultClaimDeps(): ClaimPidfileDeps {
  return {
    createExclusive: createFileExclusive,
    read: (p) => {
      try { return readFileSync(p, 'utf-8'); } catch { return null; }
    },
    rename: (from, to) => {
      try { renameSync(from, to); return true; } catch { return false; }
    },
    replace: (p, body) => {
      const tmp = `${p}.${process.pid}.tmp`;
      writeFileSync(tmp, body);
      renameSync(tmp, p);
    },
    remove: (p) => {
      try { unlinkSync(p); } catch { /* already gone */ }
    },
    isAlive: (pid) => isPidAlive(pid),
    commandOf: (pid) => pidCommand(pid),
  };
}

/** How many times {@link claimDevPidfile} retries when other starts keep changing the pidfile under it. */
const CLAIM_ATTEMPTS = 5;

/**
 * Take the per-port pidfile for `self`, so exactly one dev server runs on a
 * port even when several start at the same moment.
 *
 * The pidfile is created exclusively, so of two simultaneous starts only one
 * creates it. When it already exists, {@link evaluateSingleton} decides: a live
 * owner makes this start bow out; a stale (or unreadable) record is taken over.
 *
 * The record of our own `tsx watch` predecessor (same live watcher, exited
 * child) is replaced in place, so the pidfile exists throughout a reload and a
 * `dev stop` run at any moment of it finds the session. Only this start can
 * take that record over: any other start sees the live watcher and bows out,
 * and `tsx watch` runs one child at a time.
 *
 * Likewise the {@link DevServerPidRecord.starting} record of the `blocks dev`
 * CLI that started this dev server (`adopt`, its pid) is replaced in place: the
 * session it claimed is this one. Any other start sees the live CLI and bows out.
 *
 * Any other stale record is taken over by first renaming it to a private
 * path — of two starts that both found it stale, only one rename succeeds —
 * then checking that what it took is the record it judged (a racer may have
 * replaced it, in which case that record is put back and judged again), then
 * creating the pidfile afresh. No session is running then, so nothing needs to
 * find the pidfile in between.
 */
export function claimDevPidfile(
  path: string,
  self: DevServerPidRecord,
  deps: Partial<ClaimPidfileDeps> = {},
  adopt?: number,
): PidfileClaim {
  const d = { ...defaultClaimDeps(), ...deps };
  const body = JSON.stringify(self);
  const judge = (record: DevServerPidRecord | null): SingletonDecision =>
    record ? evaluateSingleton(record, self, recordLiveness(record, d.isAlive, d.commandOf)) : { action: 'proceed' };
  let previous: DevServerPidRecord | null = null;
  for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt++) {
    if (d.createExclusive(path, body)) return { acquired: true, previous };
    const text = d.read(path);
    if (text === null) continue; // removed since: create again
    const existing = parsePidRecord(text);
    if (existing?.starting && adopt !== undefined && existing.pid === adopt) {
      d.replace(path, body);
      return { acquired: true, previous: existing };
    }
    const liveness = existing ? recordLiveness(existing, d.isAlive, d.commandOf) : null;
    const decision = existing && liveness ? evaluateSingleton(existing, self, liveness) : { action: 'proceed' as const };
    if (decision.action === 'exit') return { acquired: false, reason: decision.reason };
    if (existing && liveness?.watcherAlive && !liveness.pidAlive && existing.ppid === self.ppid && existing.pid !== self.pid) {
      d.replace(path, body);
      return { acquired: true, previous: existing };
    }
    const claimPath = `${path}.${self.pid}.gc`;
    if (!d.rename(path, claimPath)) continue; // another start took it first
    const claimedText = d.read(claimPath);
    const claimed = claimedText === null ? null : parsePidRecord(claimedText);
    if (claimedText !== text) {
      const again = judge(claimed);
      if (again.action === 'exit') {
        // A racer's live record: put it back unless yet another start has created one since.
        if (claimedText !== null && !d.createExclusive(path, claimedText)) { /* the newer one stays */ }
        d.remove(claimPath);
        return { acquired: false, reason: again.reason };
      }
    }
    d.remove(claimPath);
    previous = claimed ?? previous;
  }
  return { acquired: false, reason: `other dev servers kept starting on :${self.port}` };
}

/** The per-port pidfile path a dev server records its supervisor identity in. */
export function devPidfilePath(port: number): string {
  return join(BLOCKS_SANDBOX_DIR, `dev-server.${port}.pid`);
}

/**
 * Remove the pidfile at `path` if it still holds `owner`'s record. The
 * pidfile is renamed to a private path first (rename(2) is atomic), and put
 * back when the snapshot is someone else's record: a `tsx watch` successor or
 * the dev server that took a CLI's record over may write it between a read and
 * an unlink, and must keep its record. Only the private copy is ever unlinked.
 */
export function releaseDevPidfile(path: string, owner: number): void {
  const claimPath = `${path}.${owner}.gc`;
  try {
    renameSync(path, claimPath);
  } catch {
    return; // No pidfile to remove (already gone / never written).
  }
  let record: DevServerPidRecord | null = null;
  try { record = parsePidRecord(readFileSync(claimPath, 'utf-8')); } catch { /* unreadable snapshot */ }
  if (record && record.pid !== owner) {
    try { linkSync(claimPath, path); } catch { /* a newer pidfile stays */ }
  }
  try { unlinkSync(claimPath); } catch { /* already gone */ }
}

/**
 * The environment variable carrying the pid of the `blocks dev` CLI to the dev
 * server it starts, which takes over the CLI's starting record (see
 * {@link claimDevSession}).
 */
export const DEV_SESSION_ENV = 'BLOCKS_DEV_SESSION';

/** Outcome of {@link claimDevSession}. */
export type DevSessionClaim =
  | {
      acquired: true;
      /** Remove the starting record, unless the dev server has taken it over. Idempotent. */
      release: () => void;
    }
  | { acquired: false; reason: string };

/**
 * Claim the dev session on `port` for this process, the `blocks dev` CLI of
 * the app at `root`, before it starts its dev server: write a
 * {@link DevServerPidRecord.starting} record with the same exclusive claim as
 * the dev server's. A `dev stop` from then on finds the session and SIGTERMs
 * the CLI, which stops what it started; until now, the pidfile appeared only
 * once the dev server had loaded, and a stop in between found nothing to stop.
 * The dev server, started with {@link DEV_SESSION_ENV} set to this pid, takes
 * the record over. A stale record's frontend group carries over, so the dev
 * server may still reclaim its port from that predecessor's frontend.
 */
export function claimDevSession(root: string, port: number): DevSessionClaim {
  const path = join(root, devPidfilePath(port));
  mkdirSync(dirname(path), { recursive: true });
  const self: DevServerPidRecord = {
    pid: process.pid,
    ppid: process.ppid,
    port,
    command: pidCommand(process.pid),
    parentCommand: pidCommand(process.ppid),
    starting: true,
  };
  const claim = claimDevPidfile(path, self);
  if (!claim.acquired) return claim;
  const frontend = claim.previous?.frontend;
  if (frontend) {
    // Nothing else writes the record before the dev server starts.
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ ...self, frontend }));
    renameSync(tmp, path);
  }
  return { acquired: true, release: () => releaseDevPidfile(path, process.pid) };
}
