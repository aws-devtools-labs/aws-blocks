// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for the handlers of the `migrateFrom` job, driven the way the CDK
 * Provider framework drives them: `handler` (onEvent) once, then
 * `isCompleteHandler` with `{ ...request, ...onEventResult }` until it reports
 * `IsComplete: true`. DynamoDB, its stream, CloudFormation and Systems Manager
 * are faked at the SDK clients.
 *
 * The fakes hold two tables and one stream. `oldPut` and `oldDelete` change
 * the old table and add the stream record that DynamoDB adds. The new table
 * checks the two condition expressions that the replay sends.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, mock, test } from 'node:test';
import { CloudFormationClient, ListStackResourcesCommand } from '@aws-sdk/client-cloudformation';
import {
	type AttributeValue,
	BatchWriteItemCommand,
	DeleteItemCommand,
	DynamoDBClient,
	GetItemCommand,
	PutItemCommand,
	ScanCommand,
} from '@aws-sdk/client-dynamodb';
import {
	DescribeStreamCommand,
	DynamoDBStreamsClient,
	GetRecordsCommand,
	GetShardIteratorCommand,
} from '@aws-sdk/client-dynamodb-streams';
import { DeleteParameterCommand, GetParameterCommand, PutParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { resolveKeyModel } from './item.js';
import {
	convertItem,
	handler,
	isCompleteHandler,
	limits,
	type MigrateEvent,
	type MigrateProperties,
} from './migrate-lambda.js';
import { MIGRATE_COPY_RESOURCE_TYPE, MIGRATE_DRAIN_RESOURCE_TYPE } from './migrate-names.js';
import { MIGRATED_MARKER } from './ttl.js';

type Item = Record<string, AttributeValue>;

const OLD = 'app-cache';
const NEW = 'app-cache-v2';
const STACK_ID = 'arn:aws:cloudformation:us-east-1:111111111111:stack/TestStack/00000000-0000-0000-0000-000000000000';
const APP_FUNCTION = 'DefaultComputeHandlerF1C2C112';

interface FakeShard {
	id: string;
	parent?: string;
	closed: boolean;
	records: { eventName: string; dynamodb: { Keys: Item; NewImage?: Item; SequenceNumber: string } }[];
}

let oldTable: Map<string, Item>;
let newTable: Map<string, Item>;
let shards: FakeShard[];
let sequence: number;
/** Items of one Scan page. */
let pageSize: number;
/** `BatchWriteItem` leaves the second half of a batch unprocessed this many times. */
let unprocessedTimes: number;
let parameters: Map<string, string>;
/** What CloudFormation reports for the app's function. */
let appFunction: { status: string; at: number };
let copyStatuses: string[];
/** What CloudFormation reports for a resource of the stack that is not part of the migration. */
let otherStatus: string;
/** Runs once, when the copy asks for the shards of the stream: every Scan segment is read by then. */
let afterScan: (() => void) | undefined;
/** The calls to DynamoDB Streams, by kind. */
let streamCalls: { describe: number; iterator: number; records: number };
/** The next read of the stream finds that its iterator expired. */
let expireIterator: boolean;
let saved: typeof limits;

const releaseItem = (pk: string, value: unknown, ttl?: number): Item => ({
	pk: { S: pk },
	value: { S: JSON.stringify(value) },
	...(ttl === undefined ? {} : { ttl: { N: String(ttl) } }),
});

/** A write of the old code: the old table changes, and the stream gets the record. */
function oldPut(pk: string, value: unknown, shard = 's1'): void {
	const item = releaseItem(pk, value);
	oldTable.set(pk, item);
	shardOf(shard).records.push({
		eventName: 'MODIFY',
		dynamodb: { Keys: { pk: { S: pk } }, NewImage: item, SequenceNumber: String(++sequence) },
	});
}

function oldDelete(pk: string, shard = 's1'): void {
	oldTable.delete(pk);
	shardOf(shard).records.push({
		eventName: 'REMOVE',
		dynamodb: { Keys: { pk: { S: pk } }, SequenceNumber: String(++sequence) },
	});
}

/** A `put` of the new code: the whole item, with no marker. */
function newPut(pk: string, value: string): void {
	newTable.set(pk, { _bkv_pk: { S: pk }, _bkv_value: { S: value } });
}

function shardOf(id: string): FakeShard {
	const shard = shards.find((s) => s.id === id);
	assert.ok(shard, `no shard ${id}`);
	return shard;
}

/** The new table as `key → value`, with a `*` for an item that has the marker. */
function newItems(): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, item] of [...newTable].sort(([a], [b]) => (a < b ? -1 : 1))) {
		if (key.startsWith('_bkv_migration')) continue;
		const { _bkv_pk: _key, [MIGRATED_MARKER]: marker, ...rest } = item;
		const value = '_bkv_value' in rest ? (rest._bkv_value.S ?? rest._bkv_value.N ?? 'null') : JSON.stringify(rest);
		out[key] = `${value}${marker ? '*' : ''}`;
	}
	return out;
}

const conditionFailed = () =>
	Object.assign(new Error('The conditional request failed'), { name: 'ConditionalCheckFailedException' });
const segmentOf = (pk: string, total: number) => [...pk].reduce((sum, c) => sum + c.charCodeAt(0), 0) % total;

function fakeDynamoDb(command: unknown): unknown {
	if (command instanceof ScanCommand) {
		const { Segment = 0, TotalSegments = 1, ExclusiveStartKey, TableName, ConsistentRead } = command.input;
		assert.equal(TableName, OLD);
		assert.equal(ConsistentRead, true, 'a write that ended before the stream began must be in the Scan');
		const after = ExclusiveStartKey?.pk?.S;
		const rest = [...oldTable.keys()]
			.filter((pk) => segmentOf(pk, TotalSegments) === Segment)
			.sort()
			.filter((pk) => after === undefined || pk > after);
		const page = rest.slice(0, pageSize);
		return {
			Items: page.map((pk) => oldTable.get(pk)),
			LastEvaluatedKey: rest.length > page.length ? { pk: { S: page[page.length - 1] } } : undefined,
			ConsumedCapacity: { CapacityUnits: page.length },
		};
	}
	if (command instanceof BatchWriteItemCommand) {
		const requests = command.input.RequestItems?.[NEW] ?? [];
		assert.ok(requests.length <= 25, 'a batch has 25 items at most');
		const keep = unprocessedTimes > 0 && requests.length > 1 ? Math.ceil(requests.length / 2) : requests.length;
		if (keep < requests.length) unprocessedTimes--;
		for (const request of requests.slice(0, keep)) {
			const item = request.PutRequest?.Item as Item;
			newTable.set(item._bkv_pk.S as string, item);
		}
		return {
			UnprocessedItems: keep < requests.length ? { [NEW]: requests.slice(keep) } : {},
			ConsumedCapacity: [{ CapacityUnits: keep }],
		};
	}
	if (command instanceof GetItemCommand) return { Item: newTable.get(command.input.Key?._bkv_pk?.S as string) };
	if (command instanceof PutItemCommand) {
		const item = command.input.Item as Item;
		const key = item._bkv_pk.S as string;
		const existing = newTable.get(key);
		if (command.input.ConditionExpression !== undefined) {
			assert.equal(command.input.ConditionExpression, 'attribute_not_exists(#pk) OR attribute_exists(#m)');
			assert.deepEqual(command.input.ExpressionAttributeNames, { '#pk': '_bkv_pk', '#m': MIGRATED_MARKER });
			if (existing && !(MIGRATED_MARKER in existing)) throw conditionFailed();
		}
		newTable.set(key, item);
		return {};
	}
	if (command instanceof DeleteItemCommand) {
		const key = command.input.Key?._bkv_pk?.S as string;
		const existing = newTable.get(key);
		if (command.input.ConditionExpression !== undefined) {
			assert.equal(command.input.ConditionExpression, 'attribute_exists(#m)');
			if (!existing || !(MIGRATED_MARKER in existing)) throw conditionFailed();
		}
		newTable.delete(key);
		return {};
	}
	throw new Error(`unexpected DynamoDB command ${String(command)}`);
}

function fakeStreams(command: unknown): unknown {
	if (command instanceof DescribeStreamCommand) {
		streamCalls.describe++;
		const hook = afterScan;
		afterScan = undefined;
		hook?.();
		return { StreamDescription: { Shards: shards.map((s) => ({ ShardId: s.id, ParentShardId: s.parent })) } };
	}
	if (command instanceof GetShardIteratorCommand) {
		streamCalls.iterator++;
		const shard = shardOf(command.input.ShardId as string);
		const after = command.input.SequenceNumber;
		const index = after === undefined ? 0 : shard.records.findIndex((r) => r.dynamodb.SequenceNumber === after) + 1;
		if (after === undefined) assert.equal(command.input.ShardIteratorType, 'TRIM_HORIZON');
		return { ShardIterator: JSON.stringify({ shard: shard.id, index }) };
	}
	if (command instanceof GetRecordsCommand) {
		streamCalls.records++;
		if (expireIterator) {
			expireIterator = false;
			throw Object.assign(new Error('Iterator expired'), { name: 'ExpiredIteratorException' });
		}
		const { shard: id, index } = JSON.parse(command.input.ShardIterator as string) as {
			shard: string;
			index: number;
		};
		const shard = shardOf(id);
		const records = shard.records.slice(index, index + (command.input.Limit ?? 1000));
		const next = index + records.length;
		return {
			Records: records,
			NextShardIterator:
				shard.closed && next >= shard.records.length ? undefined : JSON.stringify({ shard: id, index: next }),
		};
	}
	throw new Error(`unexpected DynamoDB Streams command ${String(command)}`);
}

function fakeCloudFormation(command: unknown): unknown {
	if (command instanceof ListStackResourcesCommand) {
		assert.equal(command.input.StackName, STACK_ID);
		return {
			StackResourceSummaries: [
				{
					LogicalResourceId: 'Table',
					ResourceType: 'AWS::DynamoDB::Table',
					ResourceStatus: otherStatus,
				},
				{
					LogicalResourceId: APP_FUNCTION,
					ResourceType: 'AWS::Lambda::Function',
					ResourceStatus: appFunction.status,
					LastUpdatedTimestamp: new Date(appFunction.at),
				},
				// The drain itself is in progress for as long as it asks.
				{
					LogicalResourceId: 'Drain',
					ResourceType: MIGRATE_DRAIN_RESOURCE_TYPE,
					ResourceStatus: 'CREATE_IN_PROGRESS',
				},
				...copyStatuses.map((ResourceStatus, i) => ({
					LogicalResourceId: `Copy${i}`,
					ResourceType: MIGRATE_COPY_RESOURCE_TYPE,
					ResourceStatus,
				})),
			],
		};
	}
	throw new Error(`unexpected CloudFormation command ${String(command)}`);
}

function fakeSsm(command: unknown): unknown {
	if (command instanceof GetParameterCommand) {
		const value = parameters.get(command.input.Name as string);
		if (value === undefined) throw Object.assign(new Error('not found'), { name: 'ParameterNotFound' });
		return { Parameter: { Value: value } };
	}
	if (command instanceof PutParameterCommand) {
		assert.match(
			command.input.Name as string,
			/^\/blocks\/kv-migrate\//,
			'names that begin with aws or ssm are reserved',
		);
		parameters.set(command.input.Name as string, command.input.Value as string);
		return {};
	}
	if (command instanceof DeleteParameterCommand) {
		if (!parameters.delete(command.input.Name as string))
			throw Object.assign(new Error('not found'), { name: 'ParameterNotFound' });
		return {};
	}
	throw new Error(`unexpected Systems Manager command ${String(command)}`);
}

beforeEach(() => {
	oldTable = new Map();
	newTable = new Map();
	shards = [{ id: 's1', closed: false, records: [] }];
	sequence = 0;
	pageSize = 100;
	unprocessedTimes = 0;
	parameters = new Map();
	appFunction = { status: 'UPDATE_COMPLETE', at: 0 };
	copyStatuses = ['CREATE_COMPLETE'];
	otherStatus = 'UPDATE_COMPLETE';
	afterScan = undefined;
	streamCalls = { describe: 0, iterator: 0, records: 0 };
	expireIterator = false;
	saved = { ...limits };
	limits.idleMs = 0;
	limits.switchCheckMs = 0;
	mock.method(DynamoDBClient.prototype, 'send', async (command: unknown) => fakeDynamoDb(command));
	mock.method(DynamoDBStreamsClient.prototype, 'send', async (command: unknown) => fakeStreams(command));
	mock.method(CloudFormationClient.prototype, 'send', async (command: unknown) => fakeCloudFormation(command));
	mock.method(SSMClient.prototype, 'send', async (command: unknown) => fakeSsm(command));
	mock.method(console, 'log', () => {});
});

afterEach(() => {
	Object.assign(limits, saved);
	mock.restoreAll();
});

function request(phase: 'copy' | 'drain', extra: Partial<MigrateProperties> = {}): MigrateEvent {
	return {
		RequestType: 'Create',
		RequestId: `request-${phase}`,
		StackId: STACK_ID,
		ResourceProperties: {
			Phase: phase,
			OldTable: OLD,
			NewTable: NEW,
			StreamArn: 'arn:aws:dynamodb:us-east-1:111111111111:table/app-cache/stream/1',
			KeyOptions: '{}',
			...extra,
		},
	};
}

/** Start a resource as the framework does. Returns the event that every `isComplete` call gets. */
async function begin(event: MigrateEvent): Promise<MigrateEvent> {
	const started = await handler(event);
	return { ...event, ...started };
}

/** Call `isComplete` until it is done, as the framework does. Returns its data and the number of calls. */
async function complete(event: MigrateEvent, between?: (call: number) => void) {
	for (let calls = 1; calls <= 50; calls++) {
		const result = await isCompleteHandler(event);
		if (result.IsComplete) return { data: (result as { Data?: Record<string, string> }).Data, calls };
		between?.(calls);
	}
	assert.fail('isComplete did not finish in 50 calls');
}

const drainOf = (copyData: Record<string, string> | undefined, extra: Partial<MigrateProperties> = {}) =>
	request('drain', {
		Checkpoints: copyData?.Checkpoints,
		DrainSeconds: '0',
		FunctionLogicalIds: [APP_FUNCTION],
		...extra,
	});

// ── Conversion ──────────────────────────────────────────────────────────────

describe('convertItem', () => {
	const model = resolveKeyModel(undefined);

	test('an object becomes one attribute for each field; any other value goes in _bkv_value; the expiry moves to _bkv_ttl', () => {
		assert.deepEqual(convertItem(model, releaseItem('u1', { name: 'Ada', tags: ['a'] }, 1_800_000_000)), {
			_bkv_pk: { S: 'u1' },
			name: { S: 'Ada' },
			tags: { L: [{ S: 'a' }] },
			_bkv_ttl: { N: '1800000000' },
			[MIGRATED_MARKER]: { N: '1' },
		});
		assert.deepEqual(convertItem(model, releaseItem('s', 'hello')), {
			_bkv_pk: { S: 's' },
			_bkv_value: { S: 'hello' },
			[MIGRATED_MARKER]: { N: '1' },
		});
		assert.deepEqual(convertItem(model, releaseItem('n', null))._bkv_value, { NULL: true });
		assert.deepEqual(convertItem(model, releaseItem('l', [1, 'two']))._bkv_value, {
			L: [{ N: '1' }, { S: 'two' }],
		});
	});

	test('the expiry goes to the field that the `ttl` option of the new store names', () => {
		const withTtlField = resolveKeyModel({ ttl: 'expiresAt' });
		assert.deepEqual(convertItem(withTtlField, releaseItem('s1', { userId: 'ada' }, 1_800_000_000)), {
			_bkv_pk: { S: 's1' },
			userId: { S: 'ada' },
			expiresAt: { N: '1800000000' },
			[MIGRATED_MARKER]: { N: '1' },
		});
	});

	test('refuses what a write of this release refuses, and what is not an item of a release', () => {
		assert.throws(() => convertItem(model, releaseItem('a', { _bkv_pk: 'other' })), /reserved prefix/);
		assert.throws(
			() => convertItem(model, { pk: { S: 'a' }, name: { S: 'A' } }),
			/not an item of a KVStore release/,
		);
		const indexed = resolveKeyModel({ indexes: { byEmail: { partitionKey: 'email' } } });
		assert.throws(() => convertItem(indexed, releaseItem('a', { email: '' })), /email/);
	});
});

// ── The copy phase ──────────────────────────────────────────────────────────

describe('copy', () => {
	test('copies every item, over segments, pages and batches, and removes its state item', async () => {
		for (let i = 0; i < 130; i++) oldTable.set(`k${i}`, releaseItem(`k${i}`, i));
		pageSize = 40;
		unprocessedTimes = 3;
		const { data, calls } = await complete(await begin(request('copy')));
		assert.equal(calls, 1);
		assert.equal(Object.keys(newItems()).length, 130);
		assert.equal(newItems().k7, '7*');
		assert.deepEqual(
			[...newTable.keys()].filter((key) => key.startsWith('_bkv_migration')),
			[],
		);
		const stats = JSON.parse(data?.Stats ?? '{}') as { items: number; readUnits: number; writeUnits: number };
		assert.deepEqual(
			{ items: stats.items, readUnits: stats.readUnits, writeUnits: stats.writeUnits },
			{ items: 130, readUnits: 130, writeUnits: 130 },
		);
		assert.deepEqual(JSON.parse(data?.Checkpoints ?? ''), { seq: {}, done: [] });
	});

	test('a slice that ends early hands over: each invocation moves every segment on by one page at least', async () => {
		for (let i = 0; i < 60; i++) oldTable.set(`k${i}`, releaseItem(`k${i}`, i));
		pageSize = 2;
		limits.copySliceMs = 0;
		const { data, calls } = await complete(await begin(request('copy')));
		assert.ok(calls > 1, `one call is not a hand-over (${calls})`);
		assert.equal(Object.keys(newItems()).length, 60);
		const stats = JSON.parse(data?.Stats ?? '{}') as { items: number; invocations: number };
		assert.equal(stats.items, 60, 'no item is copied twice');
		assert.equal(stats.invocations, calls);
	});

	test('an item that the new layout refuses fails the copy and names the item', async () => {
		oldTable.set('good', releaseItem('good', { a: 1 }));
		oldTable.set('bad', releaseItem('bad', { _bkv_pk: 'other' }));
		const event = await begin(request('copy'));
		await assert.rejects(isCompleteHandler(event), (error: Error) => {
			assert.match(error.message, /1 items of app-cache cannot be stored in the new layout/);
			assert.match(error.message, /bad: .*reserved prefix/);
			return true;
		});
	});

	test('a replayed change that the new layout refuses fails the copy and names the item', async () => {
		oldTable.set('good', releaseItem('good', 'a'));
		afterScan = () => oldPut('bad', { _bkv_pk: 'other' });
		await assert.rejects(
			isCompleteHandler(await begin(request('copy'))),
			/the item bad of app-cache cannot be stored in the new layout.*reserved prefix/s,
		);
	});

	test('replays the changes that the old code made during the copy, in order', async () => {
		oldTable.set('stays', releaseItem('stays', 'a'));
		oldTable.set('changes', releaseItem('changes', 'a'));
		oldTable.set('goes', releaseItem('goes', 'a'));
		// The old code writes after the Scan read the items: only the stream has these changes.
		afterScan = () => {
			oldPut('changes', 'b');
			oldPut('changes', 'c');
			oldDelete('goes');
			oldPut('arrives', 'a');
		};
		const { data } = await complete(await begin(request('copy')));
		assert.deepEqual(newItems(), { arrives: 'a*', changes: 'c*', stays: 'a*' });
		const stats = JSON.parse(data?.Stats ?? '{}') as { streamRecords: number; streamApplied: number };
		assert.equal(stats.streamRecords, 4);
		assert.equal(stats.streamApplied, 3, 'only the last record of a key in a page is applied');
		assert.equal((JSON.parse(data?.Checkpoints ?? '{}') as { seq: Record<string, string> }).seq.s1, '4');
	});

	test('a replay that the slice cuts short is not at the tip: the next invocation reads on', async () => {
		oldTable.set('k', releaseItem('k', 0));
		limits.copySliceMs = 0;
		afterScan = () => {
			for (let i = 1; i <= 10; i++) oldPut('k', i);
		};
		const { calls } = await complete(await begin(request('copy')));
		assert.equal(calls, 2, 'the first pass read 10 records, and did not see the tip of the shard');
		assert.deepEqual(newItems(), { k: '10*' });
	});

	test('reads a child shard after its parent, so the order of a key holds across a split', async () => {
		shards = [
			{ id: 'child', parent: 'parent', closed: false, records: [] },
			{ id: 'parent', closed: true, records: [] },
		];
		oldPut('k', 'first', 'parent');
		oldPut('k', 'second', 'child');
		const { data } = await complete(await begin(request('copy')));
		assert.deepEqual(newItems(), { k: 'second*' });
		assert.deepEqual((JSON.parse(data?.Checkpoints ?? '{}') as { done: string[] }).done, ['parent']);
	});
});

// ── The drain phase ─────────────────────────────────────────────────────────

describe('drain', () => {
	test('follows the stream until the functions are updated, keeps its position between invocations, then ends', async () => {
		oldTable.set('k', releaseItem('k', 'a'));
		const copy = await complete(await begin(request('copy')));
		limits.drainSliceMs = 0;
		appFunction = { status: 'UPDATE_IN_PROGRESS', at: 0 };
		const event = await begin(drainOf(copy.data));
		const { data, calls } = await complete(event, (call) => {
			// Between two invocations the old code writes, and then the function update ends.
			if (call === 1) oldPut('k', 'b');
			if (call === 2) {
				assert.equal(newItems().k, 'b*', 'the second invocation went on from the position of the first');
				assert.equal(parameters.size, 1);
				oldPut('late', 'c');
				appFunction = { status: 'UPDATE_COMPLETE', at: Date.now() };
			}
		});
		assert.ok(calls >= 3, `expected a hand-over (${calls} calls)`);
		assert.deepEqual(newItems(), { k: 'b*', late: 'c*' });
		assert.equal(parameters.size, 0, 'the position is removed when the drain ends');
		assert.equal((JSON.parse(data?.Stats ?? '{}') as { switch: string }).switch, 'updated');
	});

	test('never overwrites or deletes an item that the new code wrote', async () => {
		oldTable.set('rewritten', releaseItem('rewritten', 'old'));
		oldTable.set('deleted-then-put', releaseItem('deleted-then-put', 'old'));
		const copy = await complete(await begin(request('copy')));
		// The app's function is updated. The new code writes; a write of the old code is still in the stream.
		appFunction = { status: 'UPDATE_COMPLETE', at: Date.now() };
		oldPut('rewritten', 'late write of the old code');
		oldDelete('deleted-then-put');
		newPut('rewritten', 'new');
		newPut('deleted-then-put', 'new');
		const { data } = await complete(await begin(drainOf(copy.data)));
		assert.deepEqual(newItems(), { 'deleted-then-put': 'new', rewritten: 'new' });
		const stats = JSON.parse(data?.Stats ?? '{}') as { streamRecords: number; streamApplied: number };
		assert.deepEqual({ records: stats.streamRecords, applied: stats.streamApplied }, { records: 2, applied: 0 });
	});

	test('a pass over a stream that it read before is one read for each shard', async () => {
		oldTable.set('k', releaseItem('k', 'a'));
		const copy = await complete(await begin(request('copy')));
		appFunction = { status: 'UPDATE_COMPLETE', at: Date.now() };
		oldPut('k', 'b');
		streamCalls = { describe: 0, iterator: 0, records: 0 };
		// A drain period of 20 ms: several passes in one invocation.
		await complete(await begin(drainOf(copy.data, { DrainSeconds: '0.02' })));
		assert.equal(newItems().k, 'b*');
		// The first pass reads the record and then the tip. Each later pass is one read.
		assert.ok(streamCalls.records >= 3, `expected more than one pass (${streamCalls.records} reads)`);
		assert.deepEqual(
			{ describe: streamCalls.describe, iterator: streamCalls.iterator },
			{ describe: 1, iterator: 1 },
		);
	});

	test('an iterator that expired is replaced at the position', async () => {
		oldTable.set('k', releaseItem('k', 'a'));
		const copy = await complete(await begin(request('copy')));
		appFunction = { status: 'UPDATE_COMPLETE', at: Date.now() };
		oldPut('k', 'b');
		expireIterator = true;
		await complete(await begin(drainOf(copy.data)));
		assert.equal(newItems().k, 'b*');
	});

	test('a function that this deploy created counts as the switch', async () => {
		const copy = await complete(await begin(request('copy')));
		appFunction = { status: 'CREATE_COMPLETE', at: Date.now() };
		const { data } = await complete(await begin(drainOf(copy.data)));
		assert.equal((JSON.parse(data?.Stats ?? '{}') as { switch: string }).switch, 'updated');
	});

	test('a function that an earlier deploy updated does not count as the switch', async () => {
		const copy = await complete(await begin(request('copy')));
		limits.drainSliceMs = 0;
		copyStatuses = ['CREATE_COMPLETE', 'CREATE_IN_PROGRESS'];
		appFunction = { status: 'UPDATE_COMPLETE', at: Date.now() - 3_600_000 };
		const event = await begin(drainOf(copy.data));
		assert.deepEqual(
			await isCompleteHandler(event),
			{ IsComplete: false },
			'another copy is at work: the update did not start',
		);
	});

	test('while another resource of the stack is in progress, the update of the functions can still come: the drain waits', async () => {
		const copy = await complete(await begin(request('copy')));
		limits.noSwitchMs = 0;
		limits.drainSliceMs = 0;
		otherStatus = 'CREATE_IN_PROGRESS';
		appFunction = { status: 'UPDATE_COMPLETE', at: Date.now() - 3_600_000 };
		const event = await begin(drainOf(copy.data));
		assert.deepEqual(await isCompleteHandler(event), { IsComplete: false });
		assert.deepEqual(await isCompleteHandler(event), { IsComplete: false });
	});

	test('when every copy is done and no function update starts, the deploy does not update them: the drain ends', async () => {
		const copy = await complete(await begin(request('copy')));
		limits.noSwitchMs = 0;
		appFunction = { status: 'UPDATE_COMPLETE', at: Date.now() - 3_600_000 };
		const { data } = await complete(await begin(drainOf(copy.data)));
		assert.equal((JSON.parse(data?.Stats ?? '{}') as { switch: string }).switch, 'no update in this deploy');
	});
});

// ── The handlers ────────────────────────────────────────────────────────────

describe('handlers', () => {
	test('onEvent gives the resource an id and the attributes that the template reads', async () => {
		const started = await handler(request('copy'));
		assert.equal(started.PhysicalResourceId, 'kv-migrate-copy-request-copy');
		assert.deepEqual(Object.keys(started.Data).sort(), ['Checkpoints', 'StartedAt', 'Stats']);
		assert.equal(
			(await handler({ ...request('copy'), RequestType: 'Update', PhysicalResourceId: 'kept' }))
				.PhysicalResourceId,
			'kept',
		);
	});

	test('an Update or a Delete does no work; a Delete of a drain removes its position', async () => {
		oldTable.set('k', releaseItem('k', 'a'));
		for (const RequestType of ['Update', 'Delete'] as const) {
			assert.deepEqual(await isCompleteHandler({ ...request('copy'), RequestType, PhysicalResourceId: 'id' }), {
				IsComplete: true,
			});
		}
		assert.deepEqual(newItems(), {});
		parameters.set('/blocks/kv-migrate/drain-1', '{}');
		await handler({ ...request('drain'), RequestType: 'Delete', PhysicalResourceId: 'drain-1' });
		assert.equal(parameters.size, 0);
		// A drain that never kept a position: the Delete still succeeds.
		await handler({ ...request('drain'), RequestType: 'Delete', PhysicalResourceId: 'drain-2' });
	});
});
