// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { describe, test } from 'node:test';
import { sql } from '@aws-blocks/data-common';
import { RecordingEngine } from '../test-support/recording-engine.js';
import { DatabaseCore } from './index.js';

// Any engine, not the local one, must see a block-level query inside a transaction() callback arrive on the
// in-transaction methods with that transaction's handle.
describe('DatabaseCore routes block-level statements into the open transaction', () => {
	test('query, queryOne and execute inside a transaction() callback run on the in-transaction methods with its handle, for any engine', async () => {
		const engine = new RecordingEngine();
		const core = new DatabaseCore({ engine: async () => engine });
		await core.transaction(async (tx) => {
			await tx.execute(sql`INSERT INTO t VALUES (1)`);
			await core.execute(sql`INSERT INTO t VALUES (2)`);
			await core.query(sql`SELECT 1`);
			await core.queryOne(sql`SELECT 2`);
		});
		const handle = engine.calls[0].handle;
		assert.ok(handle);
		const params: unknown[] = [];
		assert.deepStrictEqual(engine.calls, [
			{ method: 'begin', sql: 'BEGIN', params, handle },
			{ method: 'executeInTransaction', sql: 'INSERT INTO t VALUES (1)', params, handle },
			{ method: 'executeInTransaction', sql: 'INSERT INTO t VALUES (2)', params, handle },
			{ method: 'queryInTransaction', sql: 'SELECT 1', params, handle },
			{ method: 'queryInTransaction', sql: 'SELECT 2', params, handle },
			{ method: 'commit', sql: 'COMMIT', params, handle },
		]);
	});

	test('outside a callback, and from another core inside one, statements run auto-commit on their own engine', async () => {
		const a = new RecordingEngine();
		const b = new RecordingEngine();
		const coreA = new DatabaseCore({ engine: async () => a });
		const coreB = new DatabaseCore({ engine: async () => b });
		await coreA.transaction(async () => {
			await coreB.query(sql`SELECT 1`);
		});
		await coreA.query(sql`SELECT 2`);
		assert.deepStrictEqual(
			a.calls.map((c) => c.method),
			['begin', 'commit', 'query'],
		);
		assert.deepStrictEqual(b.calls, [{ method: 'query', sql: 'SELECT 1', params: [], handle: undefined }]);
	});

	test('a statement from a promise the callback did not await runs after the commit, not on the ended handle', async () => {
		const engine = new RecordingEngine();
		const core = new DatabaseCore({ engine: async () => engine });
		let late: Promise<unknown> = Promise.resolve();
		await core.transaction(async () => {
			late = new Promise((resolve) => setTimeout(resolve, 5)).then(() => core.query(sql`SELECT 1`));
		});
		await late;
		assert.deepStrictEqual(
			engine.calls.map((c) => c.method),
			['begin', 'commit', 'query'],
		);
	});
});
