// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/** The transaction operations needed by the SQL engines; no PGlite dependency. */
interface TransactionSession {
	query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[]; affectedRows?: number }>;
	rollback(): Promise<void>;
}

/** Structural view of PGlite's callback-based transaction API. */
interface TransactionClient {
	transaction<T>(callback: (tx: TransactionSession) => Promise<T>): Promise<T>;
}

type Completion = { ok: true } | { ok: false; error: unknown };

/**
 * Bridge PGlite's callback transaction to DatabaseEngine's begin/commit/rollback
 * contract. PGlite holds its own transaction lock until the callback settles,
 * excluding both other transactions and ordinary client queries.
 *
 * Kept on data-common/internal so other local SQL engines can reuse it without
 * exposing a new public API or adding a dependency on PGlite to data-common.
 * @internal
 */
export class PgliteTransaction {
	private ending = false;

	private constructor(
		readonly owner: object,
		private readonly session: TransactionSession,
		private readonly requestEnd: (commit: boolean) => void,
		private readonly completed: Promise<Completion>,
	) {}

	/** Resolve only once PGlite has acquired its lock and begun the transaction. */
	static async begin(owner: object, client: TransactionClient): Promise<PgliteTransaction> {
		let started!: (session: TransactionSession) => void;
		let failed!: (error: unknown) => void;
		const ready = new Promise<TransactionSession>((resolve, reject) => {
			started = resolve;
			failed = reject;
		});
		let requestEnd!: (commit: boolean) => void;
		const end = new Promise<boolean>((resolve) => {
			requestEnd = resolve;
		});
		// Observe failures immediately, including BEGIN failures before a handle
		// exists. Commit/rollback still wait for the actual database outcome.
		const completed = (async (): Promise<Completion> => {
			try {
				await client.transaction(async (session) => {
					started(session);
					if (!(await end)) await session.rollback();
				});
				return { ok: true };
			} catch (error) {
				failed(error);
				return { ok: false, error };
			}
		})();
		return new PgliteTransaction(owner, await ready, requestEnd, completed);
	}

	private checkActive(): void {
		if (this.ending) throw new Error('Transaction is closed');
	}

	/** Query only this handle's session, never the shared client. */
	async query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[]; affectedRows?: number }> {
		this.checkActive();
		return this.session.query<T>(sql, params);
	}

	/** Wait for COMMIT to finish; a failed commit is reported to the caller. */
	async commit(): Promise<void> {
		this.checkActive();
		await this.finish(true);
	}

	/**
	 * Wait for rollback and lock release. A caller's cleanup after a failed
	 * commit must not issue ROLLBACK against the next queued transaction.
	 */
	async rollback(): Promise<void> {
		if (this.ending) {
			await this.completed;
			return;
		}
		await this.finish(false);
	}

	private async finish(commit: boolean): Promise<void> {
		this.ending = true;
		this.requestEnd(commit);
		const result = await this.completed;
		if (!result.ok) throw result.error;
	}
}
