// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { describe, it } from 'node:test';

import type { DiscoveredBlock, ResourceGroup, ResourceInfo } from '../contract/v1.js';
import {
	type CloudWriteContext,
	type DeleteItemParams,
	type PutItemParams,
	type SetUserEnabledParams,
	deleteCloudRecord,
	putCloudRecord,
	setCognitoUserEnabled,
} from './cloud-writes.js';

/** No test in this file may reach AWS: every seam is always injected. */

function makeBlock(overrides: Partial<DiscoveredBlock> = {}): DiscoveredBlock {
	return {
		type: 'DistributedTable',
		id: 'todos',
		fullId: 'my-app-todos',
		category: 'data',
		file: 'aws-blocks/app.ts',
		line: 12,
		...overrides,
	};
}

function tableResource(physicalResourceId: string, logicalResourceId = 'TableABC123'): ResourceInfo {
	return { logicalResourceId, resourceType: 'AWS::DynamoDB::Table', physicalResourceId };
}

function poolResource(physicalResourceId: string, logicalResourceId = 'UserPoolDEF456'): ResourceInfo {
	return { logicalResourceId, resourceType: 'AWS::Cognito::UserPool', physicalResourceId };
}

function appGroup(blockFullId: string, resources: ResourceInfo[], id = `my-app/${blockFullId}`): ResourceGroup {
	return { id, category: 'app', resources, blockFullId };
}

interface DescribeSeam {
	describeTable: (tableName: string, region?: string) => Promise<string[]>;
	calls: Array<{ tableName: string; region?: string }>;
}

/** A `DescribeTable` seam serving fixed key fields and recording every call. */
function recordingDescribe(keyFields: string[], error?: unknown): DescribeSeam {
	const calls: Array<{ tableName: string; region?: string }> = [];
	return {
		calls,
		describeTable: async (tableName, region) => {
			calls.push({ tableName, ...(region === undefined ? {} : { region }) });
			if (error !== undefined) throw error;
			return keyFields;
		},
	};
}

function recordingPut(error?: unknown): { putItem: (params: PutItemParams) => Promise<void>; calls: PutItemParams[] } {
	const calls: PutItemParams[] = [];
	return {
		calls,
		putItem: async (params) => {
			calls.push(params);
			if (error !== undefined) throw error;
		},
	};
}

function recordingDelete(error?: unknown): {
	deleteItem: (params: DeleteItemParams) => Promise<void>;
	calls: DeleteItemParams[];
} {
	const calls: DeleteItemParams[] = [];
	return {
		calls,
		deleteItem: async (params) => {
			calls.push(params);
			if (error !== undefined) throw error;
		},
	};
}

function recordingSetEnabled(error?: unknown): {
	setUserEnabled: (params: SetUserEnabledParams) => Promise<void>;
	calls: SetUserEnabledParams[];
} {
	const calls: SetUserEnabledParams[] = [];
	return {
		calls,
		setUserEnabled: async (params) => {
			calls.push(params);
			if (error !== undefined) throw error;
		},
	};
}

function named(name: string, message: string): Error {
	const error = new Error(message);
	error.name = name;
	return error;
}

/** Raw SDK text of the shape that must NEVER reach a caller. */
const ACCOUNT_ID = '123456789012';
const TABLE_ARN = `arn:aws:dynamodb:us-east-1:${ACCOUNT_ID}:table/my-app-todos`;
const RAW_DENIED = `User: arn:aws:sts::${ACCOUNT_ID}:assumed-role/Dev/me is not authorized to perform: dynamodb:PutItem on resource: ${TABLE_ARN}`;
const RAW_VALIDATION = `One or more parameter values were invalid: Missing the key pk in the item (${TABLE_ARN})`;

const conditionalFailure = (): Error =>
	named('ConditionalCheckFailedException', `The conditional request failed (${TABLE_ARN})`);
const accessDenied = (): Error => named('AccessDeniedException', RAW_DENIED);
const expiredToken = (): Error =>
	named('ExpiredTokenException', `The security token included in the request is expired (${ACCOUNT_ID})`);
const missingCredentials = (): Error =>
	named('CredentialsProviderError', 'Could not load credentials from any providers');
const missingTable = (): Error => named('ResourceNotFoundException', `Requested resource not found: ${TABLE_ARN}`);
const rawValidation = (): Error => named('ValidationException', RAW_VALIDATION);

/** The testbed app's table: keyed userId/todoId, NOT pk/sk. */
const TODOS_TABLE = 'my-app-todos-table';
const todosGroups = [appGroup('my-app-todos', [tableResource(TODOS_TABLE)])];

function todosContext(overrides: Partial<CloudWriteContext> = {}): CloudWriteContext {
	return { block: makeBlock(), groups: todosGroups, ...overrides };
}

const validTodo = { userId: 'u1', todoId: 't9', title: 'Buy milk' };

describe('the key schema is read from DescribeTable on EVERY write path', () => {
	it('put takes its key fields from DescribeTable', async () => {
		const describeSeam = recordingDescribe(['userId', 'todoId']);
		const put = recordingPut();

		const result = await putCloudRecord(
			todosContext({ describeTable: describeSeam.describeTable, putItem: put.putItem }),
			validTodo,
			'create',
		);

		assert.equal(result.ok, true);
		assert.deepEqual(
			describeSeam.calls.map((call) => call.tableName),
			[TODOS_TABLE],
		);
		assert.deepEqual(put.calls[0]?.expressionAttributeNames, { '#k0': 'userId', '#k1': 'todoId' });
	});

	it('delete takes its key fields from DescribeTable too — the reference hardcoded pk/sk', async () => {
		const describeSeam = recordingDescribe(['userId', 'todoId']);
		const del = recordingDelete();

		const result = await deleteCloudRecord(
			todosContext({ describeTable: describeSeam.describeTable, deleteItem: del.deleteItem }),
			{ userId: 'u1', todoId: 't9' },
		);

		// THE REGRESSION: the delete path must consult DescribeTable at all.
		assert.deepEqual(
			describeSeam.calls.map((call) => call.tableName),
			[TODOS_TABLE],
		);
		assert.equal(result.ok, true);
		assert.deepEqual(del.calls[0]?.key, { userId: 'u1', todoId: 't9' });
		assert.deepEqual(del.calls[0]?.expressionAttributeNames, { '#k0': 'userId', '#k1': 'todoId' });
		// Guarded on the DESCRIBED partition key, never on a hardcoded `pk`.
		assert.equal(del.calls[0]?.conditionExpression, 'attribute_exists(#k0)');
	});

	it('deletes from a table keyed userId/todoId, the case that made the reference return a 500', async () => {
		const del = recordingDelete();

		const result = await deleteCloudRecord(
			todosContext({
				describeTable: recordingDescribe(['userId', 'todoId']).describeTable,
				deleteItem: del.deleteItem,
			}),
			{ userId: 'u1', todoId: 't9' },
		);

		assert.equal(result.ok, true);
		assert.equal(result.errorCode, undefined);
		assert.equal(result.refusalCode, undefined);
		assert.match(result.message, /Deleted the record/);
		assert.ok(!('pk' in (del.calls[0]?.key ?? {})), 'no hardcoded pk may appear in the delete key');
	});

	it('reads the key schema in HASH-before-RANGE order as DescribeTable reports it', async () => {
		const del = recordingDelete();

		await deleteCloudRecord(
			todosContext({
				describeTable: recordingDescribe(['tenant', 'sortId']).describeTable,
				deleteItem: del.deleteItem,
			}),
			{ tenant: 'acme', sortId: '42' },
		);

		assert.deepEqual(Object.keys(del.calls[0]?.key ?? {}), ['tenant', 'sortId']);
	});

	it('passes the region through to DescribeTable and to the write', async () => {
		const describeSeam = recordingDescribe(['userId', 'todoId']);
		const put = recordingPut();

		await putCloudRecord(
			todosContext({ describeTable: describeSeam.describeTable, putItem: put.putItem, region: 'eu-west-1' }),
			validTodo,
			'create',
		);

		assert.equal(describeSeam.calls[0]?.region, 'eu-west-1');
		assert.equal(put.calls[0]?.region, 'eu-west-1');
	});

	it('writes to the requested store when the block owns several tables', async () => {
		const groups = [appGroup('my-app-todos', [tableResource('table-a'), tableResource('table-b', 'TableB')])];
		const put = recordingPut();

		await putCloudRecord(
			{
				block: makeBlock(),
				groups,
				store: 'table-b',
				describeTable: recordingDescribe(['userId', 'todoId']).describeTable,
				putItem: put.putItem,
			},
			validTodo,
			'create',
		);

		assert.equal(put.calls[0]?.tableName, 'table-b');
	});

	it('reports STORE_NOT_FOUND when no table is attributed to the block', async () => {
		const put = recordingPut();
		const result = await putCloudRecord(
			{
				block: makeBlock(),
				groups: [],
				describeTable: recordingDescribe(['pk']).describeTable,
				putItem: put.putItem,
			},
			validTodo,
			'create',
		);

		assert.equal(result.ok, false);
		assert.equal(result.errorCode, 'STORE_NOT_FOUND');
		assert.equal(put.calls.length, 0);
	});

	it('reports STORE_NOT_FOUND when the requested store is not a table of this block', async () => {
		const result = await deleteCloudRecord(
			todosContext({ store: 'someone-elses-table', describeTable: recordingDescribe(['userId']).describeTable }),
			{ userId: 'u1' },
		);

		assert.equal(result.ok, false);
		assert.equal(result.errorCode, 'STORE_NOT_FOUND');
	});

	it('reports STORE_NOT_FOUND when the table reports no key schema at all', async () => {
		const result = await putCloudRecord(
			todosContext({ describeTable: recordingDescribe([]).describeTable, putItem: recordingPut().putItem }),
			validTodo,
			'create',
		);

		assert.equal(result.ok, false);
		assert.equal(result.errorCode, 'STORE_NOT_FOUND');
	});

	it('classifies a DescribeTable failure instead of surfacing it', async () => {
		const result = await deleteCloudRecord(
			todosContext({ describeTable: recordingDescribe([], accessDenied()).describeTable }),
			{ userId: 'u1' },
		);

		assert.equal(result.ok, false);
		assert.equal(result.errorCode, 'ACCESS_DENIED');
		assert.ok(!result.message.includes(ACCOUNT_ID));
	});
});

describe('putCloudRecord — condition expressions', () => {
	it('guards create with attribute_not_exists over every key field', async () => {
		const put = recordingPut();

		await putCloudRecord(
			todosContext({
				describeTable: recordingDescribe(['userId', 'todoId']).describeTable,
				putItem: put.putItem,
			}),
			validTodo,
			'create',
		);

		assert.equal(put.calls[0]?.conditionExpression, 'attribute_not_exists(#k0) AND attribute_not_exists(#k1)');
	});

	it('guards edit with attribute_exists over every key field', async () => {
		const put = recordingPut();

		await putCloudRecord(
			todosContext({
				describeTable: recordingDescribe(['userId', 'todoId']).describeTable,
				putItem: put.putItem,
			}),
			validTodo,
			'edit',
		);

		assert.equal(put.calls[0]?.conditionExpression, 'attribute_exists(#k0) AND attribute_exists(#k1)');
	});

	it('builds a single-clause condition for a table with only a partition key', async () => {
		const put = recordingPut();

		await putCloudRecord(
			todosContext({ describeTable: recordingDescribe(['userId']).describeTable, putItem: put.putItem }),
			{ userId: 'u1', title: 'solo' },
			'create',
		);

		assert.equal(put.calls[0]?.conditionExpression, 'attribute_not_exists(#k0)');
		assert.deepEqual(put.calls[0]?.expressionAttributeNames, { '#k0': 'userId' });
	});

	it('routes key names through ExpressionAttributeNames so a reserved word is safe', async () => {
		const put = recordingPut();

		await putCloudRecord(
			todosContext({ describeTable: recordingDescribe(['status', 'size']).describeTable, putItem: put.putItem }),
			{ status: 'open', size: 'large' },
			'edit',
		);

		assert.equal(put.calls[0]?.conditionExpression, 'attribute_exists(#k0) AND attribute_exists(#k1)');
		assert.deepEqual(put.calls[0]?.expressionAttributeNames, { '#k0': 'status', '#k1': 'size' });
		assert.ok(!(put.calls[0]?.conditionExpression ?? '').includes('status'));
	});

	it('passes the item through unchanged for the document client to marshal', async () => {
		const put = recordingPut();
		const item = { userId: 'u1', todoId: 't9', done: false, order: 3 };

		await putCloudRecord(
			todosContext({
				describeTable: recordingDescribe(['userId', 'todoId']).describeTable,
				putItem: put.putItem,
			}),
			item,
			'create',
		);

		assert.deepEqual(put.calls[0]?.item, item);
	});
});

describe('putCloudRecord — a refused precondition is a refusal, not an error', () => {
	it('maps ConditionalCheckFailedException on create to ALREADY_EXISTS suggesting edit', async () => {
		const result = await putCloudRecord(
			todosContext({
				describeTable: recordingDescribe(['userId', 'todoId']).describeTable,
				putItem: recordingPut(conditionalFailure()).putItem,
			}),
			validTodo,
			'create',
		);

		assert.equal(result.ok, false);
		assert.equal(result.refusalCode, 'ALREADY_EXISTS');
		assert.equal(result.errorCode, undefined, 'a refusal must not also be classified as an error');
		assert.match(result.message, /already exists/i);
		assert.match(result.message, /edit/i);
	});

	it('maps ConditionalCheckFailedException on edit to NOT_FOUND suggesting create', async () => {
		const result = await putCloudRecord(
			todosContext({
				describeTable: recordingDescribe(['userId', 'todoId']).describeTable,
				putItem: recordingPut(conditionalFailure()).putItem,
			}),
			validTodo,
			'edit',
		);

		assert.equal(result.ok, false);
		assert.equal(result.refusalCode, 'NOT_FOUND');
		assert.equal(result.errorCode, undefined);
		assert.match(result.message, /no record with this key/i);
		assert.match(result.message, /create/i);
	});

	it('returns VALIDATION_FAILED rather than throwing when a key field is missing', async () => {
		const put = recordingPut();

		const result = await putCloudRecord(
			todosContext({
				describeTable: recordingDescribe(['userId', 'todoId']).describeTable,
				putItem: put.putItem,
			}),
			{ userId: 'u1', title: 'no todoId here' },
			'create',
		);

		assert.equal(result.ok, false);
		assert.equal(result.refusalCode, 'VALIDATION_FAILED');
		assert.ok(result.message.length > 0);
		assert.equal(put.calls.length, 0, 'an invalid record must never reach DynamoDB');
	});

	it('returns VALIDATION_FAILED rather than throwing when the record is not an object', async () => {
		const put = recordingPut();

		const result = await putCloudRecord(
			todosContext({
				describeTable: recordingDescribe(['userId', 'todoId']).describeTable,
				putItem: put.putItem,
			}),
			'not an object',
			'create',
		);

		assert.equal(result.ok, false);
		assert.equal(result.refusalCode, 'VALIDATION_FAILED');
		assert.equal(put.calls.length, 0);
	});

	it('validates against the key fields the TABLE declares, not the ones the item happens to carry', async () => {
		const put = recordingPut();

		const result = await putCloudRecord(
			todosContext({ describeTable: recordingDescribe(['tenant']).describeTable, putItem: put.putItem }),
			validTodo,
			'create',
		);

		assert.equal(result.refusalCode, 'VALIDATION_FAILED');
		assert.equal(put.calls.length, 0);
	});
});

describe('deleteCloudRecord', () => {
	it('returns VALIDATION_FAILED naming the missing key field', async () => {
		const del = recordingDelete();

		const result = await deleteCloudRecord(
			todosContext({
				describeTable: recordingDescribe(['userId', 'todoId']).describeTable,
				deleteItem: del.deleteItem,
			}),
			{ userId: 'u1' },
		);

		assert.equal(result.ok, false);
		assert.equal(result.refusalCode, 'VALIDATION_FAILED');
		assert.match(result.message, /todoId/);
		assert.equal(del.calls.length, 0);
	});

	it('returns VALIDATION_FAILED when a key value is not a string', async () => {
		const del = recordingDelete();

		const result = await deleteCloudRecord(
			todosContext({
				describeTable: recordingDescribe(['userId', 'todoId']).describeTable,
				deleteItem: del.deleteItem,
			}),
			{ userId: 'u1', todoId: 7 } as unknown as Record<string, string>,
		);

		assert.equal(result.refusalCode, 'VALIDATION_FAILED');
		assert.equal(del.calls.length, 0);
	});

	it('returns VALIDATION_FAILED for an empty key value rather than letting DynamoDB reject it', async () => {
		const result = await deleteCloudRecord(
			todosContext({
				describeTable: recordingDescribe(['userId', 'todoId']).describeTable,
				deleteItem: recordingDelete().deleteItem,
			}),
			{ userId: 'u1', todoId: '' },
		);

		assert.equal(result.refusalCode, 'VALIDATION_FAILED');
	});

	it('reports NOT_FOUND when the record is already gone, instead of a silent success', async () => {
		const result = await deleteCloudRecord(
			todosContext({
				describeTable: recordingDescribe(['userId', 'todoId']).describeTable,
				deleteItem: recordingDelete(conditionalFailure()).deleteItem,
			}),
			{ userId: 'u1', todoId: 't9' },
		);

		assert.equal(result.ok, false);
		assert.equal(result.refusalCode, 'NOT_FOUND');
		assert.equal(result.errorCode, undefined);
	});

	it('sends only the key fields, dropping any other values the caller passed', async () => {
		const del = recordingDelete();

		await deleteCloudRecord(
			todosContext({
				describeTable: recordingDescribe(['userId', 'todoId']).describeTable,
				deleteItem: del.deleteItem,
			}),
			{ userId: 'u1', todoId: 't9', title: 'not a key' },
		);

		assert.deepEqual(del.calls[0]?.key, { userId: 'u1', todoId: 't9' });
	});
});

describe('AWS failures are classified, never surfaced', () => {
	it('distinguishes ACCESS_DENIED from CREDENTIALS_EXPIRED', async () => {
		const context = (error: unknown): CloudWriteContext =>
			todosContext({
				describeTable: recordingDescribe(['userId', 'todoId']).describeTable,
				putItem: recordingPut(error).putItem,
			});

		const denied = await putCloudRecord(context(accessDenied()), validTodo, 'create');
		const expired = await putCloudRecord(context(expiredToken()), validTodo, 'create');

		assert.equal(denied.errorCode, 'ACCESS_DENIED');
		assert.equal(expired.errorCode, 'CREDENTIALS_EXPIRED');
		assert.notEqual(denied.message, expired.message);
		assert.match(denied.message, /Access denied/i);
		assert.match(expired.message, /expired/i);
	});

	it('classifies absent credentials as CREDENTIALS_MISSING', async () => {
		const result = await putCloudRecord(
			todosContext({
				describeTable: recordingDescribe(['userId', 'todoId']).describeTable,
				putItem: recordingPut(missingCredentials()).putItem,
			}),
			validTodo,
			'create',
		);

		assert.equal(result.errorCode, 'CREDENTIALS_MISSING');
	});

	it('classifies a deleted table as STORE_NOT_FOUND on the delete path', async () => {
		const result = await deleteCloudRecord(
			todosContext({
				describeTable: recordingDescribe(['userId', 'todoId']).describeTable,
				deleteItem: recordingDelete(missingTable()).deleteItem,
			}),
			{ userId: 'u1', todoId: 't9' },
		);

		assert.equal(result.errorCode, 'STORE_NOT_FOUND');
	});

	it('falls back to UNKNOWN for an unrecognised failure, keeping its text out of the message', async () => {
		const result = await putCloudRecord(
			todosContext({
				describeTable: recordingDescribe(['userId', 'todoId']).describeTable,
				putItem: recordingPut(rawValidation()).putItem,
			}),
			validTodo,
			'create',
		);

		assert.equal(result.errorCode, 'UNKNOWN');
		assert.ok(!result.message.includes(RAW_VALIDATION));
	});

	it('never rejects, even when a seam throws something that is not an Error', async () => {
		const result = await putCloudRecord(
			todosContext({
				describeTable: recordingDescribe(['userId', 'todoId']).describeTable,
				putItem: recordingPut('a bare string').putItem,
			}),
			validTodo,
			'create',
		);

		assert.equal(result.ok, false);
		assert.equal(result.errorCode, 'UNKNOWN');
	});
});

describe('setCognitoUserEnabled', () => {
	const authGroups = [appGroup('my-app-auth', [poolResource('eu-west-1_ABC123')])];
	const authBlock = makeBlock({ type: 'AuthBasic', id: 'auth', fullId: 'my-app-auth', category: 'auth' });

	function authContext(overrides: Partial<CloudWriteContext> = {}): CloudWriteContext {
		return { block: authBlock, groups: authGroups, ...overrides };
	}

	it('enables a user against the resolved user pool', async () => {
		const seam = recordingSetEnabled();

		const result = await setCognitoUserEnabled(authContext({ setUserEnabled: seam.setUserEnabled }), 'ada', true);

		assert.equal(result.ok, true);
		assert.deepEqual(seam.calls, [{ userPoolId: 'eu-west-1_ABC123', username: 'ada', enabled: true }]);
		assert.match(result.message, /Enabled user/);
	});

	it('disables a user against the resolved user pool', async () => {
		const seam = recordingSetEnabled();

		const result = await setCognitoUserEnabled(
			authContext({ setUserEnabled: seam.setUserEnabled, region: 'eu-west-1' }),
			'ada',
			false,
		);

		assert.equal(result.ok, true);
		assert.deepEqual(seam.calls, [
			{ userPoolId: 'eu-west-1_ABC123', username: 'ada', enabled: false, region: 'eu-west-1' },
		]);
		assert.match(result.message, /Disabled user/);
	});

	it('reports STORE_NOT_FOUND when the block has no user pool', async () => {
		const seam = recordingSetEnabled();

		const result = await setCognitoUserEnabled(
			{ block: makeBlock(), groups: todosGroups, setUserEnabled: seam.setUserEnabled },
			'ada',
			true,
		);

		assert.equal(result.ok, false);
		assert.equal(result.errorCode, 'STORE_NOT_FOUND');
		assert.equal(seam.calls.length, 0);
	});

	it('refuses an empty username as VALIDATION_FAILED', async () => {
		const seam = recordingSetEnabled();

		const result = await setCognitoUserEnabled(authContext({ setUserEnabled: seam.setUserEnabled }), '', true);

		assert.equal(result.refusalCode, 'VALIDATION_FAILED');
		assert.equal(seam.calls.length, 0);
	});

	it('maps UserNotFoundException to a NOT_FOUND refusal, not to a missing stack or store', async () => {
		const error = named('UserNotFoundException', 'User does not exist.');

		const result = await setCognitoUserEnabled(
			authContext({ setUserEnabled: recordingSetEnabled(error).setUserEnabled }),
			'ada',
			true,
		);

		assert.equal(result.refusalCode, 'NOT_FOUND');
		assert.equal(result.errorCode, undefined);
	});

	it('classifies access denied on the pool', async () => {
		const error = named(
			'AccessDeniedException',
			`User: arn:aws:sts::${ACCOUNT_ID}:assumed-role/Dev/me is not authorized to perform: cognito-idp:AdminDisableUser`,
		);

		const result = await setCognitoUserEnabled(
			authContext({ setUserEnabled: recordingSetEnabled(error).setUserEnabled }),
			'ada',
			false,
		);

		assert.equal(result.errorCode, 'ACCESS_DENIED');
		assert.ok(!result.message.includes(ACCOUNT_ID));
	});
});

describe('no raw SDK message ever reaches the caller', () => {
	it('leaks no account id, ARN or SDK text across every failure path', async () => {
		const errors = [accessDenied(), expiredToken(), missingTable(), rawValidation(), conditionalFailure()];
		const messages: string[] = [];

		for (const error of errors) {
			const keys = recordingDescribe(['userId', 'todoId']).describeTable;
			messages.push(
				(
					await putCloudRecord(
						todosContext({ describeTable: keys, putItem: recordingPut(error).putItem }),
						validTodo,
						'create',
					)
				).message,
			);
			messages.push(
				(
					await putCloudRecord(
						todosContext({ describeTable: keys, putItem: recordingPut(error).putItem }),
						validTodo,
						'edit',
					)
				).message,
			);
			messages.push(
				(
					await deleteCloudRecord(
						todosContext({ describeTable: keys, deleteItem: recordingDelete(error).deleteItem }),
						{
							userId: 'u1',
							todoId: 't9',
						},
					)
				).message,
			);
			messages.push(
				(
					await deleteCloudRecord(
						todosContext({ describeTable: recordingDescribe([], error).describeTable }),
						{ userId: 'u1', todoId: 't9' },
					)
				).message,
			);
		}

		assert.ok(messages.length > 0);
		for (const message of messages) {
			assert.ok(message.length > 0, 'every result carries an explanation');
			assert.ok(!message.includes(ACCOUNT_ID), `leaked an account id: ${message}`);
			assert.ok(!message.includes('arn:aws'), `leaked an ARN: ${message}`);
			assert.ok(!message.includes(RAW_DENIED), `echoed the SDK message: ${message}`);
			assert.ok(!message.includes(RAW_VALIDATION), `echoed the SDK message: ${message}`);
			assert.ok(!/Exception/.test(message), `echoed an SDK error name: ${message}`);
		}
	});
});
