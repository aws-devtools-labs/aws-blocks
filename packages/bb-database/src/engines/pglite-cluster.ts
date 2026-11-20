// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, renameSync, unlinkSync } from 'node:fs';
import { join, sep } from 'node:path';
import { LEGACY_MOCK_DATA_DIR, MOCK_DATA_DIR } from '@aws-cdk-blocks/core/bb-utils';
import { PGlite } from '@electric-sql/pglite';
import type { TransactionHandle } from '../common/engine.js';
import { initializePgliteWithRetry } from '../common/pglite-init.js';
import { closeOnProcessExit, pgliteUnrefTimersExtension } from '../common/pglite-process.js';
import { CLAIMS_SETTING, LOCAL_APP_ROLE, NO_CLAIMS, quoteIdent, SESSION_TRANSACTION_WAIT_MS } from '../constants.js';
import { ASYNC_DDL } from '../dialect/validation.js';
import { sessionTransactionOpen, translated, translatePgError } from '../errors.js';
import { currentTransactionHandle } from '../runtime/tx-scope.js';
import type { ClusterType } from '../types.js';
import {
	CountedEngine,
	type CountedRows,
	EngineTransaction,
	isSettled,
	openTransaction,
	type RowCountingEngine,
	withTransaction,
} from './handle.js';
import { AURORA_LOCAL_EXTENSIONS, explainMissingExtension } from './pglite-extensions.js';

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
GRANT USAGE ON SCHEMA sys TO PUBLIC;
GRANT SELECT ON sys.jobs TO PUBLIC;
`;

// PGlite's own user, a superuser: the stand-in for the cluster admin, which runs the migrations.
const ADMIN_ROLE = 'postgres';

// The stand-in for the deployed app role: a plain role that gets the grants the migration Lambda issues, so
// PostgreSQL refuses locally what it refuses on AWS (DDL, the migration ledger, rows a policy hides).
const APP_ROLE_SETUP = `DO $$ BEGIN CREATE ROLE ${quoteIdent(LOCAL_APP_ROLE)}; EXCEPTION WHEN duplicate_object THEN NULL; END $$`;

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
	assertNotAHalfCopy(dataDir);
	const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
	const corruptDataDir = `${dataDir}.corrupt-${timestamp}-${process.pid}-${randomUUID().slice(0, 8)}`;
	renameSync(dataDir, corruptDataDir);
	mkdirSync(dataDir, { recursive: true });
	console.log(`[bb-database] Moved incomplete PGlite data directory to ${corruptDataDir}; created a fresh one.`);
}

// `dataDir` before the data directory moved under `.cdk-blocks/`, or undefined when it is not under it at all.
function legacyCounterpart(dataDir: string): string | undefined {
	const consolidated = join(process.cwd(), MOCK_DATA_DIR);
	if (!dataDir.startsWith(consolidated + sep)) return undefined;
	return join(process.cwd(), LEGACY_MOCK_DATA_DIR, dataDir.slice(consolidated.length + 1));
}

// A carry-over that did not finish must fail rather than be reset to an empty database: an empty one looks like
// a fresh project, so the next write would start a second copy of rows the project already had.
//
// REACHABILITY. In the carry-over path this is now defence in depth, not the first line: every caller resolves
// `dataDir` through `getMockDataDir`, whose copy fills in whatever the new directory lacks and which records the
// unit only AFTER that copy returns, so an interrupted copy is simply retried on the next call and never reaches
// here looking initialized-but-partial. What does still reach here is a directory a PERSON made partial — a
// hand-copied `.bb-data/<id>/pglite`, an interrupted `cp -r`, or a restore from a partial backup — which is the
// case this refuses. Verified by `local-data-carry-over.test.ts`, which exercises both the real
// `getMockDataDir` path (self-healing) and a hand-made partial copy (refused).
function assertNotAHalfCopy(dataDir: string): void {
	const legacy = legacyCounterpart(dataDir);
	if (legacy === undefined || !hasInitializedPgliteDataDir(legacy)) return;
	throw new Error(
		`The local database copied from ${legacy} to ${dataDir} is incomplete: it is missing one of ` +
			`${PGLITE_INITIALIZED_DATA_DIR_ENTRIES.join(', ')}. ${legacy} is untouched, so delete ${dataDir} ` +
			'and run again rather than starting on an empty database.',
	);
}

interface Savepoint {
	readonly parent: ClusterTransaction;
	readonly name: string;
	/** The enclosing transaction's claims, put back at RELEASE (`setAsideClaims`). */
	readonly claims?: string;
}

// Settling the handle releases the mutex exactly once. A transaction begun inside another block's open
// transaction on the same cluster is a savepoint in it (§4.1).
class ClusterTransaction extends EngineTransaction {
	private rollbackListeners: (() => void)[] = [];

	constructor(
		readonly owner: SchemaEngine,
		/** The session's user for this transaction's statements. */
		readonly role: string,
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

// PGlite has one session: each block's statements switch `search_path` to its schema and the session's user
// to the app role (the admin for a migration run) under a mutex, held for one auto-commit statement or one
// BEGIN … COMMIT. A block's own statements inside its transaction() callback never reach the mutex:
// DatabaseCore routes them to the in-transaction methods. Another block's statements inside that callback
// cannot wait for the mutex either; they nest in the open transaction.
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
	private currentRole?: string;
	/** The top-level transaction that holds the mutex. */
	holder?: ClusterTransaction;

	constructor(
		readonly dataDir: string,
		readonly kind: ClusterType,
	) {
		this.db = this.createDb();
	}

	private createDb(): PGlite {
		mkdirSync(this.dataDir, { recursive: true });
		recoverIncompletePgliteDataDir(this.dataDir);
		cleanStaleLock(this.dataDir);
		this.cancelExitClose ??= closeOnProcessExit(() => this.closeForExit());
		// An aurora cluster is PostgreSQL with its contrib extensions; DSQL has none, and dsql-lint rejects
		// `CREATE EXTENSION` before a statement reaches PGlite.
		const contrib = this.kind === 'aurora' ? AURORA_LOCAL_EXTENSIONS : {};
		return new PGlite(this.dataDir, {
			extensions: { ...contrib, awsBlocksUnrefTimers: pgliteUnrefTimersExtension },
		});
	}

	// So PostgreSQL shuts down cleanly and removes its postmaster.pid when the process exits.
	private async closeForExit(): Promise<void> {
		this.cancelExitClose = undefined;
		if (this.closed || this.exitClosing) return;
		this.ready = undefined;
		this.forgetSession();
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
				// DSQL's `sys` schema exists on a DSQL cluster only; an Aurora block that queries it fails locally too.
				if (this.kind === 'dsql') await db.exec(SYS_SCHEMA_STUB);
				await db.exec(APP_ROLE_SETUP);
				// As a deployed aurora connection has it (pg-engine.ts): what a statement with no user sees.
				if (this.kind === 'aurora')
					await db.exec(`SELECT set_config('${CLAIMS_SETTING}', '${NO_CLAIMS}', false)`);
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
		// ASYNC is a DSQL form; Aurora rejects it, and so does PGlite when the cluster is `aurora`.
		try {
			const result = await db.query<T>(this.kind === 'dsql' ? synchronous(sql) : sql, params);
			return { rows: result.rows, affectedRows: result.affectedRows ?? 0 };
		} catch (e) {
			throw this.kind === 'aurora' ? explainMissingExtension(e) : e;
		}
	}

	/** Points the session at `schema`, with `role` as its user. */
	async useSession(schema: string, role: string): Promise<void> {
		if (this.currentSchema !== schema) {
			await this.raw(`SET search_path TO ${quoteIdent(schema)}`);
			this.currentSchema = schema;
		}
		if (this.currentRole !== role) {
			// Always by name: RESET SESSION AUTHORIZATION does not return a PGlite session to its own user.
			await this.raw(`SET SESSION AUTHORIZATION ${quoteIdent(role)}`);
			this.currentRole = role;
		}
	}

	forgetSession(): void {
		this.currentSchema = undefined;
		this.currentRole = undefined;
	}

	/** What the session is back at after a top-level ROLLBACK: the SETs ran before BEGIN, so they survive. */
	restoreSession(schema: string, role: string): void {
		this.currentSchema = schema;
		this.currentRole = role;
	}

	// On AWS a nested call runs on its own connection, which carries no user. Here it is a savepoint of the
	// enclosing transaction, so that transaction's claims are set aside for it and put back before its RELEASE:
	// a transaction-local setting made inside a savepoint outlives the RELEASE.
	async setAsideClaims(): Promise<string | undefined> {
		if (this.kind !== 'aurora') return undefined;
		const { rows } = await this.raw<{ claims: string | null }>(
			`SELECT current_setting('${CLAIMS_SETTING}', true) AS claims`,
		);
		await this.setClaims(NO_CLAIMS);
		return rows[0]?.claims || NO_CLAIMS;
	}

	async setClaims(claims: string): Promise<void> {
		await this.raw(`SELECT set_config('${CLAIMS_SETTING}', $1, true)`, [claims]);
	}

	acquire(): Promise<() => void> {
		const acquired = this.mutex.acquire();
		if (!this.holder?.fromSession) return acquired;
		// A Kysely transaction holds the session. A statement issued inside its callback on anything but
		// its transaction object cannot join it and would wait for it forever, so this wait is bounded.
		return new Promise((resolve, reject) => {
			let waiting = true;
			const timer = setTimeout(() => {
				waiting = false;
				reject(sessionTransactionOpen(SESSION_TRANSACTION_WAIT_MS));
			}, SESSION_TRANSACTION_WAIT_MS);
			void acquired.then((release) => {
				clearTimeout(timer);
				if (waiting) resolve(release);
				else release();
			});
		});
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

export class SchemaEngine extends CountedEngine implements RowCountingEngine {
	private admin = false;

	constructor(
		readonly cluster: PgliteCluster,
		readonly schema: string,
	) {
		super();
	}

	/** Inside {@link asAdmin}: the statements are a migration's or a test's setup, not the application's. */
	get isAdmin(): boolean {
		return this.admin;
	}

	private get role(): string {
		return this.admin ? ADMIN_ROLE : LOCAL_APP_ROLE;
	}

	/** Runs `fn` with this engine's statements issued as the cluster admin, as a migration's are on AWS. */
	async asAdmin<T>(fn: () => Promise<T>): Promise<T> {
		const previous = this.admin;
		this.admin = true;
		try {
			return await fn();
		} finally {
			this.admin = previous;
		}
	}

	private enclosing(): ClusterTransaction | undefined {
		return this.cluster.enclosingTransaction();
	}

	private async exclusive<T>(fn: () => Promise<T>): Promise<T> {
		if (this.enclosing()) return withTransaction(this, fn);
		const release = await this.cluster.acquire();
		try {
			await this.cluster.useSession(this.schema, this.role);
			return await fn();
		} finally {
			release();
		}
	}

	private async counted<T>(sql: string, params?: unknown[]): Promise<CountedRows<T>> {
		const { rows, affectedRows } = await this.cluster.raw<T>(sql, params);
		return { rows, rowCount: affectedRows };
	}

	queryCounted<T>(sql: string, params?: unknown[]): Promise<CountedRows<T>> {
		return translate(() => this.exclusive(() => this.counted<T>(sql, params)));
	}

	async beginTransaction(): Promise<TransactionHandle> {
		const role = this.role;
		const parent = this.enclosing();
		if (parent) {
			const name = `bb_database_${++savepoints}`;
			const claims = await translate(async () => {
				await this.cluster.raw(`SAVEPOINT ${name}`);
				await this.cluster.useSession(this.schema, role);
				return this.cluster.setAsideClaims();
			});
			return new ClusterTransaction(this, role, () => {}, { parent, name, claims });
		}
		const release = await this.cluster.acquire();
		try {
			await translate(async () => {
				await this.cluster.useSession(this.schema, role);
				await this.cluster.raw('BEGIN');
			});
		} catch (e) {
			release();
			throw e;
		}
		const tx: ClusterTransaction = new ClusterTransaction(this, role, () => {
			this.cluster.holder = undefined;
			release();
		});
		this.cluster.holder = tx;
		return tx;
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
			this.cluster.restoreSession(h.owner.schema, h.role);
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
			this.cluster.restoreSession(h.owner.schema, h.role);
			h.release();
			h.rolledBack();
		}
	}

	private async releaseSavepoint(h: ClusterTransaction, { parent, name, claims }: Savepoint): Promise<void> {
		try {
			await this.cluster.useSession(parent.owner.schema, parent.role);
			if (claims !== undefined) await this.cluster.setClaims(claims);
			await this.cluster.raw(`RELEASE SAVEPOINT ${name}`);
		} catch (e) {
			// The savepoint was aborted by a statement error the callback swallowed: undo it, so the enclosing
			// transaction can go on, and report the commit as failed.
			await this.rollbackToSavepoint(h, { parent, name }).catch(() => {});
			translatePgError(e, 'PgliteCluster');
		}
		h.released();
	}

	// ROLLBACK TO undoes the SETs made after the savepoint along with everything else.
	private async rollbackToSavepoint(h: ClusterTransaction, { parent, name }: Savepoint): Promise<void> {
		this.cluster.forgetSession();
		try {
			await translate(async () => {
				await this.cluster.raw(`ROLLBACK TO SAVEPOINT ${name}`);
				await this.cluster.useSession(parent.owner.schema, parent.role);
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

	async destroy(): Promise<void> {}
}

/** The directory of a local cluster's PGlite database, under the data directory of the block or the cluster. */
export const PGLITE_SUBDIR = 'pglite';

const clusters = new Map<string, PgliteCluster>();

export function sharedPgliteCluster(dataDir: string, kind: ClusterType): PgliteCluster {
	let c = clusters.get(dataDir);
	if (!c) {
		c = new PgliteCluster(dataDir, kind);
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
