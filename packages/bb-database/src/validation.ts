// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { brandBlocksError } from '@aws-blocks/core';
import { DOLLAR_QUOTE_TAG_RE } from '@aws-blocks/data-common';
import { TRANSACTION_ROW_LIMIT, TRANSACTION_SIZE_LIMIT_BYTES } from './constants.js';
import { formatDiagnostic, type LintDiagnostic, lintSql } from './dsql-lint.js';
import { DatabaseErrors, DSQL_VALIDATION_ERROR_NAME } from './errors.js';

const DOCS = 'https://docs.aws.amazon.com/aurora-dsql/latest/userguide';
const COMPAT_DOC = `${DOCS}/working-with-postgresql-compatibility.html`;
const DDL_DOC = `${DOCS}/working-with-ddl.html`;
const QUOTAS_DOC = `${DOCS}/CHAP_quotas.html`;

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

interface ValidationIssue {
	rule: string;
	message: string;
	doc: string;
}

function toIssue(d: LintDiagnostic): ValidationIssue {
	return { rule: d.rule, message: formatDiagnostic(d), doc: COMPAT_DOC };
}

const GRANT_ON_SCHEMA = /\bGRANT\b[^;]*\bON\s+SCHEMA\s+([^;]*?)\bTO\b/gi;

function grantsOnPublic(schemas: string): boolean {
	return schemas.split(',').some((s) => {
		const name = s.trim();
		return name.startsWith('"') ? name === '"public"' : name.toLowerCase() === 'public';
	});
}

export function findStatementIssues(sql: string): ValidationIssue[] {
	const issues = lintSql(sql).map(toIssue);
	// dsql-lint and PGlite both accept this, but DSQL rejects it at runtime:
	// `public` is a system entity, and custom roles can use it without a grant.
	for (const m of stripLiteralsAndComments(sql).matchAll(GRANT_ON_SCHEMA)) {
		if (grantsOnPublic(m[1])) {
			issues.push({
				rule: 'grant_on_public_schema',
				message:
					'grant_on_public_schema: DSQL rejects GRANT ON SCHEMA public (public is a system entity; roles can use it without a grant). Remove the statement.',
				doc: COMPAT_DOC,
			});
		}
	}
	return issues;
}

export function validateStatement(sql: string): void {
	const issues = findStatementIssues(sql);
	if (issues.length === 0) return;
	throw validationError(issues.map((i) => i.message).join(' '), issues[0].doc);
}

export function classifyStatement(sql: string): 'ddl' | 'dml' | 'other' {
	const cleaned = stripLiteralsAndComments(sql).trim();
	if (/^\s*(CREATE|ALTER|DROP)\b/i.test(cleaned)) return 'ddl';
	if (/^\s*(INSERT|UPDATE|DELETE|MERGE)\b/i.test(cleaned)) return 'dml';
	return 'other';
}

function transactionLimitError(detail: string): Error {
	const err = new Error(`${detail} Split the work into smaller transactions. (${QUOTAS_DOC})`);
	err.name = DatabaseErrors.TransactionRowLimitExceeded;
	return brandBlocksError(err);
}

export class TransactionTracker {
	private ddlCount = 0;
	private hasDml = false;
	private rowCount = 0;
	private bytes = 0;

	recordStatement(sql: string, params?: unknown[]): void {
		const type = classifyStatement(sql);
		if (type === 'ddl') {
			if (this.hasDml) throw validationError('DSQL does not allow DDL and DML in the same transaction.', DDL_DOC);
			this.ddlCount++;
			if (this.ddlCount > 1) throw validationError('DSQL allows only 1 DDL statement per transaction.', DDL_DOC);
		}
		if (type === 'dml') {
			if (this.ddlCount > 0)
				throw validationError('DSQL does not allow DDL and DML in the same transaction.', DDL_DOC);
			this.hasDml = true;
			this.recordBytes(sql, params);
		}
	}

	// An approximation: DSQL counts the data actually modified; locally the statement text and parameters
	// stand in for it.
	private recordBytes(sql: string, params?: unknown[]): void {
		this.bytes += Buffer.byteLength(sql);
		for (const p of params ?? []) {
			if (p === null || p === undefined) continue;
			this.bytes += Buffer.isBuffer(p)
				? p.length
				: Buffer.byteLength(typeof p === 'string' ? p : JSON.stringify(p));
		}
		if (this.bytes > TRANSACTION_SIZE_LIMIT_BYTES) {
			throw transactionLimitError(
				`DSQL limits a transaction to ${TRANSACTION_SIZE_LIMIT_BYTES / (1024 * 1024)} MiB of modified data. This one wrote about ${(this.bytes / (1024 * 1024)).toFixed(1)} MiB.`,
			);
		}
	}

	recordRowCount(count: number): void {
		this.rowCount += count;
		if (this.rowCount > TRANSACTION_ROW_LIMIT) {
			throw transactionLimitError(
				`DSQL limits transactions to ${TRANSACTION_ROW_LIMIT} mutated rows (cascades included). This one changed ${this.rowCount}.`,
			);
		}
	}

	reset(): void {
		this.ddlCount = 0;
		this.hasDml = false;
		this.rowCount = 0;
		this.bytes = 0;
	}
}

function validationError(message: string, doc: string): Error {
	const err = new Error(`${message} (${doc})`);
	err.name = DSQL_VALIDATION_ERROR_NAME;
	return brandBlocksError(err);
}
