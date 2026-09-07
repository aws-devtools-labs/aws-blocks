// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test, describe } from 'node:test';
import assert from 'node:assert';
import type { api as apiType } from 'aws-blocks';

// Compile-time type assertion helpers (same pattern as database.test.ts).
type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends (<T>() => T extends Y ? 1 : 2) ? true : false;
type Expect<T extends true> = T;

// The DSQL Kysely select must surface exactly { id; name; value } through the
// RPC client boundary. If the projection regresses, this fails to compile.
type DsqlKyselyRow = Awaited<ReturnType<typeof apiType.dsqlKyselySelect>>[number];
type _AssertDsqlKyselyRowType = Expect<Equal<DsqlKyselyRow, { id: string; name: string; value: number }>>;

export function dsqlTests(getApi: () => typeof apiType) {
  describe('DSQL Database BB', () => {
    test('DSQL - setup table', async () => {
      const api = getApi();
      const result = await api.dsqlSetup();
      assert.deepStrictEqual(result, { success: true });
    });

    test('DSQL - insert and get', async () => {
      const api = getApi();
      const id = `d-${Date.now().toString(36)}`;
      const ins = await api.dsqlInsert(id, 'alice', 100);
      assert.strictEqual(ins.rowCount, 1);

      const row = await api.dsqlGet(id);
      assert.deepStrictEqual(row, { id, name: 'alice', value: 100, category: 'general' });

      await api.dsqlDelete(id);
    });

    test('DSQL - queryOne returns null for missing row', async () => {
      const api = getApi();
      const row = await api.dsqlGet('nonexistent');
      assert.strictEqual(row, null);
    });

    test('DSQL - update', async () => {
      const api = getApi();
      const id = `d-${Date.now().toString(36)}`;
      await api.dsqlInsert(id, 'bob', 50);
      const upd = await api.dsqlUpdate(id, 999);
      assert.strictEqual(upd.rowCount, 1);

      const row = await api.dsqlGet(id);
      assert.strictEqual(row!.value, 999);

      await api.dsqlDelete(id);
    });

    test('DSQL - transaction commits (transfer)', async () => {
      const api = getApi();
      const a = `d-${Date.now().toString(36)}-a`;
      const b = `d-${Date.now().toString(36)}-b`;
      await api.dsqlInsert(a, 'sender', 500);
      await api.dsqlInsert(b, 'receiver', 0);

      await api.dsqlTransfer(a, b, 200);

      const sender = await api.dsqlGet(a);
      const receiver = await api.dsqlGet(b);
      assert.strictEqual(sender!.value, 300);
      assert.strictEqual(receiver!.value, 200);

      await api.dsqlDelete(a);
      await api.dsqlDelete(b);
    });

    test('DSQL - transaction rolls back on error', async () => {
      const api = getApi();
      const a = `d-${Date.now().toString(36)}-a`;
      const b = `d-${Date.now().toString(36)}-b`;
      await api.dsqlInsert(a, 'sender', 50);
      await api.dsqlInsert(b, 'receiver', 0);

      // Transfer more than balance — should fail
      await assert.rejects(() => api.dsqlTransfer(a, b, 999), /Insufficient balance/);

      // Values unchanged
      const sender = await api.dsqlGet(a);
      const receiver = await api.dsqlGet(b);
      assert.strictEqual(sender!.value, 50);
      assert.strictEqual(receiver!.value, 0);

      await api.dsqlDelete(a);
      await api.dsqlDelete(b);
    });

    test('DSQL - duplicate insert returns UniqueConstraintViolation', async () => {
      const api = getApi();
      const id = `d-${Date.now().toString(36)}`;
      await api.dsqlInsert(id, 'first', 1);

      const result = await api.dsqlDuplicateInsert(id);
      assert.strictEqual(result.error, 'UniqueConstraintViolationException');

      await api.dsqlDelete(id);
    });

    test('DSQL - rejects FOREIGN KEY at query time', async () => {
      const api = getApi();
      const result = await api.dsqlRejectForeignKey();
      // Mock returns DsqlValidationError (client-side), real DSQL returns QueryFailedException (server-side)
      assert.ok(
        result.error === 'DsqlValidationError' || result.error === 'QueryFailedException',
        `Expected DsqlValidationError or QueryFailedException, got: ${result.error}`
      );
    });

    test('DSQL - rejects TRUNCATE at query time', async () => {
      const api = getApi();
      const result = await api.dsqlRejectTruncate();
      // Mock returns DsqlValidationError (client-side), real DSQL returns QueryFailedException (server-side)
      assert.ok(
        result.error === 'DsqlValidationError' || result.error === 'QueryFailedException',
        `Expected DsqlValidationError or QueryFailedException, got: ${result.error}`
      );
    });

    // Kysely adapter — typed queries against the real DSQL engine.
    test('DSQL - Kysely insert and typed select', async () => {
      const api = getApi();
      const id = `dk-${Date.now().toString(36)}`;
      const row = await api.dsqlKyselyInsertAndGet(id, 'kysely-test', 42);
      assert.strictEqual(row?.id, id);
      assert.strictEqual(row?.name, 'kysely-test');
      assert.strictEqual(row?.value, 42);
      assert.strictEqual(row?.category, 'kysely');

      await api.dsqlKyselyDelete(id);
    });

    test('DSQL - Kysely select returns typed rows', async () => {
      const api = getApi();
      const id = `dk-${Date.now().toString(36)}`;
      await api.dsqlKyselyInsertAndGet(id, 'ky-select', 99);

      const rows = await api.dsqlKyselySelect();
      const ours = rows.find((r) => r.id === id);
      assert.ok(ours, 'inserted row should appear in Kysely select');
      assert.strictEqual(ours.value, 99);

      await api.dsqlKyselyDelete(id);
    });
  });
}
