// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// On-disk fixtures for the unit tests. Not part of the public package: compiled into `dist/` next to the
// tests, never imported from an entry file.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

export function removeFixtures(): void {
	for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
}
