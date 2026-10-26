// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The `Transaction` handed to a `transaction()` callback, and the error
 * re-tagging every transaction path shares.
 */
import { isWireSafeError } from '@aws-blocks/core';
import { type DatabaseEngine, type SqlQuery, type TransactionHandle, unwrapQuery } from '@aws-blocks/data-common';
import { DatabaseErrors, isKnownDatabaseErrorName, reTagged } from './errors.js';
import { validateRow, validateRows } from './result-schema.js';
import type { QueryOptions, Transaction } from './types.js';

/**
 * Re-tag an error escaping a transaction. An error meant for the caller passes
 * through unchanged: an `ApiError` (a 404 from the callback, the 401 from
 * `requireAuth`), any branded Blocks error (`blocksError`, `brandBlocksError`),
 * and the block's own `DatabaseErrors`. Anything else, such as a driver error or
 * a plain `Error`, becomes `TransactionFailed` so its text never leaves the server.
 */
export function asTransactionError(e: unknown): Error {
	const error = e instanceof Error ? e : new Error(String(e));
	if (isKnownDatabaseErrorName(error.name) || isWireSafeError(error)) return error;
	return reTagged(DatabaseErrors.TransactionFailed, error);
}

/** Transaction implementation that routes calls through a DatabaseEngine using an opaque handle. */
export class TransactionImpl implements Transaction {
	constructor(
		private engine: DatabaseEngine,
		private handle: TransactionHandle,
	) {}

	async query<T>(query: SqlQuery, options?: QueryOptions<T>): Promise<T[]> {
		const { sql, params } = unwrapQuery(query);
		const rows = await this.engine.queryInTransaction<T>(this.handle, sql, params);
		return validateRows(rows, options?.schema);
	}

	async queryOne<T>(query: SqlQuery, options?: QueryOptions<T>): Promise<T | null> {
		const { sql, params } = unwrapQuery(query);
		const rows = await this.engine.queryInTransaction<T>(this.handle, sql, params);
		if (rows.length === 0) return null;
		return options?.schema ? validateRow(rows[0], options.schema, 0) : rows[0];
	}

	async execute(query: SqlQuery): Promise<{ rowCount: number }> {
		const { sql, params } = unwrapQuery(query);
		return this.engine.executeInTransaction(this.handle, sql, params);
	}
}
