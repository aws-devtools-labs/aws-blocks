// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { PGlite, type Transaction } from '@electric-sql/pglite';
import { DatabaseErrors } from '../errors.js';
import { PGliteEngine } from './pglite-engine.js';

const resources: { engine: PGliteEngine; directory: string }[] = [];

afterEach(async () => {
	for (const { engine, directory } of resources.splice(0)) {
		await engine.destroy();
		rmSync(directory, { recursive: true, force: true });
	}
});

async function setup(createClient?: (directory: string) => PGlite) {
	const directory = mkdtempSync(join(tmpdir(), 'bb-data-tx-'));
	const engine = new PGliteEngine(directory, createClient);
	resources.push({ engine, directory });
	await engine.execute('CREATE TABLE items (id TEXT PRIMARY KEY, value TEXT UNIQUE DEFERRABLE INITIALLY DEFERRED)');
	return engine;
}

test('ordinary reads wait for rollback and never see uncommitted rows', { timeout: 10_000 }, async () => {
	const engine = await setup();
	const a = await engine.beginTransaction();
	await engine.executeInTransaction(a, "INSERT INTO items VALUES ('A', 'a')");
	const read = engine.query('SELECT * FROM items');
	try {
		const result = await Promise.race([read, delay(50, 'waiting')]);
		assert.equal(result, 'waiting', 'ordinary reads must not join A');
	} finally {
		await engine.rollbackTransaction(a);
	}
	assert.deepEqual(await read, []);
});

test('queued transactions proceed in order after commit and rollback', { timeout: 10_000 }, async () => {
	const engine = await setup();
	const a = await engine.beginTransaction();
	await engine.executeInTransaction(a, "INSERT INTO items VALUES ('A', 'a')");
	const pendingB = engine.beginTransaction();
	const pendingC = engine.beginTransaction();
	await engine.commitTransaction(a);
	const b = await pendingB;
	await engine.executeInTransaction(b, "INSERT INTO items VALUES ('B', 'b')");
	await engine.rollbackTransaction(b);
	const c = await pendingC;
	await engine.executeInTransaction(c, "INSERT INTO items VALUES ('C', 'c')");
	await engine.commitTransaction(c);
	assert.deepEqual(await engine.query('SELECT id FROM items ORDER BY id'), [{ id: 'A' }, { id: 'C' }]);
});

test('failed commit releases the queue and late rollback cannot undo its successor', { timeout: 10_000 }, async () => {
	const engine = await setup();
	await engine.execute("INSERT INTO items VALUES ('original', 'duplicate')");
	const a = await engine.beginTransaction();
	// A real PostgreSQL deferred constraint error occurs at COMMIT, not INSERT.
	await engine.executeInTransaction(a, "INSERT INTO items VALUES ('A', 'duplicate')");
	const pendingB = engine.beginTransaction();
	await assert.rejects(() => engine.commitTransaction(a), { name: DatabaseErrors.UniqueConstraintViolation });
	const b = await pendingB;
	await engine.executeInTransaction(b, "INSERT INTO items VALUES ('B', 'b')");
	// Kysely and DatabaseBase both attempt rollback when commit throws.
	await engine.rollbackTransaction(a);
	await engine.commitTransaction(b);
	assert.deepEqual(await engine.query('SELECT id FROM items ORDER BY id'), [{ id: 'B' }, { id: 'original' }]);
});

test('closed handles cannot query, write, or commit the next transaction', { timeout: 10_000 }, async () => {
	const engine = await setup();
	const a = await engine.beginTransaction();
	await engine.commitTransaction(a);
	const b = await engine.beginTransaction();
	await engine.executeInTransaction(b, "INSERT INTO items VALUES ('B', 'b')");
	await assert.rejects(() => engine.queryInTransaction(a, 'SELECT * FROM items'));
	await assert.rejects(() => engine.executeInTransaction(a, "INSERT INTO items VALUES ('A', 'a')"));
	await assert.rejects(() => engine.commitTransaction(a));
	await engine.rollbackTransaction(a);
	await engine.rollbackTransaction(b);
	assert.deepEqual(await engine.query('SELECT * FROM items'), []);
});

test('a foreign or fabricated handle cannot operate on an engine transaction', { timeout: 10_000 }, async () => {
	const engine = await setup();
	const other = await setup();
	const a = await engine.beginTransaction();
	await engine.executeInTransaction(a, "INSERT INTO items VALUES ('A', 'a')");
	for (const invalid of [a, {}, undefined]) {
		await assert.rejects(() => other.queryInTransaction(invalid, 'SELECT * FROM items'));
		await assert.rejects(() => other.executeInTransaction(invalid, 'DELETE FROM items'));
		await assert.rejects(() => other.commitTransaction(invalid));
		await assert.rejects(() => other.rollbackTransaction(invalid));
	}
	await engine.commitTransaction(a);
	assert.deepEqual(await engine.query('SELECT id FROM items'), [{ id: 'A' }]);
});

test('a failed begin rejects without leaving subsequent operations waiting', { timeout: 10_000 }, async () => {
	class FailFirstBegin extends PGlite {
		private fail = true;
		override async transaction<T>(callback: (tx: Transaction) => Promise<T>): Promise<T> {
			if (this.fail) {
				this.fail = false;
				throw new Error('injected BEGIN failure');
			}
			return super.transaction(callback);
		}
	}
	const engine = await setup((directory) => new FailFirstBegin(directory));
	await assert.rejects(() => engine.beginTransaction(), { name: DatabaseErrors.QueryFailed });
	const next = await engine.beginTransaction();
	await engine.executeInTransaction(next, "INSERT INTO items VALUES ('next', 'next')");
	await engine.commitTransaction(next);
	assert.deepEqual(await engine.query('SELECT id FROM items'), [{ id: 'next' }]);
});
