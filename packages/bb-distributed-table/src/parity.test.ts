// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { DistributedTable, DistributedTableErrors } from './index.mock.js';
import { DistributedTable as AwsDistributedTable } from './index.aws.js';
import { isBlocksError } from '@aws-blocks/core';
import { z } from 'zod';

beforeEach(() => {
	try { rmSync('.bb-data', { recursive: true, force: true }); } catch {}
});

// ── Helpers ─────────────────────────────────────────────────────────────────

let scopeN = 0;
function testScope() {
	return { id: `dt-bug-${++scopeN}-${Date.now()}` } as any;
}

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
	const items: T[] = [];
	for await (const item of iter) items.push(item);
	return items;
}

/**
 * Build an AWS-runtime DistributedTable wired to a fake doc client whose `send`
 * is driven by the provided handler. The handler receives the SDK command and
 * returns the simulated DynamoDB response, letting tests exercise the real
 * getBatch/putBatch/deleteBatch retry loops without hitting AWS.
 */
function awsTableWithFakeClient<T>(
	id: string,
	options: any,
	send: (command: any) => Promise<any>,
) {
	const table = new AwsDistributedTable<T>(testScope(), id, options);
	(table as any).docClient = { send: (command: any) => send(command) };
	return table;
}

describe('AWS getBatch retries UnprocessedKeys returned by BatchGetItem until all keys resolve', () => {
	const schema = z.object({ id: z.string(), value: z.number() });
	const options = { schema, key: { partitionKey: 'id' } };

	test('resubmits only the unprocessed keys and merges results across attempts', async () => {
		const calls: any[][] = [];
		const table = awsTableWithFakeClient('get-retry-1', options, async command => {
			const tableName = Object.keys(command.input.RequestItems)[0];
			const keys: any[] = command.input.RequestItems[tableName].Keys;
			calls.push(keys.map(k => k.id));

			// First call: only return item "a" and report "b" as unprocessed.
			if (calls.length === 1) {
				return {
					Responses: { [tableName]: [{ id: 'a', value: 1 }] },
					UnprocessedKeys: { [tableName]: { Keys: [{ id: 'b' }] } },
				};
			}
			// Second call: return the previously unprocessed "b".
			return { Responses: { [tableName]: [{ id: 'b', value: 2 }] } };
		});

		const results = await table.getBatch([{ id: 'a' }, { id: 'b' }]);

		assert.deepStrictEqual(results, [{ id: 'a', value: 1 }, { id: 'b', value: 2 }]);
		assert.strictEqual(calls.length, 2, 'should make a second call for the unprocessed key');
		assert.deepStrictEqual(calls[0], ['a', 'b'], 'first call requests all keys');
		assert.deepStrictEqual(calls[1], ['b'], 'retry requests only the unprocessed key');
	});

	test('throws BatchIncomplete when keys never resolve after exhausting retries', async () => {
		let callCount = 0;
		const table = awsTableWithFakeClient('get-retry-2', options, async command => {
			callCount++;
			const tableName = Object.keys(command.input.RequestItems)[0];
			// Always report the key as unprocessed — never makes progress.
			return {
				Responses: { [tableName]: [] },
				UnprocessedKeys: { [tableName]: { Keys: [{ id: 'a' }] } },
			};
		});

		await assert.rejects(
			() => table.getBatch([{ id: 'a' }]),
			(err: any) => {
				assert.strictEqual(err.name, DistributedTableErrors.BatchIncomplete);
				assert.match(err.message, /unprocessed/i);
				return true;
			},
		);
		assert.ok(callCount > 1 && callCount <= 5, `should retry but cap attempts, got ${callCount}`);
	});
});

describe('AWS putBatch retries UnprocessedItems returned by BatchWriteItem', () => {
	const schema = z.object({ id: z.string(), value: z.number() });
	const options = { schema, key: { partitionKey: 'id' } };

	test('resubmits only the unprocessed write requests on the next attempt', async () => {
		const calls: any[][] = [];
		const table = awsTableWithFakeClient('put-retry-1', options, async command => {
			const tableName = Object.keys(command.input.RequestItems)[0];
			const requests: any[] = command.input.RequestItems[tableName];
			calls.push(requests.map(r => r.PutRequest.Item.id));

			if (calls.length === 1) {
				// Report the second item's write as unprocessed.
				return { UnprocessedItems: { [tableName]: [requests[1]] } };
			}
			return {};
		});

		await table.putBatch([{ id: 'a', value: 1 }, { id: 'b', value: 2 }]);

		assert.strictEqual(calls.length, 2, 'should retry the unprocessed write');
		assert.deepStrictEqual(calls[0], ['a', 'b'], 'first call writes both items');
		assert.deepStrictEqual(calls[1], ['b'], 'retry writes only the unprocessed item');
	});

	test('throws BatchIncomplete when writes never complete after exhausting retries', async () => {
		let callCount = 0;
		const table = awsTableWithFakeClient('put-retry-2', options, async command => {
			callCount++;
			const tableName = Object.keys(command.input.RequestItems)[0];
			const requests: any[] = command.input.RequestItems[tableName];
			// Always report every write as unprocessed — never makes progress.
			return { UnprocessedItems: { [tableName]: requests } };
		});

		await assert.rejects(
			() => table.putBatch([{ id: 'a', value: 1 }]),
			(err: any) => {
				assert.strictEqual(err.name, DistributedTableErrors.BatchIncomplete);
				assert.match(err.message, /putBatch/);
				return true;
			},
		);
		assert.ok(callCount > 1 && callCount <= 5, `should retry but cap attempts, got ${callCount}`);
	});
});

describe('AWS deleteBatch retries UnprocessedItems returned by BatchWriteItem', () => {
	const schema = z.object({ id: z.string(), value: z.number() });
	const options = { schema, key: { partitionKey: 'id' } };

	test('resubmits only the unprocessed delete requests on the next attempt', async () => {
		const calls: any[][] = [];
		const table = awsTableWithFakeClient('delete-retry-1', options, async command => {
			const tableName = Object.keys(command.input.RequestItems)[0];
			const requests: any[] = command.input.RequestItems[tableName];
			calls.push(requests.map(r => r.DeleteRequest.Key.id));

			if (calls.length === 1) {
				return { UnprocessedItems: { [tableName]: [requests[0]] } };
			}
			return {};
		});

		await table.deleteBatch([{ id: 'a' }, { id: 'b' }]);

		assert.strictEqual(calls.length, 2, 'should retry the unprocessed delete');
		assert.deepStrictEqual(calls[0], ['a', 'b'], 'first call deletes both keys');
		assert.deepStrictEqual(calls[1], ['a'], 'retry deletes only the unprocessed key');
	});

	test('throws BatchIncomplete when deletes never complete after exhausting retries', async () => {
		let callCount = 0;
		const table = awsTableWithFakeClient('delete-retry-2', options, async command => {
			callCount++;
			const tableName = Object.keys(command.input.RequestItems)[0];
			const requests: any[] = command.input.RequestItems[tableName];
			// Always report every delete as unprocessed — never makes progress.
			return { UnprocessedItems: { [tableName]: requests } };
		});

		await assert.rejects(
			() => table.deleteBatch([{ id: 'a' }]),
			(err: any) => {
				assert.strictEqual(err.name, DistributedTableErrors.BatchIncomplete);
				assert.match(err.message, /deleteBatch/);
				return true;
			},
		);
		assert.ok(callCount > 1 && callCount <= 5, `should retry but cap attempts, got ${callCount}`);
	});
});

describe('query rejects multiple sort key conditions (DynamoDB allows only one per KeyConditionExpression)', () => {
	const schema = z.object({ pk: z.string(), sk: z.number(), data: z.string() });

	test('greaterThan + lessThan is rejected with guidance to use between', async () => {
		const table = new DistributedTable(testScope(), 'multi-sk-1', {
			schema,
			key: { partitionKey: 'pk', sortKey: 'sk' },
		});

		await table.put({ pk: 'a', sk: 100, data: '1' });
		await table.put({ pk: 'a', sk: 200, data: '2' });
		await table.put({ pk: 'a', sk: 300, data: '3' });
		await table.put({ pk: 'a', sk: 400, data: '4' });

		try {
			const items = await collect(table.query({
				where: { pk: { equals: 'a' }, sk: { greaterThan: 100, lessThan: 400 } as any },
			}));
			assert.fail(
				`Multiple sort key conditions must be rejected. Got ${items.length} items. ` +
				'DynamoDB only allows one sort key condition per query.',
			);
		} catch (err: any) {
			if (err.code === 'ERR_ASSERTION') throw err;
			assert.match(err.message, /only one sort key condition/i);
		}
	});

	test('between works correctly as the intended alternative for ranges', async () => {
		const table = new DistributedTable(testScope(), 'multi-sk-2', {
			schema,
			key: { partitionKey: 'pk', sortKey: 'sk' },
		});

		await table.put({ pk: 'a', sk: 100, data: '1' });
		await table.put({ pk: 'a', sk: 200, data: '2' });
		await table.put({ pk: 'a', sk: 300, data: '3' });

		const items = await collect(table.query({
			where: { pk: { equals: 'a' }, sk: { between: [100, 300] } },
		}));
		assert.strictEqual(items.length, 3);
	});

	test('greaterThanOrEqual + lessThanOrEqual is rejected', async () => {
		const table = new DistributedTable(testScope(), 'multi-sk-3', {
			schema,
			key: { partitionKey: 'pk', sortKey: 'sk' },
		});

		await table.put({ pk: 'a', sk: 100, data: '1' });
		await table.put({ pk: 'a', sk: 200, data: '2' });

		try {
			const items = await collect(table.query({
				where: { pk: { equals: 'a' }, sk: { greaterThanOrEqual: 100, lessThanOrEqual: 200 } as any },
			}));
			assert.fail(`Multiple sort key conditions must be rejected. Got ${items.length} items.`);
		} catch (err: any) {
			if (err.code === 'ERR_ASSERTION') throw err;
			assert.match(err.message, /only one sort key condition/i);
		}
	});

	test('rejected on an empty table — before any data is scanned (mock/AWS parity)', async () => {
		// Regression: the mock used to validate inside the per-item filter, so an
		// empty table or a no-match partition returned [] instead of throwing,
		// diverging from the AWS runtime which rejects eagerly.
		const table = new DistributedTable(testScope(), 'multi-sk-empty', {
			schema,
			key: { partitionKey: 'pk', sortKey: 'sk' },
		});

		await assert.rejects(
			() => collect(table.query({
				where: { pk: { equals: 'missing' }, sk: { greaterThan: 100, lessThan: 400 } as any },
			})),
			(err: any) => {
				assert.strictEqual(err.name, DistributedTableErrors.InvalidQuery);
				assert.match(err.message, /only one sort key condition/i);
				return true;
			},
		);
	});
});

describe('query treats a present-but-empty sort condition as no filter (mock/AWS parity)', () => {
	// Regression (R1): `{ sk: {} }` type-checks because every SortKeyCondition field
	// is optional. The mock's per-item matcher accepted everything (returned the whole
	// partition) while the AWS runtime registered `#sk` in ExpressionAttributeNames with
	// no clause using it, which DynamoDB rejects with ValidationException. Both layers now
	// normalize an empty condition to "no sort-key filter" and return the whole partition.
	const schema = z.object({ pk: z.string(), sk: z.number(), data: z.string() });

	test('mock: empty sort condition returns the whole partition instead of throwing', async () => {
		const table = new DistributedTable(testScope(), 'empty-sk-mock', {
			schema,
			key: { partitionKey: 'pk', sortKey: 'sk' },
		});

		await table.put({ pk: 'a', sk: 100, data: '1' });
		await table.put({ pk: 'a', sk: 200, data: '2' });
		await table.put({ pk: 'b', sk: 300, data: '3' });

		const items = await collect(table.query({
			where: { pk: { equals: 'a' }, sk: {} as any },
		}));
		assert.strictEqual(items.length, 2, 'should return all items in partition "a"');
	});

	test('mock: all-undefined sort condition behaves the same as an empty one', async () => {
		const table = new DistributedTable(testScope(), 'empty-sk-mock-undef', {
			schema,
			key: { partitionKey: 'pk', sortKey: 'sk' },
		});

		await table.put({ pk: 'a', sk: 100, data: '1' });
		await table.put({ pk: 'a', sk: 200, data: '2' });

		const items = await collect(table.query({
			where: { pk: { equals: 'a' }, sk: { greaterThan: undefined } as any },
		}));
		assert.strictEqual(items.length, 2);
	});

	test('AWS: empty sort condition issues a PK-only KeyConditionExpression with no #sk name', async () => {
		let captured: any;
		const table = awsTableWithFakeClient('empty-sk-aws', { schema, key: { partitionKey: 'pk', sortKey: 'sk' } }, async command => {
			captured = command.input;
			return { Items: [{ pk: 'a', sk: 100, data: '1' }] };
		});

		const items = await collect(table.query({
			where: { pk: { equals: 'a' }, sk: {} as any },
		}));

		assert.deepStrictEqual(items, [{ pk: 'a', sk: 100, data: '1' }]);
		assert.strictEqual(captured.KeyConditionExpression, '#pk = :pkval',
			'empty sort condition must not add a sort-key clause');
		assert.ok(!('#sk' in captured.ExpressionAttributeNames),
			'must not register an unused #sk name (DynamoDB rejects that with ValidationException)');
	});
});

describe('ifFieldEquals({}) is rejected for mock/AWS parity (empty ConditionExpression is invalid on DynamoDB)', () => {
	const schema = z.object({ id: z.string(), name: z.string(), version: z.number() });

	test('put with ifFieldEquals({}) throws validation error', async () => {
		const table = new DistributedTable(testScope(), 'empty-cond-1', {
			schema,
			key: { partitionKey: 'id' },
		});

		await table.put({ id: '1', name: 'test', version: 1 });

		await assert.rejects(
			() => table.put({ id: '1', name: 'updated', version: 2 }, { ifFieldEquals: {} as any }),
			(err: any) => {
				assert.strictEqual(err.name, DistributedTableErrors.InvalidQuery,
					`Expected ${DistributedTableErrors.InvalidQuery}, got ${err.name}`);
				return true;
			},
		);
	});

	test('delete with ifFieldEquals({}) throws validation error', async () => {
		const table = new DistributedTable(testScope(), 'empty-cond-2', {
			schema,
			key: { partitionKey: 'id' },
		});

		await table.put({ id: '1', name: 'test', version: 1 });

		await assert.rejects(
			() => table.delete({ id: '1' }, { ifFieldEquals: {} as any }),
			(err: any) => {
				assert.strictEqual(err.name, DistributedTableErrors.InvalidQuery,
					`Expected ${DistributedTableErrors.InvalidQuery}, got ${err.name}`);
				return true;
			},
		);
	});
});

describe('AWS ifFieldEquals rejects empty/all-undefined conditions before issuing a DynamoDB call (mock/AWS parity, R4)', () => {
	// The AWS applyFieldEqualsCondition guard mirrors the mock's checkFieldEquals:
	// an empty (or all-undefined) ifFieldEquals would otherwise produce an empty
	// ConditionExpression, which DynamoDB rejects with ValidationException. These
	// tests make that parity two-sided — the mock equivalents live above.
	const schema = z.object({ id: z.string(), name: z.string(), version: z.number() });
	const options = { schema, key: { partitionKey: 'id' } };

	test('put with ifFieldEquals({}) throws Validation and never sends a command', async () => {
		let sendCount = 0;
		const table = awsTableWithFakeClient('aws-empty-cond-put', options, async () => {
			sendCount++;
			return {};
		});

		await assert.rejects(
			() => table.put({ id: '1', name: 'updated', version: 2 }, { ifFieldEquals: {} as any }),
			(err: any) => {
				assert.strictEqual(err.name, DistributedTableErrors.InvalidQuery,
					`Expected ${DistributedTableErrors.InvalidQuery}, got ${err.name}`);
				return true;
			},
		);
		assert.strictEqual(sendCount, 0, 'must reject before sending any PutCommand to DynamoDB');
	});

	test('delete with ifFieldEquals({}) throws Validation and never sends a command', async () => {
		let sendCount = 0;
		const table = awsTableWithFakeClient('aws-empty-cond-delete', options, async () => {
			sendCount++;
			return {};
		});

		await assert.rejects(
			() => table.delete({ id: '1' }, { ifFieldEquals: {} as any }),
			(err: any) => {
				assert.strictEqual(err.name, DistributedTableErrors.InvalidQuery,
					`Expected ${DistributedTableErrors.InvalidQuery}, got ${err.name}`);
				return true;
			},
		);
		assert.strictEqual(sendCount, 0, 'must reject before sending any DeleteCommand to DynamoDB');
	});

	test('put with all-undefined ifFieldEquals is treated as empty and rejected', async () => {
		let sendCount = 0;
		const table = awsTableWithFakeClient('aws-undef-cond-put', options, async () => {
			sendCount++;
			return {};
		});

		await assert.rejects(
			() => table.put(
				{ id: '1', name: 'updated', version: 2 },
				{ ifFieldEquals: { name: undefined } as any },
			),
			(err: any) => {
				assert.strictEqual(err.name, DistributedTableErrors.InvalidQuery,
					`Expected ${DistributedTableErrors.InvalidQuery}, got ${err.name}`);
				return true;
			},
		);
		assert.strictEqual(sendCount, 0, 'must reject before sending any PutCommand to DynamoDB');
	});

	test('put with a mix of defined and undefined fields sends only the defined condition', async () => {
		let captured: any;
		const table = awsTableWithFakeClient('aws-mixed-cond-put', options, async command => {
			captured = command.input;
			return {};
		});

		await table.put(
			{ id: '1', name: 'updated', version: 2 },
			{ ifFieldEquals: { name: 'test', version: undefined } as any },
		);

		assert.strictEqual(captured.ConditionExpression, '#field0 = :val0',
			'undefined fields must be filtered out of the ConditionExpression');
		assert.deepStrictEqual(captured.ExpressionAttributeNames, { '#field0': 'name' });
		assert.deepStrictEqual(captured.ExpressionAttributeValues, { ':val0': 'test' });
	});
});

describe('ifFieldEquals filters out undefined field values to match the AWS SDK behavior', () => {
	const schema = z.object({ id: z.string(), name: z.string(), version: z.number() });

	test('all-undefined fields is treated as empty and rejected', async () => {
		const table = new DistributedTable(testScope(), 'undef-field-1', {
			schema,
			key: { partitionKey: 'id' },
		});

		await table.put({ id: '1', name: 'test', version: 1 });

		await assert.rejects(
			() => table.put(
				{ id: '1', name: 'updated', version: 2 },
				{ ifFieldEquals: { name: undefined } as any },
			),
			(err: any) => {
				assert.strictEqual(err.name, DistributedTableErrors.InvalidQuery,
					`Expected ${DistributedTableErrors.InvalidQuery}, got ${err.name}`);
				return true;
			},
		);
	});

	test('delete with all-undefined ifFieldEquals is rejected', async () => {
		const table = new DistributedTable(testScope(), 'undef-field-2', {
			schema,
			key: { partitionKey: 'id' },
		});

		await table.put({ id: '1', name: 'test', version: 1 });

		await assert.rejects(
			() => table.delete({ id: '1' }, { ifFieldEquals: { version: undefined } as any }),
			(err: any) => {
				assert.strictEqual(err.name, DistributedTableErrors.InvalidQuery,
					`Expected ${DistributedTableErrors.InvalidQuery}, got ${err.name}`);
				return true;
			},
		);
	});

	test('mix of valid and undefined values uses only the valid fields', async () => {
		const table = new DistributedTable(testScope(), 'undef-field-3', {
			schema,
			key: { partitionKey: 'id' },
		});

		await table.put({ id: '1', name: 'test', version: 1 });

		// { name: 'test', version: undefined } checks only 'name'
		await table.put(
			{ id: '1', name: 'updated', version: 2 },
			{ ifFieldEquals: { name: 'test', version: undefined } as any },
		);
		const item = await table.get({ id: '1' });
		assert.strictEqual(item?.name, 'updated',
			'Undefined fields should be filtered out; defined fields should be checked');
	});
});

describe('ifFieldEquals uses deep equality for objects and arrays (matching DynamoDB marshalled-value comparison)', () => {
	test('array with same contents but different reference passes', async () => {
		const schema = z.object({ id: z.string(), tags: z.array(z.string()) });
		const table = new DistributedTable(testScope(), 'deep-eq-1', {
			schema,
			key: { partitionKey: 'id' },
		});

		await table.put({ id: '1', tags: ['a', 'b', 'c'] });

		await table.put(
			{ id: '1', tags: ['a', 'b', 'c', 'd'] },
			{ ifFieldEquals: { tags: ['a', 'b', 'c'] } },
		);

		const item = await table.get({ id: '1' });
		assert.deepStrictEqual(item?.tags, ['a', 'b', 'c', 'd']);
	});

	test('nested object with same contents but different reference passes', async () => {
		const schema = z.object({ id: z.string(), meta: z.object({ role: z.string(), level: z.number() }) });
		const table = new DistributedTable(testScope(), 'deep-eq-2', {
			schema,
			key: { partitionKey: 'id' },
		});

		await table.put({ id: '1', meta: { role: 'admin', level: 5 } });

		await table.put(
			{ id: '1', meta: { role: 'admin', level: 10 } },
			{ ifFieldEquals: { meta: { role: 'admin', level: 5 } } },
		);

		const item = await table.get({ id: '1' });
		assert.strictEqual(item?.meta.level, 10);
	});

	test('object with same contents but different key order passes (DynamoDB Maps are unordered)', async () => {
		// Regression: a JSON.stringify compare is key-order sensitive, so
		// { role, level } stored vs { level, role } supplied would wrongly fail.
		// DynamoDB Maps are an unordered collection of name-value pairs, so the
		// same condition is expected to pass on the AWS runtime.
		const schema = z.object({ id: z.string(), meta: z.object({ role: z.string(), level: z.number() }) });
		const table = new DistributedTable(testScope(), 'deep-eq-keyorder', {
			schema,
			key: { partitionKey: 'id' },
		});

		await table.put({ id: '1', meta: { role: 'admin', level: 5 } });

		await table.put(
			{ id: '1', meta: { role: 'admin', level: 10 } },
			{ ifFieldEquals: { meta: { level: 5, role: 'admin' } as any } },
		);

		const item = await table.get({ id: '1' });
		assert.strictEqual(item?.meta.level, 10,
			'key order must not affect ifFieldEquals matching');
	});

	test('array order is still significant (DynamoDB Lists are ordered)', async () => {
		const schema = z.object({ id: z.string(), tags: z.array(z.string()) });
		const table = new DistributedTable(testScope(), 'deep-eq-arrayorder', {
			schema,
			key: { partitionKey: 'id' },
		});

		await table.put({ id: '1', tags: ['a', 'b'] });

		await assert.rejects(
			() => table.put(
				{ id: '1', tags: ['x'] },
				{ ifFieldEquals: { tags: ['b', 'a'] } },
			),
			(err: any) => {
				assert.strictEqual(err.name, DistributedTableErrors.ConditionalCheckFailed);
				return true;
			},
		);
	});

	test('array with different contents correctly fails', async () => {
		const schema = z.object({ id: z.string(), tags: z.array(z.string()) });
		const table = new DistributedTable(testScope(), 'deep-eq-3', {
			schema,
			key: { partitionKey: 'id' },
		});

		await table.put({ id: '1', tags: ['a', 'b'] });

		await assert.rejects(
			() => table.put(
				{ id: '1', tags: ['x'] },
				{ ifFieldEquals: { tags: ['a', 'b', 'c'] } },
			),
			(err: any) => {
				assert.strictEqual(err.name, DistributedTableErrors.ConditionalCheckFailed);
				return true;
			},
		);
	});

	test('primitive comparison still works (regression guard)', async () => {
		const schema = z.object({ id: z.string(), version: z.number() });
		const table = new DistributedTable(testScope(), 'deep-eq-4', {
			schema,
			key: { partitionKey: 'id' },
		});

		await table.put({ id: '1', version: 1 });
		await table.put({ id: '1', version: 2 }, { ifFieldEquals: { version: 1 } });
		const item = await table.get({ id: '1' });
		assert.strictEqual(item?.version, 2);
	});
});

describe('AWS query rejects multiple sort key conditions before issuing a DynamoDB call', () => {
	const schema = z.object({ pk: z.string(), sk: z.number(), data: z.string() });
	const options = { schema, key: { partitionKey: 'pk', sortKey: 'sk' } };

	test('throws a validation error and never sends a QueryCommand', async () => {
		let sendCount = 0;
		const table = awsTableWithFakeClient('aws-multi-sk', options, async () => {
			sendCount++;
			return { Items: [] };
		});

		await assert.rejects(
			() => collect(table.query({
				where: { pk: { equals: 'a' }, sk: { greaterThan: 100, lessThan: 400 } as any },
			})),
			(err: any) => {
				assert.match(err.message, /only one sort key condition/i);
				return true;
			},
		);
		assert.strictEqual(sendCount, 0, 'must reject before sending any query to DynamoDB');
	});

	test('a single sort key condition is accepted and issues a QueryCommand', async () => {
		let sendCount = 0;
		const table = awsTableWithFakeClient('aws-single-sk', options, async () => {
			sendCount++;
			return { Items: [{ pk: 'a', sk: 150, data: 'x' }] };
		});

		const items = await collect(table.query({
			where: { pk: { equals: 'a' }, sk: { greaterThan: 100 } },
		}));

		assert.deepStrictEqual(items, [{ pk: 'a', sk: 150, data: 'x' }]);
		assert.strictEqual(sendCount, 1, 'a valid single-condition query should reach DynamoDB');
	});
});

describe('the 400 KB item-size overflow is a distinct ItemTooLarge error, not the generic InvalidQuery bucket', () => {
	// R2: the size overflow is a runtime data condition (the item may be too big for
	// reasons outside the caller's control), so it must be catchable separately from
	// query-shape bugs. The mock throws ItemTooLarge directly; the AWS runtime re-maps
	// DynamoDB's generic ValidationException for oversized items to the same name.
	const schema = z.object({ id: z.string(), blob: z.string() });

	test('mock: put rejects an oversized item with ItemTooLarge', async () => {
		const table = new DistributedTable(testScope(), 'too-large-put', {
			schema,
			key: { partitionKey: 'id' },
		});

		await assert.rejects(
			() => table.put({ id: '1', blob: 'x'.repeat(401 * 1024) }),
			(err: any) => {
				assert.ok(isBlocksError(err, DistributedTableErrors.ItemTooLarge));
				assert.strictEqual(err.name, 'ItemTooLargeException');
				assert.notStrictEqual(err.name, DistributedTableErrors.InvalidQuery,
					'oversized item must NOT collapse into the InvalidQuery bucket');
				assert.match(err.message, /size has exceeded/i);
				return true;
			},
		);
	});

	test('mock: putBatch rejects an oversized item with ItemTooLarge', async () => {
		const table = new DistributedTable(testScope(), 'too-large-putbatch', {
			schema,
			key: { partitionKey: 'id' },
		});

		await assert.rejects(
			() => table.putBatch([{ id: '1', blob: 'ok' }, { id: '2', blob: 'x'.repeat(401 * 1024) }]),
			(err: any) => {
				assert.ok(isBlocksError(err, DistributedTableErrors.ItemTooLarge));
				return true;
			},
		);
	});

	test('AWS: put re-maps DynamoDB\'s oversized ValidationException to ItemTooLarge', async () => {
		const original = new Error('Item size has exceeded the maximum allowed size');
		original.name = 'ValidationException';
		const table = awsTableWithFakeClient('aws-too-large-put', { schema, key: { partitionKey: 'id' } }, async () => {
			throw original;
		});

		await assert.rejects(
			() => table.put({ id: '1', blob: 'big' }),
			(err: any) => {
				assert.ok(isBlocksError(err, DistributedTableErrors.ItemTooLarge));
				assert.strictEqual(err.name, 'ItemTooLargeException');
				assert.strictEqual(err.cause, original,
					'the original DynamoDB error must be preserved as cause for server-side debugging');
				return true;
			},
		);
	});

	test('AWS: an unrelated ValidationException is NOT re-mapped to ItemTooLarge', async () => {
		const table = awsTableWithFakeClient('aws-other-validation', { schema, key: { partitionKey: 'id' } }, async () => {
			const err = new Error('ExpressionAttributeValues contains invalid value');
			err.name = 'ValidationException';
			throw err;
		});

		await assert.rejects(
			() => table.put({ id: '1', blob: 'ok' }),
			(err: any) => {
				assert.strictEqual(err.name, 'ValidationException',
					'non-size ValidationException must propagate unchanged');
				assert.ok(!isBlocksError(err, DistributedTableErrors.ItemTooLarge));
				return true;
			},
		);
	});
});

describe('DistributedTableErrors split the old single Validation bucket into intent-revealing names', () => {
	test('InvalidQuery and ItemTooLarge are distinct, non-generic names', () => {
		assert.strictEqual(DistributedTableErrors.InvalidQuery, 'InvalidQueryException');
		assert.strictEqual(DistributedTableErrors.ItemTooLarge, 'ItemTooLargeException');
		assert.notStrictEqual(DistributedTableErrors.InvalidQuery, DistributedTableErrors.ItemTooLarge);
		// The generic ValidationException bucket no longer exists on the public API.
		assert.strictEqual((DistributedTableErrors as any).Validation, undefined);
	});
});

describe('readValidation behaves identically on the mock and the AWS runtime', () => {
	// V2 schema adds `currency` with a default; a legacy row lacks it.
	const schemaV2 = z.object({ orderId: z.string(), total: z.number(), currency: z.string().default('USD') });
	const legacyRow = { orderId: 'o1', total: 10 };
	const coerced = { orderId: 'o1', total: 10, currency: 'USD' };

	test("mock get() coerces a stored legacy-shaped row under the default 'coerce'", async () => {
		// Write the legacy-shaped row directly into the store (bypassing put's
		// write validation) to simulate a row that predates the V2 schema, then
		// read it back through the V2 schema (readValidation defaults to 'coerce').
		const v2 = new DistributedTable(testScope(), 'orders', {
			schema: schemaV2, key: { partitionKey: 'orderId' },
		});
		(v2 as any).data.set((v2 as any).serializeKey({ orderId: 'o1' }), legacyRow);
		assert.deepStrictEqual(await v2.get({ orderId: 'o1' }), coerced);
	});

	test("AWS get() coerces the same legacy row identically under the default 'coerce'", async () => {
		const table = awsTableWithFakeClient('ovr-aws-1',
			{ schema: schemaV2, key: { partitionKey: 'orderId' } },
			async () => ({ Item: legacyRow }),
		);
		assert.deepStrictEqual(await table.get({ orderId: 'o1' }), coerced);
	});

	test("AWS get() with readValidation 'off' returns the raw legacy row unchanged", async () => {
		const table = awsTableWithFakeClient('ovr-aws-2',
			{ schema: schemaV2, key: { partitionKey: 'orderId' }, readValidation: 'off' },
			async () => ({ Item: legacyRow }),
		);
		assert.deepStrictEqual(await table.get({ orderId: 'o1' }), legacyRow);
	});

	test("AWS get() 'coerce' returns an uncoercible row RAW and never throws", async () => {
		const strict = z.object({ orderId: z.string(), total: z.number() });
		const bad = { orderId: 'x', total: 'not-a-number' };
		const table = awsTableWithFakeClient('ovr-aws-3',
			{ schema: strict, key: { partitionKey: 'orderId' }, readValidation: 'coerce' },
			async () => ({ Item: bad }),
		);
		assert.deepStrictEqual(await table.get({ orderId: 'x' }), bad);
	});

	test("AWS get() 'strict' throws ValidationFailed on the same uncoercible row (mock parity)", async () => {
		const strict = z.object({ orderId: z.string(), total: z.number() });
		const bad = { orderId: 'x', total: 'not-a-number' };
		const table = awsTableWithFakeClient('ovr-aws-4',
			{ schema: strict, key: { partitionKey: 'orderId' }, readValidation: 'strict' },
			async () => ({ Item: bad }),
		);
		await assert.rejects(
			() => table.get({ orderId: 'x' }),
			(err: any) => err.name === 'ValidationFailedException',
		);
	});
});
