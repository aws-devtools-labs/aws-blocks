// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// A DSQL cluster's catalog, scripted, for the tests of the migration runner and the migration Lambda. Not part
// of the public package: compiled into `dist/` next to the tests, never imported from an entry file.

import { asyncDdlTarget } from '../dialect/async-ddl.js';
import { RecordingEngine } from './recording-engine.js';

export type JobState = 'submitted' | 'processing' | 'completed' | 'failed';

export interface ProgressRow {
	step: number;
	jobId: string | null;
	fileHash: string;
}

const text = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/**
 * The catalog the runner reads, scripted: the migration tables it keeps, `sys.jobs`, and the `pg_index` /
 * `pg_constraint` state of what an ASYNC statement builds. A SELECT it has no answer for is an error, so a
 * runner that reads something new fails here instead of seeing an empty result.
 */
export class ScriptedEngine extends RecordingEngine {
	readonly migrations = new Set<string>();
	readonly progress = new Map<string, ProgressRow>();
	/** `objectName` is what `sys.jobs.object_name` reports for the job: the index or constraint it builds. */
	readonly jobs = new Map<string, { status: JobState; details?: string; objectName?: string }>();
	/** `schema.index` → `pg_index.indisvalid`; absent means the index does not exist. */
	readonly indexes = new Map<string, boolean>();
	/** `schema.table.constraint` → `pg_constraint.convalidated`; absent means the constraint does not exist. */
	readonly constraints = new Map<string, boolean>();
	private nextJob = 0;

	protected override answer(sql: string, params: unknown[]): unknown[] {
		if (/^SELECT name FROM "public"\."_migrations"/.test(sql))
			return [...this.migrations].map((name) => ({ name }));
		if (/^SELECT name, step, job_id, file_hash FROM "public"\."_migration_progress"/.test(sql)) {
			return [...this.progress].map(([name, row]) => ({
				name,
				step: row.step,
				job_id: row.jobId,
				file_hash: row.fileHash,
			}));
		}
		if (/FROM pg_index/.test(sql)) {
			const valid = this.indexes.get(`${params[0]}.${params[1]}`);
			return valid === undefined ? [] : [{ valid }];
		}
		if (/FROM pg_constraint/.test(sql)) {
			const valid = this.constraints.get(`${params[0]}.${params[1]}.${params[2]}`);
			return valid === undefined ? [] : [{ valid }];
		}
		if (/^SELECT status, details FROM sys\.jobs/.test(sql)) {
			const job = this.jobs.get(String(params[0]));
			return job ? [{ status: job.status, details: job.details ?? null }] : [];
		}
		if (/^SELECT job_id FROM sys\.jobs/.test(sql)) {
			return [...this.jobs]
				.filter(
					([, job]) =>
						job.status !== 'completed' &&
						job.status !== 'failed' &&
						job.objectName !== undefined &&
						params.includes(job.objectName),
				)
				.map(([job_id]) => ({ job_id }));
		}
		if (/\bASYNC\b/.test(sql)) {
			const jobId = `job${++this.nextJob}`;
			const target = asyncDdlTarget(sql);
			this.jobs.set(jobId, { status: 'processing', objectName: target?.name });
			// DSQL lists a building index as INVALID until the job completes.
			if (target?.kind === 'index') this.indexes.set(`public.${target.name}`, false);
			return [{ job_id: jobId }];
		}
		const drop = /^DROP INDEX IF EXISTS "([^"]+)"\."([^"]+)"/.exec(sql);
		if (drop) this.indexes.delete(`${drop[1]}.${drop[2]}`);
		else if (/^INSERT INTO "public"\."_migration_progress"/.test(sql)) {
			this.progress.set(String(params[0]), {
				step: Number(params[1]),
				jobId: text(params[2]),
				fileHash: text(params[3]) ?? '',
			});
		} else if (/^INSERT INTO "public"\."_migrations"/.test(sql)) this.migrations.add(String(params[0]));
		else if (/^DELETE FROM "public"\."_migration_progress"/.test(sql)) this.progress.delete(String(params[0]));
		else if (/^SELECT\b/i.test(sql)) throw new Error(`unscripted SQL: ${sql}`);
		// The file's own DDL and DML, and the runner's CREATE TABLE IF NOT EXISTS, run without an answer.
		return [];
	}
}
