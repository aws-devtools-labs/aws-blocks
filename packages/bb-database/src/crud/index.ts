// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `db.crud()`: generated CRUD handlers for the Database Building Block.
 *
 * Generates typed list/get/create/update/delete handlers for each table, with
 * filtering, sorting, pagination, and column selection. All queries run through
 * `withRLS()` using the provided auth callback.
 *
 * @module
 */
import type { RLSEnabledDatabase } from '../rls-database.js';
import { buildDelete, buildInsert, buildSelect, buildUpdate } from './sql-builder.js';
import type { CrudAuthResult, CrudOptions, QueryOpts, TableSchema, TableTypeMeta } from './types.js';

/**
 * Create CRUD handlers for the given tables.
 *
 * @param db - The RLS-capable database core (provides withRLS + raw query)
 * @param schema - Runtime table metadata (from database.meta.ts)
 * @param options - Tables to generate, auth callback, optional exclusions
 * @returns Object with list/get/create/update/delete methods for each table
 */
export function createCrudHandlers<M extends Record<string, TableTypeMeta>>(
	db: RLSEnabledDatabase,
	schema: TableSchema,
	options: CrudOptions<M>,
): Record<string, (...args: never[]) => Promise<unknown>> {
	const handlers: Record<string, (...args: never[]) => Promise<unknown>> = {};
	const excludeSet = new Set(options.exclude ?? []);

	for (const table of options.tables) {
		const meta = schema[table];
		if (!meta) throw new Error(`Table "${table}" not found in schema`);

		const singular = capitalize(meta.singular);
		const plural = capitalize(meta.plural);
		const pkCols = Array.isArray(meta.primaryKey) ? meta.primaryKey : [meta.primaryKey];

		function resolvePkValues(id: string | Record<string, unknown>): unknown[] {
			if (id != null && typeof id === 'object' && !Array.isArray(id)) {
				return pkCols.map((c) => {
					if (!(c in id)) throw new Error(`Missing primary key column "${c}" in id object`);
					return id[c];
				});
			}
			if (pkCols.length > 1) {
				throw new Error(`Composite primary key requires an object with keys: ${pkCols.join(', ')}`);
			}
			return [id];
		}

		const listName = `list${plural}`;
		if (!excludeSet.has(listName)) {
			handlers[listName] = async (opts?: QueryOpts<Record<string, unknown>>) => {
				const auth = await options.auth();
				const query = buildSelect(table, opts, meta);
				return execQuery(db, auth, query.text, query.params);
			};
		}

		const getName = `get${singular}`;
		if (!excludeSet.has(getName)) {
			handlers[getName] = async (id: string | Record<string, unknown>) => {
				const auth = await options.auth();
				let where: Record<string, unknown>;
				if (id != null && typeof id === 'object' && !Array.isArray(id)) {
					for (const c of pkCols) {
						if (!(c in id)) throw new Error(`Missing primary key column "${c}" in id object`);
					}
					where = id;
				} else {
					if (pkCols.length > 1) {
						throw new Error(`Composite primary key requires an object with keys: ${pkCols.join(', ')}`);
					}
					where = { [pkCols[0]]: id };
				}
				const query = buildSelect(table, { where }, meta);
				const rows = await execQuery(db, auth, query.text, query.params);
				return rows[0] ?? null;
			};
		}

		const createName = `create${singular}`;
		if (!excludeSet.has(createName)) {
			handlers[createName] = async (data: Record<string, unknown>) => {
				const auth = await options.auth();
				const query = buildInsert(table, data, meta);
				const rows = await execQuery(db, auth, query.text, query.params);
				return rows[0];
			};
		}

		const updateName = `update${singular}`;
		if (!excludeSet.has(updateName)) {
			handlers[updateName] = async (id: string | Record<string, unknown>, data: Record<string, unknown>) => {
				const auth = await options.auth();
				const query = buildUpdate(table, resolvePkValues(id), data, meta);
				const rows = await execQuery(db, auth, query.text, query.params);
				return rows[0] ?? null;
			};
		}

		const deleteName = `delete${singular}`;
		if (!excludeSet.has(deleteName)) {
			handlers[deleteName] = async (id: string | Record<string, unknown>) => {
				const auth = await options.auth();
				const query = buildDelete(table, resolvePkValues(id), meta);
				const scoped = db.withRLS({ userId: auth.userId, claims: auth.claims });
				const result = await scoped.executeRaw(query.text, query.params);
				return { deleted: result.rowCount > 0 };
			};
		}
	}

	return handlers;
}

/** The method names `crud()` generates for a schema + options, in declaration order. */
export function crudMethodNames(schema: TableSchema, options: CrudOptions<Record<string, TableTypeMeta>>): string[] {
	const names: string[] = [];
	const excludeSet = new Set(options.exclude ?? []);
	for (const table of options.tables) {
		const meta = schema[table];
		if (!meta) continue;
		const singular = capitalize(meta.singular);
		const plural = capitalize(meta.plural);
		for (const name of [
			`list${plural}`,
			`get${singular}`,
			`create${singular}`,
			`update${singular}`,
			`delete${singular}`,
		]) {
			if (!excludeSet.has(name)) names.push(name);
		}
	}
	return names;
}

/** Execute a query through withRLS and return rows. */
async function execQuery(
	db: RLSEnabledDatabase,
	auth: CrudAuthResult,
	text: string,
	params: unknown[],
): Promise<Record<string, unknown>[]> {
	const scoped = db.withRLS({ userId: auth.userId, claims: auth.claims });
	return scoped.queryRaw<Record<string, unknown>>(text, params);
}

function capitalize(s: string): string {
	return s.charAt(0).toUpperCase() + s.slice(1);
}
