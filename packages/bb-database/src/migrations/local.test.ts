// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { RulesEngine } from '../dialect/rules-engine.js';
import { sharedPgliteCluster } from '../engines/pglite-cluster.js';
import { migrations } from '../test-support/fixtures.js';
import { installLocalTestHooks } from '../test-support/lifecycle.js';
import { prepareLocalSchema } from './local.js';

const DATA_DIR = join(process.cwd(), '.bb-data', `local-schema-test-${process.pid}`);

installLocalTestHooks({ mockDataPrefix: 'local-schema-test' });

// The ledger table as `DistributedDatabase` of `@aws-blocks/bb-distributed-data` created it, in `public`.
const EARLIER_LEDGER = `CREATE TABLE IF NOT EXISTS _migrations (
	id TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
	name TEXT NOT NULL UNIQUE,
	applied_at TIMESTAMP NOT NULL DEFAULT NOW()
)`;

describe('a schema that DistributedDatabase migrated', () => {
	test('its ledger is read as it is: an applied file does not run again, and a new file is recorded in it', async () => {
		const inner = sharedPgliteCluster(join(DATA_DIR, 'earlier', 'pglite'), 'dsql').forSchema('public');
		const engine = new RulesEngine(inner, 'dsql');
		// What the earlier block left: its ledger with one file, and the table and the row of that file.
		await inner.asAdmin(async () => {
			await inner.execute(EARLIER_LEDGER);
			await inner.execute(
				'CREATE TABLE accounts (owner TEXT NOT NULL, name TEXT NOT NULL, PRIMARY KEY (owner, name))',
			);
			await inner.execute("INSERT INTO accounts VALUES ('u1', 'checking')");
			await inner.execute("INSERT INTO _migrations (name) VALUES ('001_accounts.sql')");
		});
		// The same directory with one more file. `001` has no IF NOT EXISTS, so a second run of it would fail.
		const migrationsPath = migrations({
			'001_accounts.sql':
				'CREATE TABLE accounts (owner TEXT NOT NULL, name TEXT NOT NULL, PRIMARY KEY (owner, name));',
			'002_notes.sql': 'CREATE TABLE notes (id TEXT PRIMARY KEY, body TEXT);',
		});
		const options = { kind: 'dsql' as const, schemaName: 'public', migrationsPath, log: () => {} };

		assert.deepStrictEqual(await prepareLocalSchema(engine, inner, options), ['002_notes.sql']);

		const ledger = await inner.asAdmin(() =>
			inner.query<{ name: string; has_id: boolean }>(
				'SELECT name, id IS NOT NULL AS has_id FROM _migrations ORDER BY name',
			),
		);
		assert.deepStrictEqual(ledger, [
			{ name: '001_accounts.sql', has_id: true },
			{ name: '002_notes.sql', has_id: true },
		]);
		// As the app role: the earlier table has the block's grants, and its row is there.
		assert.deepStrictEqual(await engine.query('SELECT owner, name FROM accounts'), [
			{ owner: 'u1', name: 'checking' },
		]);
		await engine.execute("INSERT INTO notes (id, body) VALUES ('n1', 'after the upgrade')");

		assert.deepStrictEqual(await prepareLocalSchema(engine, inner, options), []);
	});
});
