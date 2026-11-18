// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// `types` and `status` for a block whose cluster the block provisions (`--block <id>`). Such a block has no
// connection string: its schema is its migration files, and its local database is PGlite under `.bb-data/`.

import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pgliteUnrefTimersExtension } from '../common/pglite-process.js';
import { DEFAULT_MIGRATIONS_ROOT, DEFAULT_SCHEMA, quoteIdent, sanitizeSchemaName } from '../constants.js';
import { MIGRATION_VALIDATION_ERROR_NAME } from '../errors.js';
import { loadMigrationFiles } from '../migrations/runner.js';
import { internalAccess } from '../runtime/internal.js';
import type { ClusterType } from '../types.js';
import { isUsageError, usageError } from './io.js';
import { generateTypes } from './types-file.js';

export interface BlockFlags {
	/** The id of the `Database` block, as in `new Database(scope, '<id>')`. */
	block: string;
	/** The id of the `DatabaseCluster` the block is on, when it does not own its cluster. */
	cluster?: string;
	type: ClusterType;
	schema?: string;
	dir?: string;
}

/** A block shares a cluster when it names one; an `aurora` cluster is always a `DatabaseCluster`. */
const onSharedCluster = (flags: BlockFlags): boolean => flags.cluster !== undefined || flags.type === 'aurora';

/** The schema the block's tables are in, by the rule the block itself uses. */
const schemaOf = (flags: BlockFlags): string =>
	flags.schema ?? (onSharedCluster(flags) ? sanitizeSchemaName(flags.block) : DEFAULT_SCHEMA);

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
 * the state of `.bb-data/` and a running dev server is not touched.
 */
export async function blockTypes(
	flags: BlockFlags & { out: string },
): Promise<{ ok: true; out: string; tables: string[] }> {
	const dir = blockMigrationsDir(flags);
	const out = resolve(flags.out);
	const project = process.cwd();
	const scratch = mkdtempSync(join(tmpdir(), 'bb-database-types-'));
	// The local entry point, loaded here: an existing database never needs PGlite.
	const { Database, DatabaseCluster } = await import('../index.mock.js');
	const { _closeAllPgliteClusters } = await import('../engines/pglite-cluster.js');
	const { Scope } = await import('@aws-blocks/core');
	// A local block keeps its data under the working directory.
	process.chdir(scratch);
	try {
		const scope = new Scope('types');
		const options = { migrationsPath: dir, ...(flags.schema === undefined ? {} : { schemaName: flags.schema }) };
		const db = onSharedCluster(flags)
			? new Database(scope, flags.block, {
					...options,
					cluster: new DatabaseCluster(
						scope,
						flags.cluster ?? 'cluster',
						flags.type === 'aurora' ? { type: 'aurora' } : { type: 'dsql' },
					),
				})
			: new Database(scope, flags.block, options);
		// The first use of the engine applies the files, as the first statement of a request does. The block's
		// own line about it names the temporary database, which is of no use here.
		const log = console.log;
		console.log = () => {};
		const engine = await internalAccess(db, 'cdk-blocks db types')
			.engine()
			.finally(() => {
				console.log = log;
			});
		const file = await generateTypes(engine, db.schemaName);
		mkdirSync(dirname(out), { recursive: true });
		writeFileSync(out, file.text);
		return { ok: true, out: flags.out, tables: file.tables };
	} catch (e) {
		if (e instanceof Error && e.name === MIGRATION_VALIDATION_ERROR_NAME && flags.type === 'dsql') {
			e.message += '\nFor a block on an aurora cluster, pass --type aurora.';
		}
		throw e;
	} finally {
		await _closeAllPgliteClusters();
		process.chdir(project);
		rmSync(scratch, { recursive: true, force: true });
	}
}

export interface BlockStatus {
	ok: true;
	applied: string[];
	pending: string[];
	/** Why the lists may differ from what a running dev server has. */
	note?: string;
}

/** The directory under `.bb-data/` of the block, or of its cluster: the id, after the ids of its scopes. */
function localDataDir(owner: string): string | undefined {
	const root = resolve('.bb-data');
	if (!existsSync(root)) return undefined;
	const hasDatabase = (name: string) => existsSync(join(root, name, 'pglite', 'PG_VERSION'));
	if (hasDatabase(owner)) return join(root, owner, 'pglite');
	const matches = readdirSync(root).filter((name) => name.endsWith(`-${owner}`) && hasDatabase(name));
	if (matches.length > 1) {
		throw usageError(
			`More than one local database matches '${owner}': ${matches.join(', ')}. Pass one of these names in full.`,
		);
	}
	return matches.length === 1 ? join(root, matches[0], 'pglite') : undefined;
}

/**
 * Lists the applied and the pending files of a block in its local database. It reads a copy of the PGlite
 * directory: PGlite takes one process, and opening the directory of a running dev server would damage it.
 */
export async function blockStatus(flags: BlockFlags): Promise<BlockStatus> {
	const files = Object.keys(loadMigrationFiles(blockMigrationsDir(flags))).sort();
	const live = localDataDir(flags.cluster ?? flags.block);
	if (!live) {
		return {
			ok: true,
			applied: [],
			pending: files,
			note:
				`No local database of '${flags.cluster ?? flags.block}' is under .bb-data/. The block creates it, and applies ` +
				'the files, at its first statement. For a block on a DatabaseCluster, pass --cluster <id>.',
		};
	}
	const inUse = existsSync(join(live, 'postmaster.pid'));
	const scratch = mkdtempSync(join(tmpdir(), 'bb-database-status-'));
	const copy = join(scratch, 'pglite');
	try {
		cpSync(live, copy, { recursive: true });
		rmSync(join(copy, 'postmaster.pid'), { force: true });
		const { PGlite } = await import('@electric-sql/pglite');
		const db = new PGlite(copy, { extensions: { awsBlocksUnrefTimers: pgliteUnrefTimersExtension } });
		try {
			const ledger = `${quoteIdent(schemaOf(flags))}.${quoteIdent('_migrations')}`;
			const present = await db.query<{ present: boolean }>('SELECT to_regclass($1) IS NOT NULL AS present', [
				ledger,
			]);
			const names = present.rows[0]?.present
				? (await db.query<{ name: string }>(`SELECT name FROM ${ledger}`)).rows.map((row) => row.name)
				: [];
			return {
				ok: true,
				applied: files.filter((file) => names.includes(file)),
				pending: files.filter((file) => !names.includes(file)),
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
