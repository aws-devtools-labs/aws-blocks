// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Identifier checks and TypeScript emission helpers for `db pull`. Table and
 * column names come from the database catalog, so the generators check them
 * against the TypeScript identifier grammar before generating anything, and quote
 * them at every place they are written into generated TypeScript. Pure functions, no I/O.
 *
 * @module
 */
import type { TableInfo } from './types.js';
import { mappedTsTypes, pascalCase, resolveSingular } from './naming.js';

/**
 * Pattern every table, column and primary-key name must match for `db pull` to
 * generate code for it: a TypeScript identifier. It starts with a Unicode letter
 * (`ID_Start`), `_` or `$`, followed by Unicode letters, digits and combining
 * marks (`ID_Continue`), `$`, ZWNJ or ZWJ. Unicode escape sequences are not
 * accepted (no backslash can match), so the name in the catalog is the name in
 * the generated code.
 */
export const IDENTIFIER_PATTERN = /^[\p{ID_Start}_$][\p{ID_Continue}$\u200C\u200D]*$/u;

/**
 * Names emitted unquoted, exactly as the generators always have: ASCII letters,
 * digits and underscores, not starting with a digit. Every other accepted name is
 * emitted quoted via `JSON.stringify`.
 */
const PLAIN_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** True when `name` matches {@link IDENTIFIER_PATTERN}. */
export function isIdentifier(name: string): boolean {
  return IDENTIFIER_PATTERN.test(name);
}

/**
 * True when `name` is a plain ASCII identifier (letters, digits and underscores,
 * not starting with a digit), which the emission helpers write unquoted.
 */
export function isPlainIdentifier(name: string): boolean {
  return PLAIN_NAME_PATTERN.test(name);
}

/**
 * Emit `value` as a TypeScript string literal (usable in value and type
 * positions). A plain identifier is emitted single-quoted, as the generators
 * always have, so existing generated files do not change; anything else is
 * emitted via `JSON.stringify`, which escapes quotes, backslashes and control
 * characters. A JSON string is a valid TS string literal, and inside quotes `${`
 * and backticks have no special meaning.
 */
export function tsStringLiteral(value: string): string {
  return isPlainIdentifier(value) ? `'${value}'` : JSON.stringify(value);
}

/**
 * Emit `name` as a property key for an object literal or interface body. A plain
 * identifier is emitted bare (reserved words are valid property names); anything
 * else is emitted as a quoted key via `JSON.stringify`.
 */
export function tsPropertyKey(name: string): string {
  return isPlainIdentifier(name) ? name : JSON.stringify(name);
}

/**
 * Table names that pass {@link IDENTIFIER_PATTERN} but cannot be used. Table
 * names become keys of the generated `tableMeta` object literal, and a
 * `__proto__` key there (bare or quoted) sets the object's prototype instead of
 * adding a property. Column names are not checked against this list: they only
 * appear as interface keys and in string arrays, where `__proto__` is an
 * ordinary name.
 */
const RESERVED_TABLE_NAMES: ReadonlySet<string> = new Set(['__proto__']);

/**
 * Type names a table's derived type name (its {@link pascalCase} interface name)
 * must not take, because `database.types.ts` and `database.meta.ts` already use
 * them in the scope where the interfaces are declared and imported:
 *
 * - `TableMeta` and `tableMeta`, declared by `database.meta.ts`.
 * - Every identifier in a column type that {@link pgTypeToTs} can emit
 *   (`Record`, `Uint8Array`, …), taken from the mapping so the list follows it.
 *   An interface with one of these names would replace the global type for
 *   every column in the file.
 *
 * Derived names start with an uppercase letter (or a character without case),
 * so lowercase keywords such as `string` and reserved words such as `class`
 * (→ `Class`) never collide.
 */
export const RESERVED_TYPE_NAMES: ReadonlySet<string> = new Set([
  'TableMeta',
  'tableMeta',
  ...mappedTsTypes().flatMap(t => t.match(/[A-Za-z_$][\w$]*/g) ?? []),
]);

function describeRule(): string {
  return (
    `Table, column and primary key names must be TypeScript identifiers matching ${IDENTIFIER_PATTERN.source} ` +
    `(letters, digits, underscores and \`$\`, not starting with a digit; no spaces, quotes, backslashes or punctuation). ` +
    `Rename it in a migration and re-run \`db pull\`.`
  );
}

function checkName(kind: string, name: string, tableName?: string): void {
  if (typeof name === 'string' && isIdentifier(name)) return;
  // JSON.stringify shows quotes, newlines and other characters unambiguously.
  const where = tableName === undefined ? '' : ` in table ${JSON.stringify(tableName)}`;
  throw new Error(
    `\`db pull\` cannot generate code for ${kind} ${JSON.stringify(name)}${where}: it is not a valid identifier. ` +
      describeRule(),
  );
}

/**
 * Check every catalog name the generators emit for `tables` — table names,
 * column names, primary-key columns and server-managed (autoGenerated) columns —
 * plus the names derived from them (the interface name built with
 * {@link pascalCase} and the singular, which may be a hand-edited value from a
 * prior pull). Throws an `Error` naming the first offending identifier and its
 * table. Called at the entry of each generator so every generation path is covered.
 */
export function assertValidIdentifiers(tables: TableInfo[], existingSingulars?: Map<string, string>): void {
  for (const table of tables) {
    checkName('table', table.name);
    if (RESERVED_TABLE_NAMES.has(table.name)) {
      throw new Error(
        `\`db pull\` cannot generate code for table ${JSON.stringify(table.name)}: it is a reserved name ` +
          `(it would set the prototype of the generated tableMeta object instead of adding an entry). ` +
          `Rename the table in a migration and re-run \`db pull\`.`,
      );
    }
    for (const col of table.columns) checkName('column', col.column_name, table.name);
    const pk = Array.isArray(table.primaryKey) ? table.primaryKey : [table.primaryKey];
    for (const c of pk) checkName('primary key column', c, table.name);
    for (const c of table.autoGenerated) checkName('autoGenerated column', c, table.name);

    // A valid table name can still yield an invalid type name (e.g. `_1` → `1`,
    // or a leading combining mark once the underscore before it is dropped).
    const typeName = pascalCase(table.name);
    if (!isIdentifier(typeName)) {
      throw new Error(
        `\`db pull\` cannot generate code for table ${JSON.stringify(table.name)}: ` +
          `its TypeScript type name ${JSON.stringify(typeName)} is not a valid identifier. ` +
          `Rename the table in a migration and re-run \`db pull\`.`,
      );
    }
    if (RESERVED_TYPE_NAMES.has(typeName)) {
      throw new Error(
        `\`db pull\` cannot generate code for table ${JSON.stringify(table.name)}: ` +
          `its TypeScript type name ${JSON.stringify(typeName)} clashes with a name the generated code uses. ` +
          `Rename the table in a migration and re-run \`db pull\`.`,
      );
    }

    // The singular feeds generated method names (get<Singular>, …).
    const singular = resolveSingular(table.name, existingSingulars);
    if (!isIdentifier(singular)) {
      throw new Error(
        `\`db pull\` cannot generate code for table ${JSON.stringify(table.name)}: ` +
          `its singular ${JSON.stringify(singular)} (from database.meta.ts or derived from the table name) ` +
          `is not a valid identifier. Singular names must match ${IDENTIFIER_PATTERN.source}; ` +
          `fix the \`singular\` value in database.meta.ts, or remove it to derive one from the table name.`,
      );
    }
  }
}
