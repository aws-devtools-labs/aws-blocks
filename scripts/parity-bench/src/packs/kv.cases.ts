// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// KVStore (bb-kv-store) and DistributedTable (bb-distributed-table) parity
// cases. Pure data — executed by kv.probe.ts.
//
// Both blocks check item size locally as `Buffer.byteLength(JSON.stringify(...))`
// against 400 KB, while DynamoDB sizes an item as attribute-name bytes plus
// value bytes plus per-type overhead. The size cases target the DynamoDB rule
// exactly (see the item-size doc below) so each case sits on a known side of
// the AWS boundary while its JSON size sits on a known side of the mock's.

import type { ParityCase } from '../core/types.js';

const DDB_ITEM_SIZE = 'https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/CapacityUnitCalculations.html';
const DDB_CONSTRAINTS = 'https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Constraints.html';
const DDB_DATA_TYPES = 'https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/HowItWorks.NamingRulesDataTypes.html';
const DDB_BATCH_WRITE = 'https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_BatchWriteItem.html';
const DDB_BATCH_GET = 'https://docs.aws.amazon.com/cli/latest/reference/dynamodb/batch-get-item.html';
const DDB_QUERY = 'https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_Query.html';
const DDB_SCAN = 'https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_Scan.html';
const SDK_DOC_CLIENT = 'https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/migrate-dynamodb-doc-client.html';
// The Date / MAX_SAFE_INTEGER rules live in the marshaller itself (convertToAttr / convertToNumberAttr).
const SDK_MARSHALL_SRC = '@aws-sdk/util-dynamodb dist-cjs/index.js';

/** DynamoDB's 400 KB item limit, in bytes. */
export const DDB_ITEM_LIMIT = 400 * 1024;

const KV = 'bb-kv-store';
const DT = 'bb-distributed-table';

function kvCase(id: string, block: string, category: ParityCase['category'], description: string, source: string, params: ParityCase['params']): ParityCase {
	return { id: `kv.${id}`, pack: 'kv', block, category, description, source, params };
}

export const kvCases: readonly ParityCase[] = [
	// ── KVStore: item size (stored item = pk + value attributes) ─────────────
	kvCase(
		'item-size.store-put.ddb-limit',
		KV,
		'limits',
		'store.put() of a value sized so the DynamoDB item (names "pk"+"value" + key + JSON value) is exactly 409,600 bytes',
		`${DDB_ITEM_SIZE} (item size = attribute names + values; max 400 KB)`,
		{ scenario: 'store-item-size', ddbBytes: DDB_ITEM_LIMIT },
	),
	kvCase(
		'item-size.store-put.ddb-limit-plus-1',
		KV,
		'limits',
		'store.put() with a DynamoDB item of 409,601 bytes; the JSON value alone is still under the mock\'s 400 KB check',
		`${DDB_ITEM_SIZE} (attribute names and the key count toward the 400 KB item size)`,
		{ scenario: 'store-item-size', ddbBytes: DDB_ITEM_LIMIT + 1 },
	),
	kvCase(
		'item-size.store-put.json-limit-plus-1',
		KV,
		'errors',
		'store.put() of a value whose JSON is 409,601 bytes, over both limits; compares the error name each side raises',
		`${DDB_ITEM_SIZE}; packages/bb-kv-store/README.md (ItemTooLarge on both layers)`,
		{ scenario: 'store-item-size', jsonBytes: DDB_ITEM_LIMIT + 1 },
	),

	// ── KVStore: partition key ──────────────────────────────────────────────
	kvCase(
		'key-size.store-put.2049-bytes',
		KV,
		'limits',
		'store.put() with a 2,049-byte key (partition key max is 2,048 bytes)',
		`${DDB_CONSTRAINTS} (partition key length 1 to 2048 bytes)`,
		{ scenario: 'store-key', op: 'put', keyBytes: 2049 },
	),
	kvCase(
		'key-size.store-get.2049-bytes',
		KV,
		'limits',
		'store.get() of a 2,049-byte key that was never written',
		`${DDB_CONSTRAINTS} (partition key length 1 to 2048 bytes)`,
		{ scenario: 'store-key', op: 'get', keyBytes: 2049 },
	),
	kvCase(
		'key-empty.store-put.empty-string',
		KV,
		'limits',
		'store.put() with the empty string as key',
		`${DDB_CONSTRAINTS} (minimum partition key length is 1 byte; empty strings are not allowed for key attributes)`,
		{ scenario: 'store-key', op: 'put', keyBytes: 0 },
	),

	// ── DistributedTable: item size on every write path ─────────────────────
	kvCase(
		'item-size.table-put.string-ddb-limit',
		DT,
		'limits',
		'table.put() of a string item that is exactly 409,600 bytes by DynamoDB\'s rule; its JSON is a few bytes larger',
		`${DDB_ITEM_SIZE} (string size = UTF-8 bytes of name + value)`,
		{ scenario: 'table-item-size', shape: 'string', entry: 'put', ddbBytes: DDB_ITEM_LIMIT },
	),
	kvCase(
		'item-size.table-put.nested-list-ddb-limit',
		DT,
		'limits',
		'table.put() of a list of empty lists sized to exactly 409,600 bytes by DynamoDB\'s rule (JSON is ~300 KB)',
		`${DDB_ITEM_SIZE} (empty List = 3 bytes; each List element adds 1 byte)`,
		{ scenario: 'table-item-size', shape: 'nested-list', entry: 'put', ddbBytes: DDB_ITEM_LIMIT },
	),
	kvCase(
		'item-size.table-put.nested-list-ddb-limit-plus-1',
		DT,
		'limits',
		'table.put() of a list of empty lists at 409,601 bytes by DynamoDB\'s rule (JSON is ~300 KB, under the mock check)',
		`${DDB_ITEM_SIZE} (empty List = 3 bytes; each List element adds 1 byte)`,
		{ scenario: 'table-item-size', shape: 'nested-list', entry: 'put', ddbBytes: DDB_ITEM_LIMIT + 1 },
	),
	kvCase(
		'item-size.table-putBatch.nested-list-ddb-limit-plus-1',
		DT,
		'limits',
		'table.putBatch() of one list-of-empty-lists item at 409,601 bytes by DynamoDB\'s rule',
		`${DDB_BATCH_WRITE} (the whole batch is rejected if any item exceeds 400 KB)`,
		{ scenario: 'table-item-size', shape: 'nested-list', entry: 'putBatch', ddbBytes: DDB_ITEM_LIMIT + 1 },
	),

	// ── DistributedTable: batch semantics ───────────────────────────────────
	kvCase(
		'batch-atomicity.table-putBatch.oversized-item-in-second-chunk',
		DT,
		'consistency',
		'table.putBatch() of 30 items where item 27 is over 400 KB; records the error and how many of the 30 were persisted',
		`${DDB_BATCH_WRITE} (each 25-request call is rejected as a whole; the block splits >25 items into separate calls)`,
		{ scenario: 'table-batch-atomicity', items: 30, oversizedIndex: 26 },
	),
	kvCase(
		'batch-duplicates.table-putBatch.same-key-twice',
		DT,
		'errors',
		'table.putBatch() with two items that share a primary key in one call',
		`${DDB_BATCH_WRITE} (rejects a request with two items with identical hash and range keys)`,
		{ scenario: 'table-batch-duplicates', entry: 'putBatch' },
	),
	kvCase(
		'batch-duplicates.table-getBatch.same-key-twice',
		DT,
		'errors',
		'table.getBatch() with the same existing key listed twice',
		`${DDB_BATCH_GET} (BatchGetItem results in a ValidationException if the same key is specified multiple times)`,
		{ scenario: 'table-batch-duplicates', entry: 'getBatch' },
	),

	// ── DistributedTable: JS values the DocumentClient marshaller rejects ───
	kvCase(
		'marshal.table-put.undefined-attribute',
		DT,
		'errors',
		'table.put() of an item with an optional schema field explicitly set to undefined',
		`${SDK_DOC_CLIENT} (v3 no longer omits undefined values unless marshallOptions.removeUndefinedValues; the block does not set it)`,
		{ scenario: 'table-marshal', value: 'undefined-attribute' },
	),
	kvCase(
		'marshal.table-put.date-attribute',
		DT,
		'errors',
		'table.put() of an item with a z.date() field holding a Date; records what a get() returns for it',
		`${DDB_DATA_TYPES} (DynamoDB has no date type); ${SDK_MARSHALL_SRC} ("Unsupported type passed" for class instances unless convertClassInstanceToMap)`,
		{ scenario: 'table-marshal', value: 'date-attribute' },
	),
	kvCase(
		'number.table-put.unsafe-integer',
		DT,
		'limits',
		'table.put() of a number field holding 2^53 + 2 (above Number.MAX_SAFE_INTEGER, well within DynamoDB\'s 38 digits)',
		`${DDB_DATA_TYPES} (Number: up to 38 digits of precision); ${SDK_MARSHALL_SRC} (rejects numbers above MAX_SAFE_INTEGER)`,
		{ scenario: 'table-marshal', value: 'unsafe-integer' },
	),
	kvCase(
		'nesting.table-put.depth-33',
		DT,
		'limits',
		'table.put() of an attribute that is 33 nested maps deep',
		`${DDB_CONSTRAINTS} (nested attributes up to 32 levels deep)`,
		{ scenario: 'table-nesting', depth: 33 },
	),

	// ── DistributedTable: key constraints ───────────────────────────────────
	kvCase(
		'key-size.table-put.sort-key-1025-bytes',
		DT,
		'limits',
		'table.put() with a 1,025-byte sort key (sort key max is 1,024 bytes)',
		`${DDB_CONSTRAINTS} (sort key length 1 to 1024 bytes)`,
		{ scenario: 'table-key', key: 'sort-key-1025' },
	),
	kvCase(
		'key-empty.table-put.gsi-key',
		DT,
		'limits',
		'table.put() with the empty string in a field that is the partition key of a GSI',
		`${DDB_CONSTRAINTS} (empty String values are not allowed for key attributes of a table or index)`,
		{ scenario: 'table-key', key: 'gsi-empty' },
	),

	// ── DistributedTable: query / scan arguments ────────────────────────────
	kvCase(
		'query.table-query.limit-0',
		DT,
		'errors',
		'table.query() with limit: 0 over a partition of 3 items',
		`${DDB_QUERY} (Limit: valid range minimum value of 1)`,
		{ scenario: 'table-query', variant: 'limit-0' },
	),
	kvCase(
		'query.table-scan.limit-0',
		DT,
		'errors',
		'table.scan() with limit: 0',
		`${DDB_SCAN} (Limit: valid range minimum value of 1)`,
		{ scenario: 'table-query', variant: 'scan-limit-0' },
	),
	kvCase(
		'query.table-query.between-reversed',
		DT,
		'errors',
		'table.query() with a sort-key between: [upper, lower] (bounds reversed)',
		`${DDB_QUERY} (BETWEEN is true when sort key >= first AND <= second)`,
		{ scenario: 'table-query', variant: 'between-reversed' },
	),
	kvCase(
		'query.table-query.utf8-order',
		DT,
		'consistency',
		'table.query() ascending over sort keys "z", U+FF61 and U+1F600, whose UTF-16 and UTF-8 orders differ',
		`${DDB_DATA_TYPES} (DynamoDB collates strings by their UTF-8 bytes)`,
		{ scenario: 'table-query', variant: 'utf8-order' },
	),
];
