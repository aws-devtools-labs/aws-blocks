// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert';
import { describe, it } from 'node:test';
import { blocksCommand } from './errors.js';
import { commandHelp, rootHelp } from './help.js';
import { COMMANDS, findCommand, GROUPS } from './registry.js';
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

	it('lists every runnable task once under its package script name', () => {
		const listed = listedCommands(help);
		const runnable = [
			'dev', 'dev:stop', 'sandbox', 'sandbox:deploy', 'sandbox:preview', 'sandbox:destroy', 'sandbox:console',
			'docs', 'docs:api', 'docs:search', 'deploy', 'destroy', 'whoami', 'secret', 'config',
			'generate-client', 'spec', 'typegen', 'db', 'vendorize', 'migrate', 'help',
		];
		assert.deepStrictEqual(listed.sort(), [...runnable].sort());
		assert.doesNotMatch(help, /(?<![\w.-])cdk-blocks\b(?!\/)|sandbox up/);
	});

	it('shows the version, global options and the exit codes', () => {
		assert.match(help, /^AWS CDK Blocks tasks 1\.2\.3\n/);
		assert.match(help, /\bdocs +Read the CDK Blocks docs:/);
		assert.match(help, /\bdocs:search +Search the CDK Blocks docs/);
		assert.match(help, /-C, --cwd <dir>/);
		assert.match(help, /--no-input/);
		assert.match(help, /Exit codes: 0 success, 1 failed, 2 usage error, 130 interrupted, 143 stopped by SIGTERM\./);
	});
});

describe('command help', () => {
	it('has usage, options and examples for every runnable command', () => {
		for (const command of COMMANDS.filter((c) => c.handler)) {
			const help = commandHelp(command);
			assert.ok(help.includes(`Usage: ${blocksCommand(command.path[0], ...command.path.slice(1))}`), command.path.join(' '));
			assert.match(help, /\nExamples\n {2}npm run /, command.path.join(' '));
			assert.doesNotMatch(help, /(?<![\w.-])cdk-blocks\b(?!\/)/);
			const examples = command.examples?.map(({ command }) => command) ?? [];
			assert.strictEqual(new Set(examples).size, examples.length, command.path.join(' '));
		}
	});

	it('preserves distinct docs forms, forwarded flags and silent machine output', () => {
		const docs = commandHelp(findCommand(['docs']) ?? assert.fail());
		for (const form of [
			'npm run docs KVStore core',
			'npm run docs:api KVStore',
			'npm run docs:search ConditionalCheckFailed',
			'npm run docs KVStore -- --section query',
			'npm run docs -- --exports Error',
			'npm run -s docs ApiError -- --output json',
		]) assert.ok(docs.includes(form), form);
		assert.match(docs, /defaults to JSON on a pipe and Markdown on a terminal/);
		const deploy = commandHelp(findCommand(['deploy']) ?? assert.fail());
		assert.ok(deploy.includes('API_URL=$(npm run -s deploy -- --query apiUrl)'));
		const secret = commandHelp(findCommand(['secret']) ?? assert.fail());
		assert.ok(secret.includes('cat key.txt | npm run -s secret set API_KEY -- --value-stdin'));
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
		assert.match(help, /\n {2}npm run dev -- --port 4000 +# open http:\/\/localhost:4000\n/);
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
		assert.match(help, /sandbox:destroy {2,}Delete your sandbox stack/);
		assert.doesNotMatch(help, /sandbox up|sandbox destroy/);
	});

	it('prints on stdout for --help, help <command> and an alias', async () => {
		const cwd = fixtureApp();
		for (const argv of [
			['destroy', '--help'],
			['help', 'destroy'],
			['destroy', '--help', '--output', 'json'],
			['destroy', '--help', '--query', 'destroyed'],
			['-h', 'destroy'],
		]) {
			const run = await runCli(argv, { cwd });
			assert.strictEqual(run.code, 0, argv.join(' '));
			assert.match(run.stdout, /Usage: npm run destroy/);
			assert.strictEqual(run.spawned.length, 0);
		}
		const alias = await runCli(['help', 'typegen'], { cwd });
		assert.match(alias.stdout, /Usage: npm run typegen/);
		const vendorize = await runCli(['vendorize', '--help'], { cwd });
		assert.match(vendorize.stdout, /Usage: npm run vendorize <package> \[options\.\.\.\]/);
		const db = await runCli(['db', '--help'], { cwd });
		assert.match(db.stdout, /Usage: npm run db <verb> \[args\.\.\.\]/);
		const unknown = await runCli(['help', 'deplyo'], { cwd });
		assert.strictEqual(unknown.code, 2);
		assert.match(unknown.stderr, /Did you mean "deploy"\?/);
	});

	it('prints only the version for --version after a command, and never runs it', async () => {
		const cwd = fixtureApp();
		for (const argv of [
			['whoami', '--version'],
			['deploy', '--version'],
			['destroy', '--yes', '--version'],
		]) {
			const run = await runCli(argv, { cwd, env: { AWS_REGION: 'not a region' } });
			assert.strictEqual(run.code, 0, `${argv.join(' ')}: ${run.stderr}`);
			assert.match(run.stdout, /^\d+\.\d+\.\d+\S*\n$/, argv.join(' '));
			assert.strictEqual(run.stderr, '', argv.join(' '));
			assert.strictEqual(run.spawned.length, 0, argv.join(' '));
		}
		const json = await runCli(['deploy', '--version', '--output', 'json'], { cwd });
		assert.match(JSON.parse(json.stdout).version, /^\d+\.\d+\.\d+/);
	});
});
