// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Repo invariant: no value is interpolated into a shell command line. Run
// programs with an argv array (`execFileSync(file, args)`, `spawn(file, args)`)
// and no shell; `exec`/`execSync` take only a constant command string; a shell
// program started through argv (`sh -c`, `cmd /c`, `powershell -Command`) gets
// only constants after its command flag; and an options object never sets
// `shell` to anything but `false` (a `const` options object is resolved, and a
// spread the scan can't see into is reported). A value that must reach a shell
// is validated against a strict allowlist first, and the site is listed below
// with that reason.
//
// The scan follows `child_process` imports within one file. A shell reached
// through a wrapper in another module, or an options object built at run time,
// is outside what it can see; route those through the wrappers above instead.
//
// Scans every tracked production TypeScript/JavaScript file (tests excluded) on
// the TypeScript AST. Allowlist entries are exact file:line with a reason; an
// entry that stops matching a site fails the test, so the list only shrinks.
//
// Run: node --test scripts/sink-guards/shell.test.mjs

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { compareWithAllowlist, findShellSinks, listSourceFiles, report, scan } from './sinks.mjs';

const LSOF_CLEANUP =
	'Ports come from a literal list in this file and each pid is a line of `lsof -t` output (digits); no outside value reaches the command.';
const WINDOWS_NPM =
	'shell only on Windows, where npm is an npm.cmd shim that execFileSync cannot start without one; the argv is fixed or validated (validateScope) first.';
const CI_WINDOWS =
	"CI driver: shell only on Windows for the npm/npx .cmd shims; every argument is a constant or a path the driver creates, and the spread options come from the driver's own calls (cwd/env).";
const APP_COMMAND =
	"Runs the app's own configured command (the developer's package.json / defineHosting() config) by design; it has the trust of the app's own code.";

const ALLOWLIST = [
	{ at: 'native/kotlin/example/typescript/aws-blocks/scripts/cleanup.ts:9', reason: LSOF_CLEANUP },
	{ at: 'native/kotlin/example/typescript/aws-blocks/scripts/cleanup.ts:11', reason: LSOF_CLEANUP },
	{ at: 'native/swift/Demo/typescript-demo/aws-blocks/scripts/cleanup.ts:9', reason: LSOF_CLEANUP },
	{ at: 'native/swift/Demo/typescript-demo/aws-blocks/scripts/cleanup.ts:11', reason: LSOF_CLEANUP },
	{ at: 'packages/core/src/scripts/cleanup.ts:17', reason: LSOF_CLEANUP },
	{ at: 'packages/core/src/scripts/cleanup.ts:22', reason: LSOF_CLEANUP },
	{ at: 'test-apps/native-bindings/aws-blocks/scripts/cleanup.ts:9', reason: LSOF_CLEANUP },
	{ at: 'test-apps/native-bindings/aws-blocks/scripts/cleanup.ts:11', reason: LSOF_CLEANUP },
	{ at: 'packages/core/src/hosting.ts:1182', reason: `Hosting buildCommand. ${APP_COMMAND}` },
	{ at: 'packages/hosting/src/build/runner.ts:61', reason: `Hosting buildCommand. ${APP_COMMAND}` },
	{ at: 'packages/core/src/scripts/dev-server.ts:890', reason: `Frontend dev command. ${APP_COMMAND}` },
	{ at: 'packages/core/src/scripts/sandbox.ts:560', reason: `Sandbox dev-server command. ${APP_COMMAND}` },
	{ at: 'packages/create-block/src/index.ts:287', reason: `npm view of an @aws-blocks/* name: ${WINDOWS_NPM}` },
	{ at: 'packages/create-block/src/index.ts:632', reason: `npm run build -w <validated name>: ${WINDOWS_NPM}` },
	{ at: 'packages/create-block/src/index.ts:637', reason: `npm test -w <validated name>: ${WINDOWS_NPM}` },
	{ at: 'scripts/ci/_proc.mjs:53', reason: CI_WINDOWS },
	{ at: 'scripts/ci/windows-template-e2e.mjs:51', reason: CI_WINDOWS },
	{
		at: 'scripts/agent-bench/steps/4-judge.ts:125',
		reason: 'The only value is the judge copy directory, passed through shellQuote() (single-quoted, embedded quotes escaped).',
	},
	{
		at: 'scripts/agent-bench/steps/4-judge.ts:256',
		reason: 'The only interpolation is --exclude-dir flags built from the constant STAGE_EXCLUDE_DIRS set in this script.',
	},
	{
		at: 'scripts/monte-carlo.ts:54',
		reason: 'Maintainer planning script: every gh command is a literal in this file, interpolating only the ORG constant and numeric ids.',
	},
	{
		at: 'scripts/publish/publish.ts:107',
		reason: 'The only value is a mkdtemp() directory under os.tmpdir() that this script just created, double-quoted.',
	},
];

describe('shell sink detector', () => {
	const find = (src) => findShellSinks('sample.ts', src).map((f) => `${f.line}:${f.kind}`);

	it('flags a command string built from a value', () => {
		const src = "import { execSync } from 'node:child_process';\nexport const f = (scope: string) => execSync(`npm view ${scope}/x`);";
		assert.deepEqual(find(src), ['2:shell-command-string']);
	});

	it('flags exec through an alias, a namespace import and require()', () => {
		assert.deepEqual(find("import { exec as run } from 'child_process';\nrun(cmd);"), ['2:shell-command-string']);
		assert.deepEqual(find("import * as cp from 'node:child_process';\ncp.execSync(cmd);"), ['2:shell-command-string']);
		assert.deepEqual(find("const { execSync } = require('child_process');\nexecSync('ls ' + dir);"), ['2:shell-command-string']);
	});

	it('flags any shell option that is not the literal false', () => {
		assert.deepEqual(find("spawn('npm', ['i'], { shell: true });"), ['1:shell-option']);
		assert.deepEqual(find("execFileSync('npm', args, { shell: process.platform === 'win32' });"), ['1:shell-option']);
		assert.deepEqual(find("const shell = true; run('x', [], { shell });"), ['1:shell-option']);
	});

	it('flags a shell program started through argv with a non-constant command', () => {
		const imp = "import { execFile, spawn, spawnSync } from 'node:child_process';\n";
		assert.deepEqual(find(`${imp}execFile('cmd', ['/c', 'start', '', p], cb);`), ['2:shell-program-argv']);
		assert.deepEqual(find(`${imp}spawn('sh', ['-c', \`ls \${dir}\`]);`), ['2:shell-program-argv']);
		assert.deepEqual(find(`${imp}spawnSync('/bin/bash', ['-c', ...cmds]);`), ['2:shell-program-argv']);
		assert.deepEqual(find(`${imp}spawn('pwsh', args);`), ['2:shell-program-argv']);
		assert.deepEqual(find(`${imp}spawn('sh', ['-c', 'echo ok']); spawn('bash', [script, name]);`), []);
	});

	it('resolves a const options object and flags a spread it cannot see into', () => {
		const imp = "import { spawn } from 'node:child_process';\n";
		assert.deepEqual(find(`${imp}const o = { shell: true };\nspawn(cmd, args, o);`), ['2:shell-option']);
		assert.deepEqual(find(`${imp}spawn(cmd, args, { ...o });`), ['2:shell-option-spread']);
		assert.deepEqual(find(`${imp}const base = { cwd: dir };\nspawn(cmd, args, { ...base, stdio: 'inherit' });`), []);
	});

	it('accepts constant commands, argv arrays and shell: false', () => {
		const src = [
			"import { execSync, execFileSync, spawn } from 'node:child_process';",
			"execSync('git config user.name');",
			"const CMD = 'npm install'; execSync(CMD, { stdio: 'inherit' });",
			"execFileSync('npm', ['view', name, 'version']);",
			"spawn('node', [file], { shell: false });",
		].join('\n');
		assert.deepEqual(find(src), []);
	});

	it('ignores an exec method that is not child_process (RegExp.prototype.exec)', () => {
		assert.deepEqual(find('const m = /a(b)/.exec(input);'), []);
	});
});

describe('repo: no value is interpolated into a shell command', () => {
	it('every site uses argv or a constant command, or is allowlisted with a reason', () => {
		const result = compareWithAllowlist(scan(listSourceFiles(), findShellSinks), ALLOWLIST);
		assert.ok(result.unexpected.length === 0 && result.stale.length === 0, report('shell', result));
	});
});
