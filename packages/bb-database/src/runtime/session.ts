// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// One connection of the Kysely dialect over the block's engine: auto-commit statements, or one transaction.
// Nothing here imports Kysely.
import type { TransactionHandle } from '../common/engine.js';
import {
	type CountedRows,
	EngineTransaction,
	type RowCountingEngine,
	type TransactionModes,
} from '../engines/handle.js';
import { DatabaseErrors, reTagged } from '../errors.js';

/** What a session needs from DatabaseCore. */
export interface SessionHost {
	engine(): Promise<RowCountingEngine>;
	/** The open transaction() callback of this block the caller is inside, if any. */
	joined(): TransactionHandle | undefined;
	retry<T>(fn: () => Promise<T>): Promise<T>;
}

export class Session {
	private handle: TransactionHandle | undefined;

	constructor(private readonly host: SessionHost) {}

	/** One statement: in this session's transaction, else in the block's open transaction(), else auto-commit. */
	async run<R>(sql: string, params: unknown[]): Promise<CountedRows<R>> {
		const engine = await this.host.engine();
		const handle = this.handle ?? this.host.joined();
		if (handle) return engine.queryCountedInTransaction<R>(handle, sql, params);
		return this.host.retry(() => engine.queryCounted<R>(sql, params));
	}

	async begin(modes: TransactionModes = {}): Promise<void> {
		if (this.handle) throw reTagged(DatabaseErrors.TransactionFailed, new Error('transaction already open'));
		const engine = await this.host.engine();
		const handle = await engine.beginTransaction(modes);
		if (handle instanceof EngineTransaction) handle.fromSession = true;
		this.handle = handle;
	}

	async commit(): Promise<void> {
		const handle = this.handle;
		this.handle = undefined;
		if (handle) await (await this.host.engine()).commitTransaction(handle);
	}

	async rollback(): Promise<void> {
		const handle = this.handle;
		this.handle = undefined;
		if (handle) await (await this.host.engine()).rollbackTransaction(handle);
	}

	// Returned with its transaction open: roll back, so the connection (locally, the cluster mutex) is freed.
	release(): void {
		void this.rollback().catch(() => {});
	}
}
