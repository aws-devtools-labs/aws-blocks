// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { describe, test } from 'node:test';
import { RecordingEngine } from '../test-support/recording-engine.js';
import { DatabaseCore } from './index.js';

// For any engine, not only the local one: what the Kysely dialect asks of a session must reach the handle API.
describe('a session maps transaction control onto the engine', () => {
	test('begin, statements and commit run on one handle; an isolation level is its first statement', async () => {
		const engine = new RecordingEngine();
		const session = new DatabaseCore({ engine: async () => engine }).session();
		await session.run('select 1', []);
		await session.begin({ isolationLevel: 'serializable', accessMode: 'read write' });
		await session.run('update t set x = $1', [1]);
		await session.run('rollback to savepoint "sp"', []);
		await session.commit();
		session.release();
		const handle = engine.calls[1].handle;
		assert.ok(handle);
		assert.deepStrictEqual(
			engine.calls.map((c) => [c.method, c.sql, c.handle === handle]),
			[
				['queryCounted', 'select 1', false],
				['begin', 'BEGIN', true],
				['executeInTransaction', 'set transaction isolation level serializable read write', true],
				['queryCountedInTransaction', 'update t set x = $1', true],
				['queryCountedInTransaction', 'rollback to savepoint "sp"', true],
				['commit', 'COMMIT', true],
			],
		);
	});

	test('a session released with its transaction open is rolled back', async () => {
		const engine = new RecordingEngine();
		const session = new DatabaseCore({ engine: async () => engine }).session();
		await session.begin();
		session.release();
		await new Promise((resolve) => setImmediate(resolve));
		assert.deepStrictEqual(
			engine.calls.map((c) => c.method),
			['begin', 'rollback'],
		);
	});

	test('a mode that is not PostgreSQL is refused before the transaction begins', async () => {
		const engine = new RecordingEngine();
		const session = new DatabaseCore({ engine: async () => engine }).session();
		await assert.rejects(session.begin({ isolationLevel: 'snapshot' }), /not a PostgreSQL isolation level/);
		await assert.rejects(
			session.begin({ accessMode: 'read only; drop table t' }),
			/not a PostgreSQL transaction access mode/,
		);
		assert.deepStrictEqual(engine.calls, []);
	});
});
