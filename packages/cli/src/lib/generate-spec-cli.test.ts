/**
 * Integration test for the `blocks-generate-spec` bin.
 *
 * Verifies:
 *   1. The CLI accepts a `.ts` entry point (regression for the
 *      "Unknown file extension .ts" failure that broke fresh scaffolds).
 *   2. The CLI still accepts a `.js` entry point and does not require tsx.
 *
 * Spawns the bin as a child process, the same way an end user (or `npx`) would.
 * The "tsx missing" branch is covered by manual review — it's hard to
 * simulate inside this monorepo where `tsx` is hoisted at the workspace root.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { writeFileSync, mkdirSync, rmSync, readFileSync, existsSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliPath = join(__dirname, 'generate-spec-cli.js');
// The CLI package has no `api.js` of its own; resolve the real built marker
// module from `@aws-blocks/core`'s dist so the fixture's relative import
// resolves the same ApiNamespace symbol the spec emitter discovers.
const coreApiJs = join(dirname(createRequire(import.meta.url).resolve('@aws-blocks/core')), 'api.js');

function makeBackend(dir: string, ext: 'ts' | 'js'): string {
	// Copy the marker module next to the foundation so a relative import
	// resolves through both ESM and CJS loaders.
	copyFileSync(coreApiJs, join(dir, 'api.js'));

	const indexPath = join(dir, `index.${ext}`);
	writeFileSync(indexPath, `
		import { ApiNamespace } from './api.js';

		export const api = new ApiNamespace(null, 'api', (context) => ({
			async ping() { return { ok: true }; },
			async echo(s) { return s; },
		}));
	`);
	// tsconfig that allows JS so the spec emitter's TypeScript pass succeeds
	// regardless of which extension the entry point uses.
	writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({
		compilerOptions: {
			target: 'ESNext',
			module: 'ESNext',
			moduleResolution: 'bundler',
			allowJs: true,
			esModuleInterop: true,
			skipLibCheck: true,
		},
	}));
	return indexPath;
}

function runCli(args: string[], env: NodeJS.ProcessEnv = process.env) {
	return spawnSync(process.execPath, [cliPath, ...args], {
		encoding: 'utf-8',
		env,
	});
}

describe('blocks-generate-spec CLI', () => {
	it('accepts a TypeScript entry point and emits a valid spec', async () => {
		const dir = join(tmpdir(), `blocks-spec-cli-test-${Date.now()}-ts`);
		mkdirSync(dir, { recursive: true });
		const indexPath = makeBackend(dir, 'ts');
		const outputPath = join(dir, 'blocks.spec.json');

		try {
			const result = runCli([indexPath, outputPath]);
			assert.strictEqual(
				result.status,
				0,
				`CLI exited ${result.status}.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
			);
			assert.ok(existsSync(outputPath), 'spec file should exist');
			const spec = JSON.parse(readFileSync(outputPath, 'utf-8'));
			const methodNames = (spec.methods as { name: string }[]).map((m) => m.name).sort();
			assert.deepStrictEqual(methodNames, ['api.echo', 'api.ping']);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('accepts a JavaScript entry point (no tsx needed)', async () => {
		const dir = join(tmpdir(), `blocks-spec-cli-test-${Date.now()}-js`);
		mkdirSync(dir, { recursive: true });
		const indexPath = makeBackend(dir, 'js');
		const outputPath = join(dir, 'blocks.spec.json');

		try {
			const result = runCli([indexPath, outputPath]);
			assert.strictEqual(
				result.status,
				0,
				`CLI exited ${result.status}.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
			);
			const spec = JSON.parse(readFileSync(outputPath, 'utf-8'));
			const methodNames = (spec.methods as { name: string }[]).map((m) => m.name).sort();
			assert.deepStrictEqual(methodNames, ['api.echo', 'api.ping']);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

});
