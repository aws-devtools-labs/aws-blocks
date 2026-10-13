// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Aurora DSQL compatibility rules. They catch unsupported PostgreSQL features at
 * dev time on a `distributed` cluster, before they fail in production. Each
 * rule cites the DSQL doc page it was checked against and carries the examples
 * from that page; `validation.test.ts` runs every example, so the next
 * re-baseline against the DSQL release notes is a diff of this table.
 *
 * Baseline: the DSQL user guide as of 2026-10-11. Supported since the 2025 rule
 * set and therefore deliberately absent: foreign keys, views, sequences and
 * identity columns, JSONB, `DROP COLUMN`, and `ALTER DEFAULT PRIVILEGES`.
 * `SERIAL`, a synchronous `CREATE INDEX`, and `ADD CONSTRAINT` without
 * `NOT VALID` are also absent: the migration rewriter turns them into forms
 * DSQL accepts.
 *
 * @see https://docs.aws.amazon.com/aurora-dsql/latest/userguide/working-with-postgresql-compatibility.html
 */

import { brandBlocksError } from '@aws-blocks/core';
import { DOLLAR_QUOTE_TAG_RE, splitStatements } from '@aws-blocks/data-common';
import { TRANSACTION_ROW_LIMIT, TRANSACTION_SIZE_LIMIT_BYTES } from './constants.js';
import { DatabaseErrors, DSQL_VALIDATION_ERROR_NAME } from './errors.js';

const DOCS = 'https://docs.aws.amazon.com/aurora-dsql/latest/userguide';
export const COMPAT_DOC = `${DOCS}/working-with-postgresql-compatibility.html`;
export const TX_DOC = `${DOCS}/working-with-transactions.html`;
export const DDL_DOC = `${DOCS}/working-with-ddl.html`;
export const INDEX_DOC = `${DOCS}/working-with-create-index-async.html`;
export const ALTER_TABLE_DOC = `${DOCS}/alter-table-syntax-support.html`;
export const CREATE_SEQUENCE_DOC = `${DOCS}/create-sequence-syntax-support.html`;
export const QUOTAS_DOC = `${DOCS}/CHAP_quotas.html`;

/** One compatibility rule, with the examples its doc page gives. */
export interface ValidationRule {
	/** Matches the statement with literals and comments stripped. */
	pattern: RegExp;
	message: string;
	severity: 'error' | 'warn';
	doc: string;
	/** Statements the rule must flag (quoted or adapted from `doc`). */
	rejects: string[];
	/** Statements the rule must let through: the nearest supported form. */
	accepts: string[];
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

/** Rules a statement must pass on a `distributed` cluster. */
export const RULES: readonly ValidationRule[] = [
	{
		pattern: /\bCREATE\s+(OR\s+REPLACE\s+)?(CONSTRAINT\s+)?TRIGGER\b/i,
		message: 'DSQL does not support triggers. Do the work in the handler that writes the row.',
		severity: 'error',
		doc: COMPAT_DOC,
		rejects: ['CREATE TRIGGER t_audit AFTER INSERT ON t FOR EACH ROW EXECUTE FUNCTION audit()'],
		accepts: ['CREATE TABLE t (id TEXT PRIMARY KEY)'],
	},
	{
		pattern: /\bCREATE\s+(OR\s+REPLACE\s+)?(FUNCTION|PROCEDURE)\b[\s\S]*\bLANGUAGE\s+plpgsql\b/i,
		message: 'DSQL does not support PL/pgSQL. Move the logic into your handler.',
		severity: 'error',
		doc: COMPAT_DOC,
		rejects: ['CREATE FUNCTION f() RETURNS void AS $$ BEGIN END $$ LANGUAGE plpgsql'],
		accepts: ["CREATE FUNCTION f() RETURNS int AS 'SELECT 1' LANGUAGE sql"],
	},
	{
		pattern: /\bCREATE\s+(OR\s+REPLACE\s+)?(TEMP|TEMPORARY|MATERIALIZED)\s+VIEW\b/i,
		message: 'DSQL supports views, but not temporary or materialized ones. Use CREATE VIEW.',
		severity: 'error',
		doc: COMPAT_DOC,
		rejects: ['CREATE MATERIALIZED VIEW mv AS SELECT 1', 'CREATE TEMP VIEW tv AS SELECT 1'],
		accepts: ['CREATE VIEW v AS SELECT account_id, SUM(amount) AS total FROM items GROUP BY account_id'],
	},
	{
		pattern: /\bTRUNCATE\b/i,
		message: 'DSQL does not support TRUNCATE. Use DELETE FROM, in batches of at most 3,000 rows.',
		severity: 'error',
		doc: COMPAT_DOC,
		rejects: ['TRUNCATE t', 'TRUNCATE TABLE t'],
		accepts: ['DELETE FROM t WHERE id IN (SELECT id FROM t LIMIT 3000)'],
	},
	{
		pattern: /\b(LISTEN|NOTIFY)\b/i,
		message: 'DSQL does not support LISTEN/NOTIFY. Use the Realtime block for change notifications.',
		severity: 'error',
		doc: COMPAT_DOC,
		rejects: ['LISTEN changes', "NOTIFY changes, 'payload'"],
		accepts: ["INSERT INTO log (message) VALUES ('listen to this')"],
	},
	{
		pattern: /\bCREATE\s+EXTENSION\b/i,
		message: 'DSQL does not support CREATE EXTENSION. Vector search routes to the KnowledgeBase block.',
		severity: 'error',
		doc: COMPAT_DOC,
		rejects: ['CREATE EXTENSION IF NOT EXISTS vector'],
		accepts: ['CREATE TABLE embeddings (id TEXT PRIMARY KEY, vec DOUBLE PRECISION[])'],
	},
	{
		pattern:
			/\bALTER\s+TABLE\b[^;]*\bADD\s+(?!(?:GENERATED|CONSTRAINT|CHECK|FOREIGN|UNIQUE|PRIMARY|EXCLUDE)\b)(COLUMN\s+)?(IF\s+NOT\s+EXISTS\s+)?[\w"]+\s+[^,;]*\bDEFAULT\b/i,
		message:
			'DSQL does not support ADD COLUMN with DEFAULT. Add the column, then ALTER COLUMN … SET DEFAULT, then backfill.',
		severity: 'error',
		doc: ALTER_TABLE_DOC,
		rejects: [
			"ALTER TABLE t ADD COLUMN status TEXT DEFAULT 'active'",
			"ALTER TABLE t ADD status TEXT DEFAULT 'active'",
		],
		accepts: [
			'ALTER TABLE t ADD COLUMN status TEXT',
			"ALTER TABLE t ALTER COLUMN status SET DEFAULT 'active'",
			'ALTER TABLE t ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (CACHE 65536)',
		],
	},
	{
		pattern: /\bALTER\s+TABLE\b[^;]*\bALTER\s+(COLUMN\s+)?[\w"]+\s+SET\s+NOT\s+NULL\b/i,
		message:
			'DSQL does not support SET NOT NULL on an existing column. Create the column NOT NULL, or add a CHECK (col IS NOT NULL).',
		severity: 'error',
		doc: ALTER_TABLE_DOC,
		rejects: ['ALTER TABLE t ALTER COLUMN a SET NOT NULL'],
		accepts: [
			'ALTER TABLE t ALTER COLUMN a DROP NOT NULL',
			'ALTER TABLE t ADD CONSTRAINT a_set CHECK (a IS NOT NULL)',
		],
	},
	{
		pattern: /\bALTER\s+TABLE\b[^;]*\bALTER\s+(COLUMN\s+)?[\w"]+\s+(SET\s+DATA\s+)?TYPE\b/i,
		message: 'DSQL does not support ALTER COLUMN … TYPE. Add a new column, backfill it, and switch your queries.',
		severity: 'error',
		doc: ALTER_TABLE_DOC,
		rejects: ['ALTER TABLE t ALTER COLUMN a TYPE bigint', 'ALTER TABLE t ALTER a SET DATA TYPE text'],
		accepts: ['ALTER TABLE t ADD COLUMN a_big BIGINT'],
	},
	{
		pattern: /\bALTER\s+TABLE\b[^;]*\bADD\s+(CONSTRAINT\s+[\w"]+\s+)?PRIMARY\s+KEY\b/i,
		message: 'DSQL does not support adding a primary key to an existing table. Define it in CREATE TABLE.',
		severity: 'error',
		doc: ALTER_TABLE_DOC,
		rejects: ['ALTER TABLE t ADD PRIMARY KEY (id)', 'ALTER TABLE t ADD CONSTRAINT t_pk PRIMARY KEY (id)'],
		accepts: ['CREATE TABLE t (id TEXT PRIMARY KEY)'],
	},
	{
		pattern: /\bALTER\s+TABLE\b[^;]*\bADD\s+(CONSTRAINT\s+[\w"]+\s+)?UNIQUE\s*\(/i,
		message:
			'DSQL adds a unique constraint only from an existing index: CREATE UNIQUE INDEX ASYNC first, then ADD CONSTRAINT … UNIQUE USING INDEX.',
		severity: 'error',
		doc: ALTER_TABLE_DOC,
		rejects: ['ALTER TABLE t ADD CONSTRAINT t_email UNIQUE (email)', 'ALTER TABLE t ADD UNIQUE (email)'],
		accepts: [
			'CREATE UNIQUE INDEX t_email ON t (email)',
			'ALTER TABLE t ADD CONSTRAINT t_email UNIQUE USING INDEX t_email',
		],
	},
	{
		pattern: /\bALTER\s+TABLE\b[^;]*\bADD\s+(CHECK|FOREIGN\s+KEY)\b/i,
		message:
			'Name the constraint (ADD CONSTRAINT name CHECK … / FOREIGN KEY …). DSQL adds it NOT VALID and validates it by name in a separate job.',
		severity: 'error',
		doc: ALTER_TABLE_DOC,
		rejects: ['ALTER TABLE t ADD CHECK (a > 0)', 'ALTER TABLE t ADD FOREIGN KEY (b) REFERENCES b(id)'],
		accepts: [
			'ALTER TABLE t ADD CONSTRAINT a_pos CHECK (a > 0)',
			'ALTER TABLE t ADD CONSTRAINT t_b FOREIGN KEY (b) REFERENCES b(id)',
		],
	},
	{
		pattern: /\b(CREATE\s+POLICY|ENABLE\s+ROW\s+LEVEL\s+SECURITY|FORCE\s+ROW\s+LEVEL\s+SECURITY)\b/i,
		message:
			'DSQL does not support Row Level Security. Scope rows in the handler, by the user requireAuth() returns.',
		severity: 'error',
		doc: COMPAT_DOC,
		rejects: ['CREATE POLICY own ON t USING (owner = current_user)', 'ALTER TABLE t ENABLE ROW LEVEL SECURITY'],
		accepts: ['SELECT * FROM t WHERE owner = $1'],
	},
	{
		pattern: /\bCREATE\s+(GLOBAL\s+|LOCAL\s+)?(TEMP|TEMPORARY|UNLOGGED)\s+TABLE\b/i,
		message: 'DSQL does not support temporary or unlogged tables.',
		severity: 'error',
		doc: COMPAT_DOC,
		rejects: ['CREATE TEMP TABLE scratch (id INT)', 'CREATE TEMPORARY TABLE scratch (id INT)'],
		accepts: ['CREATE TABLE scratch (id INT PRIMARY KEY)'],
	},
	{
		pattern: /\bSET\s+TRANSACTION\s+ISOLATION\s+LEVEL\b/i,
		message: 'DSQL always uses Repeatable Read. Remove SET TRANSACTION ISOLATION LEVEL.',
		severity: 'error',
		doc: TX_DOC,
		rejects: ['SET TRANSACTION ISOLATION LEVEL SERIALIZABLE'],
		accepts: ['BEGIN'],
	},
	{
		pattern: /\b(SAVEPOINT|ROLLBACK\s+TO\s+SAVEPOINT|RELEASE\s+SAVEPOINT)\b/i,
		message: 'DSQL does not support SAVEPOINT. Split the work into separate transactions.',
		severity: 'error',
		doc: TX_DOC,
		rejects: ['SAVEPOINT sp1', 'ROLLBACK TO SAVEPOINT sp1'],
		accepts: ['ROLLBACK'],
	},
	{
		pattern: /\bCOLLATE\b/i,
		message: 'DSQL only supports the C collation. Remove the COLLATE clause.',
		severity: 'error',
		doc: COMPAT_DOC,
		rejects: ['CREATE TABLE t (name TEXT COLLATE "en_US")'],
		accepts: ['CREATE TABLE t (name TEXT)'],
	},
	{
		pattern: /\bCREATE\s+(UNIQUE\s+)?INDEX\b[^;]*\([^;)]*\b(ASC|DESC)\b/i,
		message: 'DSQL does not support sort order (ASC/DESC) on index keys. Order with ORDER BY in queries.',
		severity: 'error',
		doc: INDEX_DOC,
		rejects: ['CREATE INDEX t_created ON t (created_at DESC)'],
		accepts: ['CREATE INDEX t_created ON t (created_at)', 'CREATE INDEX t_lower ON t (lower(name))'],
	},
	{
		pattern: /\bCREATE\s+(UNIQUE\s+)?INDEX\b[^;]*\bUSING\s+(?!btree\b)\w+/i,
		message: 'DSQL supports only B-tree indexes (no GIN, GiST, hash). Remove the USING clause.',
		severity: 'error',
		doc: INDEX_DOC,
		rejects: ['CREATE INDEX t_tags ON t USING gin (tags)'],
		accepts: ['CREATE INDEX t_tags ON t (tags)', 'CREATE INDEX t_tags ON t USING btree (tags)'],
	},
	{
		pattern: /(@>|<@|\?\||\?&)/,
		message: 'JSONB containment operators (@>, <@, ?|, ?&) are not indexable on DSQL; they scan the table.',
		severity: 'warn',
		doc: COMPAT_DOC,
		rejects: ['SELECT * FROM t WHERE doc @> \'{"a": 1}\''],
		accepts: ["SELECT doc->>'a' FROM t"],
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
	throw validationError(issues[0].message, issues[0].doc);
}

/** Classify a statement as DDL, DML, or other. */
export function classifyStatement(sql: string): 'ddl' | 'dml' | 'other' {
	const cleaned = stripLiteralsAndComments(sql).trim();
	if (/^\s*(CREATE|ALTER|DROP)\b/i.test(cleaned)) return 'ddl';
	if (/^\s*(INSERT|UPDATE|DELETE|MERGE)\b/i.test(cleaned)) return 'dml';
	return 'other';
}

/** Build the branded `TransactionRowLimitExceeded` the mock raises for the row and size limits. */
export function transactionLimitError(detail: string): Error {
	const err = new Error(`${detail} Split the work into smaller transactions. (${QUOTAS_DOC})`);
	err.name = DatabaseErrors.TransactionRowLimitExceeded;
	return brandBlocksError(err);
}

/**
 * Mirror of the DSQL per-transaction limits for the local `distributed` mock:
 * one DDL statement, no DDL and DML together, 3,000 changed rows (cascades
 * included), and 10 MiB of data.
 */
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

	/** Approximate the data a DML statement writes by its text and parameter sizes. */
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

export { splitStatements };
