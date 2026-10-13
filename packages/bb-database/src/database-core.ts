// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The runtime behavior every `Database` entry point shares: the four query
 * methods with their retry policy, `transaction()` with conflict retry, RLS
 * scoping, and `crud()`. The mock and aws classes differ only in how they
 * produce the engine, so that is injected as an async factory.
 */
import type { DatabaseEngine, SqlQuery, Transaction } from '@aws-blocks/data-common';
import { AUTOCOMMIT_CONFLICT_BACKOFF_MS, DEFAULT_MAX_RETRIES } from './constants.js';
import { createCrudHandlers, crudMethodNames } from './crud/index.js';
import type { CrudOptions, TableSchema, TableTypeMeta } from './crud/types.js';
import { runInTransactionScope } from './engines/tx-scope.js';
import { configError, isSerializationConflict, rlsUnavailable } from './errors.js';
import type { RLSContext } from './rls.js';
import { asTransactionError, RLSEnabledDatabase, type RLSScopedDatabase, TransactionImpl } from './rls-database.js';
import type { ClusterKind, TransactionOptions } from './types.js';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface DatabaseCoreOptions {
	kind: ClusterKind;
	/** Produces (and memoizes) the engine; may run migrations first. */
	engine: () => Promise<DatabaseEngine>;
	schema?: TableSchema;
	/** Names the block in error messages. */
	fullId: string;
}

export class DatabaseCore {
	private base: Promise<RLSEnabledDatabase> | null = null;

	constructor(private readonly options: DatabaseCoreOptions) {}

	/** @internal The underlying engine. Used by `createKyselyAdapter()`. */
	async getEngine(): Promise<DatabaseEngine> {
		return (await this.resolve()).getEngine();
	}

	private resolve(): Promise<RLSEnabledDatabase> {
		if (!this.base) {
			this.base = this.options.engine().then((engine) => new RLSEnabledDatabase(engine));
			this.base.catch(() => {
				// A failed initialization is not cached: the next call retries.
				this.base = null;
			});
		}
		return this.base;
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

	async query<T>(query: SqlQuery): Promise<T[]> {
		const base = await this.resolve();
		return this.withConflictRetry(() => base.query<T>(query));
	}

	async queryOne<T>(query: SqlQuery): Promise<T | null> {
		const base = await this.resolve();
		return this.withConflictRetry(() => base.queryOne<T>(query));
	}

	async execute(query: SqlQuery): Promise<{ rowCount: number }> {
		const base = await this.resolve();
		return this.withConflictRetry(() => base.execute(query));
	}

	async transaction<T>(fn: (tx: Transaction) => Promise<T>, options?: TransactionOptions): Promise<T> {
		const base = await this.resolve();
		const engine = base.getEngine();
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

	async withRLS(context: RLSContext): Promise<RLSScopedDatabase> {
		if (this.options.kind === 'distributed') throw rlsUnavailable();
		return (await this.resolve()).withRLS(context);
	}

	/**
	 * Generate typed CRUD handlers for the given tables. Handler creation is
	 * deferred to the first call so the engine (and any migrations) resolve lazily.
	 */
	crud<M extends Record<string, TableTypeMeta>>(
		options: CrudOptions<M>,
	): Record<string, (...args: never[]) => Promise<unknown>> {
		if (this.options.kind === 'distributed') throw rlsUnavailable();
		const schema = this.options.schema;
		if (!schema) {
			throw configError(
				`Database '${this.options.fullId}': crud() requires schema metadata. Pass \`schema: tableMeta\` to the constructor.`,
			);
		}
		let handlers: Record<string, (...args: never[]) => Promise<unknown>> | null = null;
		const ensure = async () => {
			if (!handlers) handlers = createCrudHandlers(await this.resolve(), schema, options);
			return handlers;
		};
		const target: Record<string, (...args: never[]) => Promise<unknown>> = {};
		for (const name of crudMethodNames(schema, options as CrudOptions<Record<string, TableTypeMeta>>)) {
			target[name] = async (...args: never[]) => {
				const h = await ensure();
				return h[name](...args);
			};
		}
		return target;
	}
}

/**
 * One attempt at a transaction. Mirrors `RLSEnabledDatabase.transaction()` but
 * runs the callback inside the transaction scope so a `db.query()` from within
 * it joins the open transaction on the serialized local engine.
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
