// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

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
import { afterEach, beforeEach, mock, test } from 'node:test';
import assert from 'node:assert';
import { CloudFormationClient, DescribeStacksCommand, GetTemplateCommand } from '@aws-sdk/client-cloudformation';
import { DescribeTableCommand, DynamoDBClient, UpdateTableCommand } from '@aws-sdk/client-dynamodb';
import { handler, isCompleteHandler } from './gsi-manager-lambda.js';

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
let stackStatus: string | Error;
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
	ResourceProperties: { TableName: string; Indexes: typeof INDEXES; SandboxMode: string; Version: string };
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

test('GSI manager: if the template cannot be read, Delete keeps the indexes', async () => {
	templateHasTable = accessDenied('cloudformation:GetTemplate');
	await runLifecycle(deleteEvent());
	assert.deepStrictEqual(
		gsis.map((g) => g.name),
		ALL_INDEXES,
	);
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
