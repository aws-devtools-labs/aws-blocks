// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Which synced table a SQL statement writes, so a database can tell the client
 * what an API call changed (see `SyncHint`). Conservative: a statement it can't
 * read precisely is reported as a write to an unknown table.
 */

/** Blank out string literals, quoted identifiers' contents stay, and comments, so keywords inside them don't match. */
function stripLiterals(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\$([A-Za-z_]*)\$[\s\S]*?\$\1\$/g, "''")
    .replace(/'(?:[^']|'')*'/g, "''");
}

const PLAIN_WRITE = /^\s*(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+((?:"?[a-z_][a-z0-9_]*"?\.)?"?[a-z_][a-z0-9_]*"?)/i;
const ANY_WRITE = /^\s*(?:WITH\b[\s\S]*\b)?(?:INSERT|UPDATE|DELETE|MERGE)\b/i;

/**
 * Classify a statement: `null` if it writes no synced table; otherwise the
 * synced table (empty string if unknown) and whether it is a single plain
 * statement without its own `RETURNING` (so `RETURNING` can be appended).
 */
export function classifyWrite(sql: string, tables: string[]): { table: string; plain: boolean } | null {
  const cleaned = stripLiterals(sql).trim();
  const match = PLAIN_WRITE.exec(cleaned);
  if (!match) return ANY_WRITE.test(cleaned) ? { table: '', plain: false } : null;
  const name = match[1].replace(/"/g, '').toLowerCase();
  const table = tables.find((t) => t === name || `public.${t}` === name || t === `public.${name}`);
  if (!table) return null;
  const single = !cleaned.replace(/;\s*$/, '').includes(';');
  return { table, plain: single && !/\bRETURNING\b/i.test(cleaned) };
}
