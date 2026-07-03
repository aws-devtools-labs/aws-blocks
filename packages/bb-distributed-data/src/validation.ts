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

// --- Statement validation ---

interface ValidationRule {
  pattern: RegExp;
  message: string;
  severity: 'error' | 'warn';
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

const RULES: ValidationRule[] = [
  // Source: https://docs.aws.amazon.com/aurora-dsql/latest/userguide/working-with-postgresql-compatibility.html
  { pattern: /\b(FOREIGN\s+KEY|REFERENCES)\b/i, message: 'DSQL does not support foreign key constraints.', severity: 'error' },
  { pattern: /\bCREATE\s+TRIGGER\b/i, message: 'DSQL does not support triggers.', severity: 'error' },
  { pattern: /\bCREATE\s+(OR\s+REPLACE\s+)?VIEW\b/i, message: 'DSQL does not support views.', severity: 'error' },
  { pattern: /\bCREATE\s+(OR\s+REPLACE\s+)?FUNCTION\b[\s\S]*\bLANGUAGE\s+plpgsql\b/i, message: 'DSQL does not support PL/pgSQL.', severity: 'error' },
  { pattern: /\bCREATE\s+SEQUENCE\b|\b(SERIAL|BIGSERIAL)\b/i, message: 'DSQL does not support sequences. Use UUIDs.', severity: 'error' },
  { pattern: /\bTRUNCATE\b/i, message: 'DSQL does not support TRUNCATE. Use DELETE FROM.', severity: 'error' },
  { pattern: /\b(LISTEN|NOTIFY)\b/i, message: 'DSQL does not support LISTEN/NOTIFY.', severity: 'error' },
  { pattern: /\bCREATE\s+EXTENSION\b/i, message: 'DSQL does not support extensions.', severity: 'error' },
  { pattern: /\bALTER\s+TABLE\b[\s\S]*\bADD\s+COLUMN\b[\s\S]*\bDEFAULT\b/i, message: 'DSQL does not support ADD COLUMN with DEFAULT.', severity: 'error' },
  { pattern: /\bALTER\s+DEFAULT\s+PRIVILEGES\b/i, message: 'DSQL does not support ALTER DEFAULT PRIVILEGES.', severity: 'error' },
  { pattern: /\b(CREATE\s+POLICY|ENABLE\s+ROW\s+LEVEL\s+SECURITY)\b/i, message: 'DSQL does not support Row Level Security.', severity: 'error' },
  { pattern: /\bCREATE\s+(TEMP|TEMPORARY)\s+TABLE\b/i, message: 'DSQL does not support temporary tables.', severity: 'error' },
  { pattern: /\bSET\s+TRANSACTION\s+ISOLATION\s+LEVEL\b/i, message: 'DSQL uses fixed Repeatable Read isolation.', severity: 'error' },
  { pattern: /\bCOLLATE\b/i, message: 'DSQL only supports C collation.', severity: 'error' },
  { pattern: /(?<!::)\bJSONB\b/i, message: 'DSQL does not support JSONB columns. Use JSON instead (JSONB is available as a query runtime cast via ::jsonb).', severity: 'error' },
  { pattern: /(@>|<@|\?\||\?&)/, message: 'JSONB operators lack GIN index acceleration in DSQL.', severity: 'warn' },
  { pattern: /\bCREATE\s+(?:UNIQUE\s+)?INDEX\b[\s\S]*\b(?:ASC|DESC|NULLS\s+(?:FIRST|LAST))\b/i, message: 'DSQL does not support sort order (ASC/DESC/NULLS FIRST/LAST) on index keys. Remove it — ordering is enforced by ORDER BY in queries. (DSQL: "specifying sort order not supported for index keys")', severity: 'error' },
];

/** Validate a SQL statement for DSQL compatibility. Throws on unsupported features. */
export function validateStatement(sql: string): void {
  const cleaned = stripLiteralsAndComments(sql);
  for (const rule of RULES) {
    if (rule.pattern.test(cleaned)) {
      if (rule.severity === 'error') {
        const err = new Error(rule.message);
        err.name = 'DsqlValidationError';
        throw err;
      }
      console.warn(`[bb-distributed-data] ${rule.message}`);
    }
  }
  if (/\bCREATE\s+(UNIQUE\s+)?INDEX\b/i.test(cleaned) && !/\bASYNC\b/i.test(cleaned)) {
    console.warn('[bb-distributed-data] Consider using CREATE INDEX ASYNC for non-blocking index creation.');
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
