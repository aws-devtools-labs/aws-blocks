// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { DatabaseErrors, wrapError, serializationConflict, uniqueConstraintConflict } from '../errors.js';

/** PostgreSQL error code for unique constraint violations. */
const PG_UNIQUE_VIOLATION = '23505';

/** PostgreSQL error code for serialization failures — OCC conflict. Class 40 (Transaction Rollback). */
const PG_SERIALIZATION_FAILURE = '40001';

/** PostgreSQL error code class for connection exceptions. */
const PG_CONNECTION_EXCEPTION_CLASS = '08';

/**
 * Translate a PostgreSQL error to a standardized DatabaseErrors name.
 * Used by both PGliteEngine and PgClientEngine for consistent error behavior.
 *
 * @example
 * // PostgreSQL error code 23505 → UniqueConstraintViolation
 * // PostgreSQL error code 40001 → SerializationFailure (ApiError, HTTP 409)
 * // PostgreSQL error code 08xxx → ConnectionFailed
 * // All other errors → QueryFailed
 */
export function translatePgError(e: unknown, engineName: string): never {
  if (e instanceof Error) {
    const code = (e as any).code as string | undefined;
    if (code === PG_SERIALIZATION_FAILURE) {
      // OCC conflict: surface as a retriable 409 (Conflict), not a generic 500.
      throw serializationConflict(e);
    }
    if (code === PG_UNIQUE_VIOLATION) {
      // Duplicate key: surface as a 409 (Conflict), not a generic 500. Not
      // retriable — a blind retry of the same insert fails identically.
      throw uniqueConstraintConflict(e);
    }
    if (code && code.startsWith(PG_CONNECTION_EXCEPTION_CLASS)) {
      e.name = DatabaseErrors.ConnectionFailed;
    } else {
      e.name = DatabaseErrors.QueryFailed;
    }
    console.debug(`[${engineName}] ${e.name}`, { code });
    throw e;
  }
  wrapError(e);
}
