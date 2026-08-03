// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * A fluent, typed query client over `Database`.
 *
 * ```ts
 * const notes = await data.from('notes')
 *   .select('id', 'text')
 *   .eq('done', false)
 *   .order('created_at', 'desc')
 *   .limit(20);
 * ```
 *
 * Three things this is careful about:
 *
 * - **No SQL is built by the caller.** Every value becomes a bound parameter and every
 *   identifier is validated against the introspected schema, so a column name cannot
 *   carry SQL into the statement.
 * - **Errors throw.** No `{ data, error }` tuple that the compiler can't force you to
 *   check. Match failures with `isBlocksError`.
 * - **Writes demand a filter.** `update()` and `delete()` throw unless narrowed, so a
 *   forgotten `.eq(...)` cannot rewrite or empty a table.
 *
 * The raw `sql` tag and the Kysely adapter remain for queries a fluent builder should
 * not try to express.
 *
 * @module
 */

import type { DatabaseEngine } from '@aws-blocks/data-common';
import { buildCount, buildDeleteWhere, buildInsert, buildSelect, buildUpdateWhere } from '../crud/sql-builder.js';
import type { QueryOpts, TableMetaEntry, TableSchema, WhereClause } from '../crud/types.js';
import { ExecutableQuery } from './executable.js';
import type { TableTypeMeta } from './types.js';
import type {
	DataClient,
	EngineProvider,
	InsertOf,
	RowOf,
	SelectQuery,
	SortDirection,
	TableQuery,
	WriteQuery,
} from './types.js';

/**
 * Create a typed query client for a database.
 *
 * The schema argument is the generated `tableMeta`, and the type parameter is the
 * generated `TableMeta` — both produced from your migrations by
 * `@aws-blocks/bb-data/schema-sync`, so table and column names are checked against the
 * real schema rather than trusted.
 *
 * @example
 * ```ts
 * import { createDataClient } from '@aws-blocks/bb-data/fluent';
 * import { tableMeta, type TableMeta } from './schema/database.meta.js';
 *
 * export const data = createDataClient<TableMeta>(db, tableMeta);
 * ```
 *
 * @param db - The `Database` block to run against.
 * @param schema - Generated runtime table metadata.
 */
export function createDataClient<M extends Record<string, TableTypeMeta>>(
	db: EngineProvider,
	schema: TableSchema,
): DataClient<M> {
	return {
		from<T extends keyof M & string>(table: T): TableQuery<M, T> {
			const meta = schema[table];
			if (!meta) {
				throw new Error(`Unknown table: "${table}" (valid: ${Object.keys(schema).join(', ')})`);
			}
			return new TableQueryImpl<M, T>(db, table, meta);
		},
	};
}

class TableQueryImpl<M extends Record<string, TableTypeMeta>, T extends keyof M & string>
	implements TableQuery<M, T>
{
	constructor(
		private readonly db: EngineProvider,
		private readonly table: T,
		private readonly meta: TableMetaEntry,
	) {}

	select<K extends keyof RowOf<M, T> & string>(...columns: K[]) {
		const query = new SelectQueryImpl<RowOf<M, T>, RowOf<M, T>>(this.db, this.table, this.meta);
		// Overload resolution is handled by the interface; the implementation is one path.
		return (columns.length > 0 ? query.select(...columns) : query) as SelectQuery<
			RowOf<M, T>,
			Pick<RowOf<M, T>, K>
		>;
	}

	async insert(values: InsertOf<M, T>): Promise<RowOf<M, T>> {
		const built = buildInsert(this.table, values as Record<string, unknown>, this.meta);
		const engine = await this.db.getEngine();
		const rows = await engine.query<RowOf<M, T>>(built.text, built.params);
		// INSERT ... RETURNING * always yields the stored row.
		return rows[0];
	}

	update(values: Partial<InsertOf<M, T>>): WriteQuery<RowOf<M, T>> {
		return new WriteQueryImpl<RowOf<M, T>>(this.db, this.table, this.meta, {
			kind: 'update',
			values: values as Record<string, unknown>,
		});
	}

	delete(): WriteQuery<RowOf<M, T>> {
		return new WriteQueryImpl<RowOf<M, T>>(this.db, this.table, this.meta, { kind: 'delete' });
	}
}

/** Filter accumulation shared by the select and write builders. */
class FilterState<Row> {
	readonly where: WhereClause<Row> = {} as WhereClause<Row>;

	/**
	 * Merge one condition for a column.
	 *
	 * Two operator conditions on the same column combine (`gte` + `lte` gives a
	 * range). A later equality replaces whatever came before, matching the plain
	 * reading of `.eq(...)`.
	 */
	add(column: string, condition: unknown): void {
		const current = (this.where as Record<string, unknown>)[column];
		const bothOperatorObjects =
			isPlainObject(current) && isPlainObject(condition) && current !== null && condition !== null;

		(this.where as Record<string, unknown>)[column] = bothOperatorObjects
			? { ...(current as object), ...(condition as object) }
			: condition;
	}

	get isEmpty(): boolean {
		return Object.keys(this.where).length === 0;
	}
}

function isPlainObject(value: unknown): boolean {
	return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date);
}

class SelectQueryImpl<Row, Selected> extends ExecutableQuery<Selected[]> implements SelectQuery<Row, Selected> {
	private readonly filters = new FilterState<Row>();
	private readonly orderBy: string[] = [];
	private columns?: string[];
	private limitValue?: number;
	private offsetValue?: number;

	constructor(
		private readonly db: EngineProvider,
		private readonly table: string,
		private readonly meta: TableMetaEntry,
	) {
		super();
	}

	select<K extends keyof Row & string>(...columns: K[]): SelectQuery<Row, Pick<Row, K>> {
		this.columns = columns;
		// Only the compile-time result type changes; the builder instance is the same.
		return this as unknown as SelectQuery<Row, Pick<Row, K>>;
	}

	eq<K extends keyof Row & string>(column: K, value: Row[K] | null) {
		// null becomes IS NULL in the SQL builder.
		this.filters.add(column, value);
		return this;
	}
	gt<K extends keyof Row & string>(column: K, value: Row[K]) {
		this.filters.add(column, { gt: value });
		return this;
	}
	gte<K extends keyof Row & string>(column: K, value: Row[K]) {
		this.filters.add(column, { gte: value });
		return this;
	}
	lt<K extends keyof Row & string>(column: K, value: Row[K]) {
		this.filters.add(column, { lt: value });
		return this;
	}
	lte<K extends keyof Row & string>(column: K, value: Row[K]) {
		this.filters.add(column, { lte: value });
		return this;
	}
	like<K extends keyof Row & string>(column: K, pattern: string) {
		this.filters.add(column, { like: pattern });
		return this;
	}
	ilike<K extends keyof Row & string>(column: K, pattern: string) {
		this.filters.add(column, { ilike: pattern });
		return this;
	}
	in<K extends keyof Row & string>(column: K, values: Row[K][]) {
		this.filters.add(column, { in: values });
		return this;
	}

	order(column: keyof Row & string, direction: SortDirection = 'asc') {
		this.orderBy.push(`${column}:${direction}`);
		return this;
	}

	limit(count: number) {
		this.limitValue = count;
		return this;
	}

	offset(count: number) {
		this.offsetValue = count;
		return this;
	}

	async first(): Promise<Selected | null> {
		// Not-found is ordinary control flow, so this returns null rather than throwing.
		const rows = await this.limit(1);
		return rows[0] ?? null;
	}

	async count(): Promise<number> {
		const built = buildCount(this.table, this.filters.isEmpty ? undefined : this.filters.where, this.meta);
		const engine = await this.db.getEngine();
		const rows = await engine.query<{ count: number }>(built.text, built.params);
		return rows[0]?.count ?? 0;
	}

	protected async execute(): Promise<Selected[]> {
		const opts: QueryOpts<Row> = {
			where: this.filters.isEmpty ? undefined : this.filters.where,
			orderBy: this.orderBy.length > 0 ? this.orderBy : undefined,
			limit: this.limitValue,
			offset: this.offsetValue,
			select: this.columns as (keyof Row & string)[] | undefined,
		};
		const built = buildSelect<Row>(this.table, opts, this.meta);
		const engine = await this.db.getEngine();
		return engine.query<Selected>(built.text, built.params);
	}
}

type WriteKind = { kind: 'update'; values: Record<string, unknown> } | { kind: 'delete' };

class WriteQueryImpl<Row> extends ExecutableQuery<Row[]> implements WriteQuery<Row> {
	private readonly filters = new FilterState<Row>();

	constructor(
		private readonly db: EngineProvider,
		private readonly table: string,
		private readonly meta: TableMetaEntry,
		private readonly op: WriteKind,
	) {
		super();
	}

	eq<K extends keyof Row & string>(column: K, value: Row[K] | null) {
		this.filters.add(column, value);
		return this;
	}
	in<K extends keyof Row & string>(column: K, values: Row[K][]) {
		this.filters.add(column, { in: values });
		return this;
	}
	gt<K extends keyof Row & string>(column: K, value: Row[K]) {
		this.filters.add(column, { gt: value });
		return this;
	}
	lt<K extends keyof Row & string>(column: K, value: Row[K]) {
		this.filters.add(column, { lt: value });
		return this;
	}

	protected async execute(): Promise<Row[]> {
		// The SQL builders reject an empty filter — an unfiltered write would hit every
		// row, which is never what a forgotten `.eq(...)` meant.
		const built =
			this.op.kind === 'update'
				? buildUpdateWhere<Row>(this.table, this.op.values, this.filters.where, this.meta)
				: buildDeleteWhere<Row>(this.table, this.filters.where, this.meta);

		const engine = await this.db.getEngine();
		return engine.query<Row>(built.text, built.params);
	}
}

export type {
	DataClient,
	EngineProvider,
	InsertOf,
	RowOf,
	SelectQuery,
	SortDirection,
	TableQuery,
	TableTypeMeta,
	WriteQuery,
} from './types.js';
export type { DatabaseEngine };
