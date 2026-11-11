// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// DSQL rejects a schema-level grant on `public` (a system entity): the deploy that pinned this ran
// `GRANT USAGE ON SCHEMA "public"`.
import assert from 'node:assert';
import { describe, test } from 'node:test';
import { serializationConflict } from '../errors.js';
import { RecordingEngine } from '../test-support/recording-engine.js';
import { isRetryableMigrationError, provisionAppRole } from './migration-lambda.js';

class GrantEngine extends RecordingEngine {
	constructor(
		private readonly tables: string[] = [],
		private readonly matviews: string[] = [],
	) {
		super();
	}

	protected override answer(sql: string): unknown[] {
		if (/FROM pg_tables/.test(sql)) return this.tables.map((tablename) => ({ tablename }));
		if (/FROM pg_matviews/.test(sql)) return this.matviews.map((matviewname) => ({ matviewname }));
		return [];
	}
}

describe('provisionAppRole', () => {
	test('does not grant on schema public (DSQL rejects it as a system entity)', async () => {
		const engine = new GrantEngine(['notes']);
		await provisionAppRole(engine, 'dsql', 'blocks_app_x', 'arn:aws:iam::123:role/app', 'public');
		assert.ok(!engine.statements.some((s) => s.includes('ON SCHEMA')), engine.statements.join('\n'));
		assert.ok(engine.statements.some((s) => s.startsWith('CREATE ROLE')));
		assert.ok(engine.statements.some((s) => s.startsWith('AWS IAM GRANT')));
		assert.ok(
			engine.statements.some((s) => s.includes('GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."notes"')),
		);
	});

	test('grants usage on a block-owned schema', async () => {
		const engine = new GrantEngine();
		await provisionAppRole(engine, 'dsql', 'blocks_app_x', 'arn:aws:iam::123:role/app', 'app_dbxa');
		assert.ok(engine.statements.includes('GRANT USAGE ON SCHEMA "app_dbxa" TO "blocks_app_x"'));
	});

	test('a materialized view gets SELECT like a view', async () => {
		const engine = new GrantEngine(['notes'], ['daily']);
		await provisionAppRole(engine, 'aurora', 'blocks_app_x', 'arn:aws:iam::123:role/app', 'app_dbxa');
		assert.ok(
			engine.statements.includes('GRANT SELECT ON "app_dbxa"."daily" TO "blocks_app_x"'),
			engine.statements.join('\n'),
		);
	});

	test('on an aurora cluster the role joins rds_iam instead of an AWS IAM GRANT', async () => {
		const engine = new GrantEngine(['notes']);
		await provisionAppRole(engine, 'aurora', 'blocks_app_x', 'arn:aws:iam::123:role/app', 'app_dbxa');
		assert.ok(engine.statements.includes('GRANT rds_iam TO "blocks_app_x"'), engine.statements.join('\n'));
		assert.ok(!engine.statements.some((s) => s.startsWith('AWS IAM GRANT')));
		assert.ok(engine.statements.includes('GRANT USAGE ON SCHEMA "app_dbxa" TO "blocks_app_x"'));
		assert.ok(
			engine.statements.some((s) => s.includes('GRANT SELECT, INSERT, UPDATE, DELETE ON "app_dbxa"."notes"')),
		);
	});
});

describe('isRetryableMigrationError', () => {
	test('a serialization conflict, on the error or its cause, is retried like a lost connection', () => {
		assert.ok(isRetryableMigrationError(serializationConflict(new Error('could not serialize access'))));
		assert.ok(
			isRetryableMigrationError(new Error('migration failed', { cause: serializationConflict(new Error('x')) })),
		);
		assert.ok(!isRetryableMigrationError(new Error('syntax error at or near "CREAT"')));
	});

	test('a dead socket or a connect timeout is retried, however deeply the runner and engine wrapped it', () => {
		const socket = new Error('Connection terminated unexpectedly');
		const wrapped = new Error('Migration 001 failed', {
			cause: new Error('The database query failed', { cause: socket }),
		});
		assert.ok(isRetryableMigrationError(wrapped));
		assert.ok(isRetryableMigrationError(new Error('timeout exceeded when trying to connect')));
		assert.ok(!isRetryableMigrationError(new Error('outer', { cause: new Error('relation "t" does not exist') })));
	});
});
