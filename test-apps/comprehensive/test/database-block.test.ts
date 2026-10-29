// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { describe, test } from 'node:test';
import { ApiError, isBlocksError } from '@aws-blocks/core';
import { DatabaseErrors } from '@aws-blocks/bb-database';
import type { api as apiType } from 'aws-blocks';

// Compile-time assertions (same pattern as database.test.ts). The cluster
// descriptor's `kind` must survive the RPC boundary as the literal the backend
// inferred from the constructor.
type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;
type Expect<T extends true> = T;
type Info = Awaited<ReturnType<typeof apiType.dbxInfo>>;
type _DbxKind = Expect<Equal<Info['dbx']['cluster']['kind'], 'dsql'>>;
type _DbxaKind = Expect<Equal<Info['dbxa']['cluster']['kind'], 'dsql'>>;
// A result schema, not a type argument, is what types these two: the inferred
// type must be the schema's output, and `id` must be a number on both environments.
type Validated = NonNullable<Awaited<ReturnType<typeof apiType.dbxGetValidated>>>;
type _Validated = Expect<Equal<Validated, { id: string; name: string; value: number; category: string }>>;
type Added = NonNullable<Awaited<ReturnType<typeof apiType.dbxaAdd>>>;
type _Added = Expect<Equal<Added, { id: number; sku: string; qty: number }>>;

export function databaseBlockTests(getApi: () => typeof apiType) {
  describe('bb-database (Database + DatabaseCluster)', () => {
    test('descriptors: dbx owns its DSQL cluster, dbxa/dbxb share one', async () => {
      const info = await getApi().dbxInfo();
      assert.deepStrictEqual(info.dbx.cluster, { kind: 'dsql', id: 'default' });
      assert.strictEqual(info.dbx.schemaName, 'public');
      assert.strictEqual(info.dbxa.cluster.kind, 'dsql');
      assert.notStrictEqual(info.dbxa.cluster.id, 'default');
      assert.strictEqual(info.dbxa.cluster.id, info.dbxb.cluster.id);
      assert.strictEqual(info.dbxa.schemaName, 'dbxa');
      assert.strictEqual(info.dbxb.schemaName, 'dbxb');
    });

    test('dbx - insert / get / list / delete through migrations run by the rewriter', async () => {
      const api = getApi();
      const id = `x-${Date.now().toString(36)}`;
      assert.strictEqual((await api.dbxInsert(id, 'alice', 100)).rowCount, 1);
      assert.deepStrictEqual(await api.dbxGet(id), { id, name: 'alice', value: 100, category: 'general' });
      assert.ok((await api.dbxList()).some((r) => r.id === id));
      assert.strictEqual(await api.dbxGet('nonexistent'), null);
      await api.dbxDelete(id);
    });

    test('dbx - transaction commits a transfer and rolls back on failure', async () => {
      const api = getApi();
      const a = `x-${Date.now().toString(36)}-a`;
      const b = `x-${Date.now().toString(36)}-b`;
      await api.dbxInsert(a, 'sender', 500);
      await api.dbxInsert(b, 'receiver', 0);
      await api.dbxTransfer(a, b, 200);
      assert.strictEqual((await api.dbxGet(a))?.value, 300);
      assert.strictEqual((await api.dbxGet(b))?.value, 200);
      await assert.rejects(() => api.dbxTransfer(a, b, 999), ApiError);
      assert.strictEqual((await api.dbxGet(a))?.value, 300);
      await api.dbxDelete(a);
      await api.dbxDelete(b);
    });

    test('dbx - an ApiError thrown inside transaction() reaches the client with its status, and the transaction rolls back', async () => {
      const api = getApi();
      const b = `x-${Date.now().toString(36)}-s`;
      await api.dbxInsert(b, 'receiver', 0);
      try {
        await assert.rejects(
          () => api.dbxTransferStrict('missing-sender', b, 5),
          (e: unknown) => {
            assert.ok(e instanceof ApiError);
            assert.strictEqual(e.status, 404);
            assert.strictEqual(e.message, 'no such sender');
            return true;
          },
        );
        assert.strictEqual((await api.dbxGet(b))?.value, 0, 'nothing was credited');
      } finally {
        await api.dbxDelete(b);
      }
    });

    test('dbx - a result schema types and validates rows; a mismatch is ResultValidationFailed', async () => {
      const api = getApi();
      const id = `x-v-${Date.now().toString(36)}`;
      await api.dbxInsert(id, 'validated', 5);
      try {
        assert.deepStrictEqual(await api.dbxGetValidated(id), { id, name: 'validated', value: 5, category: 'general' });
        assert.strictEqual((await api.dbxSchemaMismatch(id)).error, DatabaseErrors.ResultValidationFailed);
      } finally {
        await api.dbxDelete(id);
      }
    });

    test('dbx - a simulated conflict is retried with retryOnConflict (local mode)', async () => {
      const api = getApi();
      const a = `x-${Date.now().toString(36)}-c`;
      const b = `x-${Date.now().toString(36)}-d`;
      await api.dbxInsert(a, 'sender', 10);
      await api.dbxInsert(b, 'receiver', 0);
      const result = await api.dbxSimulatedConflictTransfer(a, b, 5);
      if (result.simulated) {
        assert.strictEqual(result.attempts, 2, 'the callback ran once, conflicted at commit, and ran again');
        assert.strictEqual((await api.dbxGet(b))?.value, 5);
      }
      await api.dbxDelete(a);
      await api.dbxDelete(b);
    });

    test('dbx - duplicate key is UniqueConstraintViolation with status 409 over the wire', async () => {
      const api = getApi();
      const id = `x-409-${Date.now().toString(36)}`;
      await api.dbxInsert(id, 'first', 1);
      try {
        assert.strictEqual((await api.dbxDuplicateInsert(id)).error, DatabaseErrors.UniqueConstraintViolation);
        await assert.rejects(
          () => api.dbxInsert(id, 'dup', 2),
          (e: unknown) => {
            assert.ok(e instanceof ApiError);
            assert.strictEqual(e.status, 409);
            assert.ok(isBlocksError(e, DatabaseErrors.UniqueConstraintViolation));
            return true;
          },
        );
      } finally {
        await api.dbxDelete(id);
      }
    });

    test('dbx - DDL and TRUNCATE are refused on a DSQL cluster', async () => {
      const api = getApi();
      const ddl = await api.dbxRejectDdl();
      assert.ok(
        ddl.error === 'DsqlPermissionException' || ddl.error === DatabaseErrors.QueryFailed,
        `expected the mock's DDL guard or DSQL's rejection, got ${ddl.error}`,
      );
      const truncate = await api.dbxRejectTruncate();
      assert.ok(truncate.error === 'DsqlValidationError' || truncate.error === DatabaseErrors.QueryFailed, `got ${truncate.error}`);
    });

    test('dbx - more than 3,000 rows in one transaction is TransactionRowLimitExceeded, locally and on DSQL', async () => {
      const result = await getApi().dbxRowLimit();
      assert.strictEqual(result.error, DatabaseErrors.TransactionRowLimitExceeded);
      assert.strictEqual(result.kept, 0, 'the transaction was rolled back');
    });

    test('shared cluster - two blocks with the same table name do not see each other', async () => {
      const api = getApi();
      const stamp = Date.now().toString(36);
      const sku = `sku-${stamp}`;
      const account = `acct-${stamp}`;
      const before = await api.sharedClusterCounts();
      const item = await api.dbxaAdd(sku, 3);
      assert.ok(item && typeof item.id === 'number', 'the rewritten identity column assigned an id, returned as a number');
      assert.deepStrictEqual(await api.dbxbAdd(account, 'alice', 40), { account_id: account, total: 40 });
      assert.deepStrictEqual(await api.dbxbAdd(account, 'alice', 2), { account_id: account, total: 42 });
      const after = await api.sharedClusterCounts();
      assert.strictEqual(after.dbxa, before.dbxa + 1);
      assert.strictEqual(after.dbxb, before.dbxb + 2);
      await api.dbxaDelete(sku);
      assert.deepStrictEqual(await api.dbxbDeleteAccount(account), { remainingItems: 0 });
    });

    test('shared cluster - the validated foreign key and check constraint are enforced on DSQL', async () => {
      const api = getApi();
      const account = `orphan-${Date.now().toString(36)}`;
      const result = await api.dbxbRejectOrphan(account);
      assert.strictEqual(result.orphan, DatabaseErrors.QueryFailed, 'no such account');
      assert.ok(
        result.negative === DatabaseErrors.QueryFailed || result.negative === DatabaseErrors.TransactionFailed,
        `check constraint: ${result.negative}`,
      );
      await api.dbxbDeleteAccount(account);
    });
  });
}
