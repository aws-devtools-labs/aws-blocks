// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Unit tests for scripts/check-packed-assets.ts. Every case builds a throwaway
// repo in a temp dir and copies the real guard into its scripts/ (the guard roots
// itself at `import.meta.dirname/..`, so the copy sees the fixture as the repo),
// then runs the guard for real: real fs, real `npm pack --dry-run`, no stubs.
//
// Run: node --test scripts/check-packed-assets.test.mjs

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const SCRIPTS_DIR = import.meta.dirname;
const GUARD_NAME = 'check-packed-assets.ts';
const REPO_ROOT = join(SCRIPTS_DIR, '..');

const CDK_ENTRY = `const __dirname = dirname(fileURLToPath(import.meta.url));
new Function(stack, 'Fn', { code: Code.fromAsset(join(__dirname, 'my-lambda')) });
`;

const DEPLOY_TIME_ENTRY = `import { deployTimeLambdaCode } from '@aws-blocks/core/cdk';
const LAMBDA = { moduleUrl: import.meta.url, bundleDir: '../my-lambda', source: './my-lambda' };
new Function(stack, 'Fn', { code: deployTimeLambdaCode(LAMBDA) });
`;

/** A package.json shipping `dist`, plus the given package-relative files. */
function pkg(name, files, manifest = {}) {
	return {
		[`${name}/package.json`]: JSON.stringify({ name: `@aws-blocks/${name}`, version: '0.0.0', files: ['dist'], ...manifest }),
		...Object.fromEntries(Object.entries(files).map(([rel, content]) => [`${name}/${rel}`, content])),
	};
}

/** Builds a fixture repo whose packages/ holds the given files, then runs the guard in it. */
function runGuard(files) {
	const dir = mkdtempSync(join(tmpdir(), 'packed-assets-guard-'));
	try {
		mkdirSync(join(dir, 'scripts'), { recursive: true });
		copyFileSync(join(SCRIPTS_DIR, GUARD_NAME), join(dir, 'scripts', GUARD_NAME));
		for (const [rel, content] of Object.entries(files)) {
			const abs = join(dir, 'packages', rel);
			mkdirSync(join(abs, '..'), { recursive: true });
			writeFileSync(abs, content);
		}
		try {
			const stdout = execFileSync('npx', ['tsx', join(dir, 'scripts', GUARD_NAME)], {
				cwd: REPO_ROOT,
				encoding: 'utf-8',
				stdio: ['ignore', 'pipe', 'pipe'],
			});
			return { code: 0, output: stdout };
		} catch (err) {
			return { code: err.status ?? 1, output: `${err.stdout ?? ''}${err.stderr ?? ''}` };
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

describe('check-packed-assets', () => {
	it('passes when the loaded asset directory is packed', () => {
		const { code, output } = runGuard(
			pkg('bb-thing', { 'dist/index.cdk.js': CDK_ENTRY, 'dist/my-lambda/index.js': 'exports.handler = 1;' }),
		);
		assert.equal(code, 0, output);
		assert.match(output, /✓ @aws-blocks\/bb-thing: dist\/my-lambda\//);
	});

	it('fails when the bundle step never wrote the asset directory', () => {
		const { code, output } = runGuard(pkg('bb-thing', { 'dist/index.cdk.js': CDK_ENTRY }));
		assert.equal(code, 1, output);
		assert.match(output, /@aws-blocks\/bb-thing: dist\/index\.cdk\.js loads dist\/my-lambda\//);
	});

	it('fails when the asset exists on disk but is excluded from the tarball', () => {
		const { code, output } = runGuard(
			pkg(
				'bb-thing',
				{ 'dist/index.cdk.js': CDK_ENTRY, 'dist/my-lambda/index.js': 'exports.handler = 1;' },
				{ files: ['dist/index.cdk.js'] },
			),
		);
		assert.equal(code, 1, output);
		assert.match(output, /loads dist\/my-lambda\//);
	});

	it('resolves the asset relative to the compiled file that loads it', () => {
		const { code, output } = runGuard(
			pkg('bb-thing', {
				'dist/cdk/index.cdk.js': CDK_ENTRY.replace("'my-lambda'", "'../my-lambda'"),
				'dist/my-lambda/index.js': 'exports.handler = 1;',
			}),
		);
		assert.equal(code, 0, output);
		assert.match(output, /✓ @aws-blocks\/bb-thing: dist\/my-lambda\/ \(dist\/cdk\/index\.cdk\.js\)/);
	});

	it('checks the bundleDir of a deployTimeLambdaCode spec, relative to its module', () => {
		const files = { 'dist/cdk/guard.js': DEPLOY_TIME_ENTRY };
		const missing = runGuard(pkg('bb-thing', files));
		assert.equal(missing.code, 1, missing.output);
		assert.match(missing.output, /dist\/cdk\/guard\.js loads dist\/my-lambda\//);

		const packed = runGuard(pkg('bb-thing', { ...files, 'dist/my-lambda/index.js': 'exports.handler = 1;' }));
		assert.equal(packed.code, 0, packed.output);
		assert.match(packed.output, /✓ @aws-blocks\/bb-thing: dist\/my-lambda\/ \(dist\/cdk\/guard\.js\)/);
	});

	it('ignores a bundleDir key in a file that never calls deployTimeLambdaCode', () => {
		const { code, output } = runGuard(
			pkg('bb-thing', {
				'dist/index.cdk.js': CDK_ENTRY,
				'dist/my-lambda/index.js': 'exports.handler = 1;',
				'dist/other.js': "const options = { bundleDir: './elsewhere' };\n",
			}),
		);
		assert.equal(code, 0, output);
		assert.doesNotMatch(output, /elsewhere/);
	});

	it('ignores a bundleDir that only appears in a JSDoc example', () => {
		const { code, output } = runGuard(
			pkg('bb-thing', {
				'dist/index.cdk.js': CDK_ENTRY,
				'dist/my-lambda/index.js': 'exports.handler = 1;',
				'dist/lambda-code.js': "/**\n * @example\n * deployTimeLambdaCode({ bundleDir: './example-lambda' })\n */\nexport function deployTimeLambdaCode(spec) {}\n",
			}),
		);
		assert.equal(code, 0, output);
		assert.doesNotMatch(output, /example-lambda/);
	});

	it('skips private packages, which are never published', () => {
		const { code, output } = runGuard({
			...pkg('bb-thing', { 'dist/index.cdk.js': CDK_ENTRY, 'dist/my-lambda/index.js': 'exports.handler = 1;' }),
			...pkg('internal', { 'dist/index.cdk.js': CDK_ENTRY }, { private: true }),
		});
		assert.equal(code, 0, output);
		assert.doesNotMatch(output, /internal/);
	});

	it('fails rather than passing when nothing is built', () => {
		const { code, output } = runGuard(pkg('bb-thing', { 'src/index.cdk.ts': CDK_ENTRY }));
		assert.equal(code, 1, output);
		assert.match(output, /found no Code\.fromAsset\(join\(__dirname, \.\.\.\)\) or deployTimeLambdaCode/);
	});
});
