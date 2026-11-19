// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { describe, test } from 'node:test';
import { isBlocksError } from '@aws-cdk-blocks/core';
import type { ExecuteStatementCommandOutput } from '@aws-sdk/client-rds-data';
import { DatabaseErrors } from '../errors.js';
import { type DataApiClient, DataApiEngine, fromField, namedParameters, toField } from './data-api-engine.js';

const COORDINATES = {
	clusterArn: 'arn:aws:rds:us-east-1:123456789012:cluster:app',
	secretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:app-AbCdEf',
	database: 'app',
};
const TARGET = { resourceArn: COORDINATES.clusterArn, secretArn: COORDINATES.secretArn };

interface Call {
	command: string;
	input: Record<string, unknown>;
}

/** A stand-in for the SDK client: records each command and answers from `answers`, in order. */
function stubClient(answers: Array<Partial<ExecuteStatementCommandOutput> | { transactionId: string } | Error> = []) {
	const calls: Call[] = [];
	const waits: number[] = [];
	const client = {
		destroy: () => {},
		send: async (command: { constructor: { name: string }; input: unknown }) => {
			calls.push({ command: command.constructor.name, input: command.input as Record<string, unknown> });
			const answer = answers.shift() ?? {};
			if (answer instanceof Error) throw answer;
			return answer;
		},
	} as unknown as DataApiClient;
	// The waits are recorded and not slept.
	const wait = async (ms: number) => {
		waits.push(ms);
	};
	return { calls, waits, engine: new DataApiEngine(COORDINATES, client, wait) };
}

function serviceError(name: string, message: string): Error {
	const e = new Error(message);
	e.name = name;
	return e;
}

describe('Data API engine: parameters and values', () => {
	test('positional placeholders become named parameters, the highest number first', () => {
		const params = ['a', 2, 3.5, true, null, 'f', 'g', 'h', 'i', 'ten'];
		const { sql, parameters } = namedParameters('SELECT $1, $2, $10 WHERE x = $3', params);
		assert.strictEqual(sql, 'SELECT :p1, :p2, :p10 WHERE x = :p3');
		assert.deepStrictEqual(parameters.slice(0, 5), [
			{ name: 'p1', value: { stringValue: 'a' } },
			{ name: 'p2', value: { longValue: 2 } },
			{ name: 'p3', value: { doubleValue: 3.5 } },
			{ name: 'p4', value: { booleanValue: true } },
			{ name: 'p5', value: { isNull: true } },
		]);
		assert.deepStrictEqual(parameters[9], { name: 'p10', value: { stringValue: 'ten' } });
		assert.deepStrictEqual(namedParameters('SELECT 1'), { sql: 'SELECT 1', parameters: [] });
		// A number above the parameter count is the longest valid number and the digits after it.
		const three = ['a', 'b', 'c'];
		assert.strictEqual(namedParameters('$1 $10 $11 $2 $3x', three).sql, ':p1 :p10 :p11 :p2 :p3x');
		assert.strictEqual(namedParameters('$01 $0 $4', three).sql, '$01 $0 $4');
		assert.strictEqual(namedParameters('$10 $1 $100', new Array(10).fill(0)).sql, ':p10 :p1 :p100');
	});

	test('text in a string, a quoted identifier, a comment or a dollar-quoted body is not a placeholder', () => {
		const two = ['a', 'b'];
		const same = (sql: string) => assert.strictEqual(namedParameters(sql, two).sql, sql);
		same("SELECT 'Only $2 today', 'it''s $1'");
		same('SELECT "col$1" FROM t -- uses $2');
		same('SELECT 1 /* $1 */');
		same('DO $$ BEGIN PERFORM $1; END $$');
		same('SELECT $fn$ $2 $fn$');
		assert.strictEqual(
			namedParameters("INSERT INTO offers (label, a) VALUES ('Only $2 today', $1) -- $2", two).sql,
			"INSERT INTO offers (label, a) VALUES ('Only $2 today', :p1) -- $2",
		);
		assert.strictEqual(
			namedParameters("SELECT '$1' || $1 || $$ $2 $$ || $2", two).sql,
			"SELECT '$1' || :p1 || $$ $2 $$ || :p2",
		);
	});

	test('a Date goes as ISO text, an object as JSON text, a Buffer as a blob', () => {
		assert.deepStrictEqual(toField(new Date('2026-01-02T03:04:05.006Z')), {
			stringValue: '2026-01-02T03:04:05.006Z',
		});
		assert.deepStrictEqual(toField({ a: [1, null] }), { stringValue: '{"a":[1,null]}' });
		assert.deepStrictEqual(toField(Buffer.from('ab')), { blobValue: Buffer.from('ab') });
		assert.deepStrictEqual(toField(undefined), { isNull: true });
		assert.deepStrictEqual(toField(new Uint8Array([1, 2])), { blobValue: new Uint8Array([1, 2]) });
		assert.deepStrictEqual(toField(42n), { longValue: 42 });
		assert.deepStrictEqual(toField(2n ** 60n), { stringValue: '1152921504606846976' });
	});

	test('a field becomes the value pg returns for the column type', () => {
		assert.strictEqual(fromField({ isNull: true }), null);
		assert.strictEqual(fromField({ stringValue: 'hi' }, 'text'), 'hi');
		assert.strictEqual(fromField({ longValue: 99 }, 'int8'), 99);
		assert.strictEqual(fromField({ stringValue: '12.50' }, 'numeric'), '12.50');
		assert.deepStrictEqual(fromField({ stringValue: '{"n":3}' }, 'jsonb'), { n: 3 });
		assert.strictEqual(fromField({ stringValue: '{"n":3}' }, 'text'), '{"n":3}');
		assert.strictEqual(fromField({ stringValue: 'not json' }, 'json'), 'not json');
		assert.deepStrictEqual(fromField({ arrayValue: { stringValues: ['a', 'b'] } }, '_text'), ['a', 'b']);
		assert.deepStrictEqual(fromField({ arrayValue: { stringValues: ['{"a":1}'] } }, '_jsonb'), [{ a: 1 }]);
		assert.deepStrictEqual(fromField({ arrayValue: { longValues: [1, 2] } }, '_int4'), [1, 2]);
		assert.deepStrictEqual(fromField({ blobValue: new Uint8Array([97, 98]) }, 'bytea'), Buffer.from('ab'));
	});
});

describe('Data API engine: statements', () => {
	test('binds positional parameters without rewriting unquoted identifiers containing dollar signs', async () => {
		const { engine, calls } = stubClient();
		const alias = '\u00e9$2';
		await engine.query(`SELECT CAST($1 AS integer) AS value$1, CAST($2 AS integer) AS ${alias}`, [7, 8]);
		assert.strictEqual(
			calls[0].input.sql,
			`SELECT CAST(:p1 AS integer) AS value$1, CAST(:p2 AS integer) AS ${alias}`,
		);
		assert.deepStrictEqual(calls[0].input.parameters, [
			{ name: 'p1', value: { longValue: 7 } },
			{ name: 'p2', value: { longValue: 8 } },
		]);
	});

	test('binds parameters after an unquoted identifier ending in a dollar-quote tag', async () => {
		const { engine, calls } = stubClient();
		await engine.query('SELECT 1 AS value$tag$, CAST($1 AS integer) AS bound', [7]);
		assert.strictEqual(calls[0].input.sql, 'SELECT 1 AS value$tag$, CAST(:p1 AS integer) AS bound');
	});

	test('a query sends one statement with the coordinates and returns rows keyed by column name', async () => {
		const { engine, calls } = stubClient([
			{
				columnMetadata: [
					{ name: 'id', typeName: 'int4' },
					{ name: 'doc', typeName: 'jsonb' },
				],
				records: [[{ longValue: 1 }, { stringValue: '{"k":"v"}' }]],
			},
		]);
		const rows = await engine.query('SELECT id, doc FROM t WHERE id = $1', [1]);
		assert.deepStrictEqual(rows, [{ id: 1, doc: { k: 'v' } }]);
		assert.deepStrictEqual(calls, [
			{
				command: 'ExecuteStatementCommand',
				input: {
					...TARGET,
					database: 'app',
					sql: 'SELECT id, doc FROM t WHERE id = :p1',
					parameters: [{ name: 'p1', value: { longValue: 1 } }],
					includeResultMetadata: true,
				},
			},
		]);
	});

	test('the row count is the rows the statement changed, with or without RETURNING', async () => {
		const { engine } = stubClient([
			{ numberOfRecordsUpdated: 3 },
			{ numberOfRecordsUpdated: 1, columnMetadata: [{ name: 'id' }], records: [[{ longValue: 7 }]] },
			{ columnMetadata: [{ name: 'n' }], records: [[{ longValue: 5 }]] },
		]);
		assert.deepStrictEqual(await engine.execute('UPDATE t SET n = 1'), { rowCount: 3 });
		assert.deepStrictEqual(await engine.queryCounted('INSERT INTO t DEFAULT VALUES RETURNING id'), {
			rows: [{ id: 7 }],
			rowCount: 1,
		});
		assert.deepStrictEqual(await engine.queryCounted('SELECT count(*) AS n FROM t'), {
			rows: [{ n: 5 }],
			rowCount: 0,
		});
	});

	test('a statement with RETURNING counts the rows it returned when the service reports none', async () => {
		const returned = { columnMetadata: [{ name: 'id' }], records: [[{ longValue: 1 }], [{ longValue: 2 }]] };
		const { engine } = stubClient([
			{ ...returned, numberOfRecordsUpdated: 0 },
			{ ...returned, numberOfRecordsUpdated: 0 },
			{ numberOfRecordsUpdated: 0 },
		]);
		assert.deepStrictEqual(await engine.execute('DELETE FROM t WHERE done RETURNING id'), { rowCount: 2 });
		assert.strictEqual((await engine.queryCounted('SELECT id FROM t')).rowCount, 0);
		assert.deepStrictEqual(await engine.execute('DELETE FROM t WHERE false RETURNING id'), { rowCount: 0 });
	});

	test('a paused cluster: the statement is sent again until the cluster answers, inside the request', async () => {
		const resuming = () => serviceError('DatabaseResumingException', 'The Aurora DB instance is resuming.');
		const { engine, calls, waits } = stubClient([resuming(), resuming(), { numberOfRecordsUpdated: 1 }]);
		assert.deepStrictEqual(await engine.execute('UPDATE t SET n = 1'), { rowCount: 1 });
		assert.strictEqual(calls.length, 3);
		assert.deepStrictEqual(waits, [3000, 3000]);

		// A cluster that does not come back ends as ConnectionFailed, after 24 seconds of waits.
		const never = stubClient(Array.from({ length: 12 }, resuming));
		await assert.rejects(never.engine.query('SELECT 1'), (e: unknown) =>
			isBlocksError(e, DatabaseErrors.ConnectionFailed),
		);
		assert.strictEqual(
			never.waits.reduce((a, b) => a + b, 0),
			24_000,
		);
		// BEGIN waits too; a statement in the transaction does not.
		const inTx = stubClient([resuming(), { transactionId: 'tx1' }, resuming()]);
		const tx = await inTx.engine.beginTransaction();
		await assert.rejects(inTx.engine.queryInTransaction(tx, 'SELECT 1'), (e: unknown) =>
			isBlocksError(e, DatabaseErrors.ConnectionFailed),
		);
		assert.deepStrictEqual(inTx.waits, [3000]);
	});

	test('a refused credential is tried three times outside a transaction', async () => {
		const refused = () =>
			serviceError('BadRequestException', 'FATAL: password authentication failed for user "app"');
		const passes = stubClient([refused(), { numberOfRecordsUpdated: 1 }]);
		assert.deepStrictEqual(await passes.engine.execute('UPDATE t SET n = 1'), { rowCount: 1 });
		assert.deepStrictEqual(passes.waits, [3000]);

		const stays = stubClient([refused(), refused(), refused()]);
		await assert.rejects(stays.engine.query('SELECT 1'), (e: unknown) =>
			isBlocksError(e, DatabaseErrors.ConnectionFailed),
		);
		assert.deepStrictEqual(stays.waits, [3000, 6000]);
		assert.strictEqual(stays.calls.length, 3);
	});

	test('a transaction: every statement carries the id, and the handle is settled by the commit', async () => {
		const { engine, calls } = stubClient([{ transactionId: 'tx1' }, { numberOfRecordsUpdated: 1 }, {}]);
		const tx = await engine.beginTransaction();
		await engine.executeInTransaction(tx, 'INSERT INTO t VALUES ($1)', ['a']);
		await engine.commitTransaction(tx);
		assert.deepStrictEqual(
			calls.map((c) => [c.command, c.input.transactionId]),
			[
				['BeginTransactionCommand', undefined],
				['ExecuteStatementCommand', 'tx1'],
				['CommitTransactionCommand', 'tx1'],
			],
		);
		assert.deepStrictEqual(calls[0].input, { ...TARGET, database: 'app' });
		// A rollback after the commit does nothing; a statement on the settled handle is refused.
		await engine.rollbackTransaction(tx);
		assert.strictEqual(calls.length, 3);
		await assert.rejects(engine.queryInTransaction(tx, 'SELECT 1'), (e: unknown) =>
			isBlocksError(e, DatabaseErrors.TransactionFailed),
		);
	});

	test('transaction modes are the first statement of the transaction', async () => {
		const { engine, calls } = stubClient([{ transactionId: 'tx1' }, {}]);
		await engine.beginTransaction({ isolationLevel: 'serializable', accessMode: 'read only' });
		assert.strictEqual(calls[1].input.sql, 'set transaction isolation level serializable read only');
		assert.strictEqual(calls[1].input.transactionId, 'tx1');
	});

	test('a failed commit settles the handle, and a rollback that fails does not throw', async () => {
		const failedCommit = stubClient([
			{ transactionId: 'tx1' },
			serviceError('DatabaseErrorException', 'ERROR: could not serialize access; SQLState: 40001'),
		]);
		const tx = await failedCommit.engine.beginTransaction();
		await assert.rejects(failedCommit.engine.commitTransaction(tx), (e: unknown) =>
			isBlocksError(e, DatabaseErrors.SerializationFailure),
		);
		// The commit may not have reached the server, so the engine rolls back; a later rollback does nothing.
		assert.deepStrictEqual(
			failedCommit.calls.map((c) => c.command),
			['BeginTransactionCommand', 'CommitTransactionCommand', 'RollbackTransactionCommand'],
		);
		await failedCommit.engine.rollbackTransaction(tx);
		assert.strictEqual(failedCommit.calls.length, 3);

		const failedRollback = stubClient([{ transactionId: 'tx2' }, serviceError('BadRequestException', 'gone')]);
		await failedRollback.engine.rollbackTransaction(await failedRollback.engine.beginTransaction());
	});
});

describe('Data API engine: errors', () => {
	const failing = (error: Error) => stubClient([error]).engine.query('SELECT 1');

	test('the SQLSTATE at the end of the message names the error', async () => {
		await assert.rejects(
			failing(
				serviceError(
					'DatabaseErrorException',
					'ERROR: duplicate key value violates unique constraint "t_pkey"\n  Detail: Key (id)=(SQLState: 40001) already exists.; SQLState: 23505',
				),
			),
			(e: unknown) => isBlocksError(e, DatabaseErrors.UniqueConstraintViolation),
		);
		await assert.rejects(
			failing(serviceError('DatabaseErrorException', 'ERROR: null value in column "n"; SQLState: 23502')),
			(e: unknown) => isBlocksError(e, DatabaseErrors.NotNullViolation),
		);
		await assert.rejects(
			failing(serviceError('DatabaseErrorException', 'ERROR: relation "t" does not exist; SQLState: 42P01')),
			(e: unknown) => isBlocksError(e, DatabaseErrors.QueryFailed),
		);
	});

	test('a service or a writer instance that cannot answer is ConnectionFailed', async () => {
		for (const name of [
			'DatabaseUnavailableException',
			'ServiceUnavailableError',
			'InternalServerErrorException',
		]) {
			await assert.rejects(failing(serviceError(name, 'try again')), (e: unknown) =>
				isBlocksError(e, DatabaseErrors.ConnectionFailed),
			);
		}
	});

	test('inside a transaction a refused credential is not retried, and is ConnectionFailed', async () => {
		const { engine, calls } = stubClient([
			{ transactionId: 'tx1' },
			serviceError('BadRequestException', 'FATAL: password authentication failed for user "postgres"'),
		]);
		const tx = await engine.beginTransaction();
		await assert.rejects(engine.queryInTransaction(tx, 'SELECT 1'), (e: unknown) =>
			isBlocksError(e, DatabaseErrors.ConnectionFailed),
		);
		assert.strictEqual(calls.length, 2);
	});

	test('the raw service error stays on the cause and is not enumerable', async () => {
		const raw = serviceError('DatabaseErrorException', 'ERROR: boom; SQLState: XX000');
		const thrown = await failing(raw).catch((e: unknown) => e);
		assert.ok(thrown instanceof Error);
		assert.strictEqual(thrown.cause, raw);
		assert.ok(!JSON.stringify(thrown).includes('boom'));
	});
});
