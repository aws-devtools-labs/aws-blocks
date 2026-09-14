// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { ApiError } from '@aws-blocks/core';

/**
 * Standardized error constants for the Database Building Block.
 *
 * All engine implementations translate engine-specific errors to these names.
 * Customers use `isBlocksError(e, DatabaseErrors.QueryFailed)` for error handling.
 */
export const DatabaseErrors = {
  QueryFailed: 'QueryFailedException',
  ConnectionFailed: 'ConnectionFailedException',
  TransactionFailed: 'TransactionFailedException',
  UniqueConstraintViolation: 'UniqueConstraintViolationException',
  SerializationFailure: 'SerializationFailureException',
} as const;

/**
 * Build the 409 ApiError for a serialization-failure (SQLSTATE 40001) OCC
 * conflict. Maps to HTTP 409 (Conflict) so the JSON-RPC serializer emits code
 * 409 instead of a generic 500, preserves the `SerializationFailure` name so
 * `isBlocksError(e, DatabaseErrors.SerializationFailure)` keeps matching on both
 * server and client, keeps the original engine error as `cause` (server-side),
 * and flags the conflict retriable (the caller can retry the transaction).
 * Shared by every engine translator (PGlite, pg-client, Data API) so all paths
 * produce an identically shaped 409.
 *
 * The client-visible message is a fixed, stable string (the raw driver text
 * varies by engine and can be verbose); the original error is retained as
 * `cause` for server-side diagnostics.
 */
export function serializationConflict(cause: Error): ApiError {
  return new ApiError('The transaction failed due to a serialization conflict', 409, {
    name: DatabaseErrors.SerializationFailure,
    cause,
    retriable: true,
  });
}

/**
 * Build the 409 ApiError for a unique-constraint / duplicate-key violation
 * (SQLSTATE 23505). Maps to HTTP 409 (Conflict) so the JSON-RPC serializer emits
 * code 409 instead of a generic 500, preserves the `UniqueConstraintViolation`
 * name so `isBlocksError(e, DatabaseErrors.UniqueConstraintViolation)` keeps
 * matching on both server and client, and keeps the original engine error as
 * `cause` (server-side). Shared by every engine translator (PGlite, pg-client,
 * Data API) so all paths produce an identically shaped 409.
 *
 * Unlike {@link serializationConflict}, this is NOT flagged retriable: a
 * duplicate key is a deterministic constraint failure, so a blind retry of the
 * same insert fails identically (ApiError defaults `retriable` to `false`).
 *
 * The client-visible message is a fixed, stable string; the raw driver text
 * (which can name columns / constraint identifiers and varies by engine) is
 * retained only as `cause` for server-side diagnostics, never interpolated into
 * the message.
 */
export function uniqueConstraintConflict(cause: Error): ApiError {
  return new ApiError('The item violates a unique constraint', 409, {
    name: DatabaseErrors.UniqueConstraintViolation,
    cause,
  });
}

const knownErrors = new Set<string>(Object.values(DatabaseErrors));

/**
 * Data API exception names that mean "the cluster is not accepting statements yet"
 * rather than "the statement is wrong": a service-side transient, or a
 * `minCapacity: 0` cluster resuming from auto-pause.
 *
 * Matched against `error.name` as the SDK sets it, so the engine's classifier and
 * the migration Lambda's pre-classification fallback stay in step. Internal to the
 * package — not re-exported from the entry points.
 */
export const TRANSIENT_DATA_API_ERROR_NAMES: ReadonlySet<string> = new Set([
  'ServiceUnavailableException',
  'InternalServerErrorException',
  // A scale-to-zero cluster (minCapacity: 0) auto-pauses after ~5 minutes idle;
  // the call that wakes it fails while it resumes.
  'DatabaseResumingException',
]);

/**
 * Wrap an error with a standardized DatabaseErrors name.
 *
 * If the error already has a recognized DatabaseErrors name, it is re-thrown as-is.
 * Otherwise, its name is set to QueryFailed before throwing.
 *
 * @param e - The caught value (may not be an Error)
 */
export function wrapError(e: unknown): never {
  const error = e instanceof Error ? e : new Error(String(e));
  if (!knownErrors.has(error.name)) {
    error.name = DatabaseErrors.QueryFailed;
  }
  throw error;
}
