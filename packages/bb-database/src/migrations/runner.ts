// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import type { DatabaseEngine, TransactionHandle } from '@aws-blocks/data-common';
import { DEFAULT_MIGRATIONS_ROOT, DEFAULT_SCHEMA, quoteIdent } from '../constants.js';
import {
	type CatalogState,
	catalogState,
	describeTarget,
	dropInvalidIndex,
	inSchema,
	type ResolvedTarget,
} from '../dialect/async-ddl.js';
import { withTransaction } from '../engines/handle.js';
import { brandedError, configError, MIGRATION_FAILED_ERROR_NAME } from '../errors.js';
import type { FilePlan, MigrationPlan, StatementStep, WaitJobStep } from './plan.js';

interface RunPlanOptions {
	schemaName: string;
	log?: (message: string) => void;
}

interface PendingJob {
	file: string;
	step: number;
	jobId: string;
}

interface RunPlanResult {
	applied: string[];
	waitingOn?: PendingJob;
}

export async function ensureMigrationTables(engine: DatabaseEngine, schemaName: string): Promise<void> {
	if (schemaName !== DEFAULT_SCHEMA) await engine.execute(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(schemaName)}`);
	await engine.execute(
		'CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())',
	);
	await engine.execute(
		'CREATE TABLE IF NOT EXISTS _migration_progress ' +
			'(name TEXT PRIMARY KEY, step INTEGER NOT NULL, job_id TEXT, file_hash TEXT NOT NULL)',
	);
}

async function appliedMigrations(engine: DatabaseEngine): Promise<Set<string>> {
	const rows = await engine.query<{ name: string }>('SELECT name FROM _migrations ORDER BY name');
	return new Set(rows.map((r) => r.name));
}

/** The resume state of a partly applied file. */
interface ProgressRecord {
	/** The next step to run; every step before it is done. */
	step: number;
	/** When `step` is a wait step, the DSQL job it waits on. */
	jobId?: string;
}

/** One `_migration_progress` row per partly applied file; `fileHash` is `FilePlan.hash` of the text the steps ran from. */
async function readProgress(engine: DatabaseEngine): Promise<Map<string, ProgressRecord & { fileHash: string }>> {
	const rows = await engine.query<{ name: string; step: number; job_id: string | null; file_hash: string }>(
		'SELECT name, step, job_id, file_hash FROM _migration_progress',
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
	file: FilePlan,
	record: ProgressRecord,
	handle?: TransactionHandle,
): Promise<void> {
	return exec(
		engine,
		'INSERT INTO _migration_progress (name, step, job_id, file_hash) VALUES ($1, $2, $3, $4) ' +
			'ON CONFLICT (name) DO UPDATE SET step = EXCLUDED.step, job_id = EXCLUDED.job_id, file_hash = EXCLUDED.file_hash',
		[file.file, record.step, record.jobId ?? null, file.hash],
		handle,
	);
}

function deleteProgress(engine: DatabaseEngine, file: FilePlan, handle?: TransactionHandle): Promise<void> {
	return exec(engine, 'DELETE FROM _migration_progress WHERE name = $1', [file.file], handle);
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
	const detail = cause instanceof Error ? cause.message : String(cause);
	return brandedError(
		MIGRATION_FAILED_ERROR_NAME,
		`Migration ${file.file} failed at statement ${k} of ${n}: ${statement.sql.replace(/\s+/g, ' ').trim()}\n` +
			`${detail}\nFix the cause and deploy again; the runner resumes at this statement.`,
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
	await ensureMigrationTables(engine, options.schemaName);
	const applied = await appliedMigrations(engine);
	const progress = await readProgress(engine);
	const results: string[] = [];

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
			save: (record, handle) => recordProgress(engine, file, record, handle),
			clear: () => deleteProgress(engine, file),
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
					if (!handle) handle = await engine.beginTransaction();
					await engine.executeInTransaction(handle, step.sql);
					// Progress is written once per batch, with the COMMIT that makes it visible.
					const next = file.steps[i + 1];
					if (!next?.transactional) {
						await run.save({ step: i + 1 }, handle);
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

		await withTransaction(engine, async (record) => {
			await engine.executeInTransaction(record, 'INSERT INTO _migrations (name) VALUES ($1)', [file.file]);
			await deleteProgress(engine, file, record);
		});
		results.push(file.file);
		log(`[bb-database] Applied: ${file.file}`);
	}
	return { applied: results };
}

export function loadMigrationFiles(dir: string): Record<string, string> {
	const files = readdirSync(dir)
		.filter((f) => f.endsWith('.sql'))
		.sort();
	const migrations: Record<string, string> = {};
	for (const file of files) migrations[file] = readFileSync(join(dir, file), 'utf-8');
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
