// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { DatabaseEngine, TransactionHandle } from '../common/engine.js';
import { configError, foreignTransactionHandle, transactionEnded } from '../errors.js';
import type { DataApiOptions } from '../types.js';

// The handle an engine's `beginTransaction()` returns. `settled` is set by the first of commitTransaction()
// and rollbackTransaction(), so the connection (or mutex) is freed exactly once and a later call sees it
// (DESIGN §4.3).
export abstract class EngineTransaction {
	settled = false;
	/**
	 * Opened by a `Session` (the Kysely dialect). Kysely runs its transaction callback outside the block's
	 * transaction scope, so no other statement can join this transaction.
	 */
	fromSession = false;
}

export interface TransactionModes {
	readonly isolationLevel?: string;
	readonly accessMode?: string;
}

// The modes go into the text of SET TRANSACTION, so only PostgreSQL's own values pass.
const ISOLATION_LEVELS = new Set(['read uncommitted', 'read committed', 'repeatable read', 'serializable']);
const ACCESS_MODES = new Set(['read only', 'read write']);

/** The `SET TRANSACTION` statement for `modes`; `undefined` when there are none. */
export function setTransactionStatement({ isolationLevel, accessMode }: TransactionModes = {}): string | undefined {
	if (isolationLevel !== undefined && !ISOLATION_LEVELS.has(isolationLevel)) {
		throw configError(`'${isolationLevel}' is not a PostgreSQL isolation level.`);
	}
	if (accessMode !== undefined && !ACCESS_MODES.has(accessMode)) {
		throw configError(`'${accessMode}' is not a PostgreSQL transaction access mode.`);
	}
	const modes = [isolationLevel && `isolation level ${isolationLevel}`, accessMode].filter(Boolean).join(' ');
	return modes ? `set transaction ${modes}` : undefined;
}

/** Runs `sql` in the transaction a `beginTransaction()` has just opened; a failure rolls the transaction back. */
export async function firstStatement(
	engine: DatabaseEngine,
	handle: TransactionHandle,
	sql: string,
	params?: unknown[],
): Promise<void> {
	try {
		await engine.executeInTransaction(handle, sql, params);
	} catch (e) {
		await engine.rollbackTransaction(handle).catch(() => {});
		throw e;
	}
}

export interface CountedRows<T> {
	rows: T[];
	/** The rows the statement changed; 0 for a statement that changes none. */
	rowCount: number;
}

/**
 * An engine that also reports the affected-row count of a statement together with its rows, so DML with
 * `RETURNING` (or none) counts by what it changed, not by what it returned. The mock's row limit and
 * the Kysely dialect both read it.
 */
export interface RowCountingEngine extends DatabaseEngine {
	/**
	 * `modes` become `SET TRANSACTION`, the transaction's first statement. The engine issues it, so an engine
	 * that wraps this one can run its own first statement after it: PostgreSQL takes no isolation level once a
	 * query has run.
	 */
	beginTransaction(modes?: TransactionModes): Promise<TransactionHandle>;
	queryCounted<T>(sql: string, params?: unknown[]): Promise<CountedRows<T>>;
	queryCountedInTransaction<T>(handle: TransactionHandle, sql: string, params?: unknown[]): Promise<CountedRows<T>>;
}

/**
 * The four methods of a {@link RowCountingEngine} that return a part of what its two counted methods return.
 * Every statement of such an engine takes one of the counted methods.
 */
export abstract class CountedEngine {
	abstract queryCounted<T>(sql: string, params?: unknown[]): Promise<CountedRows<T>>;
	abstract queryCountedInTransaction<T>(
		handle: TransactionHandle,
		sql: string,
		params?: unknown[],
	): Promise<CountedRows<T>>;

	async query<T>(sql: string, params?: unknown[]): Promise<T[]> {
		return (await this.queryCounted<T>(sql, params)).rows;
	}

	async execute(sql: string, params?: unknown[]): Promise<{ rowCount: number }> {
		return { rowCount: (await this.queryCounted(sql, params)).rowCount };
	}

	async queryInTransaction<T>(handle: TransactionHandle, sql: string, params?: unknown[]): Promise<T[]> {
		return (await this.queryCountedInTransaction<T>(handle, sql, params)).rows;
	}

	async executeInTransaction(
		handle: TransactionHandle,
		sql: string,
		params?: unknown[],
	): Promise<{ rowCount: number }> {
		return { rowCount: (await this.queryCountedInTransaction(handle, sql, params)).rowCount };
	}
}

/** The engine's own, still-open handle; anything else is refused with `TransactionFailed`. */
export function openTransaction<H extends EngineTransaction>(
	handle: TransactionHandle,
	ctor: abstract new (...args: never[]) => H,
	engineName: string,
): H {
	if (!(handle instanceof ctor)) throw foreignTransactionHandle(engineName);
	if (handle.settled) throw transactionEnded();
	return handle;
}

export function isSettled(handle: TransactionHandle): boolean {
	return handle instanceof EngineTransaction && handle.settled;
}

/**
 * BEGIN, `fn`, COMMIT; a `fn` that throws is rolled back. The COMMIT sits outside the rollback path: a failed
 * commit has settled the handle on both engines (DESIGN §4.3), so a rollback after it is a no-op on them and, on
 * an engine without that contract, would reach a connection its next borrower holds.
 */
export async function withTransaction<T>(
	engine: DatabaseEngine,
	fn: (handle: TransactionHandle) => Promise<T>,
): Promise<T> {
	const handle = await engine.beginTransaction();
	let result: T;
	try {
		result = await fn(handle);
	} catch (e) {
		await engine.rollbackTransaction(handle).catch(() => {});
		throw e;
	}
	await engine.commitTransaction(handle);
	return result;
}

/**
 * The engine of a database behind the RDS Data API. The client of the Data API is loaded here, so an app that
 * has no such database never loads it.
 */
export const dataApiEngine = async (coordinates: DataApiOptions): Promise<RowCountingEngine> =>
	new (await import('./data-api-engine.js')).DataApiEngine(coordinates);
