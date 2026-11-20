// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { CloudFormationClient, DescribeStacksCommand, GetTemplateCommand } from '@aws-sdk/client-cloudformation';
import {
	type AttributeValue,
	BatchWriteItemCommand,
	BillingMode,
	CreateTableCommand,
	DeleteTableCommand,
	DescribeContinuousBackupsCommand,
	DescribeTableCommand,
	DescribeTimeToLiveCommand,
	DynamoDBClient,
	KeyType,
	ListTagsOfResourceCommand,
	ScalarAttributeType,
	ScanCommand,
	type SSESpecification,
	type StreamSpecification,
	type TableClass,
	type TableDescription,
	type Tag,
	UpdateContinuousBackupsCommand,
	UpdateTableCommand,
	UpdateTimeToLiveCommand,
	type WriteRequest,
} from '@aws-sdk/client-dynamodb';

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
		/**
		 * ARN of the customer-managed KMS key of the table, set only in sandbox
		 * mode and only for a store with `encryption: 'customer-managed'` or
		 * `KVStore.fromKmsKey()`. It tells the sandbox fast path that the KMS key
		 * of the live table is a customer key to pass to CreateTable, and not the
		 * AWS-managed `aws/dynamodb` key.
		 */
		EncryptionKeyArn?: string;
		/**
		 * The settings that the CDK layer declares on the table, set only in
		 * sandbox mode. The fast path gives them to a table that lacks them: one
		 * that an earlier version recreated without them. The CDK layer always
		 * encrypts the table with a KMS key, so a table with no KMS encryption gets
		 * the key of `EncryptionKeyArn`, or the AWS-managed key.
		 */
		DeclaredSettings?: DeclaredSettings;
	};
}

/** Custom resource properties are strings: CloudFormation turns a boolean or a number into one. */
interface DeclaredSettings {
	TimeToLiveAttribute?: string;
	/** `'true'` when point-in-time recovery is on. */
	PointInTimeRecovery?: string;
	RecoveryPeriodInDays?: string;
}

// CloudFormation's presigned response URL lets its holder answer for the
// custom resource, so the event is logged without it.
function loggable(event: unknown): string {
	return JSON.stringify(event, (key, value) => (key === 'ResponseURL' ? '<redacted>' : value), 2);
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
 * CloudFormation sends the same Delete in two cases. In the first, `indexes` is
 * removed from the config: drop the indexes, because the table stays in the
 * stack. In the second, the table itself leaves the stack: keep the indexes,
 * because a RETAIN table stays in the account with its data. In the cleanup
 * phase of an update or update rollback the stack's current template tells the
 * two apart: it still has the table only when the table stays. A failure to read
 * the stack status keeps the indexes, the non-destructive choice. A failure to
 * read the template in an update cleanup keeps them too but throws. The Delete
 * is then reported as failed, and indexes that the config no longer has are not
 * left behind with no error.
 */
async function deleteKeepsIndexes(
	stackId: string | undefined,
	tableName: string,
	indexNames: string[],
): Promise<boolean> {
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
		const { TemplateBody } = await cloudformation.send(
			new GetTemplateCommand({ StackName: stackId, TemplateStage: 'Processed' }),
		);
		const resources: Record<string, { Type?: string; Properties?: { TableName?: unknown } }> =
			JSON.parse(TemplateBody ?? '{}').Resources ?? {};
		tableStays = Object.values(resources).some(
			(r) => r.Type === 'AWS::DynamoDB::Table' && r.Properties?.TableName === tableName,
		);
	} catch (e) {
		if (UPDATE_CLEANUP.has(status)) {
			// The failure reason travels in the custom resource response, capped at 4 KB.
			const shown = indexNames.slice(0, 5).join(', ');
			const more = indexNames.length > 5 ? ` and ${indexNames.length - 5} more` : '';
			const indexes = indexNames.length > 0 ? ` (${shown}${more})` : '';
			const rolledBack =
				'The update was rolled back: an index it added may remain. A later deploy that adds it again ' +
				'with the same keys reuses it; otherwise delete it with UpdateTable.';
			const removed =
				'If the table is still in your app, delete the indexes it no longer configures with UpdateTable.';
			const next = status === 'UPDATE_ROLLBACK_COMPLETE_CLEANUP_IN_PROGRESS' ? rolledBack : removed;
			const cause = e instanceof Error ? e.message : String(e);
			throw new Error(
				`Could not read the stack template to tell whether table ${tableName} stays in the stack, so its ` +
					`indexes${indexes} were left in place. ${next} Cause: ${cause}`,
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

let sleep = (ms: number): Promise<unknown> => new Promise((r) => setTimeout(r, ms));

/** @internal Replaces the wait between retries and status polls of the fast path, for a test; returns the previous one. */
export function _setSleepForTest(replacement: typeof sleep): typeof sleep {
	const previous = sleep;
	sleep = replacement;
	return previous;
}

// Tag keys with this prefix belong to AWS (for example the
// `aws:cloudformation:*` tags) and TagResource rejects them.
const AWS_TAG_PREFIX = 'aws:';

// UpdateContinuousBackups fails with this error for a short time after a
// table is created, until DynamoDB can turn backups on for it.
const CONTINUOUS_BACKUPS_UNAVAILABLE = 'ContinuousBackupsUnavailableException';
const PITR_RETRY_ATTEMPTS = 40;

// BatchWriteItem takes 25 items. Waits of 0.1 s doubling to 5 s: about half a
// minute for a batch before it counts as not written.
const RESTORE_BATCH_SIZE = 25;
const RESTORE_ATTEMPTS = 12;
const RESTORE_FIRST_DELAY_MS = 100;
const RESTORE_MAX_DELAY_MS = 5000;
const RETRY_DELAY_MS = 3000;

/**
 * The settings of a live table that CreateTable does not copy from anything,
 * so the sandbox fast path reads them before it deletes the table and applies
 * them to the new table. The CDK layer sets encryption, TTL, PITR and tags (the
 * stack tags); streams and the table class are kept as well when set.
 */
interface TableSettings {
	/** Undefined: the AWS-owned key, which CreateTable uses by default. */
	sse?: SSESpecification;
	stream?: StreamSpecification;
	tableClass?: TableClass;
	/** User tags only; `aws:` tags cannot be set again. */
	tags: Tag[];
	/** Set when TTL is on (or turning on). */
	ttlAttribute?: string;
	/** Set when point-in-time recovery is on. */
	pitr?: { recoveryPeriodInDays?: number };
	/** The settings that the live table lacked and that come from the stack's declaration. */
	added: string[];
}

const kmsEncryption = (customerKeyArn?: string): SSESpecification =>
	customerKeyArn
		? { Enabled: true, SSEType: 'KMS', KMSMasterKeyId: customerKeyArn }
		: { Enabled: true, SSEType: 'KMS' };

/**
 * Read every setting that the recreate must keep. Any failure throws before
 * the table is deleted, so a missing permission never costs the table.
 *
 * @param customerKeyArn - the `EncryptionKeyArn` property. DescribeTable reports
 *   an ARN for the AWS-managed key too, so only this property tells the two apart.
 * @param declared - the `DeclaredSettings` property. A setting it names that the
 *   live table lacks is taken from it and listed in `added`.
 */
async function readTableSettings(
	tableName: string,
	table: TableDescription,
	customerKeyArn: string | undefined,
	declared: DeclaredSettings | undefined,
): Promise<TableSettings> {
	const settings: TableSettings = { tags: [], added: [] };

	if (table.SSEDescription?.SSEType === 'KMS') {
		settings.sse = kmsEncryption(customerKeyArn && (table.SSEDescription.KMSMasterKeyArn ?? customerKeyArn));
	}
	if (table.StreamSpecification?.StreamEnabled) {
		settings.stream = { StreamEnabled: true, StreamViewType: table.StreamSpecification.StreamViewType };
	}
	if (table.TableClassSummary?.TableClass) settings.tableClass = table.TableClassSummary.TableClass;

	let nextToken: string | undefined;
	do {
		const page = await dynamodb.send(
			new ListTagsOfResourceCommand({ ResourceArn: table.TableArn, NextToken: nextToken }),
		);
		for (const tag of page.Tags ?? []) {
			if (!tag.Key?.startsWith(AWS_TAG_PREFIX)) settings.tags.push(tag);
		}
		nextToken = page.NextToken;
	} while (nextToken);

	const { TimeToLiveDescription: ttl } = await dynamodb.send(new DescribeTimeToLiveCommand({ TableName: tableName }));
	if ((ttl?.TimeToLiveStatus === 'ENABLED' || ttl?.TimeToLiveStatus === 'ENABLING') && ttl.AttributeName) {
		settings.ttlAttribute = ttl.AttributeName;
	}

	const { ContinuousBackupsDescription: backups } = await dynamodb.send(
		new DescribeContinuousBackupsCommand({ TableName: tableName }),
	);
	const pitr = backups?.PointInTimeRecoveryDescription;
	if (pitr?.PointInTimeRecoveryStatus === 'ENABLED') {
		settings.pitr = { recoveryPeriodInDays: pitr.RecoveryPeriodInDays };
	}

	if (declared) {
		if (!settings.sse) {
			settings.sse = kmsEncryption(customerKeyArn);
			settings.added.push('encryption');
		}
		if (!settings.ttlAttribute && declared.TimeToLiveAttribute) {
			settings.ttlAttribute = declared.TimeToLiveAttribute;
			settings.added.push('TTL');
		}
		if (!settings.pitr && declared.PointInTimeRecovery === 'true') {
			const days = Number(declared.RecoveryPeriodInDays);
			settings.pitr = { recoveryPeriodInDays: Number.isInteger(days) && days > 0 ? days : undefined };
			settings.added.push('point-in-time recovery');
		}
	}
	return settings;
}

/** Turn TTL and point-in-time recovery back on. Both need an ACTIVE table. */
async function applySettingsAfterCreate(tableName: string, settings: TableSettings) {
	if (settings.ttlAttribute) {
		await dynamodb.send(
			new UpdateTimeToLiveCommand({
				TableName: tableName,
				TimeToLiveSpecification: { Enabled: true, AttributeName: settings.ttlAttribute },
			}),
		);
	}
	if (settings.pitr) {
		for (let attempt = 1; ; attempt++) {
			try {
				await dynamodb.send(
					new UpdateContinuousBackupsCommand({
						TableName: tableName,
						PointInTimeRecoverySpecification: {
							PointInTimeRecoveryEnabled: true,
							RecoveryPeriodInDays: settings.pitr.recoveryPeriodInDays,
						},
					}),
				);
				break;
			} catch (e) {
				const unavailable = e instanceof Error && e.name === CONTINUOUS_BACKUPS_UNAVAILABLE;
				if (!unavailable || attempt >= PITR_RETRY_ATTEMPTS) throw e;
				await sleep(RETRY_DELAY_MS);
			}
		}
	}
}

/**
 * Delete the table and create it again with every desired GSI at once, then
 * copy its items back.
 *
 * CreateTable starts from defaults, so the new table gets the settings of the
 * old one explicitly: server-side encryption (the AWS-managed key, or the
 * customer key named by `customerKeyArn`), TTL, point-in-time recovery, user
 * tags, streams and the table class. They are read before the delete; TTL and
 * point-in-time recovery are set again once the new table is ACTIVE, before the
 * items are written back; a failure there is thrown after the items are back.
 * A setting that the stack declares (`declared`) and the old table lacked is
 * given to the new one. A table with deletion protection never comes here
 * (see `handler`).
 */
async function recreateTableWithIndexes(
	tableName: string,
	desired: Record<string, IndexConfig>,
	customerKeyArn: string | undefined,
	declared: DeclaredSettings | undefined,
) {
	console.log('⚠️  SANDBOX MODE: Recreating table with all GSIs (fast path)');

	const table = await describeTable(tableName);
	const settings = await readTableSettings(tableName, table, customerKeyArn, declared);
	console.log(`Keeping table settings: ${JSON.stringify({ ...settings, tags: settings.tags.map((t) => t.Key) })}`);

	// Backup data
	const items: Record<string, AttributeValue>[] = [];
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
			await sleep(RETRY_DELAY_MS);
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

	const attrDefs = [...usedAttrs].map((name) => ({
		AttributeName: name,
		AttributeType: (existingAttrMap.get(name) ??
			Object.values(desired).find((c) => c.partitionKey === name)?.partitionKeyType ??
			Object.values(desired).find((c) => c.sortKey === name)?.sortKeyType ??
			ScalarAttributeType.S) as ScalarAttributeType,
	}));

	// Recreate with all GSIs and the settings read above
	await dynamodb.send(
		new CreateTableCommand({
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
			SSESpecification: settings.sse,
			StreamSpecification: settings.stream,
			TableClass: settings.tableClass,
			...(settings.tags.length > 0 ? { Tags: settings.tags } : {}),
		}),
	);

	// Wait for active
	while (true) {
		const t = await describeTable(tableName);
		if (!isTableBusy(t)) break;
		await sleep(RETRY_DELAY_MS);
	}

	// Until they are written back, the items are only in this invocation's
	// memory. A failure to set TTL or point-in-time recovery again therefore
	// does not stop the restore: it is thrown once the items are back.
	let settingsFailure: { error: unknown } | undefined;
	try {
		await applySettingsAfterCreate(tableName, settings);
	} catch (error) {
		settingsFailure = { error };
	}

	await restoreItems(tableName, items);
	if (settingsFailure) throw settingsFailure.error;
	console.log(`✅ Sandbox: table recreated with ${Object.keys(desired).length} GSIs, ${items.length} items restored`);
}

/**
 * Write the items back, 25 at a time. A new on-demand table throttles a fast
 * restore of large items, and BatchWriteItem then succeeds and returns the
 * items it did not write: they are sent again, after a wait that doubles each
 * time. A batch that still has unprocessed items after the last attempt does
 * not stop the other batches; the function throws at the end with the count.
 */
async function restoreItems(tableName: string, items: Record<string, AttributeValue>[]) {
	let notWritten = 0;
	for (let i = 0; i < items.length; i += RESTORE_BATCH_SIZE) {
		let requests: WriteRequest[] = items
			.slice(i, i + RESTORE_BATCH_SIZE)
			.map((item) => ({ PutRequest: { Item: item } }));
		for (let attempt = 1; requests.length > 0 && attempt <= RESTORE_ATTEMPTS; attempt++) {
			if (attempt > 1) await sleep(Math.min(RESTORE_FIRST_DELAY_MS * 2 ** (attempt - 2), RESTORE_MAX_DELAY_MS));
			const result = await dynamodb.send(new BatchWriteItemCommand({ RequestItems: { [tableName]: requests } }));
			requests = result.UnprocessedItems?.[tableName] ?? [];
		}
		notWritten += requests.length;
	}
	if (notWritten > 0) {
		throw new Error(
			`${notWritten} of ${items.length} items of ${tableName} were not written back: ` +
				`DynamoDB left them unprocessed in ${RESTORE_ATTEMPTS} attempts`,
		);
	}
}

/**
 * The declared settings that the live table lacks. This runs when nothing else
 * about the table would change, so a failed read is not an error: the table is
 * left as it is.
 */
async function lackingSettings(
	tableName: string,
	table: TableDescription,
	customerKeyArn: string | undefined,
	declared: DeclaredSettings | undefined,
): Promise<string[]> {
	if (!declared) return [];
	try {
		return (await readTableSettings(tableName, table, customerKeyArn, declared)).added;
	} catch (e) {
		console.warn('Could not read the table settings; leaving the table as it is:', e);
		return [];
	}
}

// ── onEvent handler ─────────────────────────────────────────────────────────
// Called once per Create/Update/Delete. Kicks off the first GSI change (or
// the sandbox fast path). Returns immediately — isComplete polls for progress.

export async function handler(event: CfnEvent) {
	console.log('onEvent:', loggable(event));

	const { TableName, Indexes, SandboxMode, EncryptionKeyArn, DeclaredSettings } = event.ResourceProperties;
	const desired = event.RequestType === 'Delete' ? {} : (Indexes ?? {});
	const isSandbox = SandboxMode === 'true';

	// On Create, we set the physical resource ID. On Update/Delete, we must
	// echo back the original ID — CloudFormation rejects changes to it.
	const physicalId = event.PhysicalResourceId ?? TableName;

	const indexNames = Object.keys(Indexes ?? {});
	if (event.RequestType === 'Delete' && (await deleteKeepsIndexes(event.StackId, TableName, indexNames))) {
		console.log('Leaving the indexes in place');
		return { PhysicalResourceId: physicalId, Data: { Status: 'COMPLETE', [KEEP_INDEXES]: 'true' } };
	}

	// Check if already done
	const table = await describeForRequest(event.RequestType, TableName);
	if (!table) return { PhysicalResourceId: physicalId, Data: { Status: 'COMPLETE' } };
	const sandboxWithIndexes = isSandbox && Object.keys(desired).length > 0;
	if (gsiMatchesDesired(table, desired) && !isTableBusy(table)) {
		// In sandbox, a table whose indexes match can still lack what its stack
		// declares (see `DeclaredSettings`). The fast path then runs for that.
		const lacking =
			sandboxWithIndexes && !table.DeletionProtectionEnabled
				? await lackingSettings(TableName, table, EncryptionKeyArn, DeclaredSettings)
				: [];
		if (lacking.length === 0) {
			console.log('Already in desired state');
			return { PhysicalResourceId: physicalId, Data: { Status: 'COMPLETE' } };
		}
		console.log(`Table lacks ${lacking.join(', ')}, which its stack declares`);
	}

	// Sandbox fast path: drop and recreate with all GSIs at once. A table with
	// deletion protection (`protection: 'locked'`) is never deleted: it takes
	// the one-change-at-a-time path below, which only needs UpdateTable.
	if (sandboxWithIndexes) {
		if (!table.DeletionProtectionEnabled) {
			await recreateTableWithIndexes(TableName, desired, EncryptionKeyArn, DeclaredSettings);
			return { PhysicalResourceId: physicalId, Data: { Status: 'COMPLETE' } };
		}
		console.log('Table has deletion protection; changing its GSIs one at a time instead of recreating it');
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
	console.log('isComplete:', loggable(event));

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

async function initiateNextChange(tableName: string, table: any, desired: Record<string, IndexConfig>) {
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
			await dynamodb.send(
				new UpdateTableCommand({
					TableName: tableName,
					GlobalSecondaryIndexUpdates: [{ Delete: { IndexName: name } }],
				}),
			);
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
				AttributeType: (existingAttrMap.get(cfg.partitionKey) ??
					cfg.partitionKeyType ??
					ScalarAttributeType.S) as ScalarAttributeType,
			});
			if (cfg.sortKey) {
				attrDefs.push({
					AttributeName: cfg.sortKey,
					AttributeType: (existingAttrMap.get(cfg.sortKey) ??
						cfg.sortKeyType ??
						ScalarAttributeType.S) as ScalarAttributeType,
				});
			}

			await dynamodb.send(
				new UpdateTableCommand({
					TableName: tableName,
					AttributeDefinitions: attrDefs,
					GlobalSecondaryIndexUpdates: [
						{
							Create: {
								IndexName: name,
								KeySchema: [
									{ AttributeName: cfg.partitionKey, KeyType: KeyType.HASH },
									...(cfg.sortKey ? [{ AttributeName: cfg.sortKey, KeyType: KeyType.RANGE }] : []),
								],
								Projection: { ProjectionType: 'ALL' },
							},
						},
					],
				}),
			);
			return;
		}
	}

	// 3. Delete extra GSIs (only after all creations are done)
	for (const name of Object.keys(current)) {
		if (!desired[name]) {
			console.log(`Deleting GSI '${name}' (no longer desired)`);
			await dynamodb.send(
				new UpdateTableCommand({
					TableName: tableName,
					GlobalSecondaryIndexUpdates: [{ Delete: { IndexName: name } }],
				}),
			);
			return;
		}
	}
}
