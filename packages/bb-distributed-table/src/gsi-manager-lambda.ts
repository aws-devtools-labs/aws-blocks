// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
	DynamoDBClient,
	DescribeTableCommand,
	UpdateTableCommand,
	DeleteTableCommand,
	CreateTableCommand,
	ScanCommand,
	BatchWriteItemCommand,
	BillingMode,
	ScalarAttributeType,
	KeyType,
} from '@aws-sdk/client-dynamodb';

const dynamodb = new DynamoDBClient({});

interface IndexConfig {
	partitionKey: string;
	sortKey?: string;
	partitionKeyType?: 'S' | 'N' | 'B';
	sortKeyType?: 'S' | 'N' | 'B';
}

interface CfnEvent {
	RequestType: 'Create' | 'Update' | 'Delete';
	PhysicalResourceId?: string;
	ResourceProperties: {
		TableName: string;
		Indexes: Record<string, IndexConfig>;
		SandboxMode?: string;
	};
}

// ── Helpers ─────────────────────────────────────────────────────────────────

async function describeTable(tableName: string) {
	const result = await dynamodb.send(new DescribeTableCommand({ TableName: tableName }));
	return result.Table!;
}

function getCurrentGSIs(table: any): Record<string, { pk: string; sk?: string }> {
	const gsis: Record<string, { pk: string; sk?: string }> = {};
	for (const gsi of table.GlobalSecondaryIndexes ?? []) {
		const pk = gsi.KeySchema?.find((k: any) => k.KeyType === 'HASH')?.AttributeName;
		const sk = gsi.KeySchema?.find((k: any) => k.KeyType === 'RANGE')?.AttributeName;
		if (pk) gsis[gsi.IndexName!] = { pk, sk };
	}
	return gsis;
}

function gsiMatchesDesired(table: any, desired: Record<string, IndexConfig>): boolean {
	const current = getCurrentGSIs(table);
	const currentNames = Object.keys(current);
	const desiredNames = Object.keys(desired);

	if (currentNames.length !== desiredNames.length) return false;
	for (const name of desiredNames) {
		if (!current[name]) return false;
		if (current[name].pk !== desired[name].partitionKey) return false;
		if (current[name].sk !== desired[name].sortKey) return false;
	}
	return true;
}

function isTableBusy(table: any): boolean {
	if (table.TableStatus !== 'ACTIVE') return true;
	for (const gsi of table.GlobalSecondaryIndexes ?? []) {
		if (gsi.IndexStatus !== 'ACTIVE') return true;
	}
	return false;
}

// ── Sandbox fast path ───────────────────────────────────────────────────────

async function recreateTableWithIndexes(tableName: string, desired: Record<string, IndexConfig>) {
	console.log('⚠️  SANDBOX MODE: Recreating table with all GSIs (fast path)');

	const table = await describeTable(tableName);

	// Backup data
	const items: any[] = [];
	let lastKey: any;
	do {
		const result = await dynamodb.send(new ScanCommand({ TableName: tableName, ExclusiveStartKey: lastKey }));
		items.push(...(result.Items ?? []));
		lastKey = result.LastEvaluatedKey;
	} while (lastKey);
	console.log(`Backed up ${items.length} items`);

	// Delete table
	await dynamodb.send(new DeleteTableCommand({ TableName: tableName }));
	while (true) {
		try {
			await dynamodb.send(new DescribeTableCommand({ TableName: tableName }));
			await new Promise(r => setTimeout(r, 3000));
		} catch (e: any) {
			if (e.name === 'ResourceNotFoundException') break;
			throw e;
		}
	}

	// Collect all attribute definitions needed for keys
	const usedAttrs = new Set<string>();
	table.KeySchema!.forEach((k: any) => usedAttrs.add(k.AttributeName!));
	for (const cfg of Object.values(desired)) {
		usedAttrs.add(cfg.partitionKey);
		if (cfg.sortKey) usedAttrs.add(cfg.sortKey);
	}

	const existingAttrMap = new Map<string, string>();
	for (const attr of table.AttributeDefinitions ?? []) {
		existingAttrMap.set(attr.AttributeName!, attr.AttributeType!);
	}

	const attrDefs = [...usedAttrs].map(name => ({
		AttributeName: name,
		AttributeType: (existingAttrMap.get(name) ??
			Object.values(desired).find(c => c.partitionKey === name)?.partitionKeyType ??
			Object.values(desired).find(c => c.sortKey === name)?.sortKeyType ??
			ScalarAttributeType.S) as ScalarAttributeType,
	}));

	// Recreate with all GSIs
	await dynamodb.send(new CreateTableCommand({
		TableName: tableName,
		KeySchema: table.KeySchema,
		AttributeDefinitions: attrDefs,
		BillingMode: BillingMode.PAY_PER_REQUEST,
		GlobalSecondaryIndexes: Object.entries(desired).map(([name, cfg]) => ({
			IndexName: name,
			KeySchema: [
				{ AttributeName: cfg.partitionKey, KeyType: KeyType.HASH },
				...(cfg.sortKey ? [{ AttributeName: cfg.sortKey, KeyType: KeyType.RANGE }] : []),
			],
			Projection: { ProjectionType: 'ALL' as const },
		})),
	}));

	// Wait for active
	while (true) {
		const t = await describeTable(tableName);
		if (!isTableBusy(t)) break;
		await new Promise(r => setTimeout(r, 3000));
	}

	// Restore data
	for (let i = 0; i < items.length; i += 25) {
		await dynamodb.send(new BatchWriteItemCommand({
			RequestItems: { [tableName]: items.slice(i, i + 25).map(item => ({ PutRequest: { Item: item } })) },
		}));
	}
	console.log(`✅ Sandbox: table recreated with ${Object.keys(desired).length} GSIs, ${items.length} items restored`);
}

// ── onEvent handler ─────────────────────────────────────────────────────────
// Called once per Create/Update/Delete. Kicks off the first GSI change (or
// the sandbox fast path). Returns immediately — isComplete polls for progress.

export async function handler(event: CfnEvent) {
	console.log('onEvent:', JSON.stringify(event, null, 2));

	const { TableName, Indexes, SandboxMode } = event.ResourceProperties;
	const desired = event.RequestType === 'Delete' ? {} : (Indexes ?? {});
	const isSandbox = SandboxMode === 'true';

	// On Create, we set the physical resource ID. On Update/Delete, we must
	// echo back the original ID — CloudFormation rejects changes to it.
	const physicalId = event.PhysicalResourceId ?? TableName;

	// Check if already done
	const table = await describeTable(TableName);
	if (gsiMatchesDesired(table, desired) && !isTableBusy(table)) {
		console.log('Already in desired state');
		return { PhysicalResourceId: physicalId, Data: { Status: 'COMPLETE' } };
	}

	// Sandbox fast path: drop and recreate with all GSIs at once
	if (isSandbox && Object.keys(desired).length > 0) {
		await recreateTableWithIndexes(TableName, desired);
		return { PhysicalResourceId: physicalId, Data: { Status: 'COMPLETE' } };
	}

	// Production path: initiate the first GSI change if table is idle.
	// If table is busy (prior GSI still updating), just return — isComplete will poll.
	if (!isTableBusy(table)) {
		await initiateNextChange(TableName, table, desired);
	}

	return { PhysicalResourceId: physicalId, Data: { Status: 'IN_PROGRESS' } };
}

// ── isComplete handler ──────────────────────────────────────────────────────
// Called periodically by the Provider framework. Checks if the table matches
// the desired state. If a GSI update is in progress, returns IsComplete=false.
// If the table is idle but doesn't match, initiates the next change.
// Creations are performed before deletions when possible.

export async function isCompleteHandler(event: any) {
	console.log('isComplete:', JSON.stringify(event, null, 2));

	const { TableName, Indexes, SandboxMode } = event.ResourceProperties;
	const desired = event.RequestType === 'Delete' ? {} : (Indexes ?? {});

	const table = await describeTable(TableName);

	// If a GSI operation is in progress, wait for it
	if (isTableBusy(table)) {
		if (event.RequestType !== 'Delete') await probeConcurrentCreate(TableName, table, desired);
		console.log('Table busy, waiting...');
		return { IsComplete: false };
	}

	// If we match the desired state, we're done
	if (gsiMatchesDesired(table, desired)) {
		console.log('✅ All GSIs match desired state');
		return { IsComplete: true };
	}

	// Table is idle but doesn't match — initiate the next change
	await initiateNextChange(TableName, table, desired);
	return { IsComplete: false };
}

// -- EXPERIMENT ONLY (do not merge) ------------------------------------------
// While one GSI is CREATING, try to start the create of the next missing GSI
// and log whether DynamoDB accepts it. Never throws: on rejection the normal
// serial path continues unchanged.
async function probeConcurrentCreate(tableName: string, table: any, desired: Record<string, IndexConfig>) {
	const building = (table.GlobalSecondaryIndexes ?? []).find((g: any) => g.IndexStatus === 'CREATING');
	const current = getCurrentGSIs(table);
	const next = Object.entries(desired).find(([name]) => !current[name]);
	if (!building || !next) return;
	const [name, cfg] = next;
	const phase = `table=${table.TableStatus} building=${building.IndexName} backfilling=${building.Backfilling}`;
	const attrDefs = [{ AttributeName: cfg.partitionKey, AttributeType: (cfg.partitionKeyType ?? 'S') as ScalarAttributeType }];
	if (cfg.sortKey) attrDefs.push({ AttributeName: cfg.sortKey, AttributeType: (cfg.sortKeyType ?? 'S') as ScalarAttributeType });
	try {
		await dynamodb.send(new UpdateTableCommand({
			TableName: tableName,
			AttributeDefinitions: attrDefs,
			GlobalSecondaryIndexUpdates: [{
				Create: {
					IndexName: name,
					KeySchema: [
						{ AttributeName: cfg.partitionKey, KeyType: KeyType.HASH },
						...(cfg.sortKey ? [{ AttributeName: cfg.sortKey, KeyType: KeyType.RANGE }] : []),
					],
					Projection: { ProjectionType: 'ALL' },
				},
			}],
		}));
		console.log(`GSI_PROBE accepted create '${name}' while ${phase}`);
	} catch (e: any) {
		console.log(`GSI_PROBE rejected create '${name}' while ${phase}: ${e?.name}: ${e?.message}`);
	}
}

// ── Initiate next GSI change ────────────────────────────────────────────────
// Performs creations before deletions when possible.
//
// Edge case where deletion must happen first: if a desired GSI has the same
// name as an existing GSI but different key schema. DynamoDB doesn't support
// in-place GSI modification — the old one must be deleted before the new one
// can be created. We detect this by checking if a current GSI name exists in
// desired but with a different key schema.

async function initiateNextChange(
	tableName: string,
	table: any,
	desired: Record<string, IndexConfig>,
) {
	const current = getCurrentGSIs(table);
	const existingAttrMap = new Map<string, string>();
	for (const attr of table.AttributeDefinitions ?? []) {
		existingAttrMap.set(attr.AttributeName!, attr.AttributeType!);
	}

	// 1. Check for schema-mismatched GSIs that must be deleted before recreation.
	//    These take priority because the creation of the replacement can't proceed
	//    until the old one is gone.
	for (const [name, cur] of Object.entries(current)) {
		const des = desired[name];
		if (des && (cur.pk !== des.partitionKey || cur.sk !== des.sortKey)) {
			console.log(`Deleting GSI '${name}' (schema mismatch — must delete before recreating)`);
			await dynamodb.send(new UpdateTableCommand({
				TableName: tableName,
				GlobalSecondaryIndexUpdates: [{ Delete: { IndexName: name } }],
			}));
			return;
		}
	}

	// 2. Create missing GSIs (creations before deletions)
	for (const [name, cfg] of Object.entries(desired)) {
		if (!current[name]) {
			console.log(`Creating GSI '${name}'`);
			const attrDefs: { AttributeName: string; AttributeType: ScalarAttributeType }[] = [];
			attrDefs.push({
				AttributeName: cfg.partitionKey,
				AttributeType: (existingAttrMap.get(cfg.partitionKey) ?? cfg.partitionKeyType ?? ScalarAttributeType.S) as ScalarAttributeType,
			});
			if (cfg.sortKey) {
				attrDefs.push({
					AttributeName: cfg.sortKey,
					AttributeType: (existingAttrMap.get(cfg.sortKey) ?? cfg.sortKeyType ?? ScalarAttributeType.S) as ScalarAttributeType,
				});
			}

			await dynamodb.send(new UpdateTableCommand({
				TableName: tableName,
				AttributeDefinitions: attrDefs,
				GlobalSecondaryIndexUpdates: [{
					Create: {
						IndexName: name,
						KeySchema: [
							{ AttributeName: cfg.partitionKey, KeyType: KeyType.HASH },
							...(cfg.sortKey ? [{ AttributeName: cfg.sortKey, KeyType: KeyType.RANGE }] : []),
						],
						Projection: { ProjectionType: 'ALL' },
					},
				}],
			}));
			return;
		}
	}

	// 3. Delete extra GSIs (only after all creations are done)
	for (const name of Object.keys(current)) {
		if (!desired[name]) {
			console.log(`Deleting GSI '${name}' (no longer desired)`);
			await dynamodb.send(new UpdateTableCommand({
				TableName: tableName,
				GlobalSecondaryIndexUpdates: [{ Delete: { IndexName: name } }],
			}));
			return;
		}
	}
}
