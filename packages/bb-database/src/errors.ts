// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { ApiError, blocksError, brandBlocksError } from '@aws-cdk-blocks/core';
import type { StandardSchemaV1 } from '@standard-schema/spec';

/**
 * Error names for query and transaction failures. Match with
 * `isBlocksError(e, DatabaseErrors.UniqueConstraintViolation)` on either side of
 * the RPC wire. See the README's Errors table for when each
 * is raised and how it is retried. `ResultValidationFailed` is this block's
 * own: a row did not match the `schema` passed to `query()` or `queryOne()`.
 * `PermissionDenied` (HTTP 403) comes only from a statement on a database
 * from `asUser()`: a Row Level Security policy refused the row.
 * `CheckViolation` and `NotNullViolation` (HTTP 400) and `ForeignKeyViolation`
 * (HTTP 409) are the constraint the statement broke; none is retried.
 */
export const DatabaseErrors = {
	QueryFailed: 'QueryFailedException',
	ConnectionFailed: 'ConnectionFailedException',
	TransactionFailed: 'TransactionFailedException',
	UniqueConstraintViolation: 'UniqueConstraintViolationException',
	SerializationFailure: 'SerializationFailureException',
	TransactionRowLimitExceeded: 'TransactionRowLimitExceededException',
	ResultValidationFailed: 'ResultValidationFailedException',
	PermissionDenied: 'PermissionDeniedException',
	CheckViolation: 'CheckViolationException',
	NotNullViolation: 'NotNullViolationException',
	ForeignKeyViolation: 'ForeignKeyViolationException',
} as const;

export const DSQL_VALIDATION_ERROR_NAME = 'DsqlValidationError';

// A migration file the cluster cannot run (dsql-lint on dsql; a DSQL-only form on aurora); thrown at construction
// (local) and at synth (CDK), before anything runs.
export const MIGRATION_VALIDATION_ERROR_NAME = 'MigrationValidationError';

// A migration step that failed on the cluster; the runner resumes at it on the next deploy.
export const MIGRATION_FAILED_ERROR_NAME = 'MigrationFailedException';

export const PG_SERIALIZATION_FAILURE = '40001';
export const PG_UNIQUE_VIOLATION = '23505';
const PG_CONNECTION_EXCEPTION_CLASS = '08';
const PG_ADMIN_SHUTDOWN = '57P01';
// A socket that died surfaces from pg with no SQLSTATE; a connect that timed out likewise.
// The last form is pg's answer to a statement on a client whose connection has already failed.
const PG_SOCKET_ERROR_MESSAGE =
	/Connection terminated|ECONNRESET|EPIPE|ECONNREFUSED|ENOTFOUND|socket hang up|is not queryable/i;
// pg-pool's wait for a connection, and pg's own connect timer.
const PG_CONNECT_TIMEOUT_MESSAGE =
	/timeout exceeded when trying to connect|Connection terminated due to connection timeout/i;
// A connection the server never accepted. Node reports the socket and TLS failures with these codes; PostgreSQL
// reports a refused login (class 28), a missing database, too many clients and a server that is starting up.
const NODE_SOCKET_LOST_CODES = new Set(['ECONNRESET', 'EPIPE']);
const NODE_CONNECT_REFUSED_CODES = new Set([
	'ECONNREFUSED',
	'ENOTFOUND',
	'EAI_AGAIN',
	'ETIMEDOUT',
	'EHOSTUNREACH',
	'ENETUNREACH',
	'EADDRNOTAVAIL',
]);
const TLS_ERROR_CODE = /^(?:ERR_TLS_|ERR_SSL_|UNABLE_TO_|SELF_SIGNED_|DEPTH_ZERO_|CERT_|HOSTNAME_MISMATCH)/;
export const PG_INVALID_AUTHORIZATION_CLASS = '28';
/** `cannot_connect_now`: the server is starting, or a paused cluster resumes. */
export const PG_CANNOT_CONNECT_NOW = '57P03';
const PG_REFUSED_CODES = new Set(['3D000', '53300', PG_CANNOT_CONNECT_NOW]);
// Of the refusals, the ones that pass: the server is full or still starting, or the address did not answer or
// resolve this time.
const REFUSED_FOR_NOW_CODES = new Set(['53300', PG_CANNOT_CONNECT_NOW, 'EAI_AGAIN', 'ETIMEDOUT']);
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

export const PG_INSUFFICIENT_PRIVILEGE = '42501';

// Only for a statement of a user-scoped database (DESIGN §4.5). Anywhere else 42501 is the application's own
// mistake, such as DDL in a handler, and stays a QueryFailed.
export function permissionDenied(cause: Error): ApiError {
	return new ApiError('The statement was refused by a Row Level Security policy or a missing privilege', 403, {
		name: DatabaseErrors.PermissionDenied,
		cause,
	});
}

// A statement that breaks a constraint. Not retriable: the same statement on the same rows breaks it again.
// The messages are fixed, because the server's own text names the row's values; that text stays on the
// non-enumerable `cause`.
const CONSTRAINT_VIOLATIONS = new Map<string, (cause: Error) => ApiError>([
	[
		PG_UNIQUE_VIOLATION,
		(cause) =>
			new ApiError('The item violates a unique constraint', 409, {
				name: DatabaseErrors.UniqueConstraintViolation,
				cause,
			}),
	],
	[
		'23514',
		(cause) =>
			new ApiError('A value violates a check constraint', 400, { name: DatabaseErrors.CheckViolation, cause }),
	],
	[
		'23502',
		(cause) => new ApiError('A required value is missing', 400, { name: DatabaseErrors.NotNullViolation, cause }),
	],
	[
		'23503',
		(cause) =>
			new ApiError('The item violates a foreign key constraint', 409, {
				name: DatabaseErrors.ForeignKeyViolation,
				cause,
			}),
	],
]);

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

// Local mode only: the statement would otherwise wait forever (DESIGN §4.4).
export function sessionTransactionOpen(waitedMs: number): Error {
	return brandedError(
		DatabaseErrors.QueryFailed,
		`A statement waited ${waitedMs / 1000} s for the local database while a Kysely transaction was open. ` +
			'Inside a Kysely transaction, run every statement on `trx`. A statement on the block or on the root ' +
			'Kysely instance is not part of that transaction: locally it waits for it to end, and on AWS it runs ' +
			'outside it on another connection.',
	);
}

export const asError = (e: unknown): Error => (e instanceof Error ? e : new Error(String(e)));

/** Wraps an engine operation so a driver error it throws is translated by `translatePgError` under `engineName`. */
export function translated(engineName: string): <T>(fn: () => Promise<T>) => Promise<T> {
	return (fn) => fn().catch((e) => translatePgError(e, engineName));
}

export function pgErrorCode(e: unknown): string | undefined {
	return typeof e === 'object' && e !== null && 'code' in e && typeof e.code === 'string' ? e.code : undefined;
}

/** `e` and the errors under it, outermost first: each layer re-tags the error below and keeps it as `cause`. */
export function causeChain(e: unknown): Error[] {
	const chain: Error[] = [];
	for (let err = e; err instanceof Error && chain.length < 6; err = err.cause) chain.push(err);
	return chain;
}

/** The SQLSTATE of `e`, or of the first error under it that has one. */
export function sqlStateOf(e: unknown): string | undefined {
	for (const err of causeChain(e)) {
		const code = pgErrorCode(err);
		if (code !== undefined) return code;
	}
	return pgErrorCode(e);
}

function isDsqlTransactionLimit(e: Error): boolean {
	return pgErrorCode(e) === PG_PROGRAM_LIMIT_EXCEEDED && DSQL_TRANSACTION_LIMIT_MESSAGE.test(e.message);
}

export function translatePgError(raw: unknown, engineName: string): never {
	const e = asError(raw);
	const code = pgErrorCode(e);
	if (code === PG_SERIALIZATION_FAILURE) throw serializationConflict(e);
	const violation = code === undefined ? undefined : CONSTRAINT_VIOLATIONS.get(code);
	if (violation) throw violation(e);
	if (isKnownDatabaseErrorName(e.name)) throw e;
	if (isDsqlTransactionLimit(e)) throw reTagged(DatabaseErrors.TransactionRowLimitExceeded, e);
	const refused = isConnectionRefused(e);
	const name =
		isConnectionLost(e) || isConnectTimeout(e) || refused
			? DatabaseErrors.ConnectionFailed
			: DatabaseErrors.QueryFailed;
	// A refused connection is a setup problem (trust, address, login); its driver text names the host or the
	// role, never the password, and is what the operator needs in the function's log.
	if (refused) console.error(`[${engineName}] ${name}`, { code, reason: e.message });
	else console.debug(`[${engineName}] ${name}`, { code });
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

/**
 * The connection is gone: SQLSTATE class 08, the server ended it (57P01), or the socket died without a SQLSTATE;
 * the pool replaces it on the next checkout. A connect that timed out is not a lost connection (`isConnectTimeout`).
 */
export function isConnectionLost(e: unknown): boolean {
	if (isConnectTimeout(e)) return false;
	const code = pgErrorCode(e);
	if (code !== undefined) {
		return (
			code === PG_ADMIN_SHUTDOWN ||
			code.startsWith(PG_CONNECTION_EXCEPTION_CLASS) ||
			NODE_SOCKET_LOST_CODES.has(code)
		);
	}
	return e instanceof Error && PG_SOCKET_ERROR_MESSAGE.test(e.message);
}

/**
 * The connection was never made: the address did not resolve or did not answer, the server certificate was not
 * accepted, or the server refused the login. A request does not try again; a migration run does when the refusal
 * is one that passes (`isRefusedForNow`).
 */
export function isConnectionRefused(e: unknown): boolean {
	const code = pgErrorCode(e);
	if (code === undefined) return false;
	return (
		NODE_CONNECT_REFUSED_CODES.has(code) ||
		TLS_ERROR_CODE.test(code) ||
		code.startsWith(PG_INVALID_AUTHORIZATION_CLASS) ||
		PG_REFUSED_CODES.has(code)
	);
}

/** A refusal that passes: too many connections, a server that is starting up, a lookup or a connect that timed out. */
export function isRefusedForNow(e: unknown): boolean {
	const code = pgErrorCode(e);
	return code !== undefined && REFUSED_FOR_NOW_CODES.has(code);
}

/**
 * The socket failed under a statement (`ECONNRESET`, `EPIPE`). The server may have run the statement before the
 * failure reached the client, so the statement is not run again.
 */
export function isSocketReset(e: unknown): boolean {
	const code = pgErrorCode(e);
	return code !== undefined && NODE_SOCKET_LOST_CODES.has(code);
}

/** pg gave up waiting for a connection (`connectionTimeoutMillis`): the cluster is resuming or unreachable. */
export function isConnectTimeout(e: unknown): boolean {
	return e instanceof Error && PG_CONNECT_TIMEOUT_MESSAGE.test(e.message);
}

export function isSerializationConflict(e: unknown): boolean {
	if (!(e instanceof Error)) return false;
	return e.name === DatabaseErrors.SerializationFailure || pgErrorCode(e) === PG_SERIALIZATION_FAILURE;
}

export function configError(message: string): Error {
	return blocksError('DatabaseConfigurationError', message);
}
