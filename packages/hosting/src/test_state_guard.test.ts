// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * The guard `npm test` loads (`scripts/test-state-guard.mjs`): since the package's test files share one process,
 * it fails the file that leaves process-wide state changed and puts the state back before the next file. Runs the
 * guard the way `npm test` does, on fixture files in a temp dir.
 */

import assert from 'node:assert';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const GUARD = fileURLToPath(new URL('../scripts/test-state-guard.mjs', import.meta.url));

const FIXTURES: Record<string, string> = {
	'1-leaks-in-a-test.test.mjs': `
import { test } from 'node:test';
test('sets an env var and does not restore it', () => {
	process.env.STATE_GUARD_LEAK = '1';
});
`,
	'2-leaks-at-module-scope.test.mjs': `
import { test } from 'node:test';
console.warn = () => {};
test('runs', () => {});
`,
	'3-restores.test.mjs': `
import assert from 'node:assert';
import { tmpdir } from 'node:os';
import { after, before, describe, it } from 'node:test';
describe('changes state for its tests and restores it', () => {
	const cwd = process.cwd();
	const log = console.log;
	before(() => {
		process.env.STATE_GUARD_RESTORED = '1';
		process.chdir(tmpdir());
		console.log = () => {};
	});
	after(() => {
		delete process.env.STATE_GUARD_RESTORED;
		process.chdir(cwd);
		console.log = log;
	});
	it('sees the changed state', () => assert.equal(process.env.STATE_GUARD_RESTORED, '1'));
});
`,
	'4-later.test.mjs': `
import assert from 'node:assert';
import { test } from 'node:test';
test('starts from the original state', () => {
	assert.equal(process.env.STATE_GUARD_LEAK, undefined);
	assert.equal(console.warn.name, 'warn');
});
`,
};

const dir = mkdtempSync(join(tmpdir(), 'hosting-state-guard-'));
after(() => rmSync(dir, { recursive: true, force: true }));
for (const [name, source] of Object.entries(FIXTURES)) writeFileSync(join(dir, name), source);

/** Stands in for a Node 22 older than 22.15, which has no `module.registerHooks`. */
const WITHOUT_REGISTER_HOOKS = "data:text/javascript,import m from 'node:module'; delete m.registerHooks;";

/** Runs fixtures in one process with the guard, as `npm test` runs the package's tests. */
async function runFixtures(
	files: string[] = Object.keys(FIXTURES),
	preload: string[] = [],
): Promise<{ code: number | null; output: string }> {
	const env = { ...process.env };
	// Set when this file itself runs in a per-file test process; the inner runner would then report to us in v8 format.
	delete env.NODE_TEST_CONTEXT;
	delete env.NODE_OPTIONS;
	const imports = [...preload, GUARD].flatMap((specifier) => ['--import', specifier]);
	const args = ['--test', '--experimental-test-isolation=none', ...imports, '--test-reporter=tap'];
	const child = spawn(process.execPath, [...args, ...files], { cwd: dir, env });
	let output = '';
	child.stdout.on('data', (chunk: Buffer) => {
		output += chunk.toString('utf8');
	});
	child.stderr.on('data', (chunk: Buffer) => {
		output += chunk.toString('utf8');
	});
	const [code] = await once(child, 'close');
	return { code, output };
}

void describe('test-state guard', () => {
	void it('fails exactly the files that leave global state changed, and later files start clean', async () => {
		const { code, output } = await runFixtures();
		const failed = [...output.matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1]);
		assert.deepStrictEqual(
			failed,
			[
				'global state restored: 1-leaks-in-a-test.test.mjs',
				'global state restored: 2-leaks-at-module-scope.test.mjs (module scope)',
			],
			output,
		);
		assert.equal(code, 1, output);
		assert.match(output, /1-leaks-in-a-test\.test\.mjs left process-wide state changed after its tests/);
		assert.match(output, /process\.env\.STATE_GUARD_LEAK was set/);
		assert.match(output, /2-leaks-at-module-scope\.test\.mjs left process-wide state changed at module scope/);
		assert.match(output, /console\.warn was replaced/);
	});

	void it('without module.registerHooks, warns once and runs the tests unguarded', async () => {
		const { code, output } = await runFixtures(
			['1-leaks-in-a-test.test.mjs', '3-restores.test.mjs'],
			[WITHOUT_REGISTER_HOOKS],
		);
		assert.equal(code, 0, output);
		assert.equal(output.match(/Skipping the cross-file global-state guard/g)?.length, 1, output);
		assert.doesNotMatch(output, /global state restored/);
		assert.match(output, /^# pass 2$/m);
	});
});
