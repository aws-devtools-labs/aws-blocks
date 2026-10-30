// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { blocksError } from '@aws-blocks/core';
import { splitStatements } from '@aws-blocks/data-common';
import { ASYNC_DDL, findStatementIssues, inspectStatement } from '../dsql/validation.js';

export interface PlanStep {
	kind: 'statement' | 'wait-job';
	sql: string;
	transactional: boolean;
}

export interface FilePlan {
	file: string;
	steps: PlanStep[];
}

export interface MigrationPlan {
	files: FilePlan[];
}

const MIGRATION_VALIDATION_ERROR_NAME = 'DsqlMigrationValidationError';

// Never run as SQL: the runner polls `sys.jobs` for the job id the previous step returned; the text only
// labels the step in messages.
const waitJob = (): PlanStep => ({ kind: 'wait-job', sql: 'SELECT sys.wait_for_job($job)', transactional: false });

function sequenceStatement(statement: string): PlanStep[] {
	const { cleaned, kind } = inspectStatement(statement);
	// DSQL allows one DDL statement per transaction, so DDL runs alone; consecutive DML shares one.
	const step: PlanStep = { kind: 'statement', sql: statement, transactional: kind !== 'ddl' };
	return ASYNC_DDL.test(cleaned) ? [step, waitJob()] : [step];
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
			MIGRATION_VALIDATION_ERROR_NAME,
			`Migration validation failed for Aurora DSQL (cluster kind 'dsql'):\n  ${errors.join('\n  ')}`,
		);
	}
}

export function buildMigrationPlan(migrations: Record<string, string>): MigrationPlan {
	const files: FilePlan[] = Object.keys(migrations)
		.sort()
		.map((file) => ({ file, steps: splitStatements(migrations[file]).flatMap(sequenceStatement) }));
	return { files };
}
