// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The migration rewriter: turns ordinary PostgreSQL migration files into a
 * plan the target cluster accepts. On a `distributed` cluster it rewrites what
 * DSQL needs rewritten (identity columns and sequences to `bigint` with a
 * cache, `CREATE INDEX` to `ASYNC` plus a job wait, `ADD CONSTRAINT` to
 * `NOT VALID` plus an asynchronous validation, one DDL statement per
 * transaction), then runs the rewritten SQL through AWS's `dsql-lint` and
 * rejects, naming the file and the rule, what DSQL still cannot run. Other
 * kinds run the files as written, minus `ASYNC`.
 */
import { brandBlocksError } from '@aws-blocks/core';
import { DOLLAR_QUOTE_TAG_RE, splitStatements } from '@aws-blocks/data-common';
import { DSQL_IDENTITY_CACHE } from '../constants.js';
import type { ClusterKind, FilePlan, MigrationPlan, PlanStep } from '../types.js';
import { ALTER_TABLE_DOC, classifyStatement, findStatementIssues, stripLiteralsAndComments } from '../validation.js';

/** Error name for a migration directory the target cluster cannot run. */
export const MIGRATION_VALIDATION_ERROR_NAME = 'DsqlMigrationValidationError';

interface Segment {
	text: string;
	literal: boolean;
}

/**
 * Split SQL into literal (quoted / dollar-quoted / comment) and code segments so
 * rewrites never touch literals. `stripLiteralsAndComments` in validation.ts
 * drops them for matching; this keeps them so the output is still the user's SQL.
 */
function segments(sql: string): Segment[] {
	const out: Segment[] = [];
	let code = '';
	let i = 0;
	const flushCode = () => {
		if (code) out.push({ text: code, literal: false });
		code = '';
	};
	while (i < sql.length) {
		if (sql[i] === '-' && sql[i + 1] === '-') {
			const nl = sql.indexOf('\n', i);
			const end = nl === -1 ? sql.length : nl + 1;
			flushCode();
			out.push({ text: sql.slice(i, end), literal: true });
			i = end;
			continue;
		}
		if (sql[i] === '/' && sql[i + 1] === '*') {
			const close = sql.indexOf('*/', i + 2);
			const end = close === -1 ? sql.length : close + 2;
			flushCode();
			out.push({ text: sql.slice(i, end), literal: true });
			i = end;
			continue;
		}
		if (sql[i] === "'") {
			let j = i + 1;
			while (j < sql.length) {
				if (sql[j] === "'" && sql[j + 1] === "'") j += 2;
				else if (sql[j] === "'") {
					j++;
					break;
				} else j++;
			}
			flushCode();
			out.push({ text: sql.slice(i, j), literal: true });
			i = j;
			continue;
		}
		if (sql[i] === '$') {
			const m = sql.slice(i).match(DOLLAR_QUOTE_TAG_RE);
			if (m) {
				const tag = m[0];
				const close = sql.indexOf(tag, i + tag.length);
				const end = close === -1 ? sql.length : close + tag.length;
				flushCode();
				out.push({ text: sql.slice(i, end), literal: true });
				i = end;
				continue;
			}
		}
		code += sql[i];
		i++;
	}
	flushCode();
	return out;
}

/** Apply a regex replacement to the non-literal parts of a statement only. */
export function replaceOutsideLiterals(
	sql: string,
	pattern: RegExp,
	replacement: string | ((substring: string, ...args: string[]) => string),
): string {
	return segments(sql)
		.map((s) =>
			s.literal
				? s.text
				: typeof replacement === 'string'
					? s.text.replace(pattern, replacement)
					: s.text.replace(pattern, replacement),
		)
		.join('');
}

/** Normalize an identifier for comparison: unquote, drop the schema, lowercase. */
function identName(raw: string): string {
	const last = raw.split('.').pop() ?? raw;
	return last.startsWith('"') ? last.slice(1, -1).replace(/""/g, '"') : last.toLowerCase();
}

/** Split a parenthesized list on top-level commas. */
function splitTopLevel(body: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let current = '';
	for (const ch of body) {
		if (ch === '(') depth++;
		if (ch === ')') depth--;
		if (ch === ',' && depth === 0) {
			parts.push(current);
			current = '';
			continue;
		}
		current += ch;
	}
	if (current.trim()) parts.push(current);
	return parts.map((p) => p.trim());
}

const CREATE_TABLE =
	/^\s*CREATE\s+(?:UNLOGGED\s+|TEMP(?:ORARY)?\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?((?:"[^"]+"|[\w.])+)\s*\(([\s\S]*)\)\s*$/i;
const IDENT = /^\s*((?:"[^"]+"|\w+))/;

/** The primary-key columns a `CREATE TABLE` statement declares, keyed by table name. */
export function primaryKeyColumns(statement: string): { table: string; columns: string[] } | undefined {
	const m = CREATE_TABLE.exec(stripLiteralsAndComments(statement));
	if (!m) return undefined;
	const columns: string[] = [];
	for (const item of splitTopLevel(m[2])) {
		const tableLevel = /^\s*(?:CONSTRAINT\s+(?:"[^"]+"|\w+)\s+)?PRIMARY\s+KEY\s*\(([^)]*)\)/i.exec(item);
		if (tableLevel) {
			for (const col of tableLevel[1].split(',')) columns.push(identName(col.trim()));
			continue;
		}
		if (/\bPRIMARY\s+KEY\b/i.test(item) && !/^\s*(CONSTRAINT|UNIQUE|CHECK|FOREIGN|EXCLUDE)\b/i.test(item)) {
			const col = IDENT.exec(item);
			if (col) columns.push(identName(col[1]));
		}
	}
	return { table: identName(m[1]), columns };
}

const DROP_COLUMN =
	/^\s*ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?((?:"[^"]+"|[\w.])+)\b[\s\S]*\bDROP\s+(?:COLUMN\s+)?(?:IF\s+EXISTS\s+)?((?:"[^"]+"|\w+))/i;

/** The `(table, column)` an `ALTER TABLE … DROP COLUMN` statement drops. */
export function droppedColumn(statement: string): { table: string; column: string } | undefined {
	const cleaned = stripLiteralsAndComments(statement);
	if (/\bDROP\s+(CONSTRAINT|DEFAULT|NOT\s+NULL|EXPRESSION|IDENTITY)\b/i.test(cleaned)) return undefined;
	const m = DROP_COLUMN.exec(cleaned);
	return m ? { table: identName(m[1]), column: identName(m[2]) } : undefined;
}

const SERIAL_TYPES = /\b(SMALLSERIAL|BIGSERIAL|SERIAL|SERIAL2|SERIAL4|SERIAL8)\b/gi;
const SMALL_INT_TYPES = /\b(SMALLINT|INTEGER|INT|INT2|INT4|INT8|BIGINT)\b/i;
const IDENTITY_COLUMN =
	/\b(SMALLINT|INTEGER|INT|INT2|INT4|INT8|BIGINT)(\s+(?:NOT\s+NULL\s+)?GENERATED\s+(?:ALWAYS|BY\s+DEFAULT)\s+AS\s+IDENTITY)(?:\s*(\([^)]*\)))?/gi;
const ADD_IDENTITY = /\b(ADD\s+GENERATED\s+(?:ALWAYS|BY\s+DEFAULT)\s+AS\s+IDENTITY)(?:\s*(\([^)]*\)))?/gi;
const CREATE_SEQUENCE = /^\s*CREATE\s+SEQUENCE\b/i;

/** Insert `CACHE n` into a sequence-options list (or create one) when it has none. */
function withCache(options: string | undefined): { text: string; added: boolean } {
	if (!options) return { text: ` (CACHE ${DSQL_IDENTITY_CACHE})`, added: true };
	if (/\bCACHE\b/i.test(options)) return { text: ` ${options}`, added: false };
	const inner = options.slice(1, -1).trim();
	return { text: ` (${inner ? `${inner} ` : ''}CACHE ${DSQL_IDENTITY_CACHE})`, added: true };
}

/**
 * `SERIAL` family and identity columns → `BIGINT GENERATED … AS IDENTITY (CACHE 65536)`.
 * DSQL sequences and identity columns are `bigint` only and need an explicit cache.
 */
function rewriteIdentity(sql: string): { sql: string; notes: string[] } {
	const notes = new Set<string>();
	let out = replaceOutsideLiterals(sql, SERIAL_TYPES, () => {
		notes.add(`SERIAL rewritten to BIGINT GENERATED BY DEFAULT AS IDENTITY (CACHE ${DSQL_IDENTITY_CACHE})`);
		return `BIGINT GENERATED BY DEFAULT AS IDENTITY (CACHE ${DSQL_IDENTITY_CACHE})`;
	});
	out = replaceOutsideLiterals(out, IDENTITY_COLUMN, (_m, type: string, generated: string, options?: string) => {
		const cache = withCache(options);
		if (!/^(BIGINT|INT8)$/i.test(type))
			notes.add('identity column type rewritten to BIGINT (DSQL identity columns are bigint)');
		if (cache.added) notes.add(`CACHE ${DSQL_IDENTITY_CACHE} added (DSQL requires an explicit sequence cache)`);
		return `BIGINT${generated}${cache.text}`;
	});
	out = replaceOutsideLiterals(out, ADD_IDENTITY, (_m, add: string, options?: string) => {
		const cache = withCache(options);
		if (cache.added) notes.add(`CACHE ${DSQL_IDENTITY_CACHE} added (DSQL requires an explicit sequence cache)`);
		return `${add}${cache.text}`;
	});
	return { sql: out, notes: [...notes] };
}

/** `CREATE SEQUENCE` → `bigint` with an explicit cache. */
function rewriteSequence(sql: string): { sql: string; notes: string[] } {
	const notes: string[] = [];
	let out = sql;
	const cleaned = stripLiteralsAndComments(sql);
	if (!/\bCACHE\b/i.test(cleaned)) {
		out = `${out.trimEnd()} CACHE ${DSQL_IDENTITY_CACHE}`;
		notes.push(`CACHE ${DSQL_IDENTITY_CACHE} added (DSQL requires an explicit sequence cache)`);
	}
	const as = /\bAS\s+(SMALLINT|INTEGER|INT|INT2|INT4)\b/i;
	if (as.test(cleaned)) {
		out = replaceOutsideLiterals(out, as, 'AS BIGINT');
		notes.push('sequence type rewritten to BIGINT (DSQL sequences are bigint)');
	}
	return { sql: out, notes };
}

const CREATE_INDEX = /^\s*CREATE\s+(UNIQUE\s+)?INDEX\b/i;
const CREATE_INDEX_ASYNC = /^\s*CREATE\s+(UNIQUE\s+)?INDEX\s+ASYNC\b/i;
const CREATE_INDEX_CONCURRENTLY = /^\s*CREATE\s+(UNIQUE\s+)?INDEX\s+CONCURRENTLY\b/i;
/** `ADD [CONSTRAINT name] CHECK | FOREIGN KEY`. The name is what the validation step needs; without it the constraint stays NOT VALID. */
const ADD_CONSTRAINT =
	/^\s*ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?((?:"[^"]+"|[\w.])+)\s+ADD\s+(?:CONSTRAINT\s+((?:"[^"]+"|\w+))\s+)?(CHECK|FOREIGN\s+KEY)\b/i;
const ALTER_TABLE_ASYNC_VALIDATE = /^\s*ALTER\s+TABLE\s+ASYNC\b[\s\S]*\bVALIDATE\s+CONSTRAINT\b/i;
const FK_PATTERN =
	/\bREFERENCES\s+((?:"[^"]+"|[\w.])+)\s*(\([^)]*\))?(?:\s+MATCH\s+(?:FULL|PARTIAL|SIMPLE))?((?:\s+ON\s+(?:DELETE|UPDATE)\s+(?:CASCADE|RESTRICT|NO\s+ACTION|SET\s+NULL|SET\s+DEFAULT))*)/gi;

/** List every foreign key a statement defines together with its referential action. */
export function foreignKeysOf(statement: string): string[] {
	const cleaned = stripLiteralsAndComments(statement);
	const out: string[] = [];
	for (const m of cleaned.matchAll(FK_PATTERN)) {
		const actions = m[3]?.replace(/\s+/g, ' ').trim();
		out.push(`REFERENCES ${m[1]}${m[2] ?? ''}${actions ? ` ${actions}` : ' (NO ACTION)'}`);
	}
	return out;
}

/** The job-wait step that follows an asynchronous DDL statement. */
const waitStep = (what: string): PlanStep => ({
	kind: 'wait-job',
	sql: 'SELECT sys.wait_for_job($job)',
	transactional: false,
	note: `waits for the ${what} job DSQL returned`,
});

/** Rewrite one statement for the target, producing one or more plan steps. */
function rewriteStatement(statement: string, target: ClusterKind): PlanStep[] {
	const distributed = target === 'distributed';
	const cleaned = stripLiteralsAndComments(statement);

	if (!distributed) {
		// Portable: strip DSQL-only ASYNC; CONCURRENTLY cannot run inside a transaction.
		if (CREATE_INDEX_ASYNC.test(cleaned) || ALTER_TABLE_ASYNC_VALIDATE.test(cleaned)) {
			const sql = replaceOutsideLiterals(
				statement,
				/\b((?:CREATE\s+(?:UNIQUE\s+)?INDEX)|ALTER\s+TABLE)\s+ASYNC\b/i,
				'$1',
			);
			return [{ kind: 'statement', sql, transactional: true, note: 'ASYNC (DSQL-only) removed' }];
		}
		const transactional = !CREATE_INDEX_CONCURRENTLY.test(cleaned);
		return [{ kind: 'statement', sql: statement, transactional }];
	}

	const isDdl = classifyStatement(statement) === 'ddl';
	const notes: string[] = [];
	let sql = statement;

	const identity = rewriteIdentity(sql);
	sql = identity.sql;
	notes.push(...identity.notes);

	if (CREATE_SEQUENCE.test(cleaned)) {
		const seq = rewriteSequence(sql);
		sql = seq.sql;
		notes.push(...seq.notes);
	}

	const note = () => (notes.length > 0 ? notes.join('; ') : undefined);

	if (CREATE_INDEX.test(cleaned)) {
		if (!CREATE_INDEX_ASYNC.test(cleaned)) {
			sql = replaceOutsideLiterals(sql, /\b(CREATE\s+(?:UNIQUE\s+)?INDEX)\b/i, '$1 ASYNC');
			notes.push('CREATE INDEX rewritten to CREATE INDEX ASYNC');
		}
		return [{ kind: 'statement', sql, transactional: false, note: note() }, waitStep('index build')];
	}

	if (ALTER_TABLE_ASYNC_VALIDATE.test(cleaned)) {
		return [
			{ kind: 'validate-constraint', sql, transactional: false, note: note() },
			waitStep('constraint validation'),
		];
	}

	const add = ADD_CONSTRAINT.exec(cleaned);
	if (add) {
		const [, table, constraint, kind] = add;
		const label = kind.replace(/\s+/g, ' ').toUpperCase();
		if (!/\bNOT\s+VALID\s*$/i.test(cleaned.trim())) {
			sql = `${sql.trimEnd()} NOT VALID`;
			notes.push(
				constraint
					? `${label} constraint added NOT VALID, then validated asynchronously`
					: `${label} constraint added NOT VALID; name it to have it validated`,
			);
		}
		// Without a name there is nothing to pass to VALIDATE CONSTRAINT; buildMigrationPlan reports that.
		if (!constraint) return [{ kind: 'statement', sql, transactional: false, note: note() }];
		return [
			{ kind: 'statement', sql, transactional: false, note: note() },
			{
				kind: 'validate-constraint',
				sql: `ALTER TABLE ASYNC ${table} VALIDATE CONSTRAINT ${constraint}`,
				transactional: false,
			},
			waitStep('constraint validation'),
		];
	}

	return [{ kind: 'statement', sql, transactional: !isDdl, note: note() }];
}

/**
 * Build the plan for a set of migration files (name → SQL) against a cluster
 * kind. Throws a branded `DsqlMigrationValidationError` listing every statement
 * the target cannot run, each with the file name and the doc page checked.
 */
export interface BuildPlanOptions {
	/**
	 * Run the rewritten SQL through dsql-lint. On by default; the migration
	 * Lambda turns it off because the plan was validated at synth and the
	 * linter binary is not deployed.
	 * @default true
	 */
	validate?: boolean;
}

export function buildMigrationPlan(
	migrations: Record<string, string>,
	target: ClusterKind,
	options: BuildPlanOptions = {},
): MigrationPlan {
	const validate = options.validate !== false && target === 'distributed';
	const errors: string[] = [];
	const files: FilePlan[] = [];
	/** Primary-key columns per table, from the CREATE TABLE statements seen so far. */
	const primaryKeys = new Map<string, Set<string>>();
	for (const file of Object.keys(migrations).sort()) {
		const statements = splitStatements(migrations[file]);
		const steps: PlanStep[] = [];
		const foreignKeys: string[] = [];
		for (const statement of statements) {
			if (target === 'distributed') {
				// The block's own checks: what dsql-lint cannot see from one statement
				// (a primary key declared earlier) or does not care about (a constraint
				// the rewriter can add NOT VALID but cannot validate without a name).
				const cleaned = stripLiteralsAndComments(statement);
				const pk = primaryKeyColumns(statement);
				if (pk) primaryKeys.set(pk.table, new Set(pk.columns));
				const dropped = droppedColumn(statement);
				if (dropped && primaryKeys.get(dropped.table)?.has(dropped.column)) {
					errors.push(
						`${file}: DSQL cannot drop primary-key column '${dropped.column}' of '${dropped.table}'. Create a new table and copy the rows. Checked against ${ALTER_TABLE_DOC}`,
					);
				}
				const added = ADD_CONSTRAINT.exec(cleaned);
				if (added && !added[2]) {
					errors.push(
						`${file}: Name the constraint (ADD CONSTRAINT name CHECK … / FOREIGN KEY …). DSQL adds it NOT VALID and validates it by name in a separate job. Checked against ${ALTER_TABLE_DOC}`,
					);
				}
			}
			foreignKeys.push(...foreignKeysOf(statement));
			steps.push(...rewriteStatement(statement, target));
		}
		if (validate) {
			// Lint what will actually run: the rewritten statements, as one text so dsql-lint sees the file.
			const rewritten = steps
				.filter((s) => s.kind !== 'wait-job')
				.map((s) => `${s.sql.trim().replace(/;\s*$/, '')};`);
			for (const issue of findStatementIssues(rewritten.join('\n'))) {
				errors.push(`${file}: ${issue.message} Checked against ${issue.doc}`);
			}
		}
		files.push({ file, steps, foreignKeys });
	}
	if (errors.length > 0) {
		const err = new Error(`Migration validation failed for a '${target}' cluster:\n  ${errors.join('\n  ')}`);
		err.name = MIGRATION_VALIDATION_ERROR_NAME;
		throw brandBlocksError(err);
	}
	return { target, files };
}

/** Render a plan the way `bb-database migrate --explain` prints it. */
export function formatMigrationPlan(plan: MigrationPlan, options: { pending?: Set<string> } = {}): string {
	const lines: string[] = [`Migration plan (target: ${plan.target})`];
	if (plan.files.length === 0) lines.push('  (no migration files)');
	for (const file of plan.files) {
		const status = options.pending ? (options.pending.has(file.file) ? 'pending' : 'applied') : '';
		lines.push(`\n${file.file}${status ? ` [${status}]` : ''}`);
		let txOpen = false;
		file.steps.forEach((step, i) => {
			if (step.transactional && !txOpen) {
				lines.push('  BEGIN');
				txOpen = true;
			}
			if (!step.transactional && txOpen) {
				lines.push('  COMMIT');
				txOpen = false;
			}
			const indent = step.transactional ? '    ' : '  ';
			const label = step.kind === 'statement' ? '' : `[${step.kind}] `;
			lines.push(
				`${indent}${i + 1}. ${label}${step.sql.replace(/\s+/g, ' ').trim()}${step.note ? `  -- ${step.note}` : ''}`,
			);
		});
		if (txOpen) lines.push('  COMMIT');
		lines.push(`  record ${file.file} in _migrations`);
		if (file.foreignKeys.length > 0) {
			lines.push('  foreign keys and their referential actions:');
			for (const fk of file.foreignKeys) lines.push(`    - ${fk}`);
		}
	}
	return lines.join('\n');
}
