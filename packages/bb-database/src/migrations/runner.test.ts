// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { describe, test } from 'node:test';
import { asyncDdlTarget } from '../dialect/async-ddl.js';
import { MIGRATION_FAILED_ERROR_NAME } from '../errors.js';
import { RecordingEngine } from '../test-support/recording-engine.js';
import { buildMigrationPlan, type MigrationPlan } from './plan.js';
import { runMigrationPlan } from './runner.js';

type JobState = 'submitted' | 'processing' | 'completed' | 'failed';

interface ProgressRow {
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
class ScriptedEngine extends RecordingEngine {
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
		if (/^SELECT name FROM _migrations/.test(sql)) return [...this.migrations].map((name) => ({ name }));
		if (/^SELECT name, step, job_id, file_hash FROM _migration_progress/.test(sql)) {
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
		else if (/^INSERT INTO _migration_progress/.test(sql)) {
			this.progress.set(String(params[0]), {
				step: Number(params[1]),
				jobId: text(params[2]),
				fileHash: text(params[3]) ?? '',
			});
		} else if (/^INSERT INTO _migrations/.test(sql)) this.migrations.add(String(params[0]));
		else if (/^DELETE FROM _migration_progress/.test(sql)) this.progress.delete(String(params[0]));
		else if (/^SELECT\b/i.test(sql)) throw new Error(`unscripted SQL: ${sql}`);
		// The file's own DDL and DML, and the runner's CREATE TABLE IF NOT EXISTS, run without an answer.
		return [];
	}
}

const files = {
	'001_t.sql': 'CREATE TABLE t (id TEXT PRIMARY KEY, n INT);\nCREATE INDEX ASYNC t_n ON t (n);',
	'002_seed.sql': "INSERT INTO t VALUES ('a', 1);\nINSERT INTO t VALUES ('b', 2);",
};
const constraintFiles = {
	'001_c.sql':
		'CREATE TABLE t (id TEXT PRIMARY KEY, n INT);\n' +
		'ALTER TABLE t ADD CONSTRAINT t_n_pos CHECK (n > 0) NOT VALID;\n' +
		'ALTER TABLE ASYNC t VALIDATE CONSTRAINT t_n_pos;',
};
const lostConnection = () => new Error('Connection terminated unexpectedly');

const run = (engine: ScriptedEngine, plan: MigrationPlan = buildMigrationPlan(files)) =>
	runMigrationPlan(engine, plan, { schemaName: 'public', log: () => {} });

// The DSQL facts these tests pin, which only a live cluster verifies: `sys.jobs` drops a finished job after
// 30 minutes; `object_name` is the bare or schema-qualified name of the index or constraint the job builds;
// an index is INVALID in `pg_index` while its job is still building it.
describe('migration runner', () => {
	test('stops at a running job, records it, and resumes once the job completes', async () => {
		const engine = new ScriptedEngine();
		const plan = buildMigrationPlan(files);

		const first = await run(engine, plan);
		assert.deepStrictEqual(first.applied, []);
		assert.deepStrictEqual(first.waitingOn, { file: '001_t.sql', step: 2, jobId: 'job1' });
		assert.deepStrictEqual(engine.progress.get('001_t.sql'), {
			step: 2,
			jobId: 'job1',
			fileHash: plan.files[0].hash,
		});
		assert.ok(engine.statements.includes('CREATE INDEX ASYNC t_n ON t (n)'));
		assert.ok(!engine.statements.some((s) => /INSERT INTO t VALUES/.test(s)), 'the next file has not started');

		const before = engine.statements.length;
		const second = await run(engine, plan);
		assert.deepStrictEqual(second.waitingOn, first.waitingOn);
		assert.ok(
			!engine.statements.slice(before).some((s) => /CREATE (TABLE t|INDEX)/.test(s)),
			'DDL is not replayed',
		);

		engine.jobs.set('job1', { status: 'completed' });
		const third = await run(engine, plan);
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

	test('the job id is on disk before the first poll, so a dropped connection does not reissue the DDL', async () => {
		const engine = new ScriptedEngine();
		const plan = buildMigrationPlan(files);
		engine.failOn.set(/^SELECT status, details FROM sys\.jobs/, lostConnection());
		await assert.rejects(run(engine, plan), /Connection terminated unexpectedly/);
		assert.deepStrictEqual(engine.progress.get('001_t.sql'), {
			step: 2,
			jobId: 'job1',
			fileHash: plan.files[0].hash,
		});

		const before = engine.statements.length;
		const second = await run(engine, plan);
		assert.deepStrictEqual(second.waitingOn, { file: '001_t.sql', step: 2, jobId: 'job1' });
		assert.ok(!engine.statements.slice(before).some((s) => /\bASYNC\b/.test(s)), 'the index is not created twice');
		assert.strictEqual(engine.jobs.size, 1);
	});

	test('a file edited after a partial run is refused, by name, with the way forward', async () => {
		const engine = new ScriptedEngine();
		const plan = buildMigrationPlan(files);
		await run(engine, plan);
		const saved = { step: 2, jobId: 'job1', fileHash: plan.files[0].hash };
		assert.deepStrictEqual(engine.progress.get('001_t.sql'), saved);

		const edited = { ...files, '001_t.sql': files['001_t.sql'].replace('n INT', 'n INT, extra TEXT') };
		const before = engine.statements.length;
		await assert.rejects(run(engine, buildMigrationPlan(edited)), {
			name: MIGRATION_FAILED_ERROR_NAME,
			message: /001_t\.sql was edited after a partial run[\s\S]*[Rr]estore[\s\S]*new migration file/,
		});
		assert.ok(
			!engine.statements.slice(before).some((s) => /CREATE (TABLE t|INDEX)|INSERT INTO t\b/.test(s)),
			'no step of the edited file runs',
		);
		assert.deepStrictEqual(engine.progress.get('001_t.sql'), saved, 'the record is left for the original text');

		// The original text still finishes.
		engine.jobs.set('job1', { status: 'completed' });
		const result = await run(engine, plan);
		assert.deepStrictEqual(result.applied, ['001_t.sql', '002_seed.sql']);
	});

	test('a failed job rewinds to the ASYNC statement, drops the invalid index, and the next run reissues it', async () => {
		const engine = new ScriptedEngine();
		const plan = buildMigrationPlan(files);
		await run(engine, plan);
		engine.jobs.set('job1', { status: 'failed', details: 'Found duplicate key while validating index' });
		await assert.rejects(run(engine, plan), {
			name: MIGRATION_FAILED_ERROR_NAME,
			message: /001_t\.sql failed at statement 2 of 2: CREATE INDEX ASYNC t_n[\s\S]*Found duplicate key/,
		});
		assert.ok(!engine.migrations.has('001_t.sql'));
		assert.deepStrictEqual(
			engine.progress.get('001_t.sql'),
			{ step: 1, jobId: null, fileHash: plan.files[0].hash },
			'rewound to the CREATE INDEX step, the failed job forgotten',
		);
		assert.ok(engine.statements.includes('DROP INDEX IF EXISTS "public"."t_n"'), 'the INVALID index is dropped');
		assert.ok(!engine.indexes.has('public.t_n'));

		// Every redeploy before the fix re-read the same failed job; now the statement runs again.
		const before = engine.statements.length;
		const retry = await run(engine, plan);
		assert.deepStrictEqual(retry.waitingOn, { file: '001_t.sql', step: 2, jobId: 'job2' });
		const replayed = engine.statements.slice(before);
		assert.ok(replayed.includes('CREATE INDEX ASYNC t_n ON t (n)'), 'the index statement is reissued');
		assert.ok(!replayed.some((s) => /CREATE TABLE t\b/.test(s)), 'earlier steps are not replayed');
	});

	test('a job purged from sys.jobs counts as completed only when the catalog shows a valid index', async () => {
		const engine = new ScriptedEngine();
		const plan = buildMigrationPlan(files);
		await run(engine, plan);
		engine.jobs.delete('job1');
		engine.indexes.set('public.t_n', true);
		const result = await run(engine, plan);
		assert.deepStrictEqual(result.applied, ['001_t.sql', '002_seed.sql']);
	});

	test('a purged job whose index is INVALID is a failure', async () => {
		const engine = new ScriptedEngine();
		const plan = buildMigrationPlan(files);
		await run(engine, plan);
		engine.jobs.delete('job1');
		assert.strictEqual(engine.indexes.get('public.t_n'), false);
		await assert.rejects(run(engine, plan), {
			name: MIGRATION_FAILED_ERROR_NAME,
			message: /001_t\.sql failed at statement 2 of 2[\s\S]*job1.*no longer listed/,
		});
		assert.ok(!engine.migrations.has('001_t.sql'), 'the file is not recorded as applied');
		assert.deepStrictEqual(
			engine.progress.get('001_t.sql'),
			{ step: 1, jobId: null, fileHash: plan.files[0].hash },
			'the file rewinds',
		);
		assert.ok(engine.statements.includes('DROP INDEX IF EXISTS "public"."t_n"'), 'the index is dropped');
	});

	test('a purged job whose index is missing rewinds without a drop', async () => {
		const engine = new ScriptedEngine();
		const plan = buildMigrationPlan(files);
		await run(engine, plan);
		engine.jobs.delete('job1');
		engine.indexes.delete('public.t_n');
		await assert.rejects(run(engine, plan), /job1/);
		assert.deepStrictEqual(engine.progress.get('001_t.sql'), {
			step: 1,
			jobId: null,
			fileHash: plan.files[0].hash,
		});
		assert.ok(!engine.statements.some((s) => s.startsWith('DROP INDEX')));
	});

	test('a purged validation job is checked against pg_constraint.convalidated', async () => {
		const plan = buildMigrationPlan(constraintFiles);

		const notValidated = new ScriptedEngine();
		await run(notValidated, plan);
		notValidated.jobs.delete('job1');
		notValidated.constraints.set('public.t.t_n_pos', false);
		await assert.rejects(
			run(notValidated, plan),
			/001_c\.sql failed at statement 3 of 3: ALTER TABLE ASYNC t VALIDATE CONSTRAINT t_n_pos/,
		);
		assert.deepStrictEqual(
			notValidated.progress.get('001_c.sql'),
			{ step: 2, jobId: null, fileHash: plan.files[0].hash },
			'rewound to the VALIDATE statement',
		);
		assert.ok(!notValidated.statements.some((s) => s.startsWith('DROP')), 'a NOT VALID constraint is kept');

		const validated = new ScriptedEngine();
		await run(validated, plan);
		validated.jobs.delete('job1');
		validated.constraints.set('public.t.t_n_pos', true);
		const result = await run(validated, plan);
		assert.deepStrictEqual(result.applied, ['001_c.sql']);
	});

	test('a failed statement names the step and leaves the file resumable at it', async () => {
		const engine = new ScriptedEngine();
		engine.failOn.set(/VALUES \('b'/, new Error('boom'));
		const first = await run(engine);
		assert.strictEqual(first.waitingOn?.jobId, 'job1');
		engine.jobs.set('job1', { status: 'completed' });
		await assert.rejects(run(engine), {
			name: MIGRATION_FAILED_ERROR_NAME,
			message: /002_seed\.sql failed at statement 2 of 2: INSERT INTO t VALUES \('b', 2\)\nboom/,
		});
		assert.ok(engine.statements.includes('ROLLBACK'));
		assert.deepStrictEqual([...engine.migrations], ['001_t.sql']);
	});

	test('a poll that fails at the wait step names the ASYNC statement, not the wait', async () => {
		const engine = new ScriptedEngine();
		engine.failOn.set(/^SELECT status, details FROM sys\.jobs/, lostConnection());
		await assert.rejects(run(engine), (e: unknown) => {
			assert.ok(e instanceof Error);
			assert.match(
				e.message,
				/001_t\.sql failed at statement 2 of 2: CREATE INDEX ASYNC t_n ON t \(n\)\nConnection terminated/,
			);
			assert.doesNotMatch(e.message, /wait_for_job|wait-job/);
			return true;
		});
	});

	test('a failed job whose ASYNC statement is the first step leaves no progress row, so an edited file runs', async () => {
		const split = {
			'001_t.sql': 'CREATE TABLE t (id TEXT PRIMARY KEY, n INT);',
			'002_idx.sql': 'CREATE INDEX ASYNC t_n ON t (n);',
		};
		const engine = new ScriptedEngine();
		const first = await run(engine, buildMigrationPlan(split));
		assert.deepStrictEqual(first.waitingOn, { file: '002_idx.sql', step: 1, jobId: 'job1' });
		engine.jobs.set('job1', { status: 'failed', details: 'Found duplicate key while validating index' });
		await assert.rejects(
			run(engine, buildMigrationPlan(split)),
			/002_idx\.sql failed at statement 1 of 1: CREATE INDEX ASYNC t_n/,
		);
		assert.ok(!engine.progress.has('002_idx.sql'), 'nothing of the file persisted, so no row is kept');
		assert.ok(engine.statements.includes('DROP INDEX IF EXISTS "public"."t_n"'));

		// The author changes the index (a different column set) in place: nothing ran from the old text.
		const edited = { ...split, '002_idx.sql': 'CREATE INDEX ASYNC t_n ON t (n, id);' };
		const retry = await run(engine, buildMigrationPlan(edited));
		assert.deepStrictEqual(retry.waitingOn, { file: '002_idx.sql', step: 1, jobId: 'job2' });
		assert.ok(engine.statements.includes('CREATE INDEX ASYNC t_n ON t (n, id)'));
	});

	test('a resume at an ASYNC statement whose index is already valid skips the statement and its wait', async () => {
		const engine = new ScriptedEngine();
		const plan = buildMigrationPlan(files);
		// The progress save after a successful CREATE INDEX ASYNC failed: the row still names the statement.
		engine.progress.set('001_t.sql', { step: 1, jobId: null, fileHash: plan.files[0].hash });
		engine.indexes.set('public.t_n', true);
		const result = await run(engine, plan);
		assert.deepStrictEqual(result.applied, ['001_t.sql', '002_seed.sql']);
		assert.ok(!engine.statements.some((s) => /\bASYNC\b/.test(s)), 'the index statement is not re-issued');
		assert.ok(!engine.statements.some((s) => /CREATE TABLE t\b/.test(s)), 'earlier steps are not replayed');
		assert.strictEqual(engine.jobs.size, 0, 'no job was started');
		assert.strictEqual(engine.progress.size, 0);
	});

	test('a resume at an ASYNC statement whose index is INVALID drops it and re-issues the statement', async () => {
		const engine = new ScriptedEngine();
		const plan = buildMigrationPlan(files);
		engine.progress.set('001_t.sql', { step: 1, jobId: null, fileHash: plan.files[0].hash });
		engine.indexes.set('public.t_n', false);
		const result = await run(engine, plan);
		assert.deepStrictEqual(result.waitingOn, { file: '001_t.sql', step: 2, jobId: 'job1' });
		const drop = engine.statements.indexOf('DROP INDEX IF EXISTS "public"."t_n"');
		const create = engine.statements.indexOf('CREATE INDEX ASYNC t_n ON t (n)');
		assert.ok(drop !== -1 && create > drop, 'the INVALID index is dropped before the statement runs again');
	});

	test('a resume at an ASYNC statement whose index is INVALID with a running job adopts the job instead of dropping', async () => {
		const engine = new ScriptedEngine();
		const plan = buildMigrationPlan(files);
		// The statement ran and its job is still building the index when the progress save failed.
		engine.progress.set('001_t.sql', { step: 1, jobId: null, fileHash: plan.files[0].hash });
		engine.indexes.set('public.t_n', false);
		engine.jobs.set('job9', { status: 'processing', objectName: 't_n' });
		const result = await run(engine, plan);
		assert.deepStrictEqual(result.waitingOn, { file: '001_t.sql', step: 2, jobId: 'job9' });
		assert.ok(!engine.statements.some((s) => s.startsWith('DROP INDEX')), 'the building index is kept');
		assert.ok(!engine.statements.some((s) => /\bASYNC\b/.test(s)), 'the statement is not re-issued');
		assert.deepStrictEqual(engine.progress.get('001_t.sql'), {
			step: 2,
			jobId: 'job9',
			fileHash: plan.files[0].hash,
		});

		// The adopted job completes like one the runner started.
		engine.jobs.set('job9', { status: 'completed', objectName: 't_n' });
		engine.indexes.set('public.t_n', true);
		const next = await run(engine, plan);
		assert.deepStrictEqual(next.applied, ['001_t.sql', '002_seed.sql']);
	});

	test('a resume at a VALIDATE CONSTRAINT statement whose validation job is running adopts the job', async () => {
		const engine = new ScriptedEngine();
		const plan = buildMigrationPlan(constraintFiles);
		engine.progress.set('001_c.sql', { step: 2, jobId: null, fileHash: plan.files[0].hash });
		engine.constraints.set('public.t.t_n_pos', false);
		engine.jobs.set('job9', { status: 'processing', objectName: 't_n_pos' });
		const result = await run(engine, plan);
		assert.deepStrictEqual(result.waitingOn, { file: '001_c.sql', step: 3, jobId: 'job9' });
		assert.ok(!engine.statements.some((s) => /\bASYNC\b/.test(s)), 'the statement is not re-issued');
	});

	test('a resume at an ASYNC statement whose index is missing re-issues the statement', async () => {
		const engine = new ScriptedEngine();
		const plan = buildMigrationPlan(files);
		engine.progress.set('001_t.sql', { step: 1, jobId: null, fileHash: plan.files[0].hash });
		const result = await run(engine, plan);
		assert.deepStrictEqual(result.waitingOn, { file: '001_t.sql', step: 2, jobId: 'job1' });
		assert.ok(!engine.statements.some((s) => s.startsWith('DROP INDEX')));
	});

	test('the resume log counts statements, like the failure messages', async () => {
		const engine = new ScriptedEngine();
		const plan = buildMigrationPlan(files);
		await run(engine, plan);
		const lines: string[] = [];
		await runMigrationPlan(engine, plan, { schemaName: 'public', log: (m) => lines.push(m) });
		const resuming = lines.find((line) => line.includes('Resuming'));
		assert.match(resuming ?? '', /Resuming 001_t\.sql at statement 2 of 2/);
		assert.doesNotMatch(resuming ?? '', /at step/);
	});

	test('a progress row for a file absent from the plan is left alone', async () => {
		const engine = new ScriptedEngine();
		engine.progress.set('999_gone.sql', { step: 1, jobId: null, fileHash: 'abc' });
		const result = await run(engine);
		assert.deepStrictEqual(result.waitingOn, { file: '001_t.sql', step: 2, jobId: 'job1' });
		assert.deepStrictEqual(engine.progress.get('999_gone.sql'), { step: 1, jobId: null, fileHash: 'abc' });
	});
});
