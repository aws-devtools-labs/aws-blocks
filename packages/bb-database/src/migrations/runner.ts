// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import type { DatabaseEngine, TransactionHandle } from '../common/engine.js';
import {
	AURORA_MIGRATION_TRANSACTION_TIMEOUT_MS,
	DEFAULT_MIGRATIONS_ROOT,
	DEFAULT_SCHEMA,
	EXTERNAL_MIGRATION_IDLE_TIMEOUT_MS,
	LEDGER_TABLE_NAMES,
	MIGRATION_LAMBDA_TIMEOUT_MINUTES,
	quoteIdent,
} from '../constants.js';
import {
	type CatalogState,
	catalogState,
	describeTarget,
	dropInvalidIndex,
	inSchema,
	type ResolvedTarget,
} from '../dialect/async-ddl.js';
import { withTransaction } from '../engines/handle.js';
import {
	brandedError,
	causeChain,
	configError,
	MIGRATION_FAILED_ERROR_NAME,
	PG_UNIQUE_VIOLATION,
	pgErrorCode,
	sqlStateOf,
} from '../errors.js';
import type { FilePlan, MigrationPlan, StatementStep, WaitJobStep } from './plan.js';

interface RunPlanOptions {
	schemaName: string;
	log?: (message: string) => void;
	/**
	 * On AWS, an `aurora` file is one transaction inside one Lambda invocation. With this set, the runner gives the
	 * server PostgreSQL 17's `transaction_timeout` just under the invocation's limit, so a file that would outlive
	 * the invocation is cancelled by the server and reported with its file and statement instead of the
	 * invocation's own timeout, which names nothing.
	 */
	boundToInvocation?: boolean;
}

// PostgreSQL 17 reports a cancelled transaction (`transaction_timeout`) with this SQLSTATE.
const PG_TRANSACTION_TIMEOUT = '25P04';
// A statement cancelled by `statement_timeout`, the limit an existing database below PostgreSQL 17 gets.
const PG_QUERY_CANCELED = '57014';
// `transaction_timeout` exists from PostgreSQL 17.
const PG_17 = 170000;

// pg_dump 17 and later writes this line into every dump; a server below 17 refuses it and the dump's own
// transaction with it. It only lifts a limit that such a server does not have.
const SETS_TRANSACTION_TIMEOUT = /^\s*SET\s+(?:SESSION\s+)?transaction_timeout\b/i;
// `SET name ...`, `SET SESSION name ...` or `SET LOCAL name ...`: the parameter a statement of a file sets.
const SETS_PARAMETER = /^\s*SET\s+(?:SESSION\s+|LOCAL\s+)?([a-z_]+)\s*(?:=|\bTO\b)/i;

/** What the kind of cluster adds to each transaction of a file. */
interface TransactionRules {
	/** One query sent after BEGIN, before the file's first statement. */
	settings?: string;
	/** Why a statement of the file is not sent, for a statement that is not: the text that follows "skipped". */
	skips(sql: string): string | undefined;
	/** The file is recorded in its own transaction, not in one after it. */
	recordsInFile: boolean;
}

const NO_RULES: TransactionRules = { skips: () => undefined, recordsInFile: false };

async function transactionRules(
	engine: DatabaseEngine,
	plan: MigrationPlan,
	options: RunPlanOptions,
): Promise<TransactionRules> {
	if (plan.kind === 'aurora' && options.boundToInvocation) {
		return { ...NO_RULES, settings: `SET LOCAL transaction_timeout = ${AURORA_MIGRATION_TRANSACTION_TIMEOUT_MS}` };
	}
	if (plan.kind !== 'external') return NO_RULES;
	const rows = await engine.query<{ server_version_num: string }>('SHOW server_version_num');
	const serverVersion = Number(rows[0]?.server_version_num ?? 0);
	// The limits this run applies. A file's own SET of one of them (every pg_dump file has them, set to 0)
	// would replace the limit for the rest of the transaction, so the runner does not send it.
	const limits = ['idle_in_transaction_session_timeout'];
	const settings = [`SET LOCAL idle_in_transaction_session_timeout = ${EXTERNAL_MIGRATION_IDLE_TIMEOUT_MS}`];
	// Transaction-local, so it also holds through a transaction pooler; the ledger is schema-qualified.
	if (options.schemaName !== DEFAULT_SCHEMA) {
		settings.push(`SET LOCAL search_path TO ${quoteIdent(options.schemaName)}, ${quoteIdent(DEFAULT_SCHEMA)}`);
	}
	if (options.boundToInvocation) {
		limits.push('statement_timeout');
		settings.push(`SET LOCAL statement_timeout = ${AURORA_MIGRATION_TRANSACTION_TIMEOUT_MS}`);
		if (serverVersion >= PG_17) {
			limits.push('transaction_timeout');
			settings.push(`SET LOCAL transaction_timeout = ${AURORA_MIGRATION_TRANSACTION_TIMEOUT_MS}`);
		}
	}
	return {
		// One query: the settings are a round trip each otherwise, on every file.
		settings: settings.join('; '),
		skips: (sql) => {
			if (serverVersion < PG_17 && SETS_TRANSACTION_TIMEOUT.test(sql))
				return 'the server is older than PostgreSQL 17';
			const limit = SETS_PARAMETER.exec(sql)?.[1].toLowerCase();
			return limit !== undefined && limits.includes(limit) ? 'the migration run sets this limit' : undefined;
		},
		recordsInFile: true,
	};
}

/** An `aurora` file: every step in one transaction, so nothing of it persists until the whole file has run. */
const isOneTransaction = (file: FilePlan): boolean =>
	file.steps.length > 0 && file.steps.every((step) => step.transactional);

interface PendingJob {
	file: string;
	step: number;
	jobId: string;
}

interface RunPlanResult {
	applied: string[];
	waitingOn?: PendingJob;
}

/** The two bookkeeping tables, schema-qualified: a file that changes `search_path` must not redirect the ledger. */
interface Ledger {
	migrations: string;
	progress: string;
}

export const ledgerTables = (schemaName: string): Ledger => ({
	migrations: `${quoteIdent(schemaName)}.${quoteIdent(LEDGER_TABLE_NAMES[0])}`,
	progress: `${quoteIdent(schemaName)}.${quoteIdent(LEDGER_TABLE_NAMES[1])}`,
});

export async function ensureMigrationTables(engine: DatabaseEngine, schemaName: string): Promise<void> {
	const ledger = ledgerTables(schemaName);
	if (schemaName !== DEFAULT_SCHEMA) await engine.execute(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(schemaName)}`);
	await engine.execute(
		`CREATE TABLE IF NOT EXISTS ${ledger.migrations} (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`,
	);
	await engine.execute(
		`CREATE TABLE IF NOT EXISTS ${ledger.progress} ` +
			'(name TEXT PRIMARY KEY, step INTEGER NOT NULL, job_id TEXT, file_hash TEXT NOT NULL)',
	);
}

async function appliedMigrations(engine: DatabaseEngine, ledger: Ledger): Promise<Set<string>> {
	const rows = await engine.query<{ name: string }>(`SELECT name FROM ${ledger.migrations} ORDER BY name`);
	return new Set(rows.map((r) => r.name));
}

/** A statement runner: an engine's `query`, or a bare PostgreSQL client's. */
type Query = <T>(sql: string, params?: unknown[]) => Promise<T[]>;

/** Which of `files` the ledger of `schemaName` has. It creates nothing: a database with no ledger has none. */
export async function ledgerStatus(
	query: Query,
	schemaName: string,
	files: string[],
): Promise<{ applied: string[]; pending: string[] }> {
	const { migrations } = ledgerTables(schemaName);
	const [table] = await query<{ present: boolean }>('SELECT to_regclass($1) IS NOT NULL AS present', [migrations]);
	const names = new Set(
		table?.present ? (await query<{ name: string }>(`SELECT name FROM ${migrations}`)).map((r) => r.name) : [],
	);
	return { applied: files.filter((f) => names.has(f)), pending: files.filter((f) => !names.has(f)) };
}

/** Records `files` as applied without running them. Returns the ones that were not recorded before. */
export async function markFilesApplied(engine: DatabaseEngine, schemaName: string, files: string[]): Promise<string[]> {
	await ensureMigrationTables(engine, schemaName);
	const { migrations } = ledgerTables(schemaName);
	const marked: string[] = [];
	for (const file of files) {
		const rows = await engine.query<{ name: string }>(
			`INSERT INTO ${migrations} (name) VALUES ($1) ON CONFLICT (name) DO NOTHING RETURNING name`,
			[file],
		);
		if (rows.length > 0) marked.push(file);
	}
	return marked;
}

function recordApplied(
	engine: DatabaseEngine,
	ledger: Ledger,
	file: FilePlan,
	handle: TransactionHandle,
): Promise<unknown> {
	return engine.executeInTransaction(handle, `INSERT INTO ${ledger.migrations} (name) VALUES ($1)`, [file.file]);
}

/** The resume state of a partly applied file. */
interface ProgressRecord {
	/** The next step to run; every step before it is done. */
	step: number;
	/** When `step` is a wait step, the DSQL job it waits on. */
	jobId?: string;
}

/** One `_migration_progress` row per partly applied file; `fileHash` is `FilePlan.hash` of the text the steps ran from. */
async function readProgress(
	engine: DatabaseEngine,
	ledger: Ledger,
): Promise<Map<string, ProgressRecord & { fileHash: string }>> {
	const rows = await engine.query<{ name: string; step: number; job_id: string | null; file_hash: string }>(
		`SELECT name, step, job_id, file_hash FROM ${ledger.progress}`,
	);
	return new Map(
		rows.map((row) => [
			row.name,
			{ step: Number(row.step), jobId: row.job_id ?? undefined, fileHash: row.file_hash },
		]),
	);
}

// Inside the batch's transaction when a handle is given, so the row becomes visible with its COMMIT.
async function exec(engine: DatabaseEngine, sql: string, params: unknown[], handle?: TransactionHandle): Promise<void> {
	if (handle) await engine.executeInTransaction(handle, sql, params);
	else await engine.execute(sql, params);
}

function recordProgress(
	engine: DatabaseEngine,
	ledger: Ledger,
	file: FilePlan,
	record: ProgressRecord,
	handle?: TransactionHandle,
): Promise<void> {
	return exec(
		engine,
		`INSERT INTO ${ledger.progress} (name, step, job_id, file_hash) VALUES ($1, $2, $3, $4) ` +
			'ON CONFLICT (name) DO UPDATE SET step = EXCLUDED.step, job_id = EXCLUDED.job_id, file_hash = EXCLUDED.file_hash',
		[file.file, record.step, record.jobId ?? null, file.hash],
		handle,
	);
}

function deleteProgress(
	engine: DatabaseEngine,
	ledger: Ledger,
	file: FilePlan,
	handle?: TransactionHandle,
): Promise<void> {
	return exec(engine, `DELETE FROM ${ledger.progress} WHERE name = $1`, [file.file], handle);
}

// Messages count the file's statements, which the author wrote; a wait step is the runner's own and is reported at
// the ASYNC statement that started its job.
const statementsOf = (steps: readonly (StatementStep | WaitJobStep)[]): StatementStep[] =>
	steps.filter((step): step is StatementStep => step.kind === 'statement');

/** The 1-based statement number of step `index`, and the file's statement count: `statement k of n`. */
function statementPosition(file: FilePlan, index: number): { k: number; n: number } {
	const step = file.steps[index];
	const statement = step.kind === 'statement' ? step : step.statement;
	const statements = statementsOf(file.steps);
	return { k: statements.indexOf(statement) + 1, n: statements.length };
}

function editedAfterPartialRun(file: FilePlan, nextStep: number): Error {
	const done = statementsOf(file.steps.slice(0, nextStep)).length;
	const total = statementsOf(file.steps).length;
	return brandedError(
		MIGRATION_FAILED_ERROR_NAME,
		`Migration ${file.file} was edited after a partial run: ${done} of ${total} statement(s) ran from an earlier ` +
			'version of the file, and the remaining statements cannot be matched to the new text.\n' +
			'Restore the earlier text so the remaining statements can run, and put the change in a new migration file.',
	);
}

function failed(file: FilePlan, index: number, cause: unknown): Error {
	const step = file.steps[index];
	const statement = step.kind === 'statement' ? step : step.statement;
	const { k, n } = statementPosition(file, index);
	// The engine re-tags a server error and keeps the SQLSTATE and the server's own message on its cause. This
	// report goes to the person who deploys, not to a client, so it carries both.
	const root = causeChain(cause).at(-1);
	const code = pgErrorCode(cause) ?? pgErrorCode(root);
	const reason = root instanceof Error && root !== cause ? root.message : undefined;
	const detail =
		(cause instanceof Error ? cause.message : String(cause)) +
		(code || reason ? ` (${[code && `SQLSTATE ${code}`, reason].filter(Boolean).join(': ')})` : '');
	const wayForward = isOneTransaction(file)
		? code === PG_TRANSACTION_TIMEOUT || code === PG_QUERY_CANCELED
			? `The file is one transaction and it ran longer than the migration function's invocation allows ` +
				`(${MIGRATION_LAMBDA_TIMEOUT_MINUTES} minutes). Nothing from the file was applied. ` +
				'Split the file into smaller files, or move a long backfill out of the migrations.'
			: 'Nothing from the file was applied. Fix the cause and deploy again; the file runs again from the start.'
		: 'Fix the cause and deploy again; the runner resumes at this statement.';
	return brandedError(
		MIGRATION_FAILED_ERROR_NAME,
		`Migration ${file.file} failed at statement ${k} of ${n}: ${statement.sql.replace(/\s+/g, ' ').trim()}\n` +
			`${detail}\n${wayForward}`,
		cause,
	);
}

type FailedJob = { status: 'failed'; reason: string; state?: CatalogState };
type JobOutcome = { status: 'running' | 'completed' | 'missing' } | FailedJob;

async function jobStatus(engine: DatabaseEngine, jobId: string): Promise<JobOutcome> {
	const rows = await engine.query<{ status: string; details: string | null }>(
		'SELECT status, details FROM sys.jobs WHERE job_id = $1',
		[jobId],
	);
	const row = rows[0];
	if (!row) return { status: 'missing' };
	if (row.status === 'completed') return { status: 'completed' };
	if (row.status === 'failed') return { status: 'failed', reason: `DSQL job ${jobId} failed: ${row.details ?? ''}` };
	return { status: 'running' };
}

// DSQL purges finished jobs from `sys.jobs` after 30 minutes, so a missing row says nothing about the outcome;
// the object the statement built or validated does.
async function purgedJobOutcome(
	engine: DatabaseEngine,
	target: ResolvedTarget | undefined,
	jobId: string,
): Promise<JobOutcome> {
	const gone = `DSQL job ${jobId} is no longer listed in sys.jobs`;
	if (!target) return { status: 'failed', reason: `${gone} and the statement is not a form the runner can verify.` };
	const state = await catalogState(engine, target);
	if (state === 'valid') return { status: 'completed' };
	const what = state === 'invalid' ? 'is INVALID' : 'does not exist';
	return {
		status: 'failed',
		state,
		reason: `${gone} and ${describeTarget(target)} ${what}, so the job did not succeed.`,
	};
}

interface FileRun {
	engine: DatabaseEngine;
	file: FilePlan;
	log: (message: string) => void;
	save: (record: ProgressRecord, handle?: TransactionHandle) => Promise<void>;
	clear: () => Promise<void>;
}

// Rewinds the file to the ASYNC statement so the next deploy reissues it instead of re-reading a dead job, and
// returns the error that reports the job at that statement.
async function abandonJob(
	run: FileRun,
	wait: WaitJobStep,
	target: ResolvedTarget | undefined,
	jobId: string,
	outcome: FailedJob,
): Promise<Error> {
	const { engine, file, log } = run;
	if (target && (await dropInvalidIndex(engine, target, outcome.state))) {
		log(`[bb-database] ${file.file}: dropped INVALID ${describeTarget(target)} left by ${jobId}`);
	}
	const at = file.steps.indexOf(wait.statement);
	// At step 0 nothing persisted ran, so the file has no resume state and an edited text may run next.
	if (at === 0) await run.clear();
	else await run.save({ step: at });
	return failed(file, at, new Error(outcome.reason));
}

// The job still building or validating `target`, if `sys.jobs` lists one. DSQL names the object the job works on
// in `object_name`; the bare and the schema-qualified form are both accepted. Any status other than a finished one
// counts as running, as in `jobStatus`.
async function runningJobFor(engine: DatabaseEngine, target: ResolvedTarget): Promise<string | undefined> {
	const rows = await engine.query<{ job_id: string }>(
		"SELECT job_id FROM sys.jobs WHERE status NOT IN ('completed', 'failed') AND object_name IN ($1, $2)",
		[target.name, `${target.schema}.${target.name}`],
	);
	return rows[0]?.job_id;
}

type ResumedAsyncDdl = { kind: 'done' } | { kind: 'adopt'; jobId: string } | { kind: 'reissue' };

// A run resumed at an ASYNC statement may have run it already: the progress save that follows the statement can
// fail (a dropped connection) after the DDL succeeded, and re-issuing `CREATE INDEX ASYNC` would then fail with
// 42P07. The catalog says what happened: a valid object means the statement ran; a missing object means it never
// ran. An INVALID index (or NOT VALID constraint) is either still being built by the job the statement started,
// which is adopted as the wait step's job, or what a failed job left behind, which is dropped so the statement
// can run again.
async function resumedAsyncDdl(run: FileRun, target: ResolvedTarget): Promise<ResumedAsyncDdl> {
	const { engine, file, log } = run;
	const state = await catalogState(engine, target);
	if (state === 'valid') {
		log(`[bb-database] ${file.file}: ${describeTarget(target)} already exists and is valid; not re-issued`);
		return { kind: 'done' };
	}
	if (state === 'invalid') {
		const jobId = await runningJobFor(engine, target);
		if (jobId !== undefined) {
			log(
				`[bb-database] ${file.file}: DSQL job ${jobId} is still working on ${describeTarget(target)}; waiting for it`,
			);
			return { kind: 'adopt', jobId };
		}
	}
	if (await dropInvalidIndex(engine, target, state)) {
		log(`[bb-database] ${file.file}: dropped INVALID ${describeTarget(target)} before re-issuing its statement`);
	}
	return { kind: 'reissue' };
}

export async function runMigrationPlan(
	engine: DatabaseEngine,
	plan: MigrationPlan,
	options: RunPlanOptions,
): Promise<RunPlanResult> {
	const log = options.log ?? ((m: string) => console.log(m));
	const ledger = ledgerTables(options.schemaName);
	await ensureMigrationTables(engine, options.schemaName);
	const applied = await appliedMigrations(engine, ledger);
	const progress = await readProgress(engine, ledger);
	const results: string[] = [];
	const rules = await transactionRules(engine, plan, options);

	for (const file of plan.files) {
		if (applied.has(file.file)) continue;
		const total = file.steps.length;
		const resume = progress.get(file.file);
		if (resume && resume.fileHash !== file.hash) throw editedAfterPartialRun(file, resume.step);
		const startAt = resume?.step ?? 0;
		// The record is the whole resume state: `step` is the next step to run and, when it is a wait step,
		// `jobId` is the job it waits on. The loop below treats a resumed wait step and a fresh one alike.
		let pendingJobId = resume?.jobId;
		const run: FileRun = {
			engine,
			file,
			log,
			save: (record, handle) => recordProgress(engine, ledger, file, record, handle),
			clear: () => deleteProgress(engine, ledger, file),
		};
		if (startAt > 0) {
			const { k, n } = statementPosition(file, startAt);
			log(`[bb-database] Resuming ${file.file} at statement ${k} of ${n}`);
		}

		let handle: TransactionHandle | null = null;
		for (let i = startAt; i < total; i++) {
			const step = file.steps[i];
			try {
				if (step.transactional) {
					if (!handle) {
						handle = await engine.beginTransaction();
						if (rules.settings) await engine.executeInTransaction(handle, rules.settings);
					}
					const skipped = rules.skips(step.sql);
					if (skipped) {
						log(`[bb-database] ${file.file}: skipped "${step.sql.trim()}" (${skipped})`);
					} else {
						await engine.executeInTransaction(handle, step.sql);
					}
					// Progress is written once per batch, with the COMMIT that makes it visible.
					const next = file.steps[i + 1];
					if (!next?.transactional) {
						if (rules.recordsInFile) {
							// A file may set session parameters (a pg_dump file sets a dozen); through a transaction
							// pooler they would stay on a connection that other clients get next.
							await engine.executeInTransaction(handle, 'RESET ALL');
							// In this transaction, not after it: of two runs at once, one commits and the other fails
							// here and is rolled back (below) with everything its copy of the file did.
							await recordApplied(engine, ledger, file, handle).catch((e) => {
								if (sqlStateOf(e) !== PG_UNIQUE_VIOLATION) throw e;
								throw brandedError(
									MIGRATION_FAILED_ERROR_NAME,
									`Migration ${file.file} was applied by another run at the same time. Nothing from this run's ` +
										'copy of the file was applied. Run again: the file is then skipped.',
									e,
								);
							});
						} else {
							await run.save({ step: i + 1 }, handle);
						}
						await engine.commitTransaction(handle);
						handle = null;
					}
					continue;
				}
				if (step.kind === 'statement') {
					const wait = file.steps[i + 1];
					const target = resume && i === startAt && wait?.kind === 'wait-job' && wait.target;
					const resumed = target
						? await resumedAsyncDdl(run, inSchema(target, options.schemaName))
						: { kind: 'reissue' as const };
					if (resumed.kind !== 'reissue') {
						// The wait step polls the adopted job; with no job it records the progress and moves on.
						pendingJobId = resumed.kind === 'adopt' ? resumed.jobId : undefined;
						await run.save({ step: i + 1, jobId: pendingJobId });
						continue;
					}
					const rows = await engine.query<{ job_id?: string }>(step.sql);
					pendingJobId = rows[0]?.job_id ?? undefined;
					// Saved with the job id before the first poll: a run that dies here must not reissue the DDL.
					await run.save({ step: i + 1, jobId: pendingJobId });
					continue;
				}
				// Without a job id there is nothing to wait for: PGlite ran the statement synchronously
				// (pglite-cluster.ts strips ASYNC).
				if (pendingJobId === undefined) {
					await run.save({ step: i + 1 });
					continue;
				}
				const jobId = pendingJobId;
				const status = await jobStatus(engine, jobId);
				if (status.status === 'running') {
					log(`[bb-database] ${file.file}: waiting for DSQL job ${jobId}`);
					return { applied: results, waitingOn: { file: file.file, step: i, jobId } };
				}
				const target = step.target && inSchema(step.target, options.schemaName);
				const outcome = status.status === 'missing' ? await purgedJobOutcome(engine, target, jobId) : status;
				if (outcome.status === 'failed') throw await abandonJob(run, step, target, jobId, outcome);
				pendingJobId = undefined;
				await run.save({ step: i + 1 });
			} catch (e) {
				if (handle) await engine.rollbackTransaction(handle).catch(() => {});
				if (e instanceof Error && e.name === MIGRATION_FAILED_ERROR_NAME) throw e;
				throw failed(file, i, e);
			}
		}

		// A file that records itself has done so with its last statement; one with no statement has nothing to commit.
		if (!rules.recordsInFile || total === 0) {
			await withTransaction(engine, async (record) => {
				await recordApplied(engine, ledger, file, record);
				await deleteProgress(engine, ledger, file, record);
			});
		}
		results.push(file.file);
		log(`[bb-database] Applied: ${file.file}`);
	}
	return { applied: results };
}

/** The names of the migration files of `dir`, in the order they run. */
export function listMigrationFiles(dir: string): string[] {
	return readdirSync(dir)
		.filter((f) => f.endsWith('.sql'))
		.sort();
}

export function loadMigrationFiles(dir: string): Record<string, string> {
	const migrations: Record<string, string> = {};
	for (const file of listMigrationFiles(dir)) migrations[file] = readFileSync(join(dir, file), 'utf-8');
	return migrations;
}

export function resolveMigrationsPath(
	explicit: string | undefined,
	blockId: string,
	blockFullId: string,
	root: string = process.cwd(),
): string | undefined {
	if (explicit !== undefined) {
		const abs = isAbsolute(explicit) ? explicit : resolve(root, explicit);
		if (!existsSync(abs)) {
			throw configError(
				`Database '${blockFullId}': migrationsPath '${explicit}' does not exist (resolved to ${abs}).`,
			);
		}
		return abs;
	}
	const abs = resolve(root, DEFAULT_MIGRATIONS_ROOT, blockId);
	return existsSync(abs) ? abs : undefined;
}
