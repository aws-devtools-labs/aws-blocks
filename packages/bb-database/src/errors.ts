// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { ApiError, brandBlocksError } from '@aws-blocks/core';
import type { StandardSchemaV1 } from '@standard-schema/spec';

/**
 * Error names for query and transaction failures. Match with
 * `isBlocksError(e, DatabaseErrors.UniqueConstraintViolation)` on either side of
 * the RPC wire. The strings are bb-data's, so an app moving between the two
 * blocks keeps its catch clauses. See the README's Errors table for when each
 * is raised and how it is retried. `ResultValidationFailed` is this block's
 * own: a row did not match the `schema` passed to `query()` or `queryOne()`.
 */
export const DatabaseErrors = {
	QueryFailed: 'QueryFailedException',
	ConnectionFailed: 'ConnectionFailedException',
	TransactionFailed: 'TransactionFailedException',
	UniqueConstraintViolation: 'UniqueConstraintViolationException',
	SerializationFailure: 'SerializationFailureException',
	TransactionRowLimitExceeded: 'TransactionRowLimitExceededException',
	ResultValidationFailed: 'ResultValidationFailedException',
} as const;

// Local mock only: deployed DSQL raises SQLSTATE 42501 (→ QueryFailed) for DDL on the app role, so this
// name is not on the public DatabaseErrors.
export const DSQL_PERMISSION_ERROR_NAME = 'DsqlPermissionException';

export const DSQL_VALIDATION_ERROR_NAME = 'DsqlValidationError';

export const PG_SERIALIZATION_FAILURE = '40001';
const PG_UNIQUE_VIOLATION = '23505';
const PG_CONNECTION_EXCEPTION_CLASS = '08';
const PG_PROGRAM_LIMIT_EXCEEDED = '54000';
const DSQL_STALE_SCHEMA_CACHE = 'OC001';

// DSQL reports both per-transaction limits as SQLSTATE 54000; only the message tells them apart:
// `transaction row limit exceeded` (3,000 rows) and `transaction size limit 10mb exceeded`.
// https://docs.aws.amazon.com/aurora-dsql/latest/userguide/CHAP_quotas.html
const DSQL_TRANSACTION_LIMIT_MESSAGE = /transaction (row|size) limit/i;

export function serializationConflict(cause: Error): ApiError {
	return new ApiError('The transaction failed due to a serialization conflict', 409, {
		name: DatabaseErrors.SerializationFailure,
		cause,
		retriable: true,
	});
}

// Not retriable: a duplicate key is deterministic.
function uniqueConstraintConflict(cause: Error): ApiError {
	return new ApiError('The item violates a unique constraint', 409, {
		name: DatabaseErrors.UniqueConstraintViolation,
		cause,
	});
}

// The message carries the row index and the schema's first issue (path and text), which describe the
// expected shape, not the data; the row itself stays on the server.
export function resultValidationFailed(rowIndex: number, issues: ReadonlyArray<StandardSchemaV1.Issue>): Error {
	const first = issues[0];
	const path = first?.path?.map((segment) => (typeof segment === 'object' ? segment.key : segment)).join('.');
	const detail = first ? `${path ? `${path}: ` : ''}${first.message}` : 'the row did not match the schema';
	const error = new Error(
		`${DatabaseErrors.ResultValidationFailed}: row ${rowIndex} did not match the result schema (${detail})`,
	);
	error.name = DatabaseErrors.ResultValidationFailed;
	return brandBlocksError(error);
}

const knownErrors = new Set<string>(Object.values(DatabaseErrors));

export function isKnownDatabaseErrorName(name: string): boolean {
	return knownErrors.has(name);
}

const RE_TAG_MESSAGES: Record<string, string> = {
	[DatabaseErrors.QueryFailed]: 'The database query failed',
	[DatabaseErrors.ConnectionFailed]: 'The database connection failed',
	[DatabaseErrors.TransactionFailed]: 'The database transaction failed',
	[DatabaseErrors.UniqueConstraintViolation]: 'The item violates a unique constraint',
	[DatabaseErrors.SerializationFailure]: 'The transaction failed due to a serialization conflict',
	[DatabaseErrors.TransactionRowLimitExceeded]:
		'The transaction changed more rows, or more data, than the cluster allows in one transaction',
};

// Only the name and a fixed message cross the wire; the driver error, with its SQLSTATE, stays on the
// server-side `cause`.
export function reTagged(name: string, cause: Error): Error {
	const message = RE_TAG_MESSAGES[name] ?? RE_TAG_MESSAGES[DatabaseErrors.QueryFailed];
	const wrapped = new Error(`${name}: ${message}`, { cause });
	wrapped.name = name;
	return brandBlocksError(wrapped);
}

function wrapError(e: unknown): never {
	const error = e instanceof Error ? e : new Error(String(e));
	const name = knownErrors.has(error.name) ? error.name : DatabaseErrors.QueryFailed;
	throw reTagged(name, error);
}

export function pgErrorCode(e: unknown): string | undefined {
	return typeof e === 'object' && e !== null && 'code' in e && typeof e.code === 'string' ? e.code : undefined;
}

function isDsqlTransactionLimit(e: unknown): boolean {
	return (
		e instanceof Error &&
		pgErrorCode(e) === PG_PROGRAM_LIMIT_EXCEEDED &&
		DSQL_TRANSACTION_LIMIT_MESSAGE.test(e.message)
	);
}

export function translatePgError(e: unknown, engineName: string): never {
	if (e instanceof Error) {
		const code = pgErrorCode(e);
		if (code === PG_SERIALIZATION_FAILURE) throw serializationConflict(e);
		if (code === PG_UNIQUE_VIOLATION) throw uniqueConstraintConflict(e);
		if (isKnownDatabaseErrorName(e.name)) throw e;
		if (isDsqlTransactionLimit(e)) throw reTagged(DatabaseErrors.TransactionRowLimitExceeded, e);
		const name = code?.startsWith(PG_CONNECTION_EXCEPTION_CLASS)
			? DatabaseErrors.ConnectionFailed
			: DatabaseErrors.QueryFailed;
		console.debug(`[${engineName}] ${name}`, { code });
		throw reTagged(name, e);
	}
	wrapError(e);
}

export function isStaleSchemaCache(e: unknown): boolean {
	const cause = e instanceof Error && e.cause instanceof Error ? e.cause : undefined;
	return pgErrorCode(e) === DSQL_STALE_SCHEMA_CACHE || pgErrorCode(cause) === DSQL_STALE_SCHEMA_CACHE;
}

export function isSerializationConflict(e: unknown): boolean {
	if (!(e instanceof Error)) return false;
	return e.name === DatabaseErrors.SerializationFailure || pgErrorCode(e) === PG_SERIALIZATION_FAILURE;
}

export function configError(message: string): Error {
	const err = new Error(message);
	err.name = 'DatabaseConfigurationError';
	return brandBlocksError(err);
}
