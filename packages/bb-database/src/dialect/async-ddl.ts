// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { DatabaseEngine } from '@aws-blocks/data-common';
import { quoteIdent } from '../constants.js';
import { ASYNC_DDL } from './validation.js';

/**
 * The catalog object an asynchronous DDL statement builds or validates. `schema` is absent when the statement
 * left the table unqualified; the runner fills in the block's schema (`inSchema`).
 */
export type AsyncDdlTarget =
	| { kind: 'index'; schema?: string; name: string }
	| { kind: 'constraint'; schema?: string; table: string; name: string };

export type ResolvedTarget = AsyncDdlTarget & { schema: string };

const IDENT = String.raw`"(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*`;
const QUALIFIED = String.raw`(?<q1>${IDENT})(?:\s*\.\s*(?<q2>${IDENT}))?`;
// What follows ASYNC in the two forms ASYNC_DDL admits, with the optional words DSQL's grammar allows.
const INDEX_TAIL = new RegExp(
	String.raw`^\s+(?:IF\s+NOT\s+EXISTS\s+)?(?<index>${IDENT})\s+ON\s+(?:ONLY\s+)?${QUALIFIED}`,
	'i',
);
const VALIDATE_TAIL = new RegExp(
	String.raw`^\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?${QUALIFIED}\s*\*?\s+VALIDATE\s+CONSTRAINT\s+(?<constraint>${IDENT})`,
	'i',
);

// PostgreSQL folds an unquoted identifier to lower case; a quoted one is kept as written.
function unquote(ident: string): string {
	return ident.startsWith('"') ? ident.slice(1, -1).replace(/""/g, '"') : ident.toLowerCase();
}

function qualified(q1: string, q2: string | undefined): { schema?: string; name: string } {
	return q2 === undefined ? { name: unquote(q1) } : { schema: unquote(q1), name: unquote(q2) };
}

/**
 * The object an `ASYNC` statement targets, or `undefined` when the text is not one of the two async forms.
 * `cleaned` is the statement with comments removed and literals replaced (`inspectStatement().cleaned`).
 */
export function asyncDdlTarget(cleaned: string): AsyncDdlTarget | undefined {
	const prefix = ASYNC_DDL.exec(cleaned);
	if (!prefix) return undefined;
	const tail = cleaned.slice(prefix[0].length);
	if (/^\s*CREATE\b/i.test(prefix[1])) {
		const index = INDEX_TAIL.exec(tail)?.groups;
		// An index lives in its table's schema; its own name cannot be qualified.
		if (!index?.index || !index.q1) return undefined;
		const { schema } = qualified(index.q1, index.q2);
		return { kind: 'index', ...(schema === undefined ? {} : { schema }), name: unquote(index.index) };
	}
	const validate = VALIDATE_TAIL.exec(tail)?.groups;
	if (!validate?.constraint || !validate.q1) return undefined;
	const table = qualified(validate.q1, validate.q2);
	return {
		kind: 'constraint',
		...(table.schema === undefined ? {} : { schema: table.schema }),
		table: table.name,
		name: unquote(validate.constraint),
	};
}

export function inSchema(target: AsyncDdlTarget, schema: string): ResolvedTarget {
	return { ...target, schema: target.schema ?? schema };
}

export function describeTarget(target: ResolvedTarget): string {
	return target.kind === 'index'
		? `index ${quoteIdent(target.schema)}.${quoteIdent(target.name)}`
		: `constraint ${quoteIdent(target.name)} on ${quoteIdent(target.schema)}.${quoteIdent(target.table)}`;
}

export type CatalogState = 'valid' | 'invalid' | 'missing';

/** `pg_index.indisvalid` for an index, `pg_constraint.convalidated` for a constraint. */
export async function catalogState(engine: DatabaseEngine, target: ResolvedTarget): Promise<CatalogState> {
	const rows =
		target.kind === 'index'
			? await engine.query<{ valid: boolean }>(
					'SELECT i.indisvalid AS valid FROM pg_index i ' +
						'JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_namespace n ON n.oid = c.relnamespace ' +
						'WHERE n.nspname = $1 AND c.relname = $2',
					[target.schema, target.name],
				)
			: await engine.query<{ valid: boolean }>(
					'SELECT con.convalidated AS valid FROM pg_constraint con ' +
						'JOIN pg_class c ON c.oid = con.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace ' +
						'WHERE n.nspname = $1 AND c.relname = $2 AND con.conname = $3',
					[target.schema, target.table, target.name],
				);
	if (!rows[0]) return 'missing';
	return rows[0].valid ? 'valid' : 'invalid';
}

/**
 * Removes what a failed index job leaves behind: DSQL keeps the index as INVALID (a unique one still rejects
 * duplicates) and the same `CREATE INDEX ASYNC` cannot run until it is dropped. A constraint whose validation
 * failed stays NOT VALID and `VALIDATE CONSTRAINT` can simply run again, so nothing is dropped for it.
 * `knownState` is the catalog state the caller has already read, so it is not read twice.
 * Returns true when an index was dropped.
 */
export async function dropInvalidIndex(
	engine: DatabaseEngine,
	target: ResolvedTarget,
	knownState?: CatalogState,
): Promise<boolean> {
	if (target.kind !== 'index') return false;
	const state = knownState ?? (await catalogState(engine, target));
	if (state !== 'invalid') return false;
	await engine.execute(`DROP INDEX IF EXISTS ${quoteIdent(target.schema)}.${quoteIdent(target.name)}`);
	return true;
}
