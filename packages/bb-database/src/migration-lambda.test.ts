// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `provisionAppRole` against a scripted engine, pinning the statement set per
 * schema. DSQL rejects a schema-level grant on `public` (a system entity), so
 * a block that owns its cluster must get no `GRANT USAGE ON SCHEMA` — the e2e
 * failure that pinned this ran `GRANT USAGE ON SCHEMA "public"` on deploy.
 */
import assert from 'node:assert';
import { describe, test } from 'node:test';
import type { DatabaseEngine, TransactionHandle } from '@aws-blocks/data-common';
import { provisionAppRole } from './migration-lambda.js';

/** Captures statements; answers the catalog queries `provisionAppRole` makes. */
class GrantEngine implements DatabaseEngine {
	readonly statements: string[] = [];

	constructor(private readonly tables: string[] = []) {}

	async query<T>(sql: string): Promise<T[]> {
		this.statements.push(sql);
		if (/FROM pg_tables/.test(sql)) return this.tables.map((tablename) => ({ tablename })) as T[];
		return []; // no existing role, no views, no sequences
	}

	async execute(sql: string): Promise<{ rowCount: number }> {
		this.statements.push(sql);
		return { rowCount: 0 };
	}

	beginTransaction(): Promise<TransactionHandle> {
		throw new Error('not used');
	}
	commitTransaction(): Promise<void> {
		throw new Error('not used');
	}
	rollbackTransaction(): Promise<void> {
		throw new Error('not used');
	}
	queryInTransaction<T>(): Promise<T[]> {
		throw new Error('not used');
	}
	executeInTransaction(): Promise<{ rowCount: number }> {
		throw new Error('not used');
	}
	async destroy(): Promise<void> {}
}

describe('provisionAppRole', () => {
	test('does not grant on schema public (DSQL rejects it as a system entity)', async () => {
		const engine = new GrantEngine(['notes']);
		await provisionAppRole(engine, 'blocks_app_x', 'arn:aws:iam::123:role/app', 'public');
		assert.ok(!engine.statements.some((s) => s.includes('ON SCHEMA')), engine.statements.join('\n'));
		// The role itself and the table-level DML grants still happen.
		assert.ok(engine.statements.some((s) => s.startsWith('CREATE ROLE')));
		assert.ok(engine.statements.some((s) => s.startsWith('AWS IAM GRANT')));
		assert.ok(
			engine.statements.some((s) => s.includes('GRANT SELECT, INSERT, UPDATE, DELETE ON "public"."notes"')),
		);
	});

	test('grants usage on a block-owned schema', async () => {
		const engine = new GrantEngine();
		await provisionAppRole(engine, 'blocks_app_x', 'arn:aws:iam::123:role/app', 'app_dbxa');
		assert.ok(engine.statements.includes('GRANT USAGE ON SCHEMA "app_dbxa" TO "blocks_app_x"'));
	});
});
