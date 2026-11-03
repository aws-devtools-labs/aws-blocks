// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { initializePgliteWithRetry, type TransactionHandle } from '@aws-blocks/data-common';
import { closeOnProcessExit, pgliteUnrefTimersExtension } from '@aws-blocks/data-common/internal';
import { PGlite } from '@electric-sql/pglite';
import { quoteIdent } from '../constants.js';
import type { CountedRows, RowCountingEngine } from '../dialect/rules-engine.js';
import { ASYNC_DDL } from '../dialect/validation.js';
import { translated, translatePgError } from '../errors.js';
import { currentTransactionHandle } from '../runtime/tx-scope.js';
import { EngineTransaction, isSettled, openTransaction, withTransaction } from './handle.js';

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

function recoverIncompletePgliteDataDir(dataDir: string): void {
	let entries: string[];
	try {
		entries = readdirSync(dataDir);
	} catch (error) {
		if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
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

interface Savepoint {
	readonly parent: ClusterTransaction;
	readonly name: string;
}

// Settling the handle releases the mutex exactly once. A transaction begun inside another block's open
// transaction on the same cluster is a savepoint in it (§4.1).
class ClusterTransaction extends EngineTransaction {
	private rollbackListeners: (() => void)[] = [];

	constructor(
		readonly owner: SchemaEngine,
		readonly release: () => void,
		readonly savepoint?: Savepoint,
	) {
		super();
	}

	/**
	 * Runs `fn` once if the work done inside this transaction is undone: a ROLLBACK, a failed COMMIT, or a
	 * ROLLBACK TO this savepoint. Work in a savepoint survives its RELEASE only as long as the enclosing
	 * transaction does, so a released savepoint hands its listeners to its parent. A COMMIT drops them.
	 */
	onRollback(fn: () => void): void {
		this.rollbackListeners.push(fn);
	}

	rolledBack(): void {
		const listeners = this.rollbackListeners;
		this.rollbackListeners = [];
		for (const fn of listeners) fn();
	}

	released(): void {
		if (this.savepoint) this.savepoint.parent.rollbackListeners.push(...this.rollbackListeners);
		this.rollbackListeners = [];
	}
}

let savepoints = 0;

const open = (handle: TransactionHandle): ClusterTransaction =>
	openTransaction(handle, ClusterTransaction, 'PgliteCluster');

class Mutex {
	private tail: Promise<void> = Promise.resolve();

	acquire(): Promise<() => void> {
		let release!: () => void;
		const next = new Promise<void>((resolve) => {
			release = resolve;
		});
		const prev = this.tail;
		this.tail = prev.then(() => next);
		return prev.then(() => release);
	}
}

// PGlite has one session: each block's statements switch `search_path` to its schema under a mutex, held
// for one auto-commit statement or one BEGIN … COMMIT. A block's own statements inside its transaction()
// callback never reach the mutex: DatabaseCore routes them to the in-transaction methods. Another block's
// statements inside that callback cannot wait for the mutex either; they nest in the open transaction.
class PgliteCluster {
	private db: PGlite;
	private closed = false;
	/**
	 * The process-exit hook's close, while set; the next statement reopens a fresh instance once it has
	 * finished, so two instances never share the data dir.
	 */
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
		if (this.closed || this.exitClosing) return;
		this.ready = undefined;
		this.currentSchema = undefined;
		this.exitClosing = this.db.close().catch(() => {});
		await this.exitClosing;
	}

	private ensureReady(): Promise<PGlite> {
		if (this.exitClosing && !this.closed) {
			// Closed by the exit hook, but the process kept going (another `beforeExit` listener ran a
			// statement): reopen once that close has finished.
			const closing = this.exitClosing;
			this.exitClosing = undefined;
			this.ready = closing.then(() => {
				this.db = this.createDb();
				return this.init();
			});
		}
		this.ready ??= this.init();
		return this.ready;
	}

	private init(): Promise<PGlite> {
		return initializePgliteWithRetry(this.db, () => (this.db = this.createDb()), {
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

	/** The schema the session is back at after a top-level ROLLBACK: the SET ran before BEGIN, so it survives. */
	restoreSchema(schema: string): void {
		this.currentSchema = schema;
	}

	acquire(): Promise<() => void> {
		return this.mutex.acquire();
	}

	forSchema(schema: string): SchemaEngine {
		return new SchemaEngine(this, schema);
	}

	// An open transaction on this cluster, from inside its transaction() callback. On DSQL another block's
	// statement would run on its own connection; here there is one session and that transaction holds the
	// mutex, so the statement nests in it as a savepoint instead of waiting forever.
	enclosingTransaction(): ClusterTransaction | undefined {
		const ambient = currentTransactionHandle();
		// A handle whose COMMIT is in flight is still in scope; a statement racing it must wait for the mutex, not nest.
		return ambient instanceof ClusterTransaction && ambient.owner.cluster === this && !isSettled(ambient)
			? ambient
			: undefined;
	}

	async destroy(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.cancelExitClose?.();
		this.cancelExitClose = undefined;
		if (clusters.get(this.dataDir) === this) clusters.delete(this.dataDir);
		if (this.exitClosing) {
			await this.exitClosing;
			return;
		}
		// PGlite's close() never resolves before its lazy WASM init has finished (seen on 0.5.10), and a block
		// that only failed validation never ran a statement. Wait for the init first; if it failed there is
		// nothing to close.
		const db = await (this.ready ?? this.db.waitReady.then(() => this.db)).catch(() => undefined);
		if (db) await db.close();
	}
}

const translate = translated('PgliteCluster');

export class SchemaEngine implements RowCountingEngine {
	constructor(
		readonly cluster: PgliteCluster,
		readonly schema: string,
	) {}

	private enclosing(): ClusterTransaction | undefined {
		return this.cluster.enclosingTransaction();
	}

	private async exclusive<T>(fn: () => Promise<T>): Promise<T> {
		if (this.enclosing()) return withTransaction(this, fn);
		const release = await this.cluster.acquire();
		try {
			await this.cluster.useSchema(this.schema);
			return await fn();
		} finally {
			release();
		}
	}

	private async counted<T>(sql: string, params?: unknown[]): Promise<CountedRows<T>> {
		const { rows, affectedRows } = await this.cluster.raw<T>(sql, params);
		return { rows, rowCount: affectedRows };
	}

	private exclusiveCounted<T>(sql: string, params?: unknown[]): Promise<CountedRows<T>> {
		return translate(() => this.exclusive(() => this.counted<T>(sql, params)));
	}

	async query<T>(sql: string, params?: unknown[]): Promise<T[]> {
		return (await this.exclusiveCounted<T>(sql, params)).rows;
	}

	async execute(sql: string, params?: unknown[]): Promise<{ rowCount: number }> {
		return { rowCount: (await this.exclusiveCounted(sql, params)).rowCount };
	}

	async beginTransaction(): Promise<TransactionHandle> {
		const parent = this.enclosing();
		if (parent) {
			const name = `bb_database_${++savepoints}`;
			await translate(async () => {
				await this.cluster.raw(`SAVEPOINT ${name}`);
				await this.cluster.useSchema(this.schema);
			});
			return new ClusterTransaction(this, () => {}, { parent, name });
		}
		const release = await this.cluster.acquire();
		try {
			await translate(async () => {
				await this.cluster.useSchema(this.schema);
				await this.cluster.raw('BEGIN');
			});
		} catch (e) {
			release();
			throw e;
		}
		return new ClusterTransaction(this, release);
	}

	// A COMMIT that fails has rolled the transaction back, so the handle is settled either way and the mutex
	// is released here; the rollback DatabaseCore issues next is a no-op.
	async commitTransaction(handle: TransactionHandle): Promise<void> {
		const h = open(handle);
		h.settled = true;
		if (h.savepoint) return this.releaseSavepoint(h, h.savepoint);
		try {
			await translate(() => this.cluster.raw('COMMIT'));
		} catch (e) {
			this.cluster.restoreSchema(h.owner.schema);
			h.rolledBack();
			throw e;
		} finally {
			h.release();
		}
	}

	async rollbackTransaction(handle: TransactionHandle): Promise<void> {
		if (isSettled(handle)) return;
		const h = open(handle);
		h.settled = true;
		if (h.savepoint) return this.rollbackToSavepoint(h, h.savepoint);
		try {
			await translate(() => this.cluster.raw('ROLLBACK'));
		} finally {
			this.cluster.restoreSchema(h.owner.schema);
			h.release();
			h.rolledBack();
		}
	}

	private async releaseSavepoint(h: ClusterTransaction, { parent, name }: Savepoint): Promise<void> {
		try {
			await this.cluster.useSchema(parent.owner.schema);
			await this.cluster.raw(`RELEASE SAVEPOINT ${name}`);
		} catch (e) {
			// The savepoint was aborted by a statement error the callback swallowed: undo it, so the enclosing
			// transaction can go on, and report the commit as failed.
			await this.rollbackToSavepoint(h, { parent, name }).catch(() => {});
			translatePgError(e, 'PgliteCluster');
		}
		h.released();
	}

	// ROLLBACK TO undoes the SET search_path made after the savepoint along with everything else.
	private async rollbackToSavepoint(h: ClusterTransaction, { parent, name }: Savepoint): Promise<void> {
		this.cluster.forgetSchema();
		try {
			await translate(async () => {
				await this.cluster.raw(`ROLLBACK TO SAVEPOINT ${name}`);
				await this.cluster.useSchema(parent.owner.schema);
			});
		} finally {
			h.rolledBack();
		}
	}

	async queryCountedInTransaction<T>(
		handle: TransactionHandle,
		sql: string,
		params?: unknown[],
	): Promise<CountedRows<T>> {
		open(handle);
		return translate(() => this.counted<T>(sql, params));
	}

	async queryInTransaction<T>(handle: TransactionHandle, sql: string, params?: unknown[]): Promise<T[]> {
		return (await this.queryCountedInTransaction<T>(handle, sql, params)).rows;
	}

	async executeInTransaction(
		handle: TransactionHandle,
		sql: string,
		params?: unknown[],
	): Promise<{ rowCount: number }> {
		return { rowCount: (await this.queryCountedInTransaction(handle, sql, params)).rowCount };
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
