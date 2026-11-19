// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `@aws-blocks/core/scripts` in an app that has no `typescript` package (a Nuxt or
 * Astro project that AWS Blocks was added to): every script loads, and spec
 * generation falls back to `unknown` types with a warning that says what to install.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';

/** A resolve hook that answers every import of `typescript` as Node does when it isn't installed. */
const NO_TYPESCRIPT_HOOK = `export async function resolve(specifier, context, next) {
	if (specifier === 'typescript' || specifier.startsWith('typescript/')) {
		const error = new Error("Cannot find package 'typescript' imported from " + context.parentURL);
		error.code = 'ERR_MODULE_NOT_FOUND';
		throw error;
	}
	return next(specifier, context);
}`;
const REGISTER_HOOK = `import { register } from 'node:module'; register(${JSON.stringify(`data:text/javascript,${encodeURIComponent(NO_TYPESCRIPT_HOOK)}`)});`;

/** Run `source` as an ES module in a Node process where `typescript` can't be resolved. */
function runWithoutTypeScript(source: string): { status: number | null; stdout: string; stderr: string } {
	const result = spawnSync(
		process.execPath,
		['--import', `data:text/javascript,${encodeURIComponent(REGISTER_HOOK)}`, '--input-type=module', '-e', source],
		{ encoding: 'utf-8' },
	);
	return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const scriptsIndex = pathToFileURL(join(import.meta.dirname, 'index.js')).href;
const generateSpecModule = pathToFileURL(join(import.meta.dirname, 'generate-spec.js')).href;

describe('@aws-blocks/core/scripts without the typescript package', () => {
	const dir = mkdtempSync(join(tmpdir(), 'blocks-no-typescript-'));
	after(() => rmSync(dir, { recursive: true, force: true }));

	it('the hook makes typescript unresolvable', () => {
		const run = runWithoutTypeScript(`await import('typescript');`);
		assert.notEqual(run.status, 0);
		assert.match(run.stderr, /Cannot find package 'typescript'/);
	});

	it('loads every script', () => {
		const run = runWithoutTypeScript(
			`const scripts = await import(${JSON.stringify(scriptsIndex)}); console.log(typeof scripts.generateSpec);`,
		);
		assert.equal(run.status, 0, run.stderr);
		assert.equal(run.stdout.trim(), 'function');
	});

	it('generates the spec with unknown types and says to install typescript', () => {
		const backend = join(dir, 'index.js');
		writeFileSync(backend, 'export const notAnApi = 1;\n');
		const run = runWithoutTypeScript(
			`const { generateSpec } = await import(${JSON.stringify(generateSpecModule)});
			const doc = await generateSpec(${JSON.stringify(backend)});
			console.log(JSON.stringify(doc.methods));`,
		);
		assert.equal(run.status, 0, run.stderr);
		assert.equal(run.stdout.trim(), '[]');
		assert.match(run.stderr, /the "typescript" package is not installed; install it with `npm install --save-dev typescript`/);
	});
});
