// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Branded SQL tagged template for injection-safe parameterized queries.
 *
 * The `sql` tag auto-parametrizes all interpolated values — they become
 * positional `$1`, `$2`, ... placeholders, never concatenated into the SQL string.
 *
 * @example
 * ```ts
 * import { sql } from '@aws-blocks/blocks';
 *
 * const rows = await db.query(sql`SELECT * FROM users WHERE age > ${18}`);
 * // Executes: SELECT * FROM users WHERE age > $1  with params: [18]
 * ```
 *
 * @module
 */

/** @internal Unexported symbol — makes SqlQuery impossible to forge outside this module. */
const SQL_BRAND: unique symbol = Symbol('SafeSQL');

/**
 * A branded, injection-safe SQL query produced by the {@link sql} tagged template.
 *
 * Cannot be constructed directly — only the `sql` tag can create instances.
 * This guarantees that all interpolated values are parameterized.
 */
export interface SqlQuery {
  readonly [SQL_BRAND]: true;
  readonly sql: string;
  readonly params: readonly unknown[];
}

/**
 * Tagged template that produces a parameterized {@link SqlQuery}.
 *
 * Every `${}` interpolation becomes a positional parameter (`$1`, `$2`, ...),
 * never concatenated into the SQL string. This makes SQL injection structurally
 * impossible when using this tag.
 *
 * @example
 * ```ts
 * const id = 'user-123';
 * const query = sql`SELECT * FROM users WHERE id = ${id}`;
 * // query.sql    → "SELECT * FROM users WHERE id = $1"
 * // query.params → ["user-123"]
 * ```
 */
export function sql(strings: TemplateStringsArray, ...values: unknown[]): SqlQuery {
  const text = strings.reduce(
    (acc, str, i) => acc + str + (i < values.length ? `$${i + 1}` : ''),
    '',
  );
  return { [SQL_BRAND]: true as const, sql: text, params: values };
}

/** @internal Extract sql + params from a branded SqlQuery. Used by DatabaseBase. */
export function unwrapQuery(query: SqlQuery): { sql: string; params: unknown[] } {
  // Runtime guard: verify the exact module-private SQL_BRAND symbol is present.
  // Uses identity comparison (not toString()) so a foreign Symbol('SafeSQL')
  // cannot bypass the guard.
  const symbols = Object.getOwnPropertySymbols(query);
  if (!symbols.includes(SQL_BRAND)) {
    throw new Error(
      'Invalid query: use the sql tagged template (e.g. sql`SELECT ...`) instead of passing a raw string or object.'
    );
  }
  return { sql: query.sql, params: [...query.params] };
}
