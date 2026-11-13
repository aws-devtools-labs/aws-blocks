// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  RDSDataClient,
  ExecuteStatementCommand,
  BeginTransactionCommand,
  CommitTransactionCommand,
  RollbackTransactionCommand,
  type Field,
  type ArrayValue,
  type ColumnMetadata,
} from '@aws-sdk/client-rds-data';
import type { DatabaseEngine, TransactionHandle } from '@aws-blocks/data-common';
import { installClientUserAgent } from '@aws-blocks/core';
import { DatabaseErrors, TRANSIENT_DATA_API_ERROR_NAMES, wrapError, reTagged, requestError, serializationConflict, uniqueConstraintConflict } from '../errors.js';

/**
 * Translate `$1`, `$2`, ... placeholders to `:p1`, `:p2`, ... for Data API.
 *
 * @example
 * translateParams('SELECT * FROM t WHERE a = $1 AND b = $2', ['x', 42])
 * // => { sql: 'SELECT * FROM t WHERE a = :p1 AND b = :p2', parameters: [...] }
 */
function translateParams(sql: string, params?: unknown[]): { sql: string; parameters: { name: string; value: Field }[] } {
  if (!params || params.length === 0) return { sql, parameters: [] };

  // Replace highest-numbered placeholders first to avoid $1 matching inside $10.
  // Uses a word-boundary-like check (next char must not be a digit) to prevent
  // $1 from matching the prefix of $12.
  let translated = sql;
  const parameters: { name: string; value: Field }[] = [];
  for (let i = params.length - 1; i >= 0; i--) {
    const placeholder = `$${i + 1}`;
    const replacement = `:p${i + 1}`;
    translated = translated.replaceAll(placeholder, replacement);
    parameters.unshift({ name: `p${i + 1}`, value: toField(params[i]) });
  }
  return { sql: translated, parameters };
}

/**
 * Marshal a JS value to a Data API Field.
 *
 * @example
 * toField('hello')       // => { stringValue: 'hello' }
 * toField(42)            // => { longValue: 42 }
 * toField(3.14)          // => { doubleValue: 3.14 }
 * toField(true)          // => { booleanValue: true }
 * toField(null)          // => { isNull: true }
 * toField(new Date(...)) // => { stringValue: '2026-01-01T00:00:00.000Z' }
 * toField({ a: 1 })      // => { stringValue: '{"a":1}' }
 */
export function toField(value: unknown): Field {
  if (value === null || value === undefined) return { isNull: true };
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'number') {
    return Number.isInteger(value) ? { longValue: value } : { doubleValue: value };
  }
  if (typeof value === 'boolean') return { booleanValue: value };
  if (value instanceof Date) return { stringValue: value.toISOString() };
  if (Buffer.isBuffer(value)) return { blobValue: value };
  return { stringValue: JSON.stringify(value) };
}

/**
 * Postgres `typeName` values (from `ColumnMetadata.typeName`) whose Data API
 * `stringValue` is a JSON document that should be parsed back into a JS value,
 * matching what the `pg` / PGlite drivers return natively. This Set holds only
 * the scalar `json` / `jsonb` forms; the leading-underscore array-element forms
 * (`_json` / `_jsonb`) are not members here — they are matched separately in
 * {@link fromArrayValue} and parsed per element.
 */
const JSON_TYPE_NAMES = new Set(['json', 'jsonb']);

/** Whether `typeName` names a scalar `json`/`jsonb` column (not its array form). */
function isJsonTypeName(typeName: string | undefined): boolean {
  return typeName !== undefined && JSON_TYPE_NAMES.has(typeName);
}

/**
 * Parse a Data API `stringValue` for a `json`/`jsonb` column back into a JS
 * value. On malformed JSON (should not happen for a value the server round-trips
 * as json/jsonb) the raw string is returned unchanged rather than throwing, so a
 * single odd row never fails the whole query.
 */
function parseJsonValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/**
 * Unmarshal a Data API {@link ArrayValue} to a JS array, recursing through nested
 * arrays. `elementTypeName` is the column's `typeName` (e.g. `_text`, `_jsonb`);
 * when it names a `json`/`jsonb` array, each string element is JSON-parsed so an
 * array column returns the same values as the `pg` / PGlite engines.
 */
function fromArrayValue(arrayValue: ArrayValue, elementTypeName?: string): unknown[] {
  // Array element arrays are typed with nullable elements across SDK versions
  // because a SQL array can hold NULL elements (e.g. '{a,NULL,b}'::text[]); a
  // null element must round-trip as JS null, never be coerced.
  if (arrayValue.stringValues !== undefined) {
    // `_json` / `_jsonb` → an array whose non-null elements are JSON documents.
    const isJsonArray = elementTypeName === '_json' || elementTypeName === '_jsonb';
    return arrayValue.stringValues.map(v => (v === null ? null : isJsonArray ? parseJsonValue(v) : v));
  }
  if (arrayValue.longValues !== undefined) return arrayValue.longValues.map(v => (v === null ? null : Number(v)));
  if (arrayValue.doubleValues !== undefined) return arrayValue.doubleValues.map(v => (v === null ? null : v));
  if (arrayValue.booleanValues !== undefined) return arrayValue.booleanValues.map(v => (v === null ? null : v));
  if (arrayValue.arrayValues !== undefined) return arrayValue.arrayValues.map(v => (v === null ? null : fromArrayValue(v, elementTypeName)));
  return [];
}

/**
 * Unmarshal a Data API Field to a JS value.
 *
 * Pass the column's `typeName` (from `ColumnMetadata.typeName`, available when the
 * statement is run with `includeResultMetadata: true`) so the result matches what
 * the `pg` / PGlite engines return for the same query:
 *   - array columns (`text[]`, `int[]`, ...) arrive as `arrayValue` and become JS
 *     arrays instead of `null`;
 *   - `json` / `jsonb` columns arrive as `stringValue` and are parsed into objects
 *     instead of being returned as raw strings.
 * Called with no `typeName` it still unmarshals every scalar and array shape; only
 * the json/jsonb string-parsing step needs the type.
 *
 * @example
 * fromField({ stringValue: 'hi' })                               // => 'hi'
 * fromField({ longValue: 99 })                                   // => 99
 * fromField({ booleanValue: true })                              // => true
 * fromField({ isNull: true })                                    // => null
 * fromField({ arrayValue: { stringValues: ['a', 'b'] } })        // => ['a', 'b']
 * fromField({ stringValue: '{"estimate":3}' }, 'jsonb')          // => { estimate: 3 }
 */
export function fromField(field: Field, typeName?: string): unknown {
  if (field.isNull) return null;
  if (field.arrayValue !== undefined) return fromArrayValue(field.arrayValue, typeName);
  if (field.stringValue !== undefined) {
    return isJsonTypeName(typeName) ? parseJsonValue(field.stringValue) : field.stringValue;
  }
  if (field.longValue !== undefined) return Number(field.longValue);
  if (field.doubleValue !== undefined) return field.doubleValue;
  if (field.booleanValue !== undefined) return field.booleanValue;
  if (field.blobValue !== undefined) return Buffer.from(field.blobValue);
  return null;
}

/**
 * Map one Data API record (row) to a plain object, keyed by column name and
 * unmarshalled with each column's `typeName` so values match the `pg` / PGlite
 * engines. `columnMetadata` comes from `includeResultMetadata: true`.
 */
function mapRecord<T>(record: Field[], columnMetadata?: ColumnMetadata[]): T {
  const row: Record<string, unknown> = {};
  record.forEach((field, i) => {
    const meta = columnMetadata?.[i];
    const colName = meta?.name || `col${i}`;
    row[colName] = fromField(field, meta?.typeName);
  });
  return row as T;
}

/**
 * Regex to extract SQLState codes from Data API error messages (e.g. "...; SQLState: 23505").
 * The Data API appends the real code at the end, while Postgres can echo caller
 * input earlier in the message (a cast's input value, a check or foreign-key
 * row's DETAIL), so only the last match is trusted.
 */
const SQLSTATE_PATTERN = /SQLState:\s*([A-Z0-9]{5})/gi;

/**
 * Translate a Data API error to a DatabaseErrors name.
 *
 * Classification priority:
 * 1. Parse SQLState from the message (most reliable — matches pg error codes).
 * 2. Fall back to message-text matching for unique constraints (backward compat).
 * 3. Check SDK exception names for connection errors (service unavailable,
 *    or a scale-to-zero cluster resuming from auto-pause).
 * 4. Default to QueryFailed.
 */
function translateError(e: unknown): never {
  if (e instanceof Error) {
    const msg = e.message || '';

    // Prefer SQLState-based classification when available.
    const code = [...msg.matchAll(SQLSTATE_PATTERN)].at(-1)?.[1];
    let name: string;
    if (code) {
      if (code === '40001') {
        // OCC conflict: surface as a retriable 409 (Conflict), not a generic
        // 500. Preserves the SerializationFailure name and keeps the original
        // error as cause. Matches the PGlite / pg-client engine paths.
        throw serializationConflict(e);
      } else if (code === '23505') {
        // Duplicate key: surface as a 409 (Conflict), not a generic 500. Not
        // retriable. Matches the PGlite / pg-client engine paths.
        throw uniqueConstraintConflict(e);
      }
      // Request errors (42501, 23514, 23502, 23503): a 4xx, not a generic 500.
      // Matches the PGlite / pg-client engine paths.
      const request = requestError(code, e);
      if (request) throw request;
      if (code.startsWith('08')) {
        name = DatabaseErrors.ConnectionFailed;
      } else {
        name = DatabaseErrors.QueryFailed;
      }
    } else if (/unique constraint|duplicate key/i.test(msg)) {
      // Data API errors without a parseable SQLState still carry the driver's
      // unique-violation text — map to the same 409 (Conflict) as the
      // SQLState-parsed path above.
      throw uniqueConstraintConflict(e);
    } else if (TRANSIENT_DATA_API_ERROR_NAMES.has(e.name)) {
      name = DatabaseErrors.ConnectionFailed;
    } else {
      name = DatabaseErrors.QueryFailed;
    }
    console.debug(`[DataApiEngine] ${name}`);
    // Branded re-tag (stable BB message, raw error kept as cause) so the name
    // crosses the wire without leaking driver text (D-003).
    throw reTagged(name, e);
  }
  wrapError(e);
}

/**
 * DatabaseEngine implementation using RDS Data API.
 * Used in the AWS Lambda runtime. Stateless — each call is an independent HTTP request.
 */
export class DataApiEngine implements DatabaseEngine {
  private client: RDSDataClient;
  private resourceArn: string;
  private secretArn: string;
  private database: string;

  /**
   * @param config.resourceArn - Aurora cluster ARN
   * @param config.secretArn - Secrets Manager ARN for credentials
   * @param config.database - Database name
   * @param config.client - Optional pre-configured RDSDataClient (for testing)
   */
  constructor(config: { resourceArn: string; secretArn: string; database: string; client?: RDSDataClient; customUserAgent?: [string, string][] }) {
    this.resourceArn = config.resourceArn;
    this.secretArn = config.secretArn;
    this.database = config.database;
    this.client = config.client ?? new RDSDataClient({
      ...(config.customUserAgent ? { customUserAgent: config.customUserAgent } : {}),
    });
    // Instrument only a client we created; an injected one is the caller's job.
    if (!config.client) installClientUserAgent(this.client);
  }

  /** Execute a SQL query via ExecuteStatement and return rows mapped from column metadata. */
  async query<T>(sql: string, params?: unknown[]): Promise<T[]> {
    try {
      const { sql: translated, parameters } = translateParams(sql, params);
      const result = await this.client.send(new ExecuteStatementCommand({
        resourceArn: this.resourceArn,
        secretArn: this.secretArn,
        database: this.database,
        sql: translated,
        parameters,
        includeResultMetadata: true,
      }));
      return (result.records || []).map(record => mapRecord<T>(record, result.columnMetadata));
    } catch (e) {
      translateError(e);
    }
  }

  /** Execute a SQL mutation via ExecuteStatement and return the affected row count. */
  async execute(sql: string, params?: unknown[]): Promise<{ rowCount: number }> {
    try {
      const { sql: translated, parameters } = translateParams(sql, params);
      const result = await this.client.send(new ExecuteStatementCommand({
        resourceArn: this.resourceArn,
        secretArn: this.secretArn,
        database: this.database,
        sql: translated,
        parameters,
      }));
      return { rowCount: result.numberOfRecordsUpdated ?? 0 };
    } catch (e) {
      translateError(e);
    }
  }

  /** Begin a transaction via BeginTransactionCommand. Returns the transaction ID as the handle. */
  async beginTransaction(): Promise<TransactionHandle> {
    try {
      const result = await this.client.send(new BeginTransactionCommand({
        resourceArn: this.resourceArn,
        secretArn: this.secretArn,
        database: this.database,
      }));
      return result.transactionId;
    } catch (e) {
      translateError(e);
    }
  }

  /** Commit a transaction via CommitTransactionCommand. */
  async commitTransaction(handle: TransactionHandle): Promise<void> {
    try {
      await this.client.send(new CommitTransactionCommand({
        resourceArn: this.resourceArn,
        secretArn: this.secretArn,
        transactionId: handle as string,
      }));
    } catch (e) {
      translateError(e);
    }
  }

  /** Roll back a transaction via RollbackTransactionCommand. */
  async rollbackTransaction(handle: TransactionHandle): Promise<void> {
    try {
      await this.client.send(new RollbackTransactionCommand({
        resourceArn: this.resourceArn,
        secretArn: this.secretArn,
        transactionId: handle as string,
      }));
    } catch (e) {
      translateError(e);
    }
  }

  /** Execute a query within a transaction, passing the transaction ID to ExecuteStatement. */
  async queryInTransaction<T>(handle: TransactionHandle, sql: string, params?: unknown[]): Promise<T[]> {
    try {
      const { sql: translated, parameters } = translateParams(sql, params);
      const result = await this.client.send(new ExecuteStatementCommand({
        resourceArn: this.resourceArn,
        secretArn: this.secretArn,
        database: this.database,
        sql: translated,
        parameters,
        transactionId: handle as string,
        includeResultMetadata: true,
      }));
      return (result.records || []).map(record => mapRecord<T>(record, result.columnMetadata));
    } catch (e) {
      translateError(e);
    }
  }

  /** Execute a mutation within a transaction, passing the transaction ID to ExecuteStatement. */
  async executeInTransaction(handle: TransactionHandle, sql: string, params?: unknown[]): Promise<{ rowCount: number }> {
    try {
      const { sql: translated, parameters } = translateParams(sql, params);
      const result = await this.client.send(new ExecuteStatementCommand({
        resourceArn: this.resourceArn,
        secretArn: this.secretArn,
        database: this.database,
        sql: translated,
        parameters,
        transactionId: handle as string,
      }));
      return { rowCount: result.numberOfRecordsUpdated ?? 0 };
    } catch (e) {
      translateError(e);
    }
  }

  /** No-op — Data API is stateless with no persistent connections to clean up. */
  async destroy(): Promise<void> {
    // Data API is stateless — nothing to clean up
  }
}
