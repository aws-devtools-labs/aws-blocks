// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { ApiError, brandBlocksError } from '@aws-blocks/core';

/**
 * Standardized error constants for the Database Building Block.
 *
 * Every engine translates its driver errors to these names, so the same code
 * matches on every kind of cluster and on both sides of the RPC wire:
 * `isBlocksError(e, DatabaseErrors.UniqueConstraintViolation)`.
 *
 * | Error | Kinds | When |
 * |---|---|---|
 * | `QueryFailed` | all | any SQL error (the SQLSTATE stays on the server-side `cause`) |
 * | `ConnectionFailed` | `provisioned`, external | endpoint, secret, or network failure |
 * | `TransactionFailed` | all | the callback threw, or commit failed for a reason other than a conflict |
 * | `UniqueConstraintViolation` | all | SQLSTATE `23505`; HTTP 409, not retriable |
 * | `SerializationFailure` | all; `distributed` in practice | SQLSTATE `40001` at commit; HTTP 409, retriable |
 * | `TransactionRowLimitExceeded` | `distributed` | more than 3,000 rows mutated in one transaction |
 */
export const DatabaseErrors = {
	QueryFailed: 'QueryFailedException',
	ConnectionFailed: 'ConnectionFailedException',
	TransactionFailed: 'TransactionFailedException',
	UniqueConstraintViolation: 'UniqueConstraintViolationException',
	SerializationFailure: 'SerializationFailureException',
	TransactionRowLimitExceeded: 'TransactionRowLimitExceededException',
} as const;

/**
 * Error name raised by the mock's DDL guard when a DDL statement runs on the
 * app-runtime connection of a `distributed` cluster, which is DML-only (parity
 * with the deployed `dsql:DbConnect` grant). Mock-path only: on the deployed
 * path DSQL rejects the statement with SQLSTATE 42501, which falls through to
 * `QueryFailed`, so this is deliberately not on the public {@link DatabaseErrors}.
 */
export const DSQL_PERMISSION_ERROR_NAME = 'DsqlPermissionException';

/** Error name raised when a statement or migration uses a feature a `distributed` cluster lacks. */
export const DSQL_VALIDATION_ERROR_NAME = 'DsqlValidationError';

/** Serialization failure — OCC conflict. SQLSTATE class 40 (Transaction Rollback). */
export const PG_SERIALIZATION_FAILURE = '40001';
/** Unique constraint violation. SQLSTATE class 23 (Integrity Constraint Violation). */
export const PG_UNIQUE_VIOLATION = '23505';
/** Connection exception class prefix. SQLSTATE class 08. */
export const PG_CONNECTION_EXCEPTION_CLASS = '08';
/** Aurora DSQL: stale schema cache. Retried anywhere, because the fix is a catalog refresh. */
export const DSQL_STALE_SCHEMA_CACHE = 'OC001';

/** The single message text for the `withRLS()` / `crud()` capability gap, shared by the compiler doc comment and the runtime check. */
export const RLS_UNAVAILABLE_MESSAGE =
	"Not available on a 'distributed' cluster. Use type: 'provisioned' or DatabaseCluster.fromExisting().";

/**
 * Data API exception names that mean "the cluster is not accepting statements yet"
 * rather than "the statement is wrong": a service-side transient, or a
 * `minCapacity: 0` cluster resuming from auto-pause.
 */
export const TRANSIENT_DATA_API_ERROR_NAMES: ReadonlySet<string> = new Set([
	'ServiceUnavailableException',
	'InternalServerErrorException',
	'DatabaseResumingException',
]);

/**
 * Build the 409 ApiError for a serialization-failure (SQLSTATE 40001) conflict.
 * Preserves the `SerializationFailure` name, keeps the driver error as `cause`
 * (server-side only), and flags the conflict retriable.
 */
export function serializationConflict(cause: Error): ApiError {
	return new ApiError('The transaction failed due to a serialization conflict', 409, {
		name: DatabaseErrors.SerializationFailure,
		cause,
		retriable: true,
	});
}

/**
 * Build the 409 ApiError for a unique-constraint violation (SQLSTATE 23505).
 * Not retriable: a duplicate key is deterministic.
 */
export function uniqueConstraintConflict(cause: Error): ApiError {
	return new ApiError('The item violates a unique constraint', 409, {
		name: DatabaseErrors.UniqueConstraintViolation,
		cause,
	});
}

const knownErrors = new Set<string>(Object.values(DatabaseErrors));

/** Whether `name` is one of the {@link DatabaseErrors} names (an already-translated BB error). */
export function isKnownDatabaseErrorName(name: string): boolean {
	return knownErrors.has(name);
}

/**
 * Stable, BB-authored client-facing messages per error name. The raw driver
 * text is never sent — it is kept only as `cause` for server-side diagnostics.
 */
const RE_TAG_MESSAGES: Record<string, string> = {
	[DatabaseErrors.QueryFailed]: 'The database query failed',
	[DatabaseErrors.ConnectionFailed]: 'The database connection failed',
	[DatabaseErrors.TransactionFailed]: 'The database transaction failed',
	[DatabaseErrors.UniqueConstraintViolation]: 'The item violates a unique constraint',
	[DatabaseErrors.SerializationFailure]: 'The transaction failed due to a serialization conflict',
	[DatabaseErrors.TransactionRowLimitExceeded]: 'The transaction mutated more rows than the cluster allows',
};

/**
 * Build a BRANDED re-tag error: a fresh `Error` carrying the BB `name` and a
 * stable message, with the original driver error kept as `cause`. The name
 * crosses the wire; the driver text never does.
 */
export function reTagged(name: string, cause: Error): Error {
	const message = RE_TAG_MESSAGES[name] ?? RE_TAG_MESSAGES[DatabaseErrors.QueryFailed];
	const wrapped = new Error(`${name}: ${message}`, { cause });
	wrapped.name = name;
	return brandBlocksError(wrapped);
}

/** Wrap an unknown caught value with a standardized {@link DatabaseErrors} name. */
export function wrapError(e: unknown): never {
	const error = e instanceof Error ? e : new Error(String(e));
	const name = knownErrors.has(error.name) ? error.name : DatabaseErrors.QueryFailed;
	throw reTagged(name, error);
}

/** Read a pg driver error's SQLSTATE `code` without a cast. */
export function pgErrorCode(e: unknown): string | undefined {
	return typeof e === 'object' && e !== null && 'code' in e && typeof e.code === 'string' ? e.code : undefined;
}

/**
 * Translate a PostgreSQL-protocol driver error (pg, PGlite, DSQL over pg) to a
 * {@link DatabaseErrors} name. Used by every socket-based engine.
 */
export function translatePgError(e: unknown, engineName: string): never {
	if (e instanceof Error) {
		const code = pgErrorCode(e);
		if (code === PG_SERIALIZATION_FAILURE) throw serializationConflict(e);
		if (code === PG_UNIQUE_VIOLATION) throw uniqueConstraintConflict(e);
		if (isKnownDatabaseErrorName(e.name)) throw e;
		const name = code?.startsWith(PG_CONNECTION_EXCEPTION_CLASS)
			? DatabaseErrors.ConnectionFailed
			: DatabaseErrors.QueryFailed;
		console.debug(`[${engineName}] ${name}`, { code });
		throw reTagged(name, e);
	}
	wrapError(e);
}

/** Whether an error (or its `cause`) is the DSQL stale-schema-cache condition worth a transparent retry. */
export function isStaleSchemaCache(e: unknown): boolean {
	const cause = e instanceof Error && e.cause instanceof Error ? e.cause : undefined;
	return pgErrorCode(e) === DSQL_STALE_SCHEMA_CACHE || pgErrorCode(cause) === DSQL_STALE_SCHEMA_CACHE;
}

/** Whether an error is a serialization conflict (translated or raw). */
export function isSerializationConflict(e: unknown): boolean {
	if (!(e instanceof Error)) return false;
	return e.name === DatabaseErrors.SerializationFailure || pgErrorCode(e) === PG_SERIALIZATION_FAILURE;
}

/** Build a branded configuration/usage error with a BB-authored message. */
export function configError(message: string): Error {
	const err = new Error(message);
	err.name = 'DatabaseConfigurationError';
	return brandBlocksError(err);
}

/** Build the branded error for the `withRLS()` / `crud()` capability gap. */
export function rlsUnavailable(): Error {
	const err = new Error(RLS_UNAVAILABLE_MESSAGE);
	err.name = 'DatabaseCapabilityError';
	return brandBlocksError(err);
}
