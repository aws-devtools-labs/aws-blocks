// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'node:crypto';
import { blocksError } from '@aws-blocks/core';
import { splitStatements } from '@aws-blocks/data-common/core';
import { type AsyncDdlTarget, asyncDdlTarget } from '../dialect/async-ddl.js';
import { ASYNC_DDL, findStatementIssues, inspectStatement, stripLiteralsAndComments } from '../dialect/validation.js';
import { MIGRATION_VALIDATION_ERROR_NAME } from '../errors.js';
import type { ClusterType } from '../types.js';

export interface StatementStep {
	kind: 'statement';
	sql: string;
	transactional: boolean;
}

export interface WaitJobStep {
	kind: 'wait-job';
	sql: string;
	transactional: false;
	/** The `ASYNC` statement that started the job; a failed job is reported at it. */
	statement: StatementStep;
	/** The object that statement builds or validates; absent when the text is not a form the runner can verify. */
	target?: AsyncDdlTarget;
}

export type PlanStep = StatementStep | WaitJobStep;

export interface FilePlan {
	file: string;
	/** SHA-256 (hex) of the file text; the runner stores it with partial progress to detect a later edit. */
	hash: string;
	steps: PlanStep[];
}

export interface MigrationPlan {
	/** The cluster kind the steps were sequenced for. */
	kind: ClusterType;
	files: FilePlan[];
}

// Never run as SQL: the runner polls `sys.jobs` for the job id the previous step returned; the text only
// labels the step in messages.
function waitJob(statement: StatementStep, cleaned: string): WaitJobStep {
	const target = asyncDdlTarget(cleaned);
	return {
		kind: 'wait-job',
		sql: 'SELECT sys.wait_for_job($job)',
		transactional: false,
		statement,
		...(target ? { target } : {}),
	};
}

function sequenceStatement(statement: string): PlanStep[] {
	const { cleaned, kind } = inspectStatement(statement);
	// DSQL allows one DDL statement per transaction, so DDL runs alone; consecutive DML shares one.
	const step: StatementStep = { kind: 'statement', sql: statement, transactional: kind !== 'ddl' };
	return ASYNC_DDL.test(cleaned) ? [step, waitJob(step, cleaned)] : [step];
}

// The DSQL-only forms a file written for the other cluster kind carries. PostgreSQL would reject them with a
// bare syntax error; naming them here says what to change.
const DSQL_ONLY_FORMS: ReadonlyArray<{ test: RegExp; message: string }> = [
	{
		test: ASYNC_DDL,
		message:
			"`ASYNC` is Aurora DSQL syntax. This cluster is PostgreSQL: drop `ASYNC` (the index build or validation runs in the file's transaction).",
	},
	{
		test: /\bsys\.wait_for_job\s*\(/i,
		message:
			'`sys.wait_for_job()` is Aurora DSQL syntax. This cluster is PostgreSQL: remove the wait; there is no job to wait for.',
	},
];

// PostgreSQL refuses these inside a transaction block (SQLSTATE 25001), and an aurora file is one transaction.
// Named here so the file stops at construction and at synth, not at deploy with the bare driver error.
const NON_TRANSACTIONAL_FORMS: ReadonlyArray<{ test: RegExp; message: string }> = [
	{
		test: /\b(?:CREATE\s+(?:UNIQUE\s+)?INDEX|DROP\s+INDEX|REINDEX(?:\s+\([^)]*\))?(?:\s+\w+)?)\s+CONCURRENTLY\b/i,
		message:
			'`CONCURRENTLY` cannot run inside a transaction block, and each migration file on this cluster is one transaction. Drop `CONCURRENTLY`: a deploy accepts the brief lock.',
	},
	{
		test: /^\s*(?:VACUUM|CREATE\s+DATABASE|DROP\s+DATABASE|ALTER\s+SYSTEM|CREATE\s+TABLESPACE|DROP\s+TABLESPACE)\b/i,
		message:
			'This statement cannot run inside a transaction block, and each migration file on this cluster is one transaction. It is not schema: run it outside the deploy.',
	},
	{
		// An embedded COMMIT would end the runner's transaction, and a failure after it could not be rolled back.
		test: /^\s*(?:BEGIN|START\s+TRANSACTION|COMMIT|END|ROLLBACK|ABORT)\b/i,
		message:
			'Transaction control is not allowed in a migration file: each file on this cluster is already one transaction. Remove BEGIN, COMMIT, END and ROLLBACK.',
	},
];

function auroraIssues(sql: string): string[] {
	const issues: string[] = [];
	for (const statement of splitStatements(sql)) {
		const cleaned = stripLiteralsAndComments(statement);
		for (const form of [...DSQL_ONLY_FORMS, ...NON_TRANSACTIONAL_FORMS]) {
			if (form.test.test(cleaned)) issues.push(form.message);
		}
	}
	return issues;
}

/**
 * Checks every file against its cluster kind before anything runs; one error lists every finding across every
 * file. A `dsql` file goes through dsql-lint. An `aurora` file is PostgreSQL and is checked only for the DSQL-only
 * forms (`ASYNC`, `sys.wait_for_job`), which PostgreSQL would otherwise reject with a bare syntax error, and for the
 * statements PostgreSQL refuses inside a transaction block (`CONCURRENTLY`, `VACUUM`, …), since each file is one.
 */
export function lintMigrationFiles(migrations: Record<string, string>, kind: ClusterType): void {
	const errors: string[] = [];
	for (const file of Object.keys(migrations).sort()) {
		if (kind === 'dsql') {
			for (const issue of findStatementIssues(migrations[file])) {
				errors.push(`${file}: ${issue.message} Checked against ${issue.doc}`);
			}
		} else {
			for (const message of auroraIssues(migrations[file])) errors.push(`${file}: ${message}`);
		}
	}
	if (errors.length > 0) {
		const engine = kind === 'dsql' ? 'Aurora DSQL' : 'Aurora PostgreSQL';
		throw blocksError(
			MIGRATION_VALIDATION_ERROR_NAME,
			`Migration validation failed for ${engine} (cluster kind '${kind}'):\n  ${errors.join('\n  ')}`,
		);
	}
}

// PostgreSQL runs DDL inside a transaction, so a whole file is one transaction: it applies entirely or not at all,
// and a failure leaves nothing to resume.
const transactionalStatement = (sql: string): PlanStep[] => [{ kind: 'statement', sql, transactional: true }];

/**
 * The steps of each file for a cluster of `kind`: on `dsql`, DDL alone per transaction with a wait after each
 * `ASYNC` statement; on `aurora`, every statement of a file in one transaction.
 */
export function buildMigrationPlan(migrations: Record<string, string>, kind: ClusterType): MigrationPlan {
	const sequence = kind === 'dsql' ? sequenceStatement : transactionalStatement;
	const files: FilePlan[] = Object.keys(migrations)
		.sort()
		.map((file) => ({
			file,
			hash: createHash('sha256').update(migrations[file]).digest('hex'),
			steps: splitStatements(migrations[file]).flatMap(sequence),
		}));
	return { kind, files };
}
