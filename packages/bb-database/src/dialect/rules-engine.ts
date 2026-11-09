// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { blocksError } from '@aws-blocks/core';
import type { DatabaseEngine, TransactionHandle } from '@aws-blocks/data-common';
import { EngineTransaction, withTransaction } from '../engines/handle.js';
import { DSQL_PERMISSION_ERROR_NAME, serializationConflict } from '../errors.js';
import { inspectStatement, type StatementInfo, TransactionTracker, validateStatement } from './validation.js';

const DDL_NOT_ALLOWED_MESSAGE =
	'DDL statements (CREATE, ALTER, DROP) are not allowed in the app runtime of a DSQL cluster. ' +
	'Put them in a migration file; the migration Lambda runs DDL with dsql:DbConnectAdmin.';

export interface CountedRows<T> {
	rows: T[];
	rowCount: number;
}

/**
 * What the mock wraps: an engine that also reports the affected-row count of a statement issued inside a
 * transaction, so DML with `RETURNING` (or none) counts toward the row limit by what it changed, not by what
 * it returned.
 */
export interface RowCountingEngine extends DatabaseEngine {
	queryCountedInTransaction<T>(handle: TransactionHandle, sql: string, params?: unknown[]): Promise<CountedRows<T>>;
}

const DELETE_TARGET = /^\s*DELETE\s+FROM\s+(?:ONLY\s+)?((?:"[^"]+"|[\w.])+)/i;

export class DsqlRulesEngine implements DatabaseEngine {
	private shouldConflict = false;
	private allowDdl = false;
	/** The per-transaction limit tracker, keyed by the inner engine's handle. */
	private readonly trackers = new WeakMap<EngineTransaction, TransactionTracker>();

	constructor(private readonly inner: RowCountingEngine) {}

	simulateConflict(): void {
		this.shouldConflict = true;
	}

	async withDdl<T>(fn: () => Promise<T>): Promise<T> {
		const previous = this.allowDdl;
		this.allowDdl = true;
		try {
			return await fn();
		} finally {
			this.allowDdl = previous;
		}
	}

	// A migration's statements were linted as files at plan time; only app-runtime SQL is linted here.
	// Parity with the deployed grant: the app role has DML only, so DDL is refused outside a migration.
	private guard(sql: string): StatementInfo {
		const info = inspectStatement(sql);
		if (!this.allowDdl) {
			validateStatement(sql, info.cleaned);
			if (info.kind === 'ddl') throw blocksError(DSQL_PERMISSION_ERROR_NAME, DDL_NOT_ALLOWED_MESSAGE);
		}
		return info;
	}

	async query<T>(sql: string, params?: unknown[]): Promise<T[]> {
		const info = this.guard(sql);
		if (info.kind !== 'dml') return this.inner.query<T>(sql, params);
		const { rows } = await this.dml(info, sql, params, (handle) =>
			this.inner.queryCountedInTransaction<T>(handle, sql, params),
		);
		return rows;
	}

	execute(sql: string, params?: unknown[]): Promise<{ rowCount: number }> {
		const info = this.guard(sql);
		if (info.kind !== 'dml') return this.inner.execute(sql, params);
		return this.dml(info, sql, params, (handle) => this.inner.executeInTransaction(handle, sql, params));
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

	async beginTransaction(): Promise<TransactionHandle> {
		const handle = await this.inner.beginTransaction();
		this.track(handle);
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

	async queryInTransaction<T>(handle: TransactionHandle, sql: string, params?: unknown[]): Promise<T[]> {
		const info = this.guard(sql);
		if (info.kind !== 'dml') return this.inner.queryInTransaction<T>(handle, sql, params);
		const { rows } = await this.trackedInTransaction(handle, info, sql, params, () =>
			this.inner.queryCountedInTransaction<T>(handle, sql, params),
		);
		return rows;
	}

	executeInTransaction(handle: TransactionHandle, sql: string, params?: unknown[]): Promise<{ rowCount: number }> {
		const info = this.guard(sql);
		if (info.kind !== 'dml') return this.inner.executeInTransaction(handle, sql, params);
		return this.trackedInTransaction(handle, info, sql, params, () =>
			this.inner.executeInTransaction(handle, sql, params),
		);
	}

	private track(handle: TransactionHandle): void {
		if (handle instanceof EngineTransaction) this.trackers.set(handle, new TransactionTracker());
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
