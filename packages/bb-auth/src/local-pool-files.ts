// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Finding local (mock) user pools on disk from outside the process that runs
 * them: the `testing` helpers and the `bb-auth users` CLI. A local pool is
 * `.bb-data/<fullId>/state.json` (see `engines/native-mock-store.ts` for the
 * format); this module only reads it and recognises it by shape, so it
 * depends on neither the scope nor the block name.
 *
 * Node only. Never imported by a runtime entry.
 *
 * @internal
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** One local `Auth` block's data directory. */
export interface LocalPoolDir {
	/** The block's full id: the directory name. */
	fullId: string;
	dir: string;
	stateFile: string;
}

/** The parts of `state.json` these readers use. Every other key is kept as is by a writer. */
export interface LocalPoolState {
	users: Record<string, unknown>;
	groups: Record<string, unknown>;
	codes?: unknown;
	[key: string]: unknown;
}

export function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function readJson(file: string): unknown {
	try {
		return JSON.parse(readFileSync(file, 'utf8'));
	} catch {
		return undefined;
	}
}

/** Whether `state` has the shape of a local user pool's `state.json`. */
export function isLocalPoolState(state: unknown): state is LocalPoolState {
	return isRecord(state) && isRecord(state.users) && isRecord(state.groups);
}

/** The `.bb-data` directory under `cwd`. */
export function dataDirOf(cwd: string): string {
	return join(resolve(cwd), '.bb-data');
}

/** The local user pools under `dataDir`, sorted by full id. */
export function listLocalPools(dataDir: string): LocalPoolDir[] {
	let entries: string[];
	try {
		entries = readdirSync(dataDir);
	} catch {
		return [];
	}
	return entries
		.map((fullId) => {
			const dir = join(dataDir, fullId);
			return { fullId, dir, stateFile: join(dir, 'state.json') };
		})
		.filter((p) => isLocalPoolState(readJson(p.stateFile)))
		.sort((a, b) => a.fullId.localeCompare(b.fullId));
}

/**
 * The entries `block` names: the one whose full id is `block`, if any;
 * otherwise those whose full id ends with `-<block>` (the block's id, or its
 * id with some of its parent scopes). `block` undefined selects them all.
 */
export function selectBlocks<T extends { fullId: string }>(entries: readonly T[], block: string | undefined): T[] {
	if (block === undefined) return [...entries];
	const exact = entries.filter((e) => e.fullId === block);
	if (exact.length > 0) return exact;
	return entries.filter((e) => e.fullId.endsWith(`-${block}`));
}
