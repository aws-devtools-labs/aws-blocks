// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { isBlocksError } from '@aws-cdk-blocks/core';
import { quoteIdent } from '../constants.js';
import { DatabaseErrors } from '../errors.js';
import { runInTransactionScope, TransactionScope } from '../runtime/tx-scope.js';
import { installLocalTestHooks } from '../test-support/lifecycle.js';
import { _closeAllPgliteClusters, type SchemaEngine, sharedPgliteCluster } from './pglite-cluster.js';
import { AURORA_LOCAL_EXTENSIONS } from './pglite-extensions.js';

const DATA_DIR = join(process.cwd(), '.cdk-blocks/local/data', `pglite-cluster-test-${process.pid}`);
let counter = 0;
const cluster = () => sharedPgliteCluster(join(DATA_DIR, `c${++counter}`, 'pglite'), 'dsql');

installLocalTestHooks({ mockDataPrefix: 'pglite-cluster-test' });

// Setup the app role cannot do: it owns nothing and has no grants until a block issues them.
const asAdmin = (engine: SchemaEngine, statements: string[]) =>
	engine.asAdmin(async () => {
		for (const sql of statements) await engine.execute(sql);
	});

describe('PGlite cluster transaction handle lifecycle', () => {
	test('a failed COMMIT frees the session once', async () => {
		const engine = cluster().forSchema('public');
		// A deferred constraint fails at COMMIT, not at the INSERT.
		await asAdmin(engine, [
			'CREATE TABLE t (id INT, CONSTRAINT t_id UNIQUE (id) DEFERRABLE INITIALLY DEFERRED)',
			'GRANT SELECT, INSERT ON t TO PUBLIC',
		]);
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
		await asAdmin(engine, ['CREATE TABLE t (id INT)', 'GRANT SELECT, INSERT ON t TO PUBLIC']);
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
		await asAdmin(a, ['CREATE SCHEMA a', 'CREATE SCHEMA b']);
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

describe('PGlite cluster extensions', () => {
	const extensions = Object.keys(AURORA_LOCAL_EXTENSIONS);

	test('an aurora cluster creates every extension of the set, and reopens a data directory whose tables use one', async () => {
		const dir = join(DATA_DIR, `ext${++counter}`, 'pglite');
		const first = sharedPgliteCluster(dir, 'aurora');
		const engine = first.forSchema('public');
		await asAdmin(engine, [
			// Each key is the name CREATE EXTENSION takes (`uuid-ossp`, not the bundle's `uuid_ossp`).
			...extensions.map((name) => `CREATE EXTENSION ${quoteIdent(name)}`),
			'CREATE TABLE t (email CITEXT)',
			"INSERT INTO t VALUES ('Ada@Example.com')",
		]);
		await first.destroy();

		// A new instance on the same directory: the citext type's functions must load again.
		const again = sharedPgliteCluster(dir, 'aurora').forSchema('public');
		const rows = await again.asAdmin(() => again.query("SELECT email FROM t WHERE email = 'ada@example.com'"));
		assert.deepStrictEqual(rows, [{ email: 'Ada@Example.com' }]);
	});

	// PGlite's contrib bundles that the set leaves out; AURORA_LOCAL_EXTENSIONS gives the reason for each.
	const LEFT_OUT = ['auto_explain', 'file_fdw', 'pageinspect', 'pg_stat_statements', 'pg_surgery', 'pg_walinspect'];

	test('the set is every contrib extension the installed PGlite ships, minus the ones left out on purpose', () => {
		const contrib = dirname(fileURLToPath(import.meta.resolve('@electric-sql/pglite/contrib/citext')));
		const shipped = readdirSync(contrib).flatMap((file) => /^(\w+)\.js$/.exec(file)?.[1] ?? []);
		assert.deepStrictEqual(
			shipped.sort(),
			[...extensions.map((name) => name.replace('-', '_')), ...LEFT_OUT].sort(),
			'a bundle PGlite ships is neither in AURORA_LOCAL_EXTENSIONS nor in LEFT_OUT (or the reverse)',
		);
	});

	test('README and DESIGN list the set', () => {
		const quoted = extensions.map((name) => `\`${name}\``);
		const list = `${quoted.slice(0, -1).join(', ')} and ${quoted.at(-1)}`;
		for (const doc of ['README.md', 'DESIGN.md']) {
			const text = readFileSync(join(import.meta.dirname, '..', '..', doc), 'utf-8');
			assert.ok(text.includes(list), `${doc} must list the extensions of AURORA_LOCAL_EXTENSIONS: ${list}`);
		}
	});

	test('a dsql cluster loads no extension', async () => {
		const engine = cluster().forSchema('public');
		await assert.rejects(asAdmin(engine, ['CREATE EXTENSION citext']), (e: unknown) => {
			assert.ok(isBlocksError(e, DatabaseErrors.QueryFailed));
			const root = e instanceof Error ? e.cause : undefined;
			assert.ok(root instanceof Error && /extension "citext" is not available$/.test(root.message), String(root));
			return true;
		});
	});
});
