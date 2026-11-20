// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// On-disk fixtures for the unit tests. Not part of the public package: compiled into `dist/` next to the
// tests, never imported from an entry file.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLAIMS_SETTING } from '../constants.js';

const created: string[] = [];

/** A fresh temporary directory, removed by `removeFixtures()` (which `installLocalTestHooks()` calls in `after`). */
export function tempDir(prefix = 'bb-database-test-'): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	created.push(dir);
	return dir;
}

/** Writes `files` (name → SQL) into a fresh temporary directory and returns its path, for `migrationsPath`. */
export function migrations(files: Record<string, string>): string {
	const dir = tempDir('bb-database-migrations-');
	for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
	return dir;
}

/**
 * A migration for "policies written for a role": a `todos` table that only the `authenticated` role reads, each
 * row by its owner (the `sub` claim). It does not grant the role to the app role; a test adds that line.
 */
export const ROLE_TODOS = [
	'CREATE ROLE authenticated NOLOGIN;',
	'CREATE TABLE todos (id SERIAL PRIMARY KEY, owner_id TEXT NOT NULL, title TEXT NOT NULL);',
	'ALTER TABLE todos ENABLE ROW LEVEL SECURITY;',
	'GRANT SELECT ON todos TO authenticated;',
	`CREATE POLICY todos_owner ON todos FOR SELECT TO authenticated USING (owner_id = nullif(current_setting('${CLAIMS_SETTING}', true), '')::jsonb ->> 'sub');`,
	"INSERT INTO todos (owner_id, title) VALUES ('alice', 'a1'), ('bob', 'b1');",
].join('\n');

export function removeFixtures(): void {
	for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
}
