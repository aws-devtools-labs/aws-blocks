// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { blocksError } from '@aws-blocks/core';
import { DOLLAR_QUOTE_TAG_RE } from '@aws-blocks/data-common';
import { TRANSACTION_ROW_LIMIT, TRANSACTION_SIZE_LIMIT_BYTES } from './constants.js';
import { formatDiagnostic, type LintDiagnostic, lintSql } from './dsql-lint.js';
import { DatabaseErrors, DSQL_VALIDATION_ERROR_NAME } from './errors.js';

const DOCS = 'https://docs.aws.amazon.com/aurora-dsql/latest/userguide';
const COMPAT_DOC = `${DOCS}/working-with-postgresql-compatibility.html`;
const QUOTAS_DOC = `${DOCS}/CHAP_quotas.html`;

// DSQL's asynchronous DDL: `CREATE [UNIQUE] INDEX ASYNC` and `ALTER TABLE ASYNC … VALIDATE CONSTRAINT`
// (the only ALTER TABLE form that takes ASYNC). Each returns a job id instead of finishing in the statement.
// Group 1 is the statement without ASYNC, so `replace(ASYNC_DDL, '$1')` is the synchronous spelling.
export const ASYNC_DDL = /^(\s*(?:CREATE\s+(?:UNIQUE\s+)?INDEX|ALTER\s+TABLE))\s+ASYNC\b/i;

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

export type StatementKind = 'ddl' | 'dml' | 'other';

export interface StatementInfo {
	/** The statement with comments removed and every literal replaced, for keyword matching. */
	cleaned: string;
	kind: StatementKind;
}

export function inspectStatement(sql: string): StatementInfo {
	const cleaned = stripLiteralsAndComments(sql);
	let kind: StatementKind = 'other';
	if (/^\s*(CREATE|ALTER|DROP)\b/i.test(cleaned)) kind = 'ddl';
	else if (/^\s*(INSERT|UPDATE|DELETE|MERGE)\b/i.test(cleaned)) kind = 'dml';
	return { cleaned, kind };
}

export function classifyStatement(sql: string): StatementKind {
	return inspectStatement(sql).kind;
}

function transactionLimitError(detail: string): Error {
	return blocksError(
		DatabaseErrors.TransactionRowLimitExceeded,
		`${detail} Split the work into smaller transactions. (${QUOTAS_DOC})`,
	);
}

// Only the per-transaction data limits: DDL never reaches a tracker (the mock refuses it outside a
// migration, and the migration runner runs DDL outside any transaction).
export class TransactionTracker {
	private rowCount = 0;
	private bytes = 0;

	recordStatement(kind: StatementKind, sql: string, params?: unknown[]): void {
		if (kind === 'dml') this.recordBytes(sql, params);
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
		this.rowCount = 0;
		this.bytes = 0;
	}
}

function validationError(message: string, doc: string): Error {
	return blocksError(DSQL_VALIDATION_ERROR_NAME, `${message} (${doc})`);
}
