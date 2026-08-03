// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Derives TypeScript types from SQL migrations, with no command for the developer
 * to remember and no artifact to keep fresh by hand.
 *
 * The migrations are the single source of truth. This applies them to a throwaway
 * PGlite database, introspects the result, and writes the row types plus the runtime
 * table metadata. Save a `.sql` file and the types follow.
 *
 * Two reasons it builds a throwaway database rather than reading the dev one:
 *
 * 1. **No lock contention.** PGlite is single-writer per data directory, so
 *    introspecting the running dev server's database would fight it for the lock.
 * 2. **Correctness.** Types then describe what the migrations produce, not whatever
 *    state a long-lived dev database has drifted into.
 *
 * @module
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMigrationsFromDir, runMigrations } from '@aws-blocks/data-common';
import { generateMetaFile, generateTypesFile, parseExistingMetaSingulars } from './db-pull/generate.js';
import { introspectEngine } from './db-pull/introspect.js';
import { pgTypeToTs } from './db-pull/naming.js';
import { PGliteEngine } from './engines/pglite-engine.js';

const TYPES_FILE = 'database.types.ts';
const META_FILE = 'database.meta.ts';

const TYPES_HEADER = '// Generated from ./migrations — do not edit. Regenerated on migration change.\n\n';
const META_HEADER_PREFIX =
	'// Generated from ./migrations — do not edit. Regenerated on migration change.\nimport type { ';

/**
 * Postgres→TypeScript mapping for generated row types.
 *
 * Delegates to the shared `db pull` mapping except for temporal columns. Both `pg`
 * and PGlite hydrate `timestamptz`/`timestamp`/`date` into `Date` instances, but the
 * shared mapping declares them `string` — so a generated type would claim `string`
 * for a value that is a `Date` at runtime. These types are the whole point of this
 * module, so they have to be true.
 *
 * Time-of-day is mapped to `string` because it has no date part and the drivers return
 * it as a string. The shared mapping only lists the bare alias `time`, but
 * `information_schema` reports `time without time zone`, so the shared map yields
 * `unknown` for a plain `TIME` column.
 */
const TEMPORAL_TS_TYPES: Record<string, string> = {
	'timestamp without time zone': 'Date',
	'timestamp with time zone': 'Date',
	timestamp: 'Date',
	timestamptz: 'Date',
	date: 'Date',
	'time without time zone': 'string',
	'time with time zone': 'string',
};

function mapType(pgType: string): string {
	return TEMPORAL_TS_TYPES[pgType.toLowerCase()] ?? pgTypeToTs(pgType);
}

/** Options for {@link syncSchema}. */
export interface SyncSchemaOptions {
	/** Directory of ordered `.sql` migrations — the source of truth. */
	migrationsPath: string;
	/** Directory to write `database.types.ts` and `database.meta.ts` into. */
	outDir: string;
}

/** Result of {@link syncSchema}. */
export interface SyncSchemaResult {
	/** Files whose contents actually changed. Empty when the schema was unchanged. */
	written: string[];
	/** Table names discovered, in introspection order. */
	tables: string[];
}

/**
 * Apply migrations to a throwaway database, introspect it, and write the generated
 * schema modules.
 *
 * Only rewrites a file when its content differs, so calling this on every file-change
 * event does not churn mtimes or retrigger a watching dev server.
 *
 * @example
 * ```ts
 * const { tables, written } = await syncSchema({
 *   migrationsPath: './migrations',
 *   outDir: './lib/schema',
 * });
 * ```
 *
 * @throws If a migration fails to apply. The error is the underlying Postgres error,
 * so a syntax error in a `.sql` file surfaces with its real message.
 */
export async function syncSchema(options: SyncSchemaOptions): Promise<SyncSchemaResult> {
	const { migrationsPath, outDir } = options;

	mkdirSync(outDir, { recursive: true });

	// Throwaway data directory — see the module doc for why this isn't the dev database.
	const dataDir = mkdtempSync(join(tmpdir(), 'bb-schema-sync-'));
	const engine = new PGliteEngine(dataDir);

	try {
		const migrations = await loadMigrationsFromDir(migrationsPath);
		await runMigrations(engine, migrations);

		const { tables } = await introspectEngine(engine);

		// Preserve any hand-edited `singular` values so regeneration doesn't revert a
		// deliberate override (e.g. "datum" for a "data" table).
		const existingSingulars = readExistingSingulars(join(outDir, META_FILE));

		const written = [
			// No index signature: `[key: string]: unknown` would make `keyof Row` include
			// `string`, and every column-name check in the fluent client would silently
			// pass. See generateTypesFile.
			writeIfChanged(join(outDir, TYPES_FILE), generateTypesFile(tables, TYPES_HEADER, mapType, false)),
			writeIfChanged(join(outDir, META_FILE), generateMetaFile(tables, existingSingulars, META_HEADER_PREFIX)),
		].filter((f): f is string => f !== null);

		return { written, tables: tables.map((t) => t.name) };
	} finally {
		await engine.destroy();
		rmSync(dataDir, { recursive: true, force: true });
	}
}

/** Write only when the content differs. Returns the path if written, else null. */
function writeIfChanged(path: string, content: string): string | null {
	try {
		if (readFileSync(path, 'utf-8') === content) return null;
	} catch {
		// Missing or unreadable — fall through and write it.
	}
	writeFileSync(path, content);
	return path;
}

function readExistingSingulars(metaPath: string): Map<string, string> | undefined {
	try {
		return parseExistingMetaSingulars(readFileSync(metaPath, 'utf-8'));
	} catch {
		return undefined;
	}
}
