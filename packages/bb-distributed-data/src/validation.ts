// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * DSQL SQL validation — catches unsupported PostgreSQL features at dev time.
 *
 * Source of truth for DSQL limitations:
 * @see https://docs.aws.amazon.com/aurora-dsql/latest/userguide/working-with-postgresql-compatibility.html
 */

import { TRANSACTION_ROW_LIMIT } from './errors.js';
import { splitStatements, DOLLAR_QUOTE_TAG_RE } from '@aws-blocks/data-common';
import { runDsqlLint } from './dsql-lint.js';

function isKnownDsqlLintFalsePositive(rule: string, statement: string): boolean {
  if (rule === 'index_expression' || rule === 'at_unsupported_drop_constraint') return true;
  return rule === 'parse_error'
    && /^\s*ALTER\s+TABLE\b[\s\S]*\bALTER\s+(?:COLUMN\s+)?(?:[\w.]+|"[^"]+")\s+DROP\s+(?:IDENTITY|EXPRESSION)(?:\s+IF\s+EXISTS)?\s*;?\s*$/i.test(statement);
}

/** Strip string literals and comments to avoid false positives. */
export function stripLiteralsAndComments(sql: string): string {
  let result = '';
  let i = 0;
  while (i < sql.length) {
    // Line comment
    if (sql[i] === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i);
      i = nl === -1 ? sql.length : nl + 1;
      continue;
    }
    // Block comment
    if (sql[i] === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? sql.length : end + 2;
      continue;
    }
    // Single-quoted string
    if (sql[i] === "'") {
      i++;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") { i += 2; }
        else if (sql[i] === "'") { i++; break; }
        else { i++; }
      }
      result += "'__LITERAL__'";
      continue;
    }
    // Dollar-quoted string. A valid opening tag is `$$` or `$tag$` where the tag
    // starts with a letter/underscore (Postgres identifier rules). Positional bind
    // parameters like `$1`, `$2`, `$10` are NOT dollar-quote tags — they must be
    // left intact so later validation rules can inspect the rest of the statement.
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

/** Validate a SQL statement for DSQL compatibility. Throws on unsupported features. */
export function validateStatement(sql: string): void {
  const cleaned = stripLiteralsAndComments(sql);
  if (/\bCREATE\s+(?:UNIQUE\s+)?INDEX\b[^;]*\b(?:ASC|DESC)\b/i.test(cleaned)) {
    throw Object.assign(
      new Error('DSQL does not support sort order (ASC/DESC) on index keys. Remove it; use ORDER BY in queries.'),
      { name: 'DsqlValidationError' },
    );
  }
  if (/\bCOLLATE\b/i.test(cleaned)) {
    throw Object.assign(new Error('DSQL only supports C collation.'), { name: 'DsqlValidationError' });
  }

  const file = runDsqlLint(sql).files[0];
  if (file.error) {
    throw Object.assign(new Error(`dsql-lint failed: ${file.error}`), { name: 'DsqlValidationError' });
  }
  const diagnostics = file.diagnostics.filter(
    diagnostic => !isKnownDsqlLintFalsePositive(
      diagnostic.rule,
      stripLiteralsAndComments(diagnostic.statement_preview),
    ),
  );
  if (diagnostics.length > 0) {
    const message = diagnostics
      .map(diagnostic => `${diagnostic.message} ${diagnostic.suggestion}`)
      .join('\n');
    throw Object.assign(new Error(message), { name: 'DsqlValidationError' });
  }
}

/** Classify a statement as DDL, DML, or other. */
export function classifyStatement(sql: string): 'ddl' | 'dml' | 'other' {
  const cleaned = stripLiteralsAndComments(sql).trim();
  if (/^\s*(CREATE|ALTER|DROP)\b/i.test(cleaned)) return 'ddl';
  if (/^\s*(INSERT|UPDATE|DELETE|MERGE)\b/i.test(cleaned)) return 'dml';
  return 'other';
}

// --- Transaction tracking ---

export class TransactionTracker {
  private ddlCount = 0;
  private hasDml = false;
  private rowCount = 0;

  recordStatement(sql: string): void {
    const type = classifyStatement(sql);
    if (type === 'ddl') {
      if (this.hasDml) { throw Object.assign(new Error('DSQL does not allow DDL and DML in the same transaction.'), { name: 'DsqlValidationError' }); }
      this.ddlCount++;
      if (this.ddlCount > 1) { throw Object.assign(new Error('DSQL allows only 1 DDL statement per transaction.'), { name: 'DsqlValidationError' }); }
    }
    if (type === 'dml') {
      if (this.ddlCount > 0) { throw Object.assign(new Error('DSQL does not allow DDL and DML in the same transaction.'), { name: 'DsqlValidationError' }); }
      this.hasDml = true;
    }
  }

  recordRowCount(count: number): void {
    this.rowCount += count;
    if (this.rowCount > TRANSACTION_ROW_LIMIT) {
      throw Object.assign(
        new Error(`DSQL limits transactions to ${TRANSACTION_ROW_LIMIT} mutated rows. Current: ${this.rowCount}.`),
        { name: 'TransactionRowLimitExceededException' }
      );
    }
  }

  reset(): void { this.ddlCount = 0; this.hasDml = false; this.rowCount = 0; }
}

// --- Migration validation ---

export function validateMigrations(migrations: Record<string, string>): void {
  const errors: string[] = [];
  for (const [file, content] of Object.entries(migrations).sort(([a], [b]) => a.localeCompare(b))) {
    const stmts = splitStatements(content);
    let ddl = 0, dml = false;
    for (const s of stmts) {
      try { validateStatement(s); } catch (e: any) { errors.push(`${file}: ${e.message}`); }
      const t = classifyStatement(s);
      if (t === 'ddl') ddl++;
      if (t === 'dml') dml = true;
    }
    if (ddl > 1) errors.push(`${file}: DSQL allows 1 DDL per migration file.`);
    if (ddl > 0 && dml) errors.push(`${file}: Cannot mix DDL and DML in one migration.`);
  }
  if (errors.length > 0) {
    throw Object.assign(new Error(`Migration validation failed:\n  ${errors.join('\n  ')}`), { name: 'DsqlMigrationValidationError' });
  }
}

export { splitStatements };
