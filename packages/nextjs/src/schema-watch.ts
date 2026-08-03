// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Keeps generated schema types in step with the SQL migrations while the dev server
 * runs, so there is no command for the developer to remember and no generated
 * artifact to refresh by hand.
 *
 * @module
 */

import { existsSync, watch } from 'node:fs';

/** Options for schema syncing. Set `schema: false` on `withBlocks` to disable. */
export interface SchemaSyncOptions {
	/** Directory of ordered `.sql` migrations. Default: `./migrations`. */
	migrationsPath?: string;
	/** Where the generated schema modules are written. Default: `./lib/schema`. */
	outDir?: string;
}

const DEFAULTS = { migrationsPath: './migrations', outDir: './lib/schema' } as const;

/** Coalesce the burst of events an editor emits when saving a file. */
const DEBOUNCE_MS = 150;

/**
 * Run an initial sync and then watch for migration changes.
 *
 * Deliberately fire-and-forget: `next.config` evaluation must not block on a
 * database spin-up. Generated files are committed, so the first compile after a
 * fresh clone already has types — this keeps them current from then on.
 *
 * A no-op when the migrations directory is absent, or when `@aws-blocks/bb-data`
 * isn't installed (an app with no database).
 */
export function startSchemaSync(options: SchemaSyncOptions = {}): void {
	const migrationsPath = options.migrationsPath ?? DEFAULTS.migrationsPath;
	const outDir = options.outDir ?? DEFAULTS.outDir;

	if (!existsSync(migrationsPath)) return;

	// Imported lazily so this package carries no dependency on bb-data: an app
	// without a database should not need it installed.
	const load = async () => {
		try {
			return (await import('@aws-blocks/bb-data/schema-sync')).syncSchema;
		} catch {
			return null;
		}
	};

	let running = false;
	let queued = false;

	const sync = async () => {
		// Serialize: each run spins up its own throwaway database, and overlapping
		// runs would race on writing the same output files.
		if (running) {
			queued = true;
			return;
		}
		running = true;
		try {
			const syncSchema = await load();
			if (!syncSchema) return;

			const { written, tables } = await syncSchema({ migrationsPath, outDir });
			if (written.length > 0) {
				console.log(`[blocks] schema updated from ${migrationsPath} (${tables.join(', ') || 'no tables'})`);
			}
		} catch (e) {
			// A migration with a syntax error is a normal state mid-edit. Report it and
			// keep watching rather than taking the dev server down.
			console.error(`[blocks] schema sync failed: ${e instanceof Error ? e.message : String(e)}`);
		} finally {
			running = false;
			if (queued) {
				queued = false;
				void sync();
			}
		}
	};

	void sync();

	let timer: NodeJS.Timeout | undefined;
	// `persistent: false` so this watcher never holds the process open on its own.
	watch(migrationsPath, { persistent: false }, () => {
		clearTimeout(timer);
		timer = setTimeout(() => void sync(), DEBOUNCE_MS);
	});
}
