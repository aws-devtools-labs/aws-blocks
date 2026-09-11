// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { isBlocksError, ApiError } from '@aws-blocks/core';
import { DatabaseErrors } from '@aws-blocks/bb-data';
import type { api as apiType } from 'aws-blocks';

// Compile-time type assertion helpers. `Equal` is the standard invariant
// type-equality check; `Expect` only accepts `true`, so an inexact type makes
// the harness `tsc --noEmit` (run before deploy) fail.
type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends (<T>() => T extends Y ? 1 : 2) ? true : false;
type Expect<T extends true> = T;

// The Kysely typed select must surface exactly `{ id; name; value }` (correctly
// typed) through the RPC client boundary. If Kysely's inference regresses, or the
// projection leaks an unknown column, this assertion fails to compile.
type KyselyRow = Awaited<ReturnType<typeof apiType.dbKyselySelect>>[number];
type _AssertKyselyRowType = Expect<Equal<KyselyRow, { id: string; name: string; value: number }>>;

export function databaseTests(getApi: () => typeof apiType) {
  describe('Database BB', () => {
    test('Database - setup table', async () => {
      const api = getApi();
      const result = await api.dbSetup();
      assert.deepStrictEqual(result, { success: true });
    });

    test('Database - insert and get', async () => {
      const api = getApi();
      const id = `t-${Date.now().toString(36)}`;
      const ins = await api.dbInsert(id, 'alice', 100);
      assert.strictEqual(ins.rowCount, 1);

      const row = await api.dbGet(id);
      assert.deepStrictEqual(row, { id, name: 'alice', value: 100, category: 'general' });

      await api.dbDelete(id);
    });

    test('Database - queryOne returns null for missing row', async () => {
      const api = getApi();
      const row = await api.dbGet('nonexistent');
      assert.strictEqual(row, null);
    });

    test('Database - update', async () => {
      const api = getApi();
      const id = `t-${Date.now().toString(36)}`;
      await api.dbInsert(id, 'bob', 50);
      const upd = await api.dbUpdate(id, 999);
      assert.strictEqual(upd.rowCount, 1);

      const row = await api.dbGet(id);
      assert.strictEqual(row!.value, 999);

      await api.dbDelete(id);
    });

    test('Database - transaction commits', async () => {
      const api = getApi();
      const a = `t-${Date.now().toString(36)}-a`;
      const b = `t-${Date.now().toString(36)}-b`;
      await api.dbInsert(a, 'sender', 500);
      await api.dbInsert(b, 'receiver', 0);

      await api.dbTransfer(a, b, 200);

      const sender = await api.dbGet(a);
      const receiver = await api.dbGet(b);
      assert.strictEqual(sender!.value, 300);
      assert.strictEqual(receiver!.value, 200);

      await api.dbDelete(a);
      await api.dbDelete(b);
    });

    test('Database - transaction rolls back on error', async () => {
      const api = getApi();
      const a = `t-${Date.now().toString(36)}-a`;
      const b = `t-${Date.now().toString(36)}-b`;
      await api.dbInsert(a, 'sender', 50);
      await api.dbInsert(b, 'receiver', 0);

      // Transfer more than balance — should fail
      await assert.rejects(() => api.dbTransfer(a, b, 999), /Insufficient balance/);

      // Values unchanged
      const sender = await api.dbGet(a);
      const receiver = await api.dbGet(b);
      assert.strictEqual(sender!.value, 50);
      assert.strictEqual(receiver!.value, 0);

      await api.dbDelete(a);
      await api.dbDelete(b);
    });

    test('Database - duplicate insert returns UniqueConstraintViolation', async () => {
      const api = getApi();
      const id = `t-${Date.now().toString(36)}`;
      await api.dbInsert(id, 'first', 1);

      const result = await api.dbDuplicateInsert(id);
      assert.strictEqual(result.error, 'UniqueConstraintViolationException');

      await api.dbDelete(id);
    });

    // Duplicate-key (SQLSTATE 23505) UniqueConstraintViolation must serialize to
    // JSON-RPC 409 (Conflict) over the wire — reconstructed client-side as an
    // ApiError with status 409 — not a generic 500. The error name is preserved
    // so isBlocksError still matches. The PGlite mock enforces the PK constraint,
    // so this exercises the real translate path locally. (issue #508)
    test('Database - duplicate insert returns status 409 over the wire', async () => {
      const api = getApi();
      const id = `t-409-${Date.now().toString(36)}`;
      await api.dbInsert(id, 'first', 1);
      try {
        await api.dbInsert(id, 'dup', 2);
        assert.fail('Expected a conflict error');
      } catch (e) {
        assert.ok(e instanceof ApiError, `Expected ApiError, got ${e}`);
        assert.strictEqual(e.status, 409, 'duplicate key must be 409, not 500');
        assert.ok(isBlocksError(e, DatabaseErrors.UniqueConstraintViolation));
        assert.notStrictEqual(e.retriable, true, 'duplicate key is not retriable');
      }
      await api.dbDelete(id);
    });

    // Kysely transactions must be atomic on the real engine.
    test('Database - Kysely transaction commits transfer', async () => {
      const api = getApi();
      const a = `kt-${Date.now().toString(36)}-a`;
      const b = `kt-${Date.now().toString(36)}-b`;
      await api.dbInsert(a, 'sender', 500);
      await api.dbInsert(b, 'receiver', 0);

      await api.dbKyselyTransfer(a, b, 200, false);

      assert.strictEqual((await api.dbGet(a))!.value, 300);
      assert.strictEqual((await api.dbGet(b))!.value, 200);

      await api.dbDelete(a);
      await api.dbDelete(b);
    });

    test('Database - Kysely transaction rolls back atomically on error', async () => {
      const api = getApi();
      const a = `kt-${Date.now().toString(36)}-a`;
      const b = `kt-${Date.now().toString(36)}-b`;
      await api.dbInsert(a, 'sender', 500);
      await api.dbInsert(b, 'receiver', 0);

      // Force a throw after debit+credit. If the Kysely transaction is NOT atomic
      // (the pooled/Data-API bug), the debit/credit persist and these assertions fail.
      await assert.rejects(() => api.dbKyselyTransfer(a, b, 200, true));

      assert.strictEqual((await api.dbGet(a))!.value, 500, 'debit must be rolled back');
      assert.strictEqual((await api.dbGet(b))!.value, 0, 'credit must be rolled back');

      await api.dbDelete(a);
      await api.dbDelete(b);
    });

    // Kysely typed query — the backend builds a typed query via createKyselyAdapter
    // (typing is enforced by the harness tsc check); this just verifies it runs.
    test('Database - Kysely typed select returns typed rows', async () => {
      const api = getApi();
      const id = `ks-${Date.now().toString(36)}`;
      await api.dbInsert(id, 'kysely', 123);

      const rows = await api.dbKyselySelect(100);
      const ours = rows.find((r) => r.id === id);
      assert.strictEqual(ours?.value, 123);

      await api.dbDelete(id);
    });
  });
}
