// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'node:crypto';
import { blocksError } from '@aws-blocks/core';
import { splitStatements } from '@aws-blocks/data-common';
import { type AsyncDdlTarget, asyncDdlTarget } from '../dialect/async-ddl.js';
import { ASYNC_DDL, findStatementIssues, inspectStatement } from '../dialect/validation.js';
import { DSQL_MIGRATION_VALIDATION_ERROR_NAME } from '../errors.js';

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

/** Checks every file with dsql-lint; one error lists every finding across every file. */
export function lintMigrationFiles(migrations: Record<string, string>): void {
	const errors: string[] = [];
	for (const file of Object.keys(migrations).sort()) {
		for (const issue of findStatementIssues(migrations[file])) {
			errors.push(`${file}: ${issue.message} Checked against ${issue.doc}`);
		}
	}
	if (errors.length > 0) {
		throw blocksError(
			DSQL_MIGRATION_VALIDATION_ERROR_NAME,
			`Migration validation failed for Aurora DSQL (cluster kind 'dsql'):\n  ${errors.join('\n  ')}`,
		);
	}
}

export function buildMigrationPlan(migrations: Record<string, string>): MigrationPlan {
	const files: FilePlan[] = Object.keys(migrations)
		.sort()
		.map((file) => ({
			file,
			hash: createHash('sha256').update(migrations[file]).digest('hex'),
			steps: splitStatements(migrations[file]).flatMap(sequenceStatement),
		}));
	return { files };
}
