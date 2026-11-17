// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Generic, provider-agnostic naming + type-mapping helpers used by the file
 * generators. Pure functions, no I/O.
 *
 * @module
 */
import pluralize from 'pluralize';

// ── PG → TS type mapping ───────────────────────────────────────────────

const PG_TO_TS: Record<string, string> = {
  'integer': 'number',
  'bigint': 'number',
  'smallint': 'number',
  'decimal': 'number',
  'numeric': 'number',
  'real': 'number',
  'double precision': 'number',
  'serial': 'number',
  'bigserial': 'number',
  'text': 'string',
  'character varying': 'string',
  'varchar': 'string',
  'char': 'string',
  'character': 'string',
  'uuid': 'string',
  'boolean': 'boolean',
  'timestamp without time zone': 'string',
  'timestamp with time zone': 'string',
  'timestamptz': 'string',
  'date': 'string',
  'time': 'string',
  'json': 'Record<string, unknown>',
  'jsonb': 'Record<string, unknown>',
  'bytea': 'Uint8Array',
  'ARRAY': 'unknown[]',
};

export function pgTypeToTs(pgType: string): string {
  return PG_TO_TS[pgType.toLowerCase()] ?? 'unknown';
}

/** Every TypeScript type expression {@link pgTypeToTs} can return. */
export function mappedTsTypes(): string[] {
  return [...new Set([...Object.values(PG_TO_TS), 'unknown'])];
}

// ── Identifier casing ──────────────────────────────────────────────────

export function pascalCase(str: string): string {
  return str.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join('');
}

/** Uppercase only the first character, leaving the rest unchanged. */
export function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/**
 * Convert a snake_case identifier (e.g. database table name) to camelCase
 * for use as a JavaScript identifier. Used for method names: `migration_test_todos`
 * → `migrationTestTodos`, so generated methods become `listMigrationTestTodos`
 * (idiomatic) rather than `listMigration_test_todos` (mixed snake/Pascal).
 */
export function camelCase(str: string): string {
  const parts = str.split('_').filter(p => p.length > 0);
  if (parts.length === 0) return str;
  return parts[0].toLowerCase() + parts.slice(1).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join('');
}

/**
 * The camelCase singular for a table, used in generated CRUD method names
 * (`get${Pascal(singular)}`, `create${Pascal(singular)}`, …) and in
 * `database.meta.ts`. A hand-edited value from a prior pull (`existingSingulars`)
 * wins so re-pull never clobbers a customer's correction (D6 / PR #787).
 *
 * Single source of truth: previously this expression was duplicated in the meta
 * runtime const, the meta type mirror, and the migration guide — three copies the
 * code comments warned had to stay mirrored. Keep it here only.
 */
export function resolveSingular(tableName: string, existingSingulars?: Map<string, string>): string {
  return existingSingulars?.get(tableName) ?? camelCase(pluralize.singular(tableName));
}
