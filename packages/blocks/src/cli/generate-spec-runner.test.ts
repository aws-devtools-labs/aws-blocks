// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The bytes each stream carries when `cdk-blocks generate spec` runs its runner:
 * progress and detail follow `BLOCKS_LOG_STREAM`, and the `✅` result line stays
 * on stdout. The runner runs with the `tsx` loader against a JavaScript backend,
 * as the CLI starts it.
 */

import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { readNativeDeclarations } from '@aws-blocks/core/scripts';
import { runnerArgs, runnerPath } from './runners/launch.js';

const coreDist = dirname(fileURLToPath(import.meta.resolve('@aws-blocks/core')));

function runSpec(env: NodeJS.ProcessEnv) {
	const dir = mkdtempSync(join(tmpdir(), 'blocks-spec-runner-'));
	try {
		copyFileSync(join(coreDist, 'api.js'), join(dir, 'api.js'));
		const backendPath = join(dir, 'index.js');
		const outputPath = join(dir, 'blocks.spec.json');
		writeFileSync(
			backendPath,
			"import { ApiNamespace } from './api.js';\nexport const api = new ApiNamespace(null, 'api', () => ({ async ping() { return { ok: true }; } }));\n",
		);
		writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
		writeFileSync(
			join(dir, 'tsconfig.json'),
			JSON.stringify({ compilerOptions: { module: 'ESNext', moduleResolution: 'bundler', allowJs: true } }),
		);
		const child = spawnSync(
			process.execPath,
			runnerArgs(dir, runnerPath('generate-spec'), { args: [JSON.stringify({ backendPath, outputPath })] }),
			{ cwd: dir, encoding: 'utf-8', env: { PATH: process.env.PATH, ...env } },
		);
		assert.strictEqual(child.status, 0, child.stderr);
		// Packages installed above tmpdir() can declare native bindings; the line names them.
		const declarers = readNativeDeclarations(backendPath)
			.map((source) => source.sourcePackage)
			.sort();
		return {
			stdout: child.stdout,
			stderr: child.stderr,
			header: '📝 Generating OpenRPC spec...\n',
			details:
				`   backend: ${backendPath}\n   output:  ${outputPath}\n` +
				(declarers.length > 0 ? `   native declarations: ${declarers.join(', ')}\n` : ''),
			result: `✅ OpenRPC spec written to ${outputPath}\n`,
		};
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

describe('cdk-blocks generate spec output streams', () => {
	it('unset: the legacy output is unchanged (everything on stdout)', () => {
		const { stdout, stderr, header, details, result } = runSpec({});
		assert.strictEqual(stdout, header + details + result);
		assert.strictEqual(stderr, '');
	});

	it('BLOCKS_LOG_STREAM=stderr: stdout carries only the result line', () => {
		const { stdout, stderr, header, details, result } = runSpec({
			BLOCKS_LOG_LEVEL: 'verbose',
			BLOCKS_LOG_STREAM: 'stderr',
		});
		assert.strictEqual(stdout, result);
		assert.strictEqual(stderr, header + details);
	});

	it('the CLI default (normal, stderr): the header on stderr, the result on stdout', () => {
		const { stdout, stderr, header, result } = runSpec({ BLOCKS_LOG_LEVEL: 'normal', BLOCKS_LOG_STREAM: 'stderr' });
		assert.strictEqual(stdout, result);
		assert.strictEqual(stderr, header);
	});
});

describe('cdk-blocks generate spec failure', () => {
	it('reports a backend that does not load in one line and exits 1, with the stack only at debug', () => {
		const dir = mkdtempSync(join(tmpdir(), 'blocks-spec-runner-'));
		try {
			const backendPath = join(dir, 'index.ts');
			writeFileSync(backendPath, 'export const api = {;\n');
			writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
			const args = runnerArgs(dir, runnerPath('generate-spec'), {
				args: [JSON.stringify({ backendPath, outputPath: join(dir, 'blocks.spec.json') })],
			});
			const env = { PATH: process.env.PATH, BLOCKS_LOG_STREAM: 'stderr' };
			const normal = spawnSync(process.execPath, args, {
				cwd: dir,
				encoding: 'utf-8',
				env: { ...env, BLOCKS_LOG_LEVEL: 'normal' },
			});
			assert.strictEqual(normal.status, 1, normal.stderr);
			assert.match(normal.stderr, /^❌ Spec generation failed: /m);
			assert.doesNotMatch(normal.stderr, /^\s+at /m);
			const debug = spawnSync(process.execPath, args, {
				cwd: dir,
				encoding: 'utf-8',
				env: { ...env, BLOCKS_LOG_LEVEL: 'debug' },
			});
			assert.strictEqual(debug.status, 1, debug.stderr);
			assert.match(debug.stderr, /^\s+at /m);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
