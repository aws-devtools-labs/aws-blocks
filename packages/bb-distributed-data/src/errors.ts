// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { ApiError, brandBlocksError } from '@aws-blocks/core';

/**
 * DSQL-specific error constants.
 */
export const DistributedDatabaseErrors = {
  QueryFailed: 'QueryFailedException',
  ConnectionFailed: 'ConnectionFailedException',
  TransactionFailed: 'TransactionFailedException',
  UniqueConstraintViolation: 'UniqueConstraintViolationException',
  SerializationFailure: 'SerializationFailureException',
  TransactionRowLimitExceeded: 'TransactionRowLimitExceededException',
  /**
   * A DDL statement was attempted on the app-runtime connection, which is
   * DML-only (parity with the production `dsql:DbConnect` IAM grant). Raised by
   * the mock's DDL guard before execution; on the deployed path the equivalent
   * rejection comes from DSQL itself and is re-tagged by {@link translateDsqlError}.
   * Matchable via `isBlocksError(e, DistributedDatabaseErrors.Permission)`.
   */
  Permission: 'DsqlPermissionError',
} as const;

/**
 * PostgreSQL error codes used for DSQL error translation.
 * @see https://www.postgresql.org/docs/current/errcodes-appendix.html
 */

/** Serialization failure — OCC conflict in DSQL. Class 40 (Transaction Rollback). */
export const PG_SERIALIZATION_FAILURE = '40001';
/** Unique constraint violation. Class 23 (Integrity Constraint Violation). */
export const PG_UNIQUE_VIOLATION = '23505';
/** Connection exception class prefix. Class 08 (Connection Exception). */
export const PG_CONNECTION_EXCEPTION_CLASS = '08';

/**
 * Maximum rows mutated per DSQL transaction.
 * @see https://docs.aws.amazon.com/aurora-dsql/latest/userguide/working-with-transactions.html
 */
export const TRANSACTION_ROW_LIMIT = 3000;

/**
 * Build the 409 ApiError for a serialization-failure (SQLSTATE 40001) OCC
 * conflict. Maps to HTTP 409 (Conflict) so the JSON-RPC serializer emits code
 * 409 instead of a generic 500, preserves the `SerializationFailure` name so
 * `isBlocksError(e, DistributedDatabaseErrors.SerializationFailure)` keeps
 * matching on both server and client, keeps the original engine error as
 * `cause` (server-side), and flags the conflict retriable — the caller can
 * retry the transaction (see `retryOnConflict`).
 *
 * The client-visible message is a fixed, stable string (the raw driver text is
 * verbose); the original error is retained as `cause` for server-side
 * diagnostics.
 */
export function serializationConflict(cause: Error): ApiError {
  return new ApiError('The transaction failed due to a serialization conflict', 409, {
    name: DistributedDatabaseErrors.SerializationFailure,
    cause,
    retriable: true,
  });
}

/**
 * Build the 409 ApiError for a unique-constraint / duplicate-key violation
 * (SQLSTATE 23505). Maps to HTTP 409 (Conflict) so the JSON-RPC serializer emits
 * code 409 instead of a generic 500, preserves the `UniqueConstraintViolation`
 * name so `isBlocksError(e, DistributedDatabaseErrors.UniqueConstraintViolation)`
 * keeps matching on both server and client, and keeps the original engine error
 * as `cause` (server-side).
 *
 * Unlike {@link serializationConflict}, this is NOT flagged retriable: a
 * duplicate key is a deterministic constraint failure, so a blind retry of the
 * same insert fails identically (ApiError defaults `retriable` to `false`).
 *
 * The client-visible message is a fixed, stable string; the raw driver text
 * (which can name columns / constraints and varies by engine) is retained only
 * as `cause` for server-side diagnostics, never interpolated into the message.
 */
export function uniqueConstraintConflict(cause: Error): ApiError {
  return new ApiError('The item violates a unique constraint', 409, {
    name: DistributedDatabaseErrors.UniqueConstraintViolation,
    cause,
  });
}

/**
 * Stable, BB-authored client-facing messages per DistributedDatabaseErrors name.
 * The raw DSQL/pg driver text is never sent — kept only as `cause` for
 * server-side diagnostics. A branded error's `name` AND `message` cross the wire
 * (D-003), so a re-tag path gives the error a stable message here rather than
 * forwarding the driver's.
 */
const RE_TAG_MESSAGES: Record<string, string> = {
  [DistributedDatabaseErrors.QueryFailed]: 'The database query failed',
  [DistributedDatabaseErrors.ConnectionFailed]: 'The database connection failed',
};

/**
 * Build a BRANDED re-tag error: a fresh `Error` with the BB `name` and a stable
 * BB message, keeping the original driver error as `cause` (server-side only).
 * The name crosses the wire so `isBlocksError(e, DistributedDatabaseErrors.QueryFailed
 * | .ConnectionFailed)` keeps matching on the client, while the raw driver text
 * never leaks (D-003).
 */
function reTagged(name: string, cause: Error): Error {
  const message = RE_TAG_MESSAGES[name] ?? RE_TAG_MESSAGES[DistributedDatabaseErrors.QueryFailed];
  const wrapped = new Error(`${name}: ${message}`, { cause });
  wrapped.name = name;
  return brandBlocksError(wrapped);
}

/** Translate a pg error code to a DistributedDatabaseErrors name. */
export function translateDsqlError(e: Error): never {
  const code = (e as any).code as string | undefined;
  if (code === PG_SERIALIZATION_FAILURE) {
    // An OCC / serialization-failure conflict (SQLSTATE 40001) is a Conflict,
    // not an InternalServerError: see serializationConflict() for the full
    // rationale (409 mapping, preserved name, retained cause, retriable flag).
    throw serializationConflict(e);
  } else if (code === PG_UNIQUE_VIOLATION) {
    // A duplicate-key / unique-constraint violation (SQLSTATE 23505) is a
    // Conflict, not an InternalServerError: see uniqueConstraintConflict() for
    // the full rationale (409 mapping, preserved name, retained cause, and why
    // it is NOT retriable).
    throw uniqueConstraintConflict(e);
  }
  // Brand the re-tagged connection/query error (stable BB message, raw driver
  // error kept as `cause`) so its name crosses the wire without leaking driver
  // text (D-003).
  const name = code && code.startsWith(PG_CONNECTION_EXCEPTION_CLASS)
    ? DistributedDatabaseErrors.ConnectionFailed
    : DistributedDatabaseErrors.QueryFailed;
  throw reTagged(name, e);
}
