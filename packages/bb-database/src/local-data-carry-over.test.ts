// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// The local database moving with the rest of the mock data, from `.bb-data/{fullId}/pglite/` to
// `.cdk-blocks/local/data/{fullId}/pglite/`: the rows survive the move, and a half-finished copy fails.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { getMockDataDir, LEGACY_MOCK_DATA_DIR, MOCK_DATA_DIR } from '@aws-cdk-blocks/core/bb-utils';
import { _closeAllPgliteClusters, PGLITE_SUBDIR, type SchemaEngine, sharedPgliteCluster } from './engines/pglite-cluster.js';

/** `getMockDataDir` reads only `fullId`, so a bare object is the whole contract. */
const scope = (fullId: string) => ({ fullId }) as unknown as Parameters<typeof getMockDataDir>[0];

const FULL_ID = 'app-orders';

const asAdmin = (engine: SchemaEngine, statements: string[]) =>
	engine.asAdmin(async () => {
		for (const sql of statements) await engine.execute(sql);
	});

describe('the local database moves with the mock data directory', () => {
	let project: string;
	let cwd: string;

	beforeEach(() => {
		cwd = process.cwd();
		project = realpathSync(mkdtempSync(join(tmpdir(), 'bb-database-carry-over-')));
		process.chdir(project);
	});

	afterEach(async () => {
		await _closeAllPgliteClusters();
		process.chdir(cwd);
		rmSync(project, { recursive: true, force: true, maxRetries: 5 });
	});

	/** A populated pre-consolidation database: a real PGlite with real rows, closed cleanly. */
	async function seedLegacyDatabase(): Promise<void> {
		const legacy = join(project, LEGACY_MOCK_DATA_DIR, FULL_ID, PGLITE_SUBDIR);
		const engine = sharedPgliteCluster(legacy, 'dsql').forSchema('public');
		await asAdmin(engine, [
			'CREATE TABLE orders (id INT PRIMARY KEY, item TEXT NOT NULL)',
			"INSERT INTO orders VALUES (1, 'desk'), (2, 'lamp'), (3, 'chair')",
			'GRANT SELECT ON orders TO PUBLIC',
		]);
		await _closeAllPgliteClusters();
	}

	void it('carries the real rows across, byte for byte, and leaves the original in place', async () => {
		await seedLegacyDatabase();

		// What the block itself does: ask for the directory, then open PGlite under it.
		const dataDir = getMockDataDir(scope(FULL_ID));
		assert.equal(dataDir, join(project, MOCK_DATA_DIR, FULL_ID));
		const engine = sharedPgliteCluster(join(dataDir, PGLITE_SUBDIR), 'dsql').forSchema('public');

		assert.deepStrictEqual(await engine.query('SELECT id, item FROM orders ORDER BY id'), [
			{ id: 1, item: 'desk' },
			{ id: 2, item: 'lamp' },
			{ id: 3, item: 'chair' },
		]);

		// Copy, not move: an older CLI in the same checkout still opens the old path.
		assert.ok(existsSync(join(project, LEGACY_MOCK_DATA_DIR, FULL_ID, PGLITE_SUBDIR, 'PG_VERSION')));
	});

	void it('never replaces a database already in the new location', async () => {
		await seedLegacyDatabase();

		// A database the project already has at the new path, with different rows.
		const target = join(project, MOCK_DATA_DIR, FULL_ID, PGLITE_SUBDIR);
		const mine = sharedPgliteCluster(target, 'dsql').forSchema('public');
		await asAdmin(mine, [
			'CREATE TABLE orders (id INT PRIMARY KEY, item TEXT NOT NULL)',
			"INSERT INTO orders VALUES (9, 'keep-me')",
			'GRANT SELECT ON orders TO PUBLIC',
		]);
		await _closeAllPgliteClusters();

		getMockDataDir(scope(FULL_ID));
		const engine = sharedPgliteCluster(target, 'dsql').forSchema('public');
		assert.deepStrictEqual(await engine.query('SELECT id, item FROM orders ORDER BY id'), [{ id: 9, item: 'keep-me' }]);
	});

	// The reviewer's point: the refusal above calls `sharedPgliteCluster` directly, which the
	// real flow never does. Through `getMockDataDir` the copy completes first and the unit is
	// recorded only after it returns, so a partial directory is FILLED IN rather than refused.
	// That is the safe outcome, and this pins it so the refusal is not mistaken for the
	// carry-over's first line of defence.
	void it('fills a partial copy in through the real getMockDataDir path, rather than refusing', async () => {
		await seedLegacyDatabase();

		const target = join(project, MOCK_DATA_DIR, FULL_ID, PGLITE_SUBDIR);
		mkdirSync(target, { recursive: true });
		writeFileSync(join(target, 'postgresql.conf'), '# half-copied\n');

		// The real resolution order: every caller gets its dataDir from here first.
		getMockDataDir(scope(FULL_ID));
		assert.ok(existsSync(join(target, 'PG_VERSION')), 'the carry-over completes the directory');

		const engine = sharedPgliteCluster(target, 'dsql').forSchema('public');
		assert.deepStrictEqual(await engine.query('SELECT id, item FROM orders ORDER BY id'), [
			{ id: 1, item: 'desk' },
			{ id: 2, item: 'lamp' },
			{ id: 3, item: 'chair' },
		]);
		await _closeAllPgliteClusters();
	});

	void it('refuses a half-copied database, naming both paths, instead of coming up empty', async () => {
		await seedLegacyDatabase();

		// A copy cut short: enough of a Postgres data directory to look like one, but not
		// initialised. Left to itself, `recoverIncompletePgliteDataDir` renames this aside
		// and creates a fresh empty database.
		const target = join(project, MOCK_DATA_DIR, FULL_ID, PGLITE_SUBDIR);
		mkdirSync(target, { recursive: true });
		writeFileSync(join(target, 'postgresql.conf'), '# half-copied\n');

		assert.throws(
			() => sharedPgliteCluster(target, 'dsql'),
			(error: unknown) => {
				assert.ok(error instanceof Error);
				assert.match(error.message, /is incomplete/);
				assert.match(error.message, /\.bb-data/);
				assert.match(error.message, /\.cdk-blocks[/\\]local[/\\]data/);
				return true;
			},
		);

		// Nothing was moved aside, and the legacy database is untouched.
		assert.ok(existsSync(join(target, 'postgresql.conf')));
		assert.ok(existsSync(join(project, LEGACY_MOCK_DATA_DIR, FULL_ID, PGLITE_SUBDIR, 'PG_VERSION')));
	});

	void it('is a no-op for a project that never had the old directory', async () => {
		const dataDir = getMockDataDir(scope(FULL_ID));
		const engine = sharedPgliteCluster(join(dataDir, PGLITE_SUBDIR), 'dsql').forSchema('public');
		await asAdmin(engine, ['CREATE TABLE t (id INT)', 'GRANT SELECT ON t TO PUBLIC']);
		assert.deepStrictEqual(await engine.query('SELECT id FROM t'), []);
		assert.ok(!existsSync(join(project, LEGACY_MOCK_DATA_DIR)));
	});
});
