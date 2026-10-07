// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * One PGlite instance per local cluster, shared by every `Database` on it.
 *
 * PGlite is one process-local PostgreSQL with a single session. Sharing it
 * between blocks means two things have to hold:
 *
 * 1. **One schema per block.** Each block's statements run with `search_path`
 *    set to its schema. The cluster remembers the session's current schema and
 *    switches only when the next statement belongs to a different block.
 * 2. **No interleaving.** Work is serialized with a mutex: an auto-commit
 *    statement, or a whole `BEGIN … COMMIT`, holds the lock, so a second block's
 *    `SET search_path` can never land in the middle of the first one's
 *    transaction. A statement issued from inside the open transaction's own
 *    callback joins it (see `tx-scope.ts`) instead of deadlocking.
 *
 * Data persists in `.bb-data/{clusterFullId}/`.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { type DatabaseEngine, initializePgliteWithRetry, type TransactionHandle } from '@aws-blocks/data-common';
import { PGlite } from '@electric-sql/pglite';
import { quoteIdent } from '../constants.js';
import { translatePgError } from '../errors.js';
import { currentTransactionHandle } from './tx-scope.js';

const PGLITE_INITIALIZED_DATA_DIR_ENTRIES = ['PG_VERSION', 'base', 'global', 'global/pg_control'];
const PGLITE_DATA_DIR_MARKERS = [
	'PG_VERSION',
	'base',
	'global',
	'pg_wal',
	'pg_xact',
	'postgresql.conf',
	'postgresql.auto.conf',
	'postmaster.pid',
];

/** Remove a stale postmaster.pid left by an unclean shutdown (PGlite is in-process; the pid is always stale). */
function cleanStaleLock(dataDir: string): void {
	const pidFile = join(dataDir, 'postmaster.pid');
	if (existsSync(pidFile)) {
		try {
			unlinkSync(pidFile);
		} catch {}
	}
}

function hasInitializedPgliteDataDir(dataDir: string): boolean {
	return PGLITE_INITIALIZED_DATA_DIR_ENTRIES.every((entry) => existsSync(join(dataDir, entry)));
}

function isErrnoException(error: unknown): error is { code?: string } {
	return typeof error === 'object' && error !== null && 'code' in error;
}

/** Quarantine a half-written data directory so a fresh initdb can proceed. */
function recoverIncompletePgliteDataDir(dataDir: string): void {
	let entries: string[];
	try {
		entries = readdirSync(dataDir);
	} catch (error) {
		if (isErrnoException(error) && error.code === 'ENOENT') return;
		throw error;
	}
	if (entries.length === 0 || hasInitializedPgliteDataDir(dataDir)) return;
	const looksLikePglite = entries.some((entry) => PGLITE_DATA_DIR_MARKERS.includes(entry));
	const hasInitializedChild = entries.some((entry) => hasInitializedPgliteDataDir(join(dataDir, entry)));
	if (!looksLikePglite || hasInitializedChild) return;
	const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
	const corruptDataDir = `${dataDir}.corrupt-${timestamp}-${process.pid}-${randomUUID().slice(0, 8)}`;
	renameSync(dataDir, corruptDataDir);
	mkdirSync(dataDir, { recursive: true });
	console.log(`[bb-database] Moved incomplete PGlite data directory to ${corruptDataDir}; created a fresh one.`);
}

/** A transaction handle the schema engine issues. */
interface ClusterTxHandle {
	readonly owner: SchemaEngine;
	release: () => void;
	done: boolean;
}

/** The pending work queue: a minimal async mutex. */
class Mutex {
	private tail: Promise<void> = Promise.resolve();

	/** Wait for the lock; resolves with a release function. */
	acquire(): Promise<() => void> {
		let release!: () => void;
		const next = new Promise<void>((resolve) => {
			release = resolve;
		});
		const prev = this.tail;
		this.tail = prev.then(() => next);
		return prev.then(() => {
			let released = false;
			return () => {
				if (released) return;
				released = true;
				release();
			};
		});
	}
}

/**
 * The shared PGlite behind one local cluster. Hand out per-block engines with
 * {@link PgliteCluster.forSchema}.
 */
export class PgliteCluster {
	private db: PGlite;
	private closed = false;
	private ready?: Promise<PGlite>;
	private readonly mutex = new Mutex();
	/** The schema the single session's `search_path` currently points at; `undefined` when unknown. */
	private currentSchema?: string;
	private readonly ensuredSchemas = new Set<string>();

	constructor(
		readonly dataDir: string,
		private readonly createClient: (dataDir: string) => PGlite = (dir) => new PGlite(dir),
	) {
		this.db = this.createDb();
	}

	private createDb(): PGlite {
		mkdirSync(this.dataDir, { recursive: true });
		recoverIncompletePgliteDataDir(this.dataDir);
		cleanStaleLock(this.dataDir);
		return this.createClient(this.dataDir);
	}

	/** Force PGlite's lazy WASM init, retrying past intermittent initdb traps. */
	private ensureReady(): Promise<PGlite> {
		if (!this.ready) {
			this.ready = initializePgliteWithRetry(this.db, () => (this.db = this.createDb()), {
				onRetry: (attempt, error) =>
					console.warn(`[bb-database] PGlite init trap on attempt ${attempt}; recreating instance`, error),
			})
				.then((db) => (this.db = db))
				.catch((error) => {
					this.ready = undefined;
					try {
						this.db = this.createDb();
					} catch {}
					throw error;
				});
		}
		return this.ready;
	}

	/** Run a raw statement on the session. Callers hold the lock (or own the open transaction). */
	async raw<T>(sql: string, params?: unknown[]): Promise<{ rows: T[]; affectedRows: number }> {
		const db = await this.ensureReady();
		const result = await db.query<T>(sql, params);
		return { rows: result.rows, affectedRows: result.affectedRows ?? 0 };
	}

	/** Point the session's `search_path` at `schema` if it is not already there. */
	async useSchema(schema: string): Promise<void> {
		if (this.currentSchema === schema) return;
		await this.raw(`SET search_path TO ${quoteIdent(schema)}`);
		this.currentSchema = schema;
	}

	/** Create `schema` if needed (once per process). */
	async ensureSchema(schema: string): Promise<void> {
		if (this.ensuredSchemas.has(schema)) return;
		const release = await this.mutex.acquire();
		try {
			await this.raw(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(schema)}`);
			this.ensuredSchemas.add(schema);
		} finally {
			release();
		}
	}

	/** Forget the remembered search_path (after a ROLLBACK, which undoes an in-transaction SET). */
	forgetSchema(): void {
		this.currentSchema = undefined;
	}

	acquire(): Promise<() => void> {
		return this.mutex.acquire();
	}

	/** A `DatabaseEngine` whose statements run in `schema`. */
	forSchema(schema: string): DatabaseEngine {
		return new SchemaEngine(this, schema);
	}

	async destroy(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		await this.db.close();
	}
}

/**
 * Per-block view of a {@link PgliteCluster}: every statement runs with
 * `search_path` set to the block's schema, serialized on the cluster mutex.
 */
class SchemaEngine implements DatabaseEngine {
	constructor(
		private readonly cluster: PgliteCluster,
		private readonly schema: string,
	) {}

	/** The ambient handle when the caller is inside one of this engine's own open transactions. */
	private joinable(): ClusterTxHandle | undefined {
		const ambient = currentTransactionHandle() as ClusterTxHandle | undefined;
		return ambient && ambient.owner === this && !ambient.done ? ambient : undefined;
	}

	private async exclusive<T>(fn: () => Promise<T>): Promise<T> {
		if (this.joinable()) return fn();
		const release = await this.cluster.acquire();
		try {
			await this.cluster.useSchema(this.schema);
			return await fn();
		} finally {
			release();
		}
	}

	async query<T>(sql: string, params?: unknown[]): Promise<T[]> {
		try {
			return await this.exclusive(async () => (await this.cluster.raw<T>(sql, params)).rows);
		} catch (e) {
			translatePgError(e, 'PgliteCluster');
		}
	}

	async execute(sql: string, params?: unknown[]): Promise<{ rowCount: number }> {
		try {
			return await this.exclusive(async () => ({ rowCount: (await this.cluster.raw(sql, params)).affectedRows }));
		} catch (e) {
			translatePgError(e, 'PgliteCluster');
		}
	}

	async beginTransaction(): Promise<TransactionHandle> {
		const release = await this.cluster.acquire();
		try {
			await this.cluster.useSchema(this.schema);
			await this.cluster.raw('BEGIN');
		} catch (e) {
			release();
			translatePgError(e, 'PgliteCluster');
		}
		const handle: ClusterTxHandle = { owner: this, release, done: false };
		return handle;
	}

	async commitTransaction(handle: TransactionHandle): Promise<void> {
		const h = handle as ClusterTxHandle;
		try {
			await this.cluster.raw('COMMIT');
		} catch (e) {
			this.cluster.forgetSchema();
			translatePgError(e, 'PgliteCluster');
		} finally {
			h.done = true;
			h.release();
		}
	}

	async rollbackTransaction(handle: TransactionHandle): Promise<void> {
		const h = handle as ClusterTxHandle;
		try {
			await this.cluster.raw('ROLLBACK');
		} catch (e) {
			translatePgError(e, 'PgliteCluster');
		} finally {
			// SET inside an aborted transaction is undone with it.
			this.cluster.forgetSchema();
			h.done = true;
			h.release();
		}
	}

	async queryInTransaction<T>(_handle: TransactionHandle, sql: string, params?: unknown[]): Promise<T[]> {
		try {
			return (await this.cluster.raw<T>(sql, params)).rows;
		} catch (e) {
			translatePgError(e, 'PgliteCluster');
		}
	}

	async executeInTransaction(
		_handle: TransactionHandle,
		sql: string,
		params?: unknown[],
	): Promise<{ rowCount: number }> {
		try {
			return { rowCount: (await this.cluster.raw(sql, params)).affectedRows };
		} catch (e) {
			translatePgError(e, 'PgliteCluster');
		}
	}

	/** The cluster owns the PGlite; a per-block view has nothing of its own to close. */
	async destroy(): Promise<void> {}
}

/** Process-wide cache so every block on one local cluster shares the same PGlite. */
const clusters = new Map<string, PgliteCluster>();

/** Get (or create) the shared PGlite for a data directory. */
export function sharedPgliteCluster(dataDir: string): PgliteCluster {
	let c = clusters.get(dataDir);
	if (!c) {
		c = new PgliteCluster(dataDir);
		clusters.set(dataDir, c);
	}
	return c;
}

/** Close and forget every shared PGlite. **For test cleanup only.** */
export async function _closeAllPgliteClusters(): Promise<void> {
	const all = [...clusters.values()];
	clusters.clear();
	await Promise.all(all.map((c) => c.destroy().catch(() => {})));
}
