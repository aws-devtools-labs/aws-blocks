// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { BlockKeySchema, DiscoveredBlock, ResourceGroup, WriteMode } from '../contract/v1.js';
import { awsClientConfig } from './aws-config.js';
import { classifyCloudError, keyFieldsFromKeySchema, resolveCloudStores } from './cloud-data.js';
import { RecordValidationError, validateRecord } from './record-validate.js';

/**
 * The cloud WRITE path: DynamoDB put and delete, plus the Cognito
 * enable/disable toggle, performed with the developer's own credentials.
 *
 * Two properties are the point of this module rather than incidental to it,
 * because each is a defect in the implementation we model this on:
 *
 * 1. ONE SHARED KEY RESOLVER. Every write path resolves its key attribute
 *    names from `DescribeTable` through {@link resolveWriteTarget} — see the
 *    comment on that function for the bug this prevents.
 * 2. A REFUSAL IS NOT AN ERROR. `ConditionalCheckFailedException` means the
 *    write was correctly rejected by a precondition the caller can act on
 *    (`ALREADY_EXISTS` → edit instead, `NOT_FOUND` → create instead), so it
 *    comes back as `refusalCode` with an instruction, not as a failure. The
 *    reference returns the raw SDK message as a 500 body, which both loses
 *    that distinction and leaks account ids and ARNs to the browser.
 *
 * Nothing here rejects: every outcome — success, refusal, AWS failure — is a
 * {@link CloudWriteResult}, and no raw SDK message ever reaches the caller.
 */

/** Outcome of a write. Never thrown, always returned. */
export interface CloudWriteResult {
	ok: boolean;
	message: string;
	/** The write was understood and correctly refused; the caller can act on it. */
	refusalCode?: 'ALREADY_EXISTS' | 'NOT_FOUND' | 'VALIDATION_FAILED';
	/** The write could not be attempted or failed in AWS. */
	errorCode?: 'ACCESS_DENIED' | 'CREDENTIALS_EXPIRED' | 'CREDENTIALS_MISSING' | 'STORE_NOT_FOUND' | 'UNKNOWN';
}

/** `PutItem` as this module needs it, so the SDK stays behind a seam. */
export interface PutItemParams {
	tableName: string;
	item: Record<string, unknown>;
	conditionExpression: string;
	expressionAttributeNames: Record<string, string>;
	region?: string;
}

/** `DeleteItem` as this module needs it, so the SDK stays behind a seam. */
export interface DeleteItemParams {
	tableName: string;
	key: Record<string, string>;
	conditionExpression: string;
	expressionAttributeNames: Record<string, string>;
	region?: string;
}

/** `AdminEnableUser` / `AdminDisableUser` as this module needs it. */
export interface SetUserEnabledParams {
	userPoolId: string;
	username: string;
	enabled: boolean;
	region?: string;
}

/** What to write to, and the seams that stand in for AWS in a test. */
export interface CloudWriteContext {
	block: DiscoveredBlock;
	groups: ResourceGroup[];
	store?: string;
	region?: string;
	/** Test seams; default to the real SDK calls. */
	describeTable?: (tableName: string, region?: string) => Promise<string[]>;
	putItem?: (params: PutItemParams) => Promise<void>;
	deleteItem?: (params: DeleteItemParams) => Promise<void>;
	setUserEnabled?: (params: SetUserEnabledParams) => Promise<void>;
}

/** A DynamoDB write target with its key schema already read from the table. */
interface WriteTarget {
	tableName: string;
	/** Key attribute names in key order: HASH first, then RANGE. */
	keyFields: string[];
	keySchema: BlockKeySchema;
}

type TargetResolution = { resolved: true; target: WriteTarget } | { resolved: false; result: CloudWriteResult };

const DYNAMODB_WRITE_ACTIONS = 'dynamodb:DescribeTable and the write action';
const COGNITO_WRITE_ACTIONS = 'cognito-idp:AdminEnableUser and cognito-idp:AdminDisableUser';

/**
 * Resolves the table to write to AND its key attribute names, from
 * `DescribeTable`. THE ONE PLACE either write path learns how the table is
 * keyed.
 *
 * THE IMPROVEMENT: the reference gets this exactly half right. Its
 * `putCloudItem` reads `DescribeTable` correctly, while its sibling
 * `deleteCloudItem` hardcodes `pk`/`sk` and guards with
 * `attribute_exists(pk)`. On any table keyed otherwise — the testbed app keys
 * on `userId`/`todoId` — delete fails with a raw `ValidationException` that
 * surfaces as a 500, while put on the very same table succeeds. Two sibling
 * write paths disagreeing about how keys work is precisely the bug a shared
 * helper prevents, so both paths call this function and neither one is allowed
 * to name a key attribute itself. `cloud-writes.test.ts` pins the delete path's
 * `DescribeTable` call as a regression test.
 */
async function resolveWriteTarget(context: CloudWriteContext): Promise<TargetResolution> {
	const { tableNames } = resolveCloudStores(context.block, context.groups);
	const requested = context.store;
	const tableName = requested === undefined ? tableNames[0] : tableNames.find((name) => name === requested);

	if (tableName === undefined) {
		return {
			resolved: false,
			result: {
				ok: false,
				errorCode: 'STORE_NOT_FOUND',
				message:
					requested === undefined
						? `No DynamoDB table is attributed to block "${context.block.fullId}", so there is nothing to write to.`
						: `"${requested}" is not a DynamoDB table of block "${context.block.fullId}".`,
			},
		};
	}

	const describeTable = context.describeTable ?? describeTableKeyFieldsViaSdk;
	let keyFields: string[];
	try {
		keyFields = await describeTable(tableName, context.region);
	} catch (error) {
		return { resolved: false, result: awsFailure(error, tableName, DYNAMODB_WRITE_ACTIONS) };
	}

	if (keyFields.length === 0) {
		return {
			resolved: false,
			result: {
				ok: false,
				errorCode: 'STORE_NOT_FOUND',
				message: `The key schema of "${tableName}" could not be read, so a write cannot be keyed safely.`,
			},
		};
	}

	// `BlockKeySchema` is what `record-validate` speaks, and it is built HERE
	// from the described names rather than from anything the block source or the
	// caller claimed — the table itself is the only authority.
	const [partitionKey, sortKey] = keyFields;
	const keySchema: BlockKeySchema = {
		partitionKey: partitionKey as string,
		...(sortKey === undefined ? {} : { sortKey }),
	};
	return { resolved: true, target: { tableName, keyFields, keySchema } };
}

/**
 * `#k0`, `#k1`, ... for the key attributes.
 *
 * Key names go through `ExpressionAttributeNames` rather than into the
 * expression text, so a key called `size` or `status` — both DynamoDB reserved
 * words — does not turn a correct write into a `ValidationException`.
 */
function keyNamePlaceholders(keyFields: string[]): Record<string, string> {
	const names: Record<string, string> = {};
	keyFields.forEach((field, index) => {
		names[`#k${index}`] = field;
	});
	return names;
}

function keyCondition(keyFields: string[], guard: 'attribute_exists' | 'attribute_not_exists'): string {
	return keyFields.map((_field, index) => `${guard}(#k${index})`).join(' AND ');
}

/**
 * Writes one record, guarded by the mode.
 *
 * The item is marshalled by `@aws-sdk/lib-dynamodb`'s document client, so plain
 * JS values go in without hand-built `{ S: '...' }` attribute values. NOTE the
 * cost of that convenience: a DynamoDB `N` unmarshals to a JS number, so a
 * read-edit-write round trip of an integer beyond 2^53 or of a high-precision
 * decimal silently loses fidelity. That is why `record-validate` REFUSES the
 * types JSON cannot express rather than pretending the round trip is lossless.
 */
export async function putCloudRecord(
	context: CloudWriteContext,
	item: unknown,
	mode: WriteMode,
): Promise<CloudWriteResult> {
	const resolution = await resolveWriteTarget(context);
	if (!resolution.resolved) return resolution.result;
	const { tableName, keyFields, keySchema } = resolution.target;

	try {
		// Asserts, so `item` is a record from here on. A RecordValidationError is
		// a refusal carrying its own message — never rethrown at the caller.
		validateRecord(item, keySchema);
	} catch (error) {
		if (error instanceof RecordValidationError) {
			return { ok: false, refusalCode: 'VALIDATION_FAILED', message: error.message };
		}
		return awsFailure(error, tableName, DYNAMODB_WRITE_ACTIONS);
	}

	const expressionAttributeNames = keyNamePlaceholders(keyFields);
	const conditionExpression = keyCondition(
		keyFields,
		mode === 'create' ? 'attribute_not_exists' : 'attribute_exists',
	);
	const putItem = context.putItem ?? putItemViaSdk;

	try {
		await putItem({
			tableName,
			item,
			conditionExpression,
			expressionAttributeNames,
			...(context.region === undefined ? {} : { region: context.region }),
		});
	} catch (error) {
		// A failed precondition is the answer to the question the mode asked, not
		// a fault: say which one failed and what to do instead.
		if (isConditionalCheckFailure(error)) {
			return mode === 'create'
				? {
						ok: false,
						refusalCode: 'ALREADY_EXISTS',
						message: 'A record with this key already exists — use edit to change it.',
					}
				: {
						ok: false,
						refusalCode: 'NOT_FOUND',
						message: 'No record with this key exists — use create to add it.',
					};
		}
		return awsFailure(error, tableName, DYNAMODB_WRITE_ACTIONS);
	}

	return {
		ok: true,
		message: mode === 'create' ? `Created the record in "${tableName}".` : `Saved the record in "${tableName}".`,
	};
}

/** Deletes one record, addressed by the key attributes the TABLE declares. */
export async function deleteCloudRecord(
	context: CloudWriteContext,
	keyValues: Record<string, string>,
): Promise<CloudWriteResult> {
	const resolution = await resolveWriteTarget(context);
	if (!resolution.resolved) return resolution.result;
	const { tableName, keyFields } = resolution.target;

	const key: Record<string, string> = {};
	for (const field of keyFields) {
		const value = keyValues[field];
		if (typeof value !== 'string' || value.length === 0) {
			// Refused here, with the field named, rather than sent to DynamoDB to
			// come back as a ValidationException nobody can act on.
			return {
				ok: false,
				refusalCode: 'VALIDATION_FAILED',
				message: `Key field "${field}" is required and must be a non-empty string.`,
			};
		}
		key[field] = value;
	}

	const expressionAttributeNames = keyNamePlaceholders(keyFields);
	const deleteItem = context.deleteItem ?? deleteItemViaSdk;

	try {
		await deleteItem({
			tableName,
			key,
			// Guarded on the partition key so deleting something already gone
			// reports NOT_FOUND. An unconditional delete succeeds on a missing
			// record, and a silent success on a destructive action is a trap: it
			// reads as "deleted" when nothing was.
			conditionExpression: keyCondition(keyFields.slice(0, 1), 'attribute_exists'),
			expressionAttributeNames,
			...(context.region === undefined ? {} : { region: context.region }),
		});
	} catch (error) {
		if (isConditionalCheckFailure(error)) {
			return {
				ok: false,
				refusalCode: 'NOT_FOUND',
				message: 'No record with this key exists — it may already have been deleted.',
			};
		}
		return awsFailure(error, tableName, DYNAMODB_WRITE_ACTIONS);
	}

	return { ok: true, message: `Deleted the record from "${tableName}".` };
}

/**
 * Enables or disables a user in the block's user pool.
 *
 * NOT WIRED, deliberately — see DESIGN.md D31. Nothing calls this: there is no
 * route, no provider method and no UI for it. It is kept because it is complete
 * and tested, including the `UserNotFoundException` collision below that is easy
 * to get wrong; wiring it needs a confirmation flow and a decision about whether
 * the unlock gate should cover it, which is a design question rather than a
 * missing import. Do not connect it to a route without answering that.
 *
 * Disabling is the reversible action a dashboard should offer; user DELETION is
 * deliberately absent, because it is irreversible, cascades into whatever keys
 * records by user id, and needs its own thought rather than a sibling flag here.
 */
export async function setCognitoUserEnabled(
	context: CloudWriteContext,
	username: string,
	enabled: boolean,
): Promise<CloudWriteResult> {
	const { userPoolId } = resolveCloudStores(context.block, context.groups);
	if (userPoolId === undefined) {
		return {
			ok: false,
			errorCode: 'STORE_NOT_FOUND',
			message: `No Cognito user pool is attributed to block "${context.block.fullId}".`,
		};
	}
	if (typeof username !== 'string' || username.length === 0) {
		return { ok: false, refusalCode: 'VALIDATION_FAILED', message: 'A username is required.' };
	}

	const setUserEnabled = context.setUserEnabled ?? setUserEnabledViaSdk;
	try {
		await setUserEnabled({
			userPoolId,
			username,
			enabled,
			...(context.region === undefined ? {} : { region: context.region }),
		});
	} catch (error) {
		// Checked before classification: `UserNotFoundException`'s message is
		// "User does not exist.", which the shared classifier's /does not exist/
		// pattern would read as a missing STACK. It is neither an error nor a
		// missing store — the pool is fine, that one user is not in it.
		if (isUserNotFound(error)) {
			return {
				ok: false,
				refusalCode: 'NOT_FOUND',
				message: 'That user no longer exists in this user pool.',
			};
		}
		return awsFailure(error, userPoolId, COGNITO_WRITE_ACTIONS);
	}

	return { ok: true, message: enabled ? `Enabled user "${username}".` : `Disabled user "${username}".` };
}

function isConditionalCheckFailure(error: unknown): boolean {
	const name = error instanceof Error ? error.name : '';
	const message = error instanceof Error ? error.message : String(error);
	return /ConditionalCheckFailed/i.test(`${name} ${message}`);
}

function isUserNotFound(error: unknown): boolean {
	const name = error instanceof Error ? error.name : '';
	return /^UserNotFound/.test(name);
}

/**
 * Classifies an AWS write failure and explains it in OUR words.
 *
 * The vocabulary is the read path's `classifyCloudError` — one classifier for
 * both directions, so ACCESS_DENIED does not read as a missing table on one
 * path and as UNKNOWN on the other. `STACK_NOT_FOUND` collapses into
 * `STORE_NOT_FOUND`: a write consults no stack, so a "does not exist" here is
 * the table or the pool.
 */
function awsFailure(error: unknown, storeId: string, action: string): CloudWriteResult {
	const classified = classifyCloudError(error);
	const errorCode = classified === 'STACK_NOT_FOUND' ? 'STORE_NOT_FOUND' : classified;
	return { ok: false, errorCode, message: explainWriteError(errorCode, storeId, action) };
}

/** Human explanation per code. Written here, so no SDK text is ever echoed out. */
function explainWriteError(code: NonNullable<CloudWriteResult['errorCode']>, storeId: string, action: string): string {
	switch (code) {
		case 'ACCESS_DENIED':
			return `Access denied writing to "${storeId}". The credentials in use are valid but lack ${action} on it.`;
		case 'CREDENTIALS_EXPIRED':
			return 'AWS credentials have expired. Refresh them (for example re-run your SSO login) and try again.';
		case 'CREDENTIALS_MISSING':
			return 'No AWS credentials could be loaded. Set a profile with --profile, or configure the default chain.';
		case 'STORE_NOT_FOUND':
			return `"${storeId}" was not found. It may have been deleted, or the stage may be deployed in another region.`;
		default:
			return `The write to "${storeId}" failed. The underlying AWS error is in the dashboard server log.`;
	}
}

/**
 * Default `describeTable` seam. Dynamic import: the SDK loads only on a real
 * write. Delegates the HASH-before-RANGE ordering to the read path's exported
 * `keyFieldsFromKeySchema`, so both directions read a key schema identically.
 */
async function describeTableKeyFieldsViaSdk(tableName: string, region?: string): Promise<string[]> {
	const { DynamoDBClient, DescribeTableCommand } = await import('@aws-sdk/client-dynamodb');
	const client = new DynamoDBClient(awsClientConfig(region));
	const result = await client.send(new DescribeTableCommand({ TableName: tableName }));
	return keyFieldsFromKeySchema(result.Table?.KeySchema);
}

/** Default `putItem` seam, through the document client so plain JS marshals. */
async function putItemViaSdk(params: PutItemParams): Promise<void> {
	const { DynamoDBClient } = await import('@aws-sdk/client-dynamodb');
	const { DynamoDBDocumentClient, PutCommand } = await import('@aws-sdk/lib-dynamodb');
	const client = DynamoDBDocumentClient.from(new DynamoDBClient(awsClientConfig(params.region)));
	await client.send(
		new PutCommand({
			TableName: params.tableName,
			Item: params.item,
			ConditionExpression: params.conditionExpression,
			ExpressionAttributeNames: params.expressionAttributeNames,
		}),
	);
}

/** Default `deleteItem` seam, through the same document client. */
async function deleteItemViaSdk(params: DeleteItemParams): Promise<void> {
	const { DynamoDBClient } = await import('@aws-sdk/client-dynamodb');
	const { DynamoDBDocumentClient, DeleteCommand } = await import('@aws-sdk/lib-dynamodb');
	const client = DynamoDBDocumentClient.from(new DynamoDBClient(awsClientConfig(params.region)));
	await client.send(
		new DeleteCommand({
			TableName: params.tableName,
			Key: params.key,
			ConditionExpression: params.conditionExpression,
			ExpressionAttributeNames: params.expressionAttributeNames,
		}),
	);
}

/** Default `setUserEnabled` seam. */
async function setUserEnabledViaSdk(params: SetUserEnabledParams): Promise<void> {
	const { CognitoIdentityProviderClient, AdminDisableUserCommand, AdminEnableUserCommand } = await import(
		'@aws-sdk/client-cognito-identity-provider'
	);
	const client = new CognitoIdentityProviderClient(awsClientConfig(params.region));
	const input = { UserPoolId: params.userPoolId, Username: params.username };
	await client.send(params.enabled ? new AdminEnableUserCommand(input) : new AdminDisableUserCommand(input));
}
