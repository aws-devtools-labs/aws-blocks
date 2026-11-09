// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { describe, test } from 'node:test';
import { ApiError, isBlocksError } from '@aws-blocks/core';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { DatabaseErrors } from '../errors.js';
import { DsqlEngine, type DsqlPool, type DsqlPoolClient, dsqlTypeParsers, parseInt8 } from './dsql-engine.js';

describe('DSQL result types match the local engine', () => {
	test('bigint is a number when it is a safe integer and a BigInt otherwise, as PGlite returns it', async () => {
		const local = new PGlite();
		const row = (
			await local.query<{ small: unknown; big: unknown; negative: unknown; count: unknown }>(
				'SELECT 42::bigint AS small, 9007199254740993::bigint AS big, -7::bigint AS negative, count(*) AS count FROM (SELECT 1) t',
			)
		).rows[0];
		await local.close();
		const parse = dsqlTypeParsers.getTypeParser(20);
		assert.strictEqual(parse('42'), row.small);
		assert.strictEqual(parse('9007199254740993'), row.big);
		assert.strictEqual(parse('-7'), row.negative);
		assert.strictEqual(parse('1'), row.count);
		assert.strictEqual(typeof row.small, 'number');
		assert.strictEqual(typeof row.big, 'bigint');
		assert.strictEqual(parseInt8('9007199254740991'), Number.MAX_SAFE_INTEGER);
		assert.strictEqual(parseInt8('9007199254740992'), 9007199254740992n);
	});
});

function serverError(code: string, message: string): pg.DatabaseError {
	return Object.assign(new pg.DatabaseError(message, message.length, 'error'), { code });
}

class StubClient implements DsqlPoolClient {
	readonly statements: string[] = [];
	readonly releases: (Error | undefined)[] = [];
	/** Statement text → the error its next run throws, once. */
	readonly failOn = new Map<string, Error>();

	async query(sql: string): Promise<pg.QueryResult> {
		this.statements.push(sql);
		const error = this.failOn.get(sql);
		if (error) {
			this.failOn.delete(sql);
			throw error;
		}
		return { rows: [], rowCount: 0, command: sql, oid: 0, fields: [] };
	}

	release(err?: Error): void {
		this.releases.push(err);
	}
}

// One client, handed out again on every connect(): what pg-pool does with a released client.
class StubPool implements DsqlPool {
	readonly client = new StubClient();
	async connect(): Promise<DsqlPoolClient> {
		return this.client;
	}
	query(sql: string): Promise<pg.QueryResult> {
		return this.client.query(sql);
	}
	async end(): Promise<void> {}
}

function stubbedEngine(): { engine: DsqlEngine; client: StubClient } {
	const pool = new StubPool();
	const engine = new DsqlEngine({ endpoint: 'stub', role: 'app', getAuthToken: async () => 'token', pool });
	return { engine, client: pool.client };
}

describe('DSQL transaction handle lifecycle', () => {
	test('a failed COMMIT frees the client once', async () => {
		const { engine, client } = stubbedEngine();
		const first = await engine.beginTransaction();
		client.failOn.set('COMMIT', serverError('40001', 'could not serialize access'));
		await assert.rejects(engine.commitTransaction(first), (e: unknown) =>
			isBlocksError(e, DatabaseErrors.SerializationFailure),
		);
		assert.deepStrictEqual(
			client.releases,
			[undefined],
			'a server error returns the client to the pool intact, once',
		);

		// The next borrower: DatabaseCore's rollback of `first` runs while this transaction is open.
		const second = await engine.beginTransaction();
		await engine.executeInTransaction(second, 'INSERT INTO t VALUES (1)');
		await engine.rollbackTransaction(first);
		assert.deepStrictEqual(client.statements, ['BEGIN', 'COMMIT', 'BEGIN', 'INSERT INTO t VALUES (1)']);
		assert.strictEqual(
			client.releases.length,
			1,
			'a later rollback of that handle does not touch the next borrower',
		);
		await engine.commitTransaction(second);
		assert.deepStrictEqual(client.statements.slice(4), ['COMMIT']);
		assert.strictEqual(client.releases.length, 2);
	});

	test('rollbackTransaction is idempotent and a statement on an ended handle is refused', async () => {
		const { engine, client } = stubbedEngine();
		const handle = await engine.beginTransaction();
		await engine.rollbackTransaction(handle);
		await engine.rollbackTransaction(handle);
		assert.deepStrictEqual(client.statements, ['BEGIN', 'ROLLBACK']);
		assert.strictEqual(client.releases.length, 1);
		await assert.rejects(engine.queryInTransaction(handle, 'SELECT 1'), (e: unknown) =>
			isBlocksError(e, DatabaseErrors.TransactionFailed),
		);
		assert.deepStrictEqual(client.statements, ['BEGIN', 'ROLLBACK'], 'nothing ran on the freed client');
	});

	test('a BEGIN that fails hands the client back to the pool with the error, so the pool discards it', async () => {
		const { engine, client } = stubbedEngine();
		client.failOn.set('BEGIN', new Error('Connection terminated unexpectedly'));
		await assert.rejects(engine.beginTransaction(), (e: unknown) => isBlocksError(e, DatabaseErrors.QueryFailed));
		assert.strictEqual(client.releases.length, 1);
		assert.ok(client.releases[0] instanceof Error);
	});

	test('a COMMIT that fails with a lost connection discards the client', async () => {
		const { engine, client } = stubbedEngine();
		client.failOn.set('COMMIT', new Error('Connection terminated unexpectedly'));
		const handle = await engine.beginTransaction();
		await assert.rejects(engine.commitTransaction(handle), (e: unknown) =>
			isBlocksError(e, DatabaseErrors.QueryFailed),
		);
		assert.ok(client.releases[0] instanceof Error);
		await engine.rollbackTransaction(handle);
		assert.strictEqual(client.releases.length, 1);
	});
});

describe('DSQL stale schema cache', () => {
	// The message form is a DSQL fact a live cluster pinned; only a cluster can verify it stays so.
	test('a 40001 that carries OC001 in its message is retried once and then succeeds', async () => {
		const { engine, client } = stubbedEngine();
		client.failOn.set(
			'SELECT 1',
			serverError('40001', 'ERROR: schema has been updated by another transaction, please retry: (OC001)'),
		);
		assert.deepStrictEqual(await engine.query('SELECT 1'), []);
		assert.deepStrictEqual(client.statements, ['SELECT 1', 'SELECT 1']);
	});

	test('a plain 40001 is not retried and surfaces as SerializationFailure', async () => {
		const { engine, client } = stubbedEngine();
		client.failOn.set('SELECT 1', serverError('40001', 'could not serialize access due to a concurrent update'));
		await assert.rejects(engine.query('SELECT 1'), (e: unknown) =>
			isBlocksError(e, DatabaseErrors.SerializationFailure),
		);
		assert.deepStrictEqual(client.statements, ['SELECT 1']);
	});

	test('inside a transaction a 40001 with OC001 is not retried: the server has aborted the transaction', async () => {
		const { engine, client } = stubbedEngine();
		const handle = await engine.beginTransaction();
		client.failOn.set(
			'SELECT 1',
			serverError('40001', 'ERROR: schema has been updated by another transaction, please retry: (OC001)'),
		);
		await assert.rejects(
			engine.queryInTransaction(handle, 'SELECT 1'),
			(e: unknown) =>
				isBlocksError(e, DatabaseErrors.SerializationFailure) && e instanceof ApiError && e.retriable,
		);
		assert.deepStrictEqual(client.statements, ['BEGIN', 'SELECT 1'], 'no retry on the aborted transaction');
	});
});

describe('DSQL lost connection', () => {
	test('an autocommit statement whose connection the server closed is run once more on another', async () => {
		const { engine, client } = stubbedEngine();
		client.failOn.set('SELECT 1', serverError('08006', 'terminating connection due to idle timeout'));
		assert.deepStrictEqual(await engine.query('SELECT 1'), []);
		assert.deepStrictEqual(client.statements, ['SELECT 1', 'SELECT 1']);
	});

	test('inside a transaction a connection failure is not retried: the transaction is gone with the connection', async () => {
		const { engine, client } = stubbedEngine();
		const handle = await engine.beginTransaction();
		client.failOn.set('SELECT 1', serverError('08006', 'terminating connection due to idle timeout'));
		await assert.rejects(engine.queryInTransaction(handle, 'SELECT 1'), (e: unknown) =>
			isBlocksError(e, DatabaseErrors.ConnectionFailed),
		);
		assert.deepStrictEqual(client.statements, ['BEGIN', 'SELECT 1']);
	});
});
