// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { blocksError } from '@aws-blocks/core';
import type { DatabaseEngine, TransactionHandle } from '@aws-blocks/data-common';
import { DSQL_PERMISSION_ERROR_NAME, serializationConflict } from '../errors.js';
import { inspectStatement, type StatementInfo, TransactionTracker, validateStatement } from '../validation.js';
import { currentTransactionHandle } from './tx-scope.js';

const DDL_NOT_ALLOWED_MESSAGE =
	'DDL statements (CREATE, ALTER, DROP) are not allowed in the app runtime of a DSQL cluster. ' +
	'Put them in a migration file; the migration Lambda runs DDL with dsql:DbConnectAdmin.';

interface TrackedHandle {
	tracker?: TransactionTracker;
}

const DELETE_TARGET = /^\s*DELETE\s+FROM\s+(?:ONLY\s+)?((?:"[^"]+"|[\w.])+)/i;

// Bumped by every migration run in the process: a foreign key added in one block's schema can point at
// another block's table on a shared cluster, so every engine's cascade cache goes stale together.
let ddlGeneration = 0;

export class MockEngine implements DatabaseEngine {
	private shouldConflict = false;
	private allowDdl = false;
	private cascades = new Map<string, string[]>();
	private cascadesGeneration = ddlGeneration;

	constructor(private readonly inner: DatabaseEngine) {}

	simulateConflict(): void {
		this.shouldConflict = true;
	}

	async withDdl<T>(fn: () => Promise<T>): Promise<T> {
		const previous = this.allowDdl;
		this.allowDdl = true;
		ddlGeneration++;
		try {
			return await fn();
		} finally {
			this.allowDdl = previous;
			ddlGeneration++;
		}
	}

	// A migration's statements were linted as files at plan time; only app-runtime SQL is linted here.
	// Parity with the deployed grant: the app role has DML only, so DDL is refused outside a migration.
	private guard(sql: string): StatementInfo {
		const info = inspectStatement(sql);
		if (!this.allowDdl) {
			validateStatement(sql);
			if (info.kind === 'ddl') throw blocksError(DSQL_PERMISSION_ERROR_NAME, DDL_NOT_ALLOWED_MESSAGE);
		}
		return info;
	}

	query<T>(sql: string, params?: unknown[]): Promise<T[]> {
		this.guard(sql);
		return this.inner.query<T>(sql, params);
	}

	async execute(sql: string, params?: unknown[]): Promise<{ rowCount: number }> {
		const info = this.guard(sql);
		if (info.kind !== 'dml') return this.inner.execute(sql, params);

		const ambient = currentTransactionHandle() as TrackedHandle | undefined;
		if (ambient) {
			ambient.tracker?.recordStatement(info.kind, sql, params);
			const result = await this.inner.execute(sql, params);
			ambient.tracker?.recordRowCount(result.rowCount);
			return result;
		}

		// An auto-commit DML statement is one transaction on DSQL: enforce its limits before committing.
		const handle = await this.beginTransaction();
		try {
			const result = await this.tracked(handle, info, sql, params);
			// Commit on the inner engine: a pending simulateConflict() is for the user's next transaction, not this one.
			await this.inner.commitTransaction(handle);
			(handle as TrackedHandle).tracker?.reset();
			return result;
		} catch (e) {
			await this.inner.rollbackTransaction(handle).catch(() => {});
			throw e;
		}
	}

	async beginTransaction(): Promise<TransactionHandle> {
		const handle = await this.inner.beginTransaction();
		if (typeof handle === 'object' && handle !== null) {
			(handle as TrackedHandle).tracker = new TransactionTracker();
		}
		return handle;
	}

	async commitTransaction(handle: TransactionHandle): Promise<void> {
		if (this.shouldConflict) {
			this.shouldConflict = false;
			await this.inner.rollbackTransaction(handle);
			throw serializationConflict(new Error('Simulated serialization conflict'));
		}
		await this.inner.commitTransaction(handle);
		(handle as TrackedHandle | null)?.tracker?.reset();
	}

	async rollbackTransaction(handle: TransactionHandle): Promise<void> {
		await this.inner.rollbackTransaction(handle);
		(handle as TrackedHandle | null)?.tracker?.reset();
	}

	queryInTransaction<T>(handle: TransactionHandle, sql: string, params?: unknown[]): Promise<T[]> {
		const info = this.guard(sql);
		(handle as TrackedHandle | null)?.tracker?.recordStatement(info.kind, sql, params);
		return this.inner.queryInTransaction<T>(handle, sql, params);
	}

	executeInTransaction(handle: TransactionHandle, sql: string, params?: unknown[]): Promise<{ rowCount: number }> {
		return this.tracked(handle, this.guard(sql), sql, params);
	}

	private async tracked(
		handle: TransactionHandle,
		info: StatementInfo,
		sql: string,
		params?: unknown[],
	): Promise<{ rowCount: number }> {
		const tracker = (handle as TrackedHandle | null)?.tracker;
		tracker?.recordStatement(info.kind, sql, params);
		const cascade = tracker ? await this.cascadeTargets(handle, info.cleaned) : [];
		const before = await this.countRows(handle, cascade);
		const result = await this.inner.executeInTransaction(handle, sql, params);
		const after = await this.countRows(handle, cascade);
		tracker?.recordRowCount(result.rowCount + Math.max(0, before - after));
		return result;
	}

	// DSQL counts the rows an `ON DELETE CASCADE` removes, transitively, toward its 3,000-row transaction
	// limit; so does the mock.
	private async cascadeTargets(handle: TransactionHandle, cleanedSql: string): Promise<string[]> {
		const target = DELETE_TARGET.exec(cleanedSql)?.[1];
		if (!target) return [];
		if (this.cascadesGeneration !== ddlGeneration) {
			this.cascades = new Map();
			this.cascadesGeneration = ddlGeneration;
		}
		const cached = this.cascades.get(target);
		if (cached) return cached;
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
		const targets = [...seen];
		this.cascades.set(target, targets);
		return targets;
	}

	private async countRows(handle: TransactionHandle, tables: string[]): Promise<number> {
		let total = 0;
		for (const table of tables) {
			const rows = await this.inner.queryInTransaction<{ n: number }>(
				handle,
				`SELECT count(*)::int AS n FROM ${table}`,
			);
			total += Number(rows[0]?.n ?? 0);
		}
		return total;
	}

	destroy(): Promise<void> {
		return this.inner.destroy();
	}
}
