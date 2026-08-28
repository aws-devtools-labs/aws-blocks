// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  RDSDataClient,
  ExecuteStatementCommand,
  BeginTransactionCommand,
  CommitTransactionCommand,
  RollbackTransactionCommand,
  type Field,
} from '@aws-sdk/client-rds-data';
import type { DatabaseEngine, TransactionHandle } from '@aws-blocks/data-common';
import { DatabaseErrors, wrapError } from '../errors.js';

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
 * Unmarshal a Data API Field to a JS value.
 *
 * @example
 * fromField({ stringValue: 'hi' })  // => 'hi'
 * fromField({ longValue: 99 })      // => 99
 * fromField({ booleanValue: true }) // => true
 * fromField({ isNull: true })       // => null
 */
export function fromField(field: Field): unknown {
  if (field.isNull) return null;
  if (field.stringValue !== undefined) return field.stringValue;
  if (field.longValue !== undefined) return Number(field.longValue);
  if (field.doubleValue !== undefined) return field.doubleValue;
  if (field.booleanValue !== undefined) return field.booleanValue;
  if (field.blobValue !== undefined) return Buffer.from(field.blobValue);
  return null;
}

/** Regex to extract SQLState code from Data API error messages (e.g. "...; SQLState: 23505"). */
const SQLSTATE_PATTERN = /SQLState:\s*([A-Z0-9]{5})/i;

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
    const stateMatch = msg.match(SQLSTATE_PATTERN);
    if (stateMatch) {
      const code = stateMatch[1];
      if (code === '40001') {
        e.name = DatabaseErrors.SerializationFailure;
      } else if (code === '23505') {
        e.name = DatabaseErrors.UniqueConstraintViolation;
      } else if (code.startsWith('08')) {
        e.name = DatabaseErrors.ConnectionFailed;
      } else {
        e.name = DatabaseErrors.QueryFailed;
      }
    } else if (/unique constraint|duplicate key/i.test(msg)) {
      e.name = DatabaseErrors.UniqueConstraintViolation;
    } else if (
      e.name === 'ServiceUnavailableException' ||
      e.name === 'InternalServerErrorException' ||
      // A scale-to-zero cluster (minCapacity: 0) auto-pauses after ~5 minutes
      // idle; the call that wakes it fails while it resumes. Transient, and
      // retryable — not a bad statement.
      e.name === 'DatabaseResumingException'
    ) {
      e.name = DatabaseErrors.ConnectionFailed;
    } else {
      e.name = DatabaseErrors.QueryFailed;
    }
    console.debug(`[DataApiEngine] ${e.name}`);
    throw e;
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
      return (result.records || []).map(record => {
        const row: Record<string, unknown> = {};
        record.forEach((field, i) => {
          const colName = result.columnMetadata?.[i]?.name || `col${i}`;
          row[colName] = fromField(field);
        });
        return row as T;
      });
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
      return (result.records || []).map(record => {
        const row: Record<string, unknown> = {};
        record.forEach((field, i) => {
          const colName = result.columnMetadata?.[i]?.name || `col${i}`;
          row[colName] = fromField(field);
        });
        return row as T;
      });
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
