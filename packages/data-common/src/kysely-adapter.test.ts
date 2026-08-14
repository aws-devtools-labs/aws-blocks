// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert';
import { createKyselyAdapter } from './kysely-adapter.js';
import type { DatabaseEngine, TransactionHandle } from './engine.js';

// ─── Kysely adapter — transaction handle contract ───────────────────────────
// The adapter must drive transactions through the engine's handle-based API
// (beginTransaction / queryInTransaction / commitTransaction) so all statements
// share a connection scope. Issuing bare BEGIN/COMMIT via engine.query() is
// non-atomic on pooled and stateless engines.

interface Call { method: string; sql?: string }

/** Records every engine call so we can assert how Kysely drove the engine. */
class RecordingEngine implements DatabaseEngine {
  calls: Call[] = [];
  private handleSeq = 0;

  async query<T>(sql: string): Promise<T[]> {
    this.calls.push({ method: 'query', sql });
    return [] as T[];
  }
  async execute(sql: string): Promise<{ rowCount: number }> {
    this.calls.push({ method: 'execute', sql });
    return { rowCount: 0 };
  }
  async beginTransaction(): Promise<TransactionHandle> {
    this.calls.push({ method: 'beginTransaction' });
    return `h${++this.handleSeq}`;
  }
  async commitTransaction(): Promise<void> {
    this.calls.push({ method: 'commitTransaction' });
  }
  async rollbackTransaction(): Promise<void> {
    this.calls.push({ method: 'rollbackTransaction' });
  }
  async queryInTransaction<T>(_h: TransactionHandle, sql: string): Promise<T[]> {
    this.calls.push({ method: 'queryInTransaction', sql });
    return [] as T[];
  }
  async executeInTransaction(_h: TransactionHandle, sql: string): Promise<{ rowCount: number }> {
    this.calls.push({ method: 'executeInTransaction', sql });
    return { rowCount: 0 };
  }
  async destroy(): Promise<void> {}
}

interface Schema {
  t: { id: string; value: string };
}

test('Kysely transaction drives the engine transaction API (not bare BEGIN/COMMIT)', async () => {
  const engine = new RecordingEngine();
  const kysely = createKyselyAdapter<Schema>({ getEngine: () => engine });

  await kysely.transaction().execute(async (trx) => {
    await trx.insertInto('t').values({ id: 'a', value: 'one' }).execute();
  });

  const methods = engine.calls.map(c => c.method);

  // The transaction must be opened through the engine's handle-based API so all
  // statements run on the SAME connection/transaction scope.
  assert.ok(
    methods.includes('beginTransaction'),
    `expected engine.beginTransaction() to be used; saw calls: ${JSON.stringify(engine.calls)}`,
  );
  assert.ok(
    methods.includes('commitTransaction'),
    `expected engine.commitTransaction() to be used; saw calls: ${JSON.stringify(engine.calls)}`,
  );
  // The INSERT must run inside the transaction, not as a standalone query().
  assert.ok(
    methods.includes('executeInTransaction') || methods.includes('queryInTransaction'),
    `expected the statement to run via *InTransaction; saw calls: ${JSON.stringify(engine.calls)}`,
  );

  // BEGIN/COMMIT must NOT be issued through plain query().
  const bareTxKeywords = engine.calls.filter(
    c => c.method === 'query' && /^\s*(BEGIN|COMMIT|ROLLBACK)\b/i.test(c.sql ?? ''),
  );
  assert.strictEqual(
    bareTxKeywords.length,
    0,
    `BEGIN/COMMIT/ROLLBACK must not be issued via engine.query(); saw: ${JSON.stringify(bareTxKeywords)}`,
  );
});

test('adapter resolves an async getEngine() (the real Database contract)', async () => {
  // The public Database class exposes `async getEngine(): Promise<DatabaseEngine>`.
  // Previously the adapter passed the unresolved Promise straight into the
  // dialect, so the first query threw "this.engine.query is not a function".
  // Passing a Promise-returning getEngine must now Just Work.
  const engine = new RecordingEngine();
  const kysely = createKyselyAdapter<Schema>({
    getEngine: async () => engine,
  });

  await kysely.selectFrom('t').selectAll().execute();

  assert.ok(
    engine.calls.some(c => c.method === 'query'),
    `expected the query to reach the resolved engine; saw: ${JSON.stringify(engine.calls)}`,
  );
});

test('async getEngine() also drives transactions through the handle API', async () => {
  const engine = new RecordingEngine();
  const kysely = createKyselyAdapter<Schema>({ getEngine: async () => engine });

  await kysely.transaction().execute(async (trx) => {
    await trx.insertInto('t').values({ id: 'a', value: 'one' }).execute();
  });

  const methods = engine.calls.map(c => c.method);
  assert.ok(methods.includes('beginTransaction'), JSON.stringify(engine.calls));
  assert.ok(methods.includes('commitTransaction'), JSON.stringify(engine.calls));
  assert.ok(
    methods.includes('executeInTransaction') || methods.includes('queryInTransaction'),
    JSON.stringify(engine.calls),
  );
});

test('Kysely transaction rollback uses the engine rollback API', async () => {
  const engine = new RecordingEngine();
  const kysely = createKyselyAdapter<Schema>({ getEngine: () => engine });

  await assert.rejects(() =>
    kysely.transaction().execute(async (trx) => {
      await trx.insertInto('t').values({ id: 'b', value: 'two' }).execute();
      throw new Error('boom');
    }),
  );

  const methods = engine.calls.map(c => c.method);
  assert.ok(
    methods.includes('rollbackTransaction'),
    `expected engine.rollbackTransaction() on failure; saw calls: ${JSON.stringify(engine.calls)}`,
  );
});

test('createKyselyAdapter defers getEngine() until the first query (safe during CDK synth)', async () => {
  // The CDK-build blocks (DistributedDatabase/Database index.cdk.ts) define
  // infrastructure only and expose no usable engine — their getEngine() throws.
  // Creating the adapter at module scope (this file is loaded during `cdk synth`)
  // must NOT invoke getEngine(), otherwise synth crashes before it can run.
  let calls = 0;
  const db = {
    getEngine(): DatabaseEngine {
      calls++;
      throw new Error('getEngine() is unavailable during CDK synth');
    },
  };

  // Construction must not touch getEngine().
  const kysely = createKyselyAdapter<Schema>(db);
  assert.strictEqual(calls, 0, 'getEngine() must not be called when the adapter is created');

  // getEngine() is only reached when a query actually runs (never at synth).
  await assert.rejects(() => kysely.selectFrom('t').selectAll().execute());
  assert.strictEqual(calls, 1, 'getEngine() should be invoked lazily on first query');
});

test('getEngine() is called once per EngineConnection across begin/execute/commit', async () => {
  // begin(), executeQuery() and commit() each resolve the engine; memoization
  // must collapse them into a single getEngine() call per connection so the
  // one-engine-per-transaction guarantee holds.
  let calls = 0;
  const engine = new RecordingEngine();
  const kysely = createKyselyAdapter<Schema>({
    getEngine: () => {
      calls++;
      return engine;
    },
  });

  await kysely.transaction().execute(async (trx) => {
    await trx.insertInto('t').values({ id: 'a', value: 'one' }).execute();
  });

  assert.strictEqual(calls, 1, `expected a single memoized getEngine() call, saw ${calls}`);
});
