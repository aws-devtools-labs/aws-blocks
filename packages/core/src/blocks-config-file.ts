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
 * - the file is re-read immediately before writing and only the caller's keys change;
 * - the new content is written to a temp file in the same directory and renamed over
 *   the original, so a concurrent reader sees the old or the new file, never a
 *   truncated one.
 *
 * A UTF-8 BOM (which some Windows editors add) is stripped before parsing.
 *
 * @internal
 * @module
 */

import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

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
 * Apply `mutate` to the current content of a Blocks config file and write it back
 * atomically. A missing file (and its directory) is created from `{}`.
 *
 * `mutate` edits the object in place and returns whether to write it; `false` skips
 * the write (e.g. the value it would add is already there).
 *
 * @throws when the existing file can't be parsed (the file is left unchanged), or
 *   when the write itself fails.
 */
export function updateBlocksConfigFile(path: string, mutate: (config: BlocksConfigObject) => boolean): void {
	const current = readBlocksConfigFile(path);
	if (current.status === 'invalid') {
		throw new Error(
			`${path} could not be read: ${current.reason}. It was left unchanged; fix or remove it and re-run.`,
		);
	}
	const config = current.status === 'ok' ? current.config : {};
	if (!mutate(config)) return;

	mkdirSync(dirname(path), { recursive: true });
	const tempPath = `${path}.${process.pid}-${randomBytes(4).toString('hex')}.tmp`;
	try {
		writeFileSync(tempPath, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
		renameSync(tempPath, path);
	} catch (error: unknown) {
		rmSync(tempPath, { force: true });
		throw error;
	}
}
