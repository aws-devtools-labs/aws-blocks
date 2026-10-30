// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { describe, it } from 'node:test';
import { commandHelp, rootHelp } from './help.js';
import { ALIASES, COMMANDS, findCommand, GROUPS } from './registry.js';
import { fixtureApp, runCli } from './test-helpers.js';

/** The command names that root help lists, one per row. */
function listedCommands(help: string): string[] {
	return help
		.split('\n')
		.filter((line) => /^ {2}[a-z]/.test(line))
		.map((line) => line.trim().split(/ {2,}/)[0]);
}

describe('root help', () => {
	const help = rootHelp('1.2.3');

	it('lists the groups in order', () => {
		const positions = GROUPS.map((group) => help.split('\n').indexOf(group));
		assert.ok(
			positions.every((position) => position > 0),
			`every group heading is present: ${positions}`,
		);
		assert.deepStrictEqual(
			[...positions].sort((a, b) => a - b),
			positions,
		);
	});

	it('lists every canonical command that runs, and no alias', () => {
		const listed = listedCommands(help);
		const runnable = COMMANDS.filter((command) => command.handler).map((command) => command.path.join(' '));
		assert.deepStrictEqual(listed.sort(), [...runnable].sort());
		for (const alias of ALIASES) assert.ok(!listed.includes(alias.name.join(' ')), alias.name.join(' '));
		assert.doesNotMatch(help, /dev:stop|sandbox:deploy|sandbox:destroy|sandbox:console|generate-client|cleanup/);
	});

	it('shows the version, global options and the exit codes', () => {
		assert.match(help, /^AWS Blocks CLI 1\.2\.3\n/);
		assert.match(help, /-C, --cwd <dir>/);
		assert.match(help, /--no-input/);
		assert.match(help, /Exit codes: 0 success, 1 failed, 2 usage error, 130 interrupted\./);
	});
});

describe('command help', () => {
	it('has usage, options and examples for every runnable command', () => {
		for (const command of COMMANDS.filter((c) => c.handler)) {
			const help = commandHelp(command);
			assert.match(help, new RegExp(`Usage: blocks ${command.path.join(' ')}`), command.path.join(' '));
			assert.match(help, /\nExamples\n {2}blocks /, command.path.join(' '));
		}
	});

	it('says which dev port is opened in the browser and which is internal', () => {
		const help = commandHelp(findCommand(['dev']) ?? assert.fail());
		assert.match(
			help,
			/--port <N> +Port you open in the browser \(serves the app and proxies the frontend\) \[3000\]/,
		);
		assert.match(
			help,
			/--frontend-port <N> +Internal port of the frontend dev server, proxied behind --port \[3100\]/,
		);
		assert.match(help, /\n {2}blocks dev --port 4000 +# open http:\/\/localhost:4000\n/);
	});

	it('documents --stage for secret and config without a fixed list of stages', () => {
		for (const name of ['secret', 'config']) {
			const help = commandHelp(findCommand([name]) ?? assert.fail());
			assert.match(help, /--stage <name> takes any name; there is no fixed list/);
			assert.match(help, /Without --stage, the value is shared: every stage falls back to it\./);
		}
	});

	it('lists the subcommands of a group', () => {
		const help = commandHelp(findCommand(['sandbox']) ?? assert.fail());
		assert.match(help, /sandbox destroy {2,}Delete your sandbox stack/);
		assert.doesNotMatch(help, /sandbox up|sandbox:destroy/);
	});

	it('prints on stdout for --help, help <command> and an alias', async () => {
		const cwd = fixtureApp();
		for (const argv of [
			['destroy', '--help'],
			['help', 'destroy'],
			['-h', 'destroy'],
		]) {
			const run = await runCli(argv, { cwd });
			assert.strictEqual(run.code, 0, argv.join(' '));
			assert.match(run.stdout, /Usage: blocks destroy/);
			assert.strictEqual(run.spawned.length, 0);
		}
		const alias = await runCli(['help', 'typegen'], { cwd });
		assert.match(alias.stdout, /Usage: blocks generate types/);
		const db = await runCli(['db', '--help'], { cwd });
		assert.match(db.stdout, /Usage: blocks db <verb> \[args\.\.\.\]/);
		const unknown = await runCli(['help', 'deplyo'], { cwd });
		assert.strictEqual(unknown.code, 2);
		assert.match(unknown.stderr, /Did you mean "deploy"\?/);
	});
});
