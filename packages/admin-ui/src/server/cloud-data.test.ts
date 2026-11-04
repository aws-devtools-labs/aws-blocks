// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { describe, it } from 'node:test';

import type { DiscoveredBlock, ResourceGroup, ResourceInfo } from '../contract/v1.js';
import {
	COGNITO_MAX_LIMIT,
	type CognitoUser,
	KEY_SEPARATOR,
	type ListUsersParams,
	type ListUsersResult,
	type ScanParams,
	type ScanResult,
	classifyCloudError,
	keyFieldsFromKeySchema,
	readCloudData,
	resolveCloudStores,
	tableStoreLabel,
} from './cloud-data.js';
import { decodeCursor } from './data-cursor.js';
import { REDACTED } from './redact.js';

/** No test in this file may reach AWS: all three seams are always injected. */

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

/** A scan seam serving fixed pages, recording the params it was called with. */
function pagedScan(pages: ScanResult[]): {
	scanTable: (params: ScanParams) => Promise<ScanResult>;
	calls: ScanParams[];
} {
	const calls: ScanParams[] = [];
	let index = 0;
	return {
		calls,
		scanTable: async (params) => {
			calls.push(params);
			const page = pages[index] ?? { items: [] };
			index += 1;
			return page;
		},
	};
}

function pagedListUsers(pages: ListUsersResult[]): {
	listUsers: (params: ListUsersParams) => Promise<ListUsersResult>;
	calls: ListUsersParams[];
} {
	const calls: ListUsersParams[] = [];
	let index = 0;
	return {
		calls,
		listUsers: async (params) => {
			calls.push(params);
			const page = pages[index] ?? { users: [] };
			index += 1;
			return page;
		},
	};
}

function user(username: string, attributes: Record<string, string>): CognitoUser {
	return { username, status: 'CONFIRMED', enabled: true, created: '2026-01-01T00:00:00.000Z', attributes };
}

const twoKeySchema = async () => ({ keyFields: ['userId', 'todoId'] });
const noScan = async (): Promise<ScanResult> => ({ items: [] });
const noUsers = async (): Promise<ListUsersResult> => ({ users: [] });

describe('resolveCloudStores — attribution from labelled groups', () => {
	it('takes tables and the pool from groups labelled with this block', () => {
		const block = makeBlock();
		const resolved = resolveCloudStores(block, [
			appGroup('my-app-todos', [tableResource('stack-my-app-todos-T1'), poolResource('us-east-1_Todo')]),
		]);
		assert.deepStrictEqual(resolved.tableNames, ['stack-my-app-todos-T1']);
		assert.strictEqual(resolved.userPoolId, 'us-east-1_Todo');
		assert.deepStrictEqual(
			resolved.stores.map((store) => [store.id, store.kind]),
			[
				['stack-my-app-todos-T1', 'dynamodb'],
				['us-east-1_Todo', 'cognito-user-pool'],
			],
		);
	});

	it('ignores groups labelled with a different block, and unlabelled groups', () => {
		const resolved = resolveCloudStores(makeBlock(), [
			appGroup('my-app-other', [tableResource('stack-my-app-other-T9')]),
			{ id: 'BlocksApi', category: 'platform', resources: [tableResource('stack-platform-T0')] },
		]);
		assert.deepStrictEqual(resolved.tableNames, []);
		assert.deepStrictEqual(resolved.stores, []);
	});

	it('puts the user pool first for an Auth block', () => {
		const block = makeBlock({ type: 'AuthUserPool', id: 'auth', fullId: 'my-app-auth', category: 'auth' });
		const resolved = resolveCloudStores(block, [
			appGroup('my-app-auth', [tableResource('stack-my-app-auth-users'), poolResource('us-east-1_Auth')]),
		]);
		assert.deepStrictEqual(
			resolved.stores.map((store) => store.id),
			['us-east-1_Auth', 'stack-my-app-auth-users'],
		);
	});

	it('sorts ancillary tables last so a populated block does not look empty', () => {
		const block = makeBlock({ type: 'AuthEmail', id: 'auth', fullId: 'my-app-auth', category: 'auth' });
		const resolved = resolveCloudStores(block, [
			appGroup('my-app-auth', [
				tableResource('stack-my-app-auth-codes', 'CodesT1'),
				tableResource('stack-my-app-auth-users', 'UsersT2'),
				tableResource('stack-my-app-auth-sessions', 'SessionsT3'),
			]),
		]);
		assert.deepStrictEqual(resolved.tableNames, [
			'stack-my-app-auth-users',
			'stack-my-app-auth-codes',
			'stack-my-app-auth-sessions',
		]);
		assert.deepStrictEqual(
			resolved.stores.map((store) => store.ancillary),
			[false, true, true],
		);
	});

	it('returns no stores for a block with no groups', () => {
		const resolved = resolveCloudStores(makeBlock(), []);
		assert.deepStrictEqual(resolved, { stores: [], tableNames: [] });
	});

	it('skips resources that have no physical id yet', () => {
		const resolved = resolveCloudStores(makeBlock(), [
			appGroup('my-app-todos', [{ logicalResourceId: 'TableABC123', resourceType: 'AWS::DynamoDB::Table' }]),
		]);
		assert.deepStrictEqual(resolved.stores, []);
	});

	// REGRESSION: the reference matched with squash(logicalId).startsWith(squash(fullId)),
	// so `users` claimed `usersessions`'s resources — and because userPoolId is
	// single-valued it adopted whichever pool matched last in stack order.
	it('does not let a block "users" claim a sibling "usersessions" resources', () => {
		const users = makeBlock({ type: 'DistributedTable', id: 'users', fullId: 'my-app-users' });
		const userSessions = makeBlock({ type: 'DistributedTable', id: 'usersessions', fullId: 'my-app-usersessions' });
		const groups = [
			appGroup('my-app-users', [tableResource('stack-my-app-users-T1', 'myappusersTableAAA')]),
			appGroup('my-app-usersessions', [
				tableResource('stack-my-app-usersessions-T2', 'myappusersessionsTableBBB'),
				poolResource('us-east-1_Sessions', 'myappusersessionsUserPoolCCC'),
			]),
		];

		const resolvedUsers = resolveCloudStores(users, groups);
		assert.deepStrictEqual(resolvedUsers.tableNames, ['stack-my-app-users-T1']);
		assert.strictEqual(resolvedUsers.userPoolId, undefined, 'must not adopt the sibling user pool');
		assert.strictEqual(resolvedUsers.stores.length, 1);

		const resolvedSessions = resolveCloudStores(userSessions, groups);
		assert.deepStrictEqual(resolvedSessions.tableNames, ['stack-my-app-usersessions-T2']);
		assert.strictEqual(resolvedSessions.userPoolId, 'us-east-1_Sessions');
	});

	it('does not mutate the groups it is given', () => {
		const groups = [appGroup('my-app-todos', [tableResource('stack-b-codes'), tableResource('stack-a')])];
		const snapshot = JSON.stringify(groups);
		resolveCloudStores(makeBlock(), groups);
		assert.strictEqual(JSON.stringify(groups), snapshot);
	});
});

describe('keyFieldsFromKeySchema', () => {
	it('orders HASH before RANGE regardless of input order', () => {
		assert.deepStrictEqual(
			keyFieldsFromKeySchema([
				{ AttributeName: 'todoId', KeyType: 'RANGE' },
				{ AttributeName: 'userId', KeyType: 'HASH' },
			]),
			['userId', 'todoId'],
		);
	});

	it('handles a single-key table', () => {
		assert.deepStrictEqual(keyFieldsFromKeySchema([{ AttributeName: 'id', KeyType: 'HASH' }]), ['id']);
	});

	it('never assumes pk/sk — it reports whatever the table keys on', () => {
		const keyFields = keyFieldsFromKeySchema([
			{ AttributeName: 'tenant', KeyType: 'HASH' },
			{ AttributeName: 'createdAt', KeyType: 'RANGE' },
		]);
		assert.deepStrictEqual(keyFields, ['tenant', 'createdAt']);
	});

	it('tolerates a missing key schema', () => {
		assert.deepStrictEqual(keyFieldsFromKeySchema(undefined), []);
	});
});

describe('readCloudData — DynamoDB path', () => {
	const groups = [appGroup('my-app-todos', [tableResource('stack-my-app-todos-T1')])];

	it('renders a composite key with the U+00B7 separator and exact keyValues', async () => {
		const page = await readCloudData({
			block: makeBlock(),
			groups,
			describeTable: twoKeySchema,
			scanTable: async () => ({ items: [{ userId: 'u1', todoId: 't9', title: 'buy milk', done: false }] }),
		});

		assert.strictEqual(page.source, 'dynamodb');
		assert.strictEqual(page.errorCode, undefined);
		assert.deepStrictEqual(page.keyFields, ['userId', 'todoId']);
		assert.strictEqual(page.records[0].key, `u1${KEY_SEPARATOR}t9`);
		assert.ok(page.records[0].key.includes('\u00b7'), 'separator is U+00B7, not an ASCII hyphen');
		assert.deepStrictEqual(page.records[0].keyValues, { userId: 'u1', todoId: 't9' });
	});

	it('keeps keyValues exact for numeric keys and drops non-addressable ones', async () => {
		const page = await readCloudData({
			block: makeBlock(),
			groups,
			describeTable: async () => ({ keyFields: ['userId', 'version'] }),
			scanTable: async () => ({
				items: [
					{ userId: 'u1', version: 7 },
					{ userId: 'u2', version: 0 },
				],
			}),
		});
		assert.deepStrictEqual(page.records[0].keyValues, { userId: 'u1', version: '7' });
		assert.strictEqual(page.records[0].key, `u1${KEY_SEPARATOR}7`);
		// 0 is a real key value, not an absent one.
		assert.deepStrictEqual(page.records[1].keyValues, { userId: 'u2', version: '0' });
	});

	it('falls back to the row index when no key attribute carries a value', async () => {
		const page = await readCloudData({
			block: makeBlock(),
			groups,
			describeTable: twoKeySchema,
			scanTable: async () => ({ items: [{ title: 'orphan' }, { title: 'another' }] }),
		});
		assert.deepStrictEqual(
			page.records.map((record) => record.key),
			['0', '1'],
		);
		assert.strictEqual(page.records[0].keyValues, undefined);
	});

	it('passes the resolved limit through and defaults to the first store', async () => {
		const { scanTable, calls } = pagedScan([{ items: [] }]);
		const page = await readCloudData({
			block: makeBlock(),
			groups,
			describeTable: twoKeySchema,
			scanTable,
			limit: 25,
		});
		assert.strictEqual(page.activeStore, 'stack-my-app-todos-T1');
		assert.strictEqual(calls[0].limit, 25);
		assert.strictEqual(calls[0].exclusiveStartKey, undefined);
	});

	it('paginates for real: emits a cursor, consumes it, and stops on the last page', async () => {
		const first = pagedScan([
			{ items: [{ userId: 'u1', todoId: 't1' }], lastEvaluatedKey: { userId: 'u1', todoId: 't1' } },
		]);
		const pageOne = await readCloudData({
			block: makeBlock(),
			groups,
			limit: 1,
			describeTable: twoKeySchema,
			scanTable: first.scanTable,
		});
		assert.ok(pageOne.nextCursor, 'a LastEvaluatedKey must produce a cursor');
		assert.deepStrictEqual(decodeCursor(pageOne.nextCursor as string, 'stack-my-app-todos-T1'), {
			kind: 'dynamodb',
			store: 'stack-my-app-todos-T1',
			lastKey: { userId: 'u1', todoId: 't1' },
		});

		const second = pagedScan([{ items: [{ userId: 'u2', todoId: 't2' }] }]);
		const pageTwo = await readCloudData({
			block: makeBlock(),
			groups,
			limit: 1,
			cursor: pageOne.nextCursor,
			describeTable: twoKeySchema,
			scanTable: second.scanTable,
		});
		// The cursor was APPLIED, not decoration: it arrived as ExclusiveStartKey.
		assert.deepStrictEqual(second.calls[0].exclusiveStartKey, { userId: 'u1', todoId: 't1' });
		assert.strictEqual(pageTwo.records[0].key, `u2${KEY_SEPARATOR}t2`);
		assert.strictEqual(pageTwo.nextCursor, undefined, 'the final page emits no cursor');
	});

	it('reports totalRecords as records seen, never as an exact table size', async () => {
		const page = await readCloudData({
			block: makeBlock(),
			groups,
			describeTable: twoKeySchema,
			scanTable: async () => ({
				items: [
					{ userId: 'u1', todoId: 't1' },
					{ userId: 'u2', todoId: 't2' },
				],
				lastEvaluatedKey: { userId: 'u2', todoId: 't2' },
			}),
		});
		assert.strictEqual(page.totalRecords, 2);
		assert.strictEqual(page.totalRecordsExact, false);
	});

	// `pwd` matches no name in SECRET_KEY_PATTERN, so this proves the value's SHAPE
	// is what masks it — the same defence that catches a hash under `displayName`.
	it('redacts credential-shaped values and flags the page', async () => {
		const bcrypt = '$2b$12$abcdefghijklmnopqrstuvABCDEFGHIJKLMNOPQRSTUVWXYZ01234';
		const page = await readCloudData({
			block: makeBlock(),
			groups,
			describeTable: async () => ({ keyFields: ['userId'] }),
			scanTable: async () => ({ items: [{ userId: 'u1', email: 'a@b.test', pwd: bcrypt }] }),
		});
		const value = page.records[0].value as Record<string, unknown>;
		assert.strictEqual(value.pwd, REDACTED);
		assert.ok(!JSON.stringify(page.records).includes(bcrypt), 'the raw hash must not appear anywhere in the page');
		assert.strictEqual(value.email, 'a@b.test');
		assert.strictEqual(page.records[0].redacted, true);
		assert.strictEqual(page.redacted, true);
		// The key stays addressable even though the row was redacted.
		assert.deepStrictEqual(page.records[0].keyValues, { userId: 'u1' });
	});

	it('leaves an unredacted page flagged false', async () => {
		const page = await readCloudData({
			block: makeBlock(),
			groups,
			describeTable: async () => ({ keyFields: ['userId'] }),
			scanTable: async () => ({ items: [{ userId: 'u1', title: 'plain' }] }),
		});
		assert.strictEqual(page.redacted, false);
		assert.strictEqual(page.records[0].redacted, false);
	});
});

describe('readCloudData — Cognito path', () => {
	const authBlock = makeBlock({ type: 'AuthUserPool', id: 'auth', fullId: 'my-app-auth', category: 'auth' });
	const groups = [appGroup('my-app-auth', [poolResource('us-east-1_AbCdEf')])];

	it('projects users to username keys and reports keyFields as [username]', async () => {
		const page = await readCloudData({
			block: authBlock,
			groups,
			listUsers: async () => ({ users: [user('alice', { email: 'alice@example.test' })] }),
		});
		assert.strictEqual(page.source, 'cognito');
		assert.deepStrictEqual(page.keyFields, ['username']);
		assert.strictEqual(page.records[0].key, 'alice');
		assert.deepStrictEqual(page.records[0].keyValues, { username: 'alice' });
		const value = page.records[0].value as Record<string, unknown>;
		assert.strictEqual(value.status, 'CONFIRMED');
		assert.strictEqual(value.enabled, true);
		assert.strictEqual(value.created, '2026-01-01T00:00:00.000Z');
		assert.deepStrictEqual(value.attributes, { email: 'alice@example.test' });
	});

	// THE REFERENCE'S WORST DEFECT: it hardcoded `redacted: false` on this path
	// and applied no redaction at all, shipping custom-attribute tokens to the
	// browser under a flag that claimed nothing had been masked.
	it('redacts a credential-shaped custom attribute and reports redacted: true', async () => {
		const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhbGljZSJ9.s1gnatureBytes';
		const page = await readCloudData({
			block: authBlock,
			groups,
			listUsers: async () => ({
				users: [
					user('alice', {
						email: 'alice@example.test',
						'custom:refresh': jwt,
						'custom:api_token': 'plain-looking-but-named-token',
					}),
				],
			}),
		});

		const attributes = (page.records[0].value as { attributes: Record<string, unknown> }).attributes;
		assert.strictEqual(attributes['custom:refresh'], REDACTED, 'a JWT must be masked by shape');
		assert.strictEqual(attributes['custom:api_token'], REDACTED, 'a token-named attribute must be masked by name');
		assert.strictEqual(attributes.email, 'alice@example.test', 'benign attributes survive');
		assert.strictEqual(page.records[0].redacted, true);
		assert.strictEqual(page.redacted, true, 'the page flag is computed, never asserted by the caller');
		assert.ok(!JSON.stringify(page.records).includes(jwt), 'the raw JWT must not appear anywhere in the page');
	});

	it('reports redacted: false when nothing was masked, rather than always false', async () => {
		const page = await readCloudData({
			block: authBlock,
			groups,
			listUsers: async () => ({ users: [user('bob', { email: 'bob@example.test' })] }),
		});
		assert.strictEqual(page.redacted, false);
	});

	it('paginates for real: emits a cursor, consumes it, and stops on the last page', async () => {
		const first = pagedListUsers([{ users: [user('alice', {})], paginationToken: 'aws-token-1' }]);
		const pageOne = await readCloudData({ block: authBlock, groups, listUsers: first.listUsers });
		assert.ok(pageOne.nextCursor, 'a PaginationToken must produce a cursor');
		assert.deepStrictEqual(decodeCursor(pageOne.nextCursor as string, 'us-east-1_AbCdEf'), {
			kind: 'cognito',
			store: 'us-east-1_AbCdEf',
			token: 'aws-token-1',
		});

		const second = pagedListUsers([{ users: [user('bob', {})] }]);
		const pageTwo = await readCloudData({
			block: authBlock,
			groups,
			cursor: pageOne.nextCursor,
			listUsers: second.listUsers,
		});
		assert.strictEqual(second.calls[0].paginationToken, 'aws-token-1', 'the token was applied, not ignored');
		assert.strictEqual(pageTwo.records[0].key, 'bob');
		assert.strictEqual(pageTwo.nextCursor, undefined, 'the final page emits no cursor');
	});

	it('clamps the request to Cognito ListUsers maximum of 60', async () => {
		const { listUsers, calls } = pagedListUsers([{ users: [] }]);
		await readCloudData({ block: authBlock, groups, limit: 200, listUsers });
		assert.strictEqual(calls[0].limit, COGNITO_MAX_LIMIT);
	});

	it('reports totalRecordsExact false — ListUsers gives no total', async () => {
		const page = await readCloudData({
			block: authBlock,
			groups,
			listUsers: async () => ({ users: [user('alice', {}), user('bob', {})], paginationToken: 't' }),
		});
		assert.strictEqual(page.totalRecords, 2);
		assert.strictEqual(page.totalRecordsExact, false);
	});
});

describe('readCloudData — store selection and cursors', () => {
	const groups = [appGroup('my-app-todos', [tableResource('stack-my-app-todos-T1')])];

	it('is not an error for a block with no cloud store', async () => {
		const page = await readCloudData({
			block: makeBlock(),
			groups: [],
			describeTable: twoKeySchema,
			scanTable: noScan,
			listUsers: noUsers,
		});
		assert.strictEqual(page.source, 'unavailable');
		assert.strictEqual(page.errorCode, undefined, 'a block that is not deployed is not a failure');
		assert.deepStrictEqual(page.stores, []);
		assert.match(page.error as string, /not be deployed|no browsable store/);
	});

	it('rejects an unknown store with STORE_NOT_FOUND, still listing the real ones', async () => {
		const page = await readCloudData({
			block: makeBlock(),
			groups,
			store: 'some-other-table',
			describeTable: twoKeySchema,
			scanTable: noScan,
		});
		assert.strictEqual(page.source, 'unavailable');
		assert.strictEqual(page.errorCode, 'STORE_NOT_FOUND');
		assert.deepStrictEqual(
			page.stores.map((store) => store.id),
			['stack-my-app-todos-T1'],
		);
		assert.strictEqual(page.activeStore, undefined);
	});

	it('rejects a malformed cursor with BAD_CURSOR', async () => {
		const page = await readCloudData({
			block: makeBlock(),
			groups,
			cursor: 'not-a-real-cursor',
			describeTable: twoKeySchema,
			scanTable: noScan,
		});
		assert.strictEqual(page.errorCode, 'BAD_CURSOR');
		assert.strictEqual(page.records.length, 0);
	});

	it('rejects a cursor minted for another store with BAD_CURSOR, not a silent restart', async () => {
		const { scanTable, calls } = pagedScan([{ items: [{ userId: 'u1', todoId: 't1' }] }]);
		const foreign = Buffer.from(
			JSON.stringify({ kind: 'dynamodb', store: 'a-different-table', lastKey: { userId: 'u1' } }),
			'utf-8',
		).toString('base64url');
		const page = await readCloudData({
			block: makeBlock(),
			groups,
			cursor: foreign,
			describeTable: twoKeySchema,
			scanTable,
		});
		assert.strictEqual(page.errorCode, 'BAD_CURSOR');
		assert.strictEqual(calls.length, 0, 'no scan is issued for a rejected cursor');
	});

	it('rejects a cursor of the wrong store kind with BAD_CURSOR', async () => {
		const offsetCursor = Buffer.from(
			JSON.stringify({ kind: 'offset', store: 'stack-my-app-todos-T1', offset: 50 }),
			'utf-8',
		).toString('base64url');
		const page = await readCloudData({
			block: makeBlock(),
			groups,
			cursor: offsetCursor,
			describeTable: twoKeySchema,
			scanTable: noScan,
		});
		assert.strictEqual(page.errorCode, 'BAD_CURSOR');
		assert.match(page.error as string, /paginates by dynamodb/);
	});
});

describe('readCloudData — AWS error classification', () => {
	const groups = [appGroup('my-app-todos', [tableResource('stack-my-app-todos-T1')])];
	const poolGroups = [appGroup('my-app-auth', [poolResource('us-east-1_AbCdEf')])];
	const authBlock = makeBlock({ type: 'AuthUserPool', id: 'auth', fullId: 'my-app-auth', category: 'auth' });

	function awsError(name: string, message: string): Error {
		const error = new Error(message);
		error.name = name;
		return error;
	}

	it('classifies AccessDenied distinctly from a missing table', async () => {
		const denied = await readCloudData({
			block: makeBlock(),
			groups,
			describeTable: async () => {
				throw awsError(
					'AccessDeniedException',
					'User: arn:aws:iam::123456789012:user/dev is not authorized to perform: dynamodb:DescribeTable on resource: arn:aws:dynamodb:us-east-1:123456789012:table/stack-my-app-todos-T1',
				);
			},
			scanTable: noScan,
		});
		assert.strictEqual(denied.errorCode, 'ACCESS_DENIED');
		assert.strictEqual(denied.source, 'unavailable');

		const missing = await readCloudData({
			block: makeBlock(),
			groups,
			describeTable: async () => {
				throw awsError('ResourceNotFoundException', 'Requested resource not found: Table not found');
			},
			scanTable: noScan,
		});
		assert.strictEqual(missing.errorCode, 'STORE_NOT_FOUND');
		assert.notStrictEqual(missing.errorCode, denied.errorCode);
	});

	it('never leaks a raw SDK message — no account id or ARN reaches error', async () => {
		const raw =
			'User: arn:aws:iam::123456789012:user/dev is not authorized to perform: dynamodb:Scan on resource: arn:aws:dynamodb:us-east-1:123456789012:table/stack-my-app-todos-T1';
		const page = await readCloudData({
			block: makeBlock(),
			groups,
			describeTable: twoKeySchema,
			scanTable: async () => {
				throw awsError('AccessDeniedException', raw);
			},
		});
		const message = page.error as string;
		assert.strictEqual(page.errorCode, 'ACCESS_DENIED');
		assert.ok(!message.includes(raw), 'the raw SDK message must not be echoed');
		assert.ok(!message.includes('123456789012'), 'no account id in the message');
		assert.ok(!message.includes('arn:aws:'), 'no ARN in the message');
		assert.match(message, /Access denied/);
	});

	it('classifies expired credentials', async () => {
		const page = await readCloudData({
			block: makeBlock(),
			groups,
			describeTable: async () => {
				throw awsError('ExpiredTokenException', 'The security token included in the request is expired');
			},
			scanTable: noScan,
		});
		assert.strictEqual(page.errorCode, 'CREDENTIALS_EXPIRED');
		assert.match(page.error as string, /expired/i);
	});

	it('classifies missing credentials', async () => {
		const page = await readCloudData({
			block: makeBlock(),
			groups,
			describeTable: async () => {
				throw awsError('CredentialsProviderError', 'Could not load credentials from any providers');
			},
			scanTable: noScan,
		});
		assert.strictEqual(page.errorCode, 'CREDENTIALS_MISSING');
	});

	it('classifies a Cognito failure on the pool path too, naming the pool action', async () => {
		const page = await readCloudData({
			block: authBlock,
			groups: poolGroups,
			listUsers: async () => {
				throw awsError('AccessDeniedException', 'not authorized to perform: cognito-idp:ListUsers');
			},
		});
		assert.strictEqual(page.errorCode, 'ACCESS_DENIED');
		assert.match(page.error as string, /cognito-idp:ListUsers/);
	});

	it('falls back to UNKNOWN without echoing the message', async () => {
		const page = await readCloudData({
			block: makeBlock(),
			groups,
			describeTable: async () => {
				throw awsError(
					'ThrottlingException',
					'Rate exceeded for table arn:aws:dynamodb:us-east-1:123456789012:table/x',
				);
			},
			scanTable: noScan,
		});
		assert.strictEqual(page.errorCode, 'UNKNOWN');
		assert.ok(!(page.error as string).includes('arn:aws:'));
		assert.match(page.error as string, /server log/);
	});

	it('classifyCloudError handles a non-Error rejection', () => {
		assert.strictEqual(classifyCloudError('AccessDeniedException: nope'), 'ACCESS_DENIED');
		assert.strictEqual(classifyCloudError({ weird: true }), 'UNKNOWN');
	});
});

describe('tableStoreLabel — a store label must not duplicate its id', () => {
	/**
	 * Found by running the data browser against a REAL deployed stack, not a
	 * fixture: the label was the full physical table name, identical to the id, so
	 * the store picker showed two 56-character strings differing only in their last
	 * word — exactly where the user has to tell them apart.
	 */
	const STACK = 'dashboard-testbe-9dddfb-dev-0f1b3b';

	it('reduces a real deployed table name to its distinguishing suffix', () => {
		assert.strictEqual(tableStoreLabel(`${STACK}-my-app-auth-users`, 'my-app-auth'), 'users');
		assert.strictEqual(tableStoreLabel(`${STACK}-my-app-auth-codes`, 'my-app-auth'), 'codes');
		assert.strictEqual(tableStoreLabel(`${STACK}-my-app-live-connections`, 'my-app-live'), 'connections');
	});

	it('names the block-named table as the main one', () => {
		assert.strictEqual(tableStoreLabel(`${STACK}-my-app-todos`, 'my-app-todos'), 'Main table');
	});

	it('never returns the id verbatim when the block id anchors it', () => {
		const name = `${STACK}-my-app-auth-users`;
		assert.notStrictEqual(tableStoreLabel(name, 'my-app-auth'), name);
	});

	it('falls back to the full name when the block id does not appear', () => {
		// A hand-named table, or a scheme we do not know. A wrong label on the
		// control that selects which data you are reading is worse than a long one.
		assert.strictEqual(tableStoreLabel('legacy-todos-table', 'my-app-todos'), 'legacy-todos-table');
	});

	it('anchors on the LAST occurrence, so a repeated id does not truncate early', () => {
		assert.strictEqual(tableStoreLabel('my-app-auth-stack-my-app-auth-sessions', 'my-app-auth'), 'sessions');
	});

	it('strips either separator', () => {
		assert.strictEqual(tableStoreLabel('s-my-app-auth_users', 'my-app-auth'), 'users');
	});
});
