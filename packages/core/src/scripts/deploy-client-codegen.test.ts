// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * Regression test: `deploy()` (production mode) never exited after a successful
 * deploy. Its client-generation step imported the app IN-PROCESS under default
 * conditions, which loads every Building Block's local MOCK layer — and mocks
 * own long-lived, ref'd handles (e.g. the PGlite engine behind `Database`
 * re-arms an emulated `setitimer`; `CronJob` fires on schedule). Those kept the
 * deploy CLI's event loop alive forever, so a caller blocked on it never resumed.
 *
 * The fixture app imports a fake Building Block whose mock layer starts a
 * ref'd interval (a stand-in for any mock runtime). Its aws-runtime layer holds
 * a ref'd handle too, so the client-generation worker must also exit on its own. The step runs in a child process; a hang shows up as a
 * timeout instead of hanging this suite.
 */

const distScripts = dirname(fileURLToPath(import.meta.url));
const corePkgRoot = join(distScripts, '..', '..');
const STEP_TIMEOUT_MS = 30_000;

describe('generateDeployClient — the client-generation step of deploy()', () => {
	let tmp: string;
	let result: ReturnType<typeof spawnSync>;
	let stdout: string;
	const clientPath = () => join(tmp, 'aws-blocks', 'client.js');

	before(() => {
		tmp = mkdtempSync(join(tmpdir(), 'blocks-deploy-codegen-'));
		writeFileSync(join(tmp, 'package.json'), JSON.stringify({ name: 'fixture-app', type: 'module' }));

		// A fake Building Block with conditional exports, like every real BB.
		const bb = join(tmp, 'node_modules', 'fake-bb');
		mkdirSync(bb, { recursive: true });
		writeFileSync(
			join(bb, 'package.json'),
			JSON.stringify({
				name: 'fake-bb',
				type: 'module',
				exports: { '.': { 'aws-runtime': './aws.mjs', default: './mock.mjs' } },
			}),
		);
		const register = `const { Scope } = await import(process.env.FX_CORE_COMMON_URL);
new Scope('thing', { bbName: 'KVStore', bbVersion: '9.9.9' });`;
		// Mock layer: a long-lived ref'd handle, like a local scheduler or engine.
		writeFileSync(
			join(bb, 'mock.mjs'),
			`${register}\nconsole.log('FAKE_BB_MOCK_LOADED');\nsetInterval(() => {}, 1000);\n`,
		);
		// aws-runtime layer: registers; also holds a ref'd handle (an SDK client's
		// keep-alive socket, a pool, …) — the worker must exit anyway once the
		// client is written, or `deploy()` blocks on it.
		writeFileSync(join(bb, 'aws.mjs'), `${register}\nsetInterval(() => {}, 1000);\n`);

		mkdirSync(join(tmp, 'aws-blocks'), { recursive: true });
		const foundationPath = join(tmp, 'aws-blocks', 'index.ts');
		writeFileSync(foundationPath, `import 'fake-bb';\nexport const api = { hello: async () => 'hi' };\n`);

		const coreCommonUrl = pathToFileURL(join(distScripts, '..', 'common', 'index.js')).href;
		const runner = join(tmp, 'runner.mjs');
		writeFileSync(
			runner,
			`import { generateDeployClient } from ${JSON.stringify(pathToFileURL(join(distScripts, 'deploy-client-codegen.js')).href)};
const { Scope } = await import(${JSON.stringify(coreCommonUrl)});
await generateDeployClient(${JSON.stringify(foundationPath)}, ${JSON.stringify(clientPath())});
console.log('REGISTRY ' + JSON.stringify(Scope.getRegisteredBlocks()));
`,
		);

		result = spawnSync(process.execPath, [runner], {
			// `--import tsx` in the worker resolves from cwd; the core package resolves it.
			cwd: corePkgRoot,
			env: { ...process.env, NODE_OPTIONS: '', FX_CORE_COMMON_URL: coreCommonUrl },
			encoding: 'utf-8',
			timeout: STEP_TIMEOUT_MS,
			killSignal: 'SIGKILL',
		});
		stdout = String(result.stdout ?? '');
	});

	after(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it(`exits on its own (within ${STEP_TIMEOUT_MS / 1000}s) after generating the client`, () => {
		assert.strictEqual(
			result.signal,
			null,
			`the step was still running after ${STEP_TIMEOUT_MS}ms — something kept the event loop alive.\nstdout:\n${stdout}\nstderr:\n${String(result.stderr ?? '')}`,
		);
		assert.strictEqual(result.status, 0, `stderr:\n${String(result.stderr ?? '')}`);
	});

	it("never loads a Building Block's local mock layer", () => {
		assert.ok(!stdout.includes('FAKE_BB_MOCK_LOADED'), `mock layer was loaded:\n${stdout}`);
	});

	it('writes the client for the deployed backend', () => {
		assert.ok(existsSync(clientPath()), 'client.js was not written');
		assert.match(readFileSync(clientPath(), 'utf-8'), /export const api = /);
	});

	it("populates this process's Scope BB registry for the deploy telemetry event", () => {
		const line = stdout.split('\n').find((l) => l.startsWith('REGISTRY '));
		assert.ok(line, `no registry line in stdout:\n${stdout}`);
		const registry = JSON.parse(line.slice('REGISTRY '.length));
		assert.deepStrictEqual(registry.blocks, [{ name: 'KVStore', version: '9.9.9' }]);
		assert.strictEqual(registry.totalCount, 1);
	});
});
