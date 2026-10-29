// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The runtime behavior every `Database` entry point shares: the three query
 * methods with their retry policy and `transaction()` with conflict retry. The
 * mock and aws classes differ only in how they produce the engine, so that is
 * injected as an async factory.
 */
import { type DatabaseEngine, type SqlQuery, unwrapQuery } from '@aws-blocks/data-common';
import { AUTOCOMMIT_CONFLICT_BACKOFF_MS, DEFAULT_MAX_RETRIES } from './constants.js';
import { runInTransactionScope } from './engines/tx-scope.js';
import { isSerializationConflict } from './errors.js';
import { validateRow, validateRows } from './result-schema.js';
import { asTransactionError, TransactionImpl } from './transaction.js';
import type { QueryOptions, Transaction, TransactionOptions } from './types.js';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface DatabaseCoreOptions {
	/** Produces (and memoizes) the engine; may run migrations first. */
	engine: () => Promise<DatabaseEngine>;
}

export class DatabaseCore {
	private engine: Promise<DatabaseEngine> | null = null;

	constructor(private readonly options: DatabaseCoreOptions) {}

	/** @internal The underlying engine, for adapters and tests. Not part of the public API. */
	getEngine(): Promise<DatabaseEngine> {
		if (!this.engine) {
			this.engine = this.options.engine();
			this.engine.catch(() => {
				// A failed initialization is not cached: the next call retries.
				this.engine = null;
			});
		}
		return this.engine;
	}

	/**
	 * Retry a single auto-commit statement that fails with a serialization
	 * conflict: three times at 50, 100 and 200 ms. Only auto-commit statements
	 * are retried here; a `transaction()` callback is re-run only with
	 * `retryOnConflict`.
	 */
	private async withConflictRetry<T>(fn: () => Promise<T>): Promise<T> {
		for (let attempt = 0; ; attempt++) {
			try {
				return await fn();
			} catch (e) {
				if (!isSerializationConflict(e) || attempt >= AUTOCOMMIT_CONFLICT_BACKOFF_MS.length) throw e;
				await sleep(AUTOCOMMIT_CONFLICT_BACKOFF_MS[attempt]);
			}
		}
	}

	/** Run a query with the auto-commit conflict retry; rows come back as the engine returned them. */
	private async fetch<T>(query: SqlQuery): Promise<T[]> {
		const engine = await this.getEngine();
		const { sql, params } = unwrapQuery(query);
		return this.withConflictRetry(() => engine.query<T>(sql, params));
	}

	async query<T>(query: SqlQuery, options?: QueryOptions<T>): Promise<T[]> {
		return validateRows(await this.fetch<T>(query), options?.schema);
	}

	async queryOne<T>(query: SqlQuery, options?: QueryOptions<T>): Promise<T | null> {
		const rows = await this.fetch<T>(query);
		if (rows.length === 0) return null;
		return options?.schema ? validateRow(rows[0], options.schema, 0) : rows[0];
	}

	async execute(query: SqlQuery): Promise<{ rowCount: number }> {
		const engine = await this.getEngine();
		const { sql, params } = unwrapQuery(query);
		return this.withConflictRetry(() => engine.execute(sql, params));
	}

	async transaction<T>(fn: (tx: Transaction) => Promise<T>, options?: TransactionOptions): Promise<T> {
		const engine = await this.getEngine();
		const maxAttempts = options?.retryOnConflict ? (options.maxRetries ?? DEFAULT_MAX_RETRIES) + 1 : 1;
		for (let attempt = 1; ; attempt++) {
			try {
				return await runTransaction(engine, fn);
			} catch (e) {
				if (isSerializationConflict(e) && attempt < maxAttempts) continue;
				throw e;
			}
		}
	}
}

/**
 * One attempt at a transaction. Runs the callback inside the transaction scope
 * so a `db.query()` from within it joins the open transaction on the
 * serialized local engine instead of deadlocking.
 */
async function runTransaction<T>(engine: DatabaseEngine, fn: (tx: Transaction) => Promise<T>): Promise<T> {
	const handle = await engine.beginTransaction();
	try {
		const result = await runInTransactionScope(handle, () => fn(new TransactionImpl(engine, handle)));
		await engine.commitTransaction(handle);
		return result;
	} catch (e) {
		await engine.rollbackTransaction(handle).catch(() => {});
		throw asTransactionError(e);
	}
}
