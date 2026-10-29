// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { brandBlocksError } from '@aws-blocks/core';
import { splitStatements } from '@aws-blocks/data-common';
import type { ClusterType } from '../types.js';
import { classifyStatement, findStatementIssues, stripLiteralsAndComments } from '../validation.js';

export interface PlanStep {
	kind: 'statement' | 'validate-constraint' | 'wait-job';
	sql: string;
	transactional: boolean;
}

export interface FilePlan {
	file: string;
	steps: PlanStep[];
}

export interface MigrationPlan {
	target: ClusterType;
	files: FilePlan[];
}

const MIGRATION_VALIDATION_ERROR_NAME = 'DsqlMigrationValidationError';

const CREATE_INDEX_ASYNC = /^\s*CREATE\s+(?:UNIQUE\s+)?INDEX\s+ASYNC\b/i;
const ALTER_TABLE_ASYNC_VALIDATE = /^\s*ALTER\s+TABLE\s+ASYNC\b[\s\S]*\bVALIDATE\s+CONSTRAINT\b/i;

// Never run as SQL: the runner polls `sys.jobs` for the job id the previous step returned; the text only
// labels the step in messages.
const waitJob = (): PlanStep => ({ kind: 'wait-job', sql: 'SELECT sys.wait_for_job($job)', transactional: false });

function sequenceStatement(statement: string): PlanStep[] {
	const cleaned = stripLiteralsAndComments(statement);
	if (CREATE_INDEX_ASYNC.test(cleaned)) {
		return [{ kind: 'statement', sql: statement, transactional: false }, waitJob()];
	}
	if (ALTER_TABLE_ASYNC_VALIDATE.test(cleaned)) {
		return [{ kind: 'validate-constraint', sql: statement, transactional: false }, waitJob()];
	}
	// DSQL allows one DDL statement per transaction, so DDL runs alone; consecutive DML shares one.
	return [{ kind: 'statement', sql: statement, transactional: classifyStatement(statement) !== 'ddl' }];
}

interface BuildPlanOptions {
	validate?: boolean;
}

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
