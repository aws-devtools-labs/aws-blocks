// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Regex matching a valid PostgreSQL dollar-quote opening tag.
 * Matches $$ (empty tag) or $identifier$ where the identifier starts with a
 * letter/underscore. Does NOT match positional params like $1, $2, $10.
 */
export const DOLLAR_QUOTE_TAG_RE = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/;

/**
 * Split a SQL file into individual statements.
 *
 * Handles:
 * - Standard semicolon-delimited statements
 * - Dollar-quoted blocks (DO $$ ... $$, $tag$ ... $tag$)
 * - Semicolons inside single-quoted string literals
 * - Line comments (-- ...) and block comments containing semicolons
 * - Positional bind parameters ($1, $2) are NOT treated as dollar-quote tags
 *
 * Does NOT handle:
 * - Nested dollar-quoting with different tags
 */
export const splitStatements = (sql: string): string[] => {
  const statements: string[] = [];
  let current = '';
  let i = 0;

  while (i < sql.length) {
    // Single-quoted string literal — skip to closing quote
    if (sql[i] === "'") {
      current += sql[i++];
      while (i < sql.length) {
        current += sql[i];
        if (sql[i] === "'" && sql[i + 1] !== "'") { i++; break; }
        if (sql[i] === "'" && sql[i + 1] === "'") { current += sql[++i]; } // escaped ''
        i++;
      }
      continue;
    }

    // Line comment — skip to end of line (do NOT split on ';' inside)
    if (sql[i] === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i++;
      continue;
    }

    // Block comment — skip to closing '*/' (do NOT split on ';' inside)
    if (sql[i] === '/' && sql[i + 1] === '*') {
      i += 2;
      while (i < sql.length) {
        if (sql[i] === '*' && sql[i + 1] === '/') { i += 2; break; }
        i++;
      }
      continue;
    }

    // psql meta-command (e.g. pg_dump 17/18's `\restrict` / `\unrestrict`).
    // These are line-terminated psql directives, not SQL, and
    // would fail with `syntax error at or near "\"` if executed over the pg wire
    // protocol. They only appear between statements, so skip the whole line when
    // we're at the start of a statement (outside any quote/comment) — a real SQL
    // statement never begins with a backslash. A backslash *inside* a statement
    // or string literal has a non-empty `current` and is handled normally.
    if (sql[i] === '\\' && current.trim() === '') {
      while (i < sql.length && sql[i] !== '\n') i++;
      continue;
    }

    // Dollar-quoted block — a valid tag is $$ or $tag$ where tag starts with
    // a letter/underscore. Positional params like $1 are NOT dollar-quote openers.
    if (sql[i] === '$') {
      const tagMatch = sql.slice(i).match(DOLLAR_QUOTE_TAG_RE);
      if (tagMatch) {
        const tag = tagMatch[0];
        current += tag;
        i += tag.length;
        const closeIdx = sql.indexOf(tag, i);
        if (closeIdx !== -1) {
          current += sql.slice(i, closeIdx + tag.length);
          i = closeIdx + tag.length;
        }
        continue;
      }
    }

    // Statement terminator
    if (sql[i] === ';') {
      const trimmed = current.trim();
      if (trimmed.length > 0) statements.push(trimmed);
      current = '';
      i++;
      continue;
    }

    current += sql[i++];
  }

  const trimmed = current.trim();
  if (trimmed.length > 0) statements.push(trimmed);
  return statements;
};
