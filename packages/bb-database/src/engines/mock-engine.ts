// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The local-mode decorator every mock `Database` wraps its engine in.
 *
 * - `simulateConflict()` makes the next commit raise `SerializationFailure` on
 *   every kind, so retry tests do not depend on which cluster is deployed.
 * - On a `distributed` cluster it adds the DSQL validation layer: unsupported
 *   statements are rejected before they reach PGlite, DDL on the app connection
 *   is refused (parity with the deployed DML-only grant), `CREATE INDEX ASYNC`
 *   is normalized to a synchronous index, and the per-transaction DDL/DML and
 *   row-count limits are enforced.
 */
import { brandBlocksError } from '@aws-blocks/core';
import type { DatabaseEngine, TransactionHandle } from '@aws-blocks/data-common';
import {
	DatabaseErrors,
	DSQL_PERMISSION_ERROR_NAME,
	PG_SERIALIZATION_FAILURE,
	serializationConflict,
} from '../errors.js';
import { classifyStatement, TransactionTracker, validateStatement } from '../validation.js';

/** Stable, BB-authored message for the mock's DDL guard. */
export const DDL_NOT_ALLOWED_MESSAGE =
	'DDL statements (CREATE, ALTER, DROP) are not allowed in the app runtime of a distributed cluster. ' +
	'Put them in a migration file; the migration Lambda runs DDL with dsql:DbConnectAdmin.';

interface TrackedHandle {
	tracker?: TransactionTracker;
}

export interface MockEngineOptions {
	/** `distributed` enables the DSQL validation layer. */
	dialect: 'distributed' | 'postgres';
}

export class MockEngine implements DatabaseEngine {
	private shouldConflict = false;
	private allowDdl = false;

	constructor(
		private readonly inner: DatabaseEngine,
		private readonly options: MockEngineOptions,
	) {}

	/** Test helper: make the next commit raise `SerializationFailure`. */
	simulateConflict(): void {
		this.shouldConflict = true;
	}

	/** Allow DDL for the duration of `fn` (the migration runner). */
	async withDdl<T>(fn: () => Promise<T>): Promise<T> {
		const previous = this.allowDdl;
		this.allowDdl = true;
		try {
			return await fn();
		} finally {
			this.allowDdl = previous;
		}
	}

	private get distributed(): boolean {
		return this.options.dialect === 'distributed';
	}

	/** Validate, guard, and normalize a statement for the local `distributed` mock. */
	private preprocess(sql: string): string {
		if (!this.distributed) return sql;
		validateStatement(sql);
		if (!this.allowDdl && classifyStatement(sql) === 'ddl') {
			const err = new Error(DDL_NOT_ALLOWED_MESSAGE);
			err.name = DSQL_PERMISSION_ERROR_NAME;
			throw brandBlocksError(err);
		}
		return sql.replace(/\b(CREATE\s+(?:UNIQUE\s+)?INDEX)\s+ASYNC\b/gi, '$1');
	}

	query<T>(sql: string, params?: unknown[]): Promise<T[]> {
		return this.inner.query<T>(this.preprocess(sql), params);
	}

	execute(sql: string, params?: unknown[]): Promise<{ rowCount: number }> {
		return this.inner.execute(this.preprocess(sql), params);
	}

	async beginTransaction(): Promise<TransactionHandle> {
		const handle = await this.inner.beginTransaction();
		if (this.distributed && typeof handle === 'object' && handle !== null) {
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
		(handle as TrackedHandle | null)?.tracker?.recordStatement(sql);
		return this.inner.queryInTransaction<T>(handle, normalized, params);
	}

	async executeInTransaction(
		handle: TransactionHandle,
		sql: string,
		params?: unknown[],
	): Promise<{ rowCount: number }> {
		const normalized = this.preprocess(sql);
		const tracker = (handle as TrackedHandle | null)?.tracker;
		tracker?.recordStatement(sql);
		const result = await this.inner.executeInTransaction(handle, normalized, params);
		tracker?.recordRowCount(result.rowCount);
		return result;
	}

	destroy(): Promise<void> {
		return this.inner.destroy();
	}
}
