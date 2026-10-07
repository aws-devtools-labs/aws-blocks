// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { describe, test } from 'node:test';
import { ApiError, isBlocksError } from '@aws-blocks/core';
import { DatabaseErrors } from '@aws-blocks/bb-database';
import type { api as apiType } from 'aws-blocks';

// Compile-time assertions (same pattern as database.test.ts). The cluster
// descriptor's `kind` must survive the RPC boundary as the literal the backend
// inferred from the constructor — a distributed default for `dbx`, the shared
// provisioned cluster for `inventory` and `ledger`.
type Equal<X, Y> = (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;
type Expect<T extends true> = T;
type Info = Awaited<ReturnType<typeof apiType.dbxInfo>>;
type _DbxKind = Expect<Equal<Info['dbx']['cluster']['kind'], 'distributed'>>;
type _LedgerKind = Expect<Equal<Info['ledger']['cluster']['kind'], 'provisioned'>>;
type KyselyRow = Awaited<ReturnType<typeof apiType.dbxKyselySelect>>[number];
type _KyselyRow = Expect<Equal<KyselyRow, { id: string; name: string; value: number }>>;

export function databaseBlockTests(getApi: () => typeof apiType) {
	describe('bb-database (Database + DatabaseCluster)', () => {
		test('descriptors: dbx owns its distributed cluster, inventory/ledger share the provisioned one', async () => {
			const info = await getApi().dbxInfo();
			assert.deepStrictEqual(info.dbx.cluster, { kind: 'distributed', id: 'default' });
			assert.strictEqual(info.dbx.schemaName, 'public');
			assert.strictEqual(info.inventory.cluster.kind, 'provisioned');
			assert.strictEqual(info.inventory.cluster.id, info.ledger.cluster.id);
			assert.strictEqual(info.inventory.schemaName, 'inventory');
			assert.strictEqual(info.ledger.schemaName, 'ledger');
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

		test('dbx - DDL and TRUNCATE are refused on a distributed cluster', async () => {
			const api = getApi();
			const ddl = await api.dbxRejectDdl();
			assert.ok(
				ddl.error === 'DsqlPermissionException' || ddl.error === DatabaseErrors.QueryFailed,
				`expected the mock's DDL guard or DSQL's rejection, got ${ddl.error}`,
			);
			const truncate = await api.dbxRejectTruncate();
			assert.ok(truncate.error === 'DsqlValidationError' || truncate.error === DatabaseErrors.QueryFailed, `got ${truncate.error}`);
		});

		test('dbx - Kysely typed select', async () => {
			const api = getApi();
			const id = `x-k-${Date.now().toString(36)}`;
			await api.dbxInsert(id, 'kysely', 77);
			const rows = await api.dbxKyselySelect(77);
			assert.ok(rows.some((r) => r.id === id && r.value === 77));
			await api.dbxDelete(id);
		});

		test('shared cluster - two blocks with the same table name do not see each other', async () => {
			const api = getApi();
			const sku = `sku-${Date.now().toString(36)}`;
			const account = `acct-${Date.now().toString(36)}`;
			const before = await api.sharedClusterCounts();
			const item = await api.inventoryAdd(sku, 3);
			assert.ok(item && typeof item.id === 'number', 'SERIAL identity assigned');
			assert.deepStrictEqual(await api.ledgerAdd(account, 'alice', 40), { account_id: account, total: 40 });
			assert.deepStrictEqual(await api.ledgerAdd(account, 'alice', 2), { account_id: account, total: 42 });
			const after = await api.sharedClusterCounts();
			assert.strictEqual(after.inventory, before.inventory + 1);
			assert.strictEqual(after.ledger, before.ledger + 2);
			// Full PostgreSQL on the provisioned cluster: the foreign key cascades.
			assert.deepStrictEqual(await api.ledgerDeleteAccount(account), { remainingItems: 0 });
			await api.inventoryDelete(sku);
		});

		test('shared cluster - Row Level Security scopes reads to the owner', async () => {
			const api = getApi();
			const stamp = Date.now().toString(36);
			await api.ledgerAdd(`rls-${stamp}-a`, `owner-a-${stamp}`, 1);
			await api.ledgerAdd(`rls-${stamp}-b`, `owner-b-${stamp}`, 1);
			assert.deepStrictEqual(await api.ledgerOwnedAccounts(`owner-a-${stamp}`), [`rls-${stamp}-a`]);
			assert.deepStrictEqual(await api.ledgerOwnedAccounts(`owner-b-${stamp}`), [`rls-${stamp}-b`]);
			await api.ledgerDeleteAccount(`rls-${stamp}-a`);
			await api.ledgerDeleteAccount(`rls-${stamp}-b`);
		});
	});
}
