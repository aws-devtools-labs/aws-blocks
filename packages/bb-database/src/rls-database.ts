// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
	DatabaseBase,
	type DatabaseEngine,
	type SqlQuery,
	type Transaction,
	type TransactionHandle,
	unwrapQuery,
} from '@aws-blocks/data-common';
import { DatabaseErrors, isKnownDatabaseErrorName, reTagged } from './errors.js';
import { type RLSContext, setRLSContext } from './rls.js';

/** Read a diagnostic field (e.g. pg `code`/`severity`) off an unknown caught value. */
function readErrorField(err: unknown, key: string): unknown {
	return typeof err === 'object' && err !== null && key in err ? Reflect.get(err, key) : undefined;
}

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

/**
 * `DatabaseBase` extended with Row Level Security, raw query methods, and
 * `TransactionFailed` error naming. The engine-facing core every `Database`
 * entry point delegates to.
 */
export class RLSEnabledDatabase extends DatabaseBase {
	/**
	 * Return a new instance scoped with RLS context. Every query on the returned
	 * instance runs inside a transaction with Supabase-compatible session
	 * variables (`SET LOCAL ROLE` + `request.jwt.claims`).
	 */
	withRLS(context: RLSContext): RLSScopedDatabase {
		return new RLSScopedDatabase(this.engine, context);
	}

	/** @internal Execute a raw SQL query (used by `crud()` handlers). */
	async queryRaw<T>(sql: string, params: unknown[]): Promise<T[]> {
		return this.engine.query<T>(sql, params);
	}

	/** @internal Execute a raw SQL statement (used by `crud()` handlers). */
	async executeRaw(sql: string, params: unknown[]): Promise<{ rowCount: number }> {
		return this.engine.execute(sql, params);
	}

	/**
	 * Execute a function within a database transaction. Auto-commits on success,
	 * rolls back if the function throws.
	 *
	 * @throws {DatabaseErrors.TransactionFailed} If the transaction cannot be
	 *   committed or `fn` throws a non-database error
	 */
	override async transaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
		try {
			return await super.transaction(fn);
		} catch (e) {
			throw asTransactionError(e);
		}
	}
}

/**
 * The value `withRLS()` returns: every operation runs inside a transaction that
 * first sets the RLS session variables. Cannot be nested.
 */
export class RLSScopedDatabase extends RLSEnabledDatabase {
	private readonly ctx: RLSContext;

	constructor(engine: DatabaseEngine, ctx: RLSContext) {
		super(engine);
		this.ctx = ctx;
	}

	/** @throws Always: RLS scopes cannot be nested. */
	override withRLS(_context: RLSContext): RLSScopedDatabase {
		throw new Error('Cannot nest withRLS() calls. This database is already RLS-scoped.');
	}

	override async query<T>(query: SqlQuery): Promise<T[]> {
		const { sql, params } = unwrapQuery(query);
		return this.queryRaw<T>(sql, params);
	}

	override async queryRaw<T>(sql: string, params: unknown[]): Promise<T[]> {
		const handle = await this.engine.beginTransaction();
		try {
			await setRLSContext(this.engine, handle, this.ctx);
			const rows = await this.engine.queryInTransaction<T>(handle, sql, params);
			await this.engine.commitTransaction(handle);
			return rows;
		} catch (e) {
			await this.engine.rollbackTransaction(handle).catch(() => {});
			throw e;
		}
	}

	override async queryOne<T>(query: SqlQuery): Promise<T | null> {
		const rows = await this.query<T>(query);
		return rows[0] ?? null;
	}

	override async execute(query: SqlQuery): Promise<{ rowCount: number }> {
		const { sql, params } = unwrapQuery(query);
		return this.executeRaw(sql, params);
	}

	override async executeRaw(sql: string, params: unknown[]): Promise<{ rowCount: number }> {
		const handle = await this.engine.beginTransaction();
		try {
			await setRLSContext(this.engine, handle, this.ctx);
			const result = await this.engine.executeInTransaction(handle, sql, params);
			await this.engine.commitTransaction(handle);
			return result;
		} catch (e) {
			await this.engine.rollbackTransaction(handle).catch(() => {});
			throw e;
		}
	}

	override async transaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
		const handle = await this.engine.beginTransaction();
		try {
			await setRLSContext(this.engine, handle, this.ctx);
			const result = await fn(new TransactionImpl(this.engine, handle));
			await this.engine.commitTransaction(handle);
			return result;
		} catch (e) {
			try {
				await this.engine.rollbackTransaction(handle);
			} catch (rollbackErr) {
				console.error('[bb-database] Rollback failed after transaction error', {
					code: readErrorField(rollbackErr, 'code'),
					severity: readErrorField(rollbackErr, 'severity'),
				});
			}
			throw asTransactionError(e);
		}
	}
}
