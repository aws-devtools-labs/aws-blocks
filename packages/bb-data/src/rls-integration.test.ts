// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Integration test: RLSEngineWrapper + PGliteEngine.
 *
 * Proves that withRLS() correctly sets session variables in a real Postgres
 * engine (PGlite WASM). This validates the SQL sequence without needing
 * an external Supabase project.
 *
 * Note: PGlite doesn't have Supabase's `auth.uid()` function, so we test
 * with a simpler RLS policy using `current_setting('request.jwt.claims')`.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert';
import { rmSync } from 'node:fs';
import { PGliteEngine } from './engines/pglite-engine.js';
import { RLSEnabledDatabase } from './database.js';
import { sql } from '@aws-blocks/data-common';
import { ApiError } from '@aws-blocks/core';
import { DatabaseErrors } from './errors.js';

const TEST_DIR = '.bb-data-rls-integration-' + process.pid;
let engine: PGliteEngine;

afterEach(async () => {
  if (engine) await engine.destroy().catch(() => {});
  rmSync(TEST_DIR, { recursive: true, force: true });
});

async function setup(): Promise<RLSEnabledDatabase> {
  engine = new PGliteEngine(TEST_DIR);

  // Create the 'authenticated' role that RLS will use
  await engine.execute(`DO $$ BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN
      CREATE ROLE authenticated NOLOGIN;
    END IF;
  END $$`);

  // Grant usage to authenticated role
  await engine.execute(`GRANT USAGE ON SCHEMA public TO authenticated`);

  // Create table with RLS
  await engine.execute(`CREATE TABLE todos (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    content TEXT NOT NULL
  )`);
  await engine.execute(`ALTER TABLE todos ENABLE ROW LEVEL SECURITY`);

  // RLS policy: user can only see rows where user_id matches the JWT sub claim
  await engine.execute(`CREATE POLICY "users_own_todos" ON todos
    FOR ALL TO authenticated
    USING (user_id = (current_setting('request.jwt.claims', true)::json->>'sub'))`);

  // Grant table access to authenticated role
  await engine.execute(`GRANT SELECT, INSERT, UPDATE, DELETE ON todos TO authenticated`);

  // Seed data (as superuser — bypasses RLS)
  await engine.execute(`INSERT INTO todos (id, user_id, content) VALUES
    ('t1', 'user-1', 'User 1 first todo'),
    ('t2', 'user-1', 'User 1 second todo'),
    ('t3', 'user-2', 'User 2 todo')`);

  return new RLSEnabledDatabase(engine);
}

test('integration: withRLS scopes query to user-1 only', async () => {
  const db = await setup();
  const scoped = db.withRLS({ userId: 'user-1' });
  const rows = await scoped.query<{ id: string; user_id: string }>(sql`SELECT * FROM todos ORDER BY id`);

  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].id, 't1');
  assert.strictEqual(rows[1].id, 't2');
  for (const row of rows) {
    assert.strictEqual(row.user_id, 'user-1');
  }
});

test('integration: withRLS scopes query to user-2 only', async () => {
  const db = await setup();
  const scoped = db.withRLS({ userId: 'user-2' });
  const rows = await scoped.query<{ id: string; user_id: string }>(sql`SELECT * FROM todos`);

  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].id, 't3');
  assert.strictEqual(rows[0].user_id, 'user-2');
});

test('integration: withRLS returns empty for nonexistent user', async () => {
  const db = await setup();
  const scoped = db.withRLS({ userId: 'user-999' });
  const rows = await scoped.query<{ id: string }>(sql`SELECT * FROM todos`);

  assert.deepStrictEqual(rows, []);
});

test('integration: without withRLS, superuser sees all rows', async () => {
  const db = await setup();
  const rows = await db.query<{ id: string }>(sql`SELECT * FROM todos ORDER BY id`);

  assert.strictEqual(rows.length, 3);
});

test('integration: concurrent RLS scopes and ordinary reads keep their own session context', { timeout: 10_000 }, async () => {
  const db = await setup();
  const [first, second, unscoped] = await Promise.all([
    db.withRLS({ userId: 'user-1' }).query<{ id: string }>(sql`SELECT id FROM todos ORDER BY id`),
    db.withRLS({ userId: 'user-2' }).query<{ id: string }>(sql`SELECT id FROM todos ORDER BY id`),
    db.query<{ id: string }>(sql`SELECT id FROM todos ORDER BY id`),
  ]);
  assert.deepStrictEqual(first, [{ id: 't1' }, { id: 't2' }]);
  assert.deepStrictEqual(second, [{ id: 't3' }]);
  assert.deepStrictEqual(unscoped, [{ id: 't1' }, { id: 't2' }, { id: 't3' }]);
});

test('integration: withRLS execute respects policy (user-1 can only delete own rows)', async () => {
  const db = await setup();
  const scoped = db.withRLS({ userId: 'user-1' });

  // Try to delete user-2's row — should affect 0 rows due to RLS
  const result = await scoped.execute(sql`DELETE FROM todos WHERE id = 't3'`);
  assert.strictEqual(result.rowCount, 0);

  // Delete own row — should work
  const result2 = await scoped.execute(sql`DELETE FROM todos WHERE id = 't1'`);
  assert.strictEqual(result2.rowCount, 1);
});

test('integration: withRLS transaction maintains context across multiple queries', async () => {
  const db = await setup();

  // Use explicit transaction via the RLS-scoped database
  const scoped = db.withRLS({ userId: 'user-1' });
  await scoped.transaction(async (tx) => {
    const rows = await tx.query<{ id: string }>(sql`SELECT * FROM todos ORDER BY id`);
    assert.strictEqual(rows.length, 2); // only user-1's rows
  });
});

// On PostgreSQL 16+ (Aurora included) a non-superuser that creates a role gets
// ADMIN on it but not SET, so withRLS()'s SET LOCAL ROLE is refused with 42501.
// That is a setup problem that fails every withRLS() call, so it must surface as
// a 500 QueryFailed, not the 403 PermissionDenied a caller's own statement gets.
// PGlite normally runs as superuser, so switch the session to a CREATEROLE user,
// which is how Aurora's master user works.
async function setupWithoutRoleMembership(): Promise<RLSEnabledDatabase> {
  engine = new PGliteEngine(TEST_DIR);
  await engine.execute('CREATE ROLE app_owner LOGIN CREATEROLE');
  await engine.execute('GRANT CREATE ON SCHEMA public TO app_owner');
  await engine.execute('SET SESSION AUTHORIZATION app_owner');
  await engine.execute('CREATE ROLE authenticated NOLOGIN');
  await engine.execute('CREATE TABLE notes (id TEXT PRIMARY KEY)');
  await engine.execute('GRANT SELECT ON notes TO authenticated');
  return new RLSEnabledDatabase(engine);
}

test('integration: a refused role switch is a 500 QueryFailed, not a 403', async () => {
  const db = await setupWithoutRoleMembership();
  const errors: unknown[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => errors.push(args.join(' '));
  try {
    await assert.rejects(
      () => db.withRLS({ userId: 'user-1' }).query(sql`SELECT * FROM notes`),
      (e: unknown) => {
        assert.ok(e instanceof Error);
        assert.strictEqual(e.name, DatabaseErrors.QueryFailed);
        assert.ok(!(e instanceof ApiError), 'must not carry a 4xx status');
        assert.match(String((e.cause as Error).message), /permission denied to set role/);
        return true;
      },
    );
  } finally {
    console.error = original;
  }
  assert.ok(errors.some((line) => /GRANT authenticated TO CURRENT_USER/.test(String(line))), 'logs the fix');
});

test('integration: after GRANT authenticated TO CURRENT_USER, withRLS() works for a non-superuser', async () => {
  const db = await setupWithoutRoleMembership();
  await engine.execute('GRANT authenticated TO CURRENT_USER');
  const row = await db.withRLS({ userId: 'user-1' }).queryOne<{ r: string }>(sql`SELECT current_user AS r`);
  assert.strictEqual(row?.r, 'authenticated');
});

// A caller-supplied `sub` or `role` in `claims` must not change what an RLS
// policy reads from request.jwt.claims. Real PGlite enforces both policies.
test('integration: claims.sub cannot impersonate another user', async () => {
  const db = await setup();
  const rows = await db
    .withRLS({ userId: 'user-1', claims: { sub: 'user-2' } })
    .query<{ id: string; user_id: string }>(sql`SELECT * FROM todos ORDER BY id`);
  assert.deepStrictEqual(rows.map((r) => r.user_id), ['user-1', 'user-1']);
});

test('integration: claims.role cannot satisfy a policy that authorizes on the role claim', async () => {
  const db = await setup();
  // A policy written the documented way: admins (by role claim) see every row.
  await engine.execute(`CREATE POLICY "admins_see_all" ON todos
    FOR SELECT TO authenticated
    USING ((current_setting('request.jwt.claims', true)::json->>'role') = 'admin')`);
  const rows = await db
    .withRLS({ userId: 'user-1', claims: { role: 'admin' } })
    .query<{ user_id: string }>(sql`SELECT * FROM todos ORDER BY id`);
  assert.deepStrictEqual(rows.map((r) => r.user_id), ['user-1', 'user-1'], 'no extra rows from a spoofed role claim');
});
