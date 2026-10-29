// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test } from 'node:test';
import assert from 'node:assert';
import { RLSEnabledDatabase } from './database.js';
import { sql } from '@aws-blocks/data-common';
import type { DatabaseEngine, TransactionHandle } from '@aws-blocks/data-common';

/** Creates a mock engine that records all calls for assertion. */
function createMockEngine() {
  const calls: { method: string; args: unknown[] }[] = [];
  const handle = Symbol('txHandle');

  const engine: DatabaseEngine = {
    async query<T>(sql: string, params?: unknown[]) {
      calls.push({ method: 'query', args: [sql, params] });
      return [] as T[];
    },
    async execute(sql: string, params?: unknown[]) {
      calls.push({ method: 'execute', args: [sql, params] });
      return { rowCount: 0 };
    },
    async beginTransaction() {
      calls.push({ method: 'beginTransaction', args: [] });
      return handle;
    },
    async commitTransaction(h: TransactionHandle) {
      calls.push({ method: 'commitTransaction', args: [h] });
    },
    async rollbackTransaction(h: TransactionHandle) {
      calls.push({ method: 'rollbackTransaction', args: [h] });
    },
    async queryInTransaction<T>(h: TransactionHandle, sql: string, params?: unknown[]) {
      calls.push({ method: 'queryInTransaction', args: [h, sql, params] });
      return [{ id: '1' }] as T[];
    },
    async executeInTransaction(h: TransactionHandle, sql: string, params?: unknown[]) {
      calls.push({ method: 'executeInTransaction', args: [h, sql, params] });
      return { rowCount: 1 };
    },
    async destroy() {
      calls.push({ method: 'destroy', args: [] });
    },
  };

  return { engine, calls, handle };
}

test('withRLS: query wraps in transaction with SET LOCAL ROLE + set_config', async () => {
  const { engine, calls } = createMockEngine();
  const db = new RLSEnabledDatabase(engine);

  await db.withRLS({ userId: 'user-123' }).query(sql`SELECT * FROM todos`);

  assert.strictEqual(calls[0].method, 'beginTransaction');
  assert.strictEqual(calls[1].method, 'executeInTransaction');
  assert.strictEqual((calls[1].args as any[])[1], 'SET LOCAL ROLE authenticated');
  assert.strictEqual(calls[2].method, 'executeInTransaction');
  assert.strictEqual((calls[2].args as any[])[1], `SELECT set_config('request.jwt.claims', $1, true)`);
  const claimsJson = (calls[2].args as any[])[2][0];
  const claims = JSON.parse(claimsJson);
  assert.strictEqual(claims.sub, 'user-123');
  assert.strictEqual(claims.role, 'authenticated');
  assert.strictEqual(calls[3].method, 'queryInTransaction');
  assert.strictEqual(calls[4].method, 'commitTransaction');
});

test('withRLS: execute wraps in transaction with RLS context', async () => {
  const { engine, calls } = createMockEngine();
  const db = new RLSEnabledDatabase(engine);

  await db.withRLS({ userId: 'user-456' }).execute(sql`DELETE FROM todos WHERE id = ${'todo-1'}`);

  assert.strictEqual(calls[0].method, 'beginTransaction');
  assert.strictEqual(calls[1].method, 'executeInTransaction'); // SET LOCAL ROLE
  assert.strictEqual(calls[2].method, 'executeInTransaction'); // set_config
  assert.strictEqual(calls[3].method, 'executeInTransaction'); // actual DELETE
  assert.strictEqual(calls[4].method, 'commitTransaction');
});

test('withRLS: transaction sets RLS context then delegates to callback', async () => {
  const { engine, calls } = createMockEngine();
  const db = new RLSEnabledDatabase(engine);

  await db.withRLS({ userId: 'user-789' }).transaction(async (tx) => {
    await tx.query(sql`SELECT * FROM todos`);
  });

  assert.strictEqual(calls[0].method, 'beginTransaction');
  assert.strictEqual(calls[1].method, 'executeInTransaction'); // SET LOCAL ROLE
  assert.strictEqual(calls[2].method, 'executeInTransaction'); // set_config
  assert.strictEqual(calls[3].method, 'queryInTransaction');   // user's query
  assert.strictEqual(calls[4].method, 'commitTransaction');
});

test('withRLS: custom role "anon" is allowed', async () => {
  const { engine, calls } = createMockEngine();
  const db = new RLSEnabledDatabase(engine);

  await db.withRLS({ userId: 'anon-user', role: 'anon' }).query(sql`SELECT * FROM public_data`);

  assert.strictEqual((calls[1].args as any[])[1], 'SET LOCAL ROLE anon');
  const claimsJson = (calls[2].args as any[])[2][0];
  assert.strictEqual(JSON.parse(claimsJson).role, 'anon');
});

test('withRLS: invalid role throws', async () => {
  const { engine } = createMockEngine();
  const db = new RLSEnabledDatabase(engine);

  await assert.rejects(
    () => db.withRLS({ userId: 'user', role: 'superuser' }).query(sql`SELECT 1`),
    (err: Error) => {
      assert.match(err.message, /Invalid RLS role: 'superuser'/);
      return true;
    },
  );
});

test('withRLS: custom claims are merged', async () => {
  const { engine, calls } = createMockEngine();
  const db = new RLSEnabledDatabase(engine);

  await db.withRLS({
    userId: 'user-1',
    claims: { app_metadata: { org_id: 'org-99' } },
  }).query(sql`SELECT 1`);

  const claimsJson = (calls[2].args as any[])[2][0];
  const claims = JSON.parse(claimsJson);
  assert.strictEqual(claims.sub, 'user-1');
  assert.strictEqual(claims.role, 'authenticated');
  assert.deepStrictEqual(claims.app_metadata, { org_id: 'org-99' });
});

test('withRLS: rolls back on query failure', async () => {
  const { engine, calls } = createMockEngine();
  (engine as any).queryInTransaction = async () => { throw new Error('pg error'); };
  const db = new RLSEnabledDatabase(engine);

  await assert.rejects(() => db.withRLS({ userId: 'user-1' }).query(sql`SELECT bad`));
  const rollback = calls.find(c => c.method === 'rollbackTransaction');
  assert.ok(rollback, 'Expected rollbackTransaction to be called');
});

// A caller-supplied `sub` or `role` in `claims` (for example passed through from
// an identity provider) must not change what reaches request.jwt.claims: an RLS
// policy that reads either claim must see the server-derived value.
test('withRLS: claims cannot override the server-derived sub and role', async () => {
  const { engine, calls } = createMockEngine();
  const db = new RLSEnabledDatabase(engine);

  await db.withRLS({
    userId: 'user-1',
    role: 'anon',
    claims: { sub: 'victim', role: 'service_role', email: 'a@example.com' },
  }).query(sql`SELECT 1`);

  assert.strictEqual((calls[1].args as any[])[1], 'SET LOCAL ROLE anon');
  const claims = JSON.parse((calls[2].args as any[])[2][0]);
  assert.strictEqual(claims.sub, 'user-1');
  assert.strictEqual(claims.role, 'anon');
  assert.strictEqual(claims.email, 'a@example.com', 'non-reserved claims still pass through');
});
