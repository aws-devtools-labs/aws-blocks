// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/** Helpers for the `bb-auth migrate` tests: stage a fixture case, run the codemod, read the result. */

import assert from 'node:assert';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { runMigrate } from '../migrate/cli.js';

export const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');
export const FIXTURES = join(SRC_DIR, '__fixtures__', 'migrate');

/** Copy `<case>/input` into a fresh temp dir, dropping the `.txt` suffix. */
export function stageCase(name: string): string {
	const dir = mkdtempSync(join(tmpdir(), `bb-auth-migrate-${name}-`));
	copyStripped(join(FIXTURES, name, 'input'), dir);
	return dir;
}

function copyStripped(from: string, to: string): void {
	mkdirSync(to, { recursive: true });
	for (const entry of readdirSync(from, { withFileTypes: true })) {
		if (entry.isDirectory()) copyStripped(join(from, entry.name), join(to, entry.name));
		else cpSync(join(from, entry.name), join(to, entry.name.replace(/\.txt$/, '')));
	}
}

export function readTree(dir: string): Record<string, string> {
	const out: Record<string, string> = {};
	const walk = (d: string): void => {
		for (const entry of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
			const p = join(d, entry.name);
			if (entry.isDirectory()) walk(p);
			else out[relative(dir, p).replace(/\.txt$/, '')] = readFileSync(p, 'utf8');
		}
	};
	walk(dir);
	return out;
}

export async function migrate(
	dir: string,
	dryRun = false,
): Promise<{ changed: string[]; todos: number; log: string[] }> {
	const log: string[] = [];
	const summary = await runMigrate({ cwd: dir, ts, dryRun, log: (l) => log.push(l) });
	assert.deepStrictEqual(summary.failed, [], 'no file failed');
	return { changed: summary.changed, todos: summary.todos, log };
}
