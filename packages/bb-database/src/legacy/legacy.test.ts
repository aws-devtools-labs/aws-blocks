// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { describe, test } from 'node:test';
import { isBlocksError } from '@aws-cdk-blocks/core';
import { DataApiEngine } from '../engines/data-api-engine.js';
import { Database as LambdaDatabase, LegacyDatabaseCluster as LambdaLegacyCluster } from '../index.aws.js';
import { Database, LegacyDatabaseCluster, sql } from '../index.mock.js';
import { internalAccess } from '../runtime/internal.js';
import { migrations } from '../test-support/fixtures.js';
import { freshScope, installLocalTestHooks } from '../test-support/lifecycle.js';

installLocalTestHooks({ mockDataPrefix: 'legacy' });

const CONFIG_ERROR = 'DatabaseConfigurationError';
const isConfigError = (pattern: RegExp) => (e: unknown) => {
	assert.ok(isBlocksError(e, CONFIG_ERROR), `expected ${CONFIG_ERROR}, got ${String(e)}`);
	assert.match((e as Error).message, pattern);
	return true;
};

// The ledger table as `Database` of `@aws-blocks/bb-data` created it.
const EARLIER_LEDGER = `CREATE TABLE IF NOT EXISTS _migrations (
	id SERIAL PRIMARY KEY,
	name TEXT NOT NULL UNIQUE,
	applied_at TIMESTAMP NOT NULL DEFAULT NOW()
)`;

describe('LegacyDatabaseCluster, local mode', () => {
	test('a block on it is an aurora block in the public schema of that cluster', () => {
		const scope = freshScope('legacy');
		const cluster = new LegacyDatabaseCluster(scope, 'main', { minCapacity: 1 });
		const db = new Database(scope, 'main-db', { cluster });
		assert.deepStrictEqual(db.cluster, { kind: 'aurora', id: cluster.fullId });
		assert.strictEqual(db.schemaName, 'public');
		assert.throws(
			() => new Database(scope, 'other', { cluster, schemaName: 'app' }),
			isConfigError(/has the schema\s+'public'/),
		);
		assert.throws(() => new Database(scope, 'second', { cluster }), isConfigError(/both use schema 'public'/));
	});

	test('asUser() is refused, because on AWS the owner of the tables runs the statements; asRole() is not', () => {
		const scope = freshScope('legacy');
		const db = new Database(scope, 'main-db', { cluster: new LegacyDatabaseCluster(scope, 'main') });
		assert.throws(() => db.asUser({ userId: 'u1' }), isConfigError(/asUser\(\) does not filter rows.*Use asRole/));
		assert.doesNotThrow(() => db.asRole('authenticated', { sub: 'u1' }));
	});

	test('a file that is older than the block gets no check: an applied file cannot be changed', () => {
		const scope = freshScope('legacy');
		const files = { '001_index.sql': 'CREATE INDEX CONCURRENTLY t_n ON t (n);' };
		assert.doesNotThrow(
			() =>
				new Database(scope, 'main-db', {
					cluster: new LegacyDatabaseCluster(scope, 'main'),
					migrationsPath: migrations(files),
				}),
		);
	});

	test('its options are checked like those of the earlier block', () => {
		const scope = freshScope('legacy');
		assert.throws(
			() => new LegacyDatabaseCluster(scope, 'a', { postgresVersion: '16' }),
			isConfigError(/postgresVersion must be "MAJOR\.MINOR"/),
		);
		assert.throws(
			() =>
				new LegacyDatabaseCluster(scope, 'b', { subnets: { subnetType: 'isolated', subnetIds: ['subnet-1'] } }),
			isConfigError(/at most one of/),
		);
	});

	test('the block uses the tables and the ledger that the earlier block left', async () => {
		const scope = freshScope('legacy');
		const cluster = new LegacyDatabaseCluster(scope, 'main');
		// What the earlier block left in `public`: its ledger with one file, and the table and the row of that file.
		const admin = cluster.engineFor('public');
		await admin.asAdmin(async () => {
			await admin.execute(EARLIER_LEDGER);
			await admin.execute(
				'CREATE TABLE accounts (owner TEXT NOT NULL, name TEXT NOT NULL, PRIMARY KEY (owner, name))',
			);
			await admin.execute("INSERT INTO accounts VALUES ('u1', 'checking')");
			await admin.execute("INSERT INTO _migrations (name) VALUES ('001_accounts.sql')");
		});
		const db = new Database(scope, 'main-db', {
			cluster,
			migrationsPath: migrations({
				// No IF NOT EXISTS: a second run of this file would fail.
				'001_accounts.sql':
					'CREATE TABLE accounts (owner TEXT NOT NULL, name TEXT NOT NULL, PRIMARY KEY (owner, name));',
				// A PostgreSQL file: the block does not check it against DSQL.
				'002_notes.sql': 'CREATE TABLE notes (id SERIAL PRIMARY KEY, body TEXT);',
			}),
		});
		assert.deepStrictEqual(await db.query(sql`SELECT owner, name FROM accounts`), [
			{ owner: 'u1', name: 'checking' },
		]);
		await db.execute(sql`INSERT INTO notes (body) VALUES (${'after the upgrade'})`);
		const ledger = await admin.asAdmin(() =>
			admin.query<{ name: string }>('SELECT name FROM _migrations ORDER BY id'),
		);
		assert.deepStrictEqual(ledger, [{ name: '001_accounts.sql' }, { name: '002_notes.sql' }]);
	});
});

describe('LegacyDatabaseCluster, Lambda entry', () => {
	const keys = ['CLUSTER_ARN', 'SECRET_ARN', 'DATABASE'];
	const envOf = (fullId: string) => keys.map((key) => `BLOCKS_${fullId.replace(/[^a-zA-Z0-9]/g, '_')}_${key}`);

	test('without the config of the cluster, the first statement fails and names the cluster', async () => {
		const scope = freshScope('legacy-aws');
		const cluster = new LambdaLegacyCluster(scope, 'main');
		const db = new LambdaDatabase(scope, 'main-db', { cluster });
		assert.deepStrictEqual(db.cluster, { kind: 'aurora', id: cluster.fullId });
		await assert.rejects(db.query(sql`SELECT 1`), isConfigError(/LegacyDatabaseCluster '.*main' is missing/));
	});

	test('asUser() is refused as it is locally', () => {
		const scope = freshScope('legacy-aws');
		const db = new LambdaDatabase(scope, 'main-db', { cluster: new LambdaLegacyCluster(scope, 'main') });
		assert.throws(() => db.asUser({ userId: 'u1' }), isConfigError(/asUser\(\) does not filter rows/));
	});

	test('with the config that the earlier block used, the engine is the Data API engine', async () => {
		const scope = freshScope('legacy-aws');
		const cluster = new LambdaLegacyCluster(scope, 'main');
		const names = envOf(cluster.fullId);
		const values = [
			'arn:aws:rds:us-east-1:123456789012:cluster:c',
			'arn:aws:secretsmanager:us-east-1:1:secret:s',
			'db',
		];
		names.forEach((name, i) => {
			process.env[name] = values[i];
		});
		try {
			const db = new LambdaDatabase(scope, 'main-db', { cluster });
			const engine = await internalAccess(db, 'test').engine();
			assert.ok(engine instanceof DataApiEngine);
			await engine.destroy();
		} finally {
			for (const name of names) delete process.env[name];
		}
	});
});
