// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Cross-process exclusive lock for a Blocks config file's read-modify-write.
 *
 * Without it, two writers that each re-read, change their own key and rename a
 * new file into place can still lose an update: a `projectId` writer that read
 * before `blocks-telemetry --disable` wrote would rename its older copy over the
 * opt-out.
 *
 * ## Protocol
 *
 * The lock is the file `<config>.lock` (`P`). Its content is a *record*
 * `{ pid, start, host, token }`: the owner's pid, its process start time (so a
 * reused pid isn't mistaken for the owner), its hostname, and a random token
 * unique to this acquisition.
 *
 * - **Acquire:** write the record, complete, to a private temp file, then
 *   `link()` it to `P`. `link` fails with `EEXIST` when `P` exists, so creating
 *   `P` is exclusive and `P` is never visible half-written. (Not `open(wx)` and
 *   then write, which exposes an empty or partial lock.)
 * - **Contend:** when `P` exists and its owner is alive, wait and retry until the
 *   deadline. A live lock is never modified, renamed or removed by a contender.
 * - **Take over a stale lock:** when `P` holds a record `X` whose owner is dead,
 *   exclusively create `P.reap-<X.token>` (again by `link()`ing our own record).
 *   While holding it, re-read `P` and unlink it only if it still holds `X`; then
 *   release the reap file the same way. If the reap file already exists and its
 *   holder is alive, back off. If that holder is dead, reap the reap file by the
 *   same rule, at most {@link MAX_REAP_DEPTH} levels deep.
 * - **Release:** unlink `P` only if it still holds our exact record (also on
 *   process `exit`).
 *
 * ## Why a live record is never removed
 *
 * A record leaves its path in exactly two ways: (1) its owner unlinks it after
 * reading the path and seeing its own token, or (2) the holder of the path's
 * `reap-<token>` file unlinks it after seeing the owner dead and reading the path
 * and seeing that same token. Tokens are unique, so the reap file for a record is
 * held by at most one process at a time. Between "read the path, it's still `X`"
 * and "unlink it", nobody else can remove `X`: its owner is dead and the only
 * other remover is ourselves. So the unlink always removes `X`, never a newer
 * record. The same argument holds for the owner in (1), as nobody reaps a live
 * owner. Liveness errs only toward "alive": a record from another host, an
 * unreadable record, or an owner whose start time can't be read is never reaped.
 *
 * @internal
 * @module
 */

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { linkSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';

/** How many nested reap files a contender will clear before backing off. */
const MAX_REAP_DEPTH = 3;

interface LockRecord {
	pid: number;
	/** Process start time, or `null` where it can't be read (Windows: pid-only liveness). */
	start: string | null;
	host: string;
	token: string;
}

/** A lock this process holds. */
export interface HeldBlocksConfigLock {
	/** Remove the lock if it still holds this acquisition's record. Idempotent. */
	release(): void;
}

/** Thrown when the lock couldn't be taken before the deadline. */
export class BlocksConfigLockTimeoutError extends Error {
	constructor(lockPath: string, timeoutMs: number, holder: string) {
		super(
			`Timed out after ${timeoutMs} ms waiting for the lock ${lockPath} (${holder}). ` +
				`If no other Blocks command is running, delete that file and re-run.`,
		);
		this.name = 'BlocksConfigLockTimeoutError';
	}
}

const sleepCell = new Int32Array(new SharedArrayBuffer(4));

/** Block this thread for `ms` (the config writers are synchronous). */
function sleepSync(ms: number): void {
	Atomics.wait(sleepCell, 0, 0, ms);
}

/**
 * The start time of `pid` as an opaque string, or `null` when it can't be read.
 * Linux: `starttime` from `/proc/<pid>/stat` (clock ticks since boot). Windows:
 * `null`. Elsewhere: `ps -o lstart=` with a fixed locale and time zone, so every
 * process formats the same instant identically.
 */
function processStartTime(pid: number): string | null {
	try {
		if (process.platform === 'linux') {
			const stat = readFileSync(`/proc/${pid}/stat`, 'utf-8');
			// Fields after the parenthesised command name start at field 3; starttime is field 22.
			return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? null;
		}
		if (process.platform === 'win32') return null;
		const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
			encoding: 'utf-8',
			stdio: ['ignore', 'pipe', 'ignore'],
			env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
		}).trim();
		return out || null;
	} catch {
		return null;
	}
}

let ownStartTime: string | null | undefined;

/** Read a lock record; `missing` when the path doesn't exist, `unknown` when it isn't a record. */
function readRecord(path: string): LockRecord | 'missing' | 'unknown' {
	let text: string;
	try {
		text = readFileSync(path, 'utf-8');
	} catch (error: unknown) {
		return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unknown';
	}
	try {
		const value: unknown = JSON.parse(text);
		if (
			value &&
			typeof value === 'object' &&
			'pid' in value &&
			typeof value.pid === 'number' &&
			'start' in value &&
			(typeof value.start === 'string' || value.start === null) &&
			'host' in value &&
			typeof value.host === 'string' &&
			'token' in value &&
			typeof value.token === 'string'
		) {
			return { pid: value.pid, start: value.start, host: value.host, token: value.token };
		}
	} catch {
		// fall through
	}
	return 'unknown';
}

/** Describe a lock holder for an error message. */
function describeHolder(holder: LockRecord | 'missing' | 'unknown'): string {
	if (holder === 'missing') return 'released just now';
	if (holder === 'unknown') return 'its content is not a Blocks lock record';
	return `held by pid ${holder.pid} on ${holder.host}`;
}

/**
 * Whether the owner of `record` may still be running. Errs toward `true`: only a
 * same-host record whose pid is gone, or whose pid now belongs to a process with
 * a different start time, is dead.
 */
function isOwnerAlive(record: LockRecord, verified: Set<string>): boolean {
	if (record.host !== hostname()) return true;
	try {
		process.kill(record.pid, 0);
	} catch (error: unknown) {
		if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
		// EPERM: the process exists but belongs to another user.
	}
	if (record.start === null || verified.has(record.token)) return true;
	const start = processStartTime(record.pid);
	if (start !== null && start !== record.start) return false;
	verified.add(record.token);
	return true;
}

/** `link()` `from` to `to`; `false` when `to` already exists. */
function tryLink(from: string, to: string): boolean {
	try {
		linkSync(from, to);
		return true;
	} catch (error: unknown) {
		if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
		throw error;
	}
}

/** Unlink `path` only if it still holds the record with `token`. */
function unlinkIfRecord(path: string, token: string): boolean {
	const current = readRecord(path);
	if (current === 'missing' || current === 'unknown' || current.token !== token) return false;
	try {
		unlinkSync(path);
	} catch (error: unknown) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
	}
	return true;
}

/**
 * Remove the dead record `victim` from `path`, as the unique holder of
 * `<path>.reap-<victim.token>`. Returns whether `path` was cleared; `false` means
 * "retry from the top" (another reaper is at work, or the path changed).
 */
function reap(
	path: string,
	victim: LockRecord,
	own: LockRecord,
	ownRecordPath: string,
	verified: Set<string>,
	depth: number,
): boolean {
	const reapPath = `${path}.reap-${victim.token}`;
	if (!tryLink(ownRecordPath, reapPath)) {
		const reaper = readRecord(reapPath);
		if (reaper !== 'missing' && reaper !== 'unknown' && depth < MAX_REAP_DEPTH && !isOwnerAlive(reaper, verified)) {
			reap(reapPath, reaper, own, ownRecordPath, verified, depth + 1);
		}
		return false;
	}
	try {
		return unlinkIfRecord(path, victim.token);
	} finally {
		unlinkIfRecord(reapPath, own.token);
	}
}

/**
 * Take the exclusive lock `lockPath`, waiting up to `timeoutMs`. Its directory
 * must exist.
 *
 * @throws {BlocksConfigLockTimeoutError} when it can't be taken in time.
 * @throws when the file system refuses to create the lock (e.g. no hard links).
 */
export function acquireBlocksConfigLock(lockPath: string, timeoutMs: number): HeldBlocksConfigLock {
	if (ownStartTime === undefined) ownStartTime = processStartTime(process.pid);
	const own: LockRecord = {
		pid: process.pid,
		start: ownStartTime,
		host: hostname(),
		token: randomBytes(16).toString('hex'),
	};
	const ownRecordPath = `${lockPath}.${own.token}.tmp`;
	writeFileSync(ownRecordPath, JSON.stringify(own), { flag: 'wx' });
	const verified = new Set<string>();
	try {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			if (tryLink(ownRecordPath, lockPath)) {
				const release = (): void => {
					process.removeListener('exit', release);
					unlinkIfRecord(lockPath, own.token);
				};
				process.once('exit', release);
				return { release };
			}
			const holder = readRecord(lockPath);
			if (holder === 'missing') continue;
			if (holder !== 'unknown' && !isOwnerAlive(holder, verified)) {
				if (reap(lockPath, holder, own, ownRecordPath, verified, 0)) continue;
			}
			if (Date.now() >= deadline)
				throw new BlocksConfigLockTimeoutError(lockPath, timeoutMs, describeHolder(holder));
			sleepSync(5 + Math.floor(Math.random() * 20));
		}
	} finally {
		try {
			unlinkSync(ownRecordPath);
		} catch {
			// already gone
		}
	}
}
