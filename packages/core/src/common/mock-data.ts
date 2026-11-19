// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from 'node:crypto';
import type { Stats } from 'node:fs';
import {
	copyFileSync,
	existsSync,
	linkSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type { Scope } from './index.js';

/** Building Block mock-data path relative to the project root. */
export const MOCK_DATA_DIR = join('.cdk-blocks', 'local', 'data');

/**
 * Legacy mock-data path; source entries are copied per unit without modifying
 * this directory.
 */
export const LEGACY_MOCK_DATA_DIR = '.bb-data';

/**
 * A mock-data directory could not be created, or existing data could not be
 * carried over. Thrown rather than swallowed: silence here hands the caller an
 * empty store that looks like a fresh project, and the block then writes a
 * second copy of state the project already had.
 */
export class MockDataDirError extends Error {
	// Without this the class is invisible where it is reported: `err.name` is
	// `Error`, so a log line reads `Error: Cannot create ...`. Deliberately not
	// branded via `brandBlocksError`, because the message carries absolute local
	// paths that must not reach a client.
	override name = 'MockDataDirError';
}

/**
 * Options for {@link getMockDataDir}.
 */
export interface MockDataDirOptions {
	/**
	 * When true, returns the root `.cdk-blocks/local/data/` directory without appending
	 * the scope's fullId. Use this to consolidate all data from a single resource
	 * type into a single file or folder. E.g., `settings.json`.
	 */
	root?: boolean;
}

/** Writes a nested ignore rule so local data stays ignored if root rules change; `git clean -fdX` can still remove it. */
function markLocalIgnored(): void {
	const localDir = join(process.cwd(), '.cdk-blocks', 'local');
	const marker = join(localDir, '.gitignore');
	if (existsSync(marker)) return;
	try {
		mkdirSync(localDir, { recursive: true });
		writeFileSync(marker, '*\n');
	} catch (error) {
		throw new MockDataDirError(`Cannot write ${marker}: ${(error as Error).message}`);
	}
}

/** Every entry directly inside `dir`, or `[]` when it does not exist. */
function entries(dir: string): string[] {
	try {
		return existsSync(dir) ? readdirSync(dir) : [];
	} catch (error) {
		throw new MockDataDirError(`Cannot read ${dir}: ${(error as Error).message}`);
	}
}

/**
 * Copy `source` to `target` through a staging name, so an interrupted copy
 * leaves no partial file. A partial file at the final path would be treated as
 * the migrated copy by the next run, which skips any entry that already exists.
 */
function copyFileAtomically(source: string, target: string): void {
	const staged = `${target}.${randomUUID()}.tmp`;
	try {
		copyFileSync(source, staged);
		// `linkSync` REFUSES an existing target (EEXIST) where `renameSync` would
		// replace it, so "never overwrite" no longer rests on the caller's earlier
		// `existsSync`. That window is reachable: a second dev process, `npm run
		// secret`, or a parallel test worker can write the real value in it, and
		// the legacy copy would clobber that write.
		try {
			linkSync(staged, target);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
		}
	} finally {
		try {
			unlinkSync(staged);
		} catch {}
	}
}

/** Copy `from` onto `to` recursively, never replacing an entry that exists. */
function copyWithoutOverwriting(from: string, to: string): void {
	if (!existsSync(to)) mkdirSync(to, { recursive: true });
	for (const name of entries(from)) {
		const source = join(from, name);
		const target = join(to, name);
		// `lstatSync`, not `statSync`: a dangling symlink in `.bb-data/<fullId>/`
		// would otherwise throw ENOENT and stop the block from starting, and a
		// symlink to a parent directory would recurse until ELOOP. Anything that is
		// neither a regular file nor a real directory is skipped — the rule the
		// root path already follows.
		let stats: Stats;
		try {
			stats = lstatSync(source);
		} catch {
			continue;
		}
		if (stats.isDirectory()) {
			copyWithoutOverwriting(source, target);
		} else if (stats.isFile() && !existsSync(target)) {
			copyFileAtomically(source, target);
		}
	}
}

/**
 * Records which units the carry-over has already completed, so it runs once per
 * unit instead of on every `getMockDataDir` call.
 *
 * Without it the carry-over resurrects deleted data: it copies any legacy entry
 * whose destination is missing, and a delete is exactly a missing destination.
 * A `FileBucket` object unlinked by `delete()` came back on the next call, and
 * every PGlite open copied back the relation files, recycled WAL segments and
 * truncated `pg_xact` segments Postgres had removed since.
 *
 * The ledger lives in `.cdk-blocks/local/`, a level above `data/`, because a
 * block owns its unit directory and enumerates it — `FileBucket.scan()` would
 * list a marker written inside it as if it were an object.
 *
 * It is written only after a unit's copy finishes, so an interrupted copy is
 * retried rather than recorded.
 */
function markerDir(): string {
	return join(process.cwd(), MOCK_DATA_DIR, '..', '.carried-over.d');
}

/** One marker name per unit. `root: true` files are namespaced so a block cannot collide with them. */
function markerPath(name: string, rootFile: boolean): string {
	const safe = (rootFile ? `file.${name}` : `unit.${name}`).replace(/[^\w.@-]/g, '_');
	return join(markerDir(), safe);
}

function isCarried(name: string, rootFile: boolean): boolean {
	return existsSync(markerPath(name, rootFile));
}

/**
 * Records one unit as carried, by CREATING its own marker file.
 *
 * One file per unit rather than one shared list: a shared list is a
 * read-modify-write, so concurrent first uses overwrite each other's entries and
 * an unrecorded unit is carried again later, restoring data deleted in the new
 * location. With `wx` the create is exclusive and nothing is read first, so
 * sixteen processes starting together record sixteen units.
 */
function markCarried(name: string, rootFile: boolean): void {
	try {
		mkdirSync(markerDir(), { recursive: true });
		writeFileSync(markerPath(name, rootFile), '', { flag: 'wx' });
	} catch {
		// Already marked by a concurrent call is success. Any other failure costs a
		// repeated copy, which is correct but slower, and must never fail the call
		// that only wanted its data directory.
	}
}

/**
 * Carry a project's pre-consolidation data over, once, for the unit being asked
 * for rather than for the whole tree.
 *
 * Per unit, not per directory: `root: true` puts files such as `settings.json`
 * directly in the data root beside the per-block subdirectories, so a single
 * "has this project been migrated?" flag on the root would skip every block
 * whose data had not been touched yet.
 *
 * The new location always wins. An entry that already exists there is never
 * replaced, because the legacy copy stops being written the moment this version
 * runs and is stale from then on.
 */
function carryOverLegacyData(scope: Scope | undefined, target: string, root: boolean): void {
	const legacyRoot = join(process.cwd(), LEGACY_MOCK_DATA_DIR);
	if (!existsSync(legacyRoot)) return;

	if (root) {
		// Only the files of the legacy root. Its subdirectories are per-block
		// units, carried over by that block's own call, so copying them here would
		// migrate blocks that may never run.
		for (const name of entries(legacyRoot)) {
			// Already carried once: a file deleted since must stay deleted.
			if (isCarried(name, true)) continue;
			const source = join(legacyRoot, name);
			const destination = join(target, name);
			// An entry that cannot be stat'ed (a dangling symlink, or a mode that
			// denies it) is skipped rather than aborting the rest: one piece of
			// debris in the legacy directory must not stop a project reaching its own
			// data.
			let isDirectory: boolean;
			try {
				isDirectory = statSync(source).isDirectory();
			} catch {
				continue;
			}
			if (isDirectory) continue;
			if (!existsSync(destination)) copyFileAtomically(source, destination);
			markCarried(name, true);
		}
		return;
	}

	const unit = scope?.fullId ?? '';
	// Already carried once: data deleted since must stay deleted.
	if (isCarried(unit, false)) return;

	const legacyDir = join(legacyRoot, unit);
	if (existsSync(legacyDir)) copyWithoutOverwriting(legacyDir, target);
	// Recorded only now, so an interrupted copy is retried on the next call.
	markCarried(unit, false);
}

/**
 * Returns the mock data directory for a Building Block instance, creating it
 * if it doesn't already exist.
 *
 * Resolves to `<cwd>/.cdk-blocks/local/data/{scope.fullId}/` by default. The BB owns
 * this folder and can store whatever files it needs inside it.
 *
 * If `root: true` are specified, returns `<cwd>/.cdk-blocks/local/data/`. The BB must
 * then take responsibility not to conflict with other files and folders.
 *
 * A project that still has data under the pre-consolidation `.bb-data/` keeps
 * it: the first call for a given unit copies that unit across, and never
 * replaces anything already in the new location. The legacy directory is left
 * in place rather than moved, so an older CLI in the same checkout still reads
 * it.
 *
 * @param scope - The Building Block's Scope instance.
 * @param options - Optional configuration.
 * @returns Absolute path to the BB's data directory (guaranteed to exist).
 * @throws {@link MockDataDirError} when the directory cannot be created or the
 * carry-over fails — for example in a read-only project directory, which would
 * otherwise look like a project with no data.
 *
 * @example
 * ```typescript
 * const dir = getMockDataDir(this);
 * const filePath = join(dir, 'store.json');
 * ```
 *
 * @example Root directory for shared files
 * ```typescript
 * const dir = getMockDataDir(this, { root: true });
 * const settingsPath = join(dir, 'settings.json');
 * ```
 */
export function getMockDataDir(scope: Scope, options?: MockDataDirOptions): string {
	const root = options?.root === true;
	const segments = [process.cwd(), MOCK_DATA_DIR];
	if (!root) segments.push(scope.fullId);
	const dir = join(...segments);

	try {
		markLocalIgnored();
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	} catch (error) {
		throw new MockDataDirError(`Cannot create the mock data directory ${dir}: ${(error as Error).message}`);
	}

	// Called on every call, but the per-unit marker returns immediately for a unit already
	// carried, so the copy itself runs once per unit. Gating the CALL on "did I
	// just create this directory" would not work: a per-block call creates the data
	// root as a side effect of `recursive: true`, which marked the root migrated
	// and skipped every shared file.
	try {
		carryOverLegacyData(scope, dir, root);
	} catch (error) {
		if (error instanceof MockDataDirError) throw error;
		throw new MockDataDirError(`Cannot carry ${LEGACY_MOCK_DATA_DIR} over to ${dir}: ${(error as Error).message}`);
	}
	return dir;
}
