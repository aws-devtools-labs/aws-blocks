// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { coreMismatchError } from './core-load.js';

const PACKAGE = fileURLToPath(new URL('../../', import.meta.url));
const { version, dependencies } = JSON.parse(readFileSync(join(PACKAGE, 'package.json'), 'utf-8')) as {
	version: string;
	dependencies: Record<string, string>;
};

/** `text` as a regular expression that matches it literally. */
function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * An app with this CLI installed and an `@aws-cdk-blocks/core` 0.0.1 that has none of the
 * entries the CLI loads, as an upgrade that kept an older core leaves it.
 */
function appWithOldCore(): string {
	const app = mkdtempSync(join(tmpdir(), 'blocks-cli-old-core-'));
	writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'old-core-app', type: 'module' }));
	mkdirSync(join(app, 'cdk-blocks'));
	writeFileSync(join(app, 'cdk-blocks', 'index.ts'), 'export {};\n');
	const blocks = join(app, 'node_modules', 'aws-cdk-blocks');
	cpSync(join(PACKAGE, 'package.json'), join(blocks, 'package.json'));
	cpSync(join(PACKAGE, 'dist', 'cli'), join(blocks, 'dist', 'cli'), { recursive: true });
	const core = join(app, 'node_modules', '@aws-cdk-blocks', 'core');
	mkdirSync(core, { recursive: true });
	writeFileSync(
		join(core, 'package.json'),
		JSON.stringify({ name: '@aws-cdk-blocks/core', version: '0.0.1', type: 'module', exports: { '.': './index.js' } }),
	);
	writeFileSync(join(core, 'index.js'), 'export {};\n');
	return app;
}

function blocks(app: string, ...argv: string[]) {
	return spawnSync(process.execPath, ['--input-type=module', '-e', "import 'aws-cdk-blocks/run'", '--', ...argv], {
		cwd: app,
		encoding: 'utf-8',
		env: { ...process.env, CI: '1' },
	});
}

describe('an installed @aws-cdk-blocks/core that does not match the CLI', () => {
	it('fails a command that needs core with a clear reinstall message, and keeps --version and --help', () => {
		const app = appWithOldCore();
		const run = blocks(app, 'whoami');
		assert.strictEqual(run.status, 1, run.stderr);
		const lines = run.stderr.split('\n');
		assert.match(
			lines[0],
			new RegExp(
				`^Error: aws-cdk-blocks ${escapeRegExp(version)} cannot load @aws-cdk-blocks/core 0\\.0\\.1, which does not match it: Package subpath '\\./scripts' is not defined by "exports"`,
			),
		);
		assert.ok(
			lines.includes(
				`Try: reinstall @aws-cdk-blocks/core to match aws-cdk-blocks ${version}: npm install '@aws-cdk-blocks/core@${dependencies['@aws-cdk-blocks/core']}'`,
			),
			run.stderr,
		);
		assert.doesNotMatch(run.stderr, /\n\s+at /, 'no stack trace without --debug');
		for (const argv of [['--version'], ['--help'], ['dev', '--help']]) {
			const ok = blocks(app, ...argv);
			assert.strictEqual(ok.status, 0, `${argv.join(' ')}: ${ok.stderr}`);
		}
		assert.strictEqual(blocks(app, '--version').stdout, `${version}\n`);
	});

	it('names the failure only when loading core failed', () => {
		const notExported = Object.assign(
			new Error(`Package subpath './scripts/dev-pidfile' is not defined by "exports" in /app/node_modules/@aws-cdk-blocks/core/package.json`),
			{ code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' },
		);
		// Node's message on Windows names the package by its path, with backslashes.
		const notExportedOnWindows = Object.assign(
			new Error(
				`Package subpath './scripts' is not defined by "exports" in C:\\app\\node_modules\\@aws-cdk-blocks\\core\\package.json`,
			),
			{ code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' },
		);
		const missingExport = new SyntaxError(
			"The requested module '@aws-cdk-blocks/core/scripts' does not provide an export named 'claimDevSession'",
		);
		const notInstalled = Object.assign(new Error("Cannot find package '@aws-cdk-blocks/core' imported from /app/x.js"), {
			code: 'ERR_MODULE_NOT_FOUND',
		});
		for (const error of [notExported, notExportedOnWindows, missingExport, notInstalled]) {
			assert.match(coreMismatchError(error)?.message ?? '', /cannot load @aws-cdk-blocks\/core.*, which does not match it: /);
		}
		const other = Object.assign(new Error("Cannot find package 'left-pad' imported from /app/x.js"), {
			code: 'ERR_MODULE_NOT_FOUND',
		});
		for (const error of [other, new SyntaxError('Unexpected token'), new TypeError('@aws-cdk-blocks/core broke'), 'x']) {
			assert.strictEqual(coreMismatchError(error), undefined);
		}
	});
});
