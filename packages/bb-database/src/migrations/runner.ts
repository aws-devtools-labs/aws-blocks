// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { brandBlocksError } from '@aws-blocks/core';
import type { DatabaseEngine, TransactionHandle } from '@aws-blocks/data-common';
import { DEFAULT_MIGRATIONS_ROOT, quoteIdent } from '../constants.js';
import { configError } from '../errors.js';
import type { MigrationPlan, PlanStep } from './plan.js';

const MIGRATION_FAILED_ERROR_NAME = 'MigrationFailedException';

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
	if (schemaName !== 'public') await engine.execute(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(schemaName)}`);
	await engine.execute(
		'CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMP NOT NULL DEFAULT NOW())',
	);
	await engine.execute(
		'CREATE TABLE IF NOT EXISTS _migration_progress (name TEXT PRIMARY KEY, step INTEGER NOT NULL, job_id TEXT)',
	);
}

async function appliedMigrations(engine: DatabaseEngine): Promise<Set<string>> {
	const rows = await engine.query<{ name: string }>('SELECT name FROM _migrations ORDER BY name');
	return new Set(rows.map((r) => r.name));
}

interface Progress {
	step: number;
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

// A job missing from `sys.jobs` counts as completed: DSQL purges finished jobs after 30 minutes, and a
// failed index or constraint would have failed the job while it was still listed.
async function jobStatus(engine: DatabaseEngine, jobId: string): Promise<{ status: JobStatus; details?: string }> {
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

export async function runMigrationPlan(
	engine: DatabaseEngine,
	plan: MigrationPlan,
	options: RunPlanOptions,
): Promise<RunPlanResult> {
	const log = options.log ?? ((m: string) => console.log(m));
	await ensureMigrationTables(engine, options.schemaName);
	const applied = await appliedMigrations(engine);
	const results: string[] = [];

	for (const file of plan.files) {
		if (applied.has(file.file)) continue;
		const total = file.steps.length;
		const progress = await readProgress(engine, file.file);
		let startAt = progress.step;

		if (progress.jobId !== undefined) {
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
					// Without a job id there is nothing to wait for: PGlite ran the statement synchronously
					// (the mock strips ASYNC).
					if (lastJobId) {
						const status = await jobStatus(engine, lastJobId);
						if (status.status === 'failed')
							throw new Error(`DSQL job ${lastJobId} failed: ${status.details ?? ''}`);
						if (status.status === 'running') {
							await recordProgress(engine, null, file.file, i, lastJobId);
							log(`[bb-database] ${file.file}: waiting for DSQL job ${lastJobId}`);
							return { applied: results, waitingOn: { file: file.file, step: i, jobId: lastJobId } };
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
