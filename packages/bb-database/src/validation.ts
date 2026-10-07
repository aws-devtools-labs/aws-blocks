// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Aurora DSQL compatibility rules. They catch unsupported PostgreSQL features at dev
 * time on a `distributed` cluster, before they fail in production. Each rule
 * cites the DSQL doc page it was checked against.
 *
 * @see https://docs.aws.amazon.com/aurora-dsql/latest/userguide/working-with-postgresql-compatibility.html
 */

import { brandBlocksError } from '@aws-blocks/core';
import { DOLLAR_QUOTE_TAG_RE, splitStatements } from '@aws-blocks/data-common';
import { TRANSACTION_ROW_LIMIT } from './constants.js';
import { DatabaseErrors, DSQL_VALIDATION_ERROR_NAME } from './errors.js';

const COMPAT_DOC =
	'https://docs.aws.amazon.com/aurora-dsql/latest/userguide/working-with-postgresql-compatibility.html';
const TX_DOC = 'https://docs.aws.amazon.com/aurora-dsql/latest/userguide/working-with-transactions.html';
const DDL_DOC = 'https://docs.aws.amazon.com/aurora-dsql/latest/userguide/working-with-create-index-async.html';

interface ValidationRule {
	pattern: RegExp;
	message: string;
	severity: 'error' | 'warn';
	doc: string;
}

/** Strip string literals and comments to avoid false positives. */
export function stripLiteralsAndComments(sql: string): string {
	let result = '';
	let i = 0;
	while (i < sql.length) {
		if (sql[i] === '-' && sql[i + 1] === '-') {
			const nl = sql.indexOf('\n', i);
			i = nl === -1 ? sql.length : nl + 1;
			continue;
		}
		if (sql[i] === '/' && sql[i + 1] === '*') {
			const end = sql.indexOf('*/', i + 2);
			i = end === -1 ? sql.length : end + 2;
			continue;
		}
		if (sql[i] === "'") {
			i++;
			while (i < sql.length) {
				if (sql[i] === "'" && sql[i + 1] === "'") {
					i += 2;
				} else if (sql[i] === "'") {
					i++;
					break;
				} else {
					i++;
				}
			}
			result += "'__LITERAL__'";
			continue;
		}
		if (sql[i] === '$') {
			const m = sql.slice(i).match(DOLLAR_QUOTE_TAG_RE);
			if (m) {
				const tag = m[0];
				const close = sql.indexOf(tag, i + tag.length);
				i = close === -1 ? sql.length : close + tag.length;
				result += "'__LITERAL__'";
				continue;
			}
		}
		result += sql[i];
		i++;
	}
	return result;
}

/**
 * Rules a statement must pass on a `distributed` cluster. `SERIAL`/`BIGSERIAL`
 * and a synchronous `CREATE INDEX` are deliberately absent: the migration
 * rewriter turns them into forms DSQL accepts.
 */
const RULES: ValidationRule[] = [
	{
		pattern: /\b(FOREIGN\s+KEY|REFERENCES)\b/i,
		message: "Foreign keys need a 'provisioned' cluster. DSQL does not support them.",
		severity: 'error',
		doc: COMPAT_DOC,
	},
	{
		pattern: /\bCREATE\s+(OR\s+REPLACE\s+)?TRIGGER\b/i,
		message: "Triggers need a 'provisioned' cluster. DSQL does not support them.",
		severity: 'error',
		doc: COMPAT_DOC,
	},
	{
		pattern: /\bCREATE\s+(OR\s+REPLACE\s+)?(MATERIALIZED\s+)?VIEW\b/i,
		message: "Views need a 'provisioned' cluster. DSQL does not support them.",
		severity: 'error',
		doc: COMPAT_DOC,
	},
	{
		pattern: /\bCREATE\s+(OR\s+REPLACE\s+)?FUNCTION\b[\s\S]*\bLANGUAGE\s+plpgsql\b/i,
		message: "PL/pgSQL needs a 'provisioned' cluster. DSQL does not support it.",
		severity: 'error',
		doc: COMPAT_DOC,
	},
	{
		pattern: /\bCREATE\s+SEQUENCE\b/i,
		message: 'DSQL does not support CREATE SEQUENCE. Use an identity column or a UUID.',
		severity: 'error',
		doc: COMPAT_DOC,
	},
	{
		pattern: /\bTRUNCATE\b/i,
		message: 'DSQL does not support TRUNCATE. Use DELETE FROM.',
		severity: 'error',
		doc: COMPAT_DOC,
	},
	{
		pattern: /\b(LISTEN|NOTIFY)\b/i,
		message: 'DSQL does not support LISTEN/NOTIFY.',
		severity: 'error',
		doc: COMPAT_DOC,
	},
	{
		pattern: /\bCREATE\s+EXTENSION\b/i,
		message: "Extensions need a 'provisioned' cluster. DSQL does not support CREATE EXTENSION.",
		severity: 'error',
		doc: COMPAT_DOC,
	},
	{
		pattern: /\bALTER\s+TABLE\b[\s\S]*\bADD\s+COLUMN\b[\s\S]*\bDEFAULT\b/i,
		message: 'DSQL does not support ADD COLUMN with DEFAULT. Add the column, then backfill.',
		severity: 'error',
		doc: COMPAT_DOC,
	},
	{
		pattern:
			/\bALTER\s+TABLE\b[^;]*\bDROP\s+(?:COLUMN\b|IF\s+EXISTS\b|(?!(?:DEFAULT|NOT|EXPRESSION|IDENTITY|CONSTRAINT)\b)[\w"])/i,
		message:
			'DSQL does not support ALTER TABLE DROP COLUMN. Leave the column in place and stop referencing it, or rebuild the table.',
		severity: 'error',
		doc: COMPAT_DOC,
	},
	{
		pattern: /\bALTER\s+TABLE\b[^;]*\bALTER\s+(?:COLUMN\s+)?[\w"]+\s+SET\s+NOT\s+NULL\b/i,
		message:
			'DSQL does not support SET NOT NULL on an existing column. Rewrite as add column, backfill, then constrain.',
		severity: 'error',
		doc: COMPAT_DOC,
	},
	{
		pattern: /\bALTER\s+DEFAULT\s+PRIVILEGES\b/i,
		message: 'DSQL does not support ALTER DEFAULT PRIVILEGES.',
		severity: 'error',
		doc: COMPAT_DOC,
	},
	{
		pattern: /\b(CREATE\s+POLICY|ENABLE\s+ROW\s+LEVEL\s+SECURITY)\b/i,
		message: "Row Level Security needs a 'provisioned' cluster. DSQL does not support it.",
		severity: 'error',
		doc: COMPAT_DOC,
	},
	{
		pattern: /\bCREATE\s+(TEMP|TEMPORARY)\s+TABLE\b/i,
		message: 'DSQL does not support temporary tables.',
		severity: 'error',
		doc: COMPAT_DOC,
	},
	{
		pattern: /\bSET\s+TRANSACTION\s+ISOLATION\s+LEVEL\b/i,
		message: 'DSQL always uses Repeatable Read. Remove SET TRANSACTION ISOLATION LEVEL.',
		severity: 'error',
		doc: TX_DOC,
	},
	{
		pattern: /\bCOLLATE\b/i,
		message: 'DSQL only supports the C collation. Remove the COLLATE clause.',
		severity: 'error',
		doc: COMPAT_DOC,
	},
	{
		pattern: /(?<!::)\bJSONB\b/i,
		message: 'DSQL does not support JSONB columns. Use JSON (JSONB is available as a runtime cast via ::jsonb).',
		severity: 'error',
		doc: COMPAT_DOC,
	},
	{
		pattern: /(@>|<@|\?\||\?&)/,
		message: 'JSONB operators lack GIN index acceleration in DSQL.',
		severity: 'warn',
		doc: COMPAT_DOC,
	},
	{
		pattern: /\bCREATE\s+(?:UNIQUE\s+)?INDEX\b[^;]*\b(?:ASC|DESC)\b/i,
		message: 'DSQL does not support sort order (ASC/DESC) on index keys; order with ORDER BY in queries.',
		severity: 'error',
		doc: DDL_DOC,
	},
];

/** A rule violation, with the doc page it was checked against. */
export interface ValidationIssue {
	message: string;
	doc: string;
}

/** Collect the error-severity rules a statement violates on a `distributed` cluster. */
export function findStatementIssues(sql: string): ValidationIssue[] {
	const cleaned = stripLiteralsAndComments(sql);
	const issues: ValidationIssue[] = [];
	for (const rule of RULES) {
		if (!rule.pattern.test(cleaned)) continue;
		if (rule.severity === 'error') issues.push({ message: rule.message, doc: rule.doc });
		else console.warn(`[bb-database] ${rule.message} (${rule.doc})`);
	}
	return issues;
}

/** Validate a SQL statement for `distributed` compatibility. Throws a branded `DsqlValidationError`. */
export function validateStatement(sql: string): void {
	const issues = findStatementIssues(sql);
	if (issues.length === 0) return;
	const err = new Error(`${issues[0].message} Checked against ${issues[0].doc}`);
	err.name = DSQL_VALIDATION_ERROR_NAME;
	throw brandBlocksError(err);
}

/** Classify a statement as DDL, DML, or other. */
export function classifyStatement(sql: string): 'ddl' | 'dml' | 'other' {
	const cleaned = stripLiteralsAndComments(sql).trim();
	if (/^\s*(CREATE|ALTER|DROP)\b/i.test(cleaned)) return 'ddl';
	if (/^\s*(INSERT|UPDATE|DELETE|MERGE)\b/i.test(cleaned)) return 'dml';
	return 'other';
}

/** Mirror of the DSQL per-transaction limits for the local `distributed` mock. */
export class TransactionTracker {
	private ddlCount = 0;
	private hasDml = false;
	private rowCount = 0;

	recordStatement(sql: string): void {
		const type = classifyStatement(sql);
		if (type === 'ddl') {
			if (this.hasDml) throw validationError('DSQL does not allow DDL and DML in the same transaction.', TX_DOC);
			this.ddlCount++;
			if (this.ddlCount > 1) throw validationError('DSQL allows only 1 DDL statement per transaction.', TX_DOC);
		}
		if (type === 'dml') {
			if (this.ddlCount > 0)
				throw validationError('DSQL does not allow DDL and DML in the same transaction.', TX_DOC);
			this.hasDml = true;
		}
	}

	recordRowCount(count: number): void {
		this.rowCount += count;
		if (this.rowCount > TRANSACTION_ROW_LIMIT) {
			const err = new Error(
				`DSQL limits transactions to ${TRANSACTION_ROW_LIMIT} mutated rows. This one changed ${this.rowCount}. Split the work into smaller transactions. (${TX_DOC})`,
			);
			err.name = DatabaseErrors.TransactionRowLimitExceeded;
			throw brandBlocksError(err);
		}
	}

	reset(): void {
		this.ddlCount = 0;
		this.hasDml = false;
		this.rowCount = 0;
	}
}

function validationError(message: string, doc: string): Error {
	const err = new Error(`${message} (${doc})`);
	err.name = DSQL_VALIDATION_ERROR_NAME;
	return brandBlocksError(err);
}

export { splitStatements };
