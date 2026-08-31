// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * DSQL-compatible migration runner.
 */

import type { DatabaseEngine } from '@aws-blocks/data-common';
import { splitStatements } from '@aws-blocks/data-common';
import { validateMigrations, classifyStatement } from './validation.js';

/**
 * Run pending migrations against a DSQL engine.
 * DDL runs as implicit transactions, DML in explicit transactions.
 */
export async function runMigrations(
  engine: DatabaseEngine,
  migrations: Record<string, string>,
  options: { validate?: boolean } = {},
): Promise<string[]> {
  if (options.validate !== false) validateMigrations(migrations);

  await engine.execute(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL UNIQUE,
      applied_at TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);

  const applied = await engine.query<{ name: string }>('SELECT name FROM _migrations ORDER BY name');
  const appliedNames = new Set(applied.map(r => r.name));
  const files = Object.keys(migrations).sort();
  const results: string[] = [];

  for (const file of files) {
    if (appliedNames.has(file)) continue;
    const statements = splitStatements(migrations[file]);
    const isDdl = statements.some(s => classifyStatement(s) === 'ddl');

    if (isDdl) {
      for (const stmt of statements) await engine.execute(stmt);
      await engine.execute('INSERT INTO _migrations (name) VALUES ($1)', [file]);
    } else {
      const handle = await engine.beginTransaction();
      try {
        for (const stmt of statements) await engine.executeInTransaction(handle, stmt);
        await engine.executeInTransaction(handle, 'INSERT INTO _migrations (name) VALUES ($1)', [file]);
        await engine.commitTransaction(handle);
      } catch (e) {
        await engine.rollbackTransaction(handle).catch(() => {});
        const err = e as any;
        console.error(`[bb-distributed-data] Migration failed: ${file}`, { code: err.code, severity: err.severity });
        throw e;
      }
    }
    results.push(file);
    console.log(`[bb-distributed-data] Applied: ${file}`);
  }
  return results;
}

export async function loadMigrationsFromDir(dir: string): Promise<Record<string, string>> {
  const { readdirSync, readFileSync } = await import('node:fs');
  const files = readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
  const migrations: Record<string, string> = {};
  for (const file of files) migrations[file] = readFileSync(`${dir}/${file}`, 'utf-8');
  return migrations;
}
