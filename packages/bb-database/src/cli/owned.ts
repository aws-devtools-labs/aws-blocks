// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// `types` and `status` for a block whose cluster the block provisions (`--block <id>`). Such a block has no
// connection string: its schema is its migration files, and its local database is PGlite under
// `.cdk-blocks/local/data/`.

import { constants, cpSync, existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { LEGACY_MOCK_DATA_DIR, MOCK_DATA_DIR } from '@aws-cdk-blocks/core/bb-utils';
import { pgliteUnrefTimersExtension } from '../common/pglite-process.js';
import { DEFAULT_MIGRATIONS_ROOT } from '../constants.js';
import { RulesEngine } from '../dialect/rules-engine.js';
import { PGLITE_SUBDIR, sharedPgliteCluster } from '../engines/pglite-cluster.js';
import { MIGRATION_VALIDATION_ERROR_NAME } from '../errors.js';
import { prepareLocalSchema } from '../migrations/local.js';
import { ledgerStatus, listMigrationFiles } from '../migrations/runner.js';
import { defaultSchemaName } from '../runtime/construction.js';
import type { ClusterType } from '../types.js';
import type { StatusResult, TypesResult } from './commands.js';
import { isUsageError, usageError } from './io.js';
import { TYPES_FILE, writeTypes } from './types-file.js';

export interface BlockFlags {
	/** The id of the `Database` block, as in `new Database(scope, '<id>')`. */
	block: string;
	/** The id of the `DatabaseCluster` the block is on, when it does not own its cluster. */
	cluster?: string;
	type: ClusterType;
	schema?: string;
	dir?: string;
}

/** The schema the block's tables are in. An `aurora` cluster is always a `DatabaseCluster`, so it is shared. */
const schemaOf = (flags: BlockFlags): string =>
	flags.schema ?? defaultSchemaName(flags.block, flags.cluster !== undefined || flags.type === 'aurora');

function blockMigrationsDir(flags: BlockFlags): string {
	const given = flags.dir ?? join(DEFAULT_MIGRATIONS_ROOT, flags.block);
	const path = resolve(given);
	if (!existsSync(path)) {
		throw usageError(
			`The migrations directory ${given} of block '${flags.block}' does not exist. ` +
				'Pass the directory when the block has a `migrationsPath`.',
		);
	}
	return path;
}

/**
 * Writes the `Tables` interface of a block from its migration files. The files are applied to a new local
 * database in a temporary directory, by the code `npm run dev` runs them with, so the result does not depend on
 * the state of `.cdk-blocks/local/data/` and a running dev server is not touched.
 */
export async function blockTypes(flags: BlockFlags & { out?: string }): Promise<TypesResult> {
	const dir = blockMigrationsDir(flags);
	const schemaName = schemaOf(flags);
	const scratch = mkdtempSync(join(tmpdir(), 'bb-database-types-'));
	const cluster = sharedPgliteCluster(join(scratch, PGLITE_SUBDIR), flags.type);
	try {
		const inner = cluster.forSchema(schemaName);
		const engine = new RulesEngine(inner, flags.type);
		await prepareLocalSchema(engine, inner, { kind: flags.type, schemaName, migrationsPath: dir, log: () => {} });
		return { ok: true, ...(await writeTypes(engine, schemaName, flags.out ?? TYPES_FILE)) };
	} catch (e) {
		if (e instanceof Error && e.name === MIGRATION_VALIDATION_ERROR_NAME && flags.type === 'dsql') {
			e.message += '\nFor a block on an aurora cluster, pass --type aurora.';
		}
		throw e;
	} finally {
		await cluster.destroy().catch(() => {});
		rmSync(scratch, { recursive: true, force: true });
	}
}

/**
 * The block or cluster database directory under `.cdk-blocks/local/data/`, falling back to `.bb-data/`: the
 * id, after the ids of its scopes.
 */
function localDataDir(owner: string): string | undefined {
	// Reads only, so it also looks in the pre-consolidation directory: the carry-over runs when the BLOCK
	// first opens its store, and `npm run db -- status` and `-- types` are usually what an upgrading project runs
	// before that. Reporting "no local database" for one that is plainly there would be wrong.
	for (const relative of [MOCK_DATA_DIR, LEGACY_MOCK_DATA_DIR]) {
		const found = localDataDirUnder(resolve(relative), owner);
		if (found !== undefined) return found;
	}
	return undefined;
}

/** The same search within one data root, or `undefined` when that root holds no database of `owner`. */
function localDataDirUnder(root: string, owner: string): string | undefined {
	if (!existsSync(root)) return undefined;
	const hasDatabase = (name: string) => existsSync(join(root, name, PGLITE_SUBDIR, 'PG_VERSION'));
	if (hasDatabase(owner)) return join(root, owner, PGLITE_SUBDIR);
	const matches = readdirSync(root).filter((name) => name.endsWith(`-${owner}`) && hasDatabase(name));
	if (matches.length > 1) {
		throw usageError(
			`More than one local database matches '${owner}': ${matches.join(', ')}. Pass one of these names in full.`,
		);
	}
	return matches.length === 1 ? join(root, matches[0], PGLITE_SUBDIR) : undefined;
}

/**
 * Lists the applied and the pending files of a block in its local database. It reads a copy of the PGlite
 * directory: PGlite takes one process, and opening the directory of a running dev server would damage it.
 */
export async function blockStatus(flags: BlockFlags): Promise<StatusResult> {
	const files = listMigrationFiles(blockMigrationsDir(flags));
	const live = localDataDir(flags.cluster ?? flags.block);
	if (!live) {
		return {
			ok: true,
			applied: [],
			pending: files,
			note:
				`No local database of '${flags.cluster ?? flags.block}' is under .cdk-blocks/local/data/. The block creates it, and applies ` +
				'the files, at its first statement. For a block on a DatabaseCluster, pass --cluster <id>.',
		};
	}
	const inUse = existsSync(join(live, 'postmaster.pid'));
	const scratch = mkdtempSync(join(tmpdir(), 'bb-database-status-'));
	const copy = join(scratch, PGLITE_SUBDIR);
	try {
		// A clone where the file system has one (APFS, btrfs, XFS); a plain copy elsewhere.
		cpSync(live, copy, { recursive: true, mode: constants.COPYFILE_FICLONE });
		rmSync(join(copy, 'postmaster.pid'), { force: true });
		const db = new PGlite(copy, { extensions: { awsBlocksUnrefTimers: pgliteUnrefTimersExtension } });
		try {
			const query = async <T>(sql: string, params?: unknown[]) => (await db.query<T>(sql, params)).rows;
			return {
				ok: true,
				...(await ledgerStatus(query, schemaOf(flags), files)),
				...(inUse
					? { note: 'A process has the local database open. The lists show what it had written to disk.' }
					: {}),
			};
		} finally {
			await db.close();
		}
	} catch (e) {
		if (inUse && !isUsageError(e)) {
			throw usageError(
				'The local database is in use and its files could not be read. Stop `npm run dev`, then run the command again.',
			);
		}
		throw e;
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}
