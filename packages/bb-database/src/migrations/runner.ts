// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
/**
 * Runs a {@link MigrationPlan} in the block's schema. `_migrations` records
 * finished files; `_migration_progress` records the last completed step of an
 * unfinished one (and the DSQL job it is waiting on, if any), so a re-run
 * resumes where it failed or where it left off waiting.
 */
import { brandBlocksError } from '@aws-blocks/core';
import type { DatabaseEngine, TransactionHandle } from '@aws-blocks/data-common';
import { DEFAULT_MIGRATIONS_ROOT, quoteIdent } from '../constants.js';
import { configError } from '../errors.js';
import type { MigrationPlan, PlanStep } from '../types.js';

/** Error name for a migration that failed mid-plan. */
export const MIGRATION_FAILED_ERROR_NAME = 'MigrationFailedException';

export interface RunPlanOptions {
	/** The block's schema. Created if missing (unless `public`). */
	schemaName: string;
	/** Where progress lines go. @default console.log */
	log?: (message: string) => void;
	/**
	 * What to do at a `wait-job` step whose DSQL job is still running.
	 * `wait` blocks the session with `sys.wait_for_job`; `defer` records the
	 * job in `_migration_progress` and returns, so a later call (the
	 * custom-resource provider's `isComplete` poll) picks up where it left off.
	 * @default 'wait'
	 */
	asyncJobs?: 'wait' | 'defer';
}

/** A DSQL job the plan is waiting on. */
export interface PendingJob {
	file: string;
	/** Index of the `wait-job` step. */
	step: number;
	jobId: string;
}

export interface RunPlanResult {
	/** Files applied to completion in this call. */
	applied: string[];
	/** Set only with `asyncJobs: 'defer'`, when a job is still running. Call again later. */
	waitingOn?: PendingJob;
}

/** Create the schema (when not `public`) and the tracking tables. */
export async function ensureMigrationTables(engine: DatabaseEngine, schemaName: string): Promise<void> {
	if (schemaName !== 'public') await engine.execute(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(schemaName)}`);
	await engine.execute(
		'CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMP NOT NULL DEFAULT NOW())',
	);
	await engine.execute(
		'CREATE TABLE IF NOT EXISTS _migration_progress (name TEXT PRIMARY KEY, step INTEGER NOT NULL, job_id TEXT)',
	);
}

/** Names of the files already recorded in `_migrations`. */
export async function appliedMigrations(engine: DatabaseEngine): Promise<Set<string>> {
	const rows = await engine.query<{ name: string }>('SELECT name FROM _migrations ORDER BY name');
	return new Set(rows.map((r) => r.name));
}

interface Progress {
	/** Steps completed so far (the index of the next step to run). */
	step: number;
	/** The job the step at `step` is waiting on, if any. */
	jobId?: string;
}

async function readProgress(engine: DatabaseEngine, file: string): Promise<Progress> {
	const rows = await engine.query<{ step: number; job_id: string | null }>(
		'SELECT step, job_id FROM _migration_progress WHERE name = $1',
		[file],
	);
	if (!rows[0]) return { step: 0 };
	return { step: Number(rows[0].step), jobId: rows[0].job_id ?? undefined };
}

async function recordProgress(
	engine: DatabaseEngine,
	handle: TransactionHandle | null,
	file: string,
	step: number,
	jobId: string | null = null,
) {
	const sql =
		'INSERT INTO _migration_progress (name, step, job_id) VALUES ($1, $2, $3) ' +
		'ON CONFLICT (name) DO UPDATE SET step = EXCLUDED.step, job_id = EXCLUDED.job_id';
	if (handle) await engine.executeInTransaction(handle, sql, [file, step, jobId]);
	else await engine.execute(sql, [file, step, jobId]);
}

function failed(file: string, index: number, total: number, step: PlanStep, cause: unknown): Error {
	const detail = cause instanceof Error ? cause.message : String(cause);
	const err = new Error(
		`Migration ${file} failed at step ${index + 1}/${total} (${step.kind}): ${step.sql.replace(/\s+/g, ' ').trim()}\n` +
			`${detail}\nFix the cause and deploy again; the runner resumes at this step.`,
		{ cause },
	);
	err.name = MIGRATION_FAILED_ERROR_NAME;
	return brandBlocksError(err);
}

type JobStatus = 'running' | 'completed' | 'failed';

/**
 * Status of a DSQL asynchronous DDL job from `sys.jobs`. A job missing from the
 * view is treated as completed: DSQL purges finished jobs after 30 minutes, and
 * a failed index or constraint would have failed the job while it was listed.
 */
export async function jobStatus(
	engine: DatabaseEngine,
	jobId: string,
): Promise<{ status: JobStatus; details?: string }> {
	const rows = await engine.query<{ status: string; details: string | null }>(
		'SELECT status, details FROM sys.jobs WHERE job_id = $1',
		[jobId],
	);
	const row = rows[0];
	if (!row) return { status: 'completed' };
	if (row.status === 'completed') return { status: 'completed' };
	if (row.status === 'failed') return { status: 'failed', details: row.details ?? undefined };
	return { status: 'running' };
}

const quoteLiteral = (value: string) => `'${value.replace(/'/g, "''")}'`;

/** Block the session until the job finishes; throw when it failed. */
async function waitForJob(engine: DatabaseEngine, jobId: string): Promise<void> {
	const rows = await engine.query<{ ok: boolean }>(`SELECT sys.wait_for_job(${quoteLiteral(jobId)}) AS ok`);
	if (rows[0]?.ok === false) {
		const status = await jobStatus(engine, jobId);
		throw new Error(`DSQL job ${jobId} failed${status.details ? `: ${status.details}` : ''}`);
	}
}

/**
 * Apply every pending file of `plan`. Returns the names applied and, with
 * `asyncJobs: 'defer'`, the job it stopped at when one is still running.
 *
 * Consecutive transactional steps share one transaction; a non-transactional
 * step (DDL on a `distributed` cluster, a job wait, a constraint validation)
 * runs on its own. Progress is recorded after every unit of work so a failure
 * resumes where it stopped.
 */
export async function runMigrationPlan(
	engine: DatabaseEngine,
	plan: MigrationPlan,
	options: RunPlanOptions,
): Promise<RunPlanResult> {
	const log = options.log ?? ((m: string) => console.log(m));
	const defer = options.asyncJobs === 'defer';
	await ensureMigrationTables(engine, options.schemaName);
	const applied = await appliedMigrations(engine);
	const results: string[] = [];

	for (const file of plan.files) {
		if (applied.has(file.file)) continue;
		const total = file.steps.length;
		const progress = await readProgress(engine, file.file);
		let startAt = progress.step;

		if (progress.jobId !== undefined) {
			// Resuming at a wait-job step: the job was started by the previous run.
			const step = file.steps[startAt];
			const status = await jobStatus(engine, progress.jobId);
			if (status.status === 'running') {
				return { applied: results, waitingOn: { file: file.file, step: startAt, jobId: progress.jobId } };
			}
			if (status.status === 'failed') {
				throw failed(
					file.file,
					startAt,
					total,
					step,
					new Error(`DSQL job ${progress.jobId} failed: ${status.details ?? ''}`),
				);
			}
			await recordProgress(engine, null, file.file, startAt + 1);
			startAt++;
		}
		if (startAt > 0) log(`[bb-database] Resuming ${file.file} at step ${startAt + 1}`);

		let handle: TransactionHandle | null = null;
		let lastJobId: string | undefined;
		for (let i = startAt; i < total; i++) {
			const step = file.steps[i];
			try {
				if (step.transactional) {
					if (!handle) handle = await engine.beginTransaction();
					await engine.executeInTransaction(handle, step.sql);
					await recordProgress(engine, handle, file.file, i + 1);
					const next = file.steps[i + 1];
					if (!next || !next.transactional) {
						await engine.commitTransaction(handle);
						handle = null;
					}
					continue;
				}
				if (handle) {
					await engine.commitTransaction(handle);
					handle = null;
				}
				if (step.kind === 'wait-job') {
					if (lastJobId) {
						if (defer) {
							const status = await jobStatus(engine, lastJobId);
							if (status.status === 'failed')
								throw new Error(`DSQL job ${lastJobId} failed: ${status.details ?? ''}`);
							if (status.status === 'running') {
								await recordProgress(engine, null, file.file, i, lastJobId);
								log(`[bb-database] ${file.file}: waiting for DSQL job ${lastJobId}`);
								return { applied: results, waitingOn: { file: file.file, step: i, jobId: lastJobId } };
							}
						} else {
							await waitForJob(engine, lastJobId);
						}
					}
					lastJobId = undefined;
				} else {
					const rows = await engine.query<{ job_id?: string }>(step.sql);
					lastJobId = rows[0]?.job_id ?? undefined;
				}
				await recordProgress(engine, null, file.file, i + 1);
			} catch (e) {
				if (handle) await engine.rollbackTransaction(handle).catch(() => {});
				throw failed(file.file, i, total, step, e);
			}
		}

		const record = await engine.beginTransaction();
		try {
			await engine.executeInTransaction(record, 'INSERT INTO _migrations (name) VALUES ($1)', [file.file]);
			await engine.executeInTransaction(record, 'DELETE FROM _migration_progress WHERE name = $1', [file.file]);
			await engine.commitTransaction(record);
		} catch (e) {
			await engine.rollbackTransaction(record).catch(() => {});
			throw e;
		}
		results.push(file.file);
		log(`[bb-database] Applied: ${file.file}`);
	}
	return { applied: results };
}

/** Load `*.sql` files from a directory, sorted by name. */
export function loadMigrationFiles(dir: string): Record<string, string> {
	const files = readdirSync(dir)
		.filter((f) => f.endsWith('.sql'))
		.sort();
	const migrations: Record<string, string> = {};
	for (const file of files) migrations[file] = readFileSync(join(dir, file), 'utf-8');
	return migrations;
}

/**
 * Resolve a block's migrations directory. An explicit `migrationsPath` must
 * exist; the default `./aws-blocks/migrations/{id}` may be absent (a new block
 * has no migrations yet), in which case `undefined` is returned.
 */
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
