// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { ApiError, isBlocksError } from '@aws-cdk-blocks/core';
import { type ClusterKind, DatabaseErrors } from '@aws-cdk-blocks/bb-database';
import type { api as apiType } from 'cdk-blocks';

// Compile-time assertions. `Equal` is the standard invariant type-equality check;
// `Expect` only accepts `true`, so an inexact type makes the harness `tsc --noEmit`
// (run before deploy) fail. The cluster descriptor's `kind` must survive the RPC
// boundary as the block's `ClusterKind`.
type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;
type Expect<T extends true> = T;
type Info = Awaited<ReturnType<typeof apiType.dbxInfo>>;
type _DbxKind = Expect<Equal<Info['dbx']['cluster']['kind'], ClusterKind>>;
type _DbxcKind = Expect<Equal<Info['dbxc']['cluster']['kind'], ClusterKind>>;
type Task = NonNullable<Awaited<ReturnType<typeof apiType.dbxcAdd>>>;
type _Task = Expect<Equal<Task, { id: number; title: string; done: boolean }>>;
// The result schema, not a type argument, types the validated read on the aurora path too.
type ValidatedTask = NonNullable<Awaited<ReturnType<typeof apiType.dbxcGetValidated>>>;
type _ValidatedTask = Expect<Equal<ValidatedTask, { id: number; title: string; done: boolean }>>;
// A Kysely projection through DatabaseDialect keeps its row type across the RPC boundary.
type KyselyRoundTrip = Awaited<ReturnType<typeof apiType.dbxcKyselyRoundTrip>>;
type _KyselyInserted = Expect<Equal<KyselyRoundTrip['inserted'], { id: number; title: string; done: boolean }>>;
// A result schema, not a type argument, is what types these two: the inferred
// type must be the schema's output, and `id` must be a number on both environments.
type Validated = NonNullable<Awaited<ReturnType<typeof apiType.dbxGetValidated>>>;
type _Validated = Expect<Equal<Validated, { id: string; name: string; value: number; category: string }>>;
type Added = NonNullable<Awaited<ReturnType<typeof apiType.dbxaAdd>>>;
type _Added = Expect<Equal<Added, { id: number; sku: string; qty: number }>>;
// A Kysely projection on the DSQL block must surface exactly `{ id; name; value }` through the
// RPC boundary: an unknown column, or a regression in the dialect's row typing, fails to compile.
type DbxKyselyRow = Awaited<ReturnType<typeof apiType.dbxKyselySelect>>[number];
type _DbxKyselyRow = Expect<Equal<DbxKyselyRow, { id: string; name: string; value: number }>>;

/** Run the installed database task from the app directory and parse its structured result. */
function cdkBlocksDb(...args: string[]): unknown {
  const stdout = execFileSync(process.execPath, ['--input-type=module', '-e', "import 'aws-cdk-blocks/run'", '--', 'db', ...args, '--', '--output', 'json'], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return JSON.parse(stdout);
}

export function databaseBlockTests(getApi: () => typeof apiType) {
  describe('bb-database (Database + DatabaseCluster)', () => {
    // The Kysely table types the backend imports are generated from the migration files. Generating them
    // again must give the committed files, while the dev server holds the local databases.
    test('npm run db -- types --block writes the Tables files the backend imports', () => {
      const dir = mkdtempSync(join(tmpdir(), 'bb-comprehensive-types-'));
      try {
        for (const [block, ...options] of [['dbx'], ['dbxc', '--type', 'aurora']]) {
          const out = join(dir, `${block}.types.ts`);
          cdkBlocksDb('types', '--block', block, ...options, '--out', out);
          assert.strictEqual(
            readFileSync(out, 'utf-8'),
            readFileSync(join('cdk-blocks', `${block}.types.ts`), 'utf-8'),
            `cdk-blocks/${block}.types.ts is stale: run npm run db -- types --block ${block} ${options.join(' ')}`,
          );
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test('npm run db -- status --block lists the files of a block in its local database', { skip: (process.env.BLOCKS_TEST_ENV || 'local') !== 'local' }, async () => {
      // A statement first, so the block has applied its files.
      await getApi().dbxcCommentCount(0);
      assert.deepStrictEqual(cdkBlocksDb('status', '--block', 'dbxc', '--cluster', 'sharedaurora'), {
        ok: true,
        applied: ['001_tasks.sql', '002_comments.sql', '003_user_notes.sql'],
        pending: [],
        note: 'A process has the local database open. The lists show what it had written to disk.',
      });
    });

    test('descriptors: dbx owns its DSQL cluster, dbxa/dbxb share one, dbxc runs on an aurora cluster', async () => {
      const info = await getApi().dbxInfo();
      assert.strictEqual(info.dbxc.cluster.kind, 'aurora');
      assert.notStrictEqual(info.dbxc.cluster.id, info.dbxa.cluster.id);
      assert.strictEqual(info.dbxc.schemaName, 'dbxc');
      assert.deepStrictEqual(info.dbx.cluster, { kind: 'dsql', id: 'default' });
      assert.strictEqual(info.dbx.schemaName, 'public');
      assert.strictEqual(info.dbxa.cluster.kind, 'dsql');
      assert.notStrictEqual(info.dbxa.cluster.id, 'default');
      assert.strictEqual(info.dbxa.cluster.id, info.dbxb.cluster.id);
      assert.strictEqual(info.dbxa.schemaName, 'dbxa');
      assert.strictEqual(info.dbxb.schemaName, 'dbxb');
    });

    test('dbx - insert / get / list / delete on tables a DSQL migration created', async () => {
      const api = getApi();
      const id = `x-${Date.now().toString(36)}`;
      assert.strictEqual((await api.dbxInsert(id, 'alice', 100)).rowCount, 1);
      assert.deepStrictEqual(await api.dbxGet(id), { id, name: 'alice', value: 100, category: 'general' });
      assert.ok((await api.dbxList()).some((r) => r.id === id));
      assert.strictEqual(await api.dbxGet('nonexistent'), null);
      await api.dbxDelete(id);
    });

    test('dbx - update returns the affected row count and changes the row', async () => {
      const api = getApi();
      const id = `x-u-${Date.now().toString(36)}`;
      await api.dbxInsert(id, 'bob', 50);
      try {
        assert.strictEqual((await api.dbxUpdate(id, 999)).rowCount, 1);
        assert.strictEqual((await api.dbxGet(id))?.value, 999);
        assert.strictEqual((await api.dbxUpdate(`${id}-missing`, 1)).rowCount, 0, 'no row matched');
      } finally {
        await api.dbxDelete(id);
      }
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
            assert.strictEqual(e.retriable, false, 'a duplicate key is deterministic, so it is not retriable');
            return true;
          },
        );
      } finally {
        await api.dbxDelete(id);
      }
    });

    // A statement the cluster rejects for something the caller did, thrown out of the handler uncaught:
    // the client must be able to branch on the name, and the message must not carry the row's values.
    test('dbx - a not-null violation reaches the client as NotNullViolation (HTTP 400) without row values', async () => {
      const api = getApi();
      const id = `x-nn-${Date.now().toString(36)}`;
      await assert.rejects(
        () => api.dbxNotNullViolation(id),
        (e: unknown) => {
          assert.ok(e instanceof ApiError, `expected ApiError, got ${e}`);
          assert.ok(isBlocksError(e, DatabaseErrors.NotNullViolation), `expected NotNullViolation, got ${e.name}`);
          assert.strictEqual(e.status, 400);
          assert.ok(!e.message.includes(id), `the message must not quote the row: ${e.message}`);
          return true;
        },
      );
      assert.strictEqual(await api.dbxGet(id), null, 'nothing was inserted');
    });

    test('dbx - Kysely through DatabaseDialect on a DSQL cluster: typed insert, select and delete', async () => {
      const api = getApi();
      const id = `x-ky-${Date.now().toString(36)}`;
      const row = await api.dbxKyselyInsertAndGet(id, 'kysely-test', 142);
      try {
        assert.deepStrictEqual(row, { id, name: 'kysely-test', value: 142, category: 'kysely' });
        const rows = await api.dbxKyselySelect(100);
        assert.deepStrictEqual(rows.find((r) => r.id === id), { id, name: 'kysely-test', value: 142 });
        assert.ok(!(await api.dbxKyselySelect(143)).some((r) => r.id === id), 'the typed where clause filtered the row out');
      } finally {
        assert.deepStrictEqual(await api.dbxKyselyDelete(id), { deleted: 1 });
      }
      assert.strictEqual(await api.dbxGet(id), null);
    });

    test('dbx - a Kysely transaction commits a transfer, and rolls back atomically when it throws', async () => {
      const api = getApi();
      const a = `x-kt-${Date.now().toString(36)}-a`;
      const b = `x-kt-${Date.now().toString(36)}-b`;
      await api.dbxInsert(a, 'sender', 500);
      await api.dbxInsert(b, 'receiver', 0);
      try {
        assert.deepStrictEqual(await api.dbxKyselyTransfer(a, b, 200, false), { success: true });
        assert.strictEqual((await api.dbxGet(a))?.value, 300);
        assert.strictEqual((await api.dbxGet(b))?.value, 200);
        // The callback throws after the debit and the credit: neither may be kept.
        await assert.rejects(
          () => api.dbxKyselyTransfer(a, b, 200, true),
          (e: unknown) => {
            assert.ok(e instanceof ApiError);
            assert.strictEqual(e.status, 409, 'the ApiError the callback threw passes through');
            return true;
          },
        );
        assert.strictEqual((await api.dbxGet(a))?.value, 300, 'the debit was rolled back');
        assert.strictEqual((await api.dbxGet(b))?.value, 200, 'the credit was rolled back');
      } finally {
        await api.dbxDelete(a);
        await api.dbxDelete(b);
      }
    });

    test('dbx - DDL and TRUNCATE are refused on a DSQL cluster', async () => {
      const api = getApi();
      const ddl = await api.dbxRejectDdl();
      assert.strictEqual(ddl.error, DatabaseErrors.QueryFailed);
      const truncate = await api.dbxRejectTruncate();
      assert.ok(truncate.error === 'DsqlValidationError' || truncate.error === DatabaseErrors.QueryFailed, `got ${truncate.error}`);
    });

    test('dbx - more than 3,000 rows in one transaction is TransactionRowLimitExceeded, locally and on DSQL', async () => {
      const result = await getApi().dbxRowLimit();
      assert.strictEqual(result.error, DatabaseErrors.TransactionRowLimitExceeded);
      assert.strictEqual(result.kept, 0, 'the transaction was rolled back');
    });

    test('dbx - a block-level execute() inside transaction() runs in it: nothing is kept when the callback throws', async () => {
      const result = await getApi().dbxBlockWriteInAbortedTransaction(`x-join-${Date.now().toString(36)}`);
      assert.deepStrictEqual(result, { aborted: true, kept: 0 });
    });

    test("dbx - a block-level query() inside transaction() sees the callback's own uncommitted write", async () => {
      const result = await getApi().dbxBlockReadInTransaction(`x-see-${Date.now().toString(36)}`);
      assert.deepStrictEqual(result, { seenInside: true, committed: true });
    });

    test('shared cluster - two blocks with the same table name do not see each other', async () => {
      const api = getApi();
      const stamp = Date.now().toString(36);
      const sku = `sku-${stamp}`;
      const account = `acct-${stamp}`;
      const before = await api.sharedClusterCounts();
      const item = await api.dbxaAdd(sku, 3);
      assert.ok(item && typeof item.id === 'number', 'the identity column assigned an id, returned as a number');
      assert.deepStrictEqual(await api.dbxbAdd(account, 'alice', 40), { account_id: account, total: 40 });
      assert.deepStrictEqual(await api.dbxbAdd(account, 'alice', 2), { account_id: account, total: 42 });
      const after = await api.sharedClusterCounts();
      assert.strictEqual(after.dbxa, before.dbxa + 1);
      assert.strictEqual(after.dbxb, before.dbxb + 2);
      await api.dbxaDelete(sku);
      assert.deepStrictEqual(await api.dbxbDeleteAccount(account), { remainingItems: 0 });
    });

    test('aurora cluster - SERIAL ids, a PL/pgSQL trigger and a transaction over 3,000 rows', async () => {
      const api = getApi();
      const task = await api.dbxcAdd(`task-${Date.now().toString(36)}`);
      assert.ok(task && typeof task.id === 'number' && task.done === false, 'SERIAL assigned a numeric id');
      // The trigger bumps updated_at; the second query runs at least a tick later than the insert.
      await new Promise((r) => setTimeout(r, 5));
      const completed = await api.dbxcComplete(task.id);
      assert.deepStrictEqual(completed, { done: true, touched: true });
      assert.deepStrictEqual(await api.dbxcBulk(3001), { inserted: 3001, deleted: 3001 });
      assert.deepStrictEqual(await api.dbxcDelete(task.id), { rowCount: 1 });
    });

    test('aurora cluster - a foreign key is enforced, a join aggregates, and a delete cascades', async () => {
      const api = getApi();
      const task = await api.dbxcAdd(`fk-${Date.now().toString(36)}`);
      assert.ok(task);
      const orphan = await api.dbxcAddComment(task.id + 1_000_000, 'no such task');
      assert.strictEqual(orphan.error, DatabaseErrors.ForeignKeyViolation, 'SQLSTATE 23503 reaches the client by name');
      const first = await api.dbxcAddComment(task.id, 'first');
      const second = await api.dbxcAddComment(task.id, 'second');
      assert.ok(first.id !== null && second.id !== null && second.id > first.id, 'SERIAL ids on the child table');
      assert.deepStrictEqual(await api.dbxcTasksWithCounts([task.id]), [{ id: task.id, title: task.title, comments: 2 }]);
      assert.deepStrictEqual(await api.dbxcDelete(task.id), { rowCount: 1 });
      assert.strictEqual(await api.dbxcCommentCount(task.id), 0, 'ON DELETE CASCADE removed the comments');
    });

    test('aurora cluster - a transaction that throws after writing keeps nothing, and the ApiError passes through', async () => {
      const result = await getApi().dbxcAtomicFail(50);
      assert.strictEqual(result.error, 'ApiError');
      assert.strictEqual(result.kept, 0);
    });

    test('aurora cluster - a block-level execute() inside transaction() runs in it: nothing is kept when the callback throws', async () => {
      const result = await getApi().dbxcBlockWriteInAbortedTransaction(`xc-join-${Date.now().toString(36)}`);
      assert.deepStrictEqual(result, { aborted: true, kept: 0 });
    });

    test("aurora cluster - a block-level query() inside transaction() sees the callback's own uncommitted write", async () => {
      const result = await getApi().dbxcBlockReadInTransaction(`xc-see-${Date.now().toString(36)}`);
      assert.deepStrictEqual(result, { seenInside: true, committed: true });
    });

    test('aurora cluster - Kysely through DatabaseDialect: typed rows and affected-row counts', async () => {
      const title = `ky-${Date.now().toString(36)}`;
      const result = await getApi().dbxcKyselyRoundTrip(title);
      const id = result.inserted.id;
      assert.deepStrictEqual(result, {
        inserted: { id, title, done: false },
        updated: 1,
        row: { id, title, done: true },
        deleted: 1,
      });
    });

    test('aurora cluster - a Kysely transaction that throws keeps nothing, and the ApiError passes through', async () => {
      const result = await getApi().dbxcKyselyRollback(`ky-rb-${Date.now().toString(36)}`);
      assert.deepStrictEqual(result, { aborted: true, kept: 0 });
    });

    test('aurora cluster - a Kysely statement inside transaction() runs in it: it sees the write and rolls back with it', async () => {
      const result = await getApi().dbxcKyselyInBlockTransaction(`ky-in-${Date.now().toString(36)}`);
      assert.deepStrictEqual(result, { seenInside: true, kept: 0 });
    });

    test('aurora cluster - Kysely value types: a bigint is a number, a numeric a string, a timestamp a Date', async () => {
      const types = await getApi().dbxcKyselyValueTypes();
      assert.deepStrictEqual(types, { big: 'number', num: 'string', at: 'Date', n: 'number' });
    });

    test('aurora cluster - asUser(): a Row Level Security policy gives each user their own rows, through SQL and Kysely', async () => {
      const stamp = Date.now().toString(36);
      const result = await getApi().dbxcUserNotes(`owner-${stamp}`, `other-${stamp}`, `note-${stamp}`);
      assert.deepStrictEqual(result, {
        owner: 1,
        other: 0,
        noUser: 0,
        kysely: 1,
        kyselyOtherInTransaction: 0,
        refused: DatabaseErrors.PermissionDenied,
        deletedByOther: 0,
        deletedByOwner: 1,
      });
    });

    test('aurora cluster - DDL and TRUNCATE are refused: the app role has DML only', async () => {
      const api = getApi();
      for (const result of [await api.dbxcRejectDdl(), await api.dbxcRejectTruncate()]) {
        assert.strictEqual(result.error, DatabaseErrors.QueryFailed);
      }
    });

    test('aurora cluster - a result schema types and validates rows; a mismatch is ResultValidationFailed', async () => {
      const api = getApi();
      const task = await api.dbxcAdd(`schema-${Date.now().toString(36)}`);
      assert.ok(task);
      try {
        assert.deepStrictEqual(await api.dbxcGetValidated(task.id), { id: task.id, title: task.title, done: false });
        assert.strictEqual((await api.dbxcSchemaMismatch(task.id)).error, DatabaseErrors.ResultValidationFailed);
      } finally {
        await api.dbxcDelete(task.id);
      }
    });

    test('aurora cluster - a simulated conflict is retried with retryOnConflict (local mode)', async () => {
      const api = getApi();
      const task = await api.dbxcAdd(`conflict-${Date.now().toString(36)}`);
      assert.ok(task);
      try {
        const result = await api.dbxcSimulatedConflictComplete(task.id);
        if (result.simulated) {
          assert.strictEqual(result.attempts, 2, 'the callback ran once, conflicted at commit, and ran again');
          assert.deepStrictEqual(await api.dbxcGetValidated(task.id), { id: task.id, title: task.title, done: true });
        }
      } finally {
        await api.dbxcDelete(task.id);
      }
    });

    test('shared cluster - the validated foreign key and check constraint are enforced on DSQL', async () => {
      const api = getApi();
      const account = `orphan-${Date.now().toString(36)}`;
      const result = await api.dbxbRejectOrphan(account);
      assert.strictEqual(result.orphan, DatabaseErrors.ForeignKeyViolation, 'no such account');
      assert.ok(
        result.negative === DatabaseErrors.CheckViolation || result.negative === DatabaseErrors.TransactionFailed,
        `check constraint: ${result.negative}`,
      );
      await api.dbxbDeleteAccount(account);
    });
  });
}
