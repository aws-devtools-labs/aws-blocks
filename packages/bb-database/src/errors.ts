// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { ApiError, blocksError, brandBlocksError } from '@aws-blocks/core';
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

// A migration file dsql-lint rejects; thrown at construction (local) and at synth (CDK), before anything runs.
export const DSQL_MIGRATION_VALIDATION_ERROR_NAME = 'DsqlMigrationValidationError';

// A migration step that failed on the cluster; the runner resumes at it on the next deploy.
export const MIGRATION_FAILED_ERROR_NAME = 'MigrationFailedException';

export const PG_SERIALIZATION_FAILURE = '40001';
const PG_UNIQUE_VIOLATION = '23505';
const PG_CONNECTION_EXCEPTION_CLASS = '08';
const PG_ADMIN_SHUTDOWN = '57P01';
const PG_PROGRAM_LIMIT_EXCEEDED = '54000';
const DSQL_STALE_SCHEMA_CACHE = 'OC001';
const DSQL_STALE_SCHEMA_CACHE_MESSAGE = /\bOC001\b/;

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

/** A named error whose name survives the RPC serializer; `cause` is non-enumerable, for server-side logs. */
export function brandedError(name: string, message: string, cause?: unknown): Error {
	const error = new Error(`${name}: ${message}`, cause === undefined ? undefined : { cause });
	error.name = name;
	return brandBlocksError(error);
}

// The message, which reaches the client, carries the row index and the first issue's path (a column name).
// The library's issue messages can quote the row's values (zod: `… received 'refunded'`), so they stay on the
// non-enumerable `cause`, with the full `issues` array, for server-side logs.
export function resultValidationFailed(rowIndex: number, issues: ReadonlyArray<StandardSchemaV1.Issue>): Error {
	const path = issues[0]?.path?.map((segment) => (typeof segment === 'object' ? segment.key : segment)).join('.');
	const cause = Object.assign(new Error(issues[0]?.message ?? 'the row did not match the schema'), { issues });
	return reTagged(DatabaseErrors.ResultValidationFailed, cause, ` (row ${rowIndex}${path ? ` at '${path}'` : ''})`);
}

const knownErrors = new Set<string>(Object.values(DatabaseErrors));

export function isKnownDatabaseErrorName(name: string): boolean {
	return knownErrors.has(name);
}

const RE_TAG_MESSAGES = {
	[DatabaseErrors.QueryFailed]: 'The database query failed',
	[DatabaseErrors.ConnectionFailed]: 'The database connection failed',
	[DatabaseErrors.TransactionFailed]: 'The database transaction failed',
	[DatabaseErrors.TransactionRowLimitExceeded]:
		'The transaction changed more rows, or more data, than the cluster allows in one transaction',
	[DatabaseErrors.ResultValidationFailed]: 'A row did not match the result schema',
} as const;

// Only the name, a fixed message and an optional `detail` free of row values cross the wire; the driver error,
// with its SQLSTATE, stays on the server-side `cause`.
export function reTagged(name: keyof typeof RE_TAG_MESSAGES, cause: Error, detail = ''): Error {
	return brandedError(name, `${RE_TAG_MESSAGES[name]}${detail}`, cause);
}

// A handle whose transaction has ended, used by a statement that ran after commit or rollback: typically a
// promise the transaction() callback did not await.
export function transactionEnded(): Error {
	return reTagged(DatabaseErrors.TransactionFailed, new Error('the transaction has already ended'));
}

export function foreignTransactionHandle(engineName: string): Error {
	return reTagged(DatabaseErrors.TransactionFailed, new Error(`not a ${engineName} transaction handle`));
}

export const asError = (e: unknown): Error => (e instanceof Error ? e : new Error(String(e)));

/** Wraps an engine operation so a driver error it throws is translated by `translatePgError` under `engineName`. */
export function translated(engineName: string): <T>(fn: () => Promise<T>) => Promise<T> {
	return (fn) => fn().catch((e) => translatePgError(e, engineName));
}

export function pgErrorCode(e: unknown): string | undefined {
	return typeof e === 'object' && e !== null && 'code' in e && typeof e.code === 'string' ? e.code : undefined;
}

function isDsqlTransactionLimit(e: Error): boolean {
	return pgErrorCode(e) === PG_PROGRAM_LIMIT_EXCEEDED && DSQL_TRANSACTION_LIMIT_MESSAGE.test(e.message);
}

export function translatePgError(raw: unknown, engineName: string): never {
	const e = asError(raw);
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

// DSQL reports a stale catalog as SQLSTATE 40001 with `OC001` in the message
// (`schema has been updated by another transaction (OC001)`); the code form is kept for a server that reports it as
// the SQLSTATE.
function isStaleSchemaCacheError(e: unknown): boolean {
	const code = pgErrorCode(e);
	if (code === DSQL_STALE_SCHEMA_CACHE) return true;
	return code === PG_SERIALIZATION_FAILURE && e instanceof Error && DSQL_STALE_SCHEMA_CACHE_MESSAGE.test(e.message);
}

export function isStaleSchemaCache(e: unknown): boolean {
	const cause = e instanceof Error && e.cause instanceof Error ? e.cause : undefined;
	return isStaleSchemaCacheError(e) || isStaleSchemaCacheError(cause);
}

/** The connection is gone (SQLSTATE class 08) or the server ended it (57P01); the pool replaces it on the next checkout. */
export function isConnectionLost(e: unknown): boolean {
	const code = pgErrorCode(e);
	return code === PG_ADMIN_SHUTDOWN || (code?.startsWith(PG_CONNECTION_EXCEPTION_CLASS) ?? false);
}

export function isSerializationConflict(e: unknown): boolean {
	if (!(e instanceof Error)) return false;
	return e.name === DatabaseErrors.SerializationFailure || pgErrorCode(e) === PG_SERIALIZATION_FAILURE;
}

export function configError(message: string): Error {
	return blocksError('DatabaseConfigurationError', message);
}
