// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Real-deploy coverage for the DistributedTable secure-defaults change
// (review comment #6). Synth tests already assert the CloudFormation template
// shape (PITR + recovery window, SSE-KMS, deletion protection, the GSI). This
// exercises the actual AWS deploy path: the `secure-items` table carries the
// durability props (PITR + a narrowed recovery window) *and* a GSI, so the GSI
// custom resource's UpdateTable and the table's durability configuration must
// provision together on a live table.
//
// The strongest signal here is structural: if that CloudFormation interaction
// failed (the collision the review flagged), the sandbox/production *deploy*
// step fails before this file ever runs. Reaching these tests at all means the
// durable+GSI table deployed cleanly; the assertions below then prove the
// deployed table is actually functional (reads/writes + a GSI query).
//
// Deliberately API-only — no direct AWS SDK client in the test. The exact
// on-table values (RecoveryPeriodInDays, SSEType, GSI status) are asserted at
// synth level in packages/bb-distributed-table/src/index.cdk.test.ts.

import { describe, test } from 'node:test';
import assert from 'node:assert';
import type { api as apiType } from 'aws-blocks';

function uid() { return `sec-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`; }

export function distributedTableSecureDefaultsTests(getApi: () => typeof apiType) {
	describe('DistributedTable secure defaults (durable table + GSI)', () => {
		test('secure-items table (PITR + GSI) is readable and writable', async () => {
			const api = getApi();
			const pk = uid();
			await api.secureTablePut({ pk, sk: 'a', data: 'hello', timestamp: 1000 });
			assert.deepStrictEqual(
				await api.secureTableGet({ pk, sk: 'a' }),
				{ pk, sk: 'a', data: 'hello', timestamp: 1000 },
			);
			await api.secureTablePut({ pk, sk: 'b', data: 'world', timestamp: 2000 });
			assert.strictEqual((await api.secureTableGet({ pk, sk: 'b' }))?.data, 'world');
		});

		test('secure-items GSI query works (GSI custom resource + durability props coexist)', async () => {
			const api = getApi();
			const pk = uid();
			await api.secureTablePut({ pk, sk: 'x', data: 'first', timestamp: 100 });
			await api.secureTablePut({ pk, sk: 'y', data: 'second', timestamp: 200 });
			// Query the byTimestamp GSI provisioned alongside PITR — proves the GSI
			// custom resource's UpdateTable and the durability configuration
			// deployed together and left the index usable.
			const rows = await api.secureTableQuery({
				index: 'byTimestamp',
				where: { pk: { equals: pk } },
			});
			assert.strictEqual(rows.length, 2);
			assert.deepStrictEqual(rows.map((r) => r.data).sort(), ['first', 'second']);
		});
	});
}
