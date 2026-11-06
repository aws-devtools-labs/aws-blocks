// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The dev server's per-port pidfile protocol: the record of the session that
 * owns a front-door port, its exclusive claim, and its release.
 *
 * It has no dependency beyond Node.js, so the `cdk-blocks dev` CLI loads it
 * (`@aws-blocks/core/scripts/dev-pidfile`) to claim the session the moment it
 * starts, well before the dev server it starts has loaded (see
 * {@link claimDevSession}).
 */

import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { linkSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
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
   * The frontend dev server this process started, and its port. A later start
   * of this app may reclaim the port from that frontend — and from nothing else
   * (see {@link reclaimPort}). On POSIX it is recorded by its process group
   * (`pgid`). Windows has no process groups: there it is recorded by the
   * processes of its tree that listened on the port (`listeners`), each with its
   * creation time, which a pid that Windows hands out again does not have.
   */
  frontend?: { port: number; pgid?: number; listeners?: FrontendListener[] };
  /**
   * The record of a `cdk-blocks dev` CLI (`pid`, with its own parent as `ppid`)
   * whose dev server has not taken the session over yet. The CLI writes it
   * before it starts `tsx watch`, so that a `dev stop` during startup finds the
   * session, and stops it by signalling the CLI. The dev server that the CLI
   * starts replaces it with its own record (see {@link claimDevPidfile}).
   */
  starting?: true;
  /** Random, new for every record written: names the record's reap file (see {@link claimDevPidfile}). */
  token?: string;
  /**
   * The `cdk-blocks sandbox` session (its process) that started this dev server,
   * set from {@link SANDBOX_SESSION_ENV}: that session ends with its dev
   * server, so `dev stop` waits for it and says it stopped the sandbox.
   */
  sandbox?: { pid: number };
  /**
   * The `cdk-blocks dev` CLI that started this dev server's `tsx watch` (its
   * process), set from {@link DEV_SESSION_ENV}: the top of the session. On
   * Windows, where a signal runs no cleanup and a process that a shell started
   * outlives its parent, `dev stop` ends the session by ending this process's
   * whole tree, once the recorded `tsx watch` is proven to descend from it.
   */
  session?: { pid: number };
}

/** A process of the frontend's tree that listened on its port, on Windows: its pid and CIM creation time (a FILETIME). */
export interface FrontendListener {
  pid: number;
  created: string;
}

/**
 * The environment variable carrying the pid of the `cdk-blocks sandbox` process to
 * the dev server it starts, which records it (see {@link DevServerPidRecord.sandbox}).
 */
export const SANDBOX_SESSION_ENV = 'BLOCKS_SANDBOX_SESSION';

/** Parse a pidfile body into a {@link DevServerPidRecord}; `null` if absent/corrupt/incomplete. */
export function parsePidRecord(text: string): DevServerPidRecord | null {
  try {
    const o = JSON.parse(text);
    if (o && Number.isInteger(o.pid) && Number.isInteger(o.ppid) && Number.isInteger(o.port)) {
      const record: DevServerPidRecord = { pid: o.pid, ppid: o.ppid, port: o.port };
      if (typeof o.command === 'string') record.command = o.command;
      if (typeof o.parentCommand === 'string') record.parentCommand = o.parentCommand;
      if (o.starting === true) record.starting = true;
      if (typeof o.token === 'string') record.token = o.token;
      const frontend = parseFrontend(o.frontend);
      if (frontend) record.frontend = frontend;
      if (o.sandbox && Number.isInteger(o.sandbox.pid) && o.sandbox.pid > 1) record.sandbox = { pid: o.sandbox.pid };
      if (o.session && Number.isInteger(o.session.pid) && o.session.pid > 1) record.session = { pid: o.session.pid };
      return record;
    }
  } catch {
    // Corrupt / empty pidfile — treat as absent.
  }
  return null;
}

/** A record's `frontend`: a port, with a process group (POSIX) or the listeners (Windows) it may reclaim it from. */
function parseFrontend(o: unknown): DevServerPidRecord['frontend'] | undefined {
  if (!o || typeof o !== 'object') return undefined;
  const { port, pgid, listeners } = o as Record<string, unknown>;
  if (!Number.isInteger(port)) return undefined;
  const frontend: NonNullable<DevServerPidRecord['frontend']> = { port: port as number };
  if (Number.isInteger(pgid) && (pgid as number) > 1) frontend.pgid = pgid as number;
  const owned = Array.isArray(listeners)
    ? listeners.filter(
        (l): l is FrontendListener =>
          !!l && Number.isInteger(l.pid) && l.pid > 1 && typeof l.created === 'string' && /^\d+$/.test(l.created),
      )
    : [];
  if (owned.length > 0) frontend.listeners = owned.map(({ pid, created }) => ({ pid, created }));
  return frontend.pgid !== undefined || frontend.listeners !== undefined ? frontend : undefined;
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
  /** Replace `path` with `body` in one step (temp file + rename): readers see the old body or the new one, never no file. */
  replace: (path: string, body: string) => void;
  /** Delete `path` if it exists. */
  remove: (path: string) => void;
  /** The files next to `path` whose names start with `<path>.` (temp and reap files). */
  siblings: (path: string) => string[];
  /** The other dev servers' pidfiles of the app: `dev-server.<port>.pid` files in `path`'s directory, `path` excluded. */
  peers: (path: string) => string[];
  isAlive: (pid: number) => boolean;
  commandOf: (pid: number) => string;
  /** Wait before trying again while another live process holds a record's reap file. */
  sleep: (ms: number) => void;
  /** Test seam: called at each step of the protocol, so a test can run another claimant in between. */
  hook: (step: 'stale-inspected' | 'takeover') => void;
}

/** Outcome of {@link claimDevPidfile}. */
export type PidfileClaim =
  | {
      acquired: true;
      /** The stale record this start took over (a crashed predecessor, or our own `tsx watch` predecessor), if any. */
      previous: DevServerPidRecord | null;
    }
  | {
      acquired: false;
      reason: string;
      /** The port of the session that holds the app: the one `dev stop --port` stops. */
      port: number;
    };

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
    replace: (p, body) => {
      const tmp = `${p}.${process.pid}.tmp`;
      writeFileSync(tmp, body);
      renameSync(tmp, p);
    },
    remove: (p) => {
      try { unlinkSync(p); } catch { /* already gone */ }
    },
    siblings: (p) => {
      try {
        const prefix = `${basename(p)}.`;
        return readdirSync(dirname(p)).filter((name) => name.startsWith(prefix)).map((name) => join(dirname(p), name));
      } catch {
        return [];
      }
    },
    peers: (p) => {
      try {
        return readdirSync(dirname(p))
          .filter((name) => /^dev-server\.\d+\.pid$/.test(name) && name !== basename(p))
          .map((name) => join(dirname(p), name));
      } catch {
        return [];
      }
    },
    isAlive: (pid) => isPidAlive(pid),
    commandOf: (pid) => pidCommand(pid),
    sleep: (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms),
    hook: () => {},
  };
}

// ── Changing the pidfile: reap by token ─────────────────────────────────────
// Records. Every file of the protocol (the pidfile `P`, and the reap files next
// to it) holds one complete record `{pid, ppid, port, command, token, …}`; token
// is random and new for every record written. A file is created only by
// hard-linking a complete temp file (link(2) fails with EEXIST when the path
// exists, never replaces it, and a reader never sees half a record).
//
// A record is live while its process, or its `tsx watch` session, is (see
// recordLiveness), and a dead record stays dead: liveness checks the recorded
// command lines, so a reused pid does not revive it.
//
// Changing P from a record X that this process does not own, whether to remove
// a stale X or to replace X in place, happens only while holding
// `P.reap-<X.token>` (one holder per record: it is created by link). Holding it,
// the holder re-reads P and acts only if P still holds X. A reap file whose
// holder died is removed by the same rule, one level up. Nothing moves the
// pidfile aside, and a claimant that sees a live record never touches it.
//
// In place, P changes only from a live X to its rightful successor: the dev
// server that `X.starting`'s CLI started (adopt), or the `tsx watch` successor
// of X's exited dev server, whose watcher X names (reload). Both replace X with
// one rename onto P, under X's reap file, so P never goes missing, and an owner
// rewrites its own live record (the frontend group) the same way.
//
// Safety: take a live record X at P. Its owner removes it only after checking P
// holds its own record (releaseDevPidfile), under the same reap file. Any other
// process removes X only as a reaper of X, after it saw X dead, but X is live,
// and was at every moment before. It is replaced only by its successor, which
// holds X's reap file, so no reaper of X can act at the same time. While a
// holder of `P.reap-<X.token>` acts, P still holds X: X leaves P only through
// that holder (its owner and its successor both need the reap file, and the
// owner of a stale X is dead), and nothing else can appear at P while X is
// there (link fails). Hence a live record is never removed, and two live
// sessions never both own P.

/** How many times {@link claimDevPidfile} retries when other starts keep changing the pidfile under it. */
const CLAIM_ATTEMPTS = 40;
/** How long a claimant waits while another live process holds a record's reap file. */
const REAP_BACKOFF_MS = 25;
const MAX_REAP_DEPTH = 4;

/** The reap file of the record `inspected` at `path`: named by its token, or by a hash of a record without one. */
function reapPath(path: string, inspected: string): string {
  const token = parsePidRecord(inspected)?.token;
  const key =
    token !== undefined && /^[\w-]{1,64}$/.test(token)
      ? token
      : createHash('sha256').update(inspected).digest('hex').slice(0, 32);
  return `${path}.reap-${key}`;
}

/** The record of this process as the holder of a reap file: only its own process keeps it alive. */
function reaperRecord(): string {
  return JSON.stringify({ pid: process.pid, ppid: process.ppid, port: 0, command: pidCommand(process.pid), token: randomUUID() });
}

/** True when the holder of a reap file (`raw`) still runs: its own pid, with the command it had. */
function reaperAlive(raw: string, d: Pick<ClaimPidfileDeps, 'isAlive' | 'commandOf'>): boolean {
  const holder = parsePidRecord(raw);
  return holder !== null && d.isAlive(holder.pid) && (holder.command === undefined || d.commandOf(holder.pid) === holder.command);
}

/**
 * Run `action` while holding the reap file of the record `inspected` at `path`,
 * and only if `path` still holds it (see the protocol above). `changed`: the
 * record or its reap file changed meanwhile, so look again; `busy`: another live
 * process holds the reap file.
 */
function underRecordLock(
  d: ClaimPidfileDeps,
  path: string,
  inspected: string,
  action: () => void,
  depth = 0,
): 'done' | 'changed' | 'busy' {
  const lock = reapPath(path, inspected);
  if (!d.createExclusive(lock, reaperRecord())) {
    const other = d.read(lock);
    if (other === null) return 'changed'; // that holder finished
    if (reaperAlive(other, d)) return 'busy';
    if (depth < MAX_REAP_DEPTH) underRecordLock(d, lock, other, () => d.remove(lock), depth + 1);
    return 'changed';
  }
  try {
    d.hook('takeover');
    if (d.read(path) !== inspected) return 'changed';
    action();
    return 'done';
  } finally {
    d.remove(lock); // ours: nobody else removes it while we live
  }
}

/**
 * After taking the pidfile: remove the reap files of reapers that died, by the
 * same rule, and the temp files of processes that died.
 */
function removeOrphans(d: ClaimPidfileDeps, path: string): void {
  for (const file of d.siblings(path)) {
    const rest = file.slice(path.length + 1);
    if (rest.startsWith('reap-')) {
      const raw = d.read(file);
      if (raw !== null && !reaperAlive(raw, d)) underRecordLock(d, file, raw, () => d.remove(file));
      continue;
    }
    // `<path>.<pid>.tmp`, and `<path>.<pid>.gc` of the previous protocol: a link to a temp file is a separate name and stays.
    const pid = /^(\d+)\.(tmp|gc)$/.exec(rest)?.[1];
    if (pid !== undefined && !d.isAlive(Number(pid))) d.remove(file);
  }
}

/**
 * A live session of this app on another port: the first record in the app's
 * other pidfiles (see {@link ClaimPidfileDeps.peers}) whose process, or `tsx
 * watch` session, still runs (see {@link recordLiveness}). Two dev servers of
 * one app share its data directory (`.bb-data`), so a second one on another
 * port must not start either.
 */
function livePeer(d: ClaimPidfileDeps, path: string): DevServerPidRecord | null {
  for (const file of d.peers(path)) {
    const text = d.read(file);
    const record = text === null ? null : parsePidRecord(text);
    if (!record) continue;
    const live = recordLiveness(record, d.isAlive, d.commandOf);
    if (live.pidAlive || live.watcherAlive) return record;
  }
  return null;
}

/**
 * Take the per-port pidfile for `self`, so exactly one dev server runs in an
 * app, whatever its port, even when several start at the same moment.
 *
 * The pidfile is created exclusively, so of two simultaneous starts on one
 * port only one creates it. When it already exists, {@link evaluateSingleton}
 * decides: a live owner makes this start bow out; a stale (or unreadable)
 * record is taken over. A start that created its pidfile then looks at the
 * app's pidfiles for other ports, and bows out, removing its record, while one
 * of them is live: each start writes its own record before it reads the
 * others', so of two starts on two ports at least one sees the other.
 *
 * The record of our own `tsx watch` predecessor (same live watcher, exited
 * child) is replaced in place, so the pidfile exists throughout a reload and a
 * `dev stop` run at any moment of it finds the session. Only this start can
 * take that record over: any other start sees the live watcher and bows out,
 * and `tsx watch` runs one child at a time.
 *
 * Likewise the {@link DevServerPidRecord.starting} record of the `cdk-blocks dev`
 * CLI that started this dev server (`adopt`, its pid) is replaced in place: the
 * session it claimed is this one. Any other start sees the live CLI and bows out.
 * Neither looks at the other ports again: the session that claimed the app did.
 *
 * Any other stale (or unreadable) record is removed by the reap-by-token
 * protocol above, and the pidfile created afresh. In-place replacement and
 * removal both hold the record's reap file and act only while the pidfile still
 * holds that record, so a live record is never moved or removed, even briefly.
 */
export function claimDevPidfile(
  path: string,
  self: DevServerPidRecord,
  deps: Partial<ClaimPidfileDeps> = {},
  adopt?: number,
): PidfileClaim {
  const d = { ...defaultClaimDeps(), ...deps };
  const body = JSON.stringify(self);
  let previous: DevServerPidRecord | null = null;
  for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt++) {
    if (d.createExclusive(path, body)) {
      const peer = livePeer(d, path);
      if (peer) {
        underRecordLock(d, path, body, () => d.remove(path)); // ours, created just now
        const pid = recordLiveness(peer, d.isAlive, d.commandOf).pidAlive ? peer.pid : peer.ppid;
        const state = peer.starting ? 'starting' : 'running';
        return { acquired: false, reason: `a dev server of this app is already ${state} on :${peer.port} (pid ${pid})`, port: peer.port };
      }
      try { removeOrphans(d, path); } catch { /* best effort: the pidfile is ours either way */ }
      return { acquired: true, previous };
    }
    const text = d.read(path);
    if (text === null) continue; // removed since: create again
    const existing = parsePidRecord(text);
    const liveness = existing ? recordLiveness(existing, d.isAlive, d.commandOf) : null;
    const adopting = existing?.starting === true && adopt !== undefined && existing.pid === adopt;
    const reloading =
      existing !== null && liveness !== null && liveness.watcherAlive && !liveness.pidAlive &&
      existing.ppid === self.ppid && existing.pid !== self.pid;
    if (!adopting && !reloading) {
      const decision = existing && liveness ? evaluateSingleton(existing, self, liveness) : { action: 'proceed' as const };
      if (decision.action === 'exit') return { acquired: false, reason: decision.reason, port: existing?.port ?? self.port };
      d.hook('stale-inspected');
      previous = existing ?? previous;
    }
    // A live record goes to its successor in one step; a stale one is removed.
    const outcome = underRecordLock(d, path, text, () => (adopting || reloading ? d.replace(path, body) : d.remove(path)));
    if (outcome === 'done' && (adopting || reloading)) return { acquired: true, previous: existing };
    if (outcome === 'busy') d.sleep(REAP_BACKOFF_MS);
  }
  return { acquired: false, reason: `other dev servers kept starting on :${self.port}`, port: self.port };
}

/** The per-port pidfile path a dev server records its supervisor identity in. */
export function devPidfilePath(port: number): string {
  return join(BLOCKS_SANDBOX_DIR, `dev-server.${port}.pid`);
}

/** A running `cdk-blocks sandbox` session of an app: its process, and the port of its dev server. */
export interface SandboxSession {
  pid: number;
  port: number;
}

/**
 * The `cdk-blocks sandbox` session running in the app at `root`, if any: a live
 * dev-server record (see {@link recordLiveness}) whose `sandbox` process is
 * alive too. Its `cdk watch` deploys every change and writes the app's
 * `.blocks-sandbox/cdk.out`, so another sandbox deploy or destroy of the app
 * must not run beside it.
 */
export function liveSandboxSession(root: string, deps: Partial<ClaimPidfileDeps> = {}): SandboxSession | null {
  const d = { ...defaultClaimDeps(), ...deps };
  // Port 0 never has a pidfile: its peers are every dev-server pidfile of the app.
  for (const file of d.peers(join(root, devPidfilePath(0)))) {
    const text = d.read(file);
    const record = text === null ? null : parsePidRecord(text);
    if (!record?.sandbox || !d.isAlive(record.sandbox.pid)) continue;
    const live = recordLiveness(record, d.isAlive, d.commandOf);
    if (live.pidAlive || live.watcherAlive) return { pid: record.sandbox.pid, port: record.port };
  }
  return null;
}

/** A live dev session of an app: the process that holds it, its port, and whether it is still starting. */
export interface DevSession {
  pid: number;
  port: number;
  starting: boolean;
}

/**
 * The live dev session of the app at `root` on any port, if any: a
 * `cdk-blocks dev`, also one still starting, or a `cdk-blocks sandbox`'s dev
 * server (see {@link recordLiveness}). The app runs one dev server at a time,
 * so a command that would start one checks this before it does anything else.
 */
export function liveDevSession(root: string, deps: Partial<ClaimPidfileDeps> = {}): DevSession | null {
  const d = { ...defaultClaimDeps(), ...deps };
  // Port 0 never has a pidfile: its peers are every dev-server pidfile of the app.
  const record = livePeer(d, join(root, devPidfilePath(0)));
  if (!record) return null;
  const pid = recordLiveness(record, d.isAlive, d.commandOf).pidAlive ? record.pid : record.ppid;
  return { pid, port: record.port, starting: record.starting === true };
}

/**
 * Remove the pidfile at `path` if it still holds `owner`'s record, under that
 * record's reap file (see the protocol above), so a successor that is taking
 * the record over in place, or has, keeps its record.
 */
export function releaseDevPidfile(path: string, owner: number, deps: Partial<ClaimPidfileDeps> = {}): void {
  const d = { ...defaultClaimDeps(), ...deps };
  const raw = d.read(path);
  if (raw === null || parsePidRecord(raw)?.pid !== owner) return;
  underRecordLock(d, path, raw, () => d.remove(path));
}

/**
 * Remove the record `inspected` from `path`, which its reader saw dead (or
 * unreadable): never any other record (see the protocol above). For `dev stop`
 * and the dev server's hand-off watcher.
 */
export function reapDevPidfile(path: string, inspected: string, deps: Partial<ClaimPidfileDeps> = {}): void {
  const d = { ...defaultClaimDeps(), ...deps };
  for (let attempt = 0; attempt < CLAIM_ATTEMPTS && d.read(path) === inspected; attempt++) {
    if (underRecordLock(d, path, inspected, () => d.remove(path)) === 'busy') d.sleep(REAP_BACKOFF_MS);
  }
}

/**
 * The environment variable carrying the pid of the `cdk-blocks dev` CLI to the dev
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
  | {
      acquired: false;
      reason: string;
      /** The port of the dev server that already runs in the app, which may differ from the one asked for. */
      port: number;
    };

/**
 * Claim the dev session on `port` for this process, the `cdk-blocks dev` CLI of
 * the app at `root`, before it starts its dev server: write a
 * {@link DevServerPidRecord.starting} record with the same exclusive claim as
 * the dev server's. A `dev stop` from then on finds the session and SIGTERMs
 * the CLI, which stops what it started; until now, the pidfile appeared only
 * once the dev server had loaded, and a stop in between found nothing to stop.
 * The dev server, started with {@link DEV_SESSION_ENV} set to this pid, takes
 * the record over. A stale record's frontend group carries over, so the dev
 * server may still reclaim its port from that predecessor's frontend. The
 * `release` the CLI calls once its dev server has ended removes its own
 * record, and the dev server's if that died without removing it.
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
    token: randomUUID(),
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
  const release = (): void => {
    releaseDevPidfile(path, process.pid);
    // The dev server took the record over and may have died without removing
    // it (a backend that throws while it loads): the session is over once
    // this CLI releases it, so a record that nothing alive names goes too.
    const d = defaultClaimDeps();
    const raw = d.read(path);
    const record = raw === null ? null : parsePidRecord(raw);
    const live = record && recordLiveness(record, d.isAlive, d.commandOf);
    if (raw !== null && !(live && (live.pidAlive || live.watcherAlive))) reapDevPidfile(path, raw);
  };
  return { acquired: true, release };
}
