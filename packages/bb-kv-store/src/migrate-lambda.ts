// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The deploy-time job of a store with `migrateFrom`. It moves the items of the
 * table of a `KVStore` release up to 0.4.0 (`{ pk, value: <JSON text>, ttl? }`)
 * into the table of this release, in two custom resources.
 *
 * - `copy` runs BEFORE the app's functions are updated. It copies every item
 *   with a parallel Scan, then replays the stream of the old table from its
 *   start until one pass finds almost nothing, so the new table is at most a
 *   few records behind the old one.
 * - `drain` starts when `copy` ends, at the same time as the update of the
 *   app's functions. It follows the stream through that update and for a drain
 *   period after it, for writes that the old code still made.
 *
 * Every item that this job writes has the marker attribute `_bkv_m`. A `put`
 * of the new code replaces the whole item, so it has no marker. A replayed
 * change is applied only to an item that is absent or that has the marker:
 * the job never overwrites a write of the new code.
 *
 * What this cannot do is in DESIGN.md ("Move the items of an earlier release").
 */

import { CloudFormationClient, paginateListStackResources } from '@aws-sdk/client-cloudformation';
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
	type Shard,
	type _Record as StreamRecord,
} from '@aws-sdk/client-dynamodb-streams';
import { DeleteParameterCommand, GetParameterCommand, PutParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { marshall, unmarshall } from '@aws-sdk/util-dynamodb';
import { type KeyModel, layoutItem, resolveKeyModel } from './item.js';
import {
	DEFAULT_DRAIN_SECONDS,
	MIGRATE_COPY_RESOURCE_TYPE,
	MIGRATE_DRAIN_RESOURCE_TYPE,
	MIGRATE_PARAMETER_PATH,
	RELEASE_PK,
	RELEASE_TTL,
	RELEASE_VALUE,
} from './migrate-names.js';
import { MIGRATED_MARKER, PK_ATTRIBUTE, RESERVED_PREFIX } from './ttl.js';

const dynamodb = new DynamoDBClient({ maxAttempts: 10 });
const streams = new DynamoDBStreamsClient({ maxAttempts: 10 });
// Several stores of one stack read the same stack at once.
const cloudformation = new CloudFormationClient({ maxAttempts: 8 });
const ssm = new SSMClient({ maxAttempts: 8 });

/** Scan segments of the bulk copy, read side by side. */
const SEGMENTS = 8;
/** `BatchWriteItem` calls of one segment that are in flight at the same time. */
const WRITES_IN_FLIGHT = 4;
/** Changes of different keys that the replay applies at the same time. */
const APPLY_IN_FLIGHT = 32;
/** The copy phase ends when this many passes in a row reach the tip of the stream, each within `limits.tipMs`. */
const TIP_PASSES = 3;

/**
 * The time limits of the job. A unit test shortens them; nothing else writes
 * them.
 */
export const limits = {
	/** How long one invocation copies before it hands over to the next one. A Lambda invocation ends after 15 minutes. */
	copySliceMs: 10 * 60_000,
	/** How long one invocation of the drain follows the stream before it hands over to the next one. */
	drainSliceMs: 12 * 60_000,
	/** How often the drain asks CloudFormation whether the app's functions are updated. */
	switchCheckMs: 3_000,
	/** When every copy of the stack is done and no function update starts for this long, this deploy does not update them. */
	noSwitchMs: 180_000,
	/** The pause of the drain when a pass over the stream found nothing. */
	idleMs: 150,
	/** How long a pass uses the list of the shards before it lists them again. A shard that closes lists them at once. */
	shardListMs: 15_000,
	/** A pass that reaches the tip of the stream within this time leaves the new table this far behind at most. */
	tipMs: 1_000,
};

/** The properties that the CDK layer gives each custom resource. */
export interface MigrateProperties {
	Phase: 'copy' | 'drain';
	OldTable: string;
	NewTable: string;
	StreamArn: string;
	/** JSON of the `indexes` and `ttl` options of the new store: where a write puts the expiry, and what it refuses in an indexed field. */
	KeyOptions: string;
	/** `drain`: the position in the stream that `copy` returned. */
	Checkpoints?: string;
	/** `drain`: how long to follow the stream after the functions are updated. */
	DrainSeconds?: string;
	/** `drain`: the logical ids of the functions that run the app. */
	FunctionLogicalIds?: string[];
}

/** The event of the CDK Provider framework: the CloudFormation request, plus what `handler` returned. */
export interface MigrateEvent {
	RequestType: 'Create' | 'Update' | 'Delete';
	PhysicalResourceId?: string;
	RequestId: string;
	StackId: string;
	ResourceProperties: MigrateProperties;
	Data?: Record<string, string>;
}

/** Where the replay is: the last sequence number applied in each shard, and the shards that are read to their end. */
interface StreamPosition {
	seq: Record<string, string>;
	done: string[];
}

const START_OF_STREAM = '{"seq":{},"done":[]}';

/** What the job did, for the log and for the attributes of the custom resource. */
interface Stats {
	items: number;
	readUnits: number;
	writeUnits: number;
	invocations: number;
	streamRecords: number;
	/** The rest were older records of a key in one page, or changes to an item that the new code wrote. */
	streamApplied: number;
}

const noStats = (): Stats => ({
	items: 0,
	readUnits: 0,
	writeUnits: 0,
	invocations: 0,
	streamRecords: 0,
	streamApplied: 0,
});

// ── Conversion ──────────────────────────────────────────────────────────────

/** The key model of the new store: a string key, with the indexes and the `ttl` field of the store. */
function modelOf(props: MigrateProperties): KeyModel {
	return resolveKeyModel(JSON.parse(props.KeyOptions));
}

/**
 * The item of this release for an item of the old table, with the marker.
 *
 * @throws If the item is not an item of a release, or if a write of this
 *   release refuses its value (a field with the reserved prefix, a field named
 *   `__proto__`, an empty string in an indexed field).
 */
export function convertItem(model: KeyModel, old: Record<string, AttributeValue>): Record<string, AttributeValue> {
	const { [RELEASE_PK]: key, [RELEASE_VALUE]: value, [RELEASE_TTL]: ttl } = unmarshall(old);
	if (typeof key !== 'string' || typeof value !== 'string') {
		throw new Error('it is not an item of a KVStore release: it has no string `pk` and `value`');
	}
	const laidOut = layoutItem(model, key, JSON.parse(value), typeof ttl === 'number' ? ttl : undefined);
	return marshall({ ...laidOut, [MIGRATED_MARKER]: 1 }, { removeUndefinedValues: true });
}

// ── The state of the copy phase: one item in the new table, removed when the phase ends ──
//
// The app does not read the new table during the copy phase, so the item is
// never seen. Its size is not bounded by the 4 KB of a parameter: it holds a
// table key for each segment.

interface CopyState {
	segments: { key?: Record<string, AttributeValue>; done: boolean }[];
	position: StreamPosition;
	stats: Stats;
}

const copyStateKey = (physicalId: string) => ({ [PK_ATTRIBUTE]: { S: `${RESERVED_PREFIX}migration:${physicalId}` } });

async function loadCopyState(props: MigrateProperties, physicalId: string): Promise<CopyState> {
	const out = await dynamodb.send(
		new GetItemCommand({ TableName: props.NewTable, Key: copyStateKey(physicalId), ConsistentRead: true }),
	);
	if (out.Item?.state?.S) return JSON.parse(out.Item.state.S) as CopyState;
	return {
		segments: Array.from({ length: SEGMENTS }, () => ({ done: false })),
		position: JSON.parse(START_OF_STREAM) as StreamPosition,
		stats: noStats(),
	};
}

async function saveCopyState(props: MigrateProperties, physicalId: string, state: CopyState): Promise<void> {
	await dynamodb.send(
		new PutItemCommand({
			TableName: props.NewTable,
			Item: { ...copyStateKey(physicalId), state: { S: JSON.stringify(state) } },
		}),
	);
}

// ── Bulk copy ───────────────────────────────────────────────────────────────

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Write one batch, and write again what DynamoDB did not process, with backoff. */
async function writeBatch(table: string, items: Record<string, AttributeValue>[], stats: Stats): Promise<void> {
	let pending = items.map((Item) => ({ PutRequest: { Item } }));
	for (let attempt = 0; pending.length > 0; attempt++) {
		if (attempt > 0) await pause(Math.min(50 * 2 ** attempt, 2_000) * (0.5 + Math.random()));
		const out = await dynamodb.send(
			new BatchWriteItemCommand({ RequestItems: { [table]: pending }, ReturnConsumedCapacity: 'TOTAL' }),
		);
		for (const consumed of out.ConsumedCapacity ?? []) stats.writeUnits += consumed.CapacityUnits ?? 0;
		pending = (out.UnprocessedItems?.[table] ?? []) as typeof pending;
	}
}

/**
 * Copy one Scan segment until it ends or the deadline passes. Each call copies
 * at least one page, so a slice always moves the segment on. The position of
 * the segment moves only after a page is written.
 */
async function copySegment(
	props: MigrateProperties,
	model: KeyModel,
	state: CopyState,
	segment: number,
	deadline: number,
): Promise<void> {
	const cursor = state.segments[segment];
	for (let first = true; !cursor.done && (first || Date.now() < deadline); first = false) {
		const page = await dynamodb.send(
			new ScanCommand({
				TableName: props.OldTable,
				Segment: segment,
				TotalSegments: SEGMENTS,
				ExclusiveStartKey: cursor.key,
				// A write that ended before the stream began must be in the Scan.
				ConsistentRead: true,
				ReturnConsumedCapacity: 'TOTAL',
			}),
		);
		state.stats.readUnits += page.ConsumedCapacity?.CapacityUnits ?? 0;
		const converted: Record<string, AttributeValue>[] = [];
		const refused: string[] = [];
		for (const old of page.Items ?? []) {
			try {
				converted.push(convertItem(model, old));
			} catch (error) {
				refused.push(
					`${old[RELEASE_PK]?.S ?? '(no key)'}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
		if (refused.length > 0) {
			// The deploy stops here, before the app's functions are updated.
			throw new Error(
				`KVStore migrateFrom: ${refused.length} items of ${props.OldTable} cannot be stored in the new layout. ` +
					`Change or delete them in ${props.OldTable}, then deploy again. ${refused.slice(0, 10).join('; ')}`,
			);
		}
		const batches: Record<string, AttributeValue>[][] = [];
		for (let i = 0; i < converted.length; i += 25) batches.push(converted.slice(i, i + 25));
		for (let i = 0; i < batches.length; i += WRITES_IN_FLIGHT) {
			await Promise.all(
				batches.slice(i, i + WRITES_IN_FLIGHT).map((batch) => writeBatch(props.NewTable, batch, state.stats)),
			);
		}
		state.stats.items += converted.length;
		cursor.key = page.LastEvaluatedKey;
		cursor.done = page.LastEvaluatedKey === undefined;
	}
}

// ── Stream replay ───────────────────────────────────────────────────────────

/**
 * What one invocation keeps between two passes over the stream, so that a pass
 * over a stream with nothing new is one read for each shard.
 */
interface StreamCursor {
	/** The shards of the stream, as last listed. */
	shards: Shard[];
	listedAt: number;
	/** For each open shard, the iterator that its last read returned. */
	iterators: Map<string, string>;
}

const newCursor = (): StreamCursor => ({ shards: [], listedAt: 0, iterators: new Map() });

async function listShards(streamArn: string): Promise<Shard[]> {
	const shards: Shard[] = [];
	let start: string | undefined;
	do {
		const out = await streams.send(
			new DescribeStreamCommand({ StreamArn: streamArn, ExclusiveStartShardId: start }),
		);
		shards.push(...(out.StreamDescription?.Shards ?? []));
		start = out.StreamDescription?.LastEvaluatedShardId;
	} while (start);
	return shards;
}

/**
 * Apply one change of the old table to the new table, unless the new code
 * wrote the item. Returns whether it was applied.
 *
 * - A put: only if the item is absent or has the marker.
 * - A delete: only if the item has the marker.
 *
 * @throws If the new layout refuses the item. The error names the item, as the error of the Scan does.
 */
async function applyRecord(props: MigrateProperties, model: KeyModel, record: StreamRecord): Promise<boolean> {
	const key = record.dynamodb?.Keys?.[RELEASE_PK];
	if (!key) return false;
	try {
		if (record.eventName === 'REMOVE') {
			await dynamodb.send(
				new DeleteItemCommand({
					TableName: props.NewTable,
					Key: { [PK_ATTRIBUTE]: key as AttributeValue },
					ConditionExpression: 'attribute_exists(#m)',
					ExpressionAttributeNames: { '#m': MIGRATED_MARKER },
				}),
			);
			return true;
		}
		const image = record.dynamodb?.NewImage;
		if (!image) return false;
		let item: Record<string, AttributeValue>;
		try {
			item = convertItem(model, image as Record<string, AttributeValue>);
		} catch (error) {
			throw new Error(
				`KVStore migrateFrom: the item ${key.S ?? '(no key)'} of ${props.OldTable} cannot be stored in the new layout. ` +
					`Change or delete it in ${props.OldTable}, then deploy again. ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		await dynamodb.send(
			new PutItemCommand({
				TableName: props.NewTable,
				Item: item,
				ConditionExpression: 'attribute_not_exists(#pk) OR attribute_exists(#m)',
				ExpressionAttributeNames: { '#pk': PK_ATTRIBUTE, '#m': MIGRATED_MARKER },
			}),
		);
		return true;
	} catch (error) {
		// The new code wrote the item: its write is the later one.
		if (error instanceof Error && error.name === 'ConditionalCheckFailedException') return false;
		throw error;
	}
}

/** Apply the records of one page: only the last record of each key, several keys at a time. */
async function applyPage(
	props: MigrateProperties,
	model: KeyModel,
	records: StreamRecord[],
	stats: Stats,
): Promise<void> {
	const lastOfKey = new Map<string, StreamRecord>();
	for (const record of records) lastOfKey.set(record.dynamodb?.Keys?.[RELEASE_PK]?.S ?? '', record);
	const pending = [...lastOfKey.values()];
	stats.streamRecords += records.length;
	const worker = async () => {
		for (let record = pending.pop(); record; record = pending.pop()) {
			if (await applyRecord(props, model, record)) stats.streamApplied++;
		}
	};
	await Promise.all(Array.from({ length: APPLY_IN_FLIGHT }, worker));
}

/**
 * One pass over the stream: read every shard from `position` to its tip,
 * parents before children, shards side by side. The records of one key are in
 * one shard lineage, so their order holds. A pass reads one page of each shard
 * at least, so it always moves on. Returns the number of records read, and
 * `cut` when the deadline ended the pass before the tip of a shard.
 */
async function replayPass(
	props: MigrateProperties,
	model: KeyModel,
	position: StreamPosition,
	stats: Stats,
	cursor: StreamCursor,
	deadline: number,
): Promise<{ read: number; cut: boolean }> {
	const relist = async () => {
		cursor.shards = await listShards(props.StreamArn);
		cursor.listedAt = Date.now();
		// A shard that the stream no longer lists is past: the position forgets it.
		const listed = new Set(cursor.shards.map((shard) => shard.ShardId));
		position.done = position.done.filter((id) => listed.has(id));
	};
	if (Date.now() - cursor.listedAt >= limits.shardListMs) await relist();

	const iteratorAtPosition = async (id: string): Promise<string> => {
		const last = position.seq[id];
		const out = await streams.send(
			new GetShardIteratorCommand({
				StreamArn: props.StreamArn,
				ShardId: id,
				...(last
					? { ShardIteratorType: 'AFTER_SEQUENCE_NUMBER', SequenceNumber: last }
					: { ShardIteratorType: 'TRIM_HORIZON' }),
			}),
		);
		if (!out.ShardIterator)
			throw new Error(`KVStore migrateFrom: no iterator for shard ${id} of ${props.StreamArn}`);
		return out.ShardIterator;
	};
	const readPage = async (id: string, iterator: string) => {
		try {
			return await streams.send(new GetRecordsCommand({ ShardIterator: iterator, Limit: 1000 }));
		} catch (error) {
			// An iterator lasts 15 minutes. Read from the position with a new one.
			if (!(error instanceof Error && error.name === 'ExpiredIteratorException')) throw error;
			return streams.send(new GetRecordsCommand({ ShardIterator: await iteratorAtPosition(id), Limit: 1000 }));
		}
	};

	const visited = new Set<string>();
	let read = 0;
	let cut = false;

	/** Read one shard to its tip. Returns true when the shard is closed and read to its end. */
	const readShard = async (shard: Shard): Promise<boolean> => {
		const id = shard.ShardId as string;
		visited.add(id);
		let iterator: string | undefined = cursor.iterators.get(id) ?? (await iteratorAtPosition(id));
		let atTip = false;
		for (let first = true; iterator && !atTip && (first || Date.now() < deadline); first = false) {
			const out = await readPage(id, iterator);
			const records = out.Records ?? [];
			iterator = out.NextShardIterator;
			if (records.length === 0) {
				atTip = true;
				continue;
			}
			await applyPage(props, model, records, stats);
			read += records.length;
			const sequenceNumber = records.at(-1)?.dynamodb?.SequenceNumber;
			if (sequenceNumber) position.seq[id] = sequenceNumber;
		}
		if (iterator) {
			cursor.iterators.set(id, iterator);
			if (!atTip) cut = true;
			return false;
		}
		cursor.iterators.delete(id);
		delete position.seq[id];
		position.done.push(id);
		return true;
	};

	for (let closed = true; closed; ) {
		const listed = new Set(cursor.shards.map((shard) => shard.ShardId));
		// A shard is read after its parent is read to its end. A parent that the stream no longer lists is past.
		const ready = (shard: Shard) =>
			!shard.ParentShardId || !listed.has(shard.ParentShardId) || position.done.includes(shard.ParentShardId);
		const round = cursor.shards.filter(
			(shard) =>
				!position.done.includes(shard.ShardId as string) &&
				!visited.has(shard.ShardId as string) &&
				ready(shard),
		);
		closed = (await Promise.all(round.map(readShard))).some(Boolean);
		// A shard that closes has children. List the shards again, and read the children in this pass.
		if (closed) await relist();
	}
	return { read, cut };
}

// ── The copy phase ──────────────────────────────────────────────────────────

async function copyPhase(props: MigrateProperties, physicalId: string) {
	// One deadline for the Scan and the replay: the invocation ends well before the 15 minutes of the function.
	const deadline = Date.now() + limits.copySliceMs;
	const model = modelOf(props);
	const state = await loadCopyState(props, physicalId);
	state.stats.invocations++;

	if (state.segments.some((segment) => !segment.done)) {
		await Promise.all(state.segments.map((_, segment) => copySegment(props, model, state, segment, deadline)));
		await saveCopyState(props, physicalId, state);
		if (state.segments.some((segment) => !segment.done)) return { IsComplete: false };
	}

	// Pass over the stream until the new table is less than `limits.tipMs` behind the old one: a pass that the
	// deadline did not cut short, and that took no longer than that. One such pass is not enough, because a read
	// of a stream can come back empty before the last record. Each pass reads on, so several in a row are the tip.
	// The count is of time, not of records: a busy table has new records in every pass.
	const cursor = newCursor();
	let passesAtTip = 0;
	while (passesAtTip < TIP_PASSES && (passesAtTip > 0 || Date.now() < deadline || cursor.listedAt === 0)) {
		const started = Date.now();
		const pass = await replayPass(props, model, state.position, state.stats, cursor, deadline);
		passesAtTip = !pass.cut && Date.now() - started <= limits.tipMs ? passesAtTip + 1 : 0;
	}
	if (passesAtTip < TIP_PASSES) {
		await saveCopyState(props, physicalId, state);
		return { IsComplete: false };
	}

	await dynamodb.send(new DeleteItemCommand({ TableName: props.NewTable, Key: copyStateKey(physicalId) }));
	console.log(`KVStore migrateFrom: copied ${props.OldTable} to ${props.NewTable} ${JSON.stringify(state.stats)}`);
	return {
		IsComplete: true,
		Data: { Checkpoints: JSON.stringify(state.position), Stats: JSON.stringify(state.stats) },
	};
}

// ── The drain phase ─────────────────────────────────────────────────────────
//
// The app reads the new table by now, so the position of the drain between
// two invocations is in a parameter, not in the table.

type Switch = 'updated' | 'no update in this deploy';

interface DrainState {
	position: StreamPosition;
	stats: Stats;
	/** When the drain first saw that the app's functions are updated, or decided that this deploy does not update them. */
	switchedAt?: number;
	switch?: Switch;
	/** Since when the drain saw every copy done and nothing in the stack but the drains in progress. */
	quietSince?: number;
}

const drainParameter = (physicalId: string) =>
	`${MIGRATE_PARAMETER_PATH}${physicalId.replace(/[^A-Za-z0-9_.-]/g, '-')}`;

async function loadDrainState(props: MigrateProperties, physicalId: string): Promise<DrainState> {
	try {
		const out = await ssm.send(new GetParameterCommand({ Name: drainParameter(physicalId) }));
		if (out.Parameter?.Value) return JSON.parse(out.Parameter.Value) as DrainState;
	} catch (error) {
		if (!(error instanceof Error && error.name === 'ParameterNotFound')) throw error;
	}
	return { position: JSON.parse(props.Checkpoints ?? START_OF_STREAM) as StreamPosition, stats: noStats() };
}

async function deleteDrainState(physicalId: string): Promise<void> {
	try {
		await ssm.send(new DeleteParameterCommand({ Name: drainParameter(physicalId) }));
	} catch (error) {
		if (!(error instanceof Error && error.name === 'ParameterNotFound')) throw error;
	}
}

/**
 * Ask CloudFormation whether the app's functions run the new code: one read
 * of the resources of the stack.
 *
 * - `updated`: this deploy updated or created each function (after `since`).
 * - `no update in this deploy`: every copy is done, and nothing in the stack
 *   but the drains was in progress for `limits.noSwitchMs`. A function waits
 *   for every copy, and for whatever else this deploy changes before it (a
 *   policy of its role, another resource that the role is granted). While any
 *   of that is in progress, the update of the function can still come.
 * - Else undefined.
 */
async function switchOf(
	props: MigrateProperties,
	stackId: string,
	state: DrainState,
	since: number,
): Promise<Switch | undefined> {
	const functions = new Set(props.FunctionLogicalIds ?? []);
	if (functions.size === 0) return 'no update in this deploy';
	let updated = 0;
	let atWork = false;
	for await (const page of paginateListStackResources({ client: cloudformation }, { StackName: stackId })) {
		for (const resource of page.StackResourceSummaries ?? []) {
			const status = resource.ResourceStatus ?? '';
			// The drains are at work for as long as this runs.
			if (resource.ResourceType === MIGRATE_DRAIN_RESOURCE_TYPE) continue;
			if (status.endsWith('_IN_PROGRESS')) atWork = true;
			if (resource.ResourceType === MIGRATE_COPY_RESOURCE_TYPE) {
				if (status !== 'CREATE_COMPLETE' && status !== 'UPDATE_COMPLETE') atWork = true;
			} else if (functions.has(resource.LogicalResourceId ?? '')) {
				const done = status === 'UPDATE_COMPLETE' || status === 'CREATE_COMPLETE';
				if (done && (resource.LastUpdatedTimestamp?.getTime() ?? 0) > since) updated++;
			}
		}
	}
	if (updated === functions.size) return 'updated';
	if (atWork) {
		state.quietSince = undefined;
		return undefined;
	}
	state.quietSince ??= Date.now();
	return Date.now() - state.quietSince > limits.noSwitchMs ? 'no update in this deploy' : undefined;
}

async function drainPhase(props: MigrateProperties, physicalId: string, stackId: string, startedAt: number) {
	const invocationEnds = Date.now() + limits.drainSliceMs;
	const model = modelOf(props);
	const state = await loadDrainState(props, physicalId);
	state.stats.invocations++;
	const drainMs = Number(props.DrainSeconds ?? DEFAULT_DRAIN_SECONDS) * 1000;
	const cursor = newCursor();
	let checkedAt = 0;
	for (;;) {
		const { read, cut } = await replayPass(props, model, state.position, state.stats, cursor, Date.now() + 60_000);
		if (state.switchedAt === undefined && Date.now() - checkedAt >= limits.switchCheckMs) {
			checkedAt = Date.now();
			// A function that was updated shortly before the drain began was updated by this deploy.
			state.switch = await switchOf(props, stackId, state, startedAt - 30_000);
			if (state.switch) state.switchedAt = Date.now();
		}
		// The end: the drain period is over, and the last pass went to the tip of the stream. The passes of the
		// drain period read on through the stream, so that tip is the real one.
		if (state.switchedAt !== undefined && Date.now() >= state.switchedAt + drainMs && !cut) break;
		if (Date.now() > invocationEnds) {
			await ssm.send(
				new PutParameterCommand({
					Name: drainParameter(physicalId),
					Value: JSON.stringify(state),
					Type: 'String',
					Overwrite: true,
				}),
			);
			return { IsComplete: false };
		}
		if (read === 0) await pause(limits.idleMs);
	}
	await deleteDrainState(physicalId);
	const result = { ...state.stats, switch: state.switch };
	console.log(`KVStore migrateFrom: followed ${props.OldTable} into ${props.NewTable} ${JSON.stringify(result)}`);
	return { IsComplete: true, Data: { Stats: JSON.stringify(result) } };
}

// ── Handlers ────────────────────────────────────────────────────────────────

/**
 * `onEvent` of the CDK Provider framework. The work is in
 * {@link isCompleteHandler}; this gives the resource its id and the time it
 * began. An Update does no work: the items moved when the resource was created.
 */
export async function handler(event: MigrateEvent) {
	const physicalId = event.PhysicalResourceId ?? `kv-migrate-${event.ResourceProperties.Phase}-${event.RequestId}`;
	// A deploy that rolls back deletes a drain that was at work: remove its position.
	if (event.RequestType === 'Delete' && event.ResourceProperties.Phase === 'drain')
		await deleteDrainState(physicalId);
	return {
		PhysicalResourceId: physicalId,
		Data: { StartedAt: String(Date.now()), Checkpoints: START_OF_STREAM, Stats: '{}' },
	};
}

/**
 * `isComplete` of the CDK Provider framework: one slice of the copy, or of the
 * drain. The framework calls it again until it reports `IsComplete: true`.
 */
export async function isCompleteHandler(event: MigrateEvent) {
	if (event.RequestType !== 'Create') return { IsComplete: true };
	const props = event.ResourceProperties;
	const physicalId = event.PhysicalResourceId as string;
	if (props.Phase === 'copy') return copyPhase(props, physicalId);
	return drainPhase(props, physicalId, event.StackId, Number(event.Data?.StartedAt ?? Date.now()));
}
