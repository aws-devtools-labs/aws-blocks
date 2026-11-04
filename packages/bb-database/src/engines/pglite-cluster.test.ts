// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { isBlocksError } from '@aws-blocks/core';
import { DatabaseErrors } from '../errors.js';
import { runInTransactionScope, TransactionScope } from '../runtime/tx-scope.js';
import { installLocalTestHooks } from '../test-support/lifecycle.js';
import { _closeAllPgliteClusters, sharedPgliteCluster } from './pglite-cluster.js';

const DATA_DIR = join(process.cwd(), '.bb-data', `pglite-cluster-test-${process.pid}`);
let counter = 0;
const cluster = () => sharedPgliteCluster(join(DATA_DIR, `c${++counter}`, 'pglite'));

installLocalTestHooks({ mockDataPrefix: 'pglite-cluster-test' });

describe('PGlite cluster transaction handle lifecycle', () => {
	test('a failed COMMIT frees the session once', async () => {
		const engine = cluster().forSchema('public');
		// A deferred constraint fails at COMMIT, not at the INSERT.
		await engine.execute('CREATE TABLE t (id INT, CONSTRAINT t_id UNIQUE (id) DEFERRABLE INITIALLY DEFERRED)');
		const first = await engine.beginTransaction();
		await engine.executeInTransaction(first, 'INSERT INTO t VALUES (1), (1)');
		await assert.rejects(engine.commitTransaction(first), (e: unknown) =>
			isBlocksError(e, DatabaseErrors.UniqueConstraintViolation),
		);

		// The next transaction: DatabaseCore's rollback of `first` runs while it is open.
		const second = await engine.beginTransaction();
		await engine.executeInTransaction(second, 'INSERT INTO t VALUES (2)');
		await engine.rollbackTransaction(first);
		await engine.commitTransaction(second);
		assert.deepStrictEqual(
			await engine.query('SELECT id FROM t ORDER BY id'),
			[{ id: 2 }],
			'a later rollback of the failed handle leaves the next transaction alone',
		);
	});

	test('rollbackTransaction is idempotent and a statement on an ended handle is refused', async () => {
		const engine = cluster().forSchema('public');
		await engine.execute('CREATE TABLE t (id INT)');
		const first = await engine.beginTransaction();
		await engine.rollbackTransaction(first);
		const second = await engine.beginTransaction();
		await engine.executeInTransaction(second, 'INSERT INTO t VALUES (2)');
		await engine.rollbackTransaction(first);
		await assert.rejects(engine.queryInTransaction(first, 'SELECT 1'), (e: unknown) =>
			isBlocksError(e, DatabaseErrors.TransactionFailed),
		);
		await engine.commitTransaction(second);
		assert.deepStrictEqual(await engine.query('SELECT id FROM t'), [{ id: 2 }]);
	});

	test('onRollback runs when the work is undone, not when it is kept', async () => {
		const c = cluster();
		const a = c.forSchema('a');
		const b = c.forSchema('b');
		await a.execute('CREATE SCHEMA a');
		await b.execute('CREATE SCHEMA b');
		const events: string[] = [];
		const inside = (handle: Awaited<ReturnType<typeof a.beginTransaction>>, fn: () => Promise<void>) =>
			runInTransactionScope(new TransactionScope(a, handle), fn);

		// ROLLBACK: fires. COMMIT: does not.
		let outer = await a.beginTransaction();
		await inside(outer, async () => {
			c.enclosingTransaction()?.onRollback(() => events.push('rollback'));
		});
		await a.rollbackTransaction(outer);
		outer = await a.beginTransaction();
		await inside(outer, async () => {
			c.enclosingTransaction()?.onRollback(() => events.push('commit'));
		});
		await a.commitTransaction(outer);
		assert.deepStrictEqual(events, ['rollback']);

		// A listener on a savepoint: ROLLBACK TO fires it; RELEASE hands it to the enclosing transaction, whose
		// rollback then fires it. The enclosing transaction's own listeners stay out of the savepoint's rollback.
		events.length = 0;
		outer = await a.beginTransaction();
		await inside(outer, async () => {
			c.enclosingTransaction()?.onRollback(() => events.push('outer'));
			const undone = await b.beginTransaction();
			await inside(undone, async () => {
				c.enclosingTransaction()?.onRollback(() => events.push('undone savepoint'));
			});
			await b.rollbackTransaction(undone);
			assert.deepStrictEqual(events, ['undone savepoint']);
			const kept = await b.beginTransaction();
			await inside(kept, async () => {
				c.enclosingTransaction()?.onRollback(() => events.push('released savepoint'));
			});
			await b.commitTransaction(kept);
			assert.deepStrictEqual(events, ['undone savepoint'], 'a RELEASE fires nothing');
		});
		await a.rollbackTransaction(outer);
		assert.deepStrictEqual(events, ['undone savepoint', 'outer', 'released savepoint']);
	});

	test('closing a cluster that never ran a statement resolves', async () => {
		// Regression: PGlite's close() hangs until its init has finished (seen on 0.5.10). The cluster
		// constructs its PGlite eagerly, so one whose block never ran a statement is in exactly that state.
		cluster();
		const timeout = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 15_000).unref());
		assert.notStrictEqual(await Promise.race([_closeAllPgliteClusters().then(() => 'closed'), timeout]), 'timeout');
	});
});
