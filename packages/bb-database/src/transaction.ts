// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The `Transaction` handed to a `transaction()` callback, and the error
 * re-tagging every transaction path shares.
 */
import {
	type DatabaseEngine,
	type SqlQuery,
	type Transaction,
	type TransactionHandle,
	unwrapQuery,
} from '@aws-blocks/data-common';
import { DatabaseErrors, isKnownDatabaseErrorName, reTagged } from './errors.js';

/** Re-tag an error escaping a transaction: known BB errors pass through, anything else becomes `TransactionFailed`. */
export function asTransactionError(e: unknown): Error {
	const error = e instanceof Error ? e : new Error(String(e));
	if (isKnownDatabaseErrorName(error.name)) return error;
	return reTagged(DatabaseErrors.TransactionFailed, error);
}

/** Transaction implementation that routes calls through a DatabaseEngine using an opaque handle. */
export class TransactionImpl implements Transaction {
	constructor(
		private engine: DatabaseEngine,
		private handle: TransactionHandle,
	) {}

	async query<T>(query: SqlQuery): Promise<T[]> {
		const { sql, params } = unwrapQuery(query);
		return this.engine.queryInTransaction<T>(this.handle, sql, params);
	}

	async queryOne<T>(query: SqlQuery): Promise<T | null> {
		const { sql, params } = unwrapQuery(query);
		const rows = await this.engine.queryInTransaction<T>(this.handle, sql, params);
		return rows[0] ?? null;
	}

	async execute(query: SqlQuery): Promise<{ rowCount: number }> {
		const { sql, params } = unwrapQuery(query);
		return this.engine.executeInTransaction(this.handle, sql, params);
	}
}
