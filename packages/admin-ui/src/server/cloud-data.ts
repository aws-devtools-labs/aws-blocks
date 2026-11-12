// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { AwsErrorCode, DataRecord, DataStore, DiscoveredBlock, ResourceGroup } from '../contract/v1.js';
import { awsClientConfig } from './aws-config.js';
import { classifyEventsError } from './cfn-events.js';
import { type DataCursor, InvalidCursorError, decodeCursor, encodeCursor, resolvePageLimit } from './data-cursor.js';
import { isAncillaryStoreName, redactValue } from './redact.js';

/**
 * The cloud read path of the data browser: DynamoDB tables and Cognito user
 * pools, read with the developer's own credentials.
 *
 * Three things here are the point of the module rather than incidental to it,
 * because each is a defect in the implementation we model this on:
 *
 * 1. STORE RESOLUTION comes from the attribution Stage 3 already established
 *    (`ResourceGroup.blockFullId`, derived from the deployed template's CDK
 *    construct paths), not from matching physical/logical resource names
 *    against the block id. See {@link resolveCloudStores}.
 * 2. PAGINATION IS REAL on both paths. The reference issues one 100-item scan,
 *    reports `LastEvaluatedKey` only as a cosmetic label and ignores Cognito's
 *    `PaginationToken` outright, so nothing past the first page is reachable.
 *    Here both continuation values are round-tripped through `data-cursor`.
 * 3. REDACTION RUNS ON BOTH PATHS. The reference hardcodes `redacted: false`
 *    on the Cognito path and applies nothing — its worst defect, since Cognito
 *    custom attributes routinely carry tokens and hashes.
 *
 * Every AWS failure is CLASSIFIED and never surfaced verbatim: the reference
 * stringifies the raw SDK message into the response, which makes `AccessDenied`
 * on `DescribeTable` indistinguishable from a missing table and leaks account
 * ids and ARNs into the browser.
 */

/** DynamoDB tables and the user pool a block owns, plus the browsable store list. */
export interface CloudStores {
	stores: DataStore[];
	tableNames: string[];
	userPoolId?: string;
}

const DYNAMODB_TABLE_TYPE = 'AWS::DynamoDB::Table';
const COGNITO_USER_POOL_TYPE = 'AWS::Cognito::UserPool';

/**
 * The stores a block can be browsed through, resolved from the resource groups
 * Stage 3 labelled.
 *
 * THE IMPROVEMENT: a group carries `blockFullId` only when the DEPLOYED
 * template's CDK construct path put it under that block, so an exact
 * `blockFullId === block.fullId` comparison is all that is needed. This
 * REPLACES the reference's `squash(logicalId).startsWith(squash(fullId))`
 * prefix match, which was wrong in two compounding ways: a block `users`
 * claimed every resource of a sibling block `usersessions` (its squashed id is
 * a prefix of the sibling's), and because `userPoolId` is single-valued the
 * block then silently adopted whichever pool matched LAST in stack order — so
 * `users` could end up browsing `usersessions`'s user pool with no indication
 * anything had gone wrong. No string squashing happens here, so the collision
 * cannot occur; `cloud-data.test.ts` pins the sibling case as a regression.
 *
 * Where several pools are somehow attributed to one block the FIRST in group
 * and resource order wins, deterministically, rather than the last one seen.
 */
export function resolveCloudStores(block: DiscoveredBlock, groups: ResourceGroup[]): CloudStores {
	const tableNames: string[] = [];
	let userPoolId: string | undefined;

	for (const group of groups) {
		if (group.blockFullId !== block.fullId) continue;
		for (const resource of group.resources) {
			const physicalId = resource.physicalResourceId;
			if (!physicalId) continue; // A resource mid-create has no physical id yet.
			if (resource.resourceType === DYNAMODB_TABLE_TYPE) {
				if (!tableNames.includes(physicalId)) tableNames.push(physicalId);
			} else if (resource.resourceType === COGNITO_USER_POOL_TYPE && userPoolId === undefined) {
				userPoolId = physicalId;
			}
		}
	}

	// Ancillary tables (codes, sessions, tokens, challenges, cache) sort last:
	// they are usually empty at rest, so landing on one makes a healthy block
	// look broken. Stable within each half, so stack order is otherwise kept.
	const orderedTables = [...tableNames].sort((a, b) => rankAncillary(a) - rankAncillary(b));
	const tableStores: DataStore[] = orderedTables.map((tableName) => ({
		id: tableName,
		label: tableStoreLabel(tableName, block.fullId),
		kind: 'dynamodb',
		ancillary: isAncillaryStoreName(tableName),
	}));
	const poolStores: DataStore[] =
		userPoolId === undefined
			? []
			: [{ id: userPoolId, label: `Users (${userPoolId})`, kind: 'cognito-user-pool', ancillary: false }];

	// For an Auth block the user pool is the store a reader came to look at; its
	// tables are the mechanics behind it. Everywhere else, tables lead.
	const stores = isAuthBlock(block) ? [...poolStores, ...tableStores] : [...tableStores, ...poolStores];
	return { stores, tableNames: orderedTables, ...(userPoolId === undefined ? {} : { userPoolId }) };
}

function rankAncillary(tableName: string): number {
	return isAncillaryStoreName(tableName) ? 1 : 0;
}

/**
 * A readable label for a DynamoDB store, distinct from its `id`.
 *
 * A deployed table name is the stack name, the block's full id and a shard
 * suffix concatenated — on a real stack that is
 * `dashboard-testbe-9dddfb-dev-0f1b3b-my-app-auth-users`. Using it as the
 * label as well as the id (which is what this did originally, found by running
 * against a real deployment rather than a fixture) puts two 56-character strings
 * in the store picker that differ only in their final word, which is precisely
 * where the user has to tell them apart. The Cognito store beside it was already
 * labelled properly, so the two halves disagreed.
 *
 * The block's full id is the anchor: everything after it is the shard suffix that
 * actually distinguishes one store from another. A table named exactly for the
 * block is its main table and says so. When the full id does not appear at all —
 * a hand-named table, or a naming scheme we do not know — the full name is
 * returned rather than a guess, because a wrong label on the control that selects
 * which data you are reading is worse than a verbose one.
 */
export function tableStoreLabel(tableName: string, blockFullId: string): string {
	const anchor = tableName.lastIndexOf(blockFullId);
	if (anchor === -1) return tableName;
	const suffix = tableName.slice(anchor + blockFullId.length).replace(/^[-_]/, '');
	return suffix === '' ? 'Main table' : suffix;
}

function isAuthBlock(block: DiscoveredBlock): boolean {
	return block.type.startsWith('Auth');
}

/** Key attribute names in key order, as `DescribeTable` reports them. */
export interface TableKeySchema {
	keyFields: string[];
}

export interface ScanParams {
	tableName: string;
	limit: number;
	exclusiveStartKey?: Record<string, unknown>;
	region?: string;
}

export interface ScanResult {
	items: Record<string, unknown>[];
	lastEvaluatedKey?: Record<string, unknown>;
}

export interface ListUsersParams {
	userPoolId: string;
	limit: number;
	paginationToken?: string;
	region?: string;
}

export interface ListUsersResult {
	users: CognitoUser[];
	paginationToken?: string;
}

export interface CognitoUser {
	username: string;
	status?: string;
	enabled?: boolean;
	created?: string;
	attributes: Record<string, string>;
}

export interface ReadCloudDataOptions {
	block: DiscoveredBlock;
	groups: ResourceGroup[];
	store?: string;
	cursor?: string;
	limit?: number;
	region?: string;
	/** Test seams. Default to the real SDK calls. */
	describeTable?: (tableName: string, region?: string) => Promise<TableKeySchema>;
	scanTable?: (params: ScanParams) => Promise<ScanResult>;
	listUsers?: (params: ListUsersParams) => Promise<ListUsersResult>;
}

/** One page of cloud data. Mirrors the local page, with cloud sources and codes. */
export interface CloudDataPage {
	source: 'dynamodb' | 'cognito' | 'unavailable';
	error?: string;
	errorCode?: AwsErrorCode | 'STORE_NOT_FOUND' | 'ACCESS_DENIED' | 'BAD_CURSOR';
	stores: DataStore[];
	activeStore?: string;
	keyFields: string[];
	records: DataRecord[];
	nextCursor?: string;
	totalRecords: number;
	totalRecordsExact: boolean;
	redacted: boolean;
}

/** The separator between key attribute values in a record's display key (U+00B7). */
export const KEY_SEPARATOR = ' \u00b7 ';

/**
 * Cognito caps `ListUsers` at 60 per call, below our own `MAX_PAGE_LIMIT`.
 * Asking for more is a validation error, so the request is clamped and the
 * cursor simply yields more pages.
 */
export const COGNITO_MAX_LIMIT = 60;

/** One `KeySchema` entry as `DescribeTable` returns it. */
export interface RawKeySchemaElement {
	AttributeName?: string;
	KeyType?: string;
}

/**
 * Key attribute names in key order: HASH first, then RANGE.
 *
 * `DescribeTable` is the ONLY authority for these names. Never assume `pk`/`sk`
 * — a real project keys on whatever it likes, and the testbed app keys on
 * `userId`/`todoId`.
 *
 * The comparator reads BOTH sides on purpose. A comparator that inspects only
 * one (`(a) => (a.KeyType === 'HASH' ? -1 : 1)`) is a latent bug that happens
 * to produce the right answer for two entries and silently stops being a valid
 * ordering the moment a third appears — it is not antisymmetric, so the result
 * depends on the engine's sort implementation rather than on the data.
 */
export function keyFieldsFromKeySchema(keySchema: readonly RawKeySchemaElement[] | undefined): string[] {
	return [...(keySchema ?? [])]
		.sort((a, b) => keyTypeRank(a.KeyType) - keyTypeRank(b.KeyType))
		.map((element) => element.AttributeName)
		.filter((name): name is string => typeof name === 'string' && name.length > 0);
}

function keyTypeRank(keyType: string | undefined): number {
	return keyType === 'HASH' ? 0 : 1;
}

/**
 * Reads one page from a block's cloud store. Never rejects: every failure is
 * classified into `errorCode` with an explanation written here, so no raw SDK
 * text (and no account id or ARN inside it) reaches the browser.
 */
export async function readCloudData(options: ReadCloudDataOptions): Promise<CloudDataPage> {
	const { block, groups, region } = options;
	const resolved = resolveCloudStores(block, groups);

	// Not an error: a block with no cloud store is a block that is not deployed
	// to this stage, or one that has nothing browsable (an ApiNamespace, a
	// Hosting site). An empty list with an explanation is the honest answer.
	if (resolved.stores.length === 0) {
		return {
			...emptyPage([]),
			error: `No DynamoDB table or Cognito user pool is attributed to "${block.fullId}" in this stage. The block may not be deployed here, or may have no browsable store.`,
		};
	}

	const active =
		options.store === undefined ? resolved.stores[0] : resolved.stores.find((s) => s.id === options.store);
	if (!active) {
		return {
			...emptyPage(resolved.stores),
			errorCode: 'STORE_NOT_FOUND',
			error: `Store "${options.store}" does not belong to "${block.fullId}". Pick one of the listed stores.`,
		};
	}

	const expectedKind: DataCursor['kind'] = active.kind === 'cognito-user-pool' ? 'cognito' : 'dynamodb';
	let cursor: DataCursor | undefined;
	if (options.cursor !== undefined && options.cursor !== '') {
		try {
			cursor = decodeCursor(options.cursor, active.id);
		} catch (error) {
			return badCursorPage(resolved.stores, active, error);
		}
		if (cursor.kind !== expectedKind) {
			// Right store, wrong store KIND — only reachable from a hand-edited or
			// stale token, and resuming a scan from an offset would be meaningless.
			return badCursorPage(
				resolved.stores,
				active,
				new InvalidCursorError(
					`Cursor is a ${cursor.kind} cursor, but "${active.id}" paginates by ${expectedKind}.`,
				),
			);
		}
	}

	const limit = resolvePageLimit(options.limit);
	try {
		if (active.kind === 'cognito-user-pool') {
			return await readUserPool({
				stores: resolved.stores,
				store: active,
				limit,
				region,
				listUsers: options.listUsers ?? listUsersViaSdk,
				...(cursor && cursor.kind === 'cognito' ? { paginationToken: cursor.token } : {}),
			});
		}
		return await readTable({
			stores: resolved.stores,
			store: active,
			limit,
			region,
			describeTable: options.describeTable ?? describeTableViaSdk,
			scanTable: options.scanTable ?? scanTableViaSdk,
			...(cursor && cursor.kind === 'dynamodb' ? { exclusiveStartKey: cursor.lastKey } : {}),
		});
	} catch (error) {
		const errorCode = classifyCloudError(error);
		return {
			...emptyPage(resolved.stores),
			activeStore: active.id,
			errorCode,
			error: explainCloudError(errorCode, active),
		};
	}
}

interface ReadTableArgs {
	stores: DataStore[];
	store: DataStore;
	limit: number;
	region?: string;
	exclusiveStartKey?: Record<string, unknown>;
	describeTable: (tableName: string, region?: string) => Promise<TableKeySchema>;
	scanTable: (params: ScanParams) => Promise<ScanResult>;
}

async function readTable(args: ReadTableArgs): Promise<CloudDataPage> {
	const { stores, store, limit, region, exclusiveStartKey, describeTable, scanTable } = args;
	const { keyFields } = await describeTable(store.id, region);
	const result = await scanTable({
		tableName: store.id,
		limit,
		...(exclusiveStartKey ? { exclusiveStartKey } : {}),
		...(region === undefined ? {} : { region }),
	});

	let redacted = false;
	const records: DataRecord[] = result.items.map((item, index) => {
		const outcome = redactValue(item);
		if (outcome.redacted) redacted = true;
		// keyValues and the display key are read from the RAW item, never from the
		// redacted copy: Stage 5's edit and delete address the record by these, and
		// a masked key would address the wrong row (or none at all).
		const keyValues = extractKeyValues(item, keyFields);
		return {
			key: renderKey(keyValues, keyFields, index),
			...(Object.keys(keyValues).length > 0 ? { keyValues } : {}),
			value: outcome.value,
			redacted: outcome.redacted,
		};
	});

	return {
		source: 'dynamodb',
		stores,
		activeStore: store.id,
		keyFields,
		records,
		...(result.lastEvaluatedKey
			? { nextCursor: encodeCursor({ kind: 'dynamodb', store: store.id, lastKey: result.lastEvaluatedKey }) }
			: {}),
		// Records SEEN, not the table's size, and `totalRecordsExact: false` says
		// so. A DynamoDB table's true item count cannot be known without paying
		// for a full scan of it. The reference reports the scan page's `Count` as
		// the total, so its UI can never show more than 100 and a 100-item table
		// is indistinguishable from a 100,000-item one.
		totalRecords: records.length,
		totalRecordsExact: false,
		redacted,
	};
}

interface ReadUserPoolArgs {
	stores: DataStore[];
	store: DataStore;
	limit: number;
	region?: string;
	paginationToken?: string;
	listUsers: (params: ListUsersParams) => Promise<ListUsersResult>;
}

async function readUserPool(args: ReadUserPoolArgs): Promise<CloudDataPage> {
	const { stores, store, limit, region, paginationToken, listUsers } = args;
	const result = await listUsers({
		userPoolId: store.id,
		limit: Math.min(limit, COGNITO_MAX_LIMIT),
		...(paginationToken ? { paginationToken } : {}),
		...(region === undefined ? {} : { region }),
	});

	let redacted = false;
	const records: DataRecord[] = result.users.map((user) => {
		// REDACTION RUNS HERE. The reference hardcoded `redacted: false` on this
		// path and applied nothing, which is its single worst defect: a Cognito
		// custom attribute routinely carries a token, a hash or an API key, and
		// the flag the UI trusted was a claim by the caller rather than a fact
		// about the data. Cognito users go through `redactValue` like any other
		// record, and the flag is whatever the walk actually found.
		const outcome = redactValue({
			...(user.status === undefined ? {} : { status: user.status }),
			...(user.enabled === undefined ? {} : { enabled: user.enabled }),
			...(user.created === undefined ? {} : { created: user.created }),
			attributes: user.attributes,
		});
		if (outcome.redacted) redacted = true;
		return {
			key: user.username,
			keyValues: { username: user.username },
			value: outcome.value,
			redacted: outcome.redacted,
		};
	});

	return {
		source: 'cognito',
		stores,
		activeStore: store.id,
		keyFields: ['username'],
		records,
		...(result.paginationToken
			? { nextCursor: encodeCursor({ kind: 'cognito', store: store.id, token: result.paginationToken }) }
			: {}),
		// As with DynamoDB: users seen so far, not the pool's size. `ListUsers`
		// reports no total, and `DescribeUserPool`'s EstimatedNumberOfUsers is
		// both an estimate and a second API call.
		totalRecords: records.length,
		totalRecordsExact: false,
		redacted,
	};
}

/** Key attributes by name, exactly as stored, so an edit or delete can address the record. */
function extractKeyValues(item: Record<string, unknown>, keyFields: readonly string[]): Record<string, string> {
	const keyValues: Record<string, string> = {};
	for (const field of keyFields) {
		const value = item[field];
		if (value === undefined || value === null) continue;
		if (typeof value === 'string') {
			keyValues[field] = value;
		} else if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
			keyValues[field] = String(value);
		}
		// A binary or set-valued key is not addressable as a string; it is left
		// out rather than mangled into '[object Object]'.
	}
	return keyValues;
}

function renderKey(keyValues: Record<string, string>, keyFields: readonly string[], index: number): string {
	const parts = keyFields.map((field) => keyValues[field]).filter((value): value is string => value !== undefined);
	// No key attribute carried a value: fall back to the row index so the record
	// is still identifiable in the page rather than rendering as a blank row.
	return parts.length > 0 ? parts.join(KEY_SEPARATOR) : String(index);
}

function emptyPage(stores: DataStore[]): CloudDataPage {
	return {
		source: 'unavailable',
		stores,
		keyFields: [],
		records: [],
		totalRecords: 0,
		totalRecordsExact: false,
		redacted: false,
	};
}

function badCursorPage(stores: DataStore[], store: DataStore, error: unknown): CloudDataPage {
	return {
		...emptyPage(stores),
		activeStore: store.id,
		errorCode: 'BAD_CURSOR',
		// Our own message, not an SDK one — it tells the reader what to do next.
		error: error instanceof Error ? error.message : 'Cursor is not a valid token.',
	};
}

/** Classification of a cloud-read failure. */
export type CloudErrorCode = AwsErrorCode | 'STORE_NOT_FOUND' | 'ACCESS_DENIED';

/**
 * Classifies an AWS failure on the cloud read path.
 *
 * `classifyEventsError` carries the shared credential vocabulary; two codes are
 * added on top of it because it cannot distinguish them and the difference is
 * exactly what a reader needs:
 * - ACCESS_DENIED — the credentials work but lack the action. Checked FIRST,
 *   since an AccessDeniedException message ("... is not authorized to perform
 *   ...") says nothing that the credential patterns would catch.
 * - STORE_NOT_FOUND — the table or pool is gone (or lives in another region).
 *   Without this it would fall through to UNKNOWN and read identically to a
 *   permissions problem, which is the reference's failure exactly.
 */
export function classifyCloudError(error: unknown): CloudErrorCode {
	const name = error instanceof Error ? error.name : '';
	const message = error instanceof Error ? error.message : String(error);
	const haystack = `${name} ${message}`;

	if (/^AccessDenied/.test(name) || /AccessDenied|not authorized to perform/i.test(haystack)) return 'ACCESS_DENIED';
	if (/ResourceNotFound|Requested resource not found|UserPoolNotFound/i.test(haystack)) return 'STORE_NOT_FOUND';
	return classifyEventsError(error);
}

/** Human explanation per code. Written here, so no SDK text is ever echoed out. */
function explainCloudError(code: CloudErrorCode, store: DataStore): string {
	const action =
		store.kind === 'cognito-user-pool' ? 'cognito-idp:ListUsers' : 'dynamodb:DescribeTable and dynamodb:Scan';
	switch (code) {
		case 'ACCESS_DENIED':
			return `Access denied reading "${store.id}". The credentials in use are valid but lack ${action} on it.`;
		case 'CREDENTIALS_EXPIRED':
			return 'AWS credentials have expired. Refresh them (for example re-run your SSO login) and reload.';
		case 'CREDENTIALS_MISSING':
			return 'No AWS credentials could be loaded. Set a profile with --profile, or configure the default chain.';
		case 'STORE_NOT_FOUND':
			return `"${store.id}" was not found. It may have been deleted, or the stage may be deployed in another region.`;
		case 'STACK_NOT_FOUND':
			return 'The stage\u2019s stack no longer exists in this account and region.';
		default:
			return `"${store.id}" could not be read. The underlying AWS error is in the dashboard server log.`;
	}
}

/** Default `describeTable` seam. Dynamic import: the SDK loads only on a real read. */
async function describeTableViaSdk(tableName: string, region?: string): Promise<TableKeySchema> {
	const { DynamoDBClient, DescribeTableCommand } = await import('@aws-sdk/client-dynamodb');
	const client = new DynamoDBClient(awsClientConfig(region));
	const result = await client.send(new DescribeTableCommand({ TableName: tableName }));
	return { keyFields: keyFieldsFromKeySchema(result.Table?.KeySchema) };
}

/**
 * Default `scanTable` seam. Goes through `DynamoDBDocumentClient` so items
 * arrive as plain JS rather than as `{ S: '...' }` attribute-value maps —
 * `LastEvaluatedKey` comes back unmarshalled too, which is what makes it safe
 * to put straight into a cursor and hand back as `ExclusiveStartKey`.
 */
async function scanTableViaSdk(params: ScanParams): Promise<ScanResult> {
	const { DynamoDBClient } = await import('@aws-sdk/client-dynamodb');
	const { DynamoDBDocumentClient, ScanCommand } = await import('@aws-sdk/lib-dynamodb');
	const client = DynamoDBDocumentClient.from(new DynamoDBClient(awsClientConfig(params.region)));
	const result = await client.send(
		new ScanCommand({
			TableName: params.tableName,
			Limit: params.limit,
			...(params.exclusiveStartKey ? { ExclusiveStartKey: params.exclusiveStartKey } : {}),
		}),
	);
	return {
		items: (result.Items ?? []) as Record<string, unknown>[],
		...(result.LastEvaluatedKey ? { lastEvaluatedKey: result.LastEvaluatedKey } : {}),
	};
}

/** Default `listUsers` seam. `PaginationToken` is round-tripped, not discarded. */
async function listUsersViaSdk(params: ListUsersParams): Promise<ListUsersResult> {
	const { CognitoIdentityProviderClient, ListUsersCommand } = await import(
		'@aws-sdk/client-cognito-identity-provider'
	);
	const client = new CognitoIdentityProviderClient(awsClientConfig(params.region));
	const result = await client.send(
		new ListUsersCommand({
			UserPoolId: params.userPoolId,
			Limit: params.limit,
			...(params.paginationToken ? { PaginationToken: params.paginationToken } : {}),
		}),
	);
	const users: CognitoUser[] = (result.Users ?? []).map((user) => ({
		username: user.Username ?? '(unknown)',
		...(user.UserStatus === undefined ? {} : { status: user.UserStatus }),
		...(user.Enabled === undefined ? {} : { enabled: user.Enabled }),
		...(user.UserCreateDate === undefined ? {} : { created: user.UserCreateDate.toISOString() }),
		attributes: Object.fromEntries(
			(user.Attributes ?? [])
				.filter(
					(attribute): attribute is { Name: string; Value?: string } => typeof attribute.Name === 'string',
				)
				.map((attribute) => [attribute.Name, attribute.Value ?? '']),
		),
	}));
	return { users, ...(result.PaginationToken ? { paginationToken: result.PaginationToken } : {}) };
}
