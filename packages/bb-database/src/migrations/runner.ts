// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
/**
 * Runs a {@link MigrationPlan} in the block's schema. `_migrations` records
 * finished files; `_migration_progress` records the last completed step of an
 * unfinished one, so a re-run resumes where it failed.
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
}

/** Create the schema (when not `public`) and the tracking tables. */
export async function ensureMigrationTables(engine: DatabaseEngine, schemaName: string): Promise<void> {
	if (schemaName !== 'public') await engine.execute(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(schemaName)}`);
	await engine.execute(
		'CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMP NOT NULL DEFAULT NOW())',
	);
	await engine.execute(
		'CREATE TABLE IF NOT EXISTS _migration_progress (name TEXT PRIMARY KEY, step INTEGER NOT NULL)',
	);
}

/** Names of the files already recorded in `_migrations`. */
export async function appliedMigrations(engine: DatabaseEngine): Promise<Set<string>> {
	const rows = await engine.query<{ name: string }>('SELECT name FROM _migrations ORDER BY name');
	return new Set(rows.map((r) => r.name));
}

async function lastCompletedStep(engine: DatabaseEngine, file: string): Promise<number> {
	const rows = await engine.query<{ step: number }>('SELECT step FROM _migration_progress WHERE name = $1', [file]);
	return rows[0] ? Number(rows[0].step) : 0;
}

async function recordProgress(engine: DatabaseEngine, handle: TransactionHandle | null, file: string, step: number) {
	const sql =
		'INSERT INTO _migration_progress (name, step) VALUES ($1, $2) ON CONFLICT (name) DO UPDATE SET step = EXCLUDED.step';
	if (handle) await engine.executeInTransaction(handle, sql, [file, step]);
	else await engine.execute(sql, [file, step]);
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

/**
 * Apply every pending file of `plan`. Returns the names applied.
 *
 * Consecutive transactional steps share one transaction; a non-transactional
 * step (DDL on a `distributed` cluster, an index job wait, a constraint
 * validation) runs on its own. Progress is recorded after every unit of work so
 * a failure resumes where it stopped.
 */
export async function runMigrationPlan(
	engine: DatabaseEngine,
	plan: MigrationPlan,
	options: RunPlanOptions,
): Promise<string[]> {
	const log = options.log ?? ((m: string) => console.log(m));
	await ensureMigrationTables(engine, options.schemaName);
	const applied = await appliedMigrations(engine);
	const results: string[] = [];

	for (const file of plan.files) {
		if (applied.has(file.file)) continue;
		const startAt = await lastCompletedStep(engine, file.file);
		if (startAt > 0) log(`[bb-database] Resuming ${file.file} at step ${startAt + 1}`);

		let handle: TransactionHandle | null = null;
		let lastJobId: string | undefined;
		const total = file.steps.length;
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
				if (step.kind === 'wait-index-job') {
					if (lastJobId) await engine.execute(step.sql.replace('$job', `'${lastJobId.replace(/'/g, "''")}'`));
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
	return results;
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
