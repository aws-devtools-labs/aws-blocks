// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
/**
 * Unit tests for the GSI manager custom-resource handlers, driven the way the
 * CDK Provider framework drives them: `handler` (onEvent) once, then
 * `isCompleteHandler` with `{ ...request, ...onEventResult }` until it reports
 * `IsComplete: true`. DynamoDB and CloudFormation are faked at the SDK client.
 *
 * History: a Delete always dropped every GSI. That is right when `indexes` is
 * removed from the config (the custom resource is deleted in the update's
 * cleanup phase), but when the table itself leaves the stack (stack delete, or
 * the table removed from the app) it is retained by default in production, so
 * the surviving table lost all its indexes. A Delete also failed outright when
 * the table no longer existed.
 */
import { afterEach, beforeEach, mock, type TestContext, test } from 'node:test';
import { CloudFormationClient, DescribeStacksCommand, GetTemplateCommand } from '@aws-sdk/client-cloudformation';
import { DescribeTableCommand, DynamoDBClient, UpdateTableCommand } from '@aws-sdk/client-dynamodb';
import { _setSleepForTest, handler, isCompleteHandler } from './gsi-manager-lambda.js';
import { GSI_MANAGER_ACTIONS, GSI_MANAGER_SANDBOX_ACTIONS } from './gsi-manager-permissions.js';

const TABLE = 'app-items';
const STACK_ID = 'arn:aws:cloudformation:us-east-1:111111111111:stack/TestStack/00000000-0000-0000-0000-000000000000';
const INDEXES = {
	byStatus: { partitionKey: 'status', partitionKeyType: 'S' as const },
	byOwner: { partitionKey: 'owner', sortKey: 'createdAt', partitionKeyType: 'S' as const, sortKeyType: 'N' as const },
};

interface FakeIndex {
	name: string;
	pk: string;
	sk?: string;
	status: 'ACTIVE' | 'CREATING';
}

let tableExists: boolean;
/** The table vanishes after DescribeTable: UpdateTable alone reports it missing. */
let deletedBeforeUpdate: boolean;
let gsis: FakeIndex[];
/** The stack's status, the DescribeStacks failure, or `null` for a response with no stacks. */
let stackStatus: string | Error | null;
/** Whether the stack's current template still declares the table, or the GetTemplate failure. */
let templateHasTable: boolean | Error;
let updateTableCalls: unknown[];
let cfnCalls: string[];

function describeTableResult() {
	return {
		Table: {
			TableName: TABLE,
			TableStatus: 'ACTIVE',
			KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }],
			AttributeDefinitions: [{ AttributeName: 'id', AttributeType: 'S' }],
			GlobalSecondaryIndexes: gsis.map((g) => ({
				IndexName: g.name,
				IndexStatus: g.status,
				KeySchema: [
					{ AttributeName: g.pk, KeyType: 'HASH' },
					...(g.sk ? [{ AttributeName: g.sk, KeyType: 'RANGE' }] : []),
				],
			})),
		},
	};
}

function templateBody(): string {
	const resources: Record<string, unknown> = {
		OtherTable: { Type: 'AWS::DynamoDB::Table', Properties: { TableName: 'app-other' } },
	};
	if (templateHasTable === true) {
		resources.ItemsTable = { Type: 'AWS::DynamoDB::Table', Properties: { TableName: TABLE } };
	}
	return JSON.stringify({ Resources: resources });
}

function notFound(): Error {
	const e = new Error(`Requested resource not found: Table: ${TABLE} not found`);
	e.name = 'ResourceNotFoundException';
	return e;
}

function accessDenied(action: string): Error {
	const e = new Error(`not authorized to perform: ${action}`);
	e.name = 'AccessDenied';
	return e;
}

beforeEach(() => {
	tableExists = true;
	deletedBeforeUpdate = false;
	gsis = [
		{ name: 'byStatus', pk: 'status', status: 'ACTIVE' },
		{ name: 'byOwner', pk: 'owner', sk: 'createdAt', status: 'ACTIVE' },
	];
	stackStatus = 'UPDATE_COMPLETE_CLEANUP_IN_PROGRESS';
	templateHasTable = true;
	updateTableCalls = [];
	cfnCalls = [];

	mock.method(DynamoDBClient.prototype, 'send', async (command: unknown) => {
		if (command instanceof DescribeTableCommand) {
			if (!tableExists) throw notFound();
			return describeTableResult();
		}
		if (command instanceof UpdateTableCommand) {
			if (!tableExists || deletedBeforeUpdate) throw notFound();
			updateTableCalls.push(command.input);
			// Apply the change instantly: index builds/drops are modelled as done
			// by the next DescribeTable, which is all the handlers can observe.
			for (const u of command.input.GlobalSecondaryIndexUpdates ?? []) {
				if (u.Delete) gsis = gsis.filter((g) => g.name !== u.Delete?.IndexName);
				if (u.Create) {
					const keys = u.Create.KeySchema ?? [];
					gsis.push({
						name: u.Create.IndexName ?? '',
						pk: keys.find((k) => k.KeyType === 'HASH')?.AttributeName ?? '',
						sk: keys.find((k) => k.KeyType === 'RANGE')?.AttributeName,
						status: 'ACTIVE',
					});
				}
			}
			return {};
		}
		throw new Error(`unexpected DynamoDB command ${String(command)}`);
	});

	mock.method(CloudFormationClient.prototype, 'send', async (command: unknown) => {
		if (command instanceof DescribeStacksCommand) {
			assert.strictEqual(command.input.StackName, STACK_ID);
			cfnCalls.push('DescribeStacks');
			if (stackStatus instanceof Error) throw stackStatus;
			if (stackStatus === null) return { Stacks: [] };
			return { Stacks: [{ StackName: 'TestStack', StackId: STACK_ID, StackStatus: stackStatus }] };
		}
		if (command instanceof GetTemplateCommand) {
			assert.strictEqual(command.input.StackName, STACK_ID);
			assert.strictEqual(command.input.TemplateStage, 'Processed', 'the template as deployed, after transforms');
			cfnCalls.push('GetTemplate');
			if (templateHasTable instanceof Error) throw templateHasTable;
			return { TemplateBody: templateBody() };
		}
		throw new Error(`unexpected CloudFormation command ${String(command)}`);
	});
});

afterEach(() => {
	mock.restoreAll();
});

interface TestEvent {
	RequestType: 'Create' | 'Update' | 'Delete';
	StackId?: string;
	RequestId: string;
	LogicalResourceId: string;
	PhysicalResourceId?: string;
	ResourceType: string;
	ResourceProperties: {
		TableName: string;
		Indexes: Record<string, { partitionKey: string; sortKey?: string }>;
		SandboxMode: string;
		Version: string;
		EncryptionKeyArn?: string;
		DeclaredSettings?: { TimeToLiveAttribute: string; PointInTimeRecovery?: string; RecoveryPeriodInDays?: string };
	};
	ResponseURL?: string;
}

function deleteEvent(): TestEvent {
	return {
		RequestType: 'Delete',
		StackId: STACK_ID,
		RequestId: 'req-1',
		LogicalResourceId: 'itemsgsiresource',
		PhysicalResourceId: TABLE,
		ResourceType: 'AWS::CloudFormation::CustomResource',
		ResourceProperties: { TableName: TABLE, Indexes: INDEXES, SandboxMode: 'false', Version: '3' },
	};
}

/**
 * Drive one request through onEvent + isComplete like the Provider framework
 * does: the waiter input is the JSON of `{ ...request, ...onEventResult }`, and
 * an incomplete isComplete result must carry no `Data` (the framework rejects it).
 */
async function runLifecycle(event: TestEvent) {
	const onEventResult = await handler(event);
	const isCompleteEvent = JSON.parse(JSON.stringify({ ...event, ...onEventResult }));
	for (let poll = 0; poll < 10; poll++) {
		const result: { IsComplete: boolean; Data?: unknown } = await isCompleteHandler(isCompleteEvent);
		if (result.IsComplete) return onEventResult;
		assert.strictEqual(result.Data, undefined, 'no Data while incomplete');
	}
	throw new Error('isComplete never reported completion');
}

const ALL_INDEXES = ['byStatus', 'byOwner'];

// --- The table leaves the stack: keep its indexes ---

test('GSI manager: stack delete leaves the indexes of the (retained) table in place', async () => {
	stackStatus = 'DELETE_IN_PROGRESS';
	await runLifecycle(deleteEvent());
	assert.deepStrictEqual(updateTableCalls, [], 'no UpdateTable on stack delete');
	assert.deepStrictEqual(
		gsis.map((g) => g.name),
		ALL_INDEXES,
	);
	assert.deepStrictEqual(cfnCalls, ['DescribeStacks']);
});

test('GSI manager: stack create rollback leaves the indexes in place', async () => {
	stackStatus = 'ROLLBACK_IN_PROGRESS';
	await runLifecycle(deleteEvent());
	assert.deepStrictEqual(updateTableCalls, []);
	assert.deepStrictEqual(
		gsis.map((g) => g.name),
		ALL_INDEXES,
	);
});

test('GSI manager: removing the whole table from the app (update cleanup) keeps its indexes', async () => {
	stackStatus = 'UPDATE_COMPLETE_CLEANUP_IN_PROGRESS';
	templateHasTable = false;
	await runLifecycle(deleteEvent());
	assert.deepStrictEqual(updateTableCalls, []);
	assert.deepStrictEqual(
		gsis.map((g) => g.name),
		ALL_INDEXES,
	);
	assert.deepStrictEqual(cfnCalls, ['DescribeStacks', 'GetTemplate']);
});

test('GSI manager: rolling back a failed update that added the whole table keeps its indexes', async () => {
	stackStatus = 'UPDATE_ROLLBACK_COMPLETE_CLEANUP_IN_PROGRESS';
	templateHasTable = false;
	await runLifecycle(deleteEvent());
	assert.deepStrictEqual(
		gsis.map((g) => g.name),
		ALL_INDEXES,
	);
});

test('GSI manager: stack delete while an index is still building returns without waiting', async () => {
	stackStatus = 'DELETE_IN_PROGRESS';
	gsis[1].status = 'CREATING';
	const event = deleteEvent();
	const onEventResult = await handler(event);
	const result = await isCompleteHandler(JSON.parse(JSON.stringify({ ...event, ...onEventResult })));
	assert.strictEqual(result.IsComplete, true);
	assert.deepStrictEqual(updateTableCalls, []);
});

// --- The table stays in the stack: drop its indexes ---

test('GSI manager: removing `indexes` (update cleanup) drops every index one at a time', async () => {
	stackStatus = 'UPDATE_COMPLETE_CLEANUP_IN_PROGRESS';
	await runLifecycle(deleteEvent());
	assert.deepStrictEqual(gsis, []);
	assert.strictEqual(updateTableCalls.length, 2, 'one UpdateTable per index');
	assert.deepStrictEqual(cfnCalls, ['DescribeStacks', 'GetTemplate'], 'lookups happen once, in onEvent');
});

test('GSI manager: rolling back a failed update that added `indexes` drops them', async () => {
	stackStatus = 'UPDATE_ROLLBACK_COMPLETE_CLEANUP_IN_PROGRESS';
	await runLifecycle(deleteEvent());
	assert.deepStrictEqual(gsis, []);
});

// --- Lookup failures keep the indexes (non-destructive) ---

test('GSI manager: if the stack status cannot be read, Delete keeps the indexes', async () => {
	stackStatus = accessDenied('cloudformation:DescribeStacks');
	await runLifecycle(deleteEvent());
	assert.deepStrictEqual(
		gsis.map((g) => g.name),
		ALL_INDEXES,
	);
	assert.deepStrictEqual(updateTableCalls, []);
});

test('GSI manager: if DescribeStacks returns no stack, Delete keeps the indexes, template unread', async () => {
	stackStatus = null;
	await runLifecycle(deleteEvent());
	assert.deepStrictEqual(updateTableCalls, []);
	assert.deepStrictEqual(
		gsis.map((g) => g.name),
		ALL_INDEXES,
	);
	assert.deepStrictEqual(cfnCalls, ['DescribeStacks']);
});

for (const [status, hint] of [
	['UPDATE_COMPLETE_CLEANUP_IN_PROGRESS', /delete the indexes it no longer configures/],
	['UPDATE_ROLLBACK_COMPLETE_CLEANUP_IN_PROGRESS', /The update was rolled back/],
] as const) {
	test(`GSI manager: unreadable template in ${status}: Delete fails naming the table and its indexes`, async () => {
		// A failed delete in an update's cleanup phase is reported as a
		// DELETE_FAILED event and does not roll the update back, so failing
		// makes the leftover indexes visible instead of reporting success.
		stackStatus = status;
		templateHasTable = accessDenied('cloudformation:GetTemplate');
		await assert.rejects(
			() => handler(deleteEvent()),
			(e: Error) => {
				assert.match(e.message, new RegExp(`table ${TABLE}`));
				assert.match(e.message, /\(byStatus, byOwner\)/);
				assert.match(e.message, hint);
				assert.match(e.message, /not authorized to perform: cloudformation:GetTemplate/);
				return true;
			},
		);
		assert.deepStrictEqual(updateTableCalls, [], 'nothing is dropped');
		assert.deepStrictEqual(
			gsis.map((g) => g.name),
			ALL_INDEXES,
		);
	});
}

test('GSI manager: the failure message lists at most 5 indexes', async () => {
	templateHasTable = accessDenied('cloudformation:GetTemplate');
	const many = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`idx${i}`, { partitionKey: `a${i}` }]));
	const event = deleteEvent();
	await assert.rejects(
		() => handler({ ...event, ResourceProperties: { ...event.ResourceProperties, Indexes: many } }),
		/\(idx0, idx1, idx2, idx3, idx4 and 7 more\)/,
	);
});

test('GSI manager: if the template cannot be parsed in an update cleanup, Delete fails and drops nothing', async () => {
	mock.method(CloudFormationClient.prototype, 'send', async (command: unknown) => {
		if (command instanceof DescribeStacksCommand) {
			return { Stacks: [{ StackId: STACK_ID, StackStatus: 'UPDATE_COMPLETE_CLEANUP_IN_PROGRESS' }] };
		}
		return { TemplateBody: 'Resources: {' };
	});
	await assert.rejects(() => handler(deleteEvent()), new RegExp(`table ${TABLE}`));
	assert.deepStrictEqual(updateTableCalls, []);
});

test('GSI manager: only a DynamoDB table resource with the same name counts as the table staying', async () => {
	templateHasTable = false;
	mock.method(CloudFormationClient.prototype, 'send', async (command: unknown) => {
		if (command instanceof DescribeStacksCommand) {
			return { Stacks: [{ StackId: STACK_ID, StackStatus: 'UPDATE_COMPLETE_CLEANUP_IN_PROGRESS' }] };
		}
		const resources = { Other: { Type: 'AWS::Custom::Thing', Properties: { TableName: TABLE } } };
		return { TemplateBody: JSON.stringify({ Resources: resources }) };
	});
	await runLifecycle(deleteEvent());
	assert.deepStrictEqual(updateTableCalls, [], 'the table is leaving the stack: indexes kept');
});

test('GSI manager: unreadable template in any other stack status: Delete keeps the indexes', async () => {
	stackStatus = 'UPDATE_ROLLBACK_IN_PROGRESS';
	templateHasTable = accessDenied('cloudformation:GetTemplate');
	await runLifecycle(deleteEvent());
	assert.deepStrictEqual(
		gsis.map((g) => g.name),
		ALL_INDEXES,
	);
	assert.deepStrictEqual(updateTableCalls, []);
});

test('GSI manager: a Delete without a StackId keeps the indexes', async () => {
	await runLifecycle({ ...deleteEvent(), StackId: undefined });
	assert.deepStrictEqual(
		gsis.map((g) => g.name),
		ALL_INDEXES,
	);
	assert.deepStrictEqual(cfnCalls, []);
});

// --- Table already gone ---

test('GSI manager: Delete succeeds when the table no longer exists (update cleanup)', async () => {
	tableExists = false;
	const result = await runLifecycle(deleteEvent());
	assert.strictEqual(result.PhysicalResourceId, TABLE);
	assert.deepStrictEqual(updateTableCalls, []);
});

test('GSI manager: Delete succeeds when the table no longer exists (stack delete)', async () => {
	tableExists = false;
	stackStatus = 'DELETE_IN_PROGRESS';
	const result = await runLifecycle(deleteEvent());
	assert.strictEqual(result.PhysicalResourceId, TABLE);
});

test('GSI manager: Delete succeeds when the table disappears between onEvent and isComplete', async () => {
	const event = deleteEvent();
	const onEventResult = await handler(event);
	tableExists = false;
	const result = await isCompleteHandler(JSON.parse(JSON.stringify({ ...event, ...onEventResult })));
	assert.strictEqual(result.IsComplete, true);
});

test('GSI manager: Delete succeeds when the table disappears between DescribeTable and UpdateTable', async () => {
	deletedBeforeUpdate = true;
	const result = await runLifecycle(deleteEvent());
	assert.strictEqual(result.PhysicalResourceId, TABLE);
});

// --- Create and Update are unchanged ---

test('GSI manager: Create still fails when the table disappears between DescribeTable and UpdateTable', async () => {
	gsis = [];
	deletedBeforeUpdate = true;
	const event = { ...deleteEvent(), RequestType: 'Create', PhysicalResourceId: undefined } satisfies TestEvent;
	await assert.rejects(() => handler(event), { name: 'ResourceNotFoundException' });
});

test('GSI manager: Create still fails when the table does not exist', async () => {
	tableExists = false;
	const event = { ...deleteEvent(), RequestType: 'Create', PhysicalResourceId: undefined } satisfies TestEvent;
	await assert.rejects(() => handler(event), { name: 'ResourceNotFoundException' });
	assert.deepStrictEqual(cfnCalls, [], 'the stack is only read on Delete');
});

test('GSI manager: Create and Update never read the stack, and ignore a stray KeepIndexes flag', async () => {
	gsis = [];
	const create = { ...deleteEvent(), RequestType: 'Create', PhysicalResourceId: undefined } satisfies TestEvent;
	await runLifecycle(create);
	assert.deepStrictEqual(gsis.map((g) => g.name).sort(), ['byOwner', 'byStatus']);

	gsis = [];
	const update = { ...deleteEvent(), RequestType: 'Update' } satisfies TestEvent;
	const result = await isCompleteHandler({ ...update, Data: { KeepIndexes: 'true' } });
	assert.strictEqual(result.IsComplete, false, 'Update still builds the missing indexes');
	assert.strictEqual(updateTableCalls.length, 3);
	assert.deepStrictEqual(cfnCalls, []);
});

// --- Sandbox fast path: the recreated table keeps the settings of the old one ---
//
// History: the sandbox fast path deletes the table and creates it again with
// every index. CreateTable got only the keys, the billing mode and the
// indexes, so a store with `indexes` lost its encryption (AWS-managed or
// customer key), its TTL, its tags and point-in-time recovery on every deploy
// that changed its indexes.

const ACCOUNT_KEY_PREFIX = 'arn:aws:kms:us-east-1:111111111111:key';
const AWS_MANAGED_KEY_ARN = `${ACCOUNT_KEY_PREFIX}/aws-dynamodb-managed`;
const CUSTOMER_KEY_ARN = `${ACCOUNT_KEY_PREFIX}/customer-1234`;
const TABLE_ARN = `arn:aws:dynamodb:us-east-1:111111111111:table/${TABLE}`;

/** The observable state of the sandbox table: what DescribeTable and the settings APIs report. */
interface LiveTable {
	gsis: string[];
	/** Undefined: the AWS-owned key. */
	kmsKeyArn?: string;
	stream?: { StreamEnabled: boolean; StreamViewType: string };
	tableClass?: string;
	deletionProtection: boolean;
	tags: { Key: string; Value: string }[];
	ttlAttribute?: string;
	pitr?: { RecoveryPeriodInDays: number };
	items: Record<string, unknown>[];
}

interface SandboxFake {
	/** Undefined while the table is deleted. */
	live: () => LiveTable | undefined;
	calls: string[];
	createInput: () => Record<string, any> | undefined;
	/** Make the next N UpdateContinuousBackups calls fail as right after CreateTable. */
	backupsUnavailable: { remaining: number };
	/** Fail the named command, to check that nothing is deleted. */
	failing: Set<string>;
	/** The next N BatchWriteItem calls write nothing and return every item as unprocessed, as a throttled table does. */
	throttledWrites: { remaining: number };
}

function fakeSandboxTable(initial: LiveTable): SandboxFake {
	let live: LiveTable | undefined = structuredClone(initial);
	let createInput: Record<string, any> | undefined;
	const calls: string[] = [];
	const backupsUnavailable = { remaining: 0 };
	const failing = new Set<string>();
	const throttledWrites = { remaining: 0 };

	mock.method(DynamoDBClient.prototype, 'send', async (command: { constructor: { name: string }; input: any }) => {
		const name = command.constructor.name.replace(/Command$/, '');
		calls.push(name);
		if (failing.has(name)) throw accessDenied(`dynamodb:${name}`);
		const input = command.input;
		if (name === 'CreateTable') {
			assert.strictEqual(live, undefined, 'CreateTable only after the delete');
			createInput = input;
			const sse = input.SSESpecification;
			live = {
				gsis: (input.GlobalSecondaryIndexes ?? []).map((g: { IndexName: string }) => g.IndexName),
				kmsKeyArn: sse?.Enabled ? (sse.KMSMasterKeyId ?? AWS_MANAGED_KEY_ARN) : undefined,
				stream: input.StreamSpecification,
				tableClass: input.TableClass,
				deletionProtection: input.DeletionProtectionEnabled ?? false,
				tags: input.Tags ?? [],
				items: [],
			};
			return {};
		}
		if (!live) throw notFound();
		switch (name) {
			case 'DescribeTable':
				return {
					Table: {
						TableName: TABLE,
						TableArn: TABLE_ARN,
						TableStatus: 'ACTIVE',
						KeySchema: [{ AttributeName: '_bkv_pk', KeyType: 'HASH' }],
						AttributeDefinitions: [{ AttributeName: '_bkv_pk', AttributeType: 'S' }],
						DeletionProtectionEnabled: live.deletionProtection,
						...(live.kmsKeyArn
							? { SSEDescription: { Status: 'ENABLED', SSEType: 'KMS', KMSMasterKeyArn: live.kmsKeyArn } }
							: {}),
						...(live.stream ? { StreamSpecification: live.stream } : {}),
						...(live.tableClass ? { TableClassSummary: { TableClass: live.tableClass } } : {}),
						// Every index name the tests use is one of INDEXES, built with its keys.
						GlobalSecondaryIndexes: live.gsis.map((g) => {
							const keys: { partitionKey: string; sortKey?: string } = INDEXES[g as keyof typeof INDEXES];
							return {
								IndexName: g,
								IndexStatus: 'ACTIVE',
								KeySchema: [
									{ AttributeName: keys.partitionKey, KeyType: 'HASH' },
									...(keys.sortKey ? [{ AttributeName: keys.sortKey, KeyType: 'RANGE' }] : []),
								],
							};
						}),
					},
				};
			case 'ListTagsOfResource':
				assert.strictEqual(input.ResourceArn, TABLE_ARN);
				return { Tags: live.tags };
			case 'DescribeTimeToLive':
				return {
					TimeToLiveDescription: live.ttlAttribute
						? { TimeToLiveStatus: 'ENABLED', AttributeName: live.ttlAttribute }
						: { TimeToLiveStatus: 'DISABLED' },
				};
			case 'UpdateTimeToLive':
				live.ttlAttribute = input.TimeToLiveSpecification.Enabled
					? input.TimeToLiveSpecification.AttributeName
					: undefined;
				return {};
			case 'DescribeContinuousBackups':
				return {
					ContinuousBackupsDescription: {
						ContinuousBackupsStatus: 'ENABLED',
						PointInTimeRecoveryDescription: live.pitr
							? { PointInTimeRecoveryStatus: 'ENABLED', ...live.pitr }
							: { PointInTimeRecoveryStatus: 'DISABLED' },
					},
				};
			case 'UpdateContinuousBackups': {
				if (backupsUnavailable.remaining > 0) {
					backupsUnavailable.remaining--;
					const e = new Error('Backups are being enabled for the table. Please retry later');
					e.name = 'ContinuousBackupsUnavailableException';
					throw e;
				}
				const spec = input.PointInTimeRecoverySpecification;
				live.pitr = spec.PointInTimeRecoveryEnabled
					? { RecoveryPeriodInDays: spec.RecoveryPeriodInDays ?? 35 }
					: undefined;
				return {};
			}
			case 'Scan':
				return { Items: live.items };
			case 'DeleteTable':
				assert.ok(!live.deletionProtection, 'DynamoDB refuses to delete a protected table');
				live = undefined;
				return {};
			case 'BatchWriteItem':
				if (throttledWrites.remaining > 0) {
					throttledWrites.remaining--;
					return { UnprocessedItems: input.RequestItems };
				}
				live.items.push(
					...input.RequestItems[TABLE].map(
						(r: { PutRequest: { Item: Record<string, unknown> } }) => r.PutRequest.Item,
					),
				);
				return {};
			case 'UpdateTable':
				for (const u of input.GlobalSecondaryIndexUpdates ?? []) {
					if (u.Create) live.gsis.push(u.Create.IndexName);
					if (u.Delete) live.gsis = live.gsis.filter((g) => g !== u.Delete.IndexName);
				}
				return {};
		}
		throw new Error(`unexpected DynamoDB command ${name}`);
	});

	return { live: () => live, calls, createInput: () => createInput, backupsUnavailable, failing, throttledWrites };
}

/** A store with `indexes`, as the CDK layer deploys it with the defaults: AWS-managed key, TTL on, stack tags. */
function deployedTable(overrides: Partial<LiveTable> = {}): LiveTable {
	return {
		gsis: ['byStatus'],
		kmsKeyArn: AWS_MANAGED_KEY_ARN,
		deletionProtection: false,
		tags: [
			{ Key: 'team', Value: 'storefront' },
			{ Key: 'aws:cloudformation:stack-name', Value: 'TestStack' },
		],
		ttlAttribute: '_bkv_ttl',
		pitr: { RecoveryPeriodInDays: 35 },
		items: [{ _bkv_pk: { S: 'a' } }, { _bkv_pk: { S: 'b' } }],
		...overrides,
	};
}

function sandboxUpdate(extra: Partial<TestEvent['ResourceProperties']> = {}): TestEvent {
	return {
		...deleteEvent(),
		RequestType: 'Update',
		ResourceProperties: { TableName: TABLE, Indexes: INDEXES, SandboxMode: 'true', Version: '3', ...extra },
	};
}

test('GSI manager (sandbox): the recreated table keeps its encryption, TTL, tags and point-in-time recovery', async () => {
	const fake = fakeSandboxTable(deployedTable());
	await runLifecycle(sandboxUpdate());

	assert.ok(fake.calls.includes('DeleteTable'), 'the fast path recreated the table');
	const live = fake.live();
	assert.ok(live);
	assert.deepStrictEqual(live.gsis.sort(), ['byOwner', 'byStatus']);
	assert.strictEqual(live.kmsKeyArn, AWS_MANAGED_KEY_ARN, 'SSE with the AWS-managed key, not the AWS-owned key');
	assert.deepStrictEqual(
		fake.createInput()?.SSESpecification,
		{ Enabled: true, SSEType: 'KMS' },
		'the AWS-managed key is chosen by leaving KMSMasterKeyId out',
	);
	assert.strictEqual(live.ttlAttribute, '_bkv_ttl', 'TTL stays on');
	assert.deepStrictEqual(live.pitr, { RecoveryPeriodInDays: 35 }, 'point-in-time recovery stays on');
	assert.deepStrictEqual(
		live.tags,
		[{ Key: 'team', Value: 'storefront' }],
		'user tags kept; aws: tags cannot be set',
	);
	assert.strictEqual(live.items.length, 2, 'items restored');
	assert.ok(
		fake.calls.indexOf('UpdateTimeToLive') < fake.calls.indexOf('BatchWriteItem'),
		'TTL is on again before the items are written back',
	);
	// A call without its action would fail after the delete, with the items not yet restored.
	const granted: readonly string[] = [...GSI_MANAGER_ACTIONS, ...GSI_MANAGER_SANDBOX_ACTIONS];
	assert.deepStrictEqual(
		fake.calls.filter((c) => !granted.includes(`dynamodb:${c}`)),
		[],
		'the CDK layer grants every call the fast path makes',
	);
});

test('GSI manager (sandbox): a table with a customer key is recreated with the same key', async () => {
	const fake = fakeSandboxTable(deployedTable({ kmsKeyArn: CUSTOMER_KEY_ARN }));
	await runLifecycle(sandboxUpdate({ EncryptionKeyArn: CUSTOMER_KEY_ARN }));
	assert.deepStrictEqual(fake.createInput()?.SSESpecification, {
		Enabled: true,
		SSEType: 'KMS',
		KMSMasterKeyId: CUSTOMER_KEY_ARN,
	});
	assert.strictEqual(fake.live()?.kmsKeyArn, CUSTOMER_KEY_ARN);
});

test('GSI manager (sandbox): streams, table class and a custom TTL field are kept; settings that were off stay off', async () => {
	const fake = fakeSandboxTable(
		deployedTable({
			kmsKeyArn: undefined,
			stream: { StreamEnabled: true, StreamViewType: 'NEW_AND_OLD_IMAGES' },
			tableClass: 'STANDARD_INFREQUENT_ACCESS',
			tags: [],
			ttlAttribute: 'expiresAt',
			pitr: undefined,
		}),
	);
	await runLifecycle(sandboxUpdate());
	const input = fake.createInput();
	assert.ok(input);
	assert.strictEqual(input.SSESpecification, undefined, 'an AWS-owned key table stays on the AWS-owned key');
	assert.strictEqual(input.Tags, undefined);
	assert.deepStrictEqual(input.StreamSpecification, { StreamEnabled: true, StreamViewType: 'NEW_AND_OLD_IMAGES' });
	assert.strictEqual(input.TableClass, 'STANDARD_INFREQUENT_ACCESS');
	assert.strictEqual(fake.live()?.ttlAttribute, 'expiresAt');
	assert.strictEqual(fake.live()?.pitr, undefined);
	assert.ok(!fake.calls.includes('UpdateContinuousBackups'), 'point-in-time recovery is not turned on');
});

// No real wait between retries, and no timer at all: a stubbed setTimeout or
// a wait of 0 ms breaks the messages that the test runner's child process
// sends to its parent.
function withoutWaits(t: TestContext) {
	const sleep = _setSleepForTest(async () => {});
	t.after(() => _setSleepForTest(sleep));
}

test('GSI manager (sandbox): point-in-time recovery is retried while the new table cannot take backups yet', async (t) => {
	const fake = fakeSandboxTable(deployedTable({ pitr: { RecoveryPeriodInDays: 7 } }));
	withoutWaits(t);
	fake.backupsUnavailable.remaining = 1;
	await runLifecycle(sandboxUpdate());
	assert.strictEqual(fake.calls.filter((c) => c === 'UpdateContinuousBackups').length, 2);
	assert.deepStrictEqual(fake.live()?.pitr, { RecoveryPeriodInDays: 7 }, 'the pinned recovery window is kept');
});

for (const failing of ['ListTagsOfResource', 'DescribeTimeToLive', 'DescribeContinuousBackups']) {
	test(`GSI manager (sandbox): if ${failing} fails, the table is not deleted`, async () => {
		const fake = fakeSandboxTable(deployedTable());
		fake.failing.add(failing);
		await assert.rejects(() => handler(sandboxUpdate()), { name: 'AccessDenied' });
		assert.ok(!fake.calls.includes('DeleteTable'));
		assert.ok(!fake.calls.includes('Scan'), 'settings are read before the data');
		assert.deepStrictEqual(fake.live()?.items.length, 2);
	});
}

test('GSI manager (sandbox): a table with deletion protection is not recreated; its indexes change in place', async () => {
	const fake = fakeSandboxTable(deployedTable({ deletionProtection: true }));
	await runLifecycle(sandboxUpdate());
	assert.ok(!fake.calls.includes('DeleteTable'));
	assert.ok(!fake.calls.includes('CreateTable'));
	assert.deepStrictEqual(fake.live()?.gsis.sort(), ['byOwner', 'byStatus']);
	assert.strictEqual(fake.live()?.deletionProtection, true);
});

// History: the settings were set again before the items were written back, and
// a failure there threw with the items only in the function's memory. The
// items go back first now, and the failure is reported after.
for (const failing of ['UpdateTimeToLive', 'UpdateContinuousBackups']) {
	test(`GSI manager (sandbox): if ${failing} fails on the new table, the items are still written back`, async () => {
		const fake = fakeSandboxTable(deployedTable());
		fake.failing.add(failing);
		await assert.rejects(() => handler(sandboxUpdate()), { name: 'AccessDenied' });
		assert.ok(fake.calls.includes('DeleteTable'), 'the fast path ran');
		assert.strictEqual(fake.live()?.items.length, 2, 'the items are back before the failure is reported');
	});
}

// History: the restore sent each batch once and ignored UnprocessedItems. A
// sandbox run with 1,600 items of about 12 KB lost 418 of them on the new
// on-demand table, and the handler logged that all were restored.
test('GSI manager (sandbox): items that DynamoDB leaves unprocessed are sent again until all are written', async (t) => {
	const fake = fakeSandboxTable(deployedTable());
	withoutWaits(t);
	fake.throttledWrites.remaining = 3;
	await runLifecycle(sandboxUpdate());
	assert.strictEqual(fake.live()?.items.length, 2);
	assert.strictEqual(fake.calls.filter((c) => c === 'BatchWriteItem').length, 4, 'three throttled calls, then one');
});

test('GSI manager (sandbox): the handler fails when items stay unprocessed, and says how many', async (t) => {
	const fake = fakeSandboxTable(deployedTable());
	withoutWaits(t);
	fake.throttledWrites.remaining = Number.POSITIVE_INFINITY;
	await assert.rejects(() => handler(sandboxUpdate()), /2 of 2 items of app-items were not written back/);
});

// --- Sandbox: a table that lacks what its stack declares is recreated with it ---
//
// History: 1.0.0-rc.0 recreated a sandbox table with `indexes` without its
// encryption, TTL and point-in-time recovery. The fast path copies the live
// table's settings, so on its own it would carry that state forward. The CDK
// layer now passes what it declares, in sandbox, and the handler gives a
// table what it lacks, also when its indexes did not change.

const DECLARED = { TimeToLiveAttribute: '_bkv_ttl', PointInTimeRecovery: 'true', RecoveryPeriodInDays: '7' };
const STRIPPED = { gsis: ALL_INDEXES, kmsKeyArn: undefined, ttlAttribute: undefined, pitr: undefined };

test('GSI manager (sandbox): a table without the declared encryption, TTL and point-in-time recovery gets them, with its indexes unchanged', async () => {
	const fake = fakeSandboxTable(deployedTable(STRIPPED));
	await runLifecycle(sandboxUpdate({ DeclaredSettings: DECLARED }));
	assert.ok(fake.calls.includes('DeleteTable'), 'recreated although the indexes match');
	const live = fake.live();
	assert.ok(live);
	assert.strictEqual(live.kmsKeyArn, AWS_MANAGED_KEY_ARN);
	assert.strictEqual(live.ttlAttribute, '_bkv_ttl');
	assert.deepStrictEqual(live.pitr, { RecoveryPeriodInDays: 7 });
	assert.deepStrictEqual(live.gsis.sort(), ['byOwner', 'byStatus']);
	assert.strictEqual(live.items.length, 2);
});

test('GSI manager (sandbox): a table without encryption gets the declared customer key; point-in-time recovery stays off when not declared', async () => {
	const fake = fakeSandboxTable(deployedTable(STRIPPED));
	await runLifecycle(
		sandboxUpdate({ DeclaredSettings: { TimeToLiveAttribute: 'expiresAt' }, EncryptionKeyArn: CUSTOMER_KEY_ARN }),
	);
	assert.strictEqual(fake.live()?.kmsKeyArn, CUSTOMER_KEY_ARN);
	assert.strictEqual(fake.live()?.ttlAttribute, 'expiresAt');
	assert.strictEqual(fake.live()?.pitr, undefined);
});

test('GSI manager (sandbox): an index change also gives the table what it lacks', async () => {
	const fake = fakeSandboxTable(deployedTable({ ...STRIPPED, gsis: ['byStatus'] }));
	await runLifecycle(sandboxUpdate({ DeclaredSettings: DECLARED }));
	assert.strictEqual(fake.live()?.kmsKeyArn, AWS_MANAGED_KEY_ARN);
	assert.strictEqual(fake.live()?.ttlAttribute, '_bkv_ttl');
	assert.deepStrictEqual(fake.live()?.pitr, { RecoveryPeriodInDays: 7 });
});

test('GSI manager (sandbox): a table that has what its stack declares is not recreated', async () => {
	const fake = fakeSandboxTable(deployedTable({ gsis: ALL_INDEXES }));
	await runLifecycle(sandboxUpdate({ DeclaredSettings: { ...DECLARED, RecoveryPeriodInDays: undefined } }));
	assert.ok(!fake.calls.includes('DeleteTable'));
	assert.ok(!fake.calls.includes('Scan'));
});

test('GSI manager (sandbox): a table whose settings cannot be read is left as it is', async () => {
	const fake = fakeSandboxTable(deployedTable(STRIPPED));
	fake.failing.add('DescribeTimeToLive');
	await runLifecycle(sandboxUpdate({ DeclaredSettings: DECLARED }));
	assert.ok(!fake.calls.includes('DeleteTable'));
});

test('GSI manager (sandbox): a table with deletion protection is not recreated to get its settings back', async () => {
	const fake = fakeSandboxTable(deployedTable({ ...STRIPPED, deletionProtection: true }));
	await runLifecycle(sandboxUpdate({ DeclaredSettings: DECLARED }));
	assert.ok(!fake.calls.includes('DeleteTable'));
});

// CloudFormation's presigned response URL lets its holder answer for the
// custom resource, so it must not reach the log group.
test("GSI manager: the logged events leave out CloudFormation's response URL", async (t) => {
	const logged: string[] = [];
	t.mock.method(console, 'log', (...args: unknown[]) => logged.push(args.join(' ')));
	const event: TestEvent = {
		...deleteEvent(),
		RequestType: 'Update',
		ResponseURL: 'https://cloudformation-custom-resource-response.example/req-1?X-Amz-Signature=abc123',
	};
	await runLifecycle(event);
	const text = logged.join('\n');
	assert.match(text, /onEvent: [\s\S]*"RequestType": "Update"/, 'the rest of the event is logged');
	assert.match(text, /isComplete: /);
	assert.doesNotMatch(text, /X-Amz-Signature|abc123/);
});
