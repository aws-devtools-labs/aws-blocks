// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

// `sandbox:destroy` and `destroy` list their stacks with `cdk ls` and run
// `cdk destroy` through the cross-spawn wrappers in run-command, because
// `npm`/`npx` are `.cmd` shims on Windows that execFileSync cannot start
// (`spawnSync npm ENOENT`). A fresh process replaces run-command with a recorder,
// so a revert to execFileSync (which bypasses the recorder) fails here.
const scriptsUrl = new URL('./', import.meta.url).href;
const fixture = `
import assert from 'node:assert/strict';
import { mock } from 'node:test';

const scripts = ${JSON.stringify(scriptsUrl)};
const moduleUrl = (name) => new URL(name + '.js', scripts).href;
const calls = [];
mock.module(moduleUrl('run-command'), {
  namedExports: {
    runCapture: (command, args, options) => {
      calls.push({ fn: 'runCapture', command, args, cwd: options?.cwd ?? null });
      return 'StackA\\n  StackB  \\n\\n';
    },
    runSync: (command, args, options) => {
      calls.push({ fn: 'runSync', command, args, cwd: options?.cwd ?? null });
    },
    spawnCommand: () => { throw new Error('unexpected watch process'); },
  },
});
mock.module(moduleUrl('preflight-credentials'), {
  namedExports: { assertAwsCredentials: async () => {} },
});
mock.module(new URL('../telemetry/trackCommand.js', scripts).href, {
  namedExports: { trackCommand: async (_command, callback) => callback(), classifyError: () => ({}) },
});

const sandbox = await import(moduleUrl('sandbox'));
const { destroy, listProductionStackNames } = await import(moduleUrl('destroy'));
const backendPath = 'aws-blocks/index.cdk.ts';
const projectRoot = process.cwd();
const result = {
  projectRoot,
  sandboxStacks: sandbox.listSandboxStackNames(backendPath, {}),
  productionStacks: listProductionStackNames({ projectRoot, cdkAppPath: 'unused' }, {}),
  lsArgs: sandbox.buildSandboxLsArgs(backendPath),
  destroyArgs: sandbox.buildSandboxDestroyArgs(backendPath),
};
await sandbox.destroySandbox(backendPath);
await destroy({ projectRoot, cdkAppPath: 'unused' });
process.stdout.write(JSON.stringify({ ...result, calls }));
`;

describe('destroy stack listing and teardown go through run-command', () => {
	it('lists with runCapture and destroys with runSync, using the shared argv builders', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'blocks-destroy-wiring-'));
		try {
			const stdout = execFileSync(
				process.execPath,
				['--experimental-test-module-mocks', '--no-warnings', '--input-type=module', '-e', fixture],
				{
					cwd: directory,
					env: { PATH: process.env.PATH, HOME: directory, USERPROFILE: directory, AWS_BLOCKS_DISABLE_TELEMETRY: '1' },
					encoding: 'utf8',
					stdio: ['ignore', 'pipe', 'pipe'],
					timeout: 30_000,
				},
			);
			const out = JSON.parse(stdout.slice(stdout.indexOf('{"projectRoot"')));
			assert.deepEqual(out.sandboxStacks, ['StackA', 'StackB']);
			assert.deepEqual(out.productionStacks, ['StackA', 'StackB']);
			const root = out.projectRoot;
			assert.deepEqual(out.calls, [
				{ fn: 'runCapture', command: 'npm', args: out.lsArgs, cwd: null },
				{ fn: 'runCapture', command: 'npx', args: ['cdk', 'ls', '--context', `projectRoot=${root}`], cwd: root },
				{ fn: 'runSync', command: 'npm', args: out.destroyArgs, cwd: null },
				{ fn: 'runSync', command: 'npx', args: ['cdk', 'destroy', '--force', '--context', `projectRoot=${root}`], cwd: root },
			]);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});
