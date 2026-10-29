// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { brandBlocksError } from '@aws-blocks/core';
import type { DatabaseEngine, TransactionHandle } from '@aws-blocks/data-common';
import {
	DatabaseErrors,
	DSQL_PERMISSION_ERROR_NAME,
	PG_SERIALIZATION_FAILURE,
	serializationConflict,
} from '../errors.js';
import { classifyStatement, stripLiteralsAndComments, TransactionTracker, validateStatement } from '../validation.js';
import { currentTransactionHandle } from './tx-scope.js';

const DDL_NOT_ALLOWED_MESSAGE =
	'DDL statements (CREATE, ALTER, DROP) are not allowed in the app runtime of a DSQL cluster. ' +
	'Put them in a migration file; the migration Lambda runs DDL with dsql:DbConnectAdmin.';

interface TrackedHandle {
	tracker?: TransactionTracker;
}

const DELETE_TARGET = /^\s*DELETE\s+FROM\s+(?:ONLY\s+)?((?:"[^"]+"|[\w.])+)/i;

export class MockEngine implements DatabaseEngine {
	private shouldConflict = false;
	private allowDdl = false;

	constructor(private readonly inner: DatabaseEngine) {}

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

	private preprocess(sql: string): string {
		validateStatement(sql);
		// Parity with the deployed grant: the app role has DML only, so DDL is refused here as well.
		if (!this.allowDdl && classifyStatement(sql) === 'ddl') {
			const err = new Error(DDL_NOT_ALLOWED_MESSAGE);
			err.name = DSQL_PERMISSION_ERROR_NAME;
			throw brandBlocksError(err);
		}
		// PGlite rejects ASYNC; it runs the asynchronous DDL forms synchronously.
		return sql
			.replace(/\b(CREATE\s+(?:UNIQUE\s+)?INDEX)\s+ASYNC\b/gi, '$1')
			.replace(/\b(ALTER\s+TABLE)\s+ASYNC\b/gi, '$1');
	}

	query<T>(sql: string, params?: unknown[]): Promise<T[]> {
		return this.inner.query<T>(this.preprocess(sql), params);
	}

	async execute(sql: string, params?: unknown[]): Promise<{ rowCount: number }> {
		const normalized = this.preprocess(sql);
		if (classifyStatement(sql) !== 'dml') return this.inner.execute(normalized, params);

		const ambient = currentTransactionHandle() as TrackedHandle | undefined;
		if (ambient) {
			ambient.tracker?.recordStatement(sql, params);
			const result = await this.inner.execute(normalized, params);
			ambient.tracker?.recordRowCount(result.rowCount);
			return result;
		}

		// An auto-commit DML statement is one transaction on DSQL: enforce its limits before committing.
		const handle = await this.beginTransaction();
		try {
			const result = await this.executeInTransaction(handle, sql, params);
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
			const err = Object.assign(
				new Error('Simulated serialization conflict. The transaction was not committed.'),
				{
					code: PG_SERIALIZATION_FAILURE,
					name: DatabaseErrors.SerializationFailure,
				},
			);
			throw serializationConflict(err);
		}
		await this.inner.commitTransaction(handle);
		(handle as TrackedHandle | null)?.tracker?.reset();
	}

	async rollbackTransaction(handle: TransactionHandle): Promise<void> {
		await this.inner.rollbackTransaction(handle);
		(handle as TrackedHandle | null)?.tracker?.reset();
	}

	queryInTransaction<T>(handle: TransactionHandle, sql: string, params?: unknown[]): Promise<T[]> {
		const normalized = this.preprocess(sql);
		(handle as TrackedHandle | null)?.tracker?.recordStatement(sql, params);
		return this.inner.queryInTransaction<T>(handle, normalized, params);
	}

	async executeInTransaction(
		handle: TransactionHandle,
		sql: string,
		params?: unknown[],
	): Promise<{ rowCount: number }> {
		const normalized = this.preprocess(sql);
		const tracker = (handle as TrackedHandle | null)?.tracker;
		tracker?.recordStatement(sql, params);
		const cascade = tracker ? await this.cascadeTargets(handle, sql) : [];
		const before = await this.countRows(handle, cascade);
		const result = await this.inner.executeInTransaction(handle, normalized, params);
		const after = await this.countRows(handle, cascade);
		tracker?.recordRowCount(result.rowCount + Math.max(0, before - after));
		return result;
	}

	// DSQL counts the rows an `ON DELETE CASCADE` removes, transitively, toward its 3,000-row transaction
	// limit; so does the mock.
	private async cascadeTargets(handle: TransactionHandle, sql: string): Promise<string[]> {
		const target = DELETE_TARGET.exec(stripLiteralsAndComments(sql))?.[1];
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
