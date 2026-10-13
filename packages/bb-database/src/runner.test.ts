// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The resumable runner against a scripted engine: DSQL job waits are deferred
 * across calls (the custom-resource provider's `isComplete` polls), progress is
 * recorded per step, and a failed job fails the file at its wait step.
 */
import assert from 'node:assert';
import { describe, test } from 'node:test';
import type { DatabaseEngine, TransactionHandle } from '@aws-blocks/data-common';
import { buildMigrationPlan } from './migrations/plan.js';
import { runMigrationPlan } from './migrations/runner.js';

type JobState = 'submitted' | 'processing' | 'completed' | 'failed';

/** An in-memory engine that knows only the statements the runner issues. */
class ScriptedEngine implements DatabaseEngine {
	readonly statements: string[] = [];
	readonly migrations = new Set<string>();
	readonly progress = new Map<string, { step: number; jobId: string | null }>();
	readonly jobs = new Map<string, { status: JobState; details?: string }>();
	private nextJob = 0;

	async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
		this.statements.push(sql);
		if (/^SELECT name FROM _migrations/.test(sql)) return [...this.migrations].map((name) => ({ name })) as T[];
		if (/^SELECT step, job_id FROM _migration_progress/.test(sql)) {
			const row = this.progress.get(params[0] as string);
			return (row ? [{ step: row.step, job_id: row.jobId }] : []) as T[];
		}
		if (/^SELECT status, details FROM sys\.jobs/.test(sql)) {
			const job = this.jobs.get(params[0] as string);
			return (job ? [{ status: job.status, details: job.details ?? null }] : []) as T[];
		}
		if (/^SELECT sys\.wait_for_job\('(\w+)'\)/.test(sql)) {
			const id = /'(\w+)'/.exec(sql)?.[1] as string;
			const job = this.jobs.get(id);
			if (job && job.status !== 'failed') job.status = 'completed';
			return [{ ok: job?.status === 'completed' }] as T[];
		}
		if (/\bASYNC\b/.test(sql)) {
			const jobId = `job${++this.nextJob}`;
			this.jobs.set(jobId, { status: 'processing' });
			return [{ job_id: jobId }] as T[];
		}
		return [];
	}

	async execute(sql: string, params: unknown[] = []): Promise<{ rowCount: number }> {
		this.statements.push(sql);
		if (/^INSERT INTO _migration_progress/.test(sql)) {
			this.progress.set(params[0] as string, {
				step: params[1] as number,
				jobId: (params[2] as string | null) ?? null,
			});
		} else if (/^INSERT INTO _migrations/.test(sql)) {
			this.migrations.add(params[0] as string);
		} else if (/^DELETE FROM _migration_progress/.test(sql)) {
			this.progress.delete(params[0] as string);
		}
		return { rowCount: 1 };
	}

	async beginTransaction(): Promise<TransactionHandle> {
		this.statements.push('BEGIN');
		return {};
	}
	async commitTransaction(): Promise<void> {
		this.statements.push('COMMIT');
	}
	async rollbackTransaction(): Promise<void> {
		this.statements.push('ROLLBACK');
	}
	queryInTransaction<T>(_h: TransactionHandle, sql: string, params?: unknown[]): Promise<T[]> {
		return this.query<T>(sql, params);
	}
	executeInTransaction(_h: TransactionHandle, sql: string, params?: unknown[]): Promise<{ rowCount: number }> {
		return this.execute(sql, params);
	}
	async destroy(): Promise<void> {}
}

const files = {
	'001_t.sql': 'CREATE TABLE t (id TEXT PRIMARY KEY, n INT);\nCREATE INDEX t_n ON t (n);',
	'002_seed.sql': "INSERT INTO t VALUES ('a', 1);\nINSERT INTO t VALUES ('b', 2);",
};
const quiet = { log: () => {} };

describe('migration runner', () => {
	test('defer: stops at a running job, records it, and resumes once the job completes', async () => {
		const engine = new ScriptedEngine();
		const plan = buildMigrationPlan(files, 'distributed');

		const first = await runMigrationPlan(engine, plan, { schemaName: 'public', asyncJobs: 'defer', ...quiet });
		assert.deepStrictEqual(first.applied, []);
		assert.deepStrictEqual(first.waitingOn, { file: '001_t.sql', step: 2, jobId: 'job1' });
		assert.deepStrictEqual(engine.progress.get('001_t.sql'), { step: 2, jobId: 'job1' });
		assert.ok(engine.statements.includes('CREATE INDEX ASYNC t_n ON t (n)'));
		assert.ok(!engine.statements.some((s) => /INSERT INTO t VALUES/.test(s)), 'the next file has not started');

		// Still running: the same answer, nothing re-run.
		const before = engine.statements.length;
		const second = await runMigrationPlan(engine, plan, { schemaName: 'public', asyncJobs: 'defer', ...quiet });
		assert.deepStrictEqual(second.waitingOn, first.waitingOn);
		assert.ok(
			!engine.statements.slice(before).some((s) => /CREATE (TABLE t|INDEX)/.test(s)),
			'DDL is not replayed',
		);

		// Completed: the file finishes, the seed runs in one transaction, both files are recorded.
		engine.jobs.set('job1', { status: 'completed' });
		const third = await runMigrationPlan(engine, plan, { schemaName: 'public', asyncJobs: 'defer', ...quiet });
		assert.deepStrictEqual(third.applied, ['001_t.sql', '002_seed.sql']);
		assert.strictEqual(third.waitingOn, undefined);
		assert.deepStrictEqual([...engine.migrations], ['001_t.sql', '002_seed.sql']);
		assert.strictEqual(engine.progress.size, 0);
		const seed = engine.statements.filter((s) => /INSERT INTO t VALUES|BEGIN|COMMIT/.test(s));
		assert.deepStrictEqual(
			seed.slice(
				seed.indexOf("INSERT INTO t VALUES ('a', 1)") - 1,
				seed.indexOf("INSERT INTO t VALUES ('b', 2)") + 2,
			),
			['BEGIN', "INSERT INTO t VALUES ('a', 1)", "INSERT INTO t VALUES ('b', 2)", 'COMMIT'],
		);
	});

	test('defer: a failed job fails the file at its wait step with the job details', async () => {
		const engine = new ScriptedEngine();
		const plan = buildMigrationPlan(files, 'distributed');
		await runMigrationPlan(engine, plan, { schemaName: 'public', asyncJobs: 'defer', ...quiet });
		engine.jobs.set('job1', { status: 'failed', details: 'Found duplicate key while validating index' });
		await assert.rejects(
			runMigrationPlan(engine, plan, { schemaName: 'public', asyncJobs: 'defer', ...quiet }),
			(e: Error) =>
				e.name === 'MigrationFailedException' &&
				/001_t\.sql failed at step 3\/3 \(wait-job\)/.test(e.message) &&
				/Found duplicate key/.test(e.message),
		);
		assert.ok(!engine.migrations.has('001_t.sql'));
	});

	test('wait: blocks on sys.wait_for_job and continues', async () => {
		const engine = new ScriptedEngine();
		const plan = buildMigrationPlan(files, 'distributed');
		const result = await runMigrationPlan(engine, plan, { schemaName: 'public', ...quiet });
		assert.deepStrictEqual(result.applied, ['001_t.sql', '002_seed.sql']);
		assert.ok(engine.statements.includes("SELECT sys.wait_for_job('job1') AS ok"));
	});

	test('a job missing from sys.jobs counts as completed (DSQL purges finished jobs)', async () => {
		const engine = new ScriptedEngine();
		const plan = buildMigrationPlan(files, 'distributed');
		await runMigrationPlan(engine, plan, { schemaName: 'public', asyncJobs: 'defer', ...quiet });
		engine.jobs.delete('job1');
		const result = await runMigrationPlan(engine, plan, { schemaName: 'public', asyncJobs: 'defer', ...quiet });
		assert.deepStrictEqual(result.applied, ['001_t.sql', '002_seed.sql']);
	});

	test('a failed statement names the step and leaves the file resumable at it', async () => {
		const engine = new ScriptedEngine();
		engine.execute = async (sql: string, params: unknown[] = []) => {
			if (/VALUES \('b'/.test(sql)) throw new Error('boom');
			return ScriptedEngine.prototype.execute.call(engine, sql, params);
		};
		const plan = buildMigrationPlan(files, 'distributed');
		await assert.rejects(
			runMigrationPlan(engine, plan, { schemaName: 'public', ...quiet }),
			/002_seed\.sql failed at step 2\/2 \(statement\): INSERT INTO t VALUES \('b', 2\)\nboom/,
		);
		assert.ok(engine.statements.includes('ROLLBACK'));
		assert.deepStrictEqual([...engine.migrations], ['001_t.sql']);
	});
});
