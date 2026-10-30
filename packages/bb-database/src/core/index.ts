// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

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
	engine: () => Promise<DatabaseEngine>;
}

export class DatabaseCore {
	private engine: Promise<DatabaseEngine> | null = null;

	constructor(private readonly options: DatabaseCoreOptions) {}

	/** @internal */
	getEngine(): Promise<DatabaseEngine> {
		if (!this.engine) {
			this.engine = this.options.engine();
			this.engine.catch(() => {
				this.engine = null;
			});
		}
		return this.engine;
	}

	// A single auto-commit statement is safe to re-run; a transaction() callback may have side effects,
	// so it is re-run only with `retryOnConflict`.
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

	private async fetch<T>(query: SqlQuery): Promise<T[]> {
		const engine = await this.getEngine();
		const { sql, params } = unwrapQuery(query);
		return this.withConflictRetry(() => engine.query<T>(sql, params));
	}

	async query<T>(query: SqlQuery, options?: QueryOptions<T>): Promise<T[]> {
		return validateRows(await this.fetch<T>(query), options?.schema);
	}

	async queryOne<T>(query: SqlQuery, options?: QueryOptions<T>): Promise<T | null> {
		return firstRow(await this.fetch<T>(query), options?.schema);
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

// An ApiError, a branded Blocks error or one of DatabaseErrors passes through. Anything else (a driver
// error, a plain Error) becomes TransactionFailed so its text never leaves the server.
function asTransactionError(e: unknown): Error {
	const error = e instanceof Error ? e : new Error(String(e));
	if (isKnownDatabaseErrorName(error.name) || isWireSafeError(error)) return error;
	return reTagged(DatabaseErrors.TransactionFailed, error);
}

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
		return firstRow(await this.engine.queryInTransaction<T>(this.handle, sql, params), options?.schema);
	}

	async execute(query: SqlQuery): Promise<{ rowCount: number }> {
		const { sql, params } = unwrapQuery(query);
		return this.engine.executeInTransaction(this.handle, sql, params);
	}
}

async function firstRow<T>(rows: T[], schema: StandardSchemaV1<unknown, T> | undefined): Promise<T | null> {
	if (rows.length === 0) return null;
	return schema ? (await validateRows([rows[0]], schema))[0] : rows[0];
}

function settled<T>(result: StandardSchemaV1.Result<T>, index: number): T {
	if (result.issues) throw resultValidationFailed(index, result.issues);
	return result.value;
}

// Most schema libraries validate synchronously; only a Promise result is awaited, all of them together.
async function validateRows<T>(rows: T[], schema: StandardSchemaV1<unknown, T> | undefined): Promise<T[]> {
	if (!schema) return rows;
	const out: T[] = [];
	const pending: Promise<void>[] = [];
	for (const [index, row] of rows.entries()) {
		const result = schema['~standard'].validate(row);
		if (result instanceof Promise) {
			pending.push(
				result.then((r) => {
					out[index] = settled(r, index);
				}),
			);
		} else {
			out[index] = settled(result, index);
		}
	}
	await Promise.all(pending);
	return out;
}
