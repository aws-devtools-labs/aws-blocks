// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert';
import { DataApiEngine, toField, fromField } from './data-api-engine.js';
import { DatabaseErrors } from '../errors.js';

// --- toField / fromField ---

test('toField handles null', () => {
  assert.deepStrictEqual(toField(null), { isNull: true });
});

test('toField handles string', () => {
  assert.deepStrictEqual(toField('hello'), { stringValue: 'hello' });
});

test('toField handles integer', () => {
  assert.deepStrictEqual(toField(42), { longValue: 42 });
});

test('toField handles float', () => {
  assert.deepStrictEqual(toField(3.14), { doubleValue: 3.14 });
});

test('toField handles boolean', () => {
  assert.deepStrictEqual(toField(true), { booleanValue: true });
});

test('toField handles Date', () => {
  const d = new Date('2026-01-01T00:00:00.000Z');
  assert.deepStrictEqual(toField(d), { stringValue: '2026-01-01T00:00:00.000Z' });
});

test('toField handles objects as JSON', () => {
  assert.deepStrictEqual(toField({ a: 1 }), { stringValue: '{"a":1}' });
});

test('fromField handles null', () => {
  assert.strictEqual(fromField({ isNull: true }), null);
});

test('fromField handles string', () => {
  assert.strictEqual(fromField({ stringValue: 'hi' }), 'hi');
});

test('fromField handles long', () => {
  assert.strictEqual(fromField({ longValue: 99 }), 99);
});

test('fromField handles double', () => {
  assert.strictEqual(fromField({ doubleValue: 1.5 }), 1.5);
});

test('fromField handles boolean', () => {
  assert.strictEqual(fromField({ booleanValue: false }), false);
});

// --- Mock client helper ---

function mockClient(handlers: Record<string, (input: any) => any>) {
  return {
    send(command: any) {
      const name = command.constructor.name;
      const handler = handlers[name];
      if (!handler) throw new Error(`Unexpected command: ${name}`);
      return Promise.resolve(handler(command.input));
    },
  } as any;
}

function createEngine(handlers: Record<string, (input: any) => any>) {
  return new DataApiEngine({
    resourceArn: 'arn:cluster',
    secretArn: 'arn:secret',
    database: 'testdb',
    client: mockClient(handlers),
  });
}

// --- Parameter translation ---

test('query translates $1 $2 to :p1 :p2', async () => {
  let capturedSql = '';
  const engine = createEngine({
    ExecuteStatementCommand: (input: any) => {
      capturedSql = input.sql;
      return { records: [], columnMetadata: [] };
    },
  });
  await engine.query('SELECT * FROM t WHERE a = $1 AND b = $2', ['x', 'y']);
  assert.strictEqual(capturedSql, 'SELECT * FROM t WHERE a = :p1 AND b = :p2');
});

test('query translates repeated $1 placeholders (all occurrences)', async () => {
  let capturedSql = '';
  const engine = createEngine({
    ExecuteStatementCommand: (input: any) => {
      capturedSql = input.sql;
      return { records: [], columnMetadata: [] };
    },
  });
  await engine.query('SELECT * FROM t WHERE a = $1 OR b = $1', ['x']);
  assert.strictEqual(capturedSql, 'SELECT * FROM t WHERE a = :p1 OR b = :p1');
});

test('query does not mangle $10 when replacing $1', async () => {
  let capturedSql = '';
  let capturedParams: any[] = [];
  const engine = createEngine({
    ExecuteStatementCommand: (input: any) => {
      capturedSql = input.sql;
      capturedParams = input.parameters;
      return { records: [], columnMetadata: [] };
    },
  });
  const params = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];
  await engine.query(
    'SELECT * FROM t WHERE c1=$1 AND c2=$2 AND c3=$3 AND c4=$4 AND c5=$5 AND c6=$6 AND c7=$7 AND c8=$8 AND c9=$9 AND c10=$10',
    params,
  );
  assert.ok(capturedSql.includes(':p10'), `Expected :p10 in: ${capturedSql}`);
  assert.ok(!capturedSql.includes('$'), `No $ should remain in: ${capturedSql}`);
  assert.strictEqual(capturedParams.length, 10);
});

// --- query ---

test('query maps records to row objects', async () => {
  const engine = createEngine({
    ExecuteStatementCommand: () => ({
      columnMetadata: [{ name: 'id' }, { name: 'value' }],
      records: [
        [{ stringValue: 'a' }, { stringValue: 'one' }],
      ],
    }),
  });
  const rows = await engine.query('SELECT * FROM t');
  assert.deepStrictEqual(rows, [{ id: 'a', value: 'one' }]);
});

test('query returns empty array for no records', async () => {
  const engine = createEngine({
    ExecuteStatementCommand: () => ({ records: [], columnMetadata: [] }),
  });
  const rows = await engine.query('SELECT * FROM t');
  assert.deepStrictEqual(rows, []);
});

// --- execute ---

test('execute returns rowCount', async () => {
  const engine = createEngine({
    ExecuteStatementCommand: () => ({ numberOfRecordsUpdated: 3 }),
  });
  const result = await engine.execute('UPDATE t SET x = 1');
  assert.strictEqual(result.rowCount, 3);
});

// --- error translation ---

test('BadRequestException with unique constraint maps to UniqueConstraintViolation', async () => {
  const engine = createEngine({
    ExecuteStatementCommand: () => {
      const err = new Error('duplicate key value violates unique constraint');
      err.name = 'BadRequestException';
      throw err;
    },
  });
  await assert.rejects(
    () => engine.execute('INSERT INTO t VALUES (1)'),
    (err: Error) => {
      assert.strictEqual(err.name, DatabaseErrors.UniqueConstraintViolation);
      return true;
    }
  );
});

test('non-BadRequestException with unique constraint message maps to UniqueConstraintViolation', async () => {
  const engine = createEngine({
    ExecuteStatementCommand: () => {
      const err = new Error('ERROR: duplicate key value violates unique constraint "t_pkey"; SQLState: 23505');
      err.name = 'DatabaseError';
      throw err;
    },
  });
  await assert.rejects(
    () => engine.execute('INSERT INTO t VALUES (1)'),
    (err: Error) => {
      assert.strictEqual(err.name, DatabaseErrors.UniqueConstraintViolation);
      return true;
    }
  );
});

test('BadRequestException without unique constraint maps to QueryFailed', async () => {
  const engine = createEngine({
    ExecuteStatementCommand: () => {
      const err = new Error('syntax error');
      err.name = 'BadRequestException';
      throw err;
    },
  });
  await assert.rejects(
    () => engine.query('BAD SQL'),
    (err: Error) => {
      assert.strictEqual(err.name, DatabaseErrors.QueryFailed);
      return true;
    }
  );
});

test('ServiceUnavailableException maps to ConnectionFailed', async () => {
  const engine = createEngine({
    ExecuteStatementCommand: () => {
      const err = new Error('service unavailable');
      err.name = 'ServiceUnavailableException';
      throw err;
    },
  });
  await assert.rejects(
    () => engine.query('SELECT 1'),
    (err: Error) => {
      assert.strictEqual(err.name, DatabaseErrors.ConnectionFailed);
      return true;
    }
  );
});

// --- transaction lifecycle ---

test('transaction lifecycle: begin, execute, commit', async () => {
  const calls: string[] = [];
  const engine = createEngine({
    BeginTransactionCommand: () => { calls.push('begin'); return { transactionId: 'txn-1' }; },
    ExecuteStatementCommand: (input: any) => {
      calls.push(`exec:${input.transactionId || 'none'}`);
      return { numberOfRecordsUpdated: 1 };
    },
    CommitTransactionCommand: (input: any) => { calls.push(`commit:${input.transactionId}`); return {}; },
  });

  const handle = await engine.beginTransaction();
  assert.strictEqual(handle, 'txn-1');
  await engine.executeInTransaction(handle, 'INSERT INTO t VALUES (1)');
  await engine.commitTransaction(handle);

  assert.deepStrictEqual(calls, ['begin', 'exec:txn-1', 'commit:txn-1']);
});

test('transaction rollback', async () => {
  const calls: string[] = [];
  const engine = createEngine({
    BeginTransactionCommand: () => { calls.push('begin'); return { transactionId: 'txn-2' }; },
    RollbackTransactionCommand: (input: any) => { calls.push(`rollback:${input.transactionId}`); return {}; },
  });

  const handle = await engine.beginTransaction();
  await engine.rollbackTransaction(handle);

  assert.deepStrictEqual(calls, ['begin', 'rollback:txn-2']);
});

test('queryInTransaction passes transactionId', async () => {
  let capturedTxnId = '';
  const engine = createEngine({
    BeginTransactionCommand: () => ({ transactionId: 'txn-3' }),
    ExecuteStatementCommand: (input: any) => {
      capturedTxnId = input.transactionId;
      return { records: [[{ stringValue: 'a' }]], columnMetadata: [{ name: 'id' }] };
    },
    CommitTransactionCommand: () => ({}),
  });

  const handle = await engine.beginTransaction();
  const rows = await engine.queryInTransaction(handle, 'SELECT * FROM t');
  assert.strictEqual(capturedTxnId, 'txn-3');
  assert.deepStrictEqual(rows, [{ id: 'a' }]);
});

// ─── Data API — SQLState-based error classification ─────────────────────────
// Error messages from the RDS Data API carry SQLState codes (e.g. "...; SQLState:
// 40001"). The translator must parse these and map by code so callers can
// distinguish retryable serialization conflicts from generic failures.
// Error shapes below are from a live Aurora Postgres cluster (RDS Data API).

const SERIALIZATION_FAILURE_NAME = 'SerializationFailureException';

test('Data API serialization failure (SQLState 40001) maps to a distinct serialization error', async () => {
  const engine = createEngine({
    ExecuteStatementCommand: () => {
      const err = new Error(
        'ERROR: could not serialize access due to read/write dependencies among transactions; Hint: The transaction might succeed if retried.; SQLState: 40001',
      );
      err.name = 'DatabaseErrorException';
      throw err;
    },
  });
  await assert.rejects(
    () => engine.execute('UPDATE accounts SET v = 1 WHERE id = $1', ['a']),
    (err: Error) => {
      assert.notStrictEqual(err.name, DatabaseErrors.QueryFailed, 'must not be a generic QueryFailed');
      assert.strictEqual(err.name, SERIALIZATION_FAILURE_NAME);
      return true;
    },
  );
});

test('serialization failure surfaced on CommitTransaction (SQLState 40001) is classified', async () => {
  const engine = createEngine({
    BeginTransactionCommand: () => ({ transactionId: 'txn-ser' }),
    ExecuteStatementCommand: () => ({ numberOfRecordsUpdated: 1 }),
    CommitTransactionCommand: () => {
      const err = new Error(
        'ERROR: could not serialize access due to read/write dependencies among transactions; SQLState: 40001',
      );
      err.name = 'DatabaseErrorException';
      throw err;
    },
  });
  const handle = await engine.beginTransaction();
  await engine.executeInTransaction(handle, 'UPDATE t SET v = 1 WHERE id = $1', ['a']);
  await assert.rejects(
    () => engine.commitTransaction(handle),
    (err: Error) => {
      assert.strictEqual(err.name, SERIALIZATION_FAILURE_NAME);
      return true;
    },
  );
});

test('Data API unique violation (DatabaseErrorException, SQLState 23505) maps to UniqueConstraintViolation', async () => {
  // Confirms the real exception name is DatabaseErrorException (not BadRequestException),
  // and code-based classification keeps unique-violation mapping working.
  const engine = createEngine({
    ExecuteStatementCommand: () => {
      const err = new Error(
        'ERROR: duplicate key value violates unique constraint "items_pkey"; SQLState: 23505',
      );
      err.name = 'DatabaseErrorException';
      throw err;
    },
  });
  await assert.rejects(
    () => engine.execute('INSERT INTO t VALUES ($1)', ['dup']),
    (err: Error) => {
      assert.strictEqual(err.name, DatabaseErrors.UniqueConstraintViolation);
      return true;
    },
  );
});

test('a genuine non-serialization query error still maps to QueryFailed', async () => {
  const engine = createEngine({
    ExecuteStatementCommand: () => {
      const err = new Error('ERROR: syntax error at or near "SELCT"; SQLState: 42601');
      err.name = 'DatabaseErrorException';
      throw err;
    },
  });
  await assert.rejects(
    () => engine.query('SELCT 1'),
    (err: Error) => {
      assert.strictEqual(err.name, DatabaseErrors.QueryFailed);
      return true;
    },
  );
});

test('Data API auto-pause resume error (DatabaseResumingException) maps to ConnectionFailed', async () => {
  // A scale-to-zero cluster (minCapacity: 0) auto-pauses after ~5 minutes idle.
  // The first Data API call wakes it and fails with DatabaseResumingException —
  // transient, and retryable. Classifying it as QueryFailed hides that from
  // callers (notably the migration Lambda's retry helper), so a deploy against a
  // paused cluster fails outright. The message carries no SQLState.
  const engine = createEngine({
    ExecuteStatementCommand: () => {
      const err = new Error(
        'The Aurora DB instance db-XXXXXXXXXXXXXXXXXXXXXXXXXX is resuming after being auto-paused. Please wait a few seconds and try again.',
      );
      err.name = 'DatabaseResumingException';
      throw err;
    },
  });
  await assert.rejects(
    () => engine.execute('CREATE TABLE IF NOT EXISTS _migrations (id SERIAL PRIMARY KEY)'),
    (err: Error) => {
      assert.strictEqual(err.name, DatabaseErrors.ConnectionFailed);
      return true;
    },
  );
});
