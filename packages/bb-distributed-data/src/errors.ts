// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { ApiError } from '@aws-blocks/core';

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

/** Translate a pg error code to a DistributedDatabaseErrors name. */
export function translateDsqlError(e: Error): never {
  const code = (e as any).code as string | undefined;
  if (code === PG_SERIALIZATION_FAILURE) {
    // An OCC / serialization-failure conflict (SQLSTATE 40001) is a Conflict,
    // not an InternalServerError: throw an ApiError with status 409 so the
    // JSON-RPC serializer emits code 409 instead of a generic 500. Preserve the
    // SerializationFailure name so isBlocksError() keeps matching on both server
    // and client, keep the original error as `cause` (server-side), and flag it
    // retriable — the caller can retry the transaction (see `retryOnConflict`).
    // The client-visible message is a fixed, stable string (the raw driver text
    // is verbose); the original error is retained as `cause` for diagnostics.
    throw new ApiError('The transaction failed due to a serialization conflict', 409, {
      name: DistributedDatabaseErrors.SerializationFailure,
      cause: e,
      retriable: true,
    });
  } else if (code === PG_UNIQUE_VIOLATION) {
    // A duplicate-key / unique-constraint violation (SQLSTATE 23505) is a
    // Conflict, not an InternalServerError: throw an ApiError with status 409
    // so the JSON-RPC serializer emits code 409 instead of a generic 500.
    // Preserve the UniqueConstraintViolation name so isBlocksError() keeps
    // matching on both server and client, and keep the original error as
    // `cause` (server-side). Unlike the 40001 branch above, this is NOT
    // retriable — a duplicate key is deterministic, so a blind retry of the
    // same insert fails identically (ApiError defaults retriable=false). The
    // client-visible message is a fixed, stable string; the raw driver text
    // (which can name columns / constraints) is retained only as `cause`.
    throw new ApiError('The item violates a unique constraint', 409, {
      name: DistributedDatabaseErrors.UniqueConstraintViolation,
      cause: e,
    });
  } else if (code && code.startsWith(PG_CONNECTION_EXCEPTION_CLASS)) {
    e.name = DistributedDatabaseErrors.ConnectionFailed;
  } else {
    e.name = DistributedDatabaseErrors.QueryFailed;
  }
  throw e;
}
