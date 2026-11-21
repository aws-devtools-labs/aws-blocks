// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * `@aws-cdk-blocks/core/scripts` in an app that has no `typescript` package (a Nuxt or
 * Astro project that AWS CDK Blocks was added to): every script loads, and spec
 * generation falls back to `unknown` types with a warning that says what to install.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';

/**
 * A resolve hook that fails every import of `typescript` with `code` and `message`
 * (`PARENT` stands for the importing module's URL). By default, as Node fails it when
 * the package isn't installed.
 */
function typeScriptHook(
	code = 'ERR_MODULE_NOT_FOUND',
	message = "Cannot find package 'typescript' imported from PARENT",
): string {
	return `export async function resolve(specifier, context, next) {
	if (specifier === 'typescript' || specifier.startsWith('typescript/')) {
		const error = new Error(${JSON.stringify(message)}.replace('PARENT', context.parentURL));
		error.code = ${JSON.stringify(code)};
		throw error;
	}
	return next(specifier, context);
}`;
}

/** Run `source` as an ES module in a Node process where importing `typescript` fails through `hook`. */
function runWithoutTypeScript(
	source: string,
	hook = typeScriptHook(),
): { status: number | null; stdout: string; stderr: string } {
	const register = `import { register } from 'node:module'; register(${JSON.stringify(`data:text/javascript,${encodeURIComponent(hook)}`)});`;
	const result = spawnSync(
		process.execPath,
		['--import', `data:text/javascript,${encodeURIComponent(register)}`, '--input-type=module', '-e', source],
		{ encoding: 'utf-8' },
	);
	return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const scriptsIndex = pathToFileURL(join(import.meta.dirname, 'index.js')).href;
const generateSpecModule = pathToFileURL(join(import.meta.dirname, 'generate-spec.js')).href;
const apiModule = pathToFileURL(join(import.meta.dirname, '..', 'api.js')).href;

describe('@aws-cdk-blocks/core/scripts without the typescript package', () => {
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

	/** Generate the spec of a backend with one `ApiNamespace` method, with `typescript` failing through `hook`. */
	function generateSpecWithoutTypeScript(hook?: string) {
		const backend = join(dir, 'index.js');
		writeFileSync(
			backend,
			`import { ApiNamespace } from ${JSON.stringify(apiModule)};
			export const api = new ApiNamespace(null, 'api', () => ({
				/** @blocksSkipCodegen */
				async echo(text) { return text; },
			}));\n`,
		);
		return runWithoutTypeScript(
			`const { generateSpec } = await import(${JSON.stringify(generateSpecModule)});
			const doc = await generateSpec(${JSON.stringify(backend)});
			console.log(JSON.stringify(doc.methods));`,
			hook,
		);
	}

	it('generates the spec with unknown types and says to install typescript', () => {
		const run = generateSpecWithoutTypeScript();
		assert.equal(run.status, 0, run.stderr);
		const methods: { name: string; params: { schema: unknown }[]; result: { schema: unknown } }[] = JSON.parse(
			run.stdout.trim(),
		);
		assert.deepEqual(
			methods.map((m) => m.name),
			['api.echo'],
			'a method tagged @blocksSkipCodegen stays in the spec without the compiler',
		);
		const [echo] = methods;
		assert.ok(echo.params.length > 0, run.stdout);
		for (const param of echo.params) assert.deepEqual(param.schema, { type: 'unknown' });
		assert.deepEqual(echo.result.schema, { type: 'unknown' });
		assert.match(
			run.stderr,
			/the "typescript" package is not installed; install it with `npm install --save-dev typescript`/,
		);
		assert.match(run.stderr, /methods tagged @blocksSkipCodegen are not skipped/);
	});

	it('keeps the error of a typescript that is installed but does not load', () => {
		const brokenExports = typeScriptHook(
			'ERR_PACKAGE_PATH_NOT_EXPORTED',
			'Package subpath \'.\' is not defined by "exports" in /app/node_modules/typescript/package.json imported from PARENT',
		);
		const run = generateSpecWithoutTypeScript(brokenExports);
		assert.equal(run.status, 0, run.stderr);
		assert.match(run.stderr, /is not defined by "exports" in \/app\/node_modules\/typescript\/package\.json/);
		assert.doesNotMatch(run.stderr, /is not installed/);
	});
});
