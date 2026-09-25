// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Parser-layer tests for the `blocks` CLI. These drive the yargs parser
 * directly (no child process) and assert the command surface: help lists every
 * command, version prints, unknown commands fail, aliases resolve, and a
 * deploy outside a Blocks app fails the deploy-guard.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMainParser } from './main_parser_factory.js';
import { NotABlocksAppError } from './paths.js';

/** Run the parser and capture what it would print (help/version), swallowing exit. */
function capture(args: string[]): { output: string; error: unknown } {
	let output = '';
	let error: unknown;
	const parser = createMainParser(args)
		.exitProcess(false)
		.fail((msg, err) => {
			throw err ?? new Error(msg);
		});
	try {
		parser.parse(args, (err: unknown, _argv: unknown, out: string) => {
			if (out) output += out;
			if (err) error = err;
		});
	} catch (e) {
		error = e;
	}
	return { output, error };
}

const ALL_COMMANDS = [
	'deploy',
	'destroy',
	'sandbox',
	'sandbox:destroy',
	'console',
	'dev',
	'cleanup',
	'secret',
	'config',
	'typegen',
	'spec',
	'generate-client',
	'vendorize',
	'telemetry',
	'help',
];

describe('blocks parser', () => {
	it('--help lists every command', () => {
		const { output } = capture(['--help']);
		for (const cmd of ALL_COMMANDS) {
			assert.ok(output.includes(cmd), `help output should mention "${cmd}"\n${output}`);
		}
	});

	it('--version prints the CLI version', () => {
		const { output } = capture(['--version']);
		assert.match(output.trim(), /^\d+\.\d+\.\d+/, `expected a semver, got: ${output}`);
	});

	it('an unknown command is rejected', () => {
		const { error } = capture(['definitely-not-a-command']);
		assert.ok(error, 'unknown command should produce an error');
	});

	it('the sandbox:console alias resolves to the console command', async () => {
		// A raw `console`/`sandbox:console` invocation would try to open the AWS
		// console; we only assert the alias is a KNOWN command (does not error as
		// unknown under `.strict()`). We stub the handler by parsing with --help
		// scoped to the alias, which yargs resolves without running the handler.
		const { output, error } = capture(['sandbox:console', '--help']);
		assert.strictEqual(error, undefined, 'alias should be a known command');
		assert.ok(
			output.includes('console') || output.includes('sandbox:console'),
			`alias help should describe the console command\n${output}`,
		);
	});

	it('deploy outside a Blocks app fails the deploy-guard', async () => {
		const emptyDir = mkdtempSync(join(tmpdir(), 'blocks-cli-noapp-'));
		const prevCwd = process.cwd();
		process.chdir(emptyDir);
		try {
			const parser = createMainParser(['deploy'])
				.exitProcess(false)
				.fail((msg, err) => {
					throw err ?? new Error(msg);
				});
			await assert.rejects(
				() => parser.parseAsync(['deploy']),
				(err: unknown) => err instanceof NotABlocksAppError,
				'deploy outside an app should throw NotABlocksAppError',
			);
		} finally {
			process.chdir(prevCwd);
		}
	});

	it('exposes the global --verbose, --debug and --quiet flags in help', () => {
		const { output } = capture(['--help']);
		assert.ok(output.includes('--verbose'), `help should list --verbose\n${output}`);
		assert.ok(output.includes('--debug'), `help should list --debug\n${output}`);
		assert.ok(output.includes('--quiet'), `help should list --quiet\n${output}`);
	});

	it('registers an explicit `help` command', () => {
		const { output } = capture(['--help']);
		assert.ok(output.includes('help'), `help output should list the help command\n${output}`);
	});

	it('prints an epilogue with the docs link', () => {
		const { output } = capture(['--help']);
		assert.ok(output.includes('github.com/aws-devtools-labs/aws-blocks'), `help should show the docs link\n${output}`);
	});
});
