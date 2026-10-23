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
import { CloudFormationClient, DescribeStacksCommand, GetTemplateCommand } from '@aws-sdk/client-cloudformation';

const dynamodb = new DynamoDBClient({});
// Many tables' resources can read the same stack at once during a stack delete.
const cloudformation = new CloudFormationClient({ maxAttempts: 8 });

interface IndexConfig {
	partitionKey: string;
	sortKey?: string;
	partitionKeyType?: 'S' | 'N' | 'B';
	sortKeyType?: 'S' | 'N' | 'B';
}

interface CfnEvent {
	RequestType: 'Create' | 'Update' | 'Delete';
	StackId?: string;
	PhysicalResourceId?: string;
	ResourceProperties: {
		TableName: string;
		Indexes: Record<string, IndexConfig>;
		SandboxMode?: string;
	};
}

// Set by onEvent on a Delete that must leave the table's indexes alone. The
// Provider framework passes onEvent's result into every isComplete call.
const KEEP_INDEXES = 'KeepIndexes';

// ── Helpers ─────────────────────────────────────────────────────────────────

async function describeTable(tableName: string) {
	const result = await dynamodb.send(new DescribeTableCommand({ TableName: tableName }));
	return result.Table!;
}

function isTableNotFound(e: unknown): boolean {
	return e instanceof Error && e.name === 'ResourceNotFoundException';
}

// Delete only: a table that is already gone has no indexes left to remove.
async function describeTableIfExists(tableName: string) {
	try {
		return await describeTable(tableName);
	} catch (e) {
		if (isTableNotFound(e)) {
			console.log(`Table ${tableName} no longer exists; nothing to delete`);
			return null;
		}
		throw e;
	}
}

// Stack states in which a Delete means the whole stack (or its failed first
// create) is going away. The custom resource depends on the table, so it is
// deleted while the table still exists: a RETAIN table survives and must keep
// its indexes, a DESTROY table is deleted right after anyway.
const STACK_GOING_AWAY = new Set(['DELETE_IN_PROGRESS', 'ROLLBACK_IN_PROGRESS']);

// The cleanup phase of an update or update rollback. A Delete that fails here
// is reported as a DELETE_FAILED stack event; the update is not rolled back.
const UPDATE_CLEANUP = new Set(['UPDATE_COMPLETE_CLEANUP_IN_PROGRESS', 'UPDATE_ROLLBACK_COMPLETE_CLEANUP_IN_PROGRESS']);

/**
 * Decide whether a Delete must leave the table's indexes in place.
 *
 * CloudFormation sends the same Delete when `indexes` is removed from the
 * config (drop them: the table stays in the stack) and when the table itself
 * leaves the stack (keep them: a RETAIN table is orphaned with its data). In
 * the cleanup phase of an update or update rollback the stack's current
 * template tells the two apart: it still has the table only when the table
 * stays. A failure to read the stack status keeps the indexes, the
 * non-destructive choice. A failure to read the template in an update cleanup
 * keeps them too but throws, so the Delete is reported as failed instead of
 * silently leaving indexes the config no longer has.
 */
async function deleteKeepsIndexes(stackId: string | undefined, tableName: string, indexNames: string[]): Promise<boolean> {
	if (!stackId) {
		console.warn('Delete without a StackId; leaving the indexes in place');
		return true;
	}
	let status: string | undefined;
	try {
		const { Stacks } = await cloudformation.send(new DescribeStacksCommand({ StackName: stackId }));
		status = Stacks?.[0]?.StackStatus;
	} catch (e) {
		console.warn('Could not read the stack status; leaving the indexes in place:', e);
		return true;
	}
	console.log(`Stack status: ${status}`);
	if (status === undefined || STACK_GOING_AWAY.has(status)) return true;

	let tableStays: boolean;
	try {
		const { TemplateBody } = await cloudformation.send(new GetTemplateCommand({ StackName: stackId, TemplateStage: 'Processed' }));
		const resources: Record<string, { Type?: string; Properties?: { TableName?: unknown } }> =
			JSON.parse(TemplateBody ?? '{}').Resources ?? {};
		tableStays = Object.values(resources).some(
			(r) => r.Type === 'AWS::DynamoDB::Table' && r.Properties?.TableName === tableName,
		);
	} catch (e) {
		if (UPDATE_CLEANUP.has(status)) {
			const indexes = indexNames.length > 0 ? ` (${indexNames.join(', ')})` : '';
			throw new Error(
				`Could not read the stack template to tell whether table ${tableName} stays in the stack, so its ` +
					`indexes${indexes} were left in place. If the table is still in your app, delete the indexes ` +
					`it no longer configures with UpdateTable. Cause: ${e instanceof Error ? e.message : String(e)}`,
			);
		}
		console.warn('Could not read the stack template; leaving the indexes in place:', e);
		return true;
	}
	console.log(tableStays ? 'Table stays in the stack' : 'Table is leaving the stack');
	return !tableStays;
}

// On Delete a missing table is success: it has no indexes left to remove.
// Create and Update still fail on a missing table.
async function describeForRequest(requestType: CfnEvent['RequestType'], tableName: string) {
	return requestType === 'Delete' ? describeTableIfExists(tableName) : describeTable(tableName);
}

// Start the next GSI change. Returns false when a Delete finds that the table
// was deleted after DescribeTable: nothing is left to delete.
async function initiateNextChangeTolerant(
	requestType: CfnEvent['RequestType'],
	tableName: string,
	table: any,
	desired: Record<string, IndexConfig>,
): Promise<boolean> {
	try {
		await initiateNextChange(tableName, table, desired);
		return true;
	} catch (e) {
		if (requestType === 'Delete' && isTableNotFound(e)) return false;
		throw e;
	}
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
	table.KeySchema!.forEach((k: any) => {
		usedAttrs.add(k.AttributeName!);
	});
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

	if (event.RequestType === 'Delete' && await deleteKeepsIndexes(event.StackId, TableName, Object.keys(Indexes ?? {}))) {
		console.log('Leaving the indexes in place');
		return { PhysicalResourceId: physicalId, Data: { Status: 'COMPLETE', [KEEP_INDEXES]: 'true' } };
	}

	// Check if already done
	const table = await describeForRequest(event.RequestType, TableName);
	if (!table) return { PhysicalResourceId: physicalId, Data: { Status: 'COMPLETE' } };
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
	if (!isTableBusy(table) && !(await initiateNextChangeTolerant(event.RequestType, TableName, table, desired))) {
		return { PhysicalResourceId: physicalId, Data: { Status: 'COMPLETE' } };
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

	if (event.RequestType === 'Delete' && event.Data?.[KEEP_INDEXES] === 'true') {
		return { IsComplete: true };
	}

	const table = await describeForRequest(event.RequestType, TableName);
	if (!table) return { IsComplete: true };

	// If a GSI operation is in progress, wait for it
	if (isTableBusy(table)) {
		console.log('Table busy, waiting...');
		return { IsComplete: false };
	}

	// If we match the desired state, we're done
	if (gsiMatchesDesired(table, desired)) {
		console.log('✅ All GSIs match desired state');
		return { IsComplete: true };
	}

	// Table is idle but doesn't match — initiate the next change
	if (!(await initiateNextChangeTolerant(event.RequestType, TableName, table, desired))) return { IsComplete: true };
	return { IsComplete: false };
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
