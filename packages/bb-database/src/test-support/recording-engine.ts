// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { DatabaseEngine, TransactionHandle } from '@aws-blocks/data-common';

export interface RecordedCall {
	method: string;
	sql: string;
	params: unknown[];
	/** The transaction the statement ran in; `undefined` for an auto-commit statement. */
	handle: TransactionHandle | undefined;
}

/**
 * A `DatabaseEngine` double that records every call. Statements return what `answer()` says (nothing, unless a
 * subclass scripts a catalog); `failOn` makes the next run of a matching statement throw, once. The in-transaction
 * methods delegate to the auto-commit ones, with the handle recorded.
 */
export class RecordingEngine implements DatabaseEngine {
	readonly calls: RecordedCall[] = [];
	/** Statement text, or a pattern it matches → the error its next run throws, once. */
	readonly failOn = new Map<string | RegExp, Error>();
	private nextHandle = 0;

	/** Every statement in order, BEGIN/COMMIT/ROLLBACK included. */
	get statements(): string[] {
		return this.calls.map((c) => c.sql);
	}

	/** The rows `sql` returns; the base engine answers nothing. */
	protected answer(_sql: string, _params: unknown[]): unknown[] {
		return [];
	}

	private run<T>(method: string, sql: string, params: unknown[], handle?: TransactionHandle): T[] {
		this.calls.push({ method, sql, params, handle });
		for (const [pattern, error] of this.failOn) {
			if (pattern === sql || (pattern instanceof RegExp && pattern.test(sql))) {
				this.failOn.delete(pattern);
				throw error;
			}
		}
		// `query<T>` is the caller's unchecked assertion on every engine; the double asserts it at one place.
		return this.answer(sql, params) as T[];
	}

	async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
		return this.run<T>('query', sql, params);
	}

	async execute(sql: string, params: unknown[] = []): Promise<{ rowCount: number }> {
		this.run('execute', sql, params);
		return { rowCount: 1 };
	}

	async beginTransaction(): Promise<TransactionHandle> {
		const handle = { id: ++this.nextHandle };
		this.calls.push({ method: 'begin', sql: 'BEGIN', params: [], handle });
		return handle;
	}

	async commitTransaction(handle: TransactionHandle): Promise<void> {
		this.calls.push({ method: 'commit', sql: 'COMMIT', params: [], handle });
	}

	async rollbackTransaction(handle: TransactionHandle): Promise<void> {
		this.calls.push({ method: 'rollback', sql: 'ROLLBACK', params: [], handle });
	}

	async queryInTransaction<T>(handle: TransactionHandle, sql: string, params: unknown[] = []): Promise<T[]> {
		return this.run<T>('queryInTransaction', sql, params, handle);
	}

	async executeInTransaction(
		handle: TransactionHandle,
		sql: string,
		params: unknown[] = [],
	): Promise<{ rowCount: number }> {
		this.run('executeInTransaction', sql, params, handle);
		return { rowCount: 1 };
	}

	async destroy(): Promise<void> {}
}
