// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// An in-memory PGlite as a stand-in for a provisioned cluster, for the tests of the migration Lambda. Not part
// of the public package: compiled into `dist/` next to the tests, never imported from an entry file.

import { PGlite, type PGliteInterface } from '@electric-sql/pglite';
import type { TransactionHandle } from '../common/engine.js';
import { quoteIdent } from '../constants.js';
import {
	CountedEngine,
	type CountedRows,
	EngineTransaction,
	type RowCountingEngine,
	setTransactionStatement,
	type TransactionModes,
	withTransaction,
} from '../engines/handle.js';

class SessionTransaction extends EngineTransaction {}

// PGlite's own user, a superuser: the stand-in for the cluster admin.
const ADMIN = 'postgres';

/**
 * One PGlite session. Without `role` it is the cluster admin (PGlite's own superuser), as the migration Lambda
 * is. {@link as} gives an engine whose every transaction runs as `role`, the way the app's IAM connection
 * logs in as the app role: PostgreSQL then checks role membership against that role, as it does on AWS.
 * The tests run one statement at a time, so the one session is enough.
 */
export class PgliteSession extends CountedEngine implements RowCountingEngine {
	private constructor(
		readonly db: PGliteInterface,
		private readonly role?: string,
	) {
		super();
	}

	static async open(): Promise<PgliteSession> {
		const db = new PGlite();
		await db.waitReady;
		return new PgliteSession(db);
	}

	/** A copy of this database as it is now, which costs much less than {@link open}: a fresh cluster per test. */
	async clone(): Promise<PgliteSession> {
		return new PgliteSession(await this.db.clone());
	}

	/** An engine on the same database whose transactions run as `role`. */
	as(role: string): PgliteSession {
		return new PgliteSession(this.db, role);
	}

	private async run<T>(sql: string, params: unknown[]): Promise<CountedRows<T>> {
		// The runner joins its session settings into one text, which only the simple protocol takes.
		if (params.length === 0) {
			const last = (await this.db.exec(sql)).at(-1);
			return { rows: (last?.rows ?? []) as T[], rowCount: last?.affectedRows ?? 0 };
		}
		const result = await this.db.query<T>(sql, params);
		return { rows: result.rows, rowCount: result.affectedRows ?? 0 };
	}

	queryCounted<T>(sql: string, params: unknown[] = []): Promise<CountedRows<T>> {
		if (this.role) return withTransaction(this, (handle) => this.queryCountedInTransaction<T>(handle, sql, params));
		return this.run<T>(sql, params);
	}

	queryCountedInTransaction<T>(
		_handle: TransactionHandle,
		sql: string,
		params: unknown[] = [],
	): Promise<CountedRows<T>> {
		return this.run<T>(sql, params);
	}

	async beginTransaction(modes?: TransactionModes): Promise<TransactionHandle> {
		await this.db.exec('BEGIN');
		const settings = setTransactionStatement(modes);
		if (settings) await this.db.exec(settings);
		if (this.role) await this.db.exec(`SET SESSION AUTHORIZATION ${quoteIdent(this.role)}`);
		return new SessionTransaction();
	}

	// PGlite keeps the session's user past the end of a transaction, and RESET does not return it to its own
	// user (pglite-cluster.ts): the admin is set back by name.
	private async end(handle: TransactionHandle, statement: 'COMMIT' | 'ROLLBACK'): Promise<void> {
		if (handle instanceof SessionTransaction) handle.settled = true;
		try {
			await this.db.exec(statement);
		} finally {
			if (this.role) await this.db.exec(`SET SESSION AUTHORIZATION ${quoteIdent(ADMIN)}`);
		}
	}

	commitTransaction(handle: TransactionHandle): Promise<void> {
		return this.end(handle, 'COMMIT');
	}

	rollbackTransaction(handle: TransactionHandle): Promise<void> {
		return this.end(handle, 'ROLLBACK');
	}

	async destroy(): Promise<void> {}

	/** Closes the database; call once, on the admin session. */
	close(): Promise<void> {
		return this.db.close();
	}
}
