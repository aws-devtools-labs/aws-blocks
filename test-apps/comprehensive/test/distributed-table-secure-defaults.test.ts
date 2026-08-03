// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Real-deploy coverage for the DistributedTable secure-defaults change
// (review comment #6). Synth tests already assert the CloudFormation template
// shape; this exercises the actual AWS deploy path — a table that carries the
// durability props (PITR + a narrowed recovery window + SSE-KMS) *alongside* a
// GSI, so the GSI custom resource and the durability configuration provision
// together on a live table rather than only in a template.
//
// Runs only against a deployed stack (sandbox/production); a no-op locally
// where there is no DynamoDB service to describe.

import { describe, test } from 'node:test';
import assert from 'node:assert';
import type { api as apiType } from 'aws-blocks';
import {
	DynamoDBClient,
	DescribeTableCommand,
	DescribeContinuousBackupsCommand,
} from '@aws-sdk/client-dynamodb';

const ENV = process.env.BLOCKS_TEST_ENV || 'local';
const isDeployed = ENV === 'sandbox' || ENV === 'production';

// Table name is derived deterministically from the block's scoped fullId
// (`new Scope('test-app')` + id `secure-items`), truncated to 255 chars — the
// same value the CDK, runtime, and mock layers each compute independently.
const SECURE_TABLE_NAME = 'test-app-secure-items';

const ddb = isDeployed
	? new DynamoDBClient({ region: process.env.AWS_REGION || 'us-east-1' })
	: null;

export function distributedTableSecureDefaultsTests(getApi: () => typeof apiType) {
	describe('DistributedTable secure defaults (deployed)', () => {
		test('secure-items table is readable/writable (PITR + GSI table is functional)', async () => {
			const api = getApi();
			const pk = `sec-${Date.now().toString(36)}`;
			await api.secureTablePut({ pk, sk: 'a', data: 'hello', timestamp: 1000 });
			assert.deepStrictEqual(
				await api.secureTableGet({ pk, sk: 'a' }),
				{ pk, sk: 'a', data: 'hello', timestamp: 1000 },
			);
			// Query the GSI that was provisioned alongside the durability props —
			// proves the GSI custom resource's UpdateTable and the table's PITR/SSE
			// configuration coexist on the deployed table.
			const byTs = await api.secureTableQuery({
				index: 'byTimestamp',
				where: { pk: { equals: pk } },
			});
			assert.strictEqual(byTs.length, 1);
			assert.strictEqual(byTs[0]?.data, 'hello');
		});

		test('deployed table has PITR enabled with the 7-day recovery window', { skip: !isDeployed }, async () => {
			assert.ok(ddb, 'DynamoDB client required for deployed assertions');
			const res = await ddb.send(new DescribeContinuousBackupsCommand({ TableName: SECURE_TABLE_NAME }));
			const pitr = res.ContinuousBackupsDescription?.PointInTimeRecoveryDescription;
			assert.strictEqual(pitr?.PointInTimeRecoveryStatus, 'ENABLED', 'PITR should be ENABLED');
			assert.strictEqual(pitr?.RecoveryPeriodInDays, 7, 'recovery window should be the configured 7 days');
		});

		test('deployed table is encrypted with SSE-KMS and carries the GSI', { skip: !isDeployed }, async () => {
			assert.ok(ddb, 'DynamoDB client required for deployed assertions');
			const res = await ddb.send(new DescribeTableCommand({ TableName: SECURE_TABLE_NAME }));
			const t = res.Table;
			// SSE-KMS at rest (aws/dynamodb managed key → SSEType 'KMS').
			assert.strictEqual(t?.SSEDescription?.SSEType, 'KMS', 'table should use SSE-KMS at rest');
			// The GSI provisioned alongside the durability props is present + active.
			const gsi = t?.GlobalSecondaryIndexes?.find((i) => i.IndexName === 'byTimestamp');
			assert.ok(gsi, 'byTimestamp GSI should exist on the deployed table');
			assert.strictEqual(gsi?.IndexStatus, 'ACTIVE', 'GSI should be ACTIVE');
		});
	});
}
