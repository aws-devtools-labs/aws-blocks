// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { type DatabaseEngine, initializePgliteWithRetry, type TransactionHandle } from '@aws-blocks/data-common';
import { closeOnProcessExit, pgliteUnrefTimersExtension } from '@aws-blocks/data-common/internal';
import { PGlite } from '@electric-sql/pglite';
import { quoteIdent } from '../constants.js';
import { ASYNC_DDL } from '../dsql/validation.js';
import { translatePgError } from '../errors.js';
import { currentTransactionHandle } from './tx-scope.js';

// How PGlite stands in for DSQL's asynchronous DDL. On DSQL, `CREATE INDEX ASYNC` and `ALTER TABLE ASYNC …
// VALIDATE CONSTRAINT` return a job id that `sys.jobs` lists until `sys.wait_for_job(job_id)` sees it finish.
// PGlite rejects ASYNC, so it is stripped and the statement runs synchronously; `sys.jobs` is then empty and
// `wait_for_job` returns true at once: a migration copied from the AWS examples runs locally unchanged.
// `CREATE OR REPLACE` keeps the stub idempotent across restarts.
// https://docs.aws.amazon.com/aurora-dsql/latest/userguide/working-with-create-index-async.html
const synchronous = (sql: string): string => sql.replace(ASYNC_DDL, '$1');

const SYS_SCHEMA_STUB = `
CREATE SCHEMA IF NOT EXISTS sys;
CREATE OR REPLACE FUNCTION sys.wait_for_job(job_id text) RETURNS boolean LANGUAGE sql AS 'SELECT true';
CREATE OR REPLACE VIEW sys.jobs AS
  SELECT NULL::text AS job_id, NULL::text AS status, NULL::text AS details, NULL::text AS job_type,
         NULL::oid AS class_id, NULL::oid AS object_id, NULL::text AS object_name,
         NULL::timestamptz AS start_time, NULL::timestamptz AS update_time
  WHERE false;
`;

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

// PGlite is in-process, so a postmaster.pid left by an unclean shutdown is always stale.
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

interface ClusterTxHandle {
	readonly owner: SchemaEngine;
	release: () => void;
	done: boolean;
}

class Mutex {
	private tail: Promise<void> = Promise.resolve();

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

// PGlite has one session: each block's statements switch `search_path` to its schema under a mutex, and a
// query inside a block's own open transaction joins it (tx-scope.ts) instead of taking the lock again.
class PgliteCluster {
	private db: PGlite;
	private closed = false;
	/** Closed by the process-exit hook; the next statement reopens a fresh instance. */
	private closedForExit = false;
	/** The exit hook's in-flight close; a reopen waits for it, so two instances never share the data dir. */
	private exitClosing?: Promise<void>;
	private cancelExitClose?: () => void;
	private ready?: Promise<PGlite>;
	private readonly mutex = new Mutex();
	private currentSchema?: string;

	constructor(readonly dataDir: string) {
		this.db = this.createDb();
	}

	private createDb(): PGlite {
		mkdirSync(this.dataDir, { recursive: true });
		recoverIncompletePgliteDataDir(this.dataDir);
		cleanStaleLock(this.dataDir);
		this.cancelExitClose ??= closeOnProcessExit(() => this.closeForExit());
		return new PGlite(this.dataDir, { extensions: { awsBlocksUnrefTimers: pgliteUnrefTimersExtension } });
	}

	// So PostgreSQL shuts down cleanly and removes its postmaster.pid when the process exits.
	private async closeForExit(): Promise<void> {
		this.cancelExitClose = undefined;
		if (this.closed || this.closedForExit) return;
		this.closedForExit = true;
		this.ready = undefined;
		this.currentSchema = undefined;
		this.exitClosing = this.db.close().catch(() => {});
		await this.exitClosing;
	}

	private ensureReady(): Promise<PGlite> {
		if (this.closedForExit && !this.closed) {
			// Closed by the exit hook, but the process kept going (another `beforeExit` listener ran a
			// statement): reopen once that close has finished.
			this.closedForExit = false;
			const closing = this.exitClosing ?? Promise.resolve();
			this.exitClosing = undefined;
			this.ready = closing.then(() => {
				this.db = this.createDb();
				this.ready = undefined;
				return this.ensureReady();
			});
			return this.ready;
		}
		if (!this.ready) {
			this.ready = initializePgliteWithRetry(this.db, () => (this.db = this.createDb()), {
				onRetry: (attempt, error) =>
					console.warn(`[bb-database] PGlite init trap on attempt ${attempt}; recreating instance`, error),
			})
				.then(async (db) => {
					this.db = db;
					await db.exec(SYS_SCHEMA_STUB);
					return db;
				})
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

	async raw<T>(sql: string, params?: unknown[]): Promise<{ rows: T[]; affectedRows: number }> {
		const db = await this.ensureReady();
		const result = await db.query<T>(synchronous(sql), params);
		return { rows: result.rows, affectedRows: result.affectedRows ?? 0 };
	}

	async useSchema(schema: string): Promise<void> {
		if (this.currentSchema === schema) return;
		await this.raw(`SET search_path TO ${quoteIdent(schema)}`);
		this.currentSchema = schema;
	}

	forgetSchema(): void {
		this.currentSchema = undefined;
	}

	acquire(): Promise<() => void> {
		return this.mutex.acquire();
	}

	forSchema(schema: string): DatabaseEngine {
		return new SchemaEngine(this, schema);
	}

	async destroy(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.cancelExitClose?.();
		this.cancelExitClose = undefined;
		if (this.closedForExit) {
			await this.exitClosing;
			return;
		}
		// PGlite's close() never resolves before its lazy WASM init has finished (seen on 0.5.10), and a block
		// that only failed validation never ran a statement. Wait for the init first; if it failed there is
		// nothing to close.
		const db = this.ready
			? await this.ready.catch(() => undefined)
			: await this.db.waitReady.then(
					() => this.db,
					() => undefined,
				);
		if (db) await db.close();
	}
}

const translated = <T>(fn: () => Promise<T>): Promise<T> => fn().catch((e) => translatePgError(e, 'PgliteCluster'));

class SchemaEngine implements DatabaseEngine {
	constructor(
		private readonly cluster: PgliteCluster,
		private readonly schema: string,
	) {}

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

	query<T>(sql: string, params?: unknown[]): Promise<T[]> {
		return translated(() => this.exclusive(async () => (await this.cluster.raw<T>(sql, params)).rows));
	}

	execute(sql: string, params?: unknown[]): Promise<{ rowCount: number }> {
		return translated(() =>
			this.exclusive(async () => ({ rowCount: (await this.cluster.raw(sql, params)).affectedRows })),
		);
	}

	async beginTransaction(): Promise<TransactionHandle> {
		const release = await this.cluster.acquire();
		try {
			await translated(async () => {
				await this.cluster.useSchema(this.schema);
				await this.cluster.raw('BEGIN');
			});
		} catch (e) {
			release();
			throw e;
		}
		const handle: ClusterTxHandle = { owner: this, release, done: false };
		return handle;
	}

	async commitTransaction(handle: TransactionHandle): Promise<void> {
		const h = handle as ClusterTxHandle;
		try {
			await translated(() => this.cluster.raw('COMMIT'));
		} catch (e) {
			this.cluster.forgetSchema();
			throw e;
		} finally {
			h.done = true;
			h.release();
		}
	}

	async rollbackTransaction(handle: TransactionHandle): Promise<void> {
		const h = handle as ClusterTxHandle;
		try {
			await translated(() => this.cluster.raw('ROLLBACK'));
		} finally {
			// SET inside an aborted transaction is undone with it.
			this.cluster.forgetSchema();
			h.done = true;
			h.release();
		}
	}

	async queryInTransaction<T>(_handle: TransactionHandle, sql: string, params?: unknown[]): Promise<T[]> {
		return translated(async () => (await this.cluster.raw<T>(sql, params)).rows);
	}

	executeInTransaction(_handle: TransactionHandle, sql: string, params?: unknown[]): Promise<{ rowCount: number }> {
		return translated(async () => ({ rowCount: (await this.cluster.raw(sql, params)).affectedRows }));
	}

	async destroy(): Promise<void> {}
}

const clusters = new Map<string, PgliteCluster>();

export function sharedPgliteCluster(dataDir: string): PgliteCluster {
	let c = clusters.get(dataDir);
	if (!c) {
		c = new PgliteCluster(dataDir);
		clusters.set(dataDir, c);
	}
	return c;
}

/** @internal For test cleanup only. */
export async function _closeAllPgliteClusters(): Promise<void> {
	const all = [...clusters.values()];
	clusters.clear();
	await Promise.all(all.map((c) => c.destroy().catch(() => {})));
}
