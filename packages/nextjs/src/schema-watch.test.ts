// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { startSchemaSync } from './schema-watch.js';

let dir: string;
let migrations: string;
let out: string;

/** Poll until `predicate` holds, or fail. The watcher is asynchronous by design. */
async function eventually(predicate: () => boolean, what: string, timeoutMs = 30_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise((r) => setTimeout(r, 100));
	}
	assert.fail(`timed out waiting for ${what}`);
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'schema-watch-test-'));
	migrations = join(dir, 'migrations');
	out = join(dir, 'generated');
	mkdirSync(migrations, { recursive: true });
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe('startSchemaSync', () => {
	it('generates types on start', async () => {
		writeFileSync(join(migrations, '001_notes.sql'), 'CREATE TABLE notes (id SERIAL PRIMARY KEY, text TEXT);');

		startSchemaSync({ migrationsPath: migrations, outDir: out });

		await eventually(() => existsSync(join(out, 'database.types.ts')), 'initial type generation');
		assert.match(readFileSync(join(out, 'database.types.ts'), 'utf-8'), /export interface Notes \{/);
	});

	it('regenerates when a migration is added, with no command run', async () => {
		writeFileSync(join(migrations, '001_notes.sql'), 'CREATE TABLE notes (id SERIAL PRIMARY KEY, text TEXT);');
		startSchemaSync({ migrationsPath: migrations, outDir: out });
		await eventually(() => existsSync(join(out, 'database.types.ts')), 'initial type generation');

		// The headline behavior: save a .sql file, types follow.
		writeFileSync(join(migrations, '002_priority.sql'), 'ALTER TABLE notes ADD COLUMN priority INTEGER;');

		await eventually(
			() => /priority: number \| null;/.test(readFileSync(join(out, 'database.types.ts'), 'utf-8')),
			'the new column to appear in the generated types',
		);
	});

	it('is a no-op when the migrations directory is absent', () => {
		// The common "app with no database" case must not throw or create anything.
		assert.doesNotThrow(() => startSchemaSync({ migrationsPath: join(dir, 'nope'), outDir: out }));
		assert.equal(existsSync(out), false);
	});

	it('keeps watching after a migration with a syntax error', async () => {
		writeFileSync(join(migrations, '001_notes.sql'), 'CREATE TABLE notes (id SERIAL PRIMARY KEY);');
		startSchemaSync({ migrationsPath: migrations, outDir: out });
		await eventually(() => existsSync(join(out, 'database.types.ts')), 'initial type generation');

		// A broken file is a normal mid-edit state; it must not kill the watcher.
		writeFileSync(join(migrations, '002_broken.sql'), 'CREATE TABL oops (');
		await new Promise((r) => setTimeout(r, 2000));

		// Fixing it recovers without restarting the dev server.
		writeFileSync(join(migrations, '002_broken.sql'), 'ALTER TABLE notes ADD COLUMN fixed BOOLEAN;');
		await eventually(
			() => /fixed: boolean \| null;/.test(readFileSync(join(out, 'database.types.ts'), 'utf-8')),
			'recovery after the migration was fixed',
		);
	});
});
