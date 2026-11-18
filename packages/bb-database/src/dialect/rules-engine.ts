// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { TransactionHandle } from '../common/engine.js';
import {
	CountedEngine,
	type CountedRows,
	EngineTransaction,
	firstStatement,
	type RowCountingEngine,
	setTransactionStatement,
	type TransactionModes,
	withTransaction,
} from '../engines/handle.js';
import type { SchemaEngine } from '../engines/pglite-cluster.js';
import { serializationConflict } from '../errors.js';
import type { ClusterType } from '../types.js';
import { inspectStatement, type StatementInfo, TransactionTracker, validateStatement } from './validation.js';

const DELETE_TARGET = /^\s*DELETE\s+FROM\s+(?:ONLY\s+)?((?:"[^"]+"|[\w.])+)/i;

/**
 * The local stand-in for a deployed cluster's rules, over a PGlite schema engine. Every kind gets
 * `simulateConflict()`. A `dsql` cluster also gets dsql-lint on each statement and the per-transaction row
 * and size limits; an `aurora` cluster is PostgreSQL and needs neither. The app role's DML-only rule is
 * PostgreSQL's own: the schema engine runs app statements as a role with those grants.
 */
export class RulesEngine extends CountedEngine implements RowCountingEngine {
	private shouldConflict = false;
	/** The per-transaction limit tracker, keyed by the inner engine's handle. */
	private readonly trackers = new WeakMap<EngineTransaction, TransactionTracker>();

	constructor(
		private readonly inner: SchemaEngine,
		readonly kind: ClusterType,
	) {
		super();
	}

	private get limited(): boolean {
		return this.kind === 'dsql';
	}

	simulateConflict(): void {
		this.shouldConflict = true;
	}

	/** Runs `fn` as the cluster admin: a migration run, or a test's setup. */
	asAdmin<T>(fn: () => Promise<T>): Promise<T> {
		return this.inner.asAdmin(fn);
	}

	// A migration's statements were linted as files at plan time; only app-runtime SQL is linted here.
	private guard(sql: string): StatementInfo {
		const info = inspectStatement(sql);
		if (this.limited && !this.inner.isAdmin) validateStatement(sql, info.cleaned);
		return info;
	}

	// Every statement takes one of the two counted methods; the others (CountedEngine) return a part of their result.
	async queryCounted<T>(sql: string, params?: unknown[]): Promise<CountedRows<T>> {
		const info = this.guard(sql);
		if (info.kind !== 'dml' || !this.limited) return this.inner.queryCounted<T>(sql, params);
		return this.dml(info, sql, params, (handle) => this.inner.queryCountedInTransaction<T>(handle, sql, params));
	}

	// A DML statement reaching the engine directly is one transaction on DSQL (a statement inside a
	// `transaction()` callback arrives through the in-transaction methods), so its limits are enforced before commit.
	private dml<R extends { rowCount: number }>(
		info: StatementInfo,
		sql: string,
		params: unknown[] | undefined,
		run: (handle: TransactionHandle) => Promise<R>,
	): Promise<R> {
		// On the inner engine: a pending simulateConflict() is for the user's next transaction, not this one.
		return withTransaction(this.inner, (handle) => {
			this.track(handle);
			return this.trackedInTransaction(handle, info, sql, params, () => run(handle));
		});
	}

	async beginTransaction(modes?: TransactionModes): Promise<TransactionHandle> {
		const settings = setTransactionStatement(modes);
		const handle = await this.inner.beginTransaction();
		this.track(handle);
		// Through this engine, so a `dsql` cluster lints it like any statement of the application's.
		if (settings) await firstStatement(this, handle, settings);
		return handle;
	}

	async commitTransaction(handle: TransactionHandle): Promise<void> {
		if (this.shouldConflict) {
			this.shouldConflict = false;
			await this.inner.rollbackTransaction(handle);
			throw serializationConflict(new Error('Simulated serialization conflict'));
		}
		await this.inner.commitTransaction(handle);
	}

	rollbackTransaction(handle: TransactionHandle): Promise<void> {
		return this.inner.rollbackTransaction(handle);
	}

	async queryCountedInTransaction<T>(
		handle: TransactionHandle,
		sql: string,
		params?: unknown[],
	): Promise<CountedRows<T>> {
		const info = this.guard(sql);
		const run = () => this.inner.queryCountedInTransaction<T>(handle, sql, params);
		if (info.kind !== 'dml' || !this.limited) return run();
		return this.trackedInTransaction(handle, info, sql, params, run);
	}

	private track(handle: TransactionHandle): void {
		if (this.limited && handle instanceof EngineTransaction) this.trackers.set(handle, new TransactionTracker());
	}

	// The catalog and count queries run in the same transaction as the statement.
	private async trackedInTransaction<R extends { rowCount: number }>(
		handle: TransactionHandle,
		info: StatementInfo,
		sql: string,
		params: unknown[] | undefined,
		run: () => Promise<R>,
	): Promise<R> {
		const tracker = handle instanceof EngineTransaction ? this.trackers.get(handle) : undefined;
		if (!tracker) return run();
		tracker.recordStatement(info.kind, sql, params);
		const cascade = await this.cascadeTargets(handle, info.cleaned);
		const before = cascade.length > 0 ? await this.countRows(handle, cascade) : 0;
		const result = await run();
		const cascaded =
			cascade.length > 0 && result.rowCount > 0 ? before - (await this.countRows(handle, cascade)) : 0;
		tracker.recordRowCount(result.rowCount + Math.max(0, cascaded));
		return result;
	}

	// DSQL counts the rows an `ON DELETE CASCADE` removes, transitively, toward its 3,000-row transaction
	// limit; so does the mock.
	private async cascadeTargets(handle: TransactionHandle, cleanedSql: string): Promise<string[]> {
		const target = DELETE_TARGET.exec(cleanedSql)?.[1];
		if (!target) return [];
		const seen = new Set<string>();
		const queue = [target];
		while (queue.length > 0) {
			const parent = queue.shift() as string;
			let children: { child: string }[];
			try {
				children = await this.inner.queryInTransaction<{ child: string }>(
					handle,
					// to_regclass() returns NULL for an unknown table; a failed cast would abort the user's transaction.
					"SELECT DISTINCT conrelid::regclass::text AS child FROM pg_constraint WHERE contype = 'f' AND confdeltype = 'c' AND confrelid = to_regclass($1)",
					[parent],
				);
			} catch {
				return [...seen];
			}
			for (const { child } of children) {
				if (seen.has(child)) continue;
				seen.add(child);
				queue.push(child);
			}
		}
		return [...seen];
	}

	// `tables` are `regclass::text` values from the catalog: already quoted and schema-qualified where needed.
	private async countRows(handle: TransactionHandle, tables: string[]): Promise<number> {
		const sum = tables.map((table) => `(SELECT count(*) FROM ${table})`).join(' + ');
		const rows = await this.inner.queryInTransaction<{ n: number }>(handle, `SELECT (${sum})::int AS n`);
		return Number(rows[0]?.n ?? 0);
	}

	destroy(): Promise<void> {
		return this.inner.destroy();
	}
}
