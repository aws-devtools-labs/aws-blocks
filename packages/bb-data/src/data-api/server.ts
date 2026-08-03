// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Server half of the browser-facing data API.
 *
 * Lets a browser read and write tables with no hand-written endpoint per query, while
 * keeping authorization in the database:
 *
 * 1. **Authentication is mandatory.** `auth` is required and must resolve a user; there
 *    is no anonymous mode to forget to turn off. This is the difference from an
 *    anon-key model, where a table is readable by anyone until RLS is added.
 * 2. **Tables are opt-in.** Only what `tables` names is reachable.
 * 3. **The client never sends SQL.** A query description is validated against the
 *    introspected schema and a closed operator set, and the statement is built here.
 * 4. **Every query runs under RLS** with the caller's claims, so row-level
 *    authorization is Postgres policy rather than application code.
 *
 * @module
 */

import { buildCount, buildDeleteWhere, buildInsert, buildSelect, buildUpdateWhere } from '../crud/sql-builder.js';
import type { BuiltQuery, QueryOpts, TableSchema, WhereClause } from '../crud/types.js';
import { DataApiErrors, blocksError } from './errors.js';
import type { QueryDescription, SerializedFilter } from './types.js';
import { validateQueryDescription } from './validate.js';

/** The authenticated caller, as any auth block reports it. */
export interface DataApiUser {
	userId: string;
	/** Postgres role to run under. Defaults to `authenticated`. */
	role?: string;
	/** JWT claims, exposed to policies as `request.jwt.claims`. */
	claims?: Record<string, unknown>;
}

/** A database scoped to one caller's claims. */
export interface RlsScopedDatabase {
	queryRaw<T>(sql: string, params: unknown[]): Promise<T[]>;
}

/**
 * Minimal slice of `Database` this needs: the RLS entry point.
 *
 * The return type allows a promise or a plain value, because `Database.withRLS()` is
 * async (it awaits migrations first) while `RLSEnabledDatabase.withRLS()` is not.
 */
export interface RlsCapableDatabase {
	withRLS(context: {
		userId: string;
		role?: string;
		claims?: Record<string, unknown>;
	}): Promise<RlsScopedDatabase> | RlsScopedDatabase;
}

/** Options for {@link createDataApi}. */
export interface DataApiOptions {
	/** The database to query. */
	db: RlsCapableDatabase;
	/** Generated runtime table metadata, from `@aws-blocks/bb-data/schema-sync`. */
	schema: TableSchema;
	/** Tables to expose. Opt-in only — nothing is reachable by default. */
	tables: readonly string[];
	/**
	 * Resolve the calling user, or throw/return null if there isn't one.
	 *
	 * Required. Wire this to an auth block's `requireAuth`.
	 */
	auth: () => Promise<DataApiUser | null>;
	/** Largest `limit` a client may request, and the default. Defaults to 1000. */
	maxLimit?: number;
}

/** A validated, RLS-scoped query executor. */
export interface DataApi {
	/**
	 * Authenticate, validate, and run one query description.
	 *
	 * @param raw - Untrusted input, straight off the request body.
	 * @returns Rows for reads and writes; a `{ count }` row for `count`.
	 * @throws `DataApiErrors.NotAuthenticated` when no user resolves.
	 * @throws `DataApiErrors.InvalidQuery` / `DataApiErrors.TableNotExposed` when the
	 * description asks for anything not explicitly allowed.
	 */
	execute(raw: unknown): Promise<unknown[]>;
}

/**
 * Create the server-side executor for browser queries.
 *
 * @example
 * ```ts
 * const dataApi = createDataApi({
 *   db,
 *   schema: tableMeta,
 *   tables: ['notes'],
 *   auth: async () => auth.requireAuth(context),
 * });
 *
 * // one endpoint, every table
 * export async function POST(request: Request) {
 *   return Response.json(await dataApi.execute(await request.json()));
 * }
 * ```
 *
 * @throws If `tables` names a table absent from `schema`, at construction time rather
 * than on first request.
 */
export function createDataApi(options: DataApiOptions): DataApi {
	const { db, schema, tables, auth, maxLimit } = options;

	// Fail at wiring time, not on a request: a typo'd table name would otherwise look
	// like a client error much later.
	for (const table of tables) {
		if (!schema[table]) {
			throw new Error(`createDataApi: table "${table}" is not in the schema`);
		}
	}

	return {
		async execute(raw: unknown): Promise<unknown[]> {
			// Authenticate BEFORE validating, so an unauthenticated caller learns nothing
			// about the schema from validation messages.
			const user = await auth();
			if (!user?.userId) {
				throw blocksError(DataApiErrors.NotAuthenticated, 'authentication required');
			}

			const query = validateQueryDescription(raw, { schema, allowedTables: tables, maxLimit });
			const built = buildStatement(query, schema);

			// RLS is the authorization layer: policies decide which rows this user sees,
			// using the same claims the auth block reported.
			const scoped = await db.withRLS({
				userId: user.userId,
				role: user.role,
				claims: user.claims,
			});

			return scoped.queryRaw(built.text, built.params);
		},
	};
}

/** Build the statement from an already-validated description. */
function buildStatement(query: QueryDescription, schema: TableSchema): BuiltQuery {
	const meta = schema[query.table];
	const where = toWhereClause(query.filters);

	switch (query.operation) {
		case 'select': {
			const opts: QueryOpts<Record<string, unknown>> = {
				where,
				orderBy: query.order?.map((o) => `${o.column}:${o.direction}`),
				limit: query.limit,
				offset: query.offset,
				select: query.columns,
			};
			return buildSelect(query.table, opts, meta);
		}
		case 'count':
			return buildCount(query.table, where, meta);
		case 'insert':
			// values is guaranteed present and non-empty for insert by validation.
			return buildInsert(query.table, query.values ?? {}, meta);
		case 'update':
			return buildUpdateWhere(query.table, query.values ?? {}, where ?? {}, meta);
		case 'delete':
			return buildDeleteWhere(query.table, where ?? {}, meta);
	}
}

/** Convert the wire filter list into the SQL builder's filter object. */
function toWhereClause(filters: SerializedFilter[] | undefined): WhereClause<Record<string, unknown>> | undefined {
	if (!filters || filters.length === 0) return undefined;

	const where: Record<string, unknown> = {};

	for (const filter of filters) {
		const existing = where[filter.column];

		if (filter.operator === 'eq') {
			where[filter.column] = filter.value;
			continue;
		}
		if (filter.operator === 'is_null') {
			// The SQL builder reads a literal null as IS NULL.
			where[filter.column] = null;
			continue;
		}

		// Operator conditions on the same column combine, so gte + lte is a range.
		const condition = { [filter.operator]: filter.value };
		where[filter.column] =
			typeof existing === 'object' && existing !== null && !Array.isArray(existing)
				? { ...existing, ...condition }
				: condition;
	}

	return where as WhereClause<Record<string, unknown>>;
}
