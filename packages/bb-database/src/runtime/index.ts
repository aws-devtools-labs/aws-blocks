// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { isWireSafeError } from '@aws-blocks/core';
import { type DatabaseEngine, type SqlQuery, type TransactionHandle, unwrapQuery } from '@aws-blocks/data-common';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { AUTOCOMMIT_CONFLICT_BACKOFF_MS, DEFAULT_MAX_RETRIES } from '../constants.js';
import { withTransaction } from '../engines/handle.js';
import {
	asError,
	DatabaseErrors,
	isKnownDatabaseErrorName,
	isSerializationConflict,
	resultValidationFailed,
	reTagged,
} from '../errors.js';
import type { QueryOptions, Transaction, TransactionOptions } from '../types.js';
import { currentTransactionScope, runInTransactionScope, TransactionScope } from './tx-scope.js';

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
			const engine = this.options.engine();
			this.engine = engine;
			engine.catch(() => {
				if (this.engine === engine) this.engine = null;
			});
		}
		return this.engine;
	}

	/** @internal Drops the cached engine; the next statement builds it again. */
	invalidateEngine(): void {
		this.engine = null;
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

	// A block-level statement inside this block's own transaction() callback runs in that transaction, on
	// every engine: on DSQL it would otherwise auto-commit on another pooled connection, and locally it would
	// wait on the cluster mutex the transaction holds. A conflict inside a transaction surfaces at its
	// commit, so there is no per-statement retry on that path.
	private joinedHandle(): TransactionHandle | undefined {
		const scope = currentTransactionScope();
		return scope?.owner === this ? scope.handle : undefined;
	}

	private async fetch<T>(query: SqlQuery): Promise<T[]> {
		const engine = await this.getEngine();
		const { sql, params } = unwrapQuery(query);
		const handle = this.joinedHandle();
		if (handle) return engine.queryInTransaction<T>(handle, sql, params);
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
		const handle = this.joinedHandle();
		if (handle) return engine.executeInTransaction(handle, sql, params);
		return this.withConflictRetry(() => engine.execute(sql, params));
	}

	async transaction<T>(fn: (tx: Transaction) => Promise<T>, options?: TransactionOptions): Promise<T> {
		const engine = await this.getEngine();
		const maxAttempts = options?.retryOnConflict ? (options.maxRetries ?? DEFAULT_MAX_RETRIES) + 1 : 1;
		for (let attempt = 1; ; attempt++) {
			try {
				return await runTransaction(this, engine, fn);
			} catch (e) {
				if (isSerializationConflict(e) && attempt < maxAttempts) continue;
				throw e;
			}
		}
	}
}

// The scope closes with the transaction: a statement from a promise the callback did not await runs
// auto-commit instead of reaching the ended handle.
async function runTransaction<T>(
	owner: DatabaseCore,
	engine: DatabaseEngine,
	fn: (tx: Transaction) => Promise<T>,
): Promise<T> {
	let scope: TransactionScope | undefined;
	try {
		return await withTransaction(engine, (handle) => {
			scope = new TransactionScope(owner, handle);
			return runInTransactionScope(scope, () => fn(new TransactionImpl(engine, handle)));
		});
	} catch (e) {
		throw asTransactionError(e);
	} finally {
		if (scope) scope.open = false;
	}
}

// An ApiError, a branded Blocks error or one of DatabaseErrors passes through. Anything else (a driver
// error, a plain Error) becomes TransactionFailed so its text never leaves the server.
function asTransactionError(e: unknown): Error {
	const error = asError(e);
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
