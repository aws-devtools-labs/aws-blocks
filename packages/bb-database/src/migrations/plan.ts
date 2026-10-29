// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Sequences a block's migration files into the steps the runner executes on a
 * `dsql` cluster. The SQL is the customer's, unchanged: a `Database` runs on
 * Aurora DSQL, so its migrations are written in DSQL as AWS documents it, and
 * what is in the file is what runs. The plan only decides how each statement
 * runs: every DDL statement in its own transaction (DSQL allows one DDL per
 * transaction; consecutive DML statements share one), and the two asynchronous
 * forms, `CREATE [UNIQUE] INDEX ASYNC` and `ALTER TABLE ASYNC … VALIDATE
 * CONSTRAINT`, each followed by a wait for the job DSQL returns.
 *
 * Before sequencing, every file is checked as written with AWS's `dsql-lint`
 * (see `validation.ts`). What DSQL cannot run, including the PostgreSQL
 * spellings of DSQL forms (`SERIAL`, `CREATE INDEX` without `ASYNC`, an
 * `ADD CONSTRAINT` without `NOT VALID`), stops the plan with the linter's
 * message and suggestion, naming the file and the rule.
 */
import { brandBlocksError } from '@aws-blocks/core';
import { splitStatements } from '@aws-blocks/data-common';
import type { ClusterType } from '../types.js';
import { classifyStatement, findStatementIssues, stripLiteralsAndComments } from '../validation.js';

/** One step of a migration file's plan: a statement from the file, or a wait for the job a statement started. */
export interface PlanStep {
	/**
	 * What the step does. `statement` runs a statement from the file;
	 * `validate-constraint` runs the file's `ALTER TABLE ASYNC … VALIDATE
	 * CONSTRAINT`, which returns a job id; `wait-job` waits for the job the
	 * previous step started (an index build or a constraint validation).
	 */
	kind: 'statement' | 'validate-constraint' | 'wait-job';
	/** The SQL as written in the file. For `wait-job`, a label: the runner polls `sys.jobs` instead of running it. */
	sql: string;
	/** Whether this step runs inside the file's shared transaction (`false` → its own implicit transaction). */
	transactional: boolean;
}

/** The plan for one migration file. */
export interface FilePlan {
	file: string;
	steps: PlanStep[];
}

/** The plan for a migration directory against a cluster kind. */
export interface MigrationPlan {
	target: ClusterType;
	files: FilePlan[];
}

/** Error name for a migration directory the target cluster cannot run. */
const MIGRATION_VALIDATION_ERROR_NAME = 'DsqlMigrationValidationError';

/** `CREATE [UNIQUE] INDEX ASYNC …`: DSQL returns a job id and builds the index in the background. */
const CREATE_INDEX_ASYNC = /^\s*CREATE\s+(?:UNIQUE\s+)?INDEX\s+ASYNC\b/i;
/** `ALTER TABLE ASYNC … VALIDATE CONSTRAINT …`: DSQL returns a job id and validates existing rows in the background. */
const ALTER_TABLE_ASYNC_VALIDATE = /^\s*ALTER\s+TABLE\s+ASYNC\b[\s\S]*\bVALIDATE\s+CONSTRAINT\b/i;

/**
 * The job-wait step that follows an asynchronous DDL statement. The runner does
 * not run this SQL: it polls `sys.jobs` for the job id the previous step
 * returned, across Lambda invocations; the text labels the step in messages.
 */
const waitJob = (): PlanStep => ({ kind: 'wait-job', sql: 'SELECT sys.wait_for_job($job)', transactional: false });

/** The plan steps for one statement, as written. */
function sequenceStatement(statement: string): PlanStep[] {
	const cleaned = stripLiteralsAndComments(statement);
	if (CREATE_INDEX_ASYNC.test(cleaned)) {
		return [{ kind: 'statement', sql: statement, transactional: false }, waitJob()];
	}
	if (ALTER_TABLE_ASYNC_VALIDATE.test(cleaned)) {
		return [{ kind: 'validate-constraint', sql: statement, transactional: false }, waitJob()];
	}
	return [{ kind: 'statement', sql: statement, transactional: classifyStatement(statement) !== 'ddl' }];
}

interface BuildPlanOptions {
	/**
	 * Check each file with dsql-lint before sequencing it. On by default; the
	 * migration Lambda turns it off because the files were checked at synth and
	 * the linter binary is not deployed.
	 * @default true
	 */
	validate?: boolean;
}

/**
 * Build the plan for a set of migration files (name → SQL), in name order.
 * Throws a branded `DsqlMigrationValidationError` listing every finding, each
 * with the file name, the dsql-lint rule, its suggestion, and the doc page
 * checked. The SQL in the returned steps is the file's, statement by statement.
 */
export function buildMigrationPlan(migrations: Record<string, string>, options: BuildPlanOptions = {}): MigrationPlan {
	const validate = options.validate !== false;
	const errors: string[] = [];
	const files: FilePlan[] = [];
	for (const file of Object.keys(migrations).sort()) {
		const sql = migrations[file];
		if (validate) {
			for (const issue of findStatementIssues(sql)) {
				errors.push(`${file}: ${issue.message} Checked against ${issue.doc}`);
			}
		}
		files.push({ file, steps: splitStatements(sql).flatMap(sequenceStatement) });
	}
	if (errors.length > 0) {
		const err = new Error(
			`Migration validation failed for Aurora DSQL (cluster kind 'dsql'):\n  ${errors.join('\n  ')}`,
		);
		err.name = MIGRATION_VALIDATION_ERROR_NAME;
		throw brandBlocksError(err);
	}
	return { target: 'dsql', files };
}
