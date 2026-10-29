// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The runtime behavior every `Database` entry point shares: the three query
 * methods with their retry policy, `transaction()` with conflict retry, the
 * `Transaction` handed to a callback, and the validation of rows against the
 * `schema` option. The mock and aws classes differ only in how they produce
 * the engine, so that is injected as an async factory.
 */
import { isWireSafeError } from '@aws-blocks/core';
import { type DatabaseEngine, type SqlQuery, type TransactionHandle, unwrapQuery } from '@aws-blocks/data-common';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { AUTOCOMMIT_CONFLICT_BACKOFF_MS, DEFAULT_MAX_RETRIES } from '../constants.js';
import { runInTransactionScope } from '../engines/tx-scope.js';
import {
	DatabaseErrors,
	isKnownDatabaseErrorName,
	isSerializationConflict,
	resultValidationFailed,
	reTagged,
} from '../errors.js';
import type { QueryOptions, Transaction, TransactionOptions } from '../types.js';

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

/**
 * Re-tag an error escaping a transaction. An error meant for the caller passes
 * through unchanged: an `ApiError` (a 404 from the callback, the 401 from
 * `requireAuth`), any branded Blocks error (`blocksError`, `brandBlocksError`),
 * and the block's own `DatabaseErrors`. Anything else, such as a driver error or
 * a plain `Error`, becomes `TransactionFailed` so its text never leaves the server.
 */
function asTransactionError(e: unknown): Error {
	const error = e instanceof Error ? e : new Error(String(e));
	if (isKnownDatabaseErrorName(error.name) || isWireSafeError(error)) return error;
	return reTagged(DatabaseErrors.TransactionFailed, error);
}

/** Transaction implementation that routes calls through a DatabaseEngine using an opaque handle. */
class TransactionImpl implements Transaction {
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

/** Validate one row; returns the schema's output. */
async function validateRow<T>(row: unknown, schema: StandardSchemaV1<unknown, T>, index: number): Promise<T> {
	const result = schema['~standard'].validate(row);
	const resolved = result instanceof Promise ? await result : result;
	if (resolved.issues) throw resultValidationFailed(index, resolved.issues);
	return resolved.value;
}

/** Validate every row in order; without a schema the rows pass through unchanged. */
async function validateRows<T>(rows: T[], schema: StandardSchemaV1<unknown, T> | undefined): Promise<T[]> {
	if (!schema) return rows;
	const out: T[] = [];
	for (const [index, row] of rows.entries()) out.push(await validateRow(row, schema, index));
	return out;
}
