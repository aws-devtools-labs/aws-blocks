// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The one reader/writer for Blocks config files (`.blocks/config.json` and
 * `~/.blocks/config.json`).
 *
 * The project file holds the committed `stackId` (which names the stack and scopes
 * the app's secret/config namespace) next to the telemetry keys, so every writer
 * goes through {@link updateBlocksConfigFile}:
 * - a file that can't be parsed is never rewritten — it might hold a `stackId` the
 *   writer can't see;
 * - the whole read-modify-write runs under an exclusive cross-process lock
 *   (`<config>.lock`, see `./blocks-config-lock.ts`), so concurrent writers of
 *   different keys (a `projectId` and `telemetry.enabled`) can't undo each other;
 * - the file is re-read under the lock and only the caller's keys change;
 * - the new content is written to a temp file in the same directory and renamed over
 *   the original, so a lock-free reader sees the old or the new file, never a
 *   truncated one.
 *
 * A UTF-8 BOM (which some Windows editors add) is stripped before parsing.
 *
 * @internal
 * @module
 */

import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { acquireBlocksConfigLock } from './blocks-config-lock.js';

/** A parsed Blocks config file: always a plain JSON object. */
export type BlocksConfigObject = Record<string, unknown>;

/** Result of {@link readBlocksConfigFile}. */
export type BlocksConfigRead =
	| { status: 'missing' }
	| { status: 'ok'; config: BlocksConfigObject }
	| { status: 'invalid'; reason: string };

/**
 * Read and parse a Blocks config file. Never throws: a file that doesn't exist is
 * `missing`; one that can't be read, isn't valid JSON, or isn't a JSON object is
 * `invalid` with a human-readable `reason`.
 */
export function readBlocksConfigFile(path: string): BlocksConfigRead {
	let text: string;
	try {
		text = readFileSync(path, 'utf-8');
	} catch (error: unknown) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing' };
		return { status: 'invalid', reason: error instanceof Error ? error.message : String(error) };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
	} catch (error: unknown) {
		return {
			status: 'invalid',
			reason: `invalid JSON (${error instanceof Error ? error.message : String(error)})`,
		};
	}
	if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
		return { status: 'invalid', reason: 'the top-level value is not a JSON object' };
	}
	return { status: 'ok', config: parsed as BlocksConfigObject };
}

/**
 * Test-only hooks, enabled by `BLOCKS_TEST_CONFIG_LOCK_HOOKS=<dir>`, run while the
 * lock is held. `read`: if `<dir>/pause` exists, create `<dir>/paused-<pid>` and
 * wait (at most 30 s) until `pause` is removed. `written`: append the written
 * `telemetry` object as one JSON line to `<dir>/log`, in lock (= commit) order.
 */
function runTestHook(stage: 'read' | 'written', config: BlocksConfigObject): void {
	const dir = process.env.BLOCKS_TEST_CONFIG_LOCK_HOOKS;
	if (!dir) return;
	if (stage === 'written') {
		appendFileSync(join(dir, 'log'), `${JSON.stringify({ pid: process.pid, telemetry: config.telemetry })}\n`);
		return;
	}
	const pause = join(dir, 'pause');
	if (!existsSync(pause)) return;
	writeFileSync(join(dir, `paused-${process.pid}`), '');
	const cell = new Int32Array(new SharedArrayBuffer(4));
	for (const deadline = Date.now() + 30_000; existsSync(pause) && Date.now() < deadline; )
		Atomics.wait(cell, 0, 0, 10);
}

/**
 * Apply `mutate` to the current content of a Blocks config file and write it back
 * atomically. A missing file (and its directory) is created from `{}`.
 *
 * The read, `mutate` and write run under the exclusive lock `<path>.lock`, waited
 * for at most `options.lockTimeoutMs`.
 *
 * `mutate` edits the object in place and returns whether to write it; `false` skips
 * the write (e.g. the value it would add is already there).
 *
 * @throws when the existing file can't be parsed (the file is left unchanged), when
 *   the lock can't be taken in time (`BlocksConfigLockTimeoutError`; nothing is
 *   written), or when the write itself fails.
 */
export function updateBlocksConfigFile(
	path: string,
	mutate: (config: BlocksConfigObject) => boolean,
	options: { lockTimeoutMs: number },
): void {
	mkdirSync(dirname(path), { recursive: true });
	const lock = acquireBlocksConfigLock(`${path}.lock`, options.lockTimeoutMs);
	try {
		const current = readBlocksConfigFile(path);
		if (current.status === 'invalid') {
			throw new Error(
				`${path} could not be read: ${current.reason}. It was left unchanged; fix or remove it and re-run.`,
			);
		}
		const config = current.status === 'ok' ? current.config : {};
		runTestHook('read', config);
		if (!mutate(config)) return;

		const tempPath = `${path}.${process.pid}-${randomBytes(4).toString('hex')}.tmp`;
		try {
			writeFileSync(tempPath, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
			renameSync(tempPath, path);
		} catch (error: unknown) {
			rmSync(tempPath, { force: true });
			throw error;
		}
		runTestHook('written', config);
	} finally {
		lock.release();
	}
}
