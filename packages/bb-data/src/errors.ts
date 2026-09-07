// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

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
